import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';
import {publishFirstLiveware} from '../src/first-liveware.mjs';

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
