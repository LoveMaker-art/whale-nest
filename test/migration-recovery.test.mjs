import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../vendor/aurabot/src/features/memory-store.js';
import { importLegacy, rollbackLegacy } from '../src/migration.mjs';
const worker = fileURLToPath(new URL('./migration-worker.mjs', import.meta.url));
const snapshot = { runtime: { version: 1, entries: [
  { target: 'user', importance: 'normal', content: '主人喜欢蓝莓蛋糕' },
  { target: 'memory', importance: 'normal', content: '主人周末喜欢看科幻电影' },
  { target: 'memory', importance: 'low', content: '主人经常在周三游泳' },
  { target: 'memory', importance: 'normal', content: '主人原本就有的事实' },
] }, mood: { happiness: 80 }, tasks: [{ status: 'paused' }] };
for (const fault of ['prepared', 'committed']) test('SIGKILL migration at ' + fault + ': resume, preserve edits, selective rollback, restore', () => {
  const directory = mkdtempSync(join(tmpdir(), 'whalenest-migration-'));
  writeFileSync(join(directory, 'source.json'), JSON.stringify(snapshot));
  const store = createMemoryStorage({ directory: () => join(directory, 'aurabot') });
  assert.equal(store.status().backend, 'sqlite');
  const existing = { id: 'preexisting', text: '主人原本就有的事实', about: '1', source: 'tool' };
  store.save({ items: [existing], customMetadata: { retained: true } });
  const killed = spawnSync(process.execPath, [worker, directory, fault], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const journal = JSON.parse(readFileSync(join(directory, 'migration-ledger.json')));
  const sourceHash = Object.keys(journal.imports)[0];
  assert.equal(journal.imports[sourceHash].state, 'prepared', 'External ledger intentionally lags native commit');
  const interrupted = store.load();
  assert.equal(interrupted.items.length, fault === 'prepared' ? 1 : 4);
  const marker = interrupted.whaleNestMigrations?.[sourceHash];
  if (fault === 'committed') assert.equal(marker.state, 'completed');
  // New writes made while the external ledger is unfinished must survive recovery.
  interrupted.items.push({ id: 'new-after-crash', text: '中断后新增的事实', about: '1', source: 'tool' });
  if (fault === 'committed') {
    interrupted.items.find(m => m.id === marker.imported[0].memoryId).text = '恢复前已经纠正的事实';
    interrupted.items = interrupted.items.filter(m => m.id !== marker.imported[1].memoryId);
  }
  interrupted.rev = (interrupted.rev || 0) + 1;
  store.save(interrupted);
  const resumed = spawnSync(process.execPath, [worker, directory], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  const receipt = JSON.parse(resumed.stdout.trim());
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.imported.length, 4);
  assert.equal(receipt.imported[3].owned, false, 'Preexisting exact facts are never claimed');
  let current = store.load();
  if (fault === 'committed') {
    assert.equal(current.items.find(m => m.id === receipt.imported[0].memoryId).text, '恢复前已经纠正的事实');
    assert.ok(!current.items.some(m => m.id === receipt.imported[1].memoryId), 'Recovery does not resurrect deleted facts');
  } else {
    current.items.find(m => m.id === receipt.imported[0].memoryId).text = '恢复前已经纠正的事实';
    current.items = current.items.filter(m => m.id !== receipt.imported[1].memoryId);
  }
  current.items.push({ id: 'new-after-migration', text: '完成后新增的事实', about: '1', source: 'tool' });
  store.save(current);
  const beforeRollback = structuredClone(current);
  const rolled = rollbackLegacy(sourceHash, directory);
  assert.equal(rolled.state, 'rolledback');
  assert.deepEqual(rolled.rollback.removed, [receipt.imported[2].memoryId]);
  assert.deepEqual(rolled.rollback.retained, [receipt.imported[0].memoryId]);
  assert.deepEqual(JSON.parse(readFileSync(rolled.rollback.exportFile)), beforeRollback);
  const after = store.load();
  assert.equal(after.items.length, 4);
  assert.deepEqual(after.customMetadata, { retained: true });
  assert.deepEqual(after.items.find(m => m.id === 'preexisting'), existing);
  assert.ok(after.items.some(m => m.id === 'new-after-crash'));
  assert.ok(after.items.some(m => m.id === 'new-after-migration'));
  assert.ok(!after.items.some(m => m.id === receipt.imported[1].memoryId));
  assert.equal(rollbackLegacy(sourceHash, directory).duplicate, true);
  assert.equal(importLegacy(snapshot, {}, directory).state, 'rolledback');
  assert.deepEqual(store.load(), after, 'Repeat import/rollback changes no user state');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'legacy-snapshots', receipt.archiveHash + '.json'))), snapshot);
  // Actual backup restoration into a fresh isolated directory, then continuation.
  store.close();
  const restored = mkdtempSync(join(tmpdir(), 'whalenest-restored-'));
  cpSync(directory, restored, { recursive: true });
  const restoredStore = createMemoryStorage({ directory: () => join(restored, 'aurabot') });
  assert.deepEqual(restoredStore.load(), after);
  assert.equal(rollbackLegacy(sourceHash, restored).duplicate, true);
  assert.deepEqual(restoredStore.load(), after);
  restoredStore.close();
});
