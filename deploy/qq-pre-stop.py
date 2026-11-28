#!/usr/bin/env python3
"""Complete QQ's own shutdown before supervisord starts its signal wait."""
import json
import os
from pathlib import Path
import signal
import time
from qq_gateway_lifecycle import group_alive, leader_alive


def find_guardian(script, procfs=Path('/proc')):
    matches = []
    for entry in procfs.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            argv = (entry / 'cmdline').read_bytes().split(bytes([0]))
            if len(argv) < 2 or not Path(os.fsdecode(argv[0])).name.startswith('python'):
                continue
            if os.fsencode(script) in argv[1:]:
                matches.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
    if len(matches) > 1:
        raise RuntimeError('Multiple managed QQ guardians; refusing an ambiguous stop')
    return matches[0] if matches else None


def owned_groups(directory, guardian):
    groups = set()
    for name in ('qq', 'snowluma', 'dbus', 'xvfb'):
        file = directory / (name + '-process.json')
        if not file.exists():
            continue
        record = json.loads(file.read_text())
        pid = record.get('pid')
        if record.get('managedBy') == guardian and isinstance(pid, int) and pid > 0:
            groups.add(pid)
    return groups


def stop_guardian(guardian, directory, timeout=20):
    groups = owned_groups(directory, guardian)
    try:
        os.kill(guardian, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + timeout
    while True:
        # A stop may arrive during startup. Include any child registered before
        # the guardian handled its pending TERM, rather than freezing one list.
        groups.update(owned_groups(directory, guardian))
        if not leader_alive(guardian) and not any(group_alive(pid) for pid in groups):
            return {'state': 'stopped', 'guardian': guardian, 'groups': sorted(groups)}
        if time.monotonic() >= deadline:
            raise RuntimeError('Managed QQ shutdown did not complete before the stop hook deadline')
        time.sleep(.05)


def main():
    script = Path(__file__).with_name('serve-qq-gateway.py')
    guardian = find_guardian(script)
    if guardian is None:
        print(json.dumps({'state': 'absent'}))
        return
    directory = Path.home() / '.local/share/whale-nest/qq-gateways/snowluma-v2.4.2'
    result = {**stop_guardian(guardian, directory), 'completedAt': time.time()}
    temporary = directory / ('pre-stop-result.' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps(result))
    temporary.chmod(0o600)
    temporary.replace(directory / 'pre-stop-result.json')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
