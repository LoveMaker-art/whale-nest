import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {readState,writeState} from './state.mjs';
import {ensureRuntimeActivation,runtimeActivationHost,runtimeActivationTarget,probeRuntimeReady} from './runtime-activation.mjs';

const fileFor=options=>join(options.dataDir,'binding-reload.json');
const observedFor=options=>join(options.dataDir,'binding-runtime.json');

export function observeBindingRuntime(options,binding){
  if(!binding)return;
  writeState(observedFor(options),{identity:{account:binding.account,agent:binding.agent,owner:binding.owner,
    conversation:binding.conversation},coreEpoch:process.env.WHALENEST_CORE_EPOCH??null});
}

export function requestBindingReload(options,configPath){
  const job=readState(fileFor(options),null);
  if(!job||job.state==='ready')return;
  // A launcher-prepared route was loaded by this new Core already. SDK-side
  // reconciliation instead needs one host restart so cached voice routes agree.
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),configPath],{
    cwd:options.cwd,env:process.env,detached:true,stdio:'ignore'});
  child.unref();
}

export async function reloadBinding(configPath,{host,activate=ensureRuntimeActivation,probe=probeRuntimeReady,wait=delay}={}){
  const options=readState(configPath,null),file=fileFor(options),job=readState(file,null);
  if(!job||job.state==='ready')return {state:'ready',skipped:true};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const update=patch=>{
    const latest=readState(file,null);
    assert.ok(latest?.instanceId===job.instanceId&&same(latest.identity,job.identity),'Binding reload job changed');
    writeState(file,{...latest,...patch});
  };
  const ready=async()=>{
    const observed=readState(observedFor(options),null);
    return !!observed&&same(observed.identity,job.identity)&&observed.coreEpoch!==job.coreEpoch&&await probe(options);
  };
  host??=runtimeActivationHost(options);
  for(let n=0;n<60;n++){
    let identity;
    try{identity=await host.identity();}catch{await wait(1000);continue;}
    if(!identity){await wait(1000);continue;}
    if(identity.accountId&&identity.accountId!==job.identity.agent)return {state:'unavailable',reason:'activation-identity-changed'};
    const expected=job.target??runtimeActivationTarget(host.installed(),identity);
    if(!job.target){job.target=expected;update({target:expected});}
    const result=await activate(options,{host,expected,required:true,probe:ready,
      read:()=>readState(file,null)?.activation,
      save:activation=>update({activation})});
    if(result.state==='pending'){await wait(1000);continue;}
    update({state:result.state});
    return result;
  }
  return {state:'pending',reason:'binding-runtime-unavailable'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await reloadBinding(resolve(process.argv[2]));
}
