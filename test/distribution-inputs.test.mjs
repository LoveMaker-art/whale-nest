import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {distributionInputs} from '../src/distribution-inputs.mjs';
import {launcherFiles} from '../src/native-install.mjs';
test('the real distribution input list satisfies installation and bootstrap consumers without building an archive',async()=>{
 const files=await distributionInputs(fileURLToPath(new URL('../',import.meta.url)));
 for(const name of launcherFiles)assert.ok(files.includes(name),'Actual producer omits '+name);
 for(const name of ['deploy/serve-media.mjs','deploy/native-dsh-bridge.sh','scripts/source-preload.mjs','deploy/stop-qq-desktop.py'])assert.ok(files.includes(name));
 assert.equal(files.length,new Set(files).size);assert.ok(!files.some(name=>name.includes('core-extension')||name.endsWith('connector-extension.mjs')));
});
