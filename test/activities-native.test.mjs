import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';

test('native DSH searches and reads Bili through real tools, persists evidence and recalls after restart',{timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.biliFixture=true;dir.options.activities={enabled:true,automatic:false};await writeFile(dir.configPath,JSON.stringify(dir.options));
 let bridge=await bootBridge(dir);t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});
 const sessionId='activities-native';await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 await bridge.turn(sessionId,'explore-one','EXPLORE_BILI_FIXTURE');
 const folder=join(dir.options.dataDir,'activities'),files=(await readdir(folder)).filter(f=>f.startsWith('whalenest-activity-'));assert.equal(files.length,1);
 const record=JSON.parse(await readFile(join(folder,files[0])));assert.equal(record.state,'completed');assert.equal(record.trigger,'manual');assert.equal(record.video.title,'TEST_OCEAN 海洋科普');assert.equal(record.coverage.vision,false);
 await bridge.request('prompt',{sessionId,inputId:'explore-one',text:'EXPLORE_BILI_FIXTURE'});assert.equal((await readdir(folder)).filter(f=>f.startsWith('whalenest-activity-')).length,1);
 await bridge.close();bridge=await bootBridge(dir);await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});
 await bridge.turn(sessionId,'recall-after-restart','EXPERIENCES_FIXTURE');
 const history=await bridge.request('history',{sessionId});
 const replies=history.events.filter(e=>e.type==='assistant/message').map(e=>JSON.stringify(e.data.message?.content??e.data.content));
 assert.ok(replies.some(text=>text.includes('EXPERIENCE_FOUND_TEST_OCEAN')));
 const trace=(await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(trace.some(t=>JSON.stringify(t.messages).includes('TEST_OCEAN')));
 assert.ok(trace.at(-1).tools.some(tool=>tool.name==='bili_search'));assert.equal(trace.at(-1).tools.filter(tool=>tool.name==='bili_watch').length,1);
 assert.equal((await readdir(folder)).filter(f=>f.startsWith('whalenest-activity-')).length,1);
});
