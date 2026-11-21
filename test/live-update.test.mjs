import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, existsSync, realpathSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectLiveUpdate, inspectPreparedRuntimeBundle, verifyLiveInputs, reserveSnapshot, livewareRouteOnline } from '../src/live-update.mjs';
import { sdkProcesses } from '../src/recovery.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'whalenest-preflight-'))), home = join(root, 'home'), workspace = join(home, 'actual-workspace');
  mkdirSync(workspace, { recursive: true });
  const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
  const bin = join(home, 'release/clawchat-connect');
  put(bin, '#!' + process.execPath + '\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  // Write as executable, including under a restrictive test umask.
  execFileSync(process.execPath, ['-e', 'require("node:fs").chmodSync(process.argv[1],0o700)', bin]);
  put(join(home, '.clawchat-connect/config.json'), { agents: { dsh: { runtime: { pluginId: 'whalenest.runtime.deepseek-harness' },
    runtimeConfig: { executablePathOverride: join(home, 'release/runtime/dsh-bridge.sh') } } } });
  const artifact = join(home, 'artifact.mjs'), manifestPath = join(home, 'manifest.json');
  put(artifact, 'export const name="fixture";'); put(manifestPath, {});
  put(join(home, '.clawchat-connect/plugins.lock.json'), { plugins: { 'whalenest.runtime.deepseek-harness': {
    version: '0.1.0-beta.9-whalenest.3', activeArtifact: artifact, manifestPath } } });
  put(join(home, '.dsh/profiles/sdk/package.json'), { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  for (const name of ['cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) put(join(home, '.dsh/profiles/sdk', name), '[]');
  put(join(home, '.dsh/companion/config.json'), { ownerId: 'owner', chatId: 'dm' });
  put(join(home, '.dsh/companion/memory/runtime/memories.json'), { version: 1, entries: [] });
  put(join(home, '.dsh/companion/delivery/state.json'), { sessions: ['original'] });
  put(join(root, '.whale-nest/cutover-preparation/instance.json'), { clawchat: { route: { sender: 'owner', conversation: 'dm' } } });
  const backup = join(root, 'backup'); cpSync(home, backup, { recursive: true });
  put(join(root, '.whale-nest/live-update/backup.json'), { backup });
  return { root, home, workspace, backup, health: { ready: true, connected: true },
    state: { ownerId: 'owner', conversationId: 'dm', running: 0, queued: 0 }, executables: { node: process.execPath, pnpm: bin, dsh: bin, supervisor: bin } };
}

test('Preflight rejects invalid workspace, busy owner, changed backup and changed inputs before cutover', () => {
  const f = fixture();
  assert.throws(() => inspectLiveUpdate({ ...f, workspace: join(f.home, 'nonexistent') }), /ENOENT|workspace/);
  assert.throws(() => inspectLiveUpdate({ ...f, state: { ...f.state, running: 1 } }), /active/);
  assert.throws(() => inspectLiveUpdate({ ...f, health: { ready: false } }), /not ready/);
  const plan = inspectLiveUpdate(f); assert.equal(plan.summary.serviceRestarted, false);
  verifyLiveInputs(plan);
  const packagePath = join(f.home, '.dsh/profiles/sdk/package.json');
  writeFileSync(packagePath, JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  assert.throws(() => verifyLiveInputs(plan), /input changed/);
  assert.throws(() => inspectLiveUpdate(f), /Backup does not match/);
});

test('Prepared commands execute in the sdk profile and use the offline installation operation', () => {
  const f = fixture(), plan = inspectLiveUpdate(f);
  cpSync(join(f.home, '.dsh/profiles/sdk'), plan.preparedProfile, { recursive: true });
  const command = plan.commands.lockfile;
  const result = JSON.parse(execFileSync(command.executable, command.args, { cwd: command.cwd }));
  assert.equal(result.cwd, plan.preparedProfile);
  assert.ok(existsSync(join(result.cwd, 'package.json')));
  assert.notEqual(result.cwd, f.root);
  assert.ok(result.args.includes('--offline') && result.args.includes('--lockfile-only'));
  const install = plan.commands.install;
  const installed = JSON.parse(execFileSync(install.executable, [...install.args, 'fixture.connect-plugin'], { cwd: install.cwd }));
  assert.deepEqual(installed.args, ['plugin', 'install', 'fixture.connect-plugin']);
});

test('Repeated final snapshots copy a venv symlink without following an old backup destination', () => {
  const f = fixture(), source = join(f.root, 'bili'), python = join(f.root, 'python');
  mkdirSync(source); mkdirSync(python); writeFileSync(join(python, 'untouched'), 'original');
  symlinkSync(python, join(source, '.venv'), 'dir');
  const first = reserveSnapshot(f.backup), second = reserveSnapshot(f.backup);
  assert.notEqual(first, second);
  cpSync(source, join(first, 'bili'), { recursive: true });
  cpSync(source, join(second, 'bili'), { recursive: true });
  assert.equal(readFileSync(join(python, 'untouched'), 'utf8'), 'original');
  assert.ok(existsSync(join(second, 'bili/.venv')));
});

test('Current installed target is a read-only no-op and does not require the old backup to match', () => {
  const f = fixture(), file = join(f.home, '.clawchat-connect/plugins.lock.json');
  const lock = JSON.parse(readFileSync(file)); lock.plugins['whalenest.runtime.deepseek-harness'].version = '0.1.0-beta.9-whalenest.4';
  writeFileSync(file, JSON.stringify(lock));
  const instance = join(f.home, '.dsh/companion/aurabot-v1/instance.json');
  mkdirSync(dirname(instance), { recursive: true });
  writeFileSync(instance, JSON.stringify({ cwd: f.workspace, clawchat: { route: { sender: 'owner', conversation: 'dm' } } }));
  const plan = inspectLiveUpdate(f);
  assert.equal(plan.alreadyActive, true);
  assert.equal(plan.summary.action, 'already-active');
  verifyLiveInputs(plan);
});

test('A running SDK is detected before it can write its instance lease', t => {
  const proc = mkdtempSync(join(tmpdir(), 'whalenest-sdk-procs-'));
  t.after(() => rmSync(proc, { recursive: true, force: true }));
  for (const [pid, home, args] of [[41, '/instances/fish', ['--profile', 'sdk']],
    [42, '/instances/other', ['--profile=sdk']], [43, '/instances/fish', ['--profile', 'other']]]) {
    const dir = join(proc, String(pid));
    mkdirSync(dir);
    writeFileSync(join(dir, 'cmdline'), ['dsh', ...args].join('\0') + '\0');
    writeFileSync(join(dir, 'environ'), 'DSH_HOME=' + home + '\0');
  }
  mkdirSync(join(proc, '44')); // Process exited between enumeration and reading its metadata.
  assert.deepEqual(sdkProcesses('/instances/fish', proc), [41]);
  assert.deepEqual(sdkProcesses('/instances/missing', proc), []);
});

test('Deployment verifies an externally built runtime and detects changes before stopping the instance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'whalenest-bundle-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'prepared.connect-plugin'), version = '0.3.0-test.1', target = 'linux-x64';
  const content = 'export default {}', entry = 'artifacts/runtime.mjs';
  const hash = (value, encoding) => createHash('sha256').update(value).digest(encoding);
  const bundle = JSON.stringify({ format: 'clawchat-connect-plugin-bundle-v1', manifest: { version,
    pluginId: 'whalenest.runtime.deepseek-harness', artifacts: [{ target, entry, integrity: 'sha256-' + hash(content, 'base64') }] },
  files: { [entry]: { encoding: 'utf8', content } } });
  const sha256 = hash(bundle, 'hex');
  writeFileSync(file, bundle);
  writeFileSync(join(dir, 'distribution.json'), JSON.stringify({ version, target, sha256 }));
  assert.deepEqual(inspectPreparedRuntimeBundle(file, version), { target, sha256 });
  writeFileSync(file, bundle + '\n');
  assert.throws(() => inspectPreparedRuntimeBundle(file, version), /digest mismatch/);
  assert.throws(() => verifyLiveInputs({ inputs: { [file]: sha256 } }), /Preflight input changed/);
});

test('Liveware only passes deployment when the exact registered app has a live relay', async () => {
  const origin = 'https://app-test.apps.clawling.io';
  const check = (data) => livewareRouteOnline(origin, async (url) => {
    assert.equal(url.href, origin + '/liveware-status');
    return Response.json({ data });
  });
  const online = { appId: 'app-test', bound: true, relayConnected: true, live: true };
  assert.equal(await check({ ...online, relayConnected: false, live: false }), false);
  assert.equal(await check({ ...online, appId: 'app-other' }), false);
  assert.equal(await check(online), true);
});

test('Actual test runner ignores generated metadata and invalidates reuse when vendored code changes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'whalenest-test-cache-')));
  for (const dir of ['src', 'scripts', 'test', 'deploy', 'integration', 'vendor/aurabot', 'vendor/qrcode-generator', 'vendor/platform-liveware']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('../scripts/test.mjs', import.meta.url), join(root, 'scripts/test.mjs'));
  for (const name of ['qq_login_window.py', 'qq_gateway_memory.py', 'serve-qq-gateway.py'])
    copyFileSync(new URL('../deploy/' + name, import.meta.url), join(root, 'deploy', name));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'vendor/aurabot.provenance.json'), '{}');
  writeFileSync(join(root, 'persona.txt'), 'fixture persona');
  writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({ personaReference: { localFile: 'persona.txt' } }));
  const dependency = join(root, 'vendor/aurabot/feature.js');
  writeFileSync(dependency, 'export const value=1;');
  const qrDependency = join(root, 'vendor/qrcode-generator/qrcode.cjs');
  writeFileSync(qrDependency, 'module.exports=1;');
  const voiceDependency = join(root, 'vendor/platform-liveware/gateway.py');
  writeFileSync(voiceDependency, 'port = 8897');
  writeFileSync(join(root, 'test/example.test.mjs'), [
    "import test from 'node:test'; import {appendFileSync} from 'node:fs';",
    "test('fixture',()=>appendFileSync('executions.txt','executed\\n'));",
  ].join('\n'));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT; // The child exercises a separate CLI, not this node:test worker.
  const run = () => execFileSync(process.execPath, ['scripts/test.mjs', '--reuse', 'test/example.test.mjs'], { cwd: root, encoding: 'utf8', env: childEnv });
  run();
  writeFileSync(join(root, 'vendor/platform-liveware/._gateway.py'), 'generated metadata');
  assert.match(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 1);
  writeFileSync(dependency, 'export const value=2;');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 2);
  writeFileSync(qrDependency, 'module.exports=2;');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 3);
  writeFileSync(voiceDependency, 'port = 8899');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 4);
});
