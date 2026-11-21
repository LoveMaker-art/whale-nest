import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createMemoryStorage } from '../vendor/aurabot/src/features/memory-store.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { looksLikeRuleMemory } from '../vendor/aurabot/src/features/memory.js';
import { hash } from './routing.mjs';
import { readState, writeState } from './state.mjs';

/** Convert the canonical mnemon v1 index, not its generated Markdown headers.
 * This is a management operation on an isolated copy. Original entries and
 * dimensions remain in the private snapshot even when they cannot be imported.
 */
export function planLegacy(snapshot) {
  assert.equal(snapshot?.runtime?.version, 1, 'Expected a canonical mnemon Runtime v1 snapshot');
  assert.ok(Array.isArray(snapshot.runtime.entries), 'Runtime entries required');
  const entries = [], skipped = [];
  for (const [index, entry] of snapshot.runtime.entries.entries()) {
    assert.ok(entry && ['user', 'memory'].includes(entry.target) && typeof entry.content === 'string', `Invalid entry ${index}`);
    assert.ok(['critical', 'normal', 'low'].includes(entry.importance), `Invalid importance ${index}`);
    assert.ok(entry.branches === undefined || (Array.isArray(entry.branches) && entry.branches.every(b => typeof b === 'string')), 'Invalid branch scope');
    const text = entry.content.trim();
    const sourceId = hash(entry);
    // Do not promote imported instructions to factual memory. Nothing is
    // discarded: skipped records stay in the exact private source snapshot.
    if (!text || looksLikeRuleMemory(text) || entry.branches?.length) {
      skipped.push({ index, sourceId, reason: entry.branches?.length ? 'branch-scope-needs-review' : 'empty-or-rule-needs-review' });
      continue;
    }
    let chunk = '', part = 0;
    for (const character of text) {
      if ((chunk + character).length > 200) { entries.push({ sourceId, part: part++, text: chunk, importance: entry.importance, target: entry.target }); chunk = ''; }
      chunk += character;
    }
    if (chunk) entries.push({ sourceId, part, text: chunk, importance: entry.importance, target: entry.target });
  }
  return { schema: 1, sourceHash: hash(snapshot.runtime), archiveHash: hash(snapshot), entries, skipped,
    mood: { initialization: 'Aurabot base 60; seven-dimensional source archived without conversion' },
    bili: { status: 'configuration archived; login and capability mapping still required' },
    schedules: { status: 'archived only; never auto-enable or recreate tasks' } };
}


function storageFor(directory) {
  const storage = createMemoryStorage({ directory: () => join(directory, 'aurabot') });
  assert.equal(storage.status().backend, 'sqlite', 'Migration requires transactional SQLite; preserve fallback files for review');
  return storage;
}
const ledgerAt = directory => join(directory, 'migration-ledger.json');
const ledgerFor = directory => readState(ledgerAt(directory), { schema: 2, imports: {} });
function commit(storage, state) {
  storage.save(state);
  assert.equal(storage.status().backend, 'sqlite', 'SQLite commit failed; review preserved fallback before continuing');
}
function finishReceipt(ledger, directory, marker, archiveHash) {
  const receipt = { ...marker, archiveHash: archiveHash ?? marker.archiveHash };
  delete receipt.records;
  ledger.imports[marker.sourceHash] = receipt;
  writeState(ledgerAt(directory), ledger);
  return structuredClone(receipt);
}

/** Synchronous management transaction on the original Aurabot store.
 * Facts and their migration ownership receipt commit in the same SQLite txn.
 * The private external journal may lag this txn; it is never the commit oracle.
 */
