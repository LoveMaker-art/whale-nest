import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {seedBiliAccount} from './bili-test-helper.mjs';
for (const limit of [0,1]) test('native Bili inbox delivers a single ClawChat notice with background budget '+limit,{timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.biliFixture=true;dir.biliInboxFixture=join(dir.root,'inbox-fixture.json');dir.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:limit};await writeFile(dir.configPath,JSON.stringify(dir.options));seedBiliAccount(dir.options,dir.options.clawchat.route);
 const fixture={sessions:{session_list:[],has_more:0},messages:{messages:[],has_more:0,max_seqno:'0',min_seqno:'0'},at:{items:[],cursor:{is_end:true}},reply:{items:[],cursor:{is_end:true}}};await writeFile(dir.biliInboxFixture,JSON.stringify(fixture));let bridge=await bootBridge(dir);t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});
 await bridge.request('create',{sessionId:'inbox-native',cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});await bridge.control('companionConfigure',{awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,maxProactivePerDay:2});await bridge.control('biliConfigure',{watchOn:true,watchInterval:60});await bridge.control('biliTick');await assert.rejects(access(join(dir.root,'delivered.jsonl')),{code:'ENOENT'});
 fixture.sessions.session_list=[{session_type:1,system_msg_type:0,talker_id:'456',max_seqno:'1',session_ts:'9223372036854775807',unread_count:1,account_info:{name:'合成来信人'}}];fixture.messages={messages:[{msg_key:'9223372036854775807',msg_seqno:'1',sender_uid:'456',receiver_id:'123',receiver_type:1,msg_type:1,msg_status:0,timestamp:Math.floor(Date.now()/1000)+1,content:JSON.stringify({content:'NATIVE_TEST_INCOMING'})}],has_more:0,max_seqno:'1',min_seqno:'1'};await writeFile(dir.biliInboxFixture,JSON.stringify(fixture));
 await bridge.control('biliTick');const readSends=async()=>(await readFile(join(dir.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal((await readSends()).length,1);assert.match((await readSends())[0].input.text,limit?/^有封B站来信，留给你看看。/:/^B站有一条私信消息。/);
 assert.match((await readSends())[0].input.text,/合成来信人：NATIVE_TEST_INCOMING/);assert.equal((await readSends())[0].input.chatId,'dm-alice');const before=await bridge.control('companionState');assert.equal(before.usage.modelRequests,limit);assert.equal(before.usage.automaticMessages,1);assert.equal((await bridge.control('biliState')).held,0);
 await bridge.close();bridge=await bootBridge(dir);await bridge.request('resume',{sessionId:'inbox-native',whalenestChatId:'dm-alice'});await bridge.control('biliTick');assert.equal((await readSends()).length,1);assert.equal((await bridge.control('companionState')).usage.automaticMessages,1);if(limit) {
  const requests=(await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length,1,'A delivered notice does not call the model again on restart');
  assert.match(requests[0].system,/大肥鱼/);
  assert.doesNotMatch(JSON.stringify(requests[0]),/NATIVE_TEST_INCOMING|合成来信人/);
 } else await assert.rejects(access(join(dir.root,'trace.jsonl')),{code:'ENOENT'});
 const calls=(await readFile(dir.biliInboxFixture+'.calls','utf8')).trim().split('\n').map(JSON.parse);assert.ok(calls.every(c=>c.method==='GET'));assert.ok(calls.some(c=>c.path.endsWith('/fetch_session_msgs')));
});
