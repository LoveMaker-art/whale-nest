import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverIntent } from '../src/delivery.mjs';
import { readState, writeState } from '../src/state.mjs';

test('Delivery acknowledgement and uncertain outcome survive restart without replay', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'whalenest-outbox-')), 'state.json');
  let state = { outbox: {
    good: { id: 'good', state: 'pending', route: { channel: 'clawchat' }, text: 'hello' },
    lost: { id: 'lost', state: 'pending', text: 'timeout' },
    rejected: { id: 'rejected', state: 'pending', text: 'not sent' },
  } };
  const save = () => writeState(file, state);
  let count = 0;
  const adapter = { async sendText(intent) {
    count++;
    assert.equal(readState(file).outbox[intent.id].state, 'uncertain', 'Intent saved before external side effect');
    return { messageId: 'ack-123' };
  } };
  assert.equal((await deliverIntent(state, 'good', adapter, save)).state, 'confirmed');
  state = readState(file);
  await deliverIntent(state, 'good', adapter, save);
  assert.equal(count, 1);
  await assert.rejects(deliverIntent(state, 'lost', { sendText: async () => { throw new Error('Connection lost after send'); } }, save));
  state = readState(file);
  assert.equal((await deliverIntent(state, 'lost', adapter, save)).state, 'uncertain');
  assert.equal(count, 1, 'Unknown send outcome is not blindly retried');
  await assert.rejects(deliverIntent(state, 'rejected', { sendText: async () => { throw Object.assign(new Error('Offline before send'), { definitelyNotSent: true }); } }, save));
  assert.equal(state.outbox.rejected.state, 'pending');
  await deliverIntent(state, 'rejected', adapter, save);
  assert.equal(count, 2);
});
