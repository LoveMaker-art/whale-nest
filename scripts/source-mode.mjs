import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,rmSync,renameSync,lstatSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createClawChatCore} from '../src/clawchat-core.mjs';
import {inspectSourceCandidate,selectedSourceRuntime,sourceTarget,sourceIdentity,sourceCandidateFile} from '../src/source-candidate.mjs';
import {workspaceInstructionsSource,planWorkspaceInstructions,applyWorkspaceInstructions} from '../src/workspace-instructions.mjs';
import {probeRuntimeReady} from '../src/runtime-activation.mjs';
import {inspectDefaultStickerCatalog} from '../src/default-stickers.mjs';

const [action,instancePath,sourcePath,projectPath]=process.argv.slice(2);
assert.ok(['preflight','activate','rollback'].includes(action));
assert.ok(isAbsolute(instancePath)&&isAbsolute(sourcePath)&&isAbsolute(projectPath),'Use explicit absolute instance, source/backup and project paths');
const read=path=>JSON.parse(readFileSync(path,'utf8')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=path=>existsSync(path)?sha(readFileSync(path)):null;
const options=read(instancePath),core=createClawChatCore(options),pointer=sourceCandidateFile(options);
const files=['src/source-candidate.mjs','src/binding-transition.mjs','src/clawchat-state.mjs','src/state.mjs','scripts/source-preload.mjs','src/liveware-service.mjs','deploy/serve-media.mjs'];
const services=['whalenest-call','whalenest-song','dsh-agent'];
const ctl=(verb,service)=>execFileSync('/opt/clawnest/bin/supervisord',['ctl',verb,service],{cwd:options.cwd,timeout:60000,stdio:'pipe'});
const put=(path,contents,mode=0o600)=>{
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.source-switch.tmp';
  writeFileSync(temporary,contents,{flag:'wx',mode});renameSync(temporary,path);
};
const save=(path,value)=>put(path,JSON.stringify(value,null,2)+'\n');
async function idle(){
  const state=await core.state();
  assert.ok(state.available&&state.connected&&state.ownerId===options.clawchat.route.sender
    &&state.conversationId===options.clawchat.route.conversation,'Original private binding is not healthy');
  assert.equal(state.running,0,'The user has a running task');assert.equal(state.queued,0,'The user has queued tasks');
  if(options.realtime?.enabled){
    const port=(options.realtime.port??8897).toString(16).toUpperCase().padStart(4,'0');
    for(const path of ['/proc/net/tcp','/proc/net/tcp6'])if(existsSync(path)){
      const active=readFileSync(path,'utf8').trim().split('\n').slice(1).some(line=>{
        const fields=line.trim().split(/\s+/);return fields[1]?.endsWith(':'+port)&&fields[3]==='01';
      });
      assert.ok(!active,'A call transport is still connected; wait until the call closes');
    }
  }
}
async function healthy(){
  for(let n=0;n<60;n++){
    try{const state=await core.state();if(state.available&&state.connected&&await probeRuntimeReady(options))return;}
    catch{}
    await delay(1000);
  }
  throw Error('Original Core/SDK did not become ready');
}
async function start(){
  ctl('start','dsh-agent');await healthy();
  for(const service of ['whalenest-call','whalenest-song'])ctl('start',service);
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
  for(const file of record.files){
    const path=join(projectPath,file.name);
    if(file.existed)put(path,readFileSync(join(backup,'launchers',file.name)),file.mode);
    else rmSync(path,{force:true});
  }
  if(record.previousSource!==null)put(pointer,record.previousSource);else rmSync(pointer,{force:true});
  const oldSource=record.previousSource?read(join(JSON.parse(record.previousSource).root,'source-manifest.json')):null;
  const root=oldSource?JSON.parse(record.previousSource).root:join(dirname(selectedSourceRuntime(options).activeArtifact),'whalenest');
  applyWorkspaceInstructions(planWorkspaceInstructions(options,workspaceInstructionsSource({installedRoot:root})));
}

if(action==='rollback'){
  const record=read(join(sourcePath,'switch.json'));
  assert.equal(record.instanceId,options.instanceId);assert.equal(record.projectRoot,resolve(projectPath));
  assert.equal(hash(pointer),record.activatedPointerHash,'A later source selection owns this instance');
  await idle();for(const service of services)ctl('stop',service);
  restore(sourcePath,record);await start();console.log(JSON.stringify({state:'restored',backup:sourcePath}));
}else{
  const selected=selectedSourceRuntime(options),bytes=readFileSync(join(sourcePath,'source-manifest.json')),manifest=JSON.parse(bytes);
  const candidate={schema:1,mode:'source-test',identity:sourceIdentity(options),target:sourceTarget(selected),
    root:resolve(sourcePath),version:manifest.version,manifestSha256:sha(bytes)};
  inspectSourceCandidate(options,selected,{record:candidate});
  const stickerCatalog=inspectDefaultStickerCatalog(options);
  // The installed native Core retains its provider entry. This source path
  // validates DSH business modules and Liveware without changing that loader.
  for(const name of ['src/runtime-extension.mjs','src/runtime-provider.mjs','src/runtime-bridge-client.mjs','src/liveware-managed.mjs'])
    assert.equal(hash(join(sourcePath,name)),hash(join(dirname(selected.activeArtifact),'whalenest',name)),
      'The Core-side provider entry also changed; adapt its source loader before switching: '+name);
  for(const file of files)assert.ok(manifest.files[file],'Source snapshot lacks launcher support: '+file);
  const active=inspectSourceCandidate(options,selected);
  if(active?.manifestSha256===candidate.manifestSha256){
    await healthy();console.log(JSON.stringify({state:'already-active',version:candidate.version,manifestSha256:candidate.manifestSha256}));
  }else{
    const instructions=planWorkspaceInstructions(options,workspaceInstructionsSource({installedRoot:sourcePath}));
    await idle();
    const inputs=new Map([instancePath,pointer,join(dirname(options.clawchat.delivery.configPath),'plugins.lock.json'),
      ...files.map(name=>join(projectPath,name))].map(file=>[file,hash(file)]));
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
      const record={instanceId:options.instanceId,projectRoot:resolve(projectPath),candidate,summary,
        previousSource:existsSync(pointer)?readFileSync(pointer,'utf8'):null,files:[]};
      for(const path of [instancePath,join(options.cwd,'AGENTS.md'),join(options.cwd,'greeting.md'),
        ...['workspace-instructions.json','greeting-input.json','first-binding.json','managed-liveware.json',
          'song-liveware.json','call-liveware.json'].map(name=>join(options.dataDir,name))])
        if(existsSync(path))copyFileSync(path,join(backup,path.split('/').at(-1)));
      for(const name of files){
        const path=join(projectPath,name),existed=existsSync(path),mode=existed?lstatSync(path).mode&0o777:0o600;
        record.files.push({name,existed,mode});
        if(existed){const target=join(backup,'launchers',name);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(path,target);}
      }
      save(join(backup,'switch.json'),record);
      inspectSourceCandidate(options,selected,{record:candidate});await idle();
      for(const [file,digest]of inputs)assert.equal(hash(file),digest,'Input changed before cutover: '+file);
      let stopped=false;
      try{
        stopped=true;for(const service of services)ctl('stop',service);
        for(const [file,digest]of inputs)assert.equal(hash(file),digest,'Input changed during drain: '+file);
        for(const name of files){
          assert.equal(hash(join(sourcePath,name)),manifest.files[name]);
          put(join(projectPath,name),readFileSync(join(sourcePath,name)));
        }
        save(pointer,candidate);record.activatedPointerHash=hash(pointer);save(join(backup,'switch.json'),record);
        applyWorkspaceInstructions(instructions);await start();
        save(join(backup,'result.json'),{state:'active',version:candidate.version,sourceSha256:candidate.manifestSha256});
        console.log(JSON.stringify({...summary,state:'active',backup}));
      }catch(error){
        if(stopped){for(const service of services){try{ctl('stop',service);}catch{}}
          restore(backup,record);await start();}
        save(join(backup,'result.json'),{state:'rolled-back',error:error.message});throw error;
      }
    }
  }
}
