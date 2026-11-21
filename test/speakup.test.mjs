import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionPolicy,budgetedStream} from '../src/companion-policy.mjs';
import {resolveDeliveryTarget,hash,routeKey,senderKey,ownerScope} from '../src/routing.mjs';
import {createSpeakUpAdapter} from '../src/speakup-adapter.mjs';

async function fixture(t,limit=5){
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-speakup-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let at=Date.parse('2026-11-16T01:00:00Z'),connected=true;
 const cc={channel:'clawchat',account:'agent',sender:'alice',kind:'private',conversation:'dm'};
 const qq={channel:'qq',account:'20000002',sender:'10000001',kind:'private',conversation:'10000001'};
 const options={instanceId:'test',dataDir,owners:[cc,qq],clawchat:{route:cc},qq:{enabled:true},activities:{automatic:false,maxDailyBackgroundModelCalls:limit}};
 const now=()=>at,available=r=>r.channel!=='qq'||connected;
 const policy=createCompanionPolicy(options,cc,{now,available});
 return {options,cc,qq,now,policy,available,setTime:v=>at=Date.parse(v),disconnect:()=>connected=false,reconnect:()=>connected=true};
}
test('one target selector keeps manual origin and explicit tasks, verifies identity and never falls back',async t=>{
 const f=await fixture(t);
 assert.equal(resolveDeliveryTarget(f.options,{origin:f.cc,preferred:'qq'}).route.channel,'clawchat');
 assert.equal(resolveDeliveryTarget(f.options,{automatic:true,preferred:'qq'}).route.channel,'qq');
 assert.equal(resolveDeliveryTarget(f.options,{automatic:true,preferred:'qq',explicit:f.cc}).basis,'explicit');
 assert.equal(resolveDeliveryTarget(f.options,{origin:{...f.qq,conversation:'another'}}).reason,'unverified-owner-route');
 f.policy.configure({proactivePlatform:'qq'});assert.equal(f.policy.status().settings.contactEnabled,false);
 f.disconnect();assert.equal(f.policy.target().reason,'channel-unavailable');assert.equal(f.policy.status().settings.proactivePlatform,'qq');
 assert.equal(resolveDeliveryTarget(f.options,{automatic:true,preferred:'qq',available:f.available}).route.channel,'qq');
 assert.ok(f.policy.qqOnboarding());assert.equal(f.policy.qqOnboarding(),null);
 const restored=createCompanionPolicy(f.options,f.cc,{now:f.now,available:f.available});assert.equal(restored.qqOnboarding(),null);
});
test('the original module registers one tick and fires its original greeting without activity material',async t=>{
 const f=await fixture(t);let every=0,dispatches=0,speakup;
 const adapter=createSpeakUpAdapter({},f.options,{policy:f.policy,now:f.now,random:()=>0,
  getConfig:()=>({enabled:false,ownerQQ:'10000001',ownerName:'主人',speakUp:{minIntervalMinutes:1,maxIntervalMinutes:2}}),
  getNative:()=>({}),dispatch:job=>{dispatches++;assert.match(job.prompt,/这次的由头可以是/);assert.ok(!job.prompt.includes('companion_experiences'));f.policy.accept(job.id,'cc','input');return true;}});
 t.after(()=>adapter.dispose());
 const definition=adapter.wrapModule();speakup=definition.setup({config:()=>({}),core:{mutes:{muted:()=>false}},log:{info(){}},use:()=>null,every:()=>every++,route(){}});
 assert.equal(every,1);await speakup.tick();assert.equal(dispatches,0);
 f.policy.configure({contactEnabled:true});f.setTime('2026-11-16T03:01:00Z');f.policy.saveContact({nextAt:f.now()-1});
 await speakup.tick();assert.equal(dispatches,1);assert.equal(f.policy.status().settings.automatic,false);
 assert.equal(f.policy.status().usage.automaticMessages,0,'Original tick does not increment a second counter');
 await speakup.tick();assert.equal(dispatches,1,'An admitted task prevents duplicate candidates');
 f.policy.finish(['input'],{text:'[沉默]',completed:true});assert.equal(f.policy.pendingContacts().length,0);assert.equal(f.policy.status().usage.automaticMessages,0);
});
test('both owner routes refresh one timer; replay, self tests and scheduled input do not',async t=>{
 const f=await fixture(t);f.policy.configure({contactEnabled:true});f.setTime('2026-11-16T03:01:00Z');assert.equal(f.policy.contactReason(),null);
 f.policy.input('真实QQ消息',{id:'q1',route:f.qq});assert.equal(f.policy.contactReason(),'owner-recently-active');
 const at=f.policy.status().lastOwnerAt;f.setTime('2026-11-16T04:00:00Z');
 f.policy.input('真实QQ消息',{id:'q1',route:f.qq});f.policy.input('运维自测',{id:'q2',route:f.qq});f.policy.input('任务',{source:'schedule'});
 assert.equal(f.policy.status().lastOwnerAt,at);f.policy.input('真实ClawChat消息',{id:'c1',route:f.cc});assert.equal(f.policy.status().lastOwnerAt,f.now());
 assert.throws(()=>f.policy.input('群聊',{id:'g1',route:{...f.qq,kind:'group'}}),/Verified/);
});
test('native QQ task identity shares the model budget with maintenance and is not inherited by later foreground input',async t=>{
 const f=await fixture(t,2);f.policy.configure({contactEnabled:true,idleMinutes:0});const job=f.policy.queueContact('问候');f.policy.accept(job.id,'qq-session','input');
 let calls=0;const stream=async function*(){calls++;yield {type:'finish'};};
 const request={sessionId:'qq-session',messages:[{role:'user',source:{kind:'aurabot',taskId:job.id}}]};
 await Array.fromAsync(budgetedStream(f.policy,request,stream));
 await Array.fromAsync(budgetedStream(f.policy,{},stream,{kind:'memory',runId:'m1',allowed:()=>true}));
 await assert.rejects(Array.fromAsync(budgetedStream(f.policy,request,stream)),/blocked/);assert.equal(calls,2);
 await Array.fromAsync(budgetedStream(f.policy,{...request,messages:[...request.messages,{role:'user',source:{kind:'aurabot'}}]},stream));assert.equal(calls,3);
 assert.throws(()=>f.policy.requestJob({...request,sessionId:'wrong'}),/identity/);
});
test('preference changes cancel only unstarted automatic delivery; partial QQ receipts stay frozen',async t=>{
 const f=await fixture(t);f.policy.configure({contactEnabled:true,idleMinutes:0,cooldownMinutes:0});
 const first=f.policy.queueContact('第一条');f.policy.accept(first.id,'s','i');f.policy.finish(['i'],{text:'问候',completed:true});
 f.policy.configure({proactivePlatform:'qq'});assert.equal(f.policy.getJob(first.id).state,'cancelled');assert.equal(f.policy.getJob(first.id).reply,'问候');
 const second=f.policy.queueContact('第二条');f.policy.accept(second.id,'q','qi');f.policy.finish(['qi'],{text:'问候',completed:true});
 assert.equal(f.policy.delivery(second.id,{begin:true}),null);f.policy.nativeReceipt(second.id,{attempt:true});f.policy.nativeReceipt(second.id,{messageId:'ack-1'});
 f.policy.configure({proactivePlatform:'clawchat'});assert.equal(f.policy.getJob(second.id).route.channel,'qq');
 assert.equal(f.policy.delivery(second.id,{continuing:true}),null);f.policy.nativeReceipt(second.id,{attempt:true});f.policy.nativeReceipt(second.id,{error:true});f.policy.nativeReceipt(second.id,{done:true});
 assert.equal(f.policy.getJob(second.id).state,'uncertain');assert.equal(f.policy.status().usage.automaticMessages,1);
 const restarted=createCompanionPolicy(f.options,f.cc,{now:f.now,available:f.available});assert.equal(restarted.delivery(second.id),'held');assert.equal(restarted.status().usage.automaticMessages,1);
 assert.throws(()=>restarted.reserve(second.id),/not active/,'A restored uncertain request cannot start another model stream');
});

