"""Durable wall-clock session time; no audio/transcript storage. One server process."""
import fcntl
import os
import sqlite3
from datetime import datetime, timezone


def day_of(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%d')


class QuotaStore:
    def __init__(self, path, daily_limit):
        self.lock_fd = None
        if str(path) != ':memory:':
            self.lock_fd = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
            os.fchmod(self.lock_fd, 0o600)
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(self.lock_fd)
                self.lock_fd = None
                raise RuntimeError('quota_store_already_in_use') from None
        self.db = sqlite3.connect(path)
        self.limit = daily_limit
        self.db.execute('CREATE TABLE IF NOT EXISTS usage(day TEXT, user TEXT, seconds REAL, PRIMARY KEY(day,user))')
        self.db.commit()

    def used(self, user, now):
        row = self.db.execute('SELECT seconds FROM usage WHERE day=? AND user=?', (day_of(now), user)).fetchone()
        return row[0] if row else 0.0

    def remaining(self, user, now):
        return max(0.0, self.limit - self.used(user, now))

    def reserve(self, user, start, end):
        """Bill a short interval BEFORE granting it; crash cannot reset consumed quota.

        Reservations straddling UTC midnight are split. Clean termination refunds the
        unused tail. Crash may overcharge at most one meter interval; never undercharges.
        """
        cursor = start
        with self.db:
            while cursor < end:
                midnight = (int(cursor // 86400) + 1) * 86400
                stop = min(end, midnight)
                amount = stop - cursor
                if self.remaining(user, cursor) + 1e-7 < amount:
                    raise QuotaExceeded
                self.db.execute('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,user) DO UPDATE SET seconds=seconds+excluded.seconds',
                                (day_of(cursor), user, amount))
                cursor = stop

    def refund(self, user, start, end):
        cursor = start
        with self.db:
            while cursor < end:
                stop = min(end, (int(cursor // 86400) + 1) * 86400)
                self.db.execute('UPDATE usage SET seconds=MAX(0,seconds-?) WHERE day=? AND user=?',
                                (stop - cursor, day_of(cursor), user))
                cursor = stop

    def close(self):
        self.db.close()
        if self.lock_fd is not None:
            fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            os.close(self.lock_fd)
            self.lock_fd = None


class QuotaExceeded(Exception):
    pass
