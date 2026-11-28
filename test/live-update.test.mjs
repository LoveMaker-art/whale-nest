import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inspectPreparedRuntimeBundle } from '../src/live-update.mjs';
import { sdkProcesses } from '../src/recovery.mjs';

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
});
