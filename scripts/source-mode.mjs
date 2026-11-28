import {activeCall} from '../src/call-state.mjs';
import {bootstrapFiles,programFiles,retiredProgramFiles,bootstrapMode} from '../src/bootstrap-deployment.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,rmSync,renameSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createClawChatCore} from '../src/clawchat-core.mjs';
import {inspectSourceCandidate,preflightSourceLaunchers,sourceTarget,sourceIdentity,sourceCandidateFile} from '../src/source-candidate.mjs';
import {workspaceInstructionsSource,planWorkspaceInstructions,applyWorkspaceInstructions} from '../src/workspace-instructions.mjs';
import {probeRuntimeReady} from '../src/runtime-activation.mjs';
import {inspectDefaultStickerCatalog} from '../src/default-stickers.mjs';
import {clawchatBindingState} from '../src/clawchat-state.mjs';
import {installedPlugin,installationFile,ownRoot} from '../src/platform-client.mjs';
import {pendingPlatformOperations} from '../src/platform-operations.mjs';
import {sdkProcesses,waitForSdkExit} from '../src/recovery.mjs';
import {inspectOfficialDeliveryCapabilities} from '../src/official-delivery-preflight.mjs';
import {pendingOfficialDeliveries} from '../src/official-delivery.mjs';

