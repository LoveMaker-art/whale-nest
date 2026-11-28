import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {platformConfig,platformState} from './platform-client.mjs';
const exec=promisify(execFile);

export async function readClawChatPlatformState({connectBin,configPath}, {run=exec}={}) {
  assert.ok(typeof connectBin === 'string' && isAbsolute(connectBin),
    'An absolute configured Connect executable is required');
  assert.ok(typeof configPath === 'string' && isAbsolute(configPath),
    'An absolute Connect configuration is required');
  const {stdout}=await run(connectBin,['__clawnest-state','--config',configPath],{
    encoding:'utf8',timeout:8000,maxBuffer:1024*1024,
    // The official platform entry reads this variable rather than --config.
    env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath},
  });
  const state=JSON.parse(stdout);
  assert.ok(state && typeof state === 'object' && !Array.isArray(state),'Invalid public Connect state');
  return state;
}


/** Identity and readiness come exclusively from public Connect commands. */
export function clawchatBindingState(configPath,selectedAccount,dependencies={}){
 const options=dependencies.options??{clawchat:{delivery:{connectBin:dependencies.connectBin??'/usr/local/bin/clawchat-connect',configPath}}};
 const config=platformConfig(options,dependencies),account=selectedAccount??config.defaultAgent;
 assert.ok(account&&Object.hasOwn(config.agents??{},account),'First binding needs an unambiguous Connect agent');
 const current=()=>{
  const state=platformState(options,dependencies);
  // The native status command currently exposes the image's dsh binding.
  assert.ok(account===config.defaultAgent||account==='dsh','Public platform status does not select this binding');
  if(!state.userId||!state.ownerId||!state.conversationId)return null;
  return {agent:state.userId,owner:state.ownerId,conversation:state.conversationId,at:state.updatedAt??0};
 };
 const verify=binding=>{const row=current();assert.ok(row&&['agent','owner','conversation'].every(k=>row[k]===binding[k]),'Connect identity changed during first binding');return row;};
 return {account,current,verify,ready:binding=>{verify(binding);const state=platformState(options,dependencies);return state.connected===true&&state.available===true;}};
}

export async function readBoundClawChatAgentId(clawchat,{readPlatformState=readClawChatPlatformState}={}){
 const {delivery,route}=clawchat;if(!route||!delivery?.configPath)return null;
 try{const state=await readPlatformState(delivery);return state.userId&&state.ownerId===route.sender&&state.conversationId===route.conversation?state.userId:null;}catch{return null;}
}
