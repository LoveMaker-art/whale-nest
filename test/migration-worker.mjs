import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [directory, fault] = process.argv.slice(2);
if (fault) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/migration-ledger.json')) {
      const state = JSON.parse(fs.readFileSync(from));
      const receipt = Object.values(state.imports)[0];
      if (fault === 'prepared' && receipt.state === 'prepared') {
        rename(from, to); process.kill(process.pid, 'SIGKILL');
      }
      if (fault === 'committed' && receipt.state === 'completed') process.kill(process.pid, 'SIGKILL');
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
const { importLegacy } = await import('../src/migration.mjs');
const snapshot = JSON.parse(fs.readFileSync(join(directory, 'source.json')));
const receipt = importLegacy(snapshot, {}, directory);
console.log(JSON.stringify(receipt));
