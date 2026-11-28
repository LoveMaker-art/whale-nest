import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readState,writeState} from '../src/state.mjs';
import {createDiaryPublisher} from '../src/diary-publisher.mjs';
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'whalenest-diary-publisher-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const route={channel:'clawchat',account:'test',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'test',dataDir,owners:[route],activities:{momentPublicationEnabled:false},clawchat:{route,delivery:{connectBin:'/fixture/core',configPath:'/fixture/config'}}};let revision=1,hideFeed=false,writeStatus='succeeded',visibility=['owner'],publish='allow',del='ask',lost=false;const calls=[];
 const diary={read:date=>({ok:true,date:date??'2026-11-14',revision,sources:[{title:'真实公开资料',url:'https://www.bilibili.com/video/BV1xx411c7mD'}],reflection:'TEST_PRIVATE_REFLECTION',message:'TEST_PRIVATE_DIARY'})};let saved,qzone;
 const readStatus=async(name,id)=>{assert.equal(name,'clawchat_create_moment');assert.ok(id.startsWith('whalenest-diary-publish-'));return {status:'succeeded',result:{moment:saved}};};
 const run=async(_bin,args)=>{if(args[0]==='__clawnest-state')return {stdout:JSON.stringify({ownerId:route.sender,conversationId:route.conversation,connected:true,userId:'fixture-agent'})};calls.push(args);assert.equal(args[1],'call');const tool=args[2];
  if(tool==='clawchat_get_permissions')return {stdout:JSON.stringify({status:'succeeded',result:{'moment.visibility':visibility,'moment.publish':publish,'moment.delete':del,permission_windows:{}}})};
  if(tool==='clawchat_create_moment'){const input=JSON.parse(args[args.indexOf('--input-json')+1]);saved={id:123,text:input.text,userId:'fixture-agent'};if(lost)throw Error('reply lost');if(writeStatus!=='succeeded'){saved=null;return {stdout:JSON.stringify({status:writeStatus,error:'definite rejection'})};}return {stdout:JSON.stringify({status:'succeeded',result:{moment:saved}})};}
  if(tool==='clawchat_list_moments')return {stdout:JSON.stringify({status:'succeeded',result:{moments:saved&&!hideFeed?[saved]:[]}})};
  assert.equal(tool,'clawchat_delete_moment');saved=null;return {stdout:JSON.stringify({status:'succeeded',result:{ok:true}})};
 };
 return {options,route,diary,run,calls,setVisibility:v=>{visibility=v;},setPublish:v=>{publish=v;},setDelete:v=>{del=v;},setLost:v=>{lost=v;},setHideFeed:v=>{hideFeed=v;},setWriteStatus:v=>{writeStatus=v;},revise:()=>{revision++;},setQzone:value=>{qzone=value;},create:(extra={})=>createDiaryPublisher(options,route,{diary,run,getQzone:()=>qzone,readStatus,...extra})};
}
test('a new private binding migrates an empty namespace and retains old receipts outside current-account operations',async t=>{
 const f=await fixture(t),path=join(f.options.dataDir,'diary-publications.json');
 f.create();const old=readState(path),original=structuredClone(old);
 const nextRoute={...f.route,conversation:'new-dm'};f.options.clawchat.route=nextRoute;f.options.owners=[nextRoute];
 assert.doesNotThrow(()=>createDiaryPublisher(f.options,nextRoute,{diary:f.diary}));
 assert.notEqual(readState(path).identityScope,old.identityScope);assert.deepEqual(readState(path).records,{});
 const uncertain={id:'original-unknown',date:'2026-11-14',revision:1,text:'old',state:'uncertain'};
 original.records={old:uncertain,qq:{id:'qq-old',platform:'qq',state:'uncertain'}};writeState(path,original);
 const p=createDiaryPublisher(f.options,nextRoute,{diary:f.diary,run:()=>assert.fail('Old account request must not run')});
 assert.equal((await p.check('2026-11-14')).state,'not-published');
 const retained=readState(path);assert.deepEqual(retained.retainedClawChatRecords[old.identityScope].old,uncertain);
 assert.equal(retained.records.qq.id,'qq-old');assert.equal(retained.records.old,undefined);
 const bytes=JSON.stringify(retained);createDiaryPublisher(f.options,nextRoute,{diary:f.diary});assert.equal(JSON.stringify(readState(path)),bytes);
});
test('private archive stays private; public-fact preview excludes private reflection and requires explicit enablement',async t=>{const f=await fixture(t),p=f.create(),draft=p.preview('2026-11-14');assert.ok(draft.text.includes('BV1xx411c7mD'));assert.ok(!JSON.stringify(draft).includes('TEST_PRIVATE'));assert.equal((await p.publish(draft.date,draft.text)).state,'approval-required');assert.equal(f.calls.length,0);
});
test('publication rechecks audience and policy, records receipt and deduplicates over restart; delete ask is respected',async t=>{const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;let p=f.create();const draft=p.preview('2026-11-14');await assert.rejects(p.publish(draft.date,'unapproved'),/完整/);assert.equal((await p.publish(draft.date,draft.text)).momentId,123);assert.equal((await p.publish(draft.date,draft.text)).duplicate,true);assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
 p=f.create();assert.equal((await p.check(draft.date)).readback,'matched');assert.equal((await p.remove(draft.date)).state,'permission-required');assert.equal(f.calls.filter(a=>a[2]==='clawchat_delete_moment').length,0);
 f.setDelete('allow');assert.equal((await p.remove(draft.date)).state,'confirmed');await p.remove(draft.date);assert.equal(f.calls.filter(a=>a[2]==='clawchat_delete_moment').length,1);assert.equal(f.diary.read(draft.date).ok,true);
});
test('audience or permission mismatch blocks writes; an uncertain outcome is checked, never resubmitted',async t=>{const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;const p=f.create(),draft=p.preview('2026-11-14');f.setVisibility(['owner','owner_friends']);assert.equal((await p.publish(draft.date,draft.text)).state,'audience-changed');f.setVisibility(['owner']);f.setPublish('deny');assert.equal((await p.publish(draft.date,draft.text)).state,'permission-required');f.setPublish('allow');f.setLost(true);
 assert.equal((await p.publish(draft.date,draft.text)).state,'uncertain');const restarted=f.create();assert.equal((await restarted.publish(draft.date,draft.text)).state,'uncertain');assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);assert.equal((await restarted.check(draft.date)).state,'confirmed');assert.equal((await restarted.check(draft.date)).readback,'matched');
});
test('failure and denial settle directly, while a later failure settles the same held operation',async t=>{
 for(const outcome of ['failed','denied']){
  const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setWriteStatus(outcome);const p=f.create(),draft=p.preview('2026-11-14');
  assert.equal((await p.publish(draft.date,draft.text)).state,outcome);assert.equal((await p.check(draft.date)).state,outcome);
  const later=await fixture(t);later.options.activities.momentPublicationEnabled=true;later.setLost(true);later.setHideFeed(true);const q=later.create(),d=q.preview('2026-11-14');await q.publish(d.date,d.text);
  assert.equal((await later.create({readStatus:async()=>({status:outcome,error:'definite rejection'})}).check(d.date)).state,outcome);
 }
});
test('restart recovery uses the public moment list and never opens a connector database',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setLost(true);f.setHideFeed(true);
 const p=f.create(),draft=p.preview('2026-11-14');assert.equal((await p.publish(draft.date,draft.text)).state,'uncertain');
 const restarted=f.create({readStatus:undefined});assert.equal((await restarted.check(draft.date)).state,'uncertain');
 f.setHideFeed(false);assert.equal((await restarted.check(draft.date)).state,'confirmed');assert.equal((await restarted.check(draft.date)).readback,'matched');
 assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
});
test('unknown reconciliation has a bounded end and one result notification; it never reposts',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setLost(true);f.setHideFeed(true);let clock=0;const notices=[];
 const p=f.create({readStatus:()=>({status:'indeterminate'}),now:()=>clock,notify:n=>notices.push(n)}),draft=p.preview('2026-11-14');await p.publish(draft.date,draft.text);
 for(let n=0;n<12;n++){clock+=120000;await p.reconcile();}
 assert.equal(notices.length,1);assert.equal((await p.check(draft.date)).state,'uncertain');assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
});
test('only explicit retry after definite failure can create another publication attempt',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setWriteStatus('failed');const p=f.create(),draft=p.preview('2026-11-14');await p.publish(draft.date,draft.text);
 await p.publish(draft.date,draft.text);assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
 f.setWriteStatus('succeeded');assert.equal((await p.publish(draft.date,draft.text,undefined,{retry:true})).state,'confirmed');assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,2);
});
test('QQ space and ClawChat publish separate approved projections with independent receipts and no private body',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;let posts=0,deletes=0;
 f.setQzone({config:()=>({enabled:true,dryRun:false,diary:{visibility:'friends'}}),connected:()=>true,post:async(text,settings)=>{settings.beforeSend();assert.equal(settings.visibility,'self');assert.ok(!text.includes('TEST_PRIVATE'));posts++;return {ok:true,tid:'qzone-tid-'+posts};},remove:async()=>{deletes++;}});
 let p=f.create();const date='2026-11-14',cc=p.preview(date),qq=p.qq.preview(date,'self');assert.notEqual(cc.requestId,qq.requestId);assert.equal(qq.visibility,'self');assert.ok(!qq.text.includes('TEST_PRIVATE'));
 assert.equal((await p.publish(date,cc.text)).momentId,123);assert.equal((await p.qq.publish(date,qq.text,'self')).tid,'qzone-tid-1');assert.equal((await p.qq.publish(date,qq.text,'self')).duplicate,true);assert.equal(posts,1);
 p=f.create();assert.equal((await p.check(date)).momentId,123);assert.equal(p.qq.check(date).tid,'qzone-tid-1');await p.qq.remove(date);await p.qq.remove(date);assert.equal(deletes,1);assert.equal((await p.check(date)).state,'confirmed');assert.equal(f.diary.read(date).reflection,'TEST_PRIVATE_REFLECTION');
});
test('QQ publishing validates the explicit audience, refuses offline sends and holds missing receipts across restart',async t=>{
 const f=await fixture(t);let connected=false,posts=0;f.setQzone({config:()=>({enabled:true,dryRun:false,diary:{visibility:'friends'}}),connected:()=>connected,post:async()=>{posts++;return {ok:false,message:'lost reply'};}});
 const p=f.create(),date='2026-11-14',draft=p.qq.preview(date,'friends');await assert.rejects(p.qq.publish(date,draft.text,'all'),/受众/);
 assert.equal((await p.qq.publish(date,draft.text,'friends')).state,'channel-unavailable');assert.equal(posts,0);connected=true;
 assert.equal((await p.qq.publish(date,draft.text,'friends')).state,'uncertain');assert.equal((await f.create().qq.publish(date,draft.text,'friends')).state,'uncertain');assert.equal(posts,1);assert.equal((await f.create().check(date)).state,'not-published');
});
