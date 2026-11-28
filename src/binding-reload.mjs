import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startupStatus} from './startup-state.mjs';
import {readState,writeState} from './state.mjs';
import {runtimeActivationHost,probeRuntimeLease} from './runtime-activation.mjs';

const fileFor=options=>join(options.dataDir,'binding-reload.json');
const observedFor=options=>join(options.dataDir,'binding-runtime.json');

export function observeBindingRuntime(options,binding){
  if(!binding)return;
  writeState(observedFor(options),{identity:{account:binding.account,agent:binding.agent,owner:binding.owner,
    conversation:binding.conversation},coreEpoch:process.env.WHALENEST_CORE_EPOCH??null,pid:process.pid});
}

export function requestBindingReload(options,configPath){
  const job=readState(fileFor(options),null);
  if(!job||job.state==='ready')return;
  // Observe preparation only. Voice captures its route after SDK preparation;
  // temporary unavailability must never restart an executing Core tool.
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),configPath],{
    cwd:options.cwd,env:process.env,detached:true,stdio:'ignore'});
  child.unref();
}

export async function reloadBinding(configPath,{host,probe=probeRuntimeLease,wait=delay}={}){
  const options=readState(configPath,null),file=fileFor(options),job=readState(file,null);
  if(!job||job.state==='ready')return {state:'ready',skipped:true};
  host??=runtimeActivationHost(options);
  for(let n=0;n<60;n++){
    const latest=readState(file,null);
    assert.ok(latest?.instanceId===job.instanceId&&JSON.stringify(latest.identity)===JSON.stringify(job.identity),'Binding reload job changed');
    if(startupStatus(options).baseReady&&await probe(options)){
      const identity=await host.identity().catch(()=>null);
      if(identity?.accountId&&identity.accountId!==job.identity.agent)return {state:'unavailable',reason:'activation-identity-changed'};
      if(identity){
        writeState(file,{...latest,state:'ready',resolution:'prepared-without-restart'});
        return {state:'ready',restarted:false};
      }
    }
    await wait(1000);
  }
  return {state:'pending',reason:'binding-preparation-pending'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await reloadBinding(resolve(process.argv[2]));
}
