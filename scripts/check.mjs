import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(path, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(await read(join(root, 'upstream.lock.json')));
assert.equal(lock.schemaVersion, 1);
for (const name of ['aurabot', 'clawchatConnect']) {
  assert.match(lock[name].commit, /^[0-9a-f]{40}$/);
  assert.match(lock[name].repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
}
assert.equal(lock.aurabot.version, '1.2.1');
assert.equal(lock.dsh.version, '0.2.2-rc.1');
for (const field of ['license', 'notices']) {
  assert.equal(sha(await readFile(join(root, lock.aurabot[field + 'File']))), lock.aurabot[field + 'Sha256']);
}
assert.equal(sha(await readFile(join(root, lock.personaReference.localFile))), lock.personaReference.sha256);
assert.equal(sha(await readFile(join(root, lock.personaReference.licenseFile))), lock.personaReference.licenseSha256);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}
const files = [join(root, 'README.md'), join(root, 'GLOSSARY.md'), join(root, 'AGENTS.md')];
for (const directory of ['docs', 'deploy', 'integration']) files.push(...await markdownFiles(join(root, directory)));
const contents = new Map(await Promise.all(files.map(async path => [path, await read(path)])));
const withoutFences = text => text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');
function anchors(text) {
  const used = new Map(), ids = new Set();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const title = match[1].toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const count = used.get(title) ?? 0;
    ids.add(title + (count ? '-' + count : '')); used.set(title, count + 1);
  }
  return ids;
}
const errors = [];
let localLinks = 0, sourceLinks = 0, snapshotLinks = 0;
for (const [path, full] of contents) {
  const text = withoutFences(full);
  const links = [
    ...[...text.matchAll(/\]\((<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\)/g)].map(m => m[1]),
    ...[...text.matchAll(/^\[[^\]]+\]:\s*(<[^>\n]+>|\S+)/gm)].map(m => m[1]),
  ];
  for (let url of links) {
    if (url.startsWith('<')) url = url.slice(1, -1);
    if (/^[a-zA-Z][\w+.-]*:/.test(url) || url.startsWith('/')) { sourceLinks++; continue; }
    const [raw, fragment] = url.split('#');
    const target = raw ? resolve(dirname(path), decodeURIComponent(raw)) : path;
    if (relative(root, target).startsWith('..')) continue;
    // Historical source citations point into optional, ignored research caches.
    // A clean checkout must not require those private local snapshots.
    if (relative(root, target).startsWith('.whale-nest/')) { snapshotLinks++; continue; }
    localLinks++;
    try {
      await stat(target);
      if (fragment && target.endsWith('.md')) {
        const targetText = contents.get(target) ?? await read(target);
        const line = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
        if (line) {
          const last = Number(line[2] ?? line[1]);
          if (Number(line[1]) < 1 || last < Number(line[1]) || last > targetText.split('\n').length) throw new Error('源码行号越界');
        } else if (!anchors(targetText).has(decodeURIComponent(fragment))) throw new Error('标题锚点不存在');
      }
    } catch (error) { errors.push(`${relative(root, path)} -> ${url}: ${error.code ?? error.message}`); }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`检查通过：${contents.size} 份 Markdown，${localLinks} 个仓库内链接与锚点；上游来源锁、Aurabot 许可及原始人格哈希一致。`);
  console.log(`另有 ${sourceLinks} 个外部链接；本检查不请求网络，也不执行 Agent 或部署脚本。`);
  console.log(`${snapshotLinks} 个可选本地源码快照引用保留为历史证据，不计入分发文件链接检查。`);
}
