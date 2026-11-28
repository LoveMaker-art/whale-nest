import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeState,readState} from '../src/state.mjs';
import {reloadBinding} from '../src/binding-reload.mjs';

test('an unobserved Core preparation remains pending without submitting restarts',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'whalenest-binding-reload-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const identity={account:'dsh',agent:'new',owner:'owner',conversation:'new-dm'};
  const options={instanceId:'reload',dataDir,cwd:dataDir,clawchat:{firstBinding:true,route:{account:'dsh',sender:'owner',conversation:'new-dm'}}};
  const configPath=join(dataDir,'instance.json'),job=join(dataDir,'binding-reload.json');
  writeState(configPath,options);writeState(job,{instanceId:'reload',identity,state:'pending'});
  writeState(join(dataDir,'first-binding.json'),{identity,platformInstanceId:'new'});
  const host={identity:async()=>({accountId:'new',idle:true})};
  const result=await reloadBinding(configPath,{host,probe:async()=>false,wait:async()=>{},activate:()=>assert.fail('No first-binding restart')});
  assert.equal(result.state,'pending');assert.equal(readState(job).state,'pending');
});
