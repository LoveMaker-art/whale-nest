import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncResource} from 'node:async_hooks';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {createQQNative} from '../src/qq-native.mjs';
import {createCompanionPolicy,budgetedStream} from '../src/companion-policy.mjs';
import {protectQQSocialRollback} from '../src/runtime-upgrade.mjs';

async function fixture(t,{limit=5,comments=3,friends=false,failLike=false,failModel=false,failComment=false,afterDraft,clock=()=>Date.parse('2030-01-01T04:00:00Z')}={}){
 const root=await mkdtemp(join(tmpdir(),'whalenest-qq-social-'));t.after(()=>rm(root,{recursive:true,force:true}));const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const route={channel:'clawchat',account:'agent',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'qq-auto',dataDir,owners:[route],qq:{enabled:true,nativeModules:true},activities:{automatic:false,maxDailyBackgroundModelCalls:limit}};
 const policy=createCompanionPolicy(options,route,{now:clock});let cfg=normalize({enabled:true,dryRun:false,ownerQQ:'10000001',botQQ:'20000002',qzoneSocial:{enabled:true,replyOwn:!friends,commentFriends:friends,friendChance:1,ownerChance:1,maxPerDay:8,intervalMin:1}}),models=0;
 const calls=[],outside=new AsyncResource('social-model-worker');let backend,qq;
 const onebot={state:'connected',async call(action,params,settings){calls.push({action,params,settings});if(action==='get_qzone_msg_list')return {msglist:[{tid:'own',comment_num:comments,time:Date.now()/1000,content:'公开资料'}]};
  if(action==='get_qzone_feeds')return {feeds:[0,1].map(i=>({appid:311,uin:10000001,nickname:'主人',key:'feed'+i,time:Date.now()/1000,html:'公开动态'}))};
  if(action==='get_qzone_msg_detail')return {content:'公开动态',comments:friends?[]:Array.from({length:comments},(_,i)=>({comment_id:'c'+i,uin:10000001,name:'主人',content:'公开评论'+i,time:i+1}))};
  if(action==='like_qzone'&&failLike)throw Error('lost like ACK');
  if(action==='comment_qzone'&&failComment)throw Error('lost comment ACK');return null;}};
 const hub={selfId:'20000002',logChat(){},async runSystemTurn(name,title,prompt,settings){assert.equal(settings.noTools,true);const inputId='input-'+models;settings.backgroundTask?.admit('social-session',inputId);
  assert.equal(qq.modelContext({sessionId:'foreground',messages:[{id:'owner',role:'user',source:{kind:'user'}}]}),null,'A nearby foreground request cannot inherit an automatic reservation');
  const request={sessionId:'social-session',messages:[{id:inputId,role:'user',source:{kind:'aurabot',taskId:settings.backgroundTask?.id}}]};
  await outside.runInAsyncScope(()=>Array.fromAsync(budgetedStream(policy,request,async function*(){models++;if(failModel)throw Error('lost model result');yield {type:'usage',usage:{inputTokens:3,outputTokens:2}};yield {type:'finish'};},qq.modelContext(request))));
  await afterDraft?.(policy);return '公开评论回复';}};
 const native={onebot,getConfig:()=>cfg,setConfig:v=>{cfg=normalize(v);},modules:{use:id=>id==='qzone-social'?backend:{}}};
 function boot(){qq=createQQNative(options,()=>native,{policy,now:clock});backend=qq.module().setup({config:()=>cfg,core:{onebot,hub},lazy:()=>({addEvent(){}}),every(){},route(){},log:{debug(){},info(){},warn(){}}});return qq;}
 boot();return {root,dataDir,policy,native,calls,boot,qq,models:()=>models,set:patch=>{cfg=normalize({...cfg,...patch});},state:()=>readFile(join(dataDir,'aurabot/qzone-social.json'),'utf8').then(JSON.parse)};
}
test('QQ auto and memory use one budget; partial progress remains pending when the final permitted model request finishes',async t=>{
 let now=Date.parse('2030-01-01T04:00:00Z');const f=await fixture(t,{clock:()=>now});
 for(let i=0;i<4;i++)await Array.fromAsync(budgetedStream(f.policy,{messages:[]},async function*(){yield {type:'finish'};},{kind:'memory',runId:'memory-'+i,allowed:()=>true}));
 const first=await f.qq.tick();assert.equal(first.state,'completed');assert.equal(first.replies,1);assert.equal(f.models(),1);assert.equal(f.policy.status().usage.modelRequests,5);assert.equal(f.policy.status().settings.automatic,false,'QQ switch does not enable Bili/diary');
 let state=await f.state();assert.equal(state.count,1);assert.deepEqual(state.replied.own,['c0']);
 assert.equal((await f.qq.tick()).reason,'daily-model-limit');assert.equal(f.models(),1);assert.equal(f.calls.filter(c=>c.action==='comment_qzone').length,1);
 now+=86400000;const later=await f.boot().tick();assert.equal(later.replies,2);state=await f.state();assert.equal(state.replied.own.length,3);assert.equal(f.policy.status().usage.modelRequests,2);assert.equal(f.calls.filter(c=>c.action==='comment_qzone').length,3);
});
test('QQ auto gates disabled, unavailable, paused, quiet hours and zero quota before reading or generating',async t=>{
 const f=await fixture(t);f.set({qzoneSocial:{enabled:false}});assert.equal((await f.qq.tick()).reason,'social-disabled');
 f.set({qzoneSocial:{enabled:true}});f.native.onebot.state='disconnected';assert.equal((await f.qq.tick()).reason,'qq-unavailable');f.native.onebot.state='connected';
 f.policy.configure({paused:true});assert.equal((await f.qq.tick()).reason,'paused');f.policy.configure({paused:false,awakeFrom:13,awakeTo:14});assert.equal((await f.qq.tick()).reason,'quiet-hours');assert.equal(f.calls.length,0);assert.equal(f.models(),0);
 const zero=await fixture(t,{limit:0});assert.equal((await zero.qq.tick()).reason,'background-model-disabled');assert.equal(zero.calls.length,0);
});
test('pausing after a successful draft prevents posting while retaining its actual model usage',async t=>{
 let paused=false;const f=await fixture(t,{comments:1,afterDraft:p=>{if(!paused){paused=true;p.configure({paused:true});}}});
 assert.equal((await f.qq.tick()).state,'blocked');assert.equal(f.models(),1);assert.equal(f.calls.filter(c=>c.action==='comment_qzone').length,0);assert.equal(f.policy.status().usage.modelRequests,1);
 f.policy.configure({paused:false});assert.equal((await f.qq.tick()).replies,1);assert.equal(f.models(),2);assert.equal(f.policy.status().usage.modelRequests,2);
});
test('unknown automatic model or comment results are held across restart without another call',async t=>{
 for(const options of [{failModel:true},{failComment:true}]){const f=await fixture(t,{comments:1,...options});assert.equal((await f.qq.tick()).state,'held');const models=f.models(),calls=f.calls.length;
  assert.equal((await f.boot().tick()).state,'held');assert.equal(f.qq.status().automaticBlockedReason,'previous-run-unconfirmed');assert.equal(f.models(),models);assert.equal(f.calls.length,calls);assert.equal(f.policy.status().usage.modelRequests,1);
  if(options.failComment)assert.equal(f.calls.find(c=>c.action==='comment_qzone').settings.retries,0);
 }
});
test('a normal automatic run respects the original interval and does not run again immediately',async t=>{
 const f=await fixture(t,{comments:1,clock:Date.now});f.policy.configure({awakeFrom:0,awakeTo:24});assert.equal((await f.qq.tick()).replies,1);assert.equal((await f.qq.tick()).reason,'interval');assert.equal(f.models(),1);
});
test('older writers cannot restart automatic QQ social work after rollback, while settings and records remain intact',()=>{
 const cfg={enabled:true,qzoneSocial:{enabled:true,maxPerDay:8},modules:{'qzone-social':{enabled:true}},persona:{current:'dafeiyu-original'}};
 assert.equal(protectQQSocialRollback(cfg,'0.3.0-whalenest.m3.21').disableAutomaticSocial,false);assert.equal(cfg.qzoneSocial.enabled,true);
 assert.equal(protectQQSocialRollback(cfg,'0.3.0-whalenest.m3.20').disableAutomaticSocial,true);assert.equal(cfg.qzoneSocial.enabled,false);assert.equal(cfg.enabled,true);assert.equal(cfg.modules['qzone-social'].enabled,true);assert.equal(cfg.qzoneSocial.maxPerDay,8);
});
test('friend browsing completes the final budgeted comment, leaves other feeds pending and holds an unknown like',async t=>{
 const f=await fixture(t,{limit:1,friends:true});const r=await f.qq.tick();assert.equal(r.state,'completed');assert.equal(r.comments,1);assert.equal(f.models(),1);assert.equal(f.policy.status().usage.modelRequests,1);
 assert.equal(f.calls.filter(c=>c.action==='like_qzone').length,1);assert.equal(f.calls.filter(c=>c.action==='comment_qzone').length,1);assert.deepEqual((await f.state()).seen,['feed0']);
 const g=await fixture(t,{limit:1,friends:true,failLike:true});assert.equal((await g.qq.tick()).state,'held');assert.equal(g.models(),0);assert.equal(g.policy.status().usage.modelRequests,0);assert.equal((await g.boot().tick()).state,'held');assert.equal(g.calls.filter(c=>c.action==='like_qzone').length,1);
});
