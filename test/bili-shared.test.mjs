import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hash,ownerScope,routeKey,senderKey} from '../src/routing.mjs';
import {readState,writeState} from '../src/state.mjs';
import {createBiliAccount} from '../src/bili-account.mjs';
import {createBiliRules} from '../src/bili-rules.mjs';
import {createActivities} from '../src/activities.mjs';
import {protectBiliOwnerRollback} from '../src/runtime-upgrade.mjs';
import {readBiliReferenceImage} from '../src/bili-media.mjs';
import {createBiliApi} from '../src/aurabot-bili-api.generated.mjs';

function fixture(t){
 const dataDir=mkdtempSync(join(tmpdir(),'whalenest-bili-shared-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const cc={channel:'clawchat',account:'dsh',sender:'owner',conversation:'dm',kind:'private'},qq={channel:'qq',account:'20000002',sender:'10000001',conversation:'10000001',kind:'private'};
 const options={instanceId:'shared-fixture',dataDir,owners:[cc,qq],clawchat:{route:cc},activities:{enabled:true}};
 return {options,cc,qq,legacy:hash([options.instanceId,routeKey(cc),senderKey(cc)])};
}
test('legacy credentials and operation identities survive owner migration, QQ replay, unknown results and compatible rollback',async t=>{
 const f=fixture(t),file=join(f.options.dataDir,'bili/account.json');let calls=0;
 let account=createBiliAccount(f.options,f.cc);account.adoptCookie('SESSDATA=fixture;bili_jct=fixture');await account.whoami({nav:async()=>({isLogin:true,mid:'123',name:'fixture'})});
 const input={requestId:'native-session:persisted-call',kind:'message',input:{receiver:'789',text:'same'}};
 const sent=await account.mutate(input,async()=>{calls++;return {msg_key:'18446744073709551001'};});
 const old=readState(file);old.schema=1;old.scope=f.legacy;delete old.identityScope;delete old.legacyScopes;writeState(file,old);
 account=createBiliAccount(f.options,f.qq);assert.equal(account.status().uid,'123');assert.equal((await account.mutate(input,async()=>{calls++;return {msg_key:'WRONG'};})).operationId,sent.operationId);assert.equal(calls,1);
 const unknown={...input,requestId:'timeout',input:{receiver:'789',text:'uncertain'}};
 assert.equal((await account.mutate(unknown,async()=>{calls++;throw Error('lost ack');})).state,'uncertain');
 account=createBiliAccount(f.options,f.cc);assert.equal((await account.mutate({...unknown,requestId:'new-IM-call'},async()=>{calls++;return {msg_key:'WRONG'};})).state,'uncertain');assert.equal(calls,2);
 const data={account:readState(file),runtime:{outbox:{}},policy:{settings:{automatic:true},jobs:{}}};
 assert.equal(protectBiliOwnerRollback(data,f.options,'0.3.0-whalenest.m3.13').disableBrowse,true);writeState(file,data.account);
 account=createBiliAccount(f.options,f.qq);assert.equal((await account.mutate(input,()=>{throw Error('must not replay');})).receipt.msg_key,'18446744073709551001');assert.equal(readState(file).scope,ownerScope(f.options));
 assert.throws(()=>account.adoptCookie('DIFFERENT_CREDENTIAL'),/凭据不同/);
 assert.throws(()=>createBiliAccount({...f.options,instanceId:'other'},f.qq),/不属于/);
});
test('experiences retain old IDs and separate repeated real reads; original history becomes a read-only projection',async t=>{
 const f=fixture(t);let reads=0;const reader=async()=>{reads++;return {ok:true,read:{info:{bvid:'BV1xx411c7mD',title:'原资料'},digest:'原摘要',subtitle:'字幕',comments:[],coverage:{comments:true,vision:false}}};};
 let store=createActivities(f.options,f.cc,{reader});const request={link:'BV1xx411c7mD',sessionId:'session-cc',requestId:'stable'};
 const first=await store.run(request),file=join(f.options.dataDir,'activities',first.activityId+'.json'),old=readState(file);old.schema=1;old.scope=f.legacy;writeState(file,old);
 store=createActivities(f.options,f.qq,{reader});assert.equal((await store.run(request)).activityId,first.activityId);assert.equal(reads,1);assert.equal(readState(file).scope,ownerScope(f.options));
 const second=await store.run({...request,sessionId:'session-qq',requestId:'different-actual-read'});assert.notEqual(second.activityId,first.activityId);assert.equal(reads,2);
 const history=[{at:1000,kind:'watch',bvid:'BV1xx411c7mD',title:'旧经历',text:'旧感想'}];store.importOriginalHistory(history);store.importOriginalHistory(history);assert.equal(store.list().length,3);assert.equal(store.originalHistory().length,3);assert.equal(reads,2);
 const rules=createBiliRules(f.options,f.qq);rules.configure({minViews:123,replyPerDay:1});assert.equal(createBiliRules(f.options,f.cc).settings().minViews,123);
});
test('rollback preserves new Bili inbox cursors and receipts, holds unsent output and leaves original contact intact',t=>{
 const f=fixture(t),scope=ownerScope(f.options),row={schema:2,scope};
 const data={account:{...row,generation:7,mutations:{unknown:{state:'uncertain'}}},rules:{...row},index:{...row},activities:[{...row,id:'unchanged'}],
  inbox:{...row,accounts:{'123':{streams:{dm:{cursor:'exact'}}}},notices:{n:{state:'queued'},done:{state:'confirmed'}}},
  runtime:{outbox:{n:{state:'pending',biliNoticeId:'n'},b:{state:'pending',source:'bili-browse',companionJobId:'b'},c:{state:'confirmed',messageId:'keep'}}},
  policy:{settings:{automatic:true,contactEnabled:true},jobs:{b:{kind:'browse',engine:'aurabot-bili',state:'awaiting-delivery',inputId:'i'},c:{kind:'contact',state:'confirmed'}}}};
 assert.deepEqual(protectBiliOwnerRollback(data,f.options,'0.3.0-whalenest.m3.13'),{disableBrowse:true,held:2});
 assert.equal(data.account.scope,f.legacy);assert.equal(data.account.generation,7);assert.equal(data.account.mutations.unknown.state,'uncertain');assert.equal(data.inbox.accounts['123'].streams.dm.cursor,'exact');assert.equal(data.inbox.notices.n.state,'held');assert.equal(data.activities[0].id,'unchanged');assert.equal(data.runtime.outbox.c.messageId,'keep');assert.equal(data.policy.settings.contactEnabled,true);assert.equal(data.policy.jobs.c.state,'confirmed');
 assert.equal(protectBiliOwnerRollback(data,f.options,'0.3.0-whalenest.m3.13').disableBrowse,false);
});
test('last avatar image resolves only the current native Session journal and rejects changed bytes',t=>{
 const f=fixture(t),sessionId='native-cc',turnId='image-turn',bytes=Buffer.from([137,80,78,71,13,10,26,10,1]);
 const root=join(f.options.dataDir,'media/incoming',hash([f.cc.account,f.cc.conversation,sessionId,turnId]));mkdirSync(root,{recursive:true});
 const file=join(root,'last.png');
 // Binary fixture uses the same trusted journal format as prepareRuntimeInput.
 writeFileSync(file,bytes);writeState(join(root,'input.json'),{state:'completed',files:[{kind:'image',path:file,sha256:createHash('sha256').update(bytes).digest('hex')}]});
 const actor={agent:{id:sessionId,session:{seq:0,eventAt:()=>({type:'user/message',data:{source:{kind:'user',connectInputId:turnId}}})}}};
 assert.deepEqual(readBiliReferenceImage(f.options,sessionId,actor),bytes);
 const other={agent:{...actor.agent,id:'other-session'}};assert.equal(readBiliReferenceImage(f.options,'other-session',other),null);
 writeFileSync(file,Buffer.from('changed'));assert.throws(()=>readBiliReferenceImage(f.options,sessionId,actor),/changed/);
});
test('generated original API keeps long platform IDs and accepts a received avatar without a second download',async()=>{
 const calls=[],api=createBiliApi({getCookie:()=> 'bili_jct=fixture',log:{debug(){}},fetchImpl:async(url,init)=>{calls.push({url:String(url),method:init?.method});
  if(String(url).includes('/reply/add'))return new Response('{"code":0,"data":{"rpid":18446744073709551001}}');
  return Response.json({code:0,data:{}});
 }});
 assert.equal((await api.postComment('123','评论')).rpid,'18446744073709551001');
 await api.setFace(Buffer.from([137,80,78,71,13,10,26,10,1]));assert.equal(calls.filter(c=>c.url.includes('/face/update')).length,1);assert.ok(calls.every(c=>c.url.startsWith('https://api.bilibili.com/')));
});
