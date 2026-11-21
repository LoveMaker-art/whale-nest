import assert from 'node:assert/strict';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readState,writeState} from './state.mjs';
import {hash,routeKey,senderKey,ownerScope,resolveDeliveryTarget} from './routing.mjs';
import {parseReply} from '../vendor/aurabot/src/chat/reply.js';

export function localClock(at,zone='Asia/Shanghai') {
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,minutes:Number(p.hour)*60+Number(p.minute)};
}
const terminal=new Set(['confirmed','failed','cancelled','suppressed']);
export function createCompanionPolicy(options,route,{now=Date.now,available=()=>true}={}) {
 const scope=ownerScope(options),legacyScope=hash([options.instanceId,routeKey(route),senderKey(route)]),file=join(resolve(options.dataDir),'companion-policy.json');
 const initial={schema:2,scope,settings:{automatic:options.activities?.automatic===true,contactEnabled:false,proactivePlatform:'clawchat',paused:false,timezone:'Asia/Shanghai',awakeFrom:9,awakeTo:22,idleMinutes:120,cooldownMinutes:240,maxProactivePerDay:2,maxBrowsePerDay:1,diaryHour:21,interests:[]},lastOwnerAt:now(),lastAutomaticAt:0,days:{},jobs:{},reservations:{}};
 const state=readState(file,initial);
 assert.ok(state.scope===scope||state.schema===1&&state.scope===legacyScope,'Companion policy belongs to another owner');
 state.schema=2;state.scope=scope;state.settings={...initial.settings,...state.settings};
 if(!state.contact){
  const legacy=readState(join(resolve(options.dataDir),'aurabot','speakup.json'),{});
  if(legacy.count>0){
   const date=localClock(legacy.last||now()).date,bucket=state.days[date]??={modelRequests:0,automaticMessages:0,inputTokens:0,outputTokens:0};
   assert.equal(bucket.automaticMessages,0,'Existing QQ and ClawChat contact counts require explicit reconciliation');
   bucket.automaticMessages=legacy.count;
   state.lastAutomaticAt=Math.max(state.lastAutomaticAt,legacy.last||0);
  }
  state.contact={nextAt:legacy.nextAt||0,last:legacy.last||0,sequence:0};
 }
 const limit=options.activities?.maxDailyBackgroundModelCalls??0;assert.ok(Number.isInteger(limit)&&limit>=0&&limit<=100,'Invalid background request ceiling');
 const save=()=>writeState(file,state),clock=()=>localClock(now(),state.settings.timezone);
 for(const job of Object.values(state.jobs))if(job.state==='running')job.state='uncertain';
 for(const job of Object.values(state.jobs))if(job.kind==='share'&&!terminal.has(job.state)&&!job.deliveryHeld&&job.state!=='uncertain'){
  job.cancelRequested=true;job.state='cancelled';job.retiredReason='original-speakup-replaces-share';
 }
 save();let ticking=false;
 const gateway=options.qq?.gateway;
 const gatewayStatus=gateway?.type==='snowluma'&&gateway.loginQrFile
  ?join(dirname(dirname(resolve(gateway.loginQrFile))),'managed-status.json'):null;
 function backgroundPressure(){
  if(!gatewayStatus)return false;
  try{
   const status=readState(gatewayStatus,{});
   const age=now()-status.at;
   return status.ready===true&&status.deferBackground===true&&age>=0&&age<=20000;
  }catch{return false;}
 }
 function day(date=clock().date){return state.days[date]??= {modelRequests:0,automaticMessages:0,inputTokens:0,outputTokens:0};}
 const target=()=>resolveDeliveryTarget(options,{automatic:true,preferred:state.settings.proactivePlatform,available});
 function reason({message=false,externalNotice=false,kind,continuing=false}={}) {
  const s=state.settings,c=clock();
  if(s.paused)return 'paused';
  if(kind==='contact'?!s.contactEnabled:!s.automatic&&!externalNotice)return kind==='contact'?'contact-disabled':'automatic-disabled';
  if(c.minutes<s.awakeFrom*60||c.minutes>=s.awakeTo*60)return 'quiet-hours';
  if(message){
   if(now()-state.lastOwnerAt<s.idleMinutes*60000)return 'owner-recently-active';
   if(!continuing&&now()-state.lastAutomaticAt<s.cooldownMinutes*60000)return 'cooldown';
   if(day().automaticMessages>s.maxProactivePerDay||!continuing&&day().automaticMessages>=s.maxProactivePerDay)return 'daily-message-limit';
  }else if(day().modelRequests>=limit)return limit===0?'background-model-disabled':'daily-model-limit';
  return null;
 }
 function configure(patch){
  const keys=new Set(['automatic','contactEnabled','proactivePlatform','paused','awakeFrom','awakeTo','idleMinutes','cooldownMinutes','maxProactivePerDay','maxBrowsePerDay','diaryHour','interests']);
  for(const key of Object.keys(patch))assert.ok(keys.has(key),'Unsupported setting: '+key);
  const next={...state.settings,...patch};
  for(const key of ['automatic','contactEnabled','paused'])assert.equal(typeof next[key],'boolean',key+' must be boolean');
  assert.ok(['clawchat','qq'].includes(next.proactivePlatform),'Unsupported proactive platform');
  if(next.proactivePlatform!==state.settings.proactivePlatform){
   const resolved=resolveDeliveryTarget(options,{automatic:true,preferred:next.proactivePlatform,available});
   assert.ok(resolved.ok,'Cannot select proactive platform: '+resolved.reason);
  }
  for(const [key,min,max]of[['awakeFrom',0,23],['awakeTo',1,24],['idleMinutes',0,1440],['cooldownMinutes',0,1440],['maxProactivePerDay',0,10],['maxBrowsePerDay',0,10],['diaryHour',0,23]])assert.ok(Number.isInteger(next[key])&&next[key]>=min&&next[key]<=max,'Invalid '+key);
  assert.ok(next.awakeFrom<next.awakeTo,'Contact window must be ordered');
  assert.ok(Array.isArray(next.interests)&&next.interests.length<=10&&next.interests.every(x=>typeof x==='string'&&x.trim()&&x.length<=100),'Provide up to 10 short interests');
  next.interests=next.interests.map(x=>x.trim());const previous=state.settings;state.settings=next;
  if(previous.proactivePlatform!==next.proactivePlatform)state.proactiveGeneration=(state.proactiveGeneration??0)+1;
  for(const job of Object.values(state.jobs))if(!terminal.has(job.state)){
   const disabled=next.paused||(job.kind==='contact'?!next.contactEnabled:!next.automatic);
   const rerouted=previous.proactivePlatform!==next.proactivePlatform&&job.targetBasis==='preference'&&!job.deliveryHeld;
   if(disabled||rerouted){job.cancelRequested=true;if(job.state!=='running'&&job.state!=='uncertain')job.state='cancelled';}
  }
  save();return status();
 }
 function status(){const c=clock();return {settings:structuredClone(state.settings),date:c.date,dailyModelRequestLimit:limit,usage:structuredClone(day()),platformBilling:'not-connected; local limits are not a platform balance',blockedReason:reason()??(backgroundPressure()?'memory-pressure':null),contactBlockedReason:contactReason(),proactiveTarget:target(),lastOwnerAt:state.lastOwnerAt,lastAutomaticAt:state.lastAutomaticAt,contact:{...state.contact},qqOnboarding:state.qqOnboarding??null,jobs:Object.values(state.jobs).slice(-20).map(j=>({...j}))};}
 function input(text,{id,route:origin,source='user'}={}){if(source!=='user'||text.includes('运维自测'))return;
  if(origin)assert.ok(origin.kind==='private'&&options.owners?.some(o=>senderKey(o)===senderKey(origin)),'Verified owner interaction required');
  if(id){state.ownerInputs??={};const key=hash([origin?routeKey(origin):'',id]);if(state.ownerInputs[key])return;state.ownerInputs[key]=now();const keys=Object.keys(state.ownerInputs);for(const k of keys.slice(0,Math.max(0,keys.length-256)))delete state.ownerInputs[k];}
  state.lastOwnerAt=now();save();}
 function jobForInput(ids){return Object.values(state.jobs).find(job=>ids.includes(job.inputId));}
 function requestJob(request){
  const message=request.messages.findLast(m=>m.role==='user'&&['user','schedule','aurabot'].includes(m.source?.kind));
  if(!['schedule','aurabot'].includes(message?.source?.kind)||!String(message.source.taskId??'').startsWith('whalenest-job-'))return null;
  const job=state.jobs[message.source.taskId];assert.ok(job&&job.sessionId===String(request.sessionId),'Unknown background job identity');return job;
 }
 function nativeJob(session){
  for(let seq=session.seq;seq>=0;seq--){const event=session.eventAt(seq);if(event?.type!=='user/message')continue;const message=event.data.message??event.data;
   if(!['user','schedule','aurabot'].includes(message.source?.kind))continue;
   const job=['schedule','aurabot'].includes(message.source.kind)?state.jobs[message.source.taskId]??null:null;
   if(job)assert.equal(job.sessionId,String(session.id),'Background session identity mismatch');return job;
  }return null;
 }
 function reserve(jobId){const job=state.jobs[jobId];assert.ok(job&&job.state==='running'&&!job.cancelRequested,'Background job is not active');
  const blocked=reason({kind:job.kind});assert.equal(blocked,null,'Background request blocked: '+blocked);const date=clock().date,id=randomUUID();day(date).modelRequests++;
  state.reservations[id]={jobId,date,state:'uncertain',createdAt:now()};save();return id;
 }
 function maintenanceReason(){
  const s=state.settings,c=clock();
  if(backgroundPressure())return 'memory-pressure';
  if(s.paused)return 'paused';
  if(c.minutes<s.awakeFrom*60||c.minutes>=s.awakeTo*60)return 'quiet-hours';
  if(day().modelRequests>=limit)return limit===0?'background-model-disabled':'daily-model-limit';
  return null;
 }
 function reserveMaintenance(context){
  assert.ok(context?.kind==='memory'&&typeof context.runId==='string'&&context.allowed(),'Invalid memory maintenance context');
  assert.equal(maintenanceReason(),null,'Memory request blocked: '+maintenanceReason());
  const date=clock().date,id=randomUUID();day(date).modelRequests++;
  state.reservations[id]={kind:'memory',runId:context.runId,date,state:'uncertain',createdAt:now()};save();return id;
 }
 function reserveSocial(context){
  assert.ok(context?.kind==='qq-social'&&typeof context.runId==='string'&&context.allowed(),'Invalid QQ social context');
  assert.equal(maintenanceReason(),null,'QQ social request blocked: '+maintenanceReason());
  const date=clock().date,id=randomUUID();day(date).modelRequests++;
  state.reservations[id]={kind:'qq-social',runId:context.runId,date,state:'uncertain',createdAt:now()};save();return id;
 }
 function reserveNotice(){
  assert.equal(maintenanceReason(),null,'Notice model request blocked');
  const date=clock().date,id=randomUUID();day(date).modelRequests++;
  state.reservations[id]={kind:'reply-notice',date,state:'uncertain',createdAt:now()};save();return id;
 }
 function settle(id,{complete,usage}={}){const r=state.reservations[id];assert.ok(r,'Unknown budget reservation');if(r.state==='confirmed')return;
  if(complete)r.state='confirmed';
  if(usage&&!r.usage){const count=x=>Number.isFinite(x)&&x>=0?Math.floor(x):0;r.usage={inputTokens:count(usage.inputTokens),outputTokens:count(usage.outputTokens)};day(r.date).inputTokens+=r.usage.inputTokens;day(r.date).outputTokens+=r.usage.outputTokens;}
  save();
 }
 function accept(id,sessionId,inputId){const job=state.jobs[id];assert.ok(job&&['queued','deferred'].includes(job.state)&&!job.cancelRequested,'Job was already accepted');
  const blocked=reason({kind:job.kind,...(job.kind==='contact'?{message:true}:{})});assert.equal(blocked,null,'Background admission blocked: '+blocked);
  job.sessionId=sessionId;job.inputId=inputId;job.state='running';save();}
 function finish(ids,{text,completed=true}={}){const job=jobForInput(ids);if(!job)return null;
  if(job.state==='confirmed')return {...job};
  job.reply=text??'';job.finishedAt=now();const silent=!text||text==='[SKIP]'||parseReply(text).silent;
  job.state=job.cancelRequested?'suppressed':completed&&!silent?'awaiting-delivery':completed?'suppressed':'failed';save();return {...job};
 }
 function delivery(id,{begin=false,confirmed=false,continuing=false}={}){const job=state.jobs[id];assert.ok(job,'Unknown background delivery');
  if(confirmed){job.state='confirmed';job.messageConfirmedAt=now();save();return null;}
  if(job.cancelRequested||['cancelled','suppressed','failed'].includes(job.state))return 'suppressed';
  if(job.state==='confirmed'||job.deliveryHeld&&!continuing)return 'held';
  const blocked=reason({message:true,kind:job.kind,continuing:continuing&&job.deliveryHeld});if(blocked)return blocked;
  if(job.route&&!available(job.route))return 'channel-unavailable';
  if(begin){job.deliveryHeld=true;job.deliveryDate=clock().date;day().automaticMessages++;state.lastAutomaticAt=now();save();}return null;
 }
 function noticeDelivery(id,{begin=false,confirmed=false}={}){
  assert.match(id,/^whalenest-bili-notice-[a-f0-9]{64}$/,'Invalid Bili notice identity');state.notices??={};const record=state.notices[id];
  if(confirmed){assert.ok(record,'Notice was not reserved');record.state='confirmed';record.confirmedAt=now();save();return null;}
  if(record)return 'held';const blocked=reason({message:true,externalNotice:true});if(blocked)return blocked;
  if(begin){state.notices[id]={state:'held',date:clock().date,at:now()};day().automaticMessages++;state.lastAutomaticAt=now();save();}return null;
 }
 async function tick({dispatch,hasDiarySources=()=>false,diaryExists=()=>false}={}){
  if(ticking)return {state:'busy'};ticking=true;
  try{
   const blocked=reason();if(blocked)return {state:'blocked',reason:blocked};
   if(backgroundPressure())return {state:'blocked',reason:'memory-pressure'};
   const active=Object.values(state.jobs).find(j=>!terminal.has(j.state)&&!['queued','deferred'].includes(j.state));if(active)return {state:'waiting',jobId:active.id};
   const c=clock(),s=state.settings;
   let job=Object.values(state.jobs).find(j=>['queued','deferred'].includes(j.state)&&j.date===c.date&&!j.cancelRequested);
   if(!job){
    const today=Object.values(state.jobs).filter(j=>j.date===c.date);
    let kind;if(c.minutes>=s.diaryHour*60&&!diaryExists(c.date)&&hasDiarySources(c.date)&&!today.some(j=>j.kind==='diary'))kind='diary';
    else if(!reason({message:true})&&s.interests.length&&today.filter(j=>j.kind==='browse'&&(j.inputId||!['queued','deferred','cancelled'].includes(j.state))).length<s.maxBrowsePerDay)kind='browse';
    if(!kind)return {state:'idle'};
    const index=today.filter(j=>j.kind===kind).length,id='whalenest-job-'+hash([scope,c.date,kind,index]);
    job=state.jobs[id]={id,date:c.date,kind,state:'queued',startedAt:now(),interest:s.interests[index%s.interests.length]??''};save();
   }
   assert.equal(typeof dispatch,'function','Native background dispatcher unavailable');
   try{const accepted=await dispatch({...job});if(!accepted&&job.state==='queued')job.state='deferred';save();return {state:job.state,jobId:job.id};}
   catch{job.state=job.inputId?'uncertain':'failed';save();return {state:job.state,jobId:job.id};}
  }finally{ticking=false;}
 }
 function cancelJob(id){const job=state.jobs[id];assert.ok(job,'Unknown background job');assert.ok(job.state!=='confirmed','Confirmed delivery cannot be cancelled');job.cancelRequested=true;job.state='cancelled';save();return status();}
 function assignTarget(id,{allowUnavailable=false}={}){const job=state.jobs[id];assert.ok(job,'Unknown background task');
  if(job.route)return {...structuredClone(job),available:available(job.route)};
  const resolved=target();if(!resolved.ok&&!(allowUnavailable&&resolved.reason==='channel-unavailable'&&resolved.route))return {...structuredClone(job),available:false,blockedReason:resolved.reason};
  job.route=resolved.route;job.targetBasis=resolved.basis;save();return {...structuredClone(job),available:resolved.ok};
 }
 function bindSystemInput(id,sessionId,inputId){const job=state.jobs[id];assert.ok(['browse','diary'].includes(job?.kind),'Only original content tasks use this system input');
  job.engine=job.kind==='diary'?'aurabot-diary':'aurabot-bili';
  if(['queued','deferred'].includes(job.state))accept(id,String(sessionId),String(inputId));
  else assert.ok(job.state==='running'&&job.sessionId===String(sessionId)&&!job.cancelRequested,'Original content system job is not active');
  job.inputIds??=[job.inputId];if(!job.inputIds.includes(String(inputId)))job.inputIds.push(String(inputId));save();
 }
 function contactReason(){
  if(backgroundPressure())return 'memory-pressure';
  const blocked=reason({kind:'contact',message:true})??reason({kind:'contact'});if(blocked)return blocked;
  if(Object.values(state.jobs).some(j=>!terminal.has(j.state)))return 'background-job-active';
  const resolved=target();return resolved.ok?null:resolved.reason;
 }
 function contactState(){return {...state.contact,day:clock().date,count:day().automaticMessages};}
 function saveContact(value){for(const key of ['nextAt','last','nudgedFor'])if(Number.isFinite(value[key]))state.contact[key]=value[key];save();}
 function queueContact(prompt){assert.equal(contactReason(),null,'Contact blocked: '+contactReason());
  const resolved=target(),date=clock().date,index=state.contact.sequence++,id='whalenest-job-'+hash([scope,date,'contact',index]);
  const job=state.jobs[id]={id,date,kind:'contact',state:'queued',startedAt:now(),prompt,route:resolved.route,targetBasis:resolved.basis};save();return structuredClone(job);
 }
 async function dispatchJob(id,dispatch){const job=state.jobs[id];assert.ok(job&&['queued','deferred'].includes(job.state),'Job cannot dispatch');
  if(backgroundPressure())return {state:'blocked',reason:'memory-pressure'};
  const blocked=reason({kind:job.kind})??(job.kind==='contact'?reason({kind:'contact',message:true}):null);if(blocked||job.cancelRequested)return {state:'blocked',reason:blocked??'cancelled'};
  if(job.route&&!available(job.route))return {state:'blocked',reason:'channel-unavailable'};
  try{const accepted=await dispatch(structuredClone(job));if(!accepted&&job.state==='queued')job.state='deferred';save();return {state:job.state,jobId:id};}
  catch(error){job.state=job.inputId?'uncertain':'failed';save();throw error;}
 }
 function qqOnboarding(){if(state.qqOnboarding)return null;state.qqOnboarding={id:'whalenest-qq-guide-'+hash(scope),at:now(),state:'offered'};save();return {...state.qqOnboarding};}
 function nativeReceipt(id,{messageId,error,attempt=false,done=false,incomplete=false}={}){
  const job=state.jobs[id];assert.ok(job,'Unknown native delivery');job.nativeReceipts??=[];
  if(attempt)job.nativeAttempts=(job.nativeAttempts??0)+1;
  if(messageId!==undefined&&!job.nativeReceipts.includes(String(messageId)))job.nativeReceipts.push(String(messageId));
  if(error)job.nativeUncertain=true;
  if(incomplete)job.nativeIncomplete=true;
  if(done&&job.deliveryHeld){
   job.state=job.nativeUncertain?'uncertain':job.nativeIncomplete?'suppressed':job.nativeReceipts.length===(job.nativeAttempts??0)&&job.nativeReceipts.length?'confirmed':'uncertain';
   if(job.nativeIncomplete)job.deliveryOutcome='partial';
  }
  save();return structuredClone(job);
 }
 return {proactiveGeneration:()=>state.proactiveGeneration??0,status,configure,input,backgroundPressure,requestJob,nativeJob,reserve,maintenanceReason,reserveMaintenance,reserveSocial,reserveNotice,settle,accept,finish,delivery,noticeDelivery,tick,jobForInput,cancelJob,target,assignTarget,bindSystemInput,contactReason,contactState,saveContact,queueContact,dispatchJob,qqOnboarding,nativeReceipt,pendingDiaries:()=>structuredClone(Object.values(state.jobs).filter(j=>j.kind==='diary'&&!terminal.has(j.state))),pendingBrowses:()=>structuredClone(Object.values(state.jobs).filter(j=>j.kind==='browse'&&!terminal.has(j.state))),pendingContacts:()=>structuredClone(Object.values(state.jobs).filter(j=>j.kind==='contact'&&!terminal.has(j.state))),getJob:id=>state.jobs[id]?structuredClone(state.jobs[id]):null};
}

export async function* budgetedStream(policy,request,next,maintenance,background){
 const job=maintenance?null:policy.requestJob(request)??(background?policy.getJob(background.jobId):null);if(!job&&!maintenance){yield* next();return;}
 const social=maintenance?.kind==='qq-social';
 const id=social?policy.reserveSocial(maintenance):maintenance?policy.reserveMaintenance(maintenance):policy.reserve(job.id);let usage,complete=false;
 if(social)maintenance.requests++;
 try{for await(const chunk of next()){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')complete=true;yield chunk;}}
 finally{policy.settle(id,{complete,usage});if(social&&!complete)maintenance.uncertain=true;}
}
