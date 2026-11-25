import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createConnectorCutover} from '../src/connector-cutover.mjs';

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'whalenest-connector-cutover-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'.clawnest-integrations/deepseek-harness'),sha='a'.repeat(64),targetId='0.2.22-'+sha,fromId='0.2.20-'+'b'.repeat(64);
  const baseDirectory=join(root,'releases',targetId);mkdirSync(baseDirectory,{recursive:true});
  const manifest={runtime:'deepseek-harness',plugin:'clawchat-connect',version:'0.2.22',state_schema:'state1'};
  writeFileSync(join(baseDirectory,'integration.json'),JSON.stringify(manifest));
  writeFileSync(join(baseDirectory,'receipt.json'),JSON.stringify({sha256:sha,manifest_sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}));
  writeFileSync(join(baseDirectory,'source.json'),JSON.stringify({connect_commit:'fixed-source'}));
  const stateFile=join(root,'state.json');
  const state={selected:fromId,installed:{[fromId]:{version:'0.2.20',state_schema:'state1',rollback_compatible:true},[targetId]:{version:'0.2.22',sha256:sha,state_schema:'state1'}},job:{id:'historical',status:'pending_start'}};
  writeFileSync(stateFile,JSON.stringify(state));
  let status={selected:{id:fromId},previous:null,running:null,job:state.job};
  const calls=[];let fault,online=false;
  const cutover=createConnectorCutover({home,cwd:home,executable:process.execPath,run(_bin,args,options){
    assert.equal(options.cwd,home);calls.push(args);
    assert.equal(args[0],'plugin');const action=args[1];
    if(action==='status')return JSON.stringify({...status,...(online?{running:{id:status.selected.id,health:{version:'0.2.22',identity:'agent',ready:true,connected:true,draining:false}}}:{})});
    if(fault==='catalog')throw Error('signed catalog unavailable');
    if(action==='upgrade') {
      status={selected:{id:targetId},previous:{id:fromId},running:null,job:fault==='selection-window'?status.job:{id:'this-upgrade',target:targetId,status:'pending_start'}};
      if(fault==='selection-window')throw Error('process stopped between selection and receipt');
    }
    else if(action==='rollback')status={selected:{id:fromId},previous:{id:targetId},running:null,job:{id:'rollback',target:fromId,status:'pending_start'}};
    else throw Error('Unexpected command');
    if(fault==='reply-lost')throw Error('result pipe interrupted');
    return JSON.stringify(status.job);
  }});
  return {home,root,baseDirectory,stateFile,state,fromId,targetId,calls,cutover,
    status:value=>{status=value;},fault:value=>{fault=value;},online:value=>{online=value;}};
}

test('paired connector selection is offline, exact, recoverable and preserves forward data',t=>{
  const f=fixture(t),plan=f.cutover.inspect(f.baseDirectory),data=join(f.home,'new-messages.json');writeFileSync(data,'new data');
  const selected=f.cutover.select(plan);assert.equal(selected.changed,true);
  f.online(true);assert.equal(f.cutover.verify(plan,'agent').ready,true);f.online(false);
  assert.equal(f.cutover.rollback(plan,selected).selectedId,f.fromId);
  assert.equal(readFileSync(data,'utf8'),'new data');
  assert.deepEqual(f.calls.filter(args=>args[1]!=='status'),[['plugin','upgrade','--version','0.2.22','--defer'],['plugin','rollback','--defer']]);
});

test('catalog failure leaves the original official release selected and never retries',t=>{
  const f=fixture(t),plan=f.cutover.inspect(f.baseDirectory);f.fault('catalog');
  assert.throws(()=>f.cutover.select(plan),/catalog unavailable/);
  assert.equal(f.cutover.rollback(plan).changed,false);
  assert.equal(f.calls.filter(args=>args[1]==='upgrade').length,1);
});

test('lost selection and rollback acknowledgements are reconciled without resubmission',t=>{
  const f=fixture(t),plan=f.cutover.inspect(f.baseDirectory);f.fault('reply-lost');
  const selected=f.cutover.select(plan);assert.equal(selected.recoveredAcknowledgement,true);
  assert.equal(f.cutover.rollback(plan,selected).recoveredAcknowledgement,true);
  assert.equal(f.calls.filter(args=>args[1]==='upgrade').length,1);assert.equal(f.calls.filter(args=>args[1]==='rollback').length,1);
});

test('online selection and unrelated rollback are refused before any change',t=>{
  const f=fixture(t),plan=f.cutover.inspect(f.baseDirectory);f.online(true);
  assert.throws(()=>f.cutover.select(plan),/Stop the official/);f.online(false);
  f.status({selected:{id:'external-release'},previous:{id:f.fromId},running:null});
  assert.throws(()=>f.cutover.rollback(plan),/different official release/);
  assert.equal(f.calls.filter(args=>args[1]!=='status').length,0);
});

test('interruption between official selection and job receipt can restore the paired build',t=>{
  const f=fixture(t),plan=f.cutover.inspect(f.baseDirectory);f.fault('selection-window');
  const selection=f.cutover.select(plan);assert.equal(selection.selectionIncomplete,true);
  assert.equal(f.cutover.rollback(plan,selection).selectedId,f.fromId);
  assert.equal(f.calls.filter(args=>args[1]==='upgrade').length,1);
});

test('candidate needs its official staging receipt and compatible previous release',t=>{
  const f=fixture(t);f.state.installed[f.fromId].rollback_compatible=false;writeFileSync(f.stateFile,JSON.stringify(f.state));
  assert.throws(()=>f.cutover.inspect(f.baseDirectory),/cannot restore/);
  f.state.installed[f.fromId].rollback_compatible=true;writeFileSync(f.stateFile,JSON.stringify(f.state));
  writeFileSync(join(f.baseDirectory,'integration.json'),'{}');assert.throws(()=>f.cutover.inspect(f.baseDirectory),/manifest changed/);
});
