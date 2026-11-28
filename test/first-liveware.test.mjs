import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';
import {publishFirstLiveware as publish} from '../src/first-liveware.mjs';
async function publishFirstLiveware(options,kind,port,signal,dependencies){
 if(dependencies?.platform?.receipt&&!dependencies.commands.readReceipt)dependencies.commands.readReceipt=async(name,id)=>{const r=dependencies.platform.receipt({},name,id);return {...r,status:r?.status??r?.state??'not_found'};};
 return publish(options,kind,port,signal,dependencies);
}

function fixture(t){
  const dataDir=mkdtempSync(join(tmpdir(),'whalenest-song-init-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const route={channel:'clawchat',kind:'private',account:'agent',sender:'owner',conversation:'dm-new'};
  const identity={account:'agent',agent:'new-agent',owner:'owner',conversation:'dm-new'};
  const options={instanceId:'instance',dataDir,owners:[route],clawchat:{firstBinding:true,route}};
  writeState(join(dataDir,'first-binding.json'),{id:'new-binding',identity});
  return {options,path:join(dataDir,'song-liveware.json'),identity};
}
const app={appId:'app-new',name:'鲸栖歌曲',publicUrl:'https://app-new.apps.clawling.io/'};
const bound={appId:app.appId,publicUrl:app.publicUrl,registeredInClawChat:true};

test('a copied song link cannot suppress the new account app; an existing owned app is reused',async t=>{
  const f=fixture(t);let creates=0,binds=0,lists=0;
  writeState(f.path,{binding:'agent',owner:'owner',url:'https://app-source.apps.clawling.io/'});
  const deps={platform:{verify(){},receipt(){assert.fail('No pending request');}},commands:{
    async listApps(){lists++;return [];},
    async createApp(){creates++;return app;},async bindTunnel(){binds++;return bound;},
  }};
  await publishFirstLiveware(f.options,'song',8898,undefined,deps);
  await publishFirstLiveware(f.options,'song',8898,undefined,deps);
  assert.equal(creates,1);assert.equal(binds,1);assert.equal(lists,1);
  assert.equal(readState(f.path).agent,'new-agent');
  // A separate legacy record has no appId; ownership is checked before adoption.
  const g=fixture(t);writeState(g.path,{url:app.publicUrl});
  await publishFirstLiveware(g.options,'song',8898,undefined,{...deps,commands:{
    listApps:async()=>[app],createApp:()=>assert.fail('Reuse existing app'),bindTunnel:()=>assert.fail('Reuse tunnel'),
  }});
  assert.equal(readState(g.path).appId,app.appId);
});

test('a lost song create acknowledgement is reconciled without a second create',async t=>{
  const f=fixture(t);let calls=0,receipt;
  const deps={platform:{verify(){},receipt(_binding,name){assert.equal(name,'liveware_app_create');return receipt;}},commands:{
    async createApp(){calls++;throw Error('timeout after submit');},async bindTunnel(){return bound;},
  }};
  await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/timeout/);
  await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/original Core receipt/);
  assert.equal(calls,1);
  receipt={state:'succeeded',result:app};
  await publishFirstLiveware(f.options,'song',8898,undefined,deps);
  assert.equal(calls,1);assert.equal(readState(f.path).url,app.publicUrl);
});

test('only an expired request proven never executed permits a bounded new submission with old IDs retained',async t=>{
 const f=fixture(t);let creates=0,receipt;
 const deps={platform:{verify(){},receipt(){return receipt;}},commands:{
  async createApp(){creates++;if(creates===1)throw Error('initial timeout');return app;},async bindTunnel(){return bound;},
 }};
 await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/initial timeout/);
 const original=readState(f.path).operations.create.requestId;
 for(const state of ['pending','indeterminate','failed','expired']){
  receipt={state};await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/original Core receipt/);
 }
 assert.equal(creates,1);
 receipt={state:'expired',unexecuted:true};await publishFirstLiveware(f.options,'song',8898,undefined,deps);
 assert.equal(creates,2);const operation=readState(f.path).operations.create;
 assert.notEqual(operation.requestId,original);assert.deepEqual(operation.attempts,[{requestId:original,state:'expired',unexecuted:true}]);
 await publishFirstLiveware(f.options,'song',8898,undefined,deps);assert.equal(creates,2);
});

test('an executed unknown create adopts one verified owned resource and retains its unknown original receipt',async t=>{
 const f=fixture(t);let creates=0,binds=0,ambiguous=false,wrong=false;
 const deps={platform:{verify(){},receipt(){return {state:'indeterminate'};}},commands:{
  async createApp(){creates++;throw Error('interrupted after claim');},
  async listApps(){return ambiguous?[app,{...app,appId:'app-other',publicUrl:'https://app-other.apps.clawling.io/'}]:[app];},
  async inspectApp(){return wrong?{...app,appId:'app-wrong'}:app;},
  async bindTunnel(){binds++;if(binds===1)throw Error('bind interrupted before ACK');return bound;},
 }};
 await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/interrupted after claim/);
 ambiguous=true;await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/uniquely owned/);
 ambiguous=false;wrong=true;await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps));wrong=false;
 await assert.rejects(publishFirstLiveware(f.options,'song',8898,undefined,deps),/bind interrupted/);
 let state=readState(f.path);assert.equal(state.operations.create.state,'pending');assert.equal(state.adoption.originalState,'indeterminate');
 deps.platform.receipt=(_identity,name)=>name==='liveware_tunnel_bind'?{state:'succeeded',result:bound}:{state:'indeterminate'};
 await publishFirstLiveware(f.options,'song',8898,undefined,deps);
 state=readState(f.path);assert.equal(creates,1);assert.equal(binds,1);assert.equal(state.operations.create.state,'pending');assert.equal(state.url,app.publicUrl);
});
