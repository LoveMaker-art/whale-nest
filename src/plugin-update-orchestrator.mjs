import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative} from 'node:path';
import {hash} from './routing.mjs';
import {comparePluginVersions,updateTarget} from './plugin-release.mjs';
import {validatePluginUpdatePlan} from './plugin-update-path.mjs';

const terminal=new Set(['completed','failed','rolled-back']);
const selection=entry=>({version:entry?.version,integrity:entry?.integrity,
  ...(Number.isSafeInteger(entry?.activationGeneration)?{activationGeneration:entry.activationGeneration}:{})});
const completedSelection=entry=>({...selection(entry),target:entry?.target,source:entry?.source});

export const plannedUpdateStepId=(parentId,index,release)=>hash([parentId,'step',index,release.version,release.sha256]);

/** A helper already loaded from the old installation must not execute the next
 * stage merely because the installed version changed underneath it. */
export function isInstalledUpdateWorker(entry,workerPath) {
  try {
    if(!isAbsolute(entry?.activeArtifact??'')||!isAbsolute(workerPath))return false;
    const root=dirname(realpathSync(entry.activeArtifact)),file=realpathSync(workerPath);
    const inside=relative(root,file);
    return Boolean(inside)&&!inside.startsWith('..')&&!isAbsolute(inside);
  }catch{return false;}
}

/** The caller holds the one existing update lease. Each child uses the original
 * single-step executor and separate progress; this function never invokes code
 * named by metadata, starts a second helper, or changes the confirmed target. */