const [action,instancePath,sourcePath,projectPath]=process.argv.slice(2);
const flags=process.argv.slice(6),values={};let recovery=false,enableCall=false;
for(let i=0;i<flags.length;i++){
 const key=flags[i];if(key==='--recover-offline'){assert.ok(!recovery);recovery=true;}
 else if(key==='--enable-independent-call'){assert.ok(!enableCall);enableCall=true;}
 else if(['--exposure-bundle','--exposure-rollback-bundle'].includes(key)){assert.ok(!values[key]&&isAbsolute(flags[i+1]??''));values[key]=flags[++i];}
 else throw Error('Unknown source switch option');
}
const exposurePath=values['--exposure-bundle'],exposureRollbackPath=values['--exposure-rollback-bundle'];
assert.ok(!exposureRollbackPath||exposurePath);
assert.ok(['preflight','activate','rollback'].includes(action));
assert.ok(isAbsolute(instancePath)&&isAbsolute(sourcePath)&&isAbsolute(projectPath),'Use explicit absolute instance, source/backup and project paths');
const read=path=>JSON.parse(readFileSync(path,'utf8')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=path=>existsSync(path)?sha(readFileSync(path)):null;
const options=read(instancePath),core=createClawChatCore(options),pointer=sourceCandidateFile(options);
const files=programFiles(sourcePath);
const exposureId='clawling.exposure.liveware';
const replaceExposure=path=>execFileSync(options.clawchat.delivery.connectBin,['plugin','replace',exposureId,path,'--offline','--config',options.clawchat.delivery.configPath],{cwd:options.cwd,timeout:120000,stdio:'pipe',env:{...process.env,WHALENEST_SOURCE_INSTANCE:''}});
function exposurePlan(){
 if(!exposurePath)return null;
 const before=installedPlugin(options,exposureId);assert.ok(before?.status==='active'&&before.source?.type==='local');
 const bundle=read(exposurePath);assert.equal(bundle.manifest.pluginId,exposureId);
 const rollback=exposureRollbackPath??before.source.path;assert.equal(hash(rollback),hash(before.source.path),'Rollback must contain the same official Exposure bundle');
 return {before,rollback,target:exposurePath,targetHash:hash(exposurePath),rollbackHash:hash(rollback)};
}

const services=['whalenest-qq','whalenest-call','whalenest-song','dsh-agent'];
const ctl=(verb,service)=>service==='whalenest-qq'&&verb==='stop'
  ?execFileSync('/usr/bin/python3',[fileURLToPath(new URL('../deploy/stop-qq-desktop.py',import.meta.url))],{cwd:options.cwd,timeout:60000,stdio:'pipe'})
  :execFileSync('/opt/clawnest/bin/supervisord',['ctl',verb,service],{cwd:options.cwd,timeout:60000,stdio:'pipe'});
const put=(path,contents,mode=bootstrapMode(path))=>{
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.source-switch.tmp';
  writeFileSync(temporary,contents,{flag:'wx',mode});renameSync(temporary,path);
};
const save=(path,value)=>put(path,JSON.stringify(value,null,2)+'\n');
async function noActiveInitializationWrites(){
  const binding=JSON.parse(existsSync(join(options.dataDir,'first-binding.json'))?readFileSync(join(options.dataDir,'first-binding.json'),'utf8'):'null');
  if(!binding?.identity)return;
  const platform=clawchatBindingState(options.clawchat.delivery.configPath,options.clawchat.route.account,{options});
  const pending=[];
  for(const [file,section] of [['song-liveware.json','operations'],['managed-liveware.json','stableCall']]){
    const record=existsSync(join(options.dataDir,file))?read(join(options.dataDir,file)):null;
    for(const kind of ['create','bind']){
      const op=record?.[section]?.[kind];if(op?.state==='pending')pending.push([kind==='create'?'liveware_app_create':'liveware_tunnel_bind',op.requestId]);
    }
  }
  for(const [tool,id] of pending){
    const {readPlatformOperation}=await import('../src/platform-operations.mjs');
    const receipt=readPlatformOperation(options,tool,id);
    assert.ok(receipt&&['succeeded','failed','denied','expired','indeterminate','not_found'].includes(receipt.status),
      'Initialization write still executing or unknown before claim; keep the current Core online');
  }
}
async function idle(){
  assert.equal(pendingPlatformOperations(options).length,0,'Platform operations are still running');
  assert.equal(pendingOfficialDeliveries(options).length,0,'Official delivery is still executing; keep the current service online');
  const state=await core.state();
  const route=options.clawchat.route;
  assert.ok(state.ownerId===route.sender&&state.conversationId===route.conversation,'Original private binding changed');
  if(!state.available||!state.connected){
    assert.ok(recovery,'Original private binding is not healthy');
    const verified=clawchatBindingState(options.clawchat.delivery.configPath,route.account,{options}).current();
    assert.ok(verified&&verified.agent===state.userId&&verified.owner===route.sender
      &&verified.conversation===route.conversation,'Offline recovery needs the exact verified activation');
    assert.equal(sdkProcesses(options.home).length,0,'Offline recovery cannot overlap an SDK');
  }
  await noActiveInitializationWrites();
  assert.equal(state.running,0,'The user has a running task');assert.equal(state.queued,0,'The user has queued tasks');
  assert.ok(!activeCall(options),'A voice call is still active; wait until it closes');
  return state;
}
async function healthy(){
  for(let n=0;n<60;n++){
    try{const state=await core.state();if(state.available&&state.connected&&await probeRuntimeReady(options))return;}
    catch{}
    await delay(1000);
  }
  throw Error('Original Core/SDK did not become ready');
}
async function start({requireHealthy=true}={}){
  ctl('start','dsh-agent');
  for(const service of ['whalenest-call','whalenest-song'])ctl('start',service);
  if(requireHealthy)await healthy();
  ctl('start','whalenest-qq');
  for(const port of [options.realtime?.enabled?options.realtime.port??8897:null,
    options.singing?.playback?.enabled?options.singing.playback.port??8898:null].filter(Boolean)){
    let ready=false;
    for(let n=0;n<50&&!ready;n++){
      try{ready=(await fetch('http://127.0.0.1:'+port+'/healthz',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
      if(!ready)await delay(200);
    }
    assert.ok(ready,'Liveware is not healthy: '+port);
  }
}
function restore(backup,record){
  if(record.exposureChanged){assert.equal(hash(record.exposure.rollback),record.exposure.rollbackHash);replaceExposure(record.exposure.rollback);}
  if(record.activatedInstanceHash){assert.equal(hash(instancePath),record.activatedInstanceHash,'Instance settings changed after source selection');put(instancePath,record.previousInstance);Object.assign(options,JSON.parse(record.previousInstance));}
  for(const file of record.files){
    const path=join(projectPath,file.name);
    if(file.existed)put(path,readFileSync(join(backup,'launchers',file.name)),file.mode);
    else rmSync(path,{force:true});
  }
  if(record.previousSource!==null)put(pointer,record.previousSource);else rmSync(pointer,{force:true});
  const oldSource=record.previousSource?read(join(JSON.parse(record.previousSource).root,'source-manifest.json')):null;
  const root=oldSource?JSON.parse(record.previousSource).root:ownRoot(options);
  applyWorkspaceInstructions(planWorkspaceInstructions(options,workspaceInstructionsSource({installedRoot:root})));
}

if(action==='rollback'){
  const record=read(join(sourcePath,'switch.json'));
  assert.equal(record.instanceId,options.instanceId);assert.equal(record.projectRoot,resolve(projectPath));
  assert.equal(hash(pointer),record.activatedPointerHash,'A later source selection owns this instance');
  await idle();for(const service of services)ctl('stop',service);
  restore(sourcePath,record);await start();console.log(JSON.stringify({state:'restored',backup:sourcePath}));
}else{
  const selected=installedPlugin(options),bytes=readFileSync(join(sourcePath,'source-manifest.json')),manifest=JSON.parse(bytes);
  const candidate={schema:1,mode:'source-test',identity:sourceIdentity(options),target:sourceTarget(selected),
    root:resolve(sourcePath),version:manifest.version,manifestSha256:sha(bytes)};
  inspectSourceCandidate(options,selected,{record:candidate});
  const stickerCatalog=inspectDefaultStickerCatalog(options);
  // The own-source Bun preload now resolves our filesystem provider entry too;
  // the signed official Core, artifact and installed package remain untouched.
  assert.ok(!/\s/.test(join(projectPath,'scripts/source-preload.mjs')),'Bun preload path cannot contain whitespace');
  for(const file of files)assert.ok(manifest.files[file],'Source snapshot lacks launcher support: '+file);
  preflightSourceLaunchers(sourcePath,projectPath,bootstrapFiles(sourcePath));
  if(manifest.files['src/official-delivery.mjs']){
    const capabilities=await inspectOfficialDeliveryCapabilities(options);
    assert.ok(capabilities.ok,capabilities.message+': '+capabilities.missing.join(', '));
  }
  const active=inspectSourceCandidate(options,selected);
  if(active?.manifestSha256===candidate.manifestSha256){
    await healthy();console.log(JSON.stringify({state:'already-active',version:candidate.version,manifestSha256:candidate.manifestSha256}));
  }else{
    const instructions=planWorkspaceInstructions(options,workspaceInstructionsSource({installedRoot:sourcePath})),exposure=exposurePlan();
    const priorState=await idle();
    const inputs=new Map([instancePath,pointer,installationFile(options),...(exposure?[exposure.target,exposure.rollback]:[]),
      ...[...files,...retiredProgramFiles].map(name=>join(projectPath,name))].map(file=>[file,hash(file)]));
    if(stickerCatalog){
      inputs.set(stickerCatalog.path,stickerCatalog.manifestSha256);
      for(const entry of stickerCatalog.entries)inputs.set(entry.file,entry.sha256);
    }
    const summary={state:'ready',mode:'source-test',version:candidate.version,installedVersion:selected.version,
      activationGeneration:selected.activationGeneration,sourceSha256:candidate.manifestSha256,files:Object.keys(manifest.files).length,
      workspaceInstructionsChanged:instructions.changed,
      ...(stickerCatalog?{defaultStickers:stickerCatalog.entries.length}: {})};
    if(action==='preflight')console.log(JSON.stringify(summary));
    else{
      const backup=join(options.dataDir,'source-backups',new Date().toISOString().replaceAll(':','').replaceAll('.','')+'-before-source');
      mkdirSync(dirname(backup),{recursive:true,mode:0o700});mkdirSync(backup,{recursive:false,mode:0o700});
      const record={exposure,instanceId:options.instanceId,projectRoot:resolve(projectPath),candidate,summary,priorState,
        previousInstance:readFileSync(instancePath,'utf8'),previousSource:existsSync(pointer)?readFileSync(pointer,'utf8'):null,files:[]};
      for(const path of [instancePath,join(options.cwd,'AGENTS.md'),join(options.cwd,'clawchat/greeting.md'),
        ...['workspace-instructions.json','greeting-input.json','first-binding.json','managed-liveware.json',
          'song-liveware.json','call-liveware.json','diary-publications.json','binding-reload.json',
          'binding-transition.json'].map(name=>join(options.dataDir,name))])
        if(existsSync(path))copyFileSync(path,join(backup,path.split('/').at(-1)));
      for(const name of [...files,...retiredProgramFiles]){
        const path=join(projectPath,name),existed=existsSync(path),mode=existed?lstatSync(path).mode&0o777:0o600;
        record.files.push({name,existed,mode});
        if(existed){const target=join(backup,'launchers',name);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(path,target);}
      }
      save(join(backup,'switch.json'),record);
      inspectSourceCandidate(options,selected,{record:candidate});await idle();
      for(const [file,digest]of inputs)assert.equal(hash(file),digest,'Input changed before cutover: '+file);
      let stopped=false;
      try{
        if(exposure)assert.deepEqual(installedPlugin(options,exposureId),exposure.before,'Exposure selection changed before drain');
        stopped=true;for(const service of services)ctl('stop',service);
        await waitForSdkExit(options);
        for(const [file,digest]of inputs)assert.equal(hash(file),digest,'Input changed during drain: '+file);
        if(exposure){
          record.exposureChanged=true;save(join(backup,'switch.json'),record);
          replaceExposure(exposure.target);
        }
        for(const name of files){
          assert.equal(hash(join(sourcePath,name)),manifest.files[name]);
          put(join(projectPath,name),readFileSync(join(sourcePath,name)));
        }
        for(const name of retiredProgramFiles)rmSync(join(projectPath,name),{force:true});
        if(enableCall){options.realtime={...options.realtime,sessionEnabled:true,mode:'independent'};save(instancePath,options);record.activatedInstanceHash=hash(instancePath);}
        save(pointer,candidate);record.activatedPointerHash=hash(pointer);save(join(backup,'switch.json'),record);
        applyWorkspaceInstructions(instructions);await start();
        if(exposure)assert.equal(installedPlugin(options,exposureId).source.path,exposure.target,'Official Exposure replacement was not selected');
        save(join(backup,'result.json'),{state:'active',version:candidate.version,sourceSha256:candidate.manifestSha256});
        console.log(JSON.stringify({...summary,state:'active',backup}));
      }catch(error){
        if(stopped){for(const service of services){try{ctl('stop',service);}catch{}}
          restore(backup,record);await start({requireHealthy:record.priorState.available&&record.priorState.connected});}
        save(join(backup,'result.json'),{state:'rolled-back',error:error.message});throw error;
      }
    }
  }
}
