import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {readState, writeState} from './state.mjs';
import {qqManagementFile} from './qq-transition.mjs';
import {routeKey, senderKey,hash} from './routing.mjs';
import {createClawChatCore} from './clawchat-core.mjs';
import {ensureRuntimeActivation,runtimeActivationHost,runtimeActivationTarget,probeRuntimeVoice,probeRuntimeLease} from './runtime-activation.mjs';

const pluginId = 'whalenest.runtime.deepseek-harness';

/** Activate the existing installation through its host's draining lifecycle.
 * Runs outside the SDK process being replaced; never installs another Agent. */
export async function reloadQQConnection(configPath, jobId, {fetchImpl = fetch,core,activate=ensureRuntimeActivation,wait=delay} = {}) {
  const options = readState(resolve(configPath), null), file = qqManagementFile(options);
  const update = (fields,queuedOnly=false) => {
    const state = readState(file, null), job = state?.transition;
    if (job?.id === jobId && (!queuedOnly||job.state==='queued')) { Object.assign(job, fields); writeState(file, state); }
  };
  const job = readState(file, null)?.transition;
  if (job?.id !== jobId || !['queued','data-applied','confirmed'].includes(job.state) ||
      ['rejected','preflight-failed','applied'].includes(job.reloadState) && !job.runtimeActivation) return;
  try {
    assert.equal(resolve(job.configPath), resolve(configPath));
    assert.equal(job.instanceId, options.instanceId);
    assert.equal(senderKey(job.actor), senderKey(options.clawchat.route));
    assert.equal(routeKey(job.actor), routeKey(options.clawchat.route));
    core??=createClawChatCore(options, {fetchImpl});
    const installed = core.installed(pluginId);
    assert.equal(installed?.status, 'active', '鲸栖Runtime未在当前Core启用');
    const {configuration,stateDbPath} = core.binding(pluginId);
    // QQ changes already reside in our durable transition. Core configuration
    // is unchanged; a normal host restart loads that transition once without
    // replacing a Managed Web App generation or touching its active leases.
    if(!job.reloadState){
      update({reloadState:'activation-pending',reloadMethod:'supervisor',reloadSelection:{version:installed.version,integrity:installed.integrity,
        activationGeneration:installed.activationGeneration,
        identity:hash({route:options.clawchat.route,binding:configuration,stateDbPath})}},true);
    }
    const current=readState(file,null)?.transition,before=current?.reloadSelection;
    if(!before?.version||!before.integrity)return {state:'unavailable',reason:'legacy-configure-unconfirmed'};
    const host=runtimeActivationHost(options,{core});
    const probe=async()=>{
      if(readState(file,null)?.transition?.state!=='confirmed')return false;
      return options.realtime?.enabled===true?await probeRuntimeVoice(options,{fetchImpl}):probeRuntimeLease(options);
    };
    let activation;
    for(let attempt=0;attempt<60;attempt++){
      const selected=host.installed();
      if(selected?.version!==before.version||selected.integrity!==before.integrity){
        update({reloadState:'selection-changed'});return {state:'unavailable',reason:'activation-target-changed'};
      }
      if(Number.isSafeInteger(before.activationGeneration)){
        const generation=before.activationGeneration+(current.reloadMethod==='supervisor'?0:1);
        if(selected.activationGeneration<generation){
          activation={state:'pending',reason:'configuration-generation-pending'};
          if(attempt<59)await wait(1000);continue;
        }
        if(selected.activationGeneration!==generation){
          update({reloadState:'selection-changed'});return {state:'unavailable',reason:'activation-target-changed'};
        }
      }
      const expected=runtimeActivationTarget(selected,{key:before.identity});
      activation=await activate(options,{host,expected,required:true,probe,wait,
        read:()=>readState(file,null)?.transition?.runtimeActivation,
        save:record=>update({runtimeActivation:record})});
      if(activation.state!=='pending')break;
      if(attempt<59)await wait(1000);
    }
    update({reloadState:activation.state==='ready'?'applied':'activation-uncertain',
      ...(activation.state==='ready'?{}:{activationReason:activation.reason})});
    return activation;
  } catch {
    const current = readState(file, null)?.transition;
    update(current?.reloadState ? {reloadState:'uncertain'} : {state:'failed',reloadState:'preflight-failed'},true);
  }
}

/** The cold Runtime cannot supply its own retry timer. Its detached QQ worker
 * keeps observing the same durable job; neither configure nor an uncertain
 * restart is ever submitted again. Each observation round is bounded. */
export async function resumeQQReload(configPath,jobId,{wait=delay,reload=reloadQQConnection,rounds=Infinity}={}){
  const options=readState(resolve(configPath),null),lease=new DatabaseSync(join(options.dataDir,'qq-reload.sqlite'));
  try{lease.exec('BEGIN IMMEDIATE');}catch(error){lease.close();if(error.errcode===5||error.code==='SQLITE_BUSY')return;throw error;}
  try{
    for(let round=0;round<rounds;round++){
      const result=await reload(configPath,jobId),job=readState(qqManagementFile(options),null)?.transition;
      if(job?.id!==jobId||!['queued','data-applied','confirmed'].includes(job.state)||
          ['rejected','preflight-failed','selection-changed'].includes(job.reloadState)||
          result?.state==='unavailable'||job.reloadState==='applied')return result;
      if(round<rounds-1)await wait(60000);
    }
  }finally{lease.close();}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await resumeQQReload(process.argv[2],process.argv[3]);
}