export async function runPluginUpdatePlan(options,request,{
  host,readProgress,writeProgress,runStep,isCurrentWorker,
}) {
  let progress=readProgress(request.id)??{phase:'queued',cursor:0};
  const save=fields=>{
    progress={...progress,...fields,updatedAt:Date.now()};
    writeProgress(request.id,progress);
    return progress;
  };
  try {
    const plan=validatePluginUpdatePlan(request.plan,request.release);
    assert.equal(request.planDigest,hash(plan),'Confirmed update plan changed');
    assert.equal(request.instanceId,options.instanceId,'Update instance changed');
    assert.equal(request.release.repository,options.pluginUpdates.repository,'Update repository changed');
    assert.ok(Number.isSafeInteger(progress.cursor??0),'Invalid update path cursor');
    const cursor=progress.cursor??0;
    assert.ok(cursor>=0&&cursor<plan.steps.length,'Invalid update path cursor');
    assert.ok(['queued','step-running','handoff-pending','uncertain',...terminal].includes(progress.phase),'Invalid update path phase');
    if(terminal.has(progress.phase))return progress;
    const identity=await host.identity();
    if(!identity)return save({reason:'update-path-host-unavailable'});
    const binding={key:hash({instanceId:options.instanceId,route:options.clawchat.route}),accountId:identity.accountId??null};
    if(progress.stableBinding)assert.deepEqual(binding,progress.stableBinding,'Update path binding changed');
    else {
      if(!identity.idle)return save({reason:'update-path-busy'});
      const installed=host.installed();
      assert.ok(installed?.status==='active'&&installed.target===updateTarget,'Original plugin is unavailable');
      const wanted=(request.release.updatePath?.steps??[]).filter(ref=>comparePluginVersions(ref.version,installed.version)>0);
      assert.deepEqual(plan.steps.slice(0,-1).map(({version,sha256})=>({version,sha256})),wanted,
        'Confirmed path omits a required intermediate release');
      assert.ok(comparePluginVersions(plan.steps[0].version,installed.version)>0,'Update path would downgrade the plugin');
      save({stableBinding:binding,startSelection:selection(installed),cursor:0});
    }
    if(progress.phase==='handoff-pending') {
      const installed=host.installed();
      assert.ok(installed?.status==='active','Installed update helper is not active');
      assert.deepEqual(selection(installed),progress.handoff,'Selected update helper changed');
      if(!await isCurrentWorker(installed))return save({reason:'waiting-for-current-updater'});
      assert.ok(cursor+1<plan.steps.length,'Unexpected final-step handoff');
      save({phase:'step-running',cursor:cursor+1,activeStep:undefined,stepOwner:undefined,handoff:undefined,reason:undefined});
    }else if(progress.phase==='uncertain'&&!progress.activeStep) {
      // A failed handoff or changed identity is not a permission to re-plan.
      return progress;
    }
    const index=progress.cursor,release=plan.steps[index];
    const childId=plannedUpdateStepId(request.id,index,release);
    const active={id:childId,index,version:release.version,total:plan.steps.length};
    if(progress.activeStep)assert.deepEqual(progress.activeStep,active,'Active update step changed');
    const childBefore=readProgress(childId),installedBefore=host.installed();
    const queued=!childBefore||childBefore.phase==='queued';
    const expectedBefore=index===0?progress.startSelection:selection(progress.completedSteps?.[index-1]);
    if(queued)assert.deepEqual(selection(installedBefore),expectedBefore,'Installed plugin changed before update step');
    const owner=progress.activeStep?progress.stepOwner:undefined;
    if(queued) {
      if(!await isCurrentWorker(installedBefore))return save({reason:'waiting-for-current-updater'});
    }else {
      // The source which admitted this step may finish reconciling it after
      // replacement. The selected successor may also recover it after a crash.
      const successor=installedBefore?.version===release.version&&installedBefore?.source?.repository===release.repository
        &&installedBefore?.source?.release===release.tag;
      if(!owner||!await isCurrentWorker(owner)&&!(successor&&await isCurrentWorker(installedBefore)))
        return save({reason:'waiting-for-current-updater'});
    }
    const stepOwner=owner??{...selection(installedBefore),
      ...(installedBefore?.activeArtifact?{activeArtifact:installedBefore.activeArtifact}:{})};
    save({phase:'step-running',activeStep:active,stepOwner,reason:undefined});
    const childRequest={id:childId,instanceId:request.instanceId,release,
      route:request.route,confirmedAt:request.confirmedAt,parentId:request.id};
    const child=await runStep(childRequest);
    if(!child)return save({phase:'uncertain',reason:'update-step-result-unavailable'});
    if(child.phase==='completed') {
      const installed=host.installed(),after=await host.identity();
      assert.ok(installed?.status==='active'&&installed.version===release.version,'Completed update selection changed');
      assert.ok(child.completedSelection,'Completed update selection was not recorded');
      assert.deepEqual(completedSelection(installed),child.completedSelection,'Completed update selection changed');
      assert.deepEqual({key:hash({instanceId:options.instanceId,route:options.clawchat.route}),accountId:after?.accountId??null},
        progress.stableBinding,'Update binding changed after installation');
      const completed=[...(progress.completedSteps??[])];
      completed[index]={...active,...selection(installed),completedAt:Date.now()};
      if(index===plan.steps.length-1)return save({phase:'completed',version:release.version,completedSteps:completed,
        connectorVersion:child.connectorVersion,connectorDone:child.connectorDone,reason:undefined});
      // Deliberately return. A later invocation from the newly installed source
      // directory must acquire the lease and perform the next step.
      return save({phase:'handoff-pending',handoff:selection(installed),completedSteps:completed,reason:undefined});
    }
    if(terminal.has(child.phase))return save({phase:child.phase,version:host.installed()?.version,
      reason:child.reason??'update-step-failed',failedStep:active,connectorVersion:child.connectorVersion});
    return save({phase:child.phase==='uncertain'?'uncertain':'step-running',reason:child.reason,
      connectorVersion:child.connectorVersion});
  }catch(error) {
    return save({phase:'uncertain',reason:'update-path-verification-failed',
      detail:String(error.message??error).slice(0,250)});
  }
}
