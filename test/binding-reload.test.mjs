import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeState,readState} from '../src/state.mjs';
import {reloadBinding} from '../src/binding-reload.mjs';

test('a cached old Core route needs one restart; a lost restart acknowledgement is never resubmitted',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'whalenest-binding-reload-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const options={instanceId:'reload',dataDir,cwd:dataDir},configPath=join(dataDir,'instance.json');
  const identity={account:'dsh',agent:'new',owner:'owner',conversation:'new-dm'};
  const observed=join(dataDir,'binding-runtime.json'),job=join(dataDir,'binding-reload.json');
  writeState(configPath,options);writeState(job,{schema:1,instanceId:'reload',identity,coreEpoch:'old',state:'pending'});
  writeState(observed,{identity,coreEpoch:'old'});
  const host={installed:()=>({status:'active',version:'test',integrity:'digest',activationGeneration:1}),
    identity:async()=>({key:'identity',idle:true})};
  let restarts=0;
  const {ensureRuntimeActivation}=await import('../src/runtime-activation.mjs');
  const activate=(options,settings)=>ensureRuntimeActivation(options,{...settings,attempts:1,
    restart:async()=>{restarts++;throw Error('ack lost');}});
  const dependencies={host,activate,probe:async()=>true,wait:async()=>{}};
  assert.equal((await reloadBinding(configPath,dependencies)).state,'uncertain');
  assert.equal((await reloadBinding(configPath,dependencies)).state,'uncertain');assert.equal(restarts,1);
  writeState(observed,{identity,coreEpoch:'new'});
  assert.equal((await reloadBinding(configPath,dependencies)).state,'ready');
  assert.equal(readState(job).state,'ready');assert.equal(restarts,1);
});
