import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDirectory, boot, input, owners } from './host-helper.mjs';

test('Aurabot on native DSH: tools, owner isolation, routes, deduplication and cold recovery', { timeout: 60000 }, async t => {
  const directory = await fixtureDirectory();
  let host = await boot(directory);
  t.after(() => host.close());
  assert.deepEqual((await host.request('status')).modules.sort(), ['bili', 'companion-management', 'diary', 'memory', 'mood', 'speakup', 'stickers', 'voice']);
  const write = await host.request('receive', { input: input('write', 'WRITE_BLUE 谢谢你，抱抱') });
  assert.equal(write.state, 'completed');
  assert.equal(write.intent.text, 'fixture complete');
  const duplicate = await host.request('receive', { input: input('write', 'WRITE_BLUE 谢谢你，抱抱') });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.intent, write.intent);
  assert.equal((await host.request('status')).maxLiveSessions, 1);
  await assert.rejects(host.request('receive', { input: input('write', 'altered') }), /Message ID reused/);

  const qqRoute = { ...owners[1], conversation: 'qq-private', kind: 'private' };
  const shared = await host.request('receive', { input: input('recall', 'RECALL_BLUE 蓝莓蛋糕', qqRoute) });
  assert.equal(shared.intent.text, 'RECALLED_BLUE');
  assert.deepEqual(shared.intent.route, qqRoute);
  assert.notEqual(shared.sessionId, write.sessionId);
  assert.equal((await host.request('status')).liveSessions, 1);
  const stranger = await host.request('receive', { input: input('recall', 'RECALL_BLUE 蓝莓蛋糕', { sender: 'bob', conversation: 'dm-bob' }) });
  assert.equal(stranger.intent.text, 'NO_PRIVATE_MEMORY');
  const group = await host.request('receive', { input: input('recall', 'RECALL_BLUE 蓝莓蛋糕', { kind: 'group', conversation: 'group-one' }) });
  assert.equal(group.intent.text, 'NO_PRIVATE_MEMORY');
  const sameConversationDifferentSender = await host.request('receive', { input: input('spoof', 'RECALL_BLUE 蓝莓蛋糕', { sender: 'bob' }) });
  assert.equal(sameConversationDifferentSender.intent.text, 'NO_PRIVATE_MEMORY');
  assert.notEqual(sameConversationDifferentSender.sessionId, write.sessionId);
  for (const route of [{ sender: 'bob', conversation: 'dm-bob' }, { kind: 'group', conversation: 'group-one' }]) {
    const deniedRecall = await host.request('receive', { input: input('tool-recall', 'TOOL_RECALL_BLUE 蓝莓蛋糕', route) });
    assert.equal(deniedRecall.intent.text, 'NO_PRIVATE_MEMORY', 'The actual recall tool cannot bypass private-memory scope');
  }
  const concurrentInputs = [input('same-id', 'hello'), input('same-id', 'hello', qqRoute)];
  const concurrentResults = await Promise.all(concurrentInputs.map(message => host.request('receive', { input: message })));
  assert.notEqual(concurrentResults[0].intent.id, concurrentResults[1].intent.id);
  assert.deepEqual(concurrentResults.map(r => r.intent.route), concurrentInputs.map(i => i.route));
  const beforeFailure = (await host.request('outbox')).length;
  const failedInput = input('model-failure', 'FAIL_TURN');
  await assert.rejects(host.request('receive', { input: failedInput }), /DSH turn did not complete/);
  const held = await host.request('receive', { input: failedInput });
  assert.equal(held.state, 'uncertain');
  assert.equal(held.duplicate, true);
  assert.equal((await host.request('outbox')).length, beforeFailure, 'Failed generation creates no delivery intent');
  assert.equal((await host.request('receive', { input: input('after-failure', 'hello again') })).state, 'completed');
  const moodBefore = JSON.parse(await readFile(join(directory.options.dataDir, 'aurabot/mood.json')));
  assert.ok(moodBefore.history.length >= 1);
  await host.request('receive', { input: { ...input('schedule', '抱抱 谢谢你'), source: 'schedule' } });
  const moodAfter = JSON.parse(await readFile(join(directory.options.dataDir, 'aurabot/mood.json')));
  assert.deepEqual(moodBefore.history, moodAfter.history, 'Schedule input must not change mood');
  const count = (await host.request('outbox')).length;
  await host.close();
  host = await boot(directory);
  const restored = await host.request('receive', { input: input('after-restart', 'RECALL_BLUE 蓝莓蛋糕') });
  assert.equal(restored.sessionId, write.sessionId);
  assert.equal(restored.intent.text, 'RECALLED_BLUE');
  assert.equal((await host.request('outbox')).length, count + 1);
  const traces = (await readFile(join(directory.root, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const lastMessages = JSON.stringify(traces.at(-1).messages);
  assert.ok(lastMessages.includes('WRITE_BLUE'), 'Native session history survives process restart');
});

test('Canonical legacy import: sources, repeat import, correction, deletion and restart', { timeout: 60000 }, async t => {
  const directory = await fixtureDirectory();
  let host = await boot(directory);
  t.after(() => host.close());
  const snapshot = { runtime: { version: 1, entries: [
    { target: 'user', importance: 'critical', content: '主人喜欢蓝莓蛋糕 SECRET_BLUEBERRY' },
    { target: 'memory', importance: 'normal', content: '主人周末喜欢看科幻电影' },
    { target: 'memory', importance: 'low', content: '仅分支可见的事实', branches: ['private-branch'] },
  ] }, mood: { happiness: 80, sadness: 5 }, bili: { loggedIn: false }, tasks: [{ status: 'paused' }] };
  const receipt = await host.request('migration.import', { snapshot });
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.imported.length, 2);
  assert.equal(receipt.skipped.length, 1);
  assert.equal((await host.request('migration.import', { snapshot })).duplicate, true);
  assert.equal((await host.request('memory.list')).length, 2);
  await assert.rejects(host.request('memory.update', { memoryId: receipt.imported[0].memoryId, text: '' }), /Memory update requires/);
  await assert.rejects(host.request('migration.import', { snapshot: { runtime: { version: 2, entries: [] } } }), /Runtime v1/);
  assert.equal((await host.request('memory.list')).length, 2);
  const stored = JSON.parse(await readFile(join(directory.options.dataDir, 'legacy-snapshots', receipt.archiveHash + '.json')));
  assert.deepEqual(stored, snapshot, 'Original dimensions, config, scope and paused tasks remain intact');
  const id = receipt.imported[0].memoryId;
  assert.equal((await host.request('memory.update', { memoryId: id, text: '主人喜欢草莓蛋糕 CORRECTED_STRAWBERRY' })).ok, true);
  assert.equal((await host.request('memory.delete', { memoryId: receipt.imported[1].memoryId })).ok, true);
  await host.close();
  host = await boot(directory);
  const list = await host.request('memory.list');
  assert.equal(list.length, 1);
  assert.ok(list[0].text.includes('CORRECTED_STRAWBERRY'));
  await host.request('migration.import', { snapshot });
  assert.deepEqual(await host.request('memory.list'), list, 'Repeat import does not resurrect deleted or corrected records');
  const changedMeta = await host.request('migration.import', { snapshot: { ...snapshot, mood: { happiness: 40 } } });
  assert.equal(changedMeta.duplicate, true);
  assert.deepEqual(await host.request('memory.list'), list, 'Changed legacy mood does not reimport corrected facts');
  await host.request('receive', { input: input('post-import-write', 'WRITE_BLUE') });
  const afterNewWrite = (await host.request('memory.list')).map(m => ({ id: m.id, text: m.text }));
  assert.equal(afterNewWrite.length, 2);
  const rollback = await host.request('migration.rollback', { sourceHash: receipt.sourceHash });
  assert.equal(rollback.state, 'rolledback');
  assert.deepEqual((await host.request('memory.list')).map(m => ({ id: m.id, text: m.text })), afterNewWrite);
  await host.close();
  host = await boot(directory);
  assert.equal((await host.request('migration.rollback', { sourceHash: receipt.sourceHash })).duplicate, true);
  assert.equal((await host.request('migration.import', { snapshot })).state, 'rolledback');
  assert.deepEqual((await host.request('memory.list')).map(m => ({ id: m.id, text: m.text })), afterNewWrite,
    'Native DSH restart and migration retry preserve post-migration corrections and new tool writes');

});
