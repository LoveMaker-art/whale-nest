#!/usr/bin/env python3
"""One-time orderly drain for a gateway still running the old concurrent stop."""
import json
import os
from pathlib import Path
import signal
import resource
import subprocess
import time
from qq_gateway_lifecycle import stop_desktop, group_alive, leader_alive

snow = Path.home() / '.local/share/whale-nest/qq-gateways/snowluma-v2.4.2'
read = lambda p: json.loads(p.read_text())
status = read(snow / 'managed-status.json') if (snow / 'managed-status.json').exists() else {}
ctl = ['/opt/clawnest/bin/supervisord', 'ctl', 'stop', 'whalenest-qq']

class OwnedProcess:
    def __init__(self, pid):
        self.pid = pid
    def poll(self):
        return None if leader_alive(self.pid) else 0
    def wait(self, timeout):
        until = time.monotonic() + timeout
        while leader_alive(self.pid) and time.monotonic() < until:
            time.sleep(.05)
        if leader_alive(self.pid):
            raise subprocess.TimeoutExpired('owned QQ process group', timeout)
        return 0

named = {}
guardian = None
for name in ('qq', 'snowluma', 'dbus', 'xvfb'):
    p = snow / (name + '-process.json')
    if not p.exists():
        continue
    record = read(p)
    pid, owner = record['pid'], record['managedBy']
    stat = Path('/proc') / str(pid) / 'stat'
    if not stat.exists():
        continue
    fields = stat.read_text().rsplit(')', 1)[1].split()
    assert int(fields[1]) == owner and int(fields[2]) == pid, 'Unverified QQ child ownership'
    cmd = (Path('/proc') / str(owner) / 'cmdline').read_bytes().split(bytes([0]))
    assert len(cmd) >= 2 and cmd[1] == str(Path.home() / 'projects/whale-nest/deploy/serve-qq-gateway.py').encode()
    assert guardian is None or guardian == owner
    guardian = owner
    resource.prlimit(pid, resource.RLIMIT_CORE, (0, 0))
    named[name] = OwnedProcess(pid)
if guardian is None:
    subprocess.run(ctl, check=True, timeout=60, capture_output=True)
else:
    # Freeze only the old guardian, never QQ. Drain every verified group and
    # resume the guardian only after supervisor stop has been requested.
    os.kill(guardian, signal.SIGSTOP)
    try:
        stop_desktop(named)
        command = subprocess.Popen(ctl, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        until = time.monotonic() + 5
        while command.poll() is None and time.monotonic() < until:
            state = (Path('/proc') / str(guardian) / 'status').read_text()
            pending = [int(line.split()[1], 16) for line in state.splitlines() if line.startswith(('SigPnd:', 'ShdPnd:'))]
            if any(mask & (1 << (signal.SIGTERM - 1)) for mask in pending):
                break
            time.sleep(.02)
        os.kill(guardian, signal.SIGCONT)
        output, error = command.communicate(timeout=60)
        assert command.returncode == 0, 'Supervisor QQ stop failed'
        assert all(not group_alive(proc.pid) for proc in named.values())
    finally:
        try:
            os.kill(guardian, signal.SIGCONT)
        except ProcessLookupError:
            pass
print(json.dumps({'state': 'stopped', 'legacyOrderCorrected': bool(guardian)}))
