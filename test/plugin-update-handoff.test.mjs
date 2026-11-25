import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executePluginUpdate,updateFiles,updateProgress} from '../src/plugin-update-worker.mjs';
import {plannedUpdateStepId} from '../src/plugin-update-orchestrator.mjs';
import {hash} from '../src/routing.mjs';
import {readState,writeState} from '../src/state.mjs';

const repository='handoff-fixture/releases';
const current='1.0.0-beta.4.dev.20';
const route={channel:'clawchat',kind:'private',account:'dsh',conversation:'owner-private',sender:'owner'};
const integrityFor=version=>'sha256-'+Buffer.from(hash(version),'hex').toString('base64');
const releaseFor=version=>({repository,tag:'v'+version,version,sha256:hash(['bundle',version]),
  compatibility:{dataSchema:1},notes:'',updateProtocol:1});

async function fixture(t,{length=2,finalPrerequisites}={}) {
  const directory=await mkdtemp(join(tmpdir(),'whalenest-handoff-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const options={instanceId:'handoff-instance',cwd:directory,dataDir:directory,owners:[route],
    clawchat:{route:structuredClone(route),delivery:{connectBin:'/bin/false',configPath:join(directory,'connect.json')}},
    pluginUpdates:{repository,channel:'beta'}};
  const steps=Array.from({length},(_,index)=>releaseFor('1.0.0-beta.4.dev.'+(21+index)));
  const final=steps.at(-1);
  final.updatePath={schema:1,steps:steps.slice(0,-1).map(({version,sha256})=>({version,sha256}))};
  if(finalPrerequisites)final.prerequisites=finalPrerequisites;
  const plan={schema:1,steps};
  const request={id:hash([directory,final.sha256]),instanceId:options.instanceId,route:structuredClone(route),
    confirmedAt:Date.now(),release:final,plan,planDigest:hash(plan)};
  writeState(updateFiles(options).request,request);
  const initial={status:'active',version:current,target:'linux-x64',source:{type:'local'},
    integrity:integrityFor(current),activationGeneration:1,activeArtifact:join(directory,current,'linux-x64.mjs')};
  const calls=[],notices=[],activations=[];
  const state={installed:initial,identityKey:'original-binding-config',accountId:'same-agent',active:true,idle:true,
    workerVersion:current,beforeChange:null};
  const entries=new Map([[current,initial]]),failures=new Map();
  const content=join(directory,'conversation.json');
  await writeFile(content,'existing conversation');
  function commit(release) {
    const previous=state.installed;
    state.installed={status:'active',version:release.version,target:'linux-x64',
      source:{type:'github',repository,release:release.tag},integrity:integrityFor(release.version),
      activationGeneration:(previous.activationGeneration??0)+1,
      activeArtifact:join(directory,release.version,'linux-x64.mjs'),
      retainedVersions:[previous,...(previous.retainedVersions??[])]};
    entries.set(release.version,state.installed);
  }
  const host={
    installed:()=>state.installed,
    identity:async()=>state.active?{key:state.identityKey,idle:state.idle,accountId:state.accountId}:null,
    versions:async()=>({dataSchema:1}),
    async change(action,body) {
      calls.push({action,body:structuredClone(body),worker:state.workerVersion});
      await state.beforeChange?.(action,body);
      if(action==='select') {
        const previous=entries.get(body.version);
        assert.equal(previous?.integrity,body.integrity,'Rollback must name the exact recorded installation');
        state.installed=previous;state.active=true;
        return true;
      }
      const selected=steps.find(step=>body.source==='github:'+repository+'@'+step.tag);
      assert.ok(selected,'Only a pinned step may be installed');
      const failure=failures.get(selected.version);
      if(failure==='rejected')return false;
      if(failure==='unknown-before-commit')throw Error('Management response lost before selection is visible');
      commit(selected);
      if(failure==='unknown-after-commit')throw Error('Management response lost after selection');
      if(failure==='unhealthy') {
        state.active=false;
        await writeFile(content,'existing conversation and forward data');
      }
      return true;
    },
  };
  const discover=async(_config,_installed,{tag}={})=>{
    const selected=tag?steps.find(step=>step.tag===tag):final;
    assert.ok(selected,'No release outside the confirmed path may be fetched');
    return structuredClone(selected);
  };
  const dependencies={host,discover,wait:async()=>{},
    activate:async(_options,args)=>{activations.push(args.expected);return {state:'ready'};},
    isCurrentWorker:installed=>installed?.version===state.workerVersion,
    delivery:{async sendText(intent){notices.push(structuredClone(intent));return {messageId:'result-'+notices.length};}}};
  const progress=()=>readState(updateProgress(options,request.id),null);
  const child=index=>readState(updateProgress(options,plannedUpdateStepId(request.id,index,steps[index])),null);
  const run=async(extra={})=>{
    const result=await executePluginUpdate(options,request.id,{...dependencies,...extra});
    return result??progress();
  };
  return {directory,options,steps,final,request,state,initial,entries,failures,calls,notices,activations,content,
    host,dependencies,run,progress,child,commit};
}

test('a confirmed two-step job hands off to the installed worker and completes only at its final target',async t=>{
  const f=await fixture(t);
  const first=await f.run();
  assert.equal(first.phase,'handoff-pending');
  assert.equal(first.cursor,0);
  assert.equal(f.child(0).phase,'completed');
  assert.equal(f.state.installed.version,f.steps[0].version);
  assert.deepEqual(f.calls.map(call=>call.body.source),['github:'+repository+'@'+f.steps[0].tag]);
  assert.equal(f.notices.length,0,'Installing the bridge is not final completion');
  assert.equal((await f.run()).phase,'handoff-pending');
  assert.equal(f.calls.length,1,'The old worker cannot start the final step');
  f.state.workerVersion=f.steps[0].version;
  const final=await f.run();
  assert.equal(final.phase,'completed');
  assert.equal(final.cursor,1);
  assert.equal(f.child(1).phase,'completed');
  assert.equal(f.state.installed.version,f.final.version);
  assert.equal(readState(updateFiles(f.options).request).id,f.request.id,'No second user confirmation job is created');
  assert.equal(f.calls.length,2);
  assert.equal(f.notices.length,1,'Only the final root job sends completion');
  await f.run();
  assert.equal(f.calls.length,2);
  assert.equal(f.notices.length,1);
});

test('three steps use the same owner job while each child freezes its own binding configuration',async t=>{
  const f=await fixture(t,{length:3});
  for(let index=0;index<f.steps.length;index++) {
    const result=await f.run();
    assert.equal(result.cursor,index);
    assert.equal(result.phase,index===f.steps.length-1?'completed':'handoff-pending');
    assert.equal(f.child(index).phase,'completed');
    if(index<f.steps.length-1) {
      const before=f.calls.length;
      await f.run();
      assert.equal(f.calls.length,before);
      f.state.workerVersion=f.steps[index].version;
      f.state.identityKey='same-owner-new-binding-configuration-'+index;
    }
  }
  assert.equal(f.calls.length,3);
  assert.equal(f.notices.length,1);
  assert.equal(f.progress().stableBinding.accountId,'same-agent');
  assert.equal(f.progress().stableBinding.key,hash({instanceId:f.options.instanceId,route:f.options.clawchat.route}));
});

test('the final official-only prerequisite cannot prevent installing a compatible bridge first',async t=>{
  const f=await fixture(t,{finalPrerequisites:{clawchatIntegration:{minimumVersion:'0.2.24',upgradeVersion:'0.2.24',officialOnly:true}}});
  const connectorCalls=[];
  const connector={async inspect(){connectorCalls.push('inspect');return {
    status:'running',selected:{id:'official-023',version:'0.2.23'},
    running:{id:'official-023',version:'0.2.23',health:{version:'0.2.23',identity:'same-agent',ready:true,connected:true,draining:false}},
    effective:{version:'0.2.23',custom:true},job:{id:'old-job',status:'succeeded'},
  };},async prepare(){throw Error('A custom base cannot be silently replaced');},async upgrade(){throw Error('Unexpected official upgrade');}};
  assert.equal((await f.run({connector})).phase,'handoff-pending');
  assert.deepEqual(connectorCalls,[],'Only the current step prerequisite may execute');
  f.state.workerVersion=f.steps[0].version;
  const result=await f.run({connector});
  assert.equal(result.phase,'failed');
  assert.equal(f.state.installed.version,f.steps[0].version);
  assert.equal(f.calls.length,1);
  assert.ok(connectorCalls.length>0);
  assert.equal(f.child(1).reason,'connector-migration-required');
});

test('a lost bridge selection ACK is reconciled once before a new worker resumes',async t=>{
  const f=await fixture(t);
  f.failures.set(f.steps[0].version,'unknown-after-commit');
  assert.equal((await f.run()).phase,'handoff-pending');
  assert.equal(f.child(0).ack,'unknown');
  await f.run();
  assert.equal(f.calls.length,1);
  f.state.workerVersion=f.steps[0].version;
  assert.equal((await f.run()).phase,'completed');
  assert.equal(f.calls.length,2);
});

test('an unconfirmed bridge submission survives restart and is never submitted again',async t=>{
  const f=await fixture(t);
  f.failures.set(f.steps[0].version,'unknown-before-commit');
  const initial=await f.run();
  assert.equal(initial.phase,'uncertain');
  assert.equal(f.child(0).reason,'switch-unconfirmed');
  await f.run();
  assert.equal(f.calls.length,1);
  f.commit(f.steps[0]);
  assert.equal((await f.run()).phase,'handoff-pending','An original selection can become observable after a restart');
  assert.equal(f.calls.length,1);
  f.state.workerVersion=f.steps[0].version;
  assert.equal((await f.run()).phase,'completed');
  assert.equal(f.calls.length,2);
});

test('a different account cannot inherit a confirmed path after the bridge is installed',async t=>{
  const f=await fixture(t);
  await f.run();
  f.state.workerVersion=f.steps[0].version;
  f.state.accountId='another-agent';
  const result=await f.run();
  assert.notEqual(result.phase,'completed');
  assert.equal(result.cursor,0);
  assert.equal(f.calls.length,1);
});

test('external installation, integrity, or generation changes block the recorded handoff',async t=>{
  for(const change of ['version','integrity','generation'])await t.test(change,async t=>{
    const f=await fixture(t);
    await f.run();
    f.state.workerVersion=f.steps[0].version;
    if(change==='version')f.state.installed={...f.state.installed,version:'1.0.0-beta.99'};
    if(change==='integrity')f.state.installed={...f.state.installed,integrity:integrityFor('external-content')};
    if(change==='generation')f.state.installed={...f.state.installed,activationGeneration:f.state.installed.activationGeneration+1};
    const result=await f.run();
    assert.notEqual(result.phase,'completed');
    assert.equal(result.cursor,0);
    assert.equal(f.calls.length,1,'The job cannot overwrite an installation changed by another operator');
  });
});

test('a failed final step rolls back to the bridge and preserves forward data without claiming the original version',async t=>{
  const f=await fixture(t);
  await f.run();
  f.state.workerVersion=f.steps[0].version;
  f.failures.set(f.final.version,'unhealthy');
  const result=await f.run();
  assert.equal(result.phase,'rolled-back');
  assert.equal(f.state.installed.version,f.steps[0].version);
  assert.equal(result.version,f.steps[0].version);
  assert.notEqual(result.version,current);
  assert.equal(f.child(1).phase,'rolled-back');
  assert.equal(await readFile(f.content,'utf8'),'existing conversation and forward data');
  assert.equal(f.calls.at(-1).action,'select');
  assert.equal(f.calls.at(-1).body.version,f.steps[0].version);
});

test('concurrent root workers admit only one current-step switch', {timeout:15000},async t=>{
  const f=await fixture(t);
  let releaseChange,entered;
  const gate=new Promise(resolve=>{releaseChange=resolve;});
  const admitted=new Promise(resolve=>{entered=resolve;});
  f.state.beforeChange=async action=>{if(action!=='select'){entered();await gate;}};
  const first=f.run();
  let timer;
  try {
    await Promise.race([admitted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The first worker did not reach the switch')),5000);})]);
    clearTimeout(timer);
    await f.run();
    assert.equal(f.calls.length,1);
  } finally {clearTimeout(timer);releaseChange();}
  assert.equal((await first).phase,'handoff-pending');
  assert.equal(f.calls.length,1);
});

test('a changed persisted plan cannot authorize a different stage',async t=>{
  const f=await fixture(t);
  const changed=readState(updateFiles(f.options).request);
  changed.plan.steps[0].sha256=hash('unexpected replacement');
  writeState(updateFiles(f.options).request,changed);
  try {
    const result=await f.run();
    assert.notEqual(result?.phase,'completed');
  } catch(error) {assert.match(error.message,/plan|digest|changed|integrity/i);}
  assert.equal(f.calls.length,0);
});

test('an old worker cannot run the next queued child after a successor advanced a busy handoff',async t=>{
  const f=await fixture(t);
  assert.equal((await f.run()).phase,'handoff-pending');
  f.state.workerVersion=f.steps[0].version;
  f.state.idle=false;
  const waiting=await f.run();
  assert.equal(waiting.phase,'step-running');
  assert.equal(waiting.cursor,1);
  assert.equal(waiting.activeStep.id,plannedUpdateStepId(f.request.id,1,f.final));
  assert.equal(f.child(1)?.phase??'queued','queued');
  assert.equal(f.calls.length,1,'A busy successor must not submit the final installation');

  f.state.idle=true;
  f.state.workerVersion=current;
  const old=await f.run();
  assert.equal(old.phase,'step-running');
  assert.equal(old.reason,'waiting-for-current-updater');
  assert.equal(old.cursor,1);
  assert.equal(f.child(1)?.phase??'queued','queued');
  assert.equal(f.calls.length,1,'Advancing the parent cursor cannot grant old code the queued child');

  f.state.workerVersion=f.steps[0].version;
  assert.equal((await f.run()).phase,'completed');
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].worker,f.steps[0].version);
});

test('a queued child keeps the original selection instead of accepting an external installation as a new baseline',async t=>{
  for(const change of ['lower-version','integrity','generation'])await t.test(change,async t=>{
    const f=await fixture(t);
    const childFile=updateProgress(f.options,plannedUpdateStepId(f.request.id,0,f.steps[0]));
    writeState(childFile,{phase:'queued'});
    const identity=f.host.identity;
    let reads=0;
    // The parent admits the plan, then the child observes a busy owner. This
    // leaves a real frozen baseline before any switch has been submitted.
    f.host.identity=async()=>({...await identity(),idle:++reads===1});
    const admitted=await f.run();
    f.host.identity=identity;
    assert.equal(admitted.phase,'step-running');
    assert.equal(admitted.cursor,0);
    assert.equal(f.child(0).phase,'queued');
    assert.equal(admitted.startSelection.version,current);
    assert.equal(f.calls.length,0);

    if(change==='lower-version')f.state.installed={...f.initial,version:'1.0.0-beta.4.dev.19'};
    if(change==='integrity')f.state.installed={...f.initial,integrity:integrityFor('external-queued-content')};
    if(change==='generation')f.state.installed={...f.initial,activationGeneration:f.initial.activationGeneration+1};
    f.state.workerVersion=f.state.installed.version;
    const external=structuredClone(f.state.installed);
    const stopped=await f.run();
    assert.equal(stopped.phase,'uncertain');
    assert.equal(stopped.reason,'update-path-verification-failed');
    assert.match(stopped.detail,/Installed plugin changed before update step/);
    assert.equal(stopped.cursor,0);
    assert.equal(f.child(0).phase,'queued');
    assert.equal(f.calls.length,0,'No external version may become the rollback baseline of this job');
    assert.deepEqual(f.state.installed,external);
    assert.deepEqual(stopped.startSelection,admitted.startSelection);
  });
});

test('a completed child cannot certify an externally changed selection after the parent completion write was lost',async t=>{
  for(const index of [0,1])for(const change of ['integrity','source','generation'])await t.test('step '+index+' '+change,async t=>{
    const f=await fixture(t);
    await f.run();
    if(index===1) {
      f.state.workerVersion=f.steps[0].version;
      assert.equal((await f.run()).phase,'completed');
    }
    const child=f.child(index);
    assert.equal(child.phase,'completed');
    assert.ok(child.completedSelection,'The child must persist its exact completion selection');
    const saved=f.progress();
    // Model a crash after the child commit but before the parent writes either
    // its handoff or final completion. The admitted step owner remains intact.
    const beforeParentCommit={...saved,phase:'step-running',cursor:index,
      completedSteps:(saved.completedSteps??[]).slice(0,index),handoff:undefined,
      version:undefined,notices:undefined,reason:undefined};
    writeState(updateProgress(f.options,f.request.id),beforeParentCommit);
    f.notices.length=0;
    f.state.workerVersion=index===0?current:f.steps[index-1].version;
    if(change==='integrity')f.state.installed={...f.state.installed,integrity:integrityFor('external-completed-content')};
    if(change==='source')f.state.installed={...f.state.installed,source:{type:'github',repository:'another/releases',release:f.steps[index].tag}};
    if(change==='generation')f.state.installed={...f.state.installed,activationGeneration:f.state.installed.activationGeneration+1};
    const external=structuredClone(f.state.installed),calls=f.calls.length;

    const stopped=await f.run();
    assert.equal(stopped.phase,'uncertain');
    assert.equal(stopped.reason,'update-path-verification-failed');
    assert.match(stopped.detail,/Completed update selection changed/);
    assert.equal(stopped.cursor,index);
    assert.equal(stopped.handoff,undefined,'A different installation cannot acquire the next step');
    assert.equal(stopped.completedSteps.length,index,'No parent completion can be inferred from version alone');
    assert.equal(f.calls.length,calls,'Reconciliation cannot overwrite the external selection');
    assert.deepEqual(f.state.installed,external);
    assert.equal(f.child(index).phase,'completed');
    assert.deepEqual(f.child(index).completedSelection,child.completedSelection);
    assert.ok(f.notices.every(notice=>!/已经更新到/.test(notice.text)),'An uncertain child reconciliation cannot send final success');
  });
});
