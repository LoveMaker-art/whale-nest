"""Stop only child process groups started by this gateway, before dependencies."""
import os
from pathlib import Path
import signal
import subprocess
import time


def group_alive(group):
    procfs = Path('/proc')
    if procfs.exists():
        for entry in procfs.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) == group and fields[0] not in ('Z', 'X', 'x'):
                    return True
            except (OSError, ValueError, IndexError):
                continue
        return False
    rows = subprocess.run(['ps', '-axo', 'pgid=,stat='], capture_output=True,
                          text=True, check=True).stdout.splitlines()
    return any(fields and int(fields[0]) == group and not fields[1].startswith('Z')
               for row in rows if len(fields := row.split()) >= 2)



def leader_alive(pid):
    stat = Path('/proc') / str(pid) / 'stat'
    if Path('/proc').exists():
        try:
            return stat.read_text().rsplit(')', 1)[1].split()[0] not in ('Z', 'X', 'x')
        except (FileNotFoundError, ProcessLookupError):
            return False
    state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True,
                           text=True).stdout.strip()
    return bool(state) and not state.startswith('Z')



def stop_group(proc, grace=8):
    # Electron's renderer/crash handler must stay alive while its main process
    # shuts down. Signalling the entire group first can itself crash the main.
    if leader_alive(proc.pid):
        try:
            os.kill(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        until = time.monotonic() + grace
        while time.monotonic() < until:
            if not leader_alive(proc.pid):
                break
            time.sleep(.05)
        if leader_alive(proc.pid):
            try:
                os.kill(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    until = time.monotonic() + 5
    while leader_alive(proc.pid) and time.monotonic() < until:
        time.sleep(.05)
    if leader_alive(proc.pid):
        raise RuntimeError('Managed main process failed to exit: ' + str(proc.pid))
    # Do not acquire Popen's waitpid lock during signal-driven cleanup. The main
    # loop may have been interrupted while polling that same child.
    try:
        pid, status = os.waitpid(proc.pid, os.WNOHANG)
        if pid:
            proc.returncode = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        pass  # The migration adapter is not the frozen guardian's parent.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not group_alive(proc.pid):
            return
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 2
        while group_alive(proc.pid) and time.monotonic() < until:
            time.sleep(.05)
    if group_alive(proc.pid):
        raise RuntimeError('Managed descendants failed to exit: ' + str(proc.pid))


def stop_desktop(named):
    # QQ retains its connected bus/display until its entire group has exited.
    for name in ('qq', 'snowluma', 'dbus', 'xvfb'):
        if name in named:
            stop_group(named[name])
