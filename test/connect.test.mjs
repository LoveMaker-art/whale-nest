import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeDirectory, bootBridge } from './bridge-helper.mjs';

test('Existing Core bridge owns Aurabot sessions and native schedule cold activation', { timeout: 90000 }, async t => {
  const dir = await bridgeDirectory();
  let bridge = await bootBridge(dir);
  t.after(() => bridge.close());
  const id = 'existing-core-session';
  const oldNotificationId = 'whalenest-schedule-87cf1f8fd1583e616cbf90439f3bf1a5';
  await assert.rejects(bridge.request('create', { sessionId: 'foreign', cwd: dir.root, whalenestChatId: 'foreign-chat',
    model: dir.options.model }), /Unverified ClawChat conversation/);
  const created = await bridge.request('create', { sessionId: id, cwd: dir.root, whalenestChatId: 'dm-alice',
    permissionPreset: 'workspace-write', model: dir.options.model });
  assert.equal(created.sessionId, id);
  const first = await bridge.turn(id, 'write-blue', 'WRITE_BLUE 抱抱');
  const repeated = await bridge.request('prompt', { sessionId: id, inputId: 'write-blue', text: 'WRITE_BLUE 抱抱' });
  assert.equal(repeated.messageId, first.messageId);
  const history = await bridge.request('history', { sessionId: id });
  assert.equal(history.events.filter(e => e.type === 'user/message' && e.data.source?.connectInputId === 'write-blue').length, 1);
  assert.equal((await bridge.control('outbox')).length, 0, 'Core owns foreground delivery; no second sender');
  await bridge.request('create', { sessionId: 'another-native-session', cwd: dir.root, whalenestChatId: 'dm-alice', model: dir.options.model });
  assert.equal(await bridge.control('liveSessions'), 1);
  await bridge.request('resume', { sessionId: id, whalenestChatId: 'dm-alice' });
  assert.equal(await bridge.control('liveSessions'), 1);
  await assert.rejects(bridge.control('resolveUnknown'), /no trusted route/);
  const paused = await bridge.control('create', { title: 'Paused before migration', prompt: 'hello',
    timing: { kind: 'daily', daily: { time: '23:59:00', time_zone: 'Asia/Shanghai' } }, target: { kind: 'session', sessionId: id } });
  assert.ok(paused.id, JSON.stringify(paused));
  await bridge.control('edit', { id: paused.id, action: 'update', patch: { active: false } });
  await bridge.close();
  const runtimeFile = join(dir.options.dataDir, 'runtime.json');
  const persisted = JSON.parse(await readFile(runtimeFile));
  persisted.externalRoutes = {};
  await writeFile(runtimeFile, JSON.stringify(persisted));
  dir.options.clawchat.legacySnapshotPath = join(dir.root, 'legacy-notifications.json');
  await writeFile(dir.options.clawchat.legacySnapshotPath, JSON.stringify({
    chatId: 'dm-alice', ownerId: 'alice', state: { sessions: [id], taskId: paused.id, enabled: false,
      outbox: [{ id: oldNotificationId, messageId: 'legacy-ack' }, { id: 'legacy-uncertain', text: 'ambiguous old result' }] },
  }));
  await writeFile(dir.configPath, JSON.stringify(dir.options));
  bridge = await bootBridge(dir); // No live native handle: schedule must use the original owner to resume.
  const inherited = await bridge.control('outbox');
  assert.equal(inherited.find(e => e.id === oldNotificationId).state, 'confirmed');
  assert.equal(inherited.find(e => e.id === 'legacy-uncertain').state, 'uncertain');
  const replay = await bridge.control('queueHistorical', { sessionId: id, inputIds: ['legacy-source-id'], text: 'should not replace the old confirmed output' });
  assert.equal(replay.id, oldNotificationId, 'Historical notification ID format remains compatible');
  assert.equal(replay.state, 'confirmed');
  assert.equal(replay.messageId, 'legacy-ack');
  assert.equal((await bridge.control('outbox')).length, 2);
  const list = await bridge.control('list');
  assert.equal(list.items.filter(item => item.id === paused.id).length, 1);
  assert.equal(list.items.find(item => item.id === paused.id).status, 'paused');
  const task = await bridge.control('create', { title: 'Cold native reminder', prompt: 'hello schedule',
    timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: id } });
  const delivered = await bridge.wait(async () => (await bridge.control('outbox')).find(e => e.source === 'schedule' && e.state === 'confirmed' && e.id.startsWith('whalenest-schedule-') && e.id !== oldNotificationId), 30000);
  assert.equal(delivered.sessionId, id);
  assert.equal(delivered.route.conversation, 'dm-alice');
  assert.equal(delivered.text, 'fixture complete');
  assert.ok(delivered.messageId.startsWith('fixture-ack-'));
  const receipts = (await readFile(join(dir.root, 'delivered.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].input.chatId, 'dm-alice');
  assert.equal(receipts[0].input.mentions[0].userId, 'alice');
  await bridge.turn(id, 'read-blue', 'RECALL_BLUE 蓝莓蛋糕');
  const after = await bridge.request('history', { sessionId: id });
  assert.ok(JSON.stringify(after.events).includes('RECALLED_BLUE'));
  assert.equal((await bridge.control('outbox')).length, 3);
  await bridge.control('create', { title: 'Silent native reminder', prompt: 'SKIP_SCHEDULE',
    timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: id } });
  await bridge.wait(async () => (await bridge.control('outbox')).some(e => e.state === 'suppressed'));
  assert.equal((await readFile(join(dir.root, 'delivered.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const pending = await bridge.control('queueHistorical', { sessionId: id, inputIds: ['unsent-before-restart'], text: 'persisted pending notification' });
  assert.equal(pending.state, 'pending');
  await bridge.close();
  bridge = await bootBridge(dir);
  await bridge.wait(async () => (await bridge.control('outbox')).some(e => e.id === pending.id && e.state === 'confirmed'));
  const afterRestart = (await readFile(join(dir.root, 'delivered.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(afterRestart.length, 2, 'Restart drains only known-unsent work');
  assert.equal(afterRestart.filter(r => r.id === pending.id).length, 1);
  assert.equal(afterRestart.at(-1).input.text, 'persisted pending notification');

});
