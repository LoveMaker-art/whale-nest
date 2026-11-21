import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recoverLease } from '../src/recovery.mjs';
assert.ok(process.argv.includes('--offline'), 'Stop the instance supervisor first, then pass --offline');
const config = process.argv[2];
assert.ok(config && config !== '--offline', 'Usage: node scripts/recover-lock.mjs INSTANCE_JSON --offline');
console.log(JSON.stringify(recoverLease(JSON.parse(readFileSync(config, 'utf8')))));