export function importLegacy(snapshot, _memory, directory) {
  const plan = planLegacy(snapshot);
  writeState(join(directory, 'legacy-snapshots', plan.archiveHash + '.json'), snapshot);
  const ledger = ledgerFor(directory);
  const storage = storageFor(directory);
  try {
    const raw = storage.load();
    raw.whaleNestMigrations ??= {};
    const applied = raw.whaleNestMigrations[plan.sourceHash];
    if (applied) return { ...finishReceipt(ledger, directory, applied, plan.archiveHash), duplicate: true };
    const previous = ledger.imports[plan.sourceHash];
    // Old prototype receipts have no atomic ownership evidence. Never guess.
    assert.ok(!previous || (previous.version === 2 && previous.state === 'prepared'),
      'Legacy migration receipt has no atomic commit proof; preserve target for manual review');
    if (!previous) {
      writeState(join(directory, 'migration-snapshots', plan.sourceHash + '-before.json'), raw);
      ledger.imports[plan.sourceHash] = { version: 2, state: 'prepared', sourceHash: plan.sourceHash,
        archiveHash: plan.archiveHash, imported: [], skipped: plan.skipped };
      writeState(ledgerAt(directory), ledger);
    }
    const imported = [], records = [];
    const now = Date.now();
    for (const entry of plan.entries) {
      // Exact existing facts are reused without modifying or claiming them.
      const existing = raw.items.find(m => m.text === entry.text && m.about === '1' && m.scope !== 'group'
        && !m.invalidAt && !m.validUntil && !m.kind && (!m.status || m.status === 'fact'));
      let memoryId = existing?.id;
      if (!existing) {
        memoryId = 'mnemon-' + hash([plan.sourceHash, entry.sourceId, entry.part]).slice(0, 32);
        assert.ok(!raw.items.some(m => m.id === memoryId), 'Migration ID collision without commit receipt');
        const record = { id: memoryId, text: entry.text, about: '1', aboutName: '主人',
          source: 'import', chatId: 'private:1', importance: { critical: 0.9, normal: 0.6, low: 0.3 }[entry.importance],
          tags: ['mnemon', entry.target, entry.sourceId.slice(0, 12)], at: now, saidAt: now, validFrom: now, hits: 0 };
        raw.items.push(record); records.push(structuredClone(record));
      }
      imported.push({ sourceId: entry.sourceId, part: entry.part, memoryId, owned: !existing });
    }
    const marker = { version: 2, state: 'completed', sourceHash: plan.sourceHash, archiveHash: plan.archiveHash,
      imported, records, skipped: plan.skipped };
    raw.whaleNestMigrations[plan.sourceHash] = marker;
    raw.rev = (raw.rev || 0) + 1;
    commit(storage, raw);
    return finishReceipt(ledger, directory, marker);
  } finally { storage.close(); }
}

/** Remove only our untouched created rows. Preserve all new/edited user data,
 * existing rows, deletions, and the full pre-rollback state as a private export.
 * Repeating import after rollback does not resurrect removed facts.
 */
export function rollbackLegacy(sourceHash, directory) {
  assert.match(sourceHash, /^[a-f0-9]{64}$/, 'Invalid migration source hash');
  const ledger = ledgerFor(directory);
  const storage = storageFor(directory);
  try {
    const raw = storage.load();
    const marker = raw.whaleNestMigrations?.[sourceHash];
    assert.ok(marker?.version === 2, 'No atomic migration ownership receipt');
    if (marker.state === 'rolledback') return { ...finishReceipt(ledger, directory, marker), duplicate: true };
    const exportFile = join(directory, 'migration-snapshots', sourceHash + '-rollback-' + randomUUID() + '.json');
    writeState(exportFile, raw);
    const owned = new Map(marker.records.map(record => [record.id, record]));
    const removed = [], retained = [];
    raw.items = raw.items.filter(item => {
      const original = owned.get(item.id);
      if (!original) return true;
      if (!isDeepStrictEqual(item, original)) { retained.push(item.id); return true; }
      removed.push(item.id); return false;
    });
    marker.state = 'rolledback';
    marker.rollback = { exportFile, removed, retained };
    raw.rev = (raw.rev || 0) + 1;
    commit(storage, raw);
    return finishReceipt(ledger, directory, marker);
  } finally { storage.close(); }
}
