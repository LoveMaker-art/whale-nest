"""Memory protection for a shared ClawChat and QQ container."""
from collections import deque
from pathlib import Path


def counters(path):
    return {key: int(value) for key, value in
            (line.split() for line in path.read_text().splitlines())}


class GatewayMemory:
    def __init__(self, cgroup=Path('/sys/fs/cgroup')):
        self.cgroup = cgroup
        self.samples = deque(maxlen=30)
        self.deferred = False
        self.clear_samples = 0
        self.critical_samples = 0

    def read(self):
        group = self.cgroup
        stats = counters(group / 'memory.stat')
        limit = (group / 'memory.max').read_text().strip()
        events = counters(group / 'memory.events')
        current = int((group / 'memory.current').read_text())
        return {
            'current': current,
            'limit': None if limit == 'max' else int(limit),
            'effective': max(0, current - stats.get('inactive_file', 0)),
            'nonFile': current - min(current, max(0, stats.get('file', 0) - stats.get('shmem', 0))),
            'stat': {key: stats[key] for key in ('anon', 'file', 'shmem', 'file_mapped',
                     'file_dirty', 'inactive_file', 'active_file', 'pgsteal', 'pgmajfault',
                     'workingset_refault_file') if key in stats},
            'events': {key: events.get(key, 0) for key in ('max', 'oom', 'oom_kill')},
        }

    def record(self, value, at):
        previous = self.samples[-1] if self.samples else None
        self.samples.append(dict(value, at=at))
        limit = value['limit']
        if not limit:
            return False

        if value['effective'] >= .85 * limit or value['current'] >= .95 * limit:
            self.deferred = True
            self.clear_samples = 0
        elif self.deferred:
            clear = value['effective'] < .82 * limit and value['current'] < .92 * limit
            self.clear_samples = self.clear_samples + 1 if clear else 0
            if self.clear_samples >= 3:
                self.deferred = False

        near_limit = value['current'] >= .97 * limit
        self.critical_samples = self.critical_samples + 1 if near_limit else 0
        if not near_limit:
            return False
        if previous and any(value['events'][key] > previous['events'][key]
                            for key in ('oom', 'oom_kill')):
            return True
        if self.critical_samples < 3:
            return False

        first = self.samples[-3]
        hitting_ceiling = value['events']['max'] > first['events']['max']
        resident_high = all(sample['nonFile'] >= .90 * limit
                            for sample in list(self.samples)[-3:])
        return hitting_ceiling or resident_high


def process_memory(groups, *, procfs=Path('/proc')):
    """Aggregate proportional resident memory by the existing supervisor's process groups."""
    owners = dict(groups)
    total = {name: {'processes': 0, 'sampled': 0, 'pssKiB': 0} for name in owners.values()}
    for proc in procfs.iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            status = (proc / 'stat').read_text()
            fields = status[status.rfind(')') + 1:].split()
            name = owners.get(int(fields[2]))
            if name is None:
                continue
            row = total[name]
            row['processes'] += 1
            for line in (proc / 'smaps_rollup').read_text().splitlines():
                if line.startswith('Pss:'):
                    row['pssKiB'] += int(line.split()[1])
                    row['sampled'] += 1
                    break
        except (OSError, ValueError, IndexError):
            continue
    return total
