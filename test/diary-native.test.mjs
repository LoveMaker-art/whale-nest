import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';

test('original compose uses only activity sources in its own native Session, skips empty days and generates once across restart',{timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.biliFixture=true;dir.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:0};await writeFile(dir.configPath,JSON.stringify(dir.options));let bridge=await bootBridge(dir);
 t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});const sessionId='diary-source-native';await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 const traces=async()=>(await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),compositions=rows=>rows.filter(r=>r.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('【私人活动日记】')));
 await bridge.turn(sessionId,'chat','PRIVATE_CHAT_SOURCE_CANARY');await bridge.turn(sessionId,'private-memory','FOUNDATION_TOOL '+JSON.stringify({name:'remember',args:{text:'主人喜欢 PRIVATE_MEMORY_SOURCE_CANARY'}}));
 assert.equal((await bridge.control('legacyDiaryWrite')).state,'legacy-disabled');
 await bridge.turn(sessionId,'no-activity','DIARY_WRITE_FIXTURE');assert.equal(compositions(await traces()).length,0);assert.equal((await readdir(join(dir.options.dataDir,'diary'))).length,0);
 await bridge.turn(sessionId,'read-activity','EXPLORE_BILI_FIXTURE');await bridge.turn(sessionId,'compose','DIARY_WRITE_FIXTURE');
 const file=join(dir.options.dataDir,'diary',(await readdir(join(dir.options.dataDir,'diary')))[0]),entry=JSON.parse(await readFile(file));assert.equal(entry.generator,'aurabot-diary-compose');assert.equal(entry.sources.length,1);assert.match(entry.body,/TEST_DIARY_FEELING/);
 let generated=compositions(await traces());assert.equal(generated.length,1);assert.equal((generated[0].tools??[]).length,0);assert.ok(!JSON.stringify(generated[0]).includes('PRIVATE_MEMORY_SOURCE_CANARY'));assert.ok(!JSON.stringify(generated[0]).includes('PRIVATE_CHAT_SOURCE_CANARY'));
 await bridge.turn(sessionId,'duplicate','DIARY_WRITE_FIXTURE');assert.equal(compositions(await traces()).length,1);
 await bridge.close();bridge=await bootBridge(dir);await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});await bridge.turn(sessionId,'recall','DIARY_READ_FIXTURE');assert.equal(compositions(await traces()).length,1);
 assert.equal(JSON.parse(await readFile(file)).revision,1);assert.equal((await bridge.control('companionState')).usage.modelRequests,0);
});
