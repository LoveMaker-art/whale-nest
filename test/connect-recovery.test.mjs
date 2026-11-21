import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverLease } from '../src/recovery.mjs';
import { bridgeDirectory, bootBridge } from './bridge-helper.mjs';

test('Recover durable native schedule output across a SIGKILL before outbox commit', { timeout: 60000 }, async t => {
  const dir = await bridgeDirectory();
  let bridge = await bootBridge(dir);
  t.after(() => bridge.close());
  assert.throws(() => recoverLease(dir.options), /still running/, 'A live native owner lease cannot be removed');
  const sessionId = 'native-crash-window';
  await bridge.request('create', { sessionId, cwd: dir.root, whalenestChatId: 'dm-alice', model: dir.options.model });
  await bridge.control('armCrash');
  await bridge.control('create', { title: 'Crash after flush', prompt: 'hello schedule',
    timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Crash did not occur')), 20000);
    bridge.child.once('exit', (code, signal) => { clearTimeout(timer); assert.equal(signal, 'SIGKILL'); resolve(); });
  });
  assert.equal(await readFile(join(dir.root, 'control.json.crashed'), 'utf8'), 'after-native-flush-before-outbox');
  const runtimeFile = join(dir.options.dataDir, 'runtime.json');
  assert.equal(Object.keys(JSON.parse(await readFile(runtimeFile)).outbox).length, 0);
  const trace = await readFile(join(dir.root, 'trace.jsonl'), 'utf8');
  assert.equal(recoverLease(dir.options).recovered, true);
  bridge = await bootBridge(dir);
  await delay(800);
  const recovered = (await bridge.control('outbox')).filter(e => e.state === 'confirmed');
  assert.equal(recovered.length, 1, 'Durable native output must be reconstructed without regenerating it');
  assert.equal(recovered[0].sessionId, sessionId);
  assert.equal(await readFile(join(dir.root, 'trace.jsonl'), 'utf8'), trace, 'Recovery must not call the model again');
  await bridge.close();
  bridge = await bootBridge(dir);
  await delay(300);
  assert.equal((await readFile(join(dir.root, 'delivered.jsonl'), 'utf8')).trim().split('\n').length, 1);
});
