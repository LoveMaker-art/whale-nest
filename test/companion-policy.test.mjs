import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionPolicy,budgetedStream,localClock} from '../src/companion-policy.mjs';

async function fixture(t,limit=2){const dataDir=await mkdtemp(join(tmpdir(),'whalenest-policy-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let at=Date.parse('2026-11-14T01:00:00Z');
 const route={channel:'clawchat',account:'agent',sender:'alice',conversation:'dm',kind:'private'},options={instanceId:'test',dataDir,owners:[route],clawchat:{route},activities:{automatic:true,maxDailyBackgroundModelCalls:limit}};
 const now=()=>at,policy=createCompanionPolicy(options,route,{now});return {options,route,now,policy,setTime:v=>{at=Date.parse(v);}};}
test('zero background limit stops dispatch while normal foreground streaming remains available',async t=>{
 const f=await fixture(t,0);f.policy.configure({idleMinutes:0,interests:['鲸鱼']});let calls=0;
 assert.equal((await f.policy.tick({dispatch:()=>{calls++;}})).reason,'background-model-disabled');assert.equal(calls,0);
 await Array.fromAsync(budgetedStream(f.policy,{messages:[{role:'user',source:{kind:'user'}}]},async function*(){calls++;yield {type:'finish'};}));
 assert.equal(calls,1);assert.equal(f.policy.status().usage.modelRequests,0);
 assert.throws(()=>f.policy.configure({dailyModelRequestLimit:50}),/Unsupported/);
});
test('each model stream reserves budget before dispatch and uncertain requests remain charged after restart',async t=>{
 const f=await fixture(t);f.policy.configure({idleMinutes:0,interests:['鲸鱼']});
 const first=await f.policy.tick({dispatch:job=>{f.policy.accept(job.id,'native','input');return true;}});
 const request={sessionId:'native',messages:[{role:'user',source:{kind:'schedule',taskId:first.jobId}}]};let calls=0;
 await Array.fromAsync(budgetedStream(f.policy,request,async function*(){calls++;yield {type:'usage',usage:{inputTokens:10,outputTokens:2}};yield {type:'finish'};}));
 await assert.rejects(Array.fromAsync(budgetedStream(f.policy,request,async function*(){calls++;throw Error('lost response');})),/lost response/);
 await assert.rejects(Array.fromAsync(budgetedStream(f.policy,request,async function*(){calls++;yield {type:'finish'};})),/blocked/);assert.equal(calls,2);
 const recovered=createCompanionPolicy(f.options,f.route,{now:f.now});assert.equal(recovered.status().usage.modelRequests,2);assert.equal(recovered.status().usage.inputTokens,10);
 assert.equal(recovered.getJob(first.jobId).state,'uncertain');assert.equal((await recovered.tick({dispatch:()=>{calls++;}})).reason,'daily-model-limit');assert.equal(calls,2);
});
test('original contact, browsing and diary share quiet hours, idle, cooldown and the same daily message limit',async t=>{
 const f=await fixture(t,10);f.policy.configure({contactEnabled:true,interests:['鲸鱼']});const dispatch=job=>{f.policy.accept(job.id,'native',job.id+'-input');return true;};
 assert.equal((await f.policy.tick({dispatch})).state,'idle');
 f.setTime('2026-11-14T03:00:00Z');const one=await f.policy.tick({dispatch});f.policy.finish([one.jobId+'-input'],{text:'实际资料',completed:true});
 assert.equal(f.policy.delivery(one.jobId,{begin:true}),null);assert.equal(f.policy.delivery(one.jobId),'held');f.policy.delivery(one.jobId,{confirmed:true});
 assert.equal((await f.policy.tick({dispatch,hasDiarySources:()=>true})).state,'idle');
 f.setTime('2026-11-14T07:00:00Z');assert.equal((await f.policy.tick({dispatch,hasDiarySources:()=>true})).state,'idle','Old ordinary share does not create another strategy');
 const contact=f.policy.queueContact('原主动问候'),two=await f.policy.dispatchJob(contact.id,dispatch);f.policy.finish([two.jobId+'-input'],{text:'问候',completed:true});f.policy.delivery(two.jobId,{begin:true});f.policy.delivery(two.jobId,{confirmed:true});
 assert.equal(f.policy.status().usage.automaticMessages,2);
 f.setTime('2026-11-14T13:00:00Z');const diary=await f.policy.tick({dispatch,hasDiarySources:()=>true});assert.equal(f.policy.getJob(diary.jobId).kind,'diary');f.policy.finish([diary.jobId+'-input'],{text:'日记已保存',completed:true});
 assert.equal(f.policy.delivery(diary.jobId),'daily-message-limit');
 f.policy.configure({paused:true});assert.equal(f.policy.getJob(diary.jobId).state,'cancelled');f.policy.configure({paused:false});assert.equal(f.policy.delivery(diary.jobId),'suppressed');
});
test('midnight resets the correct local bucket, not prior uncertain usage or a paused policy',async t=>{
 const f=await fixture(t,1);f.policy.configure({idleMinutes:0,interests:['鲸鱼']});const job=await f.policy.tick({dispatch:j=>{f.policy.accept(j.id,'s','i');return true;}});f.policy.reserve(job.jobId);
 f.policy.configure({paused:true});f.setTime('2026-11-14T15:59:00Z');assert.equal(f.policy.status().usage.modelRequests,1);
 f.setTime('2026-11-14T16:01:00Z');assert.equal(localClock(f.now()).date,'2026-11-15');assert.equal(f.policy.status().usage.modelRequests,0);assert.equal((await f.policy.tick()).reason,'paused');
});
test('deterministic inbox notices share message limits while model budget stays zero',async t=>{
 const f=await fixture(t,0);f.policy.configure({automatic:false,idleMinutes:0,cooldownMinutes:0});const first='whalenest-bili-notice-'+'a'.repeat(64),second='whalenest-bili-notice-'+'b'.repeat(64),third='whalenest-bili-notice-'+'c'.repeat(64);
 assert.equal(f.policy.noticeDelivery(first,{begin:true}),null);assert.equal(f.policy.noticeDelivery(first),'held');f.policy.noticeDelivery(first,{confirmed:true});assert.equal(f.policy.noticeDelivery(second,{begin:true}),null);assert.equal(f.policy.noticeDelivery(third),'daily-message-limit');assert.equal(f.policy.status().usage.modelRequests,0);assert.equal(f.policy.status().usage.automaticMessages,2);
 f.policy.configure({paused:true});assert.equal(f.policy.noticeDelivery(third),'paused');const reload=createCompanionPolicy(f.options,f.route,{now:f.now});assert.equal(reload.noticeDelivery(second),'held');assert.equal(reload.status().usage.automaticMessages,2);
});

test('memory direct streams share the same quota without enabling autonomous activities',async t=>{
 const f=await fixture(t,2);f.policy.configure({automatic:false});
 const request={messages:[{role:'user',source:{kind:'plugin',plugin:'aurabot'}}]};
 const context={kind:'memory',runId:'memory-test',allowed:()=>true};let calls=0;
 const stream=async function*(){calls++;yield {type:'finish'};};
 await Array.fromAsync(budgetedStream(f.policy,request,stream,context));
 assert.equal(f.policy.status().settings.automatic,false);assert.equal(f.policy.status().usage.modelRequests,1);
 f.policy.configure({paused:true});
 await assert.rejects(Array.fromAsync(budgetedStream(f.policy,request,stream,context)),/blocked/);assert.equal(calls,1);
 f.policy.configure({paused:false});
 await Array.fromAsync(budgetedStream(f.policy,request,stream,context));
 await assert.rejects(Array.fromAsync(budgetedStream(f.policy,request,stream,context)),/blocked/);
 assert.equal(calls,2);
 const restarted=createCompanionPolicy(f.options,f.route,{now:f.now});
 assert.equal(restarted.status().usage.modelRequests,2);
});

test('gateway pressure defers optional jobs while foreground and committed delivery continue',async t=>{
 const {options,route,now,setTime}=await fixture(t,4);
 options.qq={gateway:{type:'snowluma',loginQrFile:join(options.dataDir,'login','qr.json')}};
 const f=createCompanionPolicy(options,route,{now});
 const file=join(options.dataDir,'managed-status.json');
 f.configure({idleMinutes:0,cooldownMinutes:0,interests:['鲸鱼']});
 const job=await f.tick({dispatch:j=>{f.accept(j.id,'native','accepted');return true;}});
 f.finish(['accepted'],{text:'已完成的记录',completed:true});
 await writeFile(file,JSON.stringify({ready:true,deferBackground:true,at:now()}));
 assert.equal(f.maintenanceReason(),'memory-pressure');
 assert.equal((await f.tick()).reason,'memory-pressure');
 assert.equal(f.delivery(job.jobId,{begin:true}),null);
 f.delivery(job.jobId,{confirmed:true});
 let calls=0;
 await Array.fromAsync(budgetedStream(f,{messages:[{role:'user',source:{kind:'user'}}]},async function*(){calls++;yield {type:'finish'};}));
 assert.equal(calls,1);
 setTime('2026-11-14T01:01:00Z');
 assert.equal(f.backgroundPressure(),false,'Stale data cannot defer background work permanently');
});
