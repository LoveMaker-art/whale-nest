import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {clawchatBindingState,readBoundClawChatAgentId,readClawChatPlatformState} from '../src/clawchat-state.mjs';
import {installedPlugin} from '../src/platform-client.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'whalenest-public-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const configPath=join(root,'unreadable-as-json');writeFileSync(configPath,'THIS IS NOT A PRIVATE CONFIG');
 const config={defaultAgent:'dsh',agents:{dsh:{runtime:{pluginId:'whalenest.runtime.deepseek-harness'}}}};
 let state={userId:'agent',ownerId:'owner',conversationId:'dm',connected:true,available:true};
 const options={dataDir:root,clawchat:{route:{account:'dsh',sender:'owner',conversation:'dm'},delivery:{connectBin:'/public/cli',configPath}}};
 const calls=[],run=(bin,args,settings)=>{calls.push(args);assert.equal(settings.env.WHALENEST_SOURCE_INSTANCE,'');return JSON.stringify(args[0]==='config'?config:state);};
 return {config,options,run,calls,set:value=>{state=value;},adapter:()=>clawchatBindingState(configPath,'dsh',{options,run})};
}
test('first binding uses public configuration and identity without opening connector files',t=>{
 const f=fixture(t),p=f.adapter();assert.deepEqual(p.current(),{agent:'agent',owner:'owner',conversation:'dm',at:0});assert.equal(p.ready(p.current()),true);assert.ok(f.calls.every(args=>['config','__clawnest-state'].includes(args[0])));
});
test('public readiness and exact identity block stale, disconnected and foreign bindings',t=>{
 const f=fixture(t),p=f.adapter(),identity=p.current();f.set({userId:'agent',ownerId:'owner',conversationId:'dm',connected:false,available:true});assert.equal(p.ready(identity),false);
 f.set({userId:'other',ownerId:'owner',conversationId:'dm',connected:true,available:true});assert.throws(()=>p.verify(identity),/identity changed/);
 f.set({});assert.equal(p.current(),null);assert.throws(()=>p.verify(identity),/identity changed/);
});
test('bound agent lookup accepts only its original owner and conversation through the public command',async()=>{
 const clawchat={route:{account:'dsh',sender:'owner',conversation:'dm'},delivery:{configPath:'/public/config',connectBin:'/public/cli'}};
 assert.equal(await readBoundClawChatAgentId(clawchat,{readPlatformState:async()=>({userId:'agent',ownerId:'owner',conversationId:'dm'})}),'agent');
 assert.equal(await readBoundClawChatAgentId(clawchat,{readPlatformState:async()=>({userId:'agent',ownerId:'other',conversationId:'dm'})}),null);
});
test('public plugin records provide status and provenance without relying on installation layout',t=>{
 const f=fixture(t),row={pluginId:'whalenest.runtime.deepseek-harness',version:'1.2.3',status:'active',source:{type:'github',repository:'owner/repo',release:'v1.2.3'},target:'linux-x64',integrity:'sha256-test'};
 const run=(_node,args,settings)=>{assert.ok(args[0].endsWith('/platform-query.mjs'));assert.equal(args[1],f.options.clawchat.delivery.configPath);assert.equal(settings.env.WHALENEST_SOURCE_INSTANCE,'');return JSON.stringify([row]);};
 assert.deepEqual(installedPlugin(f.options,undefined,{run}),row);
 assert.throws(()=>installedPlugin(f.options,undefined,{run:()=>JSON.stringify([{...row,integrity:undefined}])}),/Incomplete/);
 assert.throws(()=>installedPlugin(f.options,undefined,{run:()=>JSON.stringify([row,row])}),/Conflicting/);
});

test('async public status calls do not reload development plugins inside the platform CLI',async()=>{
 const before=process.env.WHALENEST_SOURCE_INSTANCE;process.env.WHALENEST_SOURCE_INSTANCE='/own/instance.json';
 try{
  const state=await readClawChatPlatformState({connectBin:'/public/cli',configPath:'/public/config'},{run:async(_bin,args,settings)=>{
   assert.equal(settings.env.WHALENEST_SOURCE_INSTANCE,'');assert.equal(settings.env.CLAWCHAT_CONNECT_CONFIG,'/public/config');assert.equal(args[0],'__clawnest-state');
   return {stdout:JSON.stringify({connected:true})};
  }});assert.equal(state.connected,true);assert.equal(process.env.WHALENEST_SOURCE_INSTANCE,'/own/instance.json');
 }finally{if(before===undefined)delete process.env.WHALENEST_SOURCE_INSTANCE;else process.env.WHALENEST_SOURCE_INSTANCE=before;}
});
