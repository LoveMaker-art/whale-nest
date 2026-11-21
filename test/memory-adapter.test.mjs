import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryAdapter, memoryCallContext } from '../src/memory-adapter.mjs';

async function fixture(t, automatic = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'whalenest-history-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = { channel: 'clawchat', account: 'agent', sender: 'alice' };
  const route = { ...owner, kind: 'private', conversation: 'dm' };
  const events = [], policy = { maintenanceReason: () => null, status: () => ({ dailyModelRequestLimit: 2, usage: { modelRequests: 0 } }) };
  const adapter = createMemoryAdapter({ sessionPersistence: { inspect: async () => ({ events: structuredClone(events) }) } },
    { dataDir, instanceId: 'history-test', owners: [owner], memory: { automatic } }, policy);
  t.after(() => adapter.close());
  return { adapter, policy, events, route, dataDir };
}

test('memory history admits only durable authenticated human input and never deletes native history', async t => {
  const f = await fixture(t);
  const input = { sessionId: 's', inputId: 'one', text: '<clawchat_turn_context>\n{"name":"可爱"}\n</clawchat_turn_context>\n我喜欢海洋', route: f.route };
  f.adapter.capture(input); f.adapter.capture(input);
  assert.equal((await f.adapter.refresh()).added, 0);
  assert.equal(f.adapter.status().pendingInputs, 1, 'Prepared but unadmitted content is not a fact source');
  f.events.push({ seq: 0, type: 'user/message', data: { id: 'native-one', source: { kind: 'user', connectInputId: 'one' } } });
  assert.equal((await f.adapter.refresh()).added, 1);
  assert.equal((await f.adapter.refresh()).added, 0);
  const day = f.adapter.hub.chatLogDays()[0];
  assert.equal(f.adapter.hub.chatLogOf(day)[0].text, '我喜欢海洋');
  for (const [id, extra] of [['self-test', { text: '运维自测 喜欢你' }], ['scheduled', { source: 'schedule' }],
    ['stranger', { route: { ...f.route, sender: 'bob' } }]]) f.adapter.capture({ ...input, inputId: id, ...extra });
  assert.equal(f.adapter.status().pendingInputs, 0);
  assert.equal(f.adapter.hub.forgetChatLog('1', '海洋'), 1);
  assert.ok(f.adapter.hub.chatLogOf(day)[0].forgottenAt);
  assert.equal(f.adapter.hub.forgetChatLog('1', '海洋'), 0);
  const before = structuredClone(f.events);
  f.adapter.hub.deleteChatLog(day);
  assert.deepEqual(f.events, before);
  assert.equal((await f.adapter.refresh()).added, 0, 'Cleaned projections are not rebuilt from old native events');
  assert.deepEqual(f.adapter.hub.chatLogDays(), []);
});

test('the original timer callback is scoped, non-overlapping and honours the maintenance gate', async t => {
  const f = await fixture(t, true);
  let callback, release, calls = 0, registrations = 0;
  const held = new Promise(resolve => { release = resolve; });
  f.adapter.wrapModule({ id: 'memory', setup(api) {
    api.every(60000, async () => {
      calls++; assert.equal(memoryCallContext.getStore().kind, 'memory'); await held;
    }, '原记忆整理');
  } }).setup({ every(ms, fn) { assert.equal(ms, 60000); registrations++; callback = fn; } });
  const first = callback();
  await new Promise(setImmediate);
  await callback();
  assert.equal(registrations, 1); assert.equal(calls, 1);
  release(); await first;
  assert.equal(memoryCallContext.getStore(), undefined);
  f.policy.maintenanceReason = () => 'paused';
  assert.equal((await callback()).reason, 'paused');
  assert.equal(calls, 1);
});

test('bad compatibility data reports a maintenance error without rejecting the foreground refresh', async t => {
  const f = await fixture(t);
  const input = { sessionId: 's', inputId: 'one', text: '我喜欢海洋', route: f.route };
  f.adapter.capture(input);
  f.events.push({ seq: 0, type: 'user/message', data: { id: 'one', source: { kind: 'user', connectInputId: 'one' } } });
  await f.adapter.refresh();
  const day = f.adapter.hub.chatLogDays()[0];
  await writeFile(join(f.dataDir, 'aurabot/chatlog', day + '.jsonl'), 'invalid-json\n');
  f.adapter.capture({ ...input, inputId: 'two' });
  f.events.push({ seq: 1, type: 'user/message', data: { id: 'two', source: { kind: 'user', connectInputId: 'two' } } });
  assert.equal((await f.adapter.refresh()).ok, false);
  assert.ok(f.adapter.status().lastError);
});
