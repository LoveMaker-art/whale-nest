import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDiaryPublisher} from '../src/diary-publisher.mjs';
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'whalenest-diary-publisher-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const route={channel:'clawchat',account:'test',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'test',dataDir,owners:[route],activities:{momentPublicationEnabled:false},clawchat:{route,delivery:{connectBin:'/fixture/core',configPath:'/fixture/config'}}};let revision=1,visibility=['owner'],publish='allow',del='ask',lost=false;const calls=[];
 const diary={read:date=>({ok:true,date:date??'2026-11-14',revision,sources:[{title:'真实公开资料',url:'https://www.bilibili.com/video/BV1xx411c7mD'}],reflection:'TEST_PRIVATE_REFLECTION',message:'TEST_PRIVATE_DIARY'})};let saved,qzone;
 const readStatus=async(name,id)=>{assert.equal(name,'clawchat_create_moment');assert.ok(id.startsWith('whalenest-diary-publish-'));return {status:'succeeded',result:{moment:saved}};};
 const run=async(_bin,args)=>{calls.push(args);assert.equal(args[1],'call');const tool=args[2];
  if(tool==='clawchat_get_agent_permissions')return {stdout:JSON.stringify({status:'succeeded',result:{'moment.visibility':visibility,'moment.publish':publish,'moment.delete':del,permission_windows:{}}})};
  if(tool==='clawchat_create_moment'){const input=JSON.parse(args[args.indexOf('--input-json')+1]);saved={id:123,text:input.text};if(lost)throw Error('reply lost');return {stdout:JSON.stringify({status:'succeeded',result:{moment:saved}})};}
  if(tool==='clawchat_list_moments')return {stdout:JSON.stringify({status:'succeeded',result:{moments:saved?[saved]:[]}})};
  assert.equal(tool,'clawchat_delete_moment');saved=null;return {stdout:JSON.stringify({status:'succeeded',result:{ok:true}})};
 };
 return {options,route,diary,run,calls,setVisibility:v=>{visibility=v;},setPublish:v=>{publish=v;},setDelete:v=>{del=v;},setLost:v=>{lost=v;},revise:()=>{revision++;},setQzone:value=>{qzone=value;},create:(extra={})=>createDiaryPublisher(options,route,{diary,run,getQzone:()=>qzone,readStatus,...extra})};
}
test('private archive stays private; public-fact preview excludes private reflection and requires explicit enablement',async t=>{const f=await fixture(t),p=f.create(),draft=p.preview('2026-11-14');assert.ok(draft.text.includes('BV1xx411c7mD'));assert.ok(!JSON.stringify(draft).includes('TEST_PRIVATE'));assert.equal((await p.publish(draft.date,draft.text)).state,'approval-required');assert.equal(f.calls.length,0);
});
test('publication rechecks audience and policy, records receipt and deduplicates over restart; delete ask is respected',async t=>{const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;let p=f.create();const draft=p.preview('2026-11-14');await assert.rejects(p.publish(draft.date,'unapproved'),/完整/);assert.equal((await p.publish(draft.date,draft.text)).momentId,123);assert.equal((await p.publish(draft.date,draft.text)).duplicate,true);assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
 p=f.create();assert.equal((await p.check(draft.date)).readback,'matched');assert.equal((await p.remove(draft.date)).state,'permission-required');assert.equal(f.calls.filter(a=>a[2]==='clawchat_delete_moment').length,0);
 f.setDelete('allow');assert.equal((await p.remove(draft.date)).state,'confirmed');await p.remove(draft.date);assert.equal(f.calls.filter(a=>a[2]==='clawchat_delete_moment').length,1);assert.equal(f.diary.read(draft.date).ok,true);
});
test('audience or permission mismatch blocks writes; an uncertain outcome is checked, never resubmitted',async t=>{const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;const p=f.create(),draft=p.preview('2026-11-14');f.setVisibility(['owner','owner_friends']);assert.equal((await p.publish(draft.date,draft.text)).state,'audience-changed');f.setVisibility(['owner']);f.setPublish('deny');assert.equal((await p.publish(draft.date,draft.text)).state,'permission-required');f.setPublish('allow');f.setLost(true);
 assert.equal((await p.publish(draft.date,draft.text)).state,'uncertain');const restarted=f.create();assert.equal((await restarted.publish(draft.date,draft.text)).state,'uncertain');assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);assert.equal((await restarted.check(draft.date)).state,'confirmed');assert.equal((await restarted.check(draft.date)).readback,'matched');
});
test('publication recovery holds unknown or mismatched receipts and reader failures without publishing again',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setLost(true);
 const p=f.create(),draft=p.preview('2026-11-14');
 assert.equal((await p.publish(draft.date,draft.text)).state,'uncertain');
 for(const status of ['not_found','pending','running','failed','expired','indeterminate']) {
  const restarted=f.create({readStatus:async()=>({status,error:'unconfirmed'})});
  assert.equal((await restarted.check(draft.date)).state,'uncertain');
 }
 const mismatch=f.create({readStatus:async()=>({status:'succeeded',result:{moment:{id:123,text:'another publication'}}})});
 assert.equal((await mismatch.check(draft.date)).state,'uncertain');
 const unavailable=f.create({readStatus:async()=>{throw Error('database unavailable');}});
 assert.equal((await unavailable.check(draft.date)).state,'uncertain');
 assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
 assert.equal((await f.create().check(draft.date)).state,'confirmed');
});
test('publication restart recovery reads its exact Core receipt without submitting the publication again',async t=>{
 const f=await fixture(t);f.options.activities.momentPublicationEnabled=true;f.setLost(true);
 const configPath=join(f.options.dataDir,'connect.json'),dbPath=join(f.options.dataDir,'connect.sqlite'),db=new DatabaseSync(dbPath);
 t.after(()=>db.close());
 db.exec('CREATE TABLE tool_requests(binding_id TEXT,tool_name TEXT,request_id TEXT PRIMARY KEY,state TEXT,result_json TEXT,error TEXT)');
 await writeFile(configPath,JSON.stringify({agents:{test:{}},stateDbPath:dbPath}));
 f.options.clawchat.delivery.configPath=configPath;
 const p=f.create(),draft=p.preview('2026-11-14');
 assert.equal((await p.publish(draft.date,draft.text)).state,'uncertain');
 const restarted=f.create({readStatus:undefined});
 assert.equal((await restarted.check(draft.date)).state,'uncertain');
 assert.equal(db.prepare('SELECT count(*) AS n FROM tool_requests').get().n,0);
 db.prepare('INSERT INTO tool_requests VALUES(?,?,?,?,?,NULL)').run('test','clawchat_create_moment',draft.requestId,'succeeded',JSON.stringify({moment:{id:123,text:draft.text}}));
 assert.equal((await restarted.check(draft.date)).state,'confirmed');
 assert.equal((await restarted.check(draft.date)).readback,'matched');
 assert.equal(f.calls.filter(a=>a[2]==='clawchat_create_moment').length,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM tool_requests').get().n,1);
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