test('contact clock obeys Beijing hours, and stopping contact does not stop the shared memory allowance',async t=>{
 const f=await fixture(t);f.policy.configure({contactEnabled:true,idleMinutes:0});
 f.setTime('2026-11-16T00:59:00Z');assert.equal(f.policy.contactReason(),'quiet-hours');
 f.setTime('2026-11-16T01:00:00Z');assert.equal(f.policy.contactReason(),null);
 f.setTime('2026-11-16T14:00:00Z');assert.equal(f.policy.contactReason(),'quiet-hours');
 f.setTime('2026-11-16T13:00:00Z');f.policy.configure({contactEnabled:false});
 assert.equal(f.policy.contactReason(),'contact-disabled');assert.equal(f.policy.maintenanceReason(),null);
});

test('a new owner message between QQ segments stops the remaining segment and records a partial delivery',async t=>{
 const f=await fixture(t);f.policy.configure({contactEnabled:true,proactivePlatform:'qq'});f.setTime('2026-11-16T03:01:00Z');
 const job=f.policy.queueContact('问候');f.policy.accept(job.id,'native','input');
 const adapter=createSpeakUpAdapter({sessions:{flush:async()=>true}},f.options,{policy:f.policy,now:f.now,getConfig:()=>({ownerQQ:'10000001'}),getNative:()=>({})});
 t.after(()=>adapter.dispose());
 await adapter.background.completeTurn({jobId:job.id,session:{id:'native'},text:'第一段|||第二段',completed:true,send:async()=>{
  assert.equal(adapter.background.beforeSend(job.id,{chatId:'private:10000001'}),null);adapter.background.sent(job.id,{message_id:'first'});
  f.policy.input('我回来了',{id:'new',route:f.cc});
  assert.equal(adapter.background.beforeSend(job.id,{chatId:'private:10000001'}),'owner-recently-active');
 }});
 const result=f.policy.getJob(job.id);assert.equal(result.state,'suppressed');assert.equal(result.deliveryOutcome,'partial');assert.deepEqual(result.nativeReceipts,['first']);
 assert.equal(f.policy.status().usage.automaticMessages,1);
});
test('legacy policy scope migrates once, preserving budgets, old jobs and retirement of the share writer',async t=>{
 const f=await fixture(t);const file=join(f.options.dataDir,'companion-policy.json');
 const old=JSON.parse(await readFile(file,'utf8'));old.schema=1;old.scope=hash([f.options.instanceId,routeKey(f.cc),senderKey(f.cc)]);
 old.days['2026-11-16']={modelRequests:2,automaticMessages:1,inputTokens:30,outputTokens:4};
 old.jobs.old={id:'old',kind:'share',state:'awaiting-delivery',reply:'旧结果'};
 old.jobs.unknown={id:'unknown',kind:'share',state:'uncertain',deliveryHeld:true};await writeFile(file,JSON.stringify(old));
 const migrated=createCompanionPolicy(f.options,f.cc,{now:f.now});assert.equal(migrated.status().usage.modelRequests,2);assert.equal(migrated.getJob('old').state,'cancelled');assert.equal(migrated.getJob('unknown').state,'uncertain');
 const again=createCompanionPolicy(f.options,f.qq,{now:f.now});assert.equal(again.status().usage.automaticMessages,1);assert.equal(JSON.parse(await readFile(file,'utf8')).scope,ownerScope(f.options));
});

