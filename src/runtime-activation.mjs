import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {hash} from './routing.mjs';
import {createClawChatCore} from './clawchat-core.mjs';

const exec=promisify(execFile),pluginId='whalenest.runtime.deepseek-harness';

export function runtimeActivationTarget(installed,identity){
 assert.ok(installed?.version&&installed.integrity&&identity?.key,'Runtime activation needs the exact installation and identity');
 return {identity:identity.key,version:installed.version,integrity:installed.integrity,
  ...(Number.isSafeInteger(installed.activationGeneration)?{activationGeneration:installed.activationGeneration}:{})};
}

export function runtimeActivationHost(options,{core=createClawChatCore(options)}={}){
 return {installed:()=>core.installed(pluginId),async identity(){
  const state=await core.state(),route=options.clawchat.route;
  if(!state.available||!state.connected||state.ownerId!==route.sender||state.conversationId!==route.conversation)return null;
  const {configuration,stateDbPath}=core.binding(pluginId);
  return {key:hash({route,binding:configuration,stateDbPath}),idle:state.running===0&&state.queued===0,accountId:state.userId};
 }};
}

/** A metadata-only request to the authenticated, Core-owned voice endpoint. */
export async function probeRuntimeVoice(options,{fetchImpl=fetch}={}){
 try{
  const port=options.realtime?.bridgePort??8896;
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
  const file=join(options.dataDir,'realtime/session-secret'),info=lstatSync(file);
  assert.ok(info.isFile()&&!(info.mode&0o077));
  const secret=readFileSync(file,'utf8');assert.match(secret,/^[a-f0-9]{64}$/);
  const response=await fetchImpl('http://127.0.0.1:'+port+'/voice/v1/settings',{
   headers:{'x-voice-secret':secret},signal:AbortSignal.timeout(1500),redirect:'error',
  });
  if(!response.ok){await response.body?.cancel();return false;}
  const body=await response.json();return typeof body.voice==='string'&&Boolean(body.voice.trim());
 }catch{return false;}
}

/** QQ reconfiguration also needs its native writer when voice is disabled.
 * This is our lease, not a private Connect table or another SDK process. */
export function probeRuntimeLease(options){
 try{
  const lease=JSON.parse(readFileSync(join(options.dataDir,'runtime.lock'),'utf8'));
  if(lease.instanceId!==options.instanceId||lease.hostname!==hostname()||!Number.isSafeInteger(lease.pid)||lease.pid<=0)return false;
  process.kill(lease.pid,0);return true;
 }catch{return false;}
}

export async function probeRuntimeReady(options,dependencies){
 if(!probeRuntimeLease(options))return false;
 return options.realtime?.enabled===true?await probeRuntimeVoice(options,dependencies):true;
}

async function restartRuntime(options){
 // The existing image supervisor and official host own draining, preserving
 // publications, and restarting the original binding. No SDK is started here.
 await exec('/opt/clawnest/bin/supervisord',['ctl','restart','dsh-agent'],{
  cwd:options.cwd,timeout:90000,maxBuffer:128*1024,
 });
}

/** Reconcile one durable restart intent. Once an intent exists, even a lost
 * command acknowledgement can only be observed; restart is never resubmitted.
 * Callers keep separate records for forward activation and rollback.
 */
export async function ensureRuntimeActivation(options,configuration={}){
 if(!(configuration.required??options.realtime?.enabled===true))return {state:'ready',skipped:true};
 mkdirSync(options.dataDir,{recursive:true,mode:0o700});
 const lease=new DatabaseSync(join(options.dataDir,'runtime-activation.sqlite'));
 try{lease.exec('BEGIN IMMEDIATE');}catch(error){
  lease.close();if(error.errcode===5||error.code==='SQLITE_BUSY')return {state:'pending',reason:'activation-busy'};throw error;
 }
 try{return await activateRuntime(options,configuration);}finally{lease.close();}
}

async function activateRuntime(options,{host,expected,read,save,
 required=options.realtime?.enabled===true,probe,restart=restartRuntime,wait=delay,
 attempts=60,intervalMs=1000,now=Date.now}={}){
 if(!required)return {state:'ready',skipped:true};
 host??=runtimeActivationHost(options);
 assert.ok(expected&&typeof read==='function'&&typeof save==='function');
 assert.ok(Number.isSafeInteger(attempts)&&attempts>0&&Number.isFinite(intervalMs)&&intervalMs>=0);
 probe??=()=>probeRuntimeReady(options);
 const matches=(installed,identity)=>installed?.status==='active'&&identity?.key===expected.identity&&
  installed.version===expected.version&&installed.integrity===expected.integrity&&
  (expected.activationGeneration===undefined||installed.activationGeneration===expected.activationGeneration);
 const snapshot=async()=>({installed:host.installed(),identity:await host.identity()});
 const persist=async fields=>{const next={...(read()??{}),...fields,updatedAt:now()};await save(next);return next;};
 let record=read(),current;
 if(record&&hash(record.target)!==hash(expected))return {state:'unavailable',reason:'activation-target-changed'};
 try{current=await snapshot();}catch{return {state:'pending',reason:'runtime-unavailable'};}
 if(!matches(current.installed,current.identity))return {state:'unavailable',reason:'activation-identity-changed'};
 if(await probe()){
  if(record)record=await persist({state:'ready'});
  return {state:'ready',...(record?{activation:record}:{})};
 }
 if(!record){
  if(!current.identity.idle)return {state:'pending',reason:'runtime-busy'};
  // Recheck after the readiness read before admitting the single restart.
  current=await snapshot();
  if(!matches(current.installed,current.identity))return {state:'unavailable',reason:'activation-identity-changed'};
  if(!current.identity.idle)return {state:'pending',reason:'runtime-busy'};
  record=await persist({schema:1,target:expected,state:'restart-submitting',attemptedAt:now()});
  try{await restart(options);record=await persist({ack:'accepted',state:'observing'});}
  catch{record=await persist({ack:'unknown',state:'observing'});}
 }
 for(let attempt=0;attempt<attempts;attempt++){
  try{
   current=await snapshot();
   if(matches(current.installed,current.identity)&&await probe()){
    record=await persist({state:'ready'});return {state:'ready',activation:record};
   }
   if(current.identity&&current.identity.key!==expected.identity)
    return {state:'unavailable',reason:'activation-identity-changed'};
  }catch{/* The original host may be between stopped and ready. */}
  if(attempt<attempts-1)await wait(intervalMs);
 }
 record=await persist({state:'uncertain'});
 return {state:'uncertain',reason:'runtime-activation-unconfirmed',activation:record};
}
