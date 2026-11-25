import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';
import {qqManagementFile} from '../src/qq-transition.mjs';
import {reloadQQConnection,resumeQQReload} from '../src/qq-reload.mjs';
import {ensureRuntimeActivation} from '../src/runtime-activation.mjs';
import {hash} from '../src/routing.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-qq-reload-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'private-chat'};
 const options={instanceId:'qq-reload-fixture',dataDir:root,cwd:root,clawchat:{route,delivery:{connectBin:'/fixture/connect',configPath:join(root,'connect.json')}}};
 const configPath=join(root,'instance.json');writeState(configPath,options);
 const file=qqManagementFile(options),id='verified-qq-transition';
 writeState(file,{schema:1,instanceId:options.instanceId,transition:{id,state:'queued',configPath,instanceId:options.instanceId,actor:route}});
 const installed={status:'active',version:'1.0.0-fixture',integrity:'sha256-fixture',activationGeneration:5};
 let changes=0,restarts=0,unknown=false,completeOnRestart=true;
 const core={installed:()=>installed,binding:()=>({configuration:{runtimeConfig:{instancePath:configPath}},stateDbPath:join(root,'core.db')}),
  state:async()=>({available:true,connected:true,ownerId:route.sender,conversationId:route.conversation,userId:'platform-agent',running:0,queued:0}),
  async change(){changes++;if(unknown)throw Error('configure ACK lost');installed.activationGeneration++;return true;}};
 const complete=()=>{
  const state=readState(file);state.transition.state='confirmed';writeState(file,state);
  writeState(join(root,'runtime.lock'),{instanceId:options.instanceId,hostname:hostname(),pid:process.pid});
 };
 const activate=(instance,ports)=>ensureRuntimeActivation(instance,{...ports,attempts:2,wait:async()=>{},restart:async()=>{
  restarts++;if(completeOnRestart)complete();else throw Error('restart ACK lost');
 }});
 const legacy=()=>{
  const saved=readState(file),{configuration,stateDbPath}=core.binding();
  Object.assign(saved.transition,{reloadState:'uncertain',reloadSelection:{version:installed.version,integrity:installed.integrity,
   activationGeneration:installed.activationGeneration,identity:hash({route,binding:configuration,stateDbPath})}});writeState(file,saved);
 };
 return {options,configPath,file,id,installed,core,activate,complete,
  legacy,incomplete:()=>{completeOnRestart=false;},changes:()=>changes,restarts:()=>restarts};
}

test('QQ reload activates the original native writer even when realtime voice is disabled',async t=>{
 const f=await fixture(t);
 const result=await reloadQQConnection(f.configPath,f.id,{core:f.core,activate:f.activate,wait:async()=>{},
  fetchImpl:async()=>{throw Error('Voice must not be required when disabled');}});
 assert.equal(result.state,'ready');assert.equal(f.changes(),0);assert.equal(f.restarts(),1);
 const job=readState(f.file).transition;assert.equal(job.state,'confirmed');assert.equal(job.reloadState,'applied');
 assert.equal(job.runtimeActivation.target.activationGeneration,5);
});

test('a timed-out configure waits for its committed generation before restarting, without another configure',async t=>{
 const f=await fixture(t);f.legacy();let waits=0;
 const result=await reloadQQConnection(f.configPath,f.id,{core:f.core,activate:f.activate,wait:async()=>{
  waits++;assert.equal(f.restarts(),0);f.installed.activationGeneration=6;
 }});
 assert.equal(result.state,'ready');assert.equal(waits,1);assert.equal(f.changes(),0);assert.equal(f.restarts(),1);
 assert.equal(readState(f.file).transition.runtimeActivation.target.activationGeneration,6);
});

test('the detached QQ worker resumes a cold queued transition after a full observation round',async t=>{
 const f=await fixture(t);f.legacy();let rounds=0;
 const result=await resumeQQReload(f.configPath,f.id,{rounds:2,wait:async ms=>{
  assert.equal(ms,60000);rounds++;f.installed.activationGeneration=6;
 },reload:(path,id)=>reloadQQConnection(path,id,{core:f.core,activate:f.activate,wait:async()=>{}})});
 assert.equal(result.state,'ready');assert.equal(rounds,1);assert.equal(f.changes(),0);assert.equal(f.restarts(),1);
 assert.equal(readState(f.file).transition.reloadState,'applied');
});

test('QQ restart acknowledgement loss is reconciled without repeating configure or restart',async t=>{
 const f=await fixture(t);f.incomplete();
 assert.equal((await reloadQQConnection(f.configPath,f.id,{core:f.core,activate:f.activate,wait:async()=>{}})).state,'uncertain');
 assert.equal(f.changes(),0);assert.equal(f.restarts(),1);assert.equal(readState(f.file).transition.runtimeActivation.ack,'unknown');
 f.complete();
 assert.equal((await reloadQQConnection(f.configPath,f.id,{core:f.core,activate:f.activate,wait:async()=>{}})).state,'ready');
 assert.equal(f.changes(),0);assert.equal(f.restarts(),1);
});