test('native adapter flushes before sending, holds unknown acknowledgements and never retries after restart',async t=>{
 const f=await fixture(t);f.policy.configure({contactEnabled:true,proactivePlatform:'qq',idleMinutes:0});
 const job=f.policy.queueContact('问候');f.policy.accept(job.id,'native','input');let flushed=false,attempts=0;
 const adapter=createSpeakUpAdapter({sessions:{flush:async()=>{flushed=true;return true;}}},f.options,{policy:f.policy,now:f.now,
  getConfig:()=>({ownerQQ:'10000001'}),getNative:()=>({hub:{deliver(){throw Error('Unknown outcome must not resume');}}})});
 t.after(()=>adapter.dispose());
 await adapter.background.completeTurn({jobId:job.id,session:{id:'native'},text:'你好',completed:true,send:async()=>{
  assert.ok(flushed);assert.equal(adapter.background.beforeSend(job.id,{chatId:'private:10000001'}),null);attempts++;
  adapter.background.sent(job.id,{});
 }});
 assert.equal(f.policy.getJob(job.id).state,'uncertain');assert.equal(f.policy.status().usage.automaticMessages,1);
 await adapter.resume();assert.equal(attempts,1);
 const restored=createCompanionPolicy(f.options,f.cc,{now:f.now});assert.equal(restored.delivery(job.id),'held');
});
