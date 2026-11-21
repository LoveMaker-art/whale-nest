import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {verifyLiveTools} from '../scripts/lib/live-tools.mjs';
test('original Bili tool names mount on verified owner chat; real DSH exercises independent reads and manual scan',{timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.biliFixture=true;dir.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:0};await writeFile(dir.configPath,JSON.stringify(dir.options));let bridge=await bootBridge(dir);t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});const sessionId='bili-tools-native';await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 for(const [n,item] of [{name:'bili_whoami'},{name:'bili_comments',args:{bvid:'BV1xx411c7mD'}},{name:'bili_subtitle',args:{bvid:'BV1xx411c7mD'}},{name:'bili_scan',args:{query:'鲸鱼'}}].entries())await bridge.turn(sessionId,'read-'+n,'BILI_TOOL_FIXTURE '+JSON.stringify(item));
 const trace=(await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),names=new Set(trace.at(-1).tools.map(t=>t.name));
 for(const name of ['scan','whoami','search','subtitle','comments','reply','triple','send_message','send_dynamic','status','login_start','login_poll','setup','config'])assert.ok(names.has('bili_'+name),name);
 const status=await bridge.request('companionStatus',{sessionId}),profile=JSON.parse(await readFile(join(dir.options.home,'profiles/whalenest/package.json')));assert.equal(verifyLiveTools(status,profile,{activitiesEnabled:true}).oldPluginPackagesAbsent,true);
 const messages=JSON.stringify(trace.at(-1).messages);assert.match(messages,/TEST_OCEAN/);assert.equal((await readdir(join(dir.options.dataDir,'activities'))).filter(f=>f.startsWith('whalenest-activity-')).length,1);const history=await bridge.request('history',{sessionId});assert.match(JSON.stringify(history),/公开热评/);assert.match(JSON.stringify(history),/鲸鱼生活在海洋/);assert.match(JSON.stringify(history),/logged-out/);
 await bridge.close();bridge=await bootBridge(dir);await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});await bridge.turn(sessionId,'state-after-restart','BILI_TOOL_FIXTURE '+JSON.stringify({name:'bili_status'}));const state=await bridge.control('companionState');assert.equal(state.usage.modelRequests,0);
});
