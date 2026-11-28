import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const pluginId = 'whalenest.runtime.deepseek-harness';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const profileFiles = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

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
