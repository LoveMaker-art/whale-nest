#!/usr/bin/env python3
"""Run the separately provisioned SnowLuma/QQ desktop on the test instance.

No QQ business logic or account linking lives here. All endpoints stay on
loopback; the existing companion owns account verification and messages.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import traceback
import urllib.request
from qq_login_window import QQLoginWindow
from qq_gateway_memory import GatewayMemory, process_memory

os.umask(0o077)
base = Path.home() / '.local/share/whale-nest/qq-gateways'
snow = base / 'snowluma-v2.4.2'
deps = base / 'desktop-deps'
root = deps / 'root'
login = snow / 'login'
login.mkdir(mode=0o700, exist_ok=True)
children = []
stopping = False


class ResourceStop(Exception):
    pass


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def start(name, args, env, cwd=None):
    path = snow / (name + '-managed.log')
    if path.exists() and path.stat().st_size > 2 * 1024 * 1024:
        path.replace(path.with_suffix('.previous.log'))
    with path.open('ab') as log:
        proc = subprocess.Popen(args, env=env, cwd=cwd, stdout=log,
                                stderr=subprocess.STDOUT, start_new_session=True)
    children.append(proc)
    save(snow / (name + '-process.json'), {'pid': proc.pid, 'args': args,
                                          'managedBy': os.getpid()})
    return proc


def stop(signum=None, _frame=None):
    global stopping
    if signum is not None:
        save(snow / 'lifecycle.json', {'reason': signal.Signals(signum).name,
                                      'at': int(time.time() * 1000)})
    if stopping:
        return
    stopping = True
    for proc in reversed(children):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for proc in children:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
env = dict(os.environ, PATH=str(root / 'usr/bin') + ':' + os.environ['PATH'],
           LD_LIBRARY_PATH=(deps / 'runtime-library-path.txt').read_text().strip(),
           DISPLAY=':99', XKB_CONFIG_ROOT=str(root / 'usr/share/X11/xkb'),
           XDG_DATA_DIRS=str(root / 'usr/share') + ':/usr/share',
           FONTCONFIG_PATH=str(root / 'etc/fonts'),
           FONTCONFIG_FILE=str(root / 'etc/fonts/fonts.conf'))


def command(args):
    return subprocess.run(args, env=env, capture_output=True, timeout=15,
                          check=True).stdout


def api(route, data=None, token=None):
    headers = {'content-type': 'application/json'}
    if token:
        headers['x-snowluma-token'] = token
    request = urllib.request.Request('http://127.0.0.1:5099/api/' + route,
                                     data=None if data is None else json.dumps(data).encode(),
                                     headers=headers)
    with urllib.request.urlopen(request, timeout=35) as response:
        value = json.load(response)
    if value.get('success') is False:
        raise RuntimeError('SnowLuma operation failed: ' + route.split('/')[0])
    return value


try:
    if (snow / 'resource-stop.json').exists():
        raise ResourceStop()
    # QQ can render its QR without CJK fonts while hiding every Chinese login
    # error. Require actual Chinese coverage before exposing that login UI.
    languages = command([str(root / 'usr/bin/fc-match'), '-f', '%{lang}', 'sans:lang=zh-cn']).decode()
    if 'zh-cn' not in languages.split('|'):
        raise RuntimeError('Chinese font coverage is required for QQ login diagnostics')
    # Debian's xkbcomp search directory is compiled in. Recreate the recorded
    # user-prefix relocation after /tmp cleanup; preserve the original binary.
    relocation = read(deps / 'xvfb-relocation.json')
    compiler = Path(relocation['to'])
    compiler.mkdir(mode=0o700, exist_ok=True)
    assert compiler.stat().st_uid == os.getuid() and compiler.stat().st_mode & 0o077 == 0
    link = compiler / 'xkbcomp'
    if not link.exists():
        link.symlink_to(root / 'usr/bin/xkbcomp')
    assert link.resolve() == (root / 'usr/bin/xkbcomp').resolve()
    executable = Path(relocation['patched'])
    assert hashlib.sha256(executable.read_bytes()).hexdigest() == relocation['patchedSha256']
    xvfb = start('xvfb', [str(executable), ':99', '-screen', '0', '1024x768x24',
                         '-nolisten', 'tcp', '-ac', '-xkbdir', env['XKB_CONFIG_ROOT']], env)
    for _ in range(30):
        try:
            command([str(root / 'usr/bin/xdpyinfo')])
            break
        except subprocess.SubprocessError:
            if xvfb.poll() is not None:
                raise RuntimeError('Virtual display failed')
            time.sleep(.3)
    else:
        raise RuntimeError('Virtual display unavailable')

    dbus = start('dbus', [str(root / 'usr/bin/dbus-daemon'), '--nofork',
                          '--config-file=' + str(root / 'usr/share/dbus-1/session.conf'),
                          '--address=unix:path=' + str(snow / 'session-bus')], env)
    env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + str(snow / 'session-bus')
    assert read(snow / 'managed-desktop.json')['profile'] == str(Path.home() / '.config/QQ')
    qq = start('qq', [str(base / 'linux-qq-3.2.34/opt/QQ/qq'), '--no-sandbox',
                      '--disable-gpu', '--disable-dev-shm-usage'], env)
    snow_env = dict(env, NODE_OPTIONS='--max-old-space-size=192',
                    SNOWLUMA_WEBUI_HOST='127.0.0.1', SNOWLUMA_WEBUI_PORT='5099',
                    SNOWLUMA_HOOK_AUTOLOAD='0', SNOWLUMA_UPDATE_CHECK='0',
                    SNOWLUMA_LOG_MAX_TOTAL_MB='16', SNOWLUMA_ACCEPT_EULA='1',
                    SNOWLUMA_ACCEPT_PRIVACY='1')
    snow_proc = start('snowluma', ['/usr/local/bin/node', str(snow / 'index.mjs')], snow_env, str(snow))
    password = read(snow / 'operator-credentials.json')['webuiPassword']
    for _ in range(60):
        try:
            token = api('login', {'password': password})['token']
            break
        except Exception:
            if snow_proc.poll() is not None:
                raise RuntimeError('SnowLuma startup failed')
            time.sleep(.5)
    else:
        raise RuntimeError('SnowLuma console unavailable')
    save(snow / 'session.json', {'token': token})
    # Attach only the freshly started managed QQ process, never all user QQs.
    api('processes/' + str(qq.pid) + '/load', {}, token)
    for _ in range(60):
        own = next((p for p in api('processes', token=token).get('list', []) if p['pid'] == qq.pid), {})
        if own.get('connected'):
            break
        if qq.poll() is not None:
            raise RuntimeError('Managed QQ exited before connection')
        time.sleep(.5)
    else:
        raise RuntimeError('Managed QQ hook did not connect')
    last_auth = time.monotonic()
    memory = GatewayMemory()
    last_memory_sample = 0
    last_window_check = 0
    sample = {}
    groups = {qq.pid: 'qq', snow_proc.pid: 'snowluma', xvfb.pid: 'xvfb', dbus.pid: 'dbus'}
    window = QQLoginWindow(root, env, qq.pid)
    request_id = None
    request_reused = False
    pending = None
    response = None
    action_error = None
    last_digest = None
    generated_at = None
    unknown_since = None
    print('QQ desktop and SnowLuma started; account login is checked separately.', flush=True)
    while not stopping:
        if any(proc.poll() is not None for proc in children):
            raise RuntimeError('Managed QQ dependency exited')
        tick = time.monotonic()
        if tick - last_memory_sample >= 5:
            sample = memory.read()
            last_memory_sample = tick
            sample['processes'] = process_memory(groups)
            critical = memory.record(sample, int(time.time() * 1000))
            try:
                save(snow / 'memory-samples.json', {'samples': list(memory.samples)})
            except OSError:
                pass  # The process protection does not depend on diagnostic storage.
            if critical:
                save(snow / 'resource-stop.json', {'at': int(time.time() * 1000),
                    'memoryEffective': sample['effective'], 'sample': memory.samples[-1]})
                raise ResourceStop()
        if time.monotonic() - last_auth > 20 * 60:
            token = api('login', {'password': password})['token']
            save(snow / 'session.json', {'token': token})
            last_auth = time.monotonic()
        processes = api('processes', token=token).get('list', [])
        own = next((p for p in processes if p['pid'] == qq.pid), {})
        if not own.get('connected'):
            raise RuntimeError('SnowLuma lost the managed QQ connection')
        online = own.get('loggedIn') is True
        request_file = login / 'request.json'
        request = read(request_file) if request_file.exists() else None
        fresh_request = request and request.get('id') != request_id and abs(time.time() * 1000 - request.get('requestedAt', 0)) < 30000
        if fresh_request:
            request_id = request['id']
            pending = {'id': request_id, 'refresh': request.get('refresh') is True,
                       'startedAt': time.monotonic()}
            response = None
            unknown_since = None
            action_error = None
            (login / 'qr.json').unlink(missing_ok=True)
        stamp = int(time.time() * 1000)
        if online:
            save(login / 'status.json', {'state': 'online', 'updatedAt': stamp})
            save(login / 'qr.json', {'phase': 'online', 'requestId': request_id, 'updatedAt': stamp})
            pending = None
            (login / 'qr.png').unlink(missing_ok=True)
        if not online and (pending or not memory.deferred or tick - last_window_check >= 2):
            last_window_check = tick
            try:
                frame = window.inspect()
            except (subprocess.SubprocessError, ValueError, OSError):
                frame = {'state': 'unavailable'}
            phase = frame['state']
            if phase in ('preparing', 'unavailable'):
                unknown_since = unknown_since or time.monotonic()
                if time.monotonic() - unknown_since > 12:
                    phase = 'attention-required'
            else:
                unknown_since = None
            if pending:
                try:
                    step = window.prepare(frame, pending)
                    phase = step['state']
                    if step.get('action'):
                        save(snow / 'last-login-action.json', {'requestId': request_id, 'qqPid': qq.pid,
                                                             'action': step['action'], 'at': stamp})
                        unknown_since = None
                    if phase != 'waiting' and step.get('done'):
                        response = {'phase': phase, 'requestId': request_id, 'updatedAt': stamp}
                        pending = None
                    elif phase != 'waiting' and time.monotonic() - pending['startedAt'] > 15:
                        phase = 'attention-required'
                        response = {'phase': phase, 'requestId': request_id, 'updatedAt': stamp}
                        pending = None
                except (RuntimeError, subprocess.SubprocessError, OSError) as error:
                    action_error = 'login-action-failed'
                    pending = None
                    save(snow / 'last-action-error.json', {'requestId': request_id, 'type': type(error).__name__, 'at': stamp})
            status = {'state': phase, 'updatedAt': stamp}
            if phase == 'waiting':
                action_error = None
                image = frame['image']
                digest = hashlib.sha256(image).hexdigest()
                if digest != last_digest:
                    generated_at = stamp
                last_digest = digest
                if pending:
                    request_reused = not pending.get('changed', False)
                temporary = login / 'qr.png.tmp'
                temporary.write_bytes(image)
                temporary.replace(login / 'qr.png')
                if response is None:
                    save(login / 'qr.json', {'phase': 'waiting', 'imageSha256': digest,
                                             'updatedAt': stamp, 'generatedAt': generated_at,
                                             'requestId': request_id,
                                             'reused': request_reused})
                pending = None
            else:
                if response is None:
                    (login / 'qr.json').unlink(missing_ok=True)
                if frame.get('attentionImage'):
                    temporary = login / 'attention.png.tmp'
                    temporary.write_bytes(frame['attentionImage'])
                    temporary.replace(login / 'attention.png')
                    status['attentionSha256'] = hashlib.sha256(frame['attentionImage']).hexdigest()
            if action_error:
                status['state'] = 'attention-required'
                if frame.get('attentionImage'):
                    temporary = login / 'attention.png.tmp'
                    temporary.write_bytes(frame['attentionImage'])
                    temporary.replace(login / 'attention.png')
                    status['attentionSha256'] = hashlib.sha256(frame['attentionImage']).hexdigest()
                response = {'requestId': request_id, 'error': action_error, 'updatedAt': stamp}
            # Keep a non-image reply until the next explicit request. A short
            # state transition must not make the caller miss its response.
            if response is not None:
                save(login / 'qr.json', response)
            save(login / 'status.json', status)
        save(snow / 'managed-status.json', {'ready': True, 'qqProcessConnected': True,
                   'loggedIn': online, 'memoryCurrent': sample.get('current'),
                   'memoryEffective': sample.get('effective'),
                   'deferBackground': memory.deferred, 'at': int(time.time() * 1000)})
        for logfile in snow.glob('*-managed.log'):
            if logfile.stat().st_size > 2 * 1024 * 1024:
                with logfile.open('wb'):
                    pass
        for _ in range(2):
            if stopping:
                break
            time.sleep(.25)
except ResourceStop:
    # The supervisor also restarts clean exits. Keep a small, inactive guardian
    # here so memory pressure cannot create a QQ restart loop. An operator must
    # review the persistent stop marker and explicitly restart this service.
    save(snow / 'managed-status.json', {'ready': False, 'reason': 'resource-stop',
                                       'at': int(time.time() * 1000)})
    print('QQ stopped for resource review.', flush=True)
    stop()
    def leave_pause(*_args):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, leave_pause)
    signal.signal(signal.SIGINT, leave_pause)
    while True:
        signal.pause()
except Exception as error:
    # Do not emit exception payloads from third-party APIs or credentials.
    print('QQ service stopped: ' + type(error).__name__ + '. Inspect private diagnostics.', file=sys.stderr, flush=True)
    save(snow / 'managed-error.json', {'type': type(error).__name__, 'at': int(time.time() * 1000)})
    (snow / 'managed-error-private.log').write_text(traceback.format_exc())
    sys.exit(1)
finally:
    (login / 'qr.json').unlink(missing_ok=True)
    save(login / 'status.json', {'state': 'reconnecting', 'updatedAt': int(time.time() * 1000)})
    save(snow / 'managed-status.json', {'ready': False, 'at': int(time.time() * 1000)})
    stop()
