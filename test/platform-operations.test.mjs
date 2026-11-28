import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {platformOperations,readPlatformOperation,classifyPlatformReceipt} from '../src/platform-operations.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'whalenest-platform-ops-'));t.after(()=>rm(root,{recursive:true,force:true}));const route={channel:'clawchat',kind:'private',account:'dsh',sender:'owner',conversation:'dm'},options={instanceId:'test',dataDir:root,cwd:root,owners:[route],clawchat:{route,delivery:{connectBin:'/fake/cli',configPath:'/fake/config'}}};return {root,options};}
test('durable platform results retain failure and denial, and restart never submits an existing operation',async t=>{
 const f=await fixture(t);let calls=0,status='failed';
 const run=async(_bin,args)=>({stdout:JSON.stringify(args[0]==='__clawnest-state'?{ownerId:'owner',conversationId:'dm',connected:true}:{requestId:args[args.indexOf('--request-id')+1],status:(calls++,status),error:'definite validation rejection'})});
 for(const outcome of ['failed','denied','expired']){
  status=outcome;const ops=platformOperations(f.options,{run}),id='operation-'+outcome;
  assert.equal((await ops.submit('clawchat_create_moment',id,{text:'operations test'})).status,outcome);
  assert.equal((await platformOperations(f.options,{run}).submit('clawchat_create_moment',id,{text:'operations test'})).status,outcome);
 }
 assert.equal(calls,3);await assert.rejects(platformOperations(f.options,{run}).submit('clawchat_create_moment','operation-failed',{text:'different'}),/parameters changed/);
});
test('wait cancellation retains a later real result; identity changes refuse writes',async t=>{
 const f=await fixture(t),gate=Promise.withResolvers();let calls=0;
 const run=async(_bin,args)=>{if(args[0]==='__clawnest-state')return {stdout:JSON.stringify({ownerId:'owner',conversationId:'dm',connected:true})};calls++;await gate.promise;return {stdout:JSON.stringify({status:'succeeded',result:{moment:{id:1,text:'test'}}})};};
 const ops=platformOperations(f.options,{run}),abort=new AbortController(),pending=ops.submit('clawchat_create_moment','cancelled-wait',{text:'test'},{signal:abort.signal});
 await new Promise(r=>setTimeout(r,40));abort.abort();assert.equal((await pending).pending,true);gate.resolve();
 for(let i=0;i<30&&ops.inspect('clawchat_create_moment','cancelled-wait').pending;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(ops.inspect('clawchat_create_moment','cancelled-wait').status,'succeeded');assert.equal(calls,1);
 const wrong=platformOperations(f.options,{run:async()=>({stdout:JSON.stringify({ownerId:'other',conversationId:'dm',connected:true})})});assert.equal((await wrong.submit('clawchat_create_moment','wrong-owner',{text:'test'})).status,'failed');
});
test('transport-shaped failures remain unknown and cannot authorize a retry',()=>{
 assert.equal(classifyPlatformReceipt({status:'failed',error:'network timeout after submission'}).status,'indeterminate');assert.equal(classifyPlatformReceipt({status:'failed',error:'file does not exist'}).status,'failed');assert.equal(classifyPlatformReceipt({status:'denied',error:'owner denied'}).status,'denied');
});
