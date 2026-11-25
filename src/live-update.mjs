import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {configuredConnectExecutable} from './clawchat-core.mjs';

const pluginId = 'whalenest.runtime.deepseek-harness';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const profileFiles = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/** Read-only live inspection. Commands carry their cwd and the offline install
 * operation, so callers cannot accidentally use the project cwd or online replace.
 * Reports contain paths and checks; authenticated identities stay inside files.
 */
export function inspectLiveUpdate({ root, home, workspace, health, state, executables }) {
  root = resolve(root); home = resolve(home);
  const configFile = join(home, '.clawchat-connect/config.json');
  const lockFile = join(home, '.clawchat-connect/plugins.lock.json');
  const profile = join(home, '.dsh/profiles/sdk');
  const config = read(configFile), selected = read(lockFile).plugins[pluginId];
  assert.ok(selected, 'DSH runtime is not installed');
  assert.equal(config.agents.dsh.runtime.pluginId, pluginId, 'Unexpected runtime binding');
  assert.ok(['0.1.0-beta.9-whalenest.3', '0.1.0-beta.9-whalenest.4'].includes(selected.version), 'Unreviewed runtime version');
  assert.ok(health.ready && health.connected && !health.draining, 'Core is not ready');
  assert.ok(typeof workspace === 'string' && statSync(workspace).isDirectory(), 'Runtime workspace must be an existing directory');
  for (const [name, file] of Object.entries(executables)) {
    assert.ok(statSync(file).isFile(), 'Missing executable: ' + name); accessSync(file, constants.X_OK);
  }
  accessSync(join(home, '.dsh/companion'), constants.W_OK);
  const legacyFile = join(home, '.dsh/companion/config.json');
  const legacy = read(legacyFile);
  assert.equal(legacy.ownerId, state.ownerId, 'Authenticated owner changed');
  assert.equal(legacy.chatId, state.conversationId, 'Authenticated conversation changed');
  const manifest = read(join(profile, 'package.json'));
  assert.ok(Array.isArray(manifest.dsh?.profile?.bundles), 'Invalid sdk profile manifest');
  const alreadyActive = selected.version === '0.1.0-beta.9-whalenest.4';
  const instancePath = join(home, '.dsh/companion/aurabot-v1/instance.json');
  const candidatePath = alreadyActive ? instancePath : join(root, '.whale-nest/cutover-preparation/instance.json');
  const candidate = read(candidatePath);
  const connectBin = configuredConnectExecutable(candidate, config);
  accessSync(connectBin, constants.X_OK);
  assert.equal(candidate.clawchat.route.sender, state.ownerId, 'Candidate owner mismatch');
  assert.equal(candidate.clawchat.route.conversation, state.conversationId, 'Candidate conversation mismatch');
  if (alreadyActive) assert.equal(resolve(candidate.cwd), resolve(workspace), 'Installed workspace mismatch');
  else {
    assert.equal(state.running, 0, 'An owner turn is active');
    assert.equal(state.queued, 0, 'Owner input is queued');
    const runtime = read(join(home, '.dsh/companion/memory/runtime/memories.json'));
    assert.equal(runtime.version, 1, 'Unknown legacy memory format');
    assert.ok(Array.isArray(runtime.entries), 'Legacy memory entries missing');
    assert.ok(Array.isArray(read(join(home, '.dsh/companion/delivery/state.json')).sessions), 'Legacy sessions missing');
  }
  const inputPaths = [configFile, lockFile, legacyFile, candidatePath, ...profileFiles.map(name => join(profile, name)),
    ...Object.values(executables), connectBin, selected.activeArtifact, selected.manifestPath];
  const inputs = Object.fromEntries([...new Set(inputPaths)].map(file => [file, digest(file)]));
  if (!alreadyActive) {
    const backup = read(join(root, '.whale-nest/live-update/backup.json')).backup;
    assert.ok(statSync(backup).isDirectory(), 'Backup directory missing');
    accessSync(backup, constants.W_OK);
    for (const file of [configFile, lockFile, ...profileFiles.map(name => join(profile, name))]) {
      assert.equal(digest(file), digest(join(backup, file.slice(home.length + 1))), 'Backup does not match live configuration');
    }
  }
  const preparedProfile = join(root, '.whale-nest/live-update', 'prepared-' + randomUUID(), 'profile');
  return { root, home, profile, preparedProfile, configFile, lockFile, instancePath, candidatePath, workspace,
    alreadyActive, inputs,
    commands: {
      lockfile: { executable: executables.pnpm, args: ['install', '--lockfile-only', '--offline', '--ignore-scripts'], cwd: preparedProfile },
      install: { executable: connectBin, args: ['plugin', 'install'], cwd: root },
    },
    summary: { ok: true, action: alreadyActive ? 'already-active' : 'ready-to-prepare',
      version: selected.version, profile: 'sdk', workspace, serviceRestarted: false,
      checks: ['runtime and identity', 'real workspace', 'executables', 'sdk profile', 'migration sources',
        alreadyActive ? 'installed instance configuration' : 'matching private backup', 'offline installer and explicit cwd'] } };
}

/** Recheck immutable inputs immediately before stopping the service. */
export function verifyLiveInputs(plan) {
  for (const [file, expected] of Object.entries(plan.inputs)) assert.equal(digest(file), expected, 'Preflight input changed: ' + file);
}

export async function livewareRouteOnline(value, request = fetch) {
  const url = new URL(value);
  assert.match(url.href, /^https:\/\/app-[a-z0-9-]+\.apps\.clawling\.io\/$/, 'Invalid Liveware app URL');
  const appId = url.hostname.split('.')[0];
  const response = await request(new URL('/liveware-status', url), {
    redirect: 'error', signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) return false;
  const { data } = await response.json();
  return data?.appId === appId && data.bound === true && data.relayConnected === true && data.live === true;
}

export function inspectPreparedRuntimeBundle(path, version) {
  const prepared = read(join(dirname(path), 'distribution.json'));
  assert.ok(prepared.version === version && prepared.target === 'linux-x64', 'Unexpected prepared runtime version or target');
  const raw = readFileSync(path);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assert.equal(sha256, prepared.sha256, 'Prepared runtime bundle digest mismatch');
  const bundle = JSON.parse(raw);
  assert.equal(bundle.format, 'clawchat-connect-plugin-bundle-v1', 'Official installer bundle format required');
  assert.equal(bundle.manifest.pluginId, pluginId, 'Unexpected runtime plugin identity');
  assert.equal(bundle.manifest.version, version, 'Unexpected runtime bundle version');
  assert.ok(bundle.manifest.artifacts.some(artifact => artifact.target === prepared.target), 'Prepared runtime target is missing');
  for (const artifact of bundle.manifest.artifacts) {
    const file = bundle.files[artifact.entry];
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    assert.equal('sha256-' + createHash('sha256').update(bytes).digest('base64'), artifact.integrity);
  }
  return { target: prepared.target, sha256 };
}

/** Every attempt reserves a new empty directory, including repeated same-ms calls. */
export function reserveSnapshot(backup, label = 'freeze') {
  assert.match(label, /^[a-z-]+$/);
  return mkdtempSync(join(backup, label + '-'));
}
