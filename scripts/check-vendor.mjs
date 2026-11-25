import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../vendor/aurabot/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../vendor/aurabot.provenance.json', import.meta.url)));
const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url)));
assert.equal(manifest.commit, lock.aurabot.commit);
const actual = [];
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(new URL(entry.name + '/', dir), name + '/');
    else { assert.ok(entry.isFile(), `Unexpected source link: ${name}`); actual.push(name); }
  }
}
await walk(root);
assert.deepEqual(actual.sort(), Object.keys(manifest.files).sort(), 'Vendored file set changed');
for (const [name, sha] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(await readFile(new URL(name, root))).digest('hex'), sha, name);
}
console.log(`Aurabot ${lock.aurabot.version}: ${actual.length} original files verified at ${manifest.commit}`);

const platform = new URL('../vendor/platform-liveware/',import.meta.url);
const {songsmith} = JSON.parse(await readFile(new URL('SOURCE.json',platform),'utf8'));
for (const [name, sha] of Object.entries(songsmith.reused ?? {})) {
  assert.equal(createHash('sha256').update(await readFile(new URL('songsmith/'+name,platform))).digest('hex'),sha,name);
}
console.log(`SongSmith ${songsmith.version}: original melody and ABC sources verified`);
