import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeState } from './state.mjs';

/** Read the host's SDK processes, including ones that have yet to take the data lease. */
export function sdkProcesses(home, proc = '/proc') {
  const pids = [];
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const processDir = join(proc, name);
    try {
      const args = readFileSync(join(processDir, 'cmdline'), 'utf8').split('\0');
      if (!args.some((arg, index) => arg === '--profile=sdk' || arg === '--profile' && args[index + 1] === 'sdk')) continue;
      const entry = readFileSync(join(processDir, 'environ'), 'utf8').split('\0').find(value => value.startsWith('DSH_HOME='));
      if (entry && resolve(entry.slice('DSH_HOME='.length)) === resolve(home)) pids.push(Number(name));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  return pids;
}

export async function waitForSdkExit(options, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (sdkProcesses(options.home).length) {
    assert.ok(Date.now() < deadline, 'Previous DSH SDK is still running for this instance');
    await delay(200);
  }
}

/** Offline operation: refuse live/foreign owners. No automatic lock stealing.
 * The instance supervisor must remain stopped throughout this operation.
 */
export function recoverLease(options) {
  const file = join(resolve(options.dataDir), 'runtime.lock');
  const before = statSync(file);
  const contents = readFileSync(file, 'utf8');
  const lease = JSON.parse(contents);
  assert.equal(lease.instanceId, options.instanceId, 'Lease belongs to a different instance');
  assert.equal(lease.hostname, hostname(), 'Cannot recover a lease from another host');
  assert.ok(Number.isSafeInteger(lease.pid) && lease.pid > 0, 'Invalid lease PID');
  try { process.kill(lease.pid, 0); throw new Error('Lease owner is still running'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const archive = join(resolve(options.dataDir), 'recovery', 'lease-' + randomUUID() + '.json');
  writeState(archive, lease);
  const after = statSync(file);
  assert.ok(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs
    && readFileSync(file, 'utf8') === contents, 'Lease changed during recovery');
  unlinkSync(file);
  return { recovered: true, archive };
}
