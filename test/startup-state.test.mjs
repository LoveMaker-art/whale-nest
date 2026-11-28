import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';
import {startupStatus} from '../src/startup-state.mjs';
import {reloadBinding} from '../src/binding-reload.mjs';
export function fixture(t){
  const dataDir=mkdtempSync(join(tmpdir(),'whalenest-startup-'));
  const old=process.env.CLAWNEST_INSTANCE_ID;process.env.CLAWNEST_INSTANCE_ID='new-instance';
  t.after(()=>{rmSync(dataDir,{recursive:true,force:true});if(old===undefined)delete process.env.CLAWNEST_INSTANCE_ID;else process.env.CLAWNEST_INSTANCE_ID=old;});
  const identity={account:'dsh',agent:'new-agent',owner:'owner',conversation:'new-dm'};
  const options={instanceId:'test',dataDir,cwd:dataDir,realtime:{enabled:true},singing:{playback:{enabled:true}},
    clawchat:{firstBinding:true,route:{account:'dsh',sender:'owner',conversation:'new-dm'}}};
  const put=(name,value)=>writeState(join(dataDir,name+'.json'),value);
  put('first-binding',{identity,platformInstanceId:'new-instance',avatar:{state:'pending'}});
  put('binding-core',{instanceId:'test',coreEpoch:'new',platformInstanceId:'new-instance',state:'prepared',identity,pid:process.pid});
  put('binding-runtime',{coreEpoch:'new',identity,pid:process.pid});
  return {options,identity,put};
}
test('new identity and both current processes precede avatar, apps, QQ and background',t=>{
 const {options,identity,put}=fixture(t);
 assert.equal(startupStatus(options).baseReady,true);assert.equal(startupStatus(options).appsAllowed,false);
 put('binding-runtime',{identity,coreEpoch:'copied',pid:process.pid});assert.equal(startupStatus(options).baseReady,false);
 put('binding-runtime',{identity,coreEpoch:'new',pid:99999999});assert.equal(startupStatus(options).baseReady,false);
 put('binding-runtime',{identity,coreEpoch:'new',pid:process.pid});
 put('first-binding',{identity,platformInstanceId:'new-instance',avatar:{state:'confirmed'}});
 assert.equal(startupStatus(options).appsAllowed,true);assert.equal(startupStatus(options).qqAllowed,false);
 put('managed-liveware',{legacy:{url:'stable'},publication:{url:'managed'}});
 put('song-liveware',{startupPass:{coreEpoch:'new',state:'deferred'},operations:{create:{state:'pending'}}});
 assert.equal(startupStatus(options).qqAllowed,true);assert.equal(startupStatus(options).backgroundAllowed,true);
 assert.equal(readState(join(options.dataDir,'song-liveware.json')).operations.create.state,'pending');
 process.env.CLAWNEST_INSTANCE_ID='copied-instance';assert.equal(startupStatus(options).baseReady,false);
});
test('voice warmup or absent Core observation never triggers a binding restart',async t=>{
 const {options,identity,put}=fixture(t);put('instance',options);put('binding-reload',{instanceId:'test',identity,state:'pending',coreEpoch:null});
 let restarts=0;
 const deps={host:{identity:async()=>({accountId:'new-agent'})},probe:async()=>true,wait:async()=>{},activate:()=>{restarts++;throw Error('must not restart');}};
 assert.equal((await reloadBinding(join(options.dataDir,'instance.json'),deps)).state,'ready');
 assert.equal(restarts,0);
 put('binding-reload',{instanceId:'test',identity,state:'pending'});put('binding-core',{state:'starting',coreEpoch:'next'});
 assert.equal((await reloadBinding(join(options.dataDir,'instance.json'),deps)).state,'pending');assert.equal(restarts,0);
});

test('the voice bridge captures verified identity after SDK preparation without an official Session hook',async t=>{
 const {options,put}=fixture(t);
 const {createServer}=await import('node:net');
 const {mkdirSync,readFileSync}=await import('node:fs');
 const {extendRuntimeEntry}=await import('../src/runtime-extension.mjs');
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const epoch=process.env.WHALENEST_CORE_EPOCH;process.env.WHALENEST_CORE_EPOCH='new';
 t.after(()=>{if(epoch===undefined)delete process.env.WHALENEST_CORE_EPOCH;else process.env.WHALENEST_CORE_EPOCH=epoch;});
 options.realtime={enabled:true,sessionEnabled:true,mode:'independent',bridgePort:port};options.speech={};
 const config=join(options.dataDir,'companion/aurabot-v1/instance.json');mkdirSync(join(options.dataDir,'companion/aurabot-v1'),{recursive:true});
 writeState(config,{...options,clawchat:{...options.clawchat,route:{...options.clawchat.route,conversation:'copied-source-chat'}}});
 let provider,preparedFor;
 const base={activate(ctx){ctx.hostCapabilities.get('runtime-provider').register({create(){return {
  prepare:async()=>writeState(config,options),listModels:()=>[],close:async()=>{},
  withCallSession:async(target,_signal,run)=>{preparedFor=target;await run({prepareVoice:async()=> 'native-thread'},{sessionRef:'independent-thread'});},
 };}});}};
 await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:p=>provider=p})}});
 const adapter=provider.create({homePath:options.dataDir});
 t.after(()=>adapter.close());
 assert.equal(readState(join(options.dataDir,'binding-core.json')).coreEpoch,'new');
 await adapter.prepare();
 const secret=readFileSync(join(options.dataDir,'realtime/session-secret'),'utf8');
 const url='http://127.0.0.1:'+port+'/voice/v1/calls/vs_'+'a'.repeat(32);
 const response=await fetch(url+'/prepare',{method:'POST',headers:{'x-voice-secret':secret},body:'{}'});
 assert.equal(response.status,200);assert.deepEqual(preparedFor,{chatId:'new-dm',ownerId:'owner'});
 await fetch(url+'/close',{method:'POST',headers:{'x-voice-secret':secret},body:'{}'});
});

test('a healthy QQ survives a Core-only restart but copied identity or stale readiness cannot release background work',t=>{
 const {options,identity,put}=fixture(t);
 put('first-binding',{identity,platformInstanceId:'new-instance',avatar:{state:'confirmed'}});
 put('managed-liveware',{legacy:{url:'stable'},publication:{url:'managed'}});put('song-liveware',{url:'song'});
 const gateway=join(options.dataDir,'qq');options.qq={gateway:{loginQrFile:join(gateway,'login/qr.json')}};
 const file=join(gateway,'managed-status.json');
 writeState(file,{ready:true,coreEpoch:'previous',platformInstanceId:'new-instance',identity,at:Date.now()});
 assert.equal(startupStatus(options).backgroundAllowed,true);
 writeState(file,{ready:true,platformInstanceId:'source-instance',identity,at:Date.now()});assert.equal(startupStatus(options).backgroundAllowed,false);
 writeState(file,{ready:true,platformInstanceId:'new-instance',identity,at:Date.now()-30000});assert.equal(startupStatus(options).backgroundAllowed,false);
});
