import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,existsSync,rmSync,mkdtempSync,readdirSync,renameSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {inspectRuntimeUpgrade,protectBiliRollback,protectBiliOwnerRollback,protectDiaryRollback,protectContactRollback,protectVoiceRollback,protectImageRollback,protectQQSocialRollback,protectSongRollback,enablePlatformSpeech,enablePlatformImage,enablePlatformSinging} from '../src/runtime-upgrade.mjs';
import {inspectPreparedRuntimeBundle,verifyLiveInputs,reserveSnapshot,livewareRouteOnline} from '../src/live-update.mjs';
import {recoverLease,waitForSdkExit} from '../src/recovery.mjs';
import {writeState} from '../src/state.mjs';
import {prepareConnectorExtension,verifyInstalledConnector} from '../src/connector-extension.mjs';
import {createConnectorCutover} from '../src/connector-cutover.mjs';
import {inspectConnectorStartup,prepareConnectorStartup,restoreConnectorStartup} from '../src/connector-startup.mjs';
import {voiceSessionPort} from '../src/platform-voice-liveware.mjs';
import {configuredConnectExecutable} from '../src/clawchat-core.mjs';
import {verifyStickerCatalog,importStickerCatalog} from './import-sticker-catalog.mjs';
process.umask(0o077);
const action=process.argv[2];assert.ok(['preflight','install','rollback'].includes(action),'Usage: update-m2.mjs preflight|install|rollback');
const withMediaCore=process.argv.includes('--media-core');
const coreBuildAt=process.argv.indexOf('--core-build');
if(coreBuildAt>=0)assert.ok(withMediaCore&&process.argv[coreBuildAt+1]&&!process.argv[coreBuildAt+1].startsWith('--'),'--core-build requires --media-core and a build directory');
const coreBuildDirectory=resolve(coreBuildAt<0?'.whale-nest/core-media-current':process.argv[coreBuildAt+1]);
const officialBaseAt=process.argv.indexOf('--official-base');
if(officialBaseAt>=0)assert.ok(withMediaCore&&process.argv[officialBaseAt+1]&&!process.argv[officialBaseAt+1].startsWith('--'),'--official-base requires --media-core and an officially staged base directory');
const explicitOfficialBase=officialBaseAt<0?null:resolve(process.argv[officialBaseAt+1]);
const runtimeBundleAt=process.argv.indexOf('--runtime-bundle');
if(runtimeBundleAt>=0)assert.ok(process.argv[runtimeBundleAt+1]&&!process.argv[runtimeBundleAt+1].startsWith('--'),'--runtime-bundle requires a prepared bundle');
const runtimeBundle=runtimeBundleAt<0?null:resolve(process.argv[runtimeBundleAt+1]);
const versionFile=runtimeBundle?join(dirname(runtimeBundle),'distribution.json'):new URL('../package.json',import.meta.url);
const distributionVersion=JSON.parse(readFileSync(versionFile,'utf8')).version;
const withActivities=process.argv.includes('--activities');
const withExpressions=process.argv.includes('--expressions');assert.ok(!withExpressions||withMediaCore,'Expressions require the existing media connector');
const withSpeech=process.argv.includes('--speech');assert.ok(!withSpeech||withMediaCore,'Speech requires the existing media connector');
const withImages=process.argv.includes('--images');assert.ok(!withImages||withMediaCore,'Images require the existing media connector');
const withSongs=process.argv.includes('--songs');assert.ok(!withSongs||withMediaCore,'Singing requires the existing media connector');
const withSongLiveware=process.argv.includes('--song-liveware');assert.ok(!withSongLiveware||withMediaCore,'Song Liveware requires the existing media connector');
const withRealtime=process.argv.includes('--realtime');assert.ok(!withRealtime||withMediaCore&&withSpeech,'Realtime requires the existing media connector and speech');
const realtimeOriginAt=process.argv.indexOf('--realtime-origin');
const realtimeOrigin=realtimeOriginAt<0?undefined:process.argv[realtimeOriginAt+1];
if(realtimeOriginAt>=0){
 assert.ok(withRealtime&&realtimeOrigin,'--realtime-origin requires --realtime and its registered HTTPS origin');
 const {verifiedRealtimePublicOrigin}=await import('../src/platform-voice-liveware.mjs');
 verifiedRealtimePublicOrigin(realtimeOrigin);
}
const withQQModules=process.argv.includes('--qq-modules');
const promptsAt=process.argv.indexOf('--probe-prompts');
if(promptsAt>=0)assert.ok(process.argv[promptsAt+1]&&!process.argv[promptsAt+1].startsWith('--'),'Provide the labelled live probe prompts file');
const probePrompts=promptsAt<0?null:resolve(process.argv[promptsAt+1]);
const stickerCatalogAt=process.argv.indexOf('--sticker-catalog');
if(stickerCatalogAt>=0)assert.ok(process.argv[stickerCatalogAt+1]&&!process.argv[stickerCatalogAt+1].startsWith('--'),'Provide the private sticker catalog file');
const stickerCatalogPath=stickerCatalogAt<0?null:resolve(process.argv[stickerCatalogAt+1]);
const root=process.cwd(),home=homedir(),privateRoot=join(root,'.whale-nest/m2-update');mkdirSync(privateRoot,{recursive:true,mode:0o700});
const recordFile=join(privateRoot,'deployment.json'),read=path=>JSON.parse(readFileSync(path,'utf8'));
const releaseLauncher=fileURLToPath(new URL('../deploy/serve-media.mjs',import.meta.url));
const installedLauncher=join(root,'deploy/serve-media.mjs');
const configFile=join(home,'.clawchat-connect/config.json'),config=read(configFile);
const connectBin=configuredConnectExecutable(read(join(home,'.dsh/companion/aurabot-v1/instance.json')),config);
const run=(bin,args,timeout=45000)=>execFileSync(bin,args,{cwd:root,encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']});
const officialCutover=createConnectorCutover({home,cwd:root});
const supervisor=(action,service='dsh-agent')=>run('/opt/clawnest/bin/supervisord',['ctl',action,service]);
const reload=()=>run('/opt/clawnest/bin/supervisord',['ctl','reload'],60000);
const livewarePrograms=['call','song'].map(kind=>({kind,name:'whalenest-'+kind,file:join(home,'.clawling/supervisord/whalenest-'+kind+'.conf')}));
function stopForRollback(service) {
 try { supervisor('stop',service); }
 catch (error) {
  if(!/\b(?:Stopped|Exited|Fatal)\b/i.test(supervisor('status',service)))throw error;
 }
}
function startAfterReload() {
 reload();
 if(!supervisor('status','dsh-agent').includes('Running'))supervisor('start','dsh-agent');
}
const platformState=()=>JSON.parse(run(connectBin,['__clawnest-state','--config',configFile],12000));
async function health(){return new Promise((resolve,reject)=>{const req=http.get({socketPath:join(home,'.clawnest-integrations/deepseek-harness/control.sock'),path:'/integration/health'},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('health timeout')));});}
async function ready(){for(let i=0;i<100;i++){try{const h=await health();if(h.ready&&h.connected&&!h.draining)return h;}catch{}await delay(500);}throw Error('Core did not become ready');}
async function callReady(port){for(let n=0;n<30;n++){try{const h=await new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:'/healthz'},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});r.on('error',reject);r.setTimeout(1000,()=>r.destroy(Error('Call health timeout')));});if(h.ready&&h.kind==='whalenest-realtime-call')return h;}catch{}await delay(300);}throw Error('Realtime call listener did not become ready');}
async function songPageReady(port){
 for(let attempt=0;attempt<30;attempt++){
  try{const response=await fetch('http://127.0.0.1:'+port+'/healthz',{signal:AbortSignal.timeout(1000)});
   if(response.ok&&await response.text()==='ok')return;
  }catch{}
  await delay(300);
 }
 throw Error('Song Liveware listener did not become ready');
}
async function livewareReady(instance){
 const apps={};
 const route=instance.clawchat.route,callPath=join(instance.dataDir,'call-liveware.json');
 if(instance.realtime?.enabled){
  const call=existsSync(callPath)?read(callPath):null;
  if(call){assert.equal(call.binding,route.account);assert.equal(call.owner,route.sender);apps.call=call.url;}
  else if(instance.realtime.publicOrigin)apps.call=instance.realtime.publicOrigin;
 }
 const songPath=join(instance.dataDir,'song-liveware.json');
 if(instance.singing?.playback?.enabled&&existsSync(songPath)){
  const song=read(songPath),route=instance.clawchat.route;
  if(song.binding===route.account&&song.owner===route.sender)apps.song=song.url;
 }
 const overridePath=join(instance.dataDir,'connector-override.json');
 if(existsSync(overridePath)&&read(overridePath).managedLiveware){
  for(let attempt=0;attempt<30;attempt++){
   const path=join(instance.dataDir,'managed-liveware.json'),managed=existsSync(path)?read(path):null;
   if(managed?.publication){
    assert.equal(managed.binding,route.account);assert.equal(managed.owner,route.sender);
    apps.managedCall=managed.publication.url;break;
   }
   await delay(500);
  }
  assert.ok(apps.managedCall,'Official managed Liveware publication was not discovered');
 }
 return Object.fromEntries(await Promise.all(Object.entries(apps).map(async ([name,url])=>{
  for(let attempt=0;attempt<15;attempt++){
   if(await livewareRouteOnline(url).catch(()=>false))return [name,true];
   await delay(1000);
  }
  throw Error('Registered Liveware route did not come online: '+name);
 })));
}
async function rollback(record){
 const restoredLock=read(join(record.backup,record.lockFile.slice(home.length+1)));
 const targetManaged=restoredLock.plugins['whalenest.runtime.deepseek-harness']?.manifest?.capabilities?.some(capability=>
  capability.type==='managed-web-app'&&capability.id==='whalenest-liveware');
 // Preload while the current support files still exist. Restoring an older
 // root may remove these modules, but its stable launcher still needs repair.
 const restoreLaunchers=record.connector?.managedLiveware&&record.managedExposureAttempted&&!targetManaged
  ?(await import('../src/liveware-migration.mjs')).rollbackManagedLiveware:null;
 stopForRollback('dsh-agent');
 for(const program of record.livewarePrograms??[]) {
  const status=(()=>{try{return supervisor('status',program.name);}catch{return '';}})();
  if(status)stopForRollback(program.name);
  const prior=join(record.backup,program.file.slice(home.length+1));
  if(existsSync(prior))copyFileSync(prior,program.file);else rmSync(program.file,{force:true});
 }
 const instance=read(record.instancePath);
 await waitForSdkExit(instance);
 if(record.officialCutover)record.officialRollback=officialCutover.rollback(record.officialCutover,record.officialSelection);
 const preparedStartup=record.startupPreparation??record.startupPlan;
 if(preparedStartup){
  const profile=preparedStartup.profile??preparedStartup;
  const actual=createHash('sha256').update(readFileSync(profile.profileFile)).digest('hex');
  if(actual!==profile.beforeSha256)restoreConnectorStartup(instance,preparedStartup,join(record.backup,profile.profileFile.slice(home.length+1)));
 }
 const forward=reserveSnapshot(record.backup,'forward-data');
 cpSync(instance.dataDir,join(forward,'companion'),{recursive:true,verbatimSymlinks:true});
 cpSync(join(home,'.dsh/sessions'),join(forward,'sessions'),{recursive:true,verbatimSymlinks:true});
 record.forwardDataPreservedAt=forward;
 for(const path of [record.configFile,record.lockFile,record.instancePath])copyFileSync(join(record.backup,path.slice(home.length+1)),path);
 // Keep the explicitly removed standalone page disabled on rollback as well.
 const restored=read(record.instancePath);delete restored.management;
 const lock=read(record.lockFile);
 const policyFile=join(instance.dataDir,'companion-policy.json'),runtimeFile=join(instance.dataDir,'runtime.json');
 if(existsSync(policyFile)){
  const policy=read(policyFile),runtime=read(runtimeFile);
  record.rollbackContactSafety=protectContactRollback(runtime,policy,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
  if(record.rollbackContactSafety.disableContact){
   writeState(policyFile,policy);writeState(runtimeFile,runtime);restored.activities={...restored.activities,automatic:false};
   const nativeConfigFile=join(instance.dataDir,'aurabot/config.json'),native=read(nativeConfigFile);
   native.speakUp={...native.speakUp,enabled:false};native.modules={...native.modules,speakup:{...native.modules?.speakup,enabled:false}};writeState(nativeConfigFile,native);
  }
 }
 if(existsSync(join(instance.dataDir,'bili/rules.json'))){
  const runtimeFile=join(instance.dataDir,'runtime.json'),inboxFile=join(instance.dataDir,'bili/inbox.json'),runtime=read(runtimeFile),inbox=existsSync(inboxFile)?read(inboxFile):{notices:{}};
  record.rollbackBiliSafety=protectBiliRollback(runtime,inbox,lock.plugins['whalenest.runtime.deepseek-harness'].version);
  writeState(runtimeFile,runtime);if(existsSync(inboxFile))writeState(inboxFile,inbox);
  if(record.rollbackBiliSafety.disableActivities)restored.activities={...restored.activities,enabled:false,automatic:false,maxDailyBackgroundModelCalls:0};
 }
 const biliFiles=['bili/account.json','bili/rules.json','bili/inbox.json','activities/index.json','runtime.json','companion-policy.json'];
 const names=['account','rules','inbox','index','runtime','policy'],files=new Map();
 for(const [i,file]of biliFiles.entries()){const path=join(instance.dataDir,file);if(existsSync(path))files.set(names[i],{path,state:read(path)});}
 const activityFiles=existsSync(join(instance.dataDir,'activities'))?readdirSync(join(instance.dataDir,'activities')).filter(n=>/^whalenest-activity-[a-f0-9]{64}\.json$/.test(n)).map(n=>join(instance.dataDir,'activities',n)):[];
 const activityStates=activityFiles.map(read),data=Object.fromEntries([...files].map(([key,value])=>[key,value.state]));data.activities=activityStates;
 record.rollbackBiliOwnerSafety=protectBiliOwnerRollback(data,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 if(record.rollbackBiliOwnerSafety.disableBrowse){
  for(const {path,state}of files.values())writeState(path,state);
  activityFiles.forEach((file,i)=>writeState(file,activityStates[i]));restored.activities={...restored.activities,automatic:false};
  const path=join(instance.dataDir,'aurabot/config.json'),native=read(path);native.bili={...native.bili,autoBrowse:false,reply:false};writeState(path,native);
 }
 const diaryDirectory=join(instance.dataDir,'diary'),diaryFiles=existsSync(diaryDirectory)?readdirSync(diaryDirectory).filter(n=>/^[a-f0-9]{64}-\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n=>join(diaryDirectory,n)):[];
 const diaries=diaryFiles.map(read),publicationFile=join(instance.dataDir,'diary-publications.json'),diaryData={diaries,publications:existsSync(publicationFile)?read(publicationFile):null,policy:existsSync(policyFile)?read(policyFile):null,runtime:read(runtimeFile)};
 record.rollbackDiarySafety=protectDiaryRollback(diaryData,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 if(record.rollbackDiarySafety.disableDiary){
  diaries.forEach((entry,i)=>{const target=join(diaryDirectory,entry.scope+'-'+entry.date+'.json');if(target!==diaryFiles[i]&&existsSync(target))assert.deepEqual(read(target),entry,'Rollback diary file conflict');writeState(target,entry);if(target!==diaryFiles[i])rmSync(diaryFiles[i]);});
  if(diaryData.publications)writeState(publicationFile,diaryData.publications);if(diaryData.policy)writeState(policyFile,diaryData.policy);writeState(runtimeFile,diaryData.runtime);
  const path=join(instance.dataDir,'aurabot/config.json'),native=read(path);native.modules={...native.modules,diary:{...native.modules?.diary,enabled:false}};writeState(path,native);restored.activities={...restored.activities,automatic:false};
 }
 const nativeVoicePath=join(instance.dataDir,'aurabot/config.json'),nativeVoice=read(nativeVoicePath);
 record.rollbackVoiceSafety=protectVoiceRollback(nativeVoice,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 record.rollbackImageSafety=protectImageRollback(nativeVoice,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 record.rollbackSongSafety=protectSongRollback(nativeVoice,restored,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 record.rollbackQQSocialSafety=protectQQSocialRollback(nativeVoice,lock.plugins['whalenest.runtime.deepseek-harness'].version);
 if(record.rollbackVoiceSafety.disableNativeVoice||record.rollbackImageSafety.disableImages||record.rollbackQQSocialSafety.disableAutomaticSocial||record.rollbackSongSafety.disableSinging)writeState(nativeVoicePath,nativeVoice);
 writeState(record.instancePath,restored);
 writeState(record.lockFile,lock);
 if(existsSync(join(instance.dataDir,'runtime.lock')))recoverLease(instance);
 if(record.connector){
  for(const file of record.launcherSupport??[])if(file.changed){
   const actual=existsSync(file.path)?createHash('sha256').update(readFileSync(file.path)).digest('hex'):null;
   if(actual===file.beforeSha256)continue;
   assert.equal(actual,file.sha256,'Startup support changed after deployment; rollback withheld');
   if(file.existed)copyFileSync(join(record.backup,file.path.slice(home.length+1)),file.path);else rmSync(file.path);
  }
  if(record.launcher){
   if(record.launcher.backup)copyFileSync(record.launcher.backup,record.launcher.path);
   else rmSync(record.launcher.path,{force:true});
  }
  for(const path of [record.connector.pointer,record.connector.supervisorFile]) {
   const previous=join(record.backup,path.slice(home.length+1));
   if(existsSync(previous))copyFileSync(previous,path);else rmSync(path,{force:true});
  }
  if(record.supervisorChanged===false&&!record.livewarePrograms?.length)supervisor('start');else startAfterReload();
 }else if(record.livewarePrograms?.length)startAfterReload();else supervisor('start');
 await ready();
 if(restoreLaunchers){
  const result=await restoreLaunchers(restored,{exposureStopped:true});
  record.managedLivewareRollback=result;writeState(recordFile,record);
  assert.ok(result.ok,'Liveware launcher rollback has an unconfirmed result; retained for reconciliation');
 }
 record.state='rolled-back';record.rolledBackAt=new Date().toISOString();writeState(recordFile,record);
}
if(action==='rollback'){const record=read(recordFile);await rollback(record);console.log(JSON.stringify({state:record.state,newDataPreserved:true}));process.exit(0);}
const beforeHealth=await ready(),beforeState=platformState();
const {workspace}=await import(pathToFileURL(join(dirname(connectBin),'runtime/lib.mjs')));
const platformRoot=join(home,'.clawnest-integrations/deepseek-harness');
const officialBase=withMediaCore?(explicitOfficialBase??join(platformRoot,'releases',read(join(platformRoot,'state.json')).selected)):undefined;
const officialPlan=explicitOfficialBase?officialCutover.inspect(officialBase):null;
const plan=inspectRuntimeUpgrade({root,home,workspace,health:beforeHealth,state:beforeState,targetVersion:distributionVersion,officialBase});
for(const {file} of livewarePrograms)if(existsSync(file))plan.inputs[file]=createHash('sha256').update(readFileSync(file)).digest('hex');
if(withMediaCore){
 plan.inputs[releaseLauncher]=createHash('sha256').update(readFileSync(releaseLauncher)).digest('hex');
 if(existsSync(installedLauncher))plan.inputs[installedLauncher]=createHash('sha256').update(readFileSync(installedLauncher)).digest('hex');
}
if(runtimeBundle){
 plan.summary.bundle=inspectPreparedRuntimeBundle(runtimeBundle,distributionVersion);
 plan.inputs[runtimeBundle]=plan.summary.bundle.sha256;
}
const stickerCatalog=stickerCatalogPath?verifyStickerCatalog(stickerCatalogPath):null;
if(stickerCatalog){
 assert.ok(!plan.alreadyActive,'Catalog installation requires a version cutover');
 plan.inputs[stickerCatalogPath]=stickerCatalog.manifestSha256;
 plan.summary.stickerCatalog={count:stickerCatalog.entries.length,bytes:stickerCatalog.bytes};
}
let connector;
let officialExposureCandidate;
if(withMediaCore){
 connector=prepareConnectorExtension({home,baseDirectory:officialBase,
  binary:join(coreBuildDirectory,'clawchat-connect'),manifestFile:join(coreBuildDirectory,'manifest.json'),skillsDirectory:join(coreBuildDirectory,'skills'),
  liveware:withRealtime||withSongLiveware||plan.instance.realtime?.enabled===true||plan.instance.singing?.playback?.enabled===true,
  voice:withRealtime||plan.instance.realtime?.enabled===true});
 if(connector.managedLiveware){
  const names=Object.keys(connector.fileIntegrity).filter(name=>/^official-plugins\/clawling\.exposure\.liveware-.*\.connect-plugin$/.test(name));
  assert.equal(names.length,1,'Exactly one verified official Exposure bundle is required');
  const bundlePath=join(connector.directory,names[0]),bundle=read(bundlePath);
  assert.equal(bundle.manifest.pluginId,'clawling.exposure.liveware');
  const artifact=bundle.manifest.artifacts.find(artifact=>artifact.target==='linux-x64');
  assert.ok(artifact?.integrity,'Official Exposure Linux artifact is missing');
  officialExposureCandidate={bundlePath,integrity:artifact.integrity};
  plan.inputs[bundlePath]=createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
 }
 assert.equal(JSON.parse(run(join(connector.directory,'clawchat-connect'),['skills','preflight'])).ready,true,'Connector managed skills preflight failed');
 const compatibilityState=JSON.parse(run(join(connector.directory,'clawchat-connect'),['__clawnest-state','--config',configFile]));
 assert.equal(compatibilityState.ownerId,beforeState.ownerId,'Native platform state command compatibility failed');
 const updaterProbe=mkdtempSync(join(privateRoot,'updater-preflight-'));
 try {
  mkdirSync(join(updaterProbe,'target'));writeState(join(updaterProbe,'receipt.json'),{});
  const {syncUpdaterSkill}=await import(pathToFileURL(join(connector.baseDirectory,'runtime/update-skill.mjs')));
  syncUpdaterSkill(join(connector.directory,'updater-skill'),join(updaterProbe,'target'),join(updaterProbe,'receipt.json'));
 }finally{rmSync(updaterProbe,{recursive:true,force:true});}
 verifyInstalledConnector(connector);
 for(const [name,hash]of Object.entries(connector.fileIntegrity??{}))plan.inputs[join(connector.directory,name)]=hash;
 for(const path of [connector.pointer,connector.supervisorFile])if(existsSync(path))plan.inputs[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
}
const launcherSupport=connector?['src/connector-extension.mjs','src/connector-startup.mjs','src/connector-cutover.mjs','src/clawchat-core.mjs','src/clawchat-state.mjs','src/liveware-migration.mjs','src/liveware-command.mjs','src/routing.mjs','src/runtime-upgrade.mjs','src/plugin-release.mjs','src/recovery.mjs','src/state.mjs','src/voice-model.mjs','scripts/update-m2.mjs','scripts/probe-live.mjs','scripts/build-runtime-base.mjs','integration/clawchat/SOURCE.json','integration/clawchat/core-media/SOURCE.json'].map(name=>{
 const source=fileURLToPath(new URL('../'+name,import.meta.url)),path=join(root,name),existed=existsSync(path);
 const sha256=createHash('sha256').update(readFileSync(source)).digest('hex');
 plan.inputs[source]=sha256;if(existed)plan.inputs[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
 return {source,path,sha256,existed,beforeSha256:existed?plan.inputs[path]:null,changed:source!==path&&(!existed||plan.inputs[path]!==sha256)};
}):[];
const startupPlan=connector?inspectConnectorStartup(plan.instance,{migrateProfile:true}):null;
if(startupPlan)plan.inputs[startupPlan.profileFile]=startupPlan.beforeSha256;
if(officialPlan)Object.assign(plan.inputs,officialPlan.inputs);
if(connector){
 const activeFile=join(plan.instance.dataDir,'connector-override.json');
 const active=existsSync(activeFile)?read(activeFile):null;
 plan.alreadyActive=plan.alreadyActive&&active?.directory===connector.directory&&active.baseDirectory===connector.baseDirectory&&!startupPlan?.changed&&!launcherSupport.some(file=>file.changed)&&(!officialPlan||officialPlan.fromId===officialPlan.targetId);
 plan.summary.action=plan.alreadyActive?'already-active':'ready-to-prepare';
 plan.summary.connector={from:active?.version,to:connector.version,baseVersion:connector.baseVersion,allFilesVerified:true};
}
if(officialPlan)plan.summary.officialConnector={from:officialPlan.fromVersion,to:officialPlan.targetVersion,assetsStaged:true,selectionChanged:false};
if(action==='install'&&!plan.alreadyActive)assert.ok(runtimeBundle,'Build the Linux package off-instance and pass --runtime-bundle');
writeState(join(privateRoot,'preflight.json'),{...plan.summary,at:new Date().toISOString()});
if(plan.alreadyActive&&withMediaCore){
 assert.ok(plan.instance.clawchat?.delivery?.mediaEnabled,'Runtime is active but media delivery is disabled');
 const activeExtension=read(join(home,'.dsh/companion/aurabot-v1/connector-override.json'));
 assert.equal(dirname(plan.connectBin),activeExtension.directory,'The active connector differs from the media extension');
 assert.equal(JSON.parse(run(plan.connectBin,['tool','describe','clawchat_send_media'])).name,'clawchat_send_media','Media connector entry missing');
}
if(plan.alreadyActive&&withActivities)assert.ok(plan.instance.activities?.enabled,'Installed runtime has not enabled manual activities');
if(plan.alreadyActive&&withExpressions)assert.ok(plan.instance.expressions?.enabled,'Installed runtime has not enabled expressions');
if(plan.alreadyActive&&withSpeech)assert.ok(plan.instance.speech?.enabled&&plan.instance.speech?.asrModel&&plan.instance.speech?.ttsModel,'Installed runtime has not enabled speech');
if(plan.alreadyActive&&withImages)assert.ok(plan.instance.image?.enabled&&plan.instance.image.model,'Installed runtime has not enabled images');
if(plan.alreadyActive&&withSongs)assert.ok(plan.instance.singing?.enabled,'Installed runtime has not enabled platform singing');
if(plan.alreadyActive&&withSongLiveware){assert.ok(plan.instance.singing?.playback?.enabled,'Installed runtime has not enabled Song Liveware');await songPageReady(plan.instance.singing.playback.port??8898);}
if(withRealtime||plan.instance.realtime?.enabled===true){
 const python=plan.instance.realtime?.python??'python3';
 run(python,['-c','import sqlite3,sys; sys.exit(int(sys.version_info < (3, 11)))'],10000);
 if(plan.alreadyActive){assert.ok(plan.instance.realtime?.enabled,'Installed runtime has not enabled realtime calls');await callReady(plan.instance.realtime.port??8897);}
}
if(plan.alreadyActive&&withQQModules)assert.ok(plan.instance.qq?.nativeModules,'Installed runtime has not prepared original QQ modules');
if(plan.alreadyActive)plan.summary.livewareRoutes=await livewareReady(plan.instance);
if(action==='preflight'||plan.alreadyActive){console.log(JSON.stringify(plan.summary));process.exit(0);}
const backup=join(home,'.local/share/whale-nest/backups',new Date().toISOString().replace(/[:.]/g,'')+'-before-m2-live');
mkdirSync(backup,{recursive:true,mode:0o700});
for(const file of Object.keys(plan.inputs).filter(path=>path.startsWith(home+'/')&&!path.includes('/.whale-nest/'))){
 const dest=join(backup,file.slice(home.length+1));mkdirSync(dirname(dest),{recursive:true,mode:0o700});copyFileSync(file,dest);
}
const candidate={...plan.instance,
 media:{maxCount:4,maxBytesEach:16*1024*1024,maxBytesTotal:32*1024*1024,...plan.instance.media},
 speech:{enabled:false,provider:'clawling',providerConfigPath:join(home,'.clawchat-dsh/config.json'),asrModel:'fun-asr-flash',ttsModel:'',...plan.instance.speech}};
delete candidate.management;
if(withSpeech)candidate.speech=enablePlatformSpeech(candidate.speech);
if(withImages)candidate.image=enablePlatformImage({providerConfigPath:candidate.speech.providerConfigPath,...candidate.image});
if(withSongs||withSongLiveware)candidate.singing=enablePlatformSinging({providerConfigPath:candidate.speech.providerConfigPath,...candidate.singing});
if(withSongLiveware)candidate.singing.playback={port:8898,...candidate.singing.playback,enabled:true};
if(withRealtime)candidate.realtime={port:8897,...candidate.realtime,...(realtimeOrigin?{publicOrigin:realtimeOrigin}:{}),enabled:true};
if(withQQModules)candidate.qq={...candidate.qq,nativeModules:true};
if(withActivities)candidate.activities={automatic:false,maxDailyBackgroundModelCalls:0,...candidate.activities,enabled:true};
if(withExpressions)candidate.expressions={...candidate.expressions,enabled:true};
if(connector)candidate.clawchat={...candidate.clawchat,delivery:{...candidate.clawchat.delivery,connectBin:join(connector.directory,'clawchat-connect'),mediaEnabled:true}};
assert.ok(existsSync(candidate.speech.providerConfigPath),'Speech provider configuration missing');
const staged=join(privateRoot,'candidate.json');writeState(staged,candidate);
plan.inputs[staged]=createHash('sha256').update(readFileSync(staged)).digest('hex');
if(probePrompts)plan.inputs[probePrompts]=createHash('sha256').update(readFileSync(probePrompts)).digest('hex');
const record={state:'prepared',at:new Date().toISOString(),backup,version:distributionVersion,sourceRuntime:plan.selected.version,
 configFile:plan.configFile,lockFile:plan.lockFile,instancePath:plan.instancePath,accountBindingChanged:false,qqBound:false,...(officialPlan?{officialCutover:officialPlan}:{}),...(startupPlan?{startupPlan}: {})};
const enabledPrograms=livewarePrograms.filter(({kind})=>kind==='call'?candidate.realtime?.enabled:candidate.singing?.playback?.enabled);
const serviceEntry=join(root,'src/liveware-service.mjs');
if(enabledPrograms.length){
 assert.ok(existsSync(serviceEntry),'Liveware service entry is missing');
 assert.ok([process.execPath,serviceEntry,plan.instancePath].every(value=>!/[\s"']/.test(value)), 'Liveware service paths require shell-safe names');
}
if(connector){record.connector=connector;record.launcherSupport=launcherSupport;for(const path of [connector.pointer,connector.supervisorFile])if(existsSync(path)){const destination=join(backup,path.slice(home.length+1));mkdirSync(dirname(destination),{recursive:true,mode:0o700});copyFileSync(path,destination);}}
const supervisorConfig=connector?'[program:dsh-agent]\ncommand='+process.execPath+' '+installedLauncher
 +'\ndirectory='+candidate.cwd+'\nautostart=true\nautorestart=true\nredirect_stderr=true\n'
 +'stdout_logfile=/tmp/dsh-agent.log\nstdout_logfile_maxbytes=1MB\n'
 +'stopasgroup=true\nkillasgroup=true\nstopwaitsecs=20\n':null;
if(connector&&releaseLauncher!==installedLauncher){
 const launcherBackup=existsSync(installedLauncher)?join(backup,'serve-media-before.mjs'):null;
 if(launcherBackup)copyFileSync(installedLauncher,launcherBackup);
 record.launcher={path:installedLauncher,backup:launcherBackup};
}
if(connector)record.supervisorChanged=!existsSync(connector.supervisorFile)||readFileSync(connector.supervisorFile,'utf8')!==supervisorConfig;
writeState(recordFile,record);
console.log(JSON.stringify({phase:'prepared',version:distributionVersion,backup}));
let stopped=false,cutoverStarted=false;
try{
 const immediate=platformState();assert.equal(immediate.running,0,'A turn is active');assert.equal(immediate.queued,0,'Input is queued');verifyLiveInputs(plan);
 for(const file of launcherSupport)assert.equal(existsSync(file.path),file.existed,'A startup support path changed after preflight');
 supervisor('stop');stopped=true;
 await waitForSdkExit(candidate);
 const freeze=reserveSnapshot(backup);record.finalSnapshot=freeze;
 cpSync(candidate.dataDir,join(freeze,'companion'),{recursive:true,verbatimSymlinks:true});
 for(const name of ['sessions','storages'])cpSync(join(home,'.dsh',name),join(freeze,name),{recursive:true,verbatimSymlinks:true});
 cutoverStarted=true;
 if(officialPlan){record.officialPhase='selecting';writeState(recordFile,record);record.officialSelection=officialCutover.select(officialPlan);record.officialPhase='selected';writeState(recordFile,record);}
 if(startupPlan){record.startupPreparation=prepareConnectorStartup(candidate,{migrateProfile:true,expectedProfileSha256:startupPlan.beforeSha256});writeState(recordFile,record);}
 copyFileSync(staged,plan.instancePath);
 if(connector){
  for(const file of launcherSupport)if(file.changed){
   mkdirSync(dirname(file.path),{recursive:true,mode:0o700});const temporary=file.path+'.whalenest-candidate';
   try{copyFileSync(file.source,temporary);assert.equal(createHash('sha256').update(readFileSync(temporary)).digest('hex'),file.sha256);renameSync(temporary,file.path);}
   finally{rmSync(temporary,{force:true});}
  }
  if(record.launcher){
   mkdirSync(dirname(installedLauncher),{recursive:true,mode:0o700});
   copyFileSync(releaseLauncher,installedLauncher);
  }
  writeState(connector.pointer,connector);
  const launchConfig=read(plan.configFile);
  launchConfig.agents.dsh.runtime={pluginId:'whalenest.runtime.deepseek-harness',capabilityId:'deepseek-harness'};
  launchConfig.agents.dsh.runtimeConfig.executablePathOverride=join(connector.directory,'runtime/dsh-bridge.sh');
  writeState(plan.configFile,launchConfig);
  if(record.supervisorChanged){
   mkdirSync(dirname(connector.supervisorFile),{recursive:true,mode:0o700});
   writeFileSync(connector.supervisorFile,supervisorConfig,{mode:0o600});
  }
 }
 const priorLock=read(plan.lockFile),previous=priorLock.plugins['whalenest.runtime.deepseek-harness'];
 delete priorLock.plugins['whalenest.runtime.deepseek-harness'];writeState(plan.lockFile,priorLock);
 run(connectBin,['plugin','install',runtimeBundle,'--config',configFile],30000);
 const next=read(plan.lockFile),installed=next.plugins['whalenest.runtime.deepseek-harness'];
 const keys=['source','version','target','integrity','activeArtifact','manifestPath','manifest','installationConfiguration','capabilityConfigurations'];
 installed.retainedVersions=[...(previous.retainedVersions??[]),Object.fromEntries(keys.map(k=>[k,previous[k]]))];installed.activationGeneration=previous.activationGeneration+1;
 assert.equal(installed.version,distributionVersion);
 writeState(plan.lockFile,next);
 if(connector)run(process.execPath,[join(connector.directory,'runtime/cli.mjs'),'init'],20000);
 if(existsSync(join(candidate.dataDir,'runtime.lock')))recoverLease(candidate);
 if(stickerCatalog)record.stickerCatalog=await importStickerCatalog(stickerCatalog,candidate.dataDir);
 record.state='configured';writeState(recordFile,record);
 const probe=join(privateRoot,'native-probe.json');
 run(process.execPath,[fileURLToPath(new URL('./probe-live.mjs',import.meta.url)),plan.instancePath,join(dirname(installed.activeArtifact),'deepseek-harness-bridge.mjs'),probe,...(probePrompts?[probePrompts]:[])],probePrompts?240000:45000);
 record.nativeProbe=read(probe);
 // The probe has exited and the supervisor is still stopped. Its shutdown may
 // require forced termination; archive only a verified dead owner's lease.
 await waitForSdkExit(candidate);
 if(existsSync(join(candidate.dataDir,'runtime.lock')))recoverLease(candidate);
 record.livewarePrograms=[];
 for(const program of enabledPrograms){
  const contents='[program:'+program.name+']\ncommand='+[process.execPath,serviceEntry,program.kind,plan.instancePath].join(' ')
   +'\nautostart=true\nautorestart=true\n';
  if(!existsSync(program.file)||readFileSync(program.file,'utf8')!==contents){
   record.livewarePrograms.push(program);
   writeState(recordFile,record);
   mkdirSync(dirname(program.file),{recursive:true,mode:0o700});
   writeFileSync(program.file,contents,{mode:0o600});
  }
 }
 if(connector?.managedLiveware){record.managedExposureAttempted=true;writeState(recordFile,record);}
 if(record.supervisorChanged||record.livewarePrograms.length)startAfterReload();else supervisor('start');stopped=false;
 const current=await ready();assert.deepEqual(current.identity,beforeHealth.identity,'Connection identity changed');
 if(connector?.managedLiveware){
  record.managedExposureAttempted=true;writeState(recordFile,record);
  // The official public operation activates Exposure only after the native
  // runtime and its own managed entry are installed and connected.
  const officialExposure=read(plan.lockFile).plugins['clawling.exposure.liveware'];
  assert.ok(officialExposure,'Official Liveware Exposure is not installed');
  if(officialExposure.integrity!==officialExposureCandidate.integrity||
      officialExposure.capabilityConfigurations?.liveware?.accessPolicy!=='private'){
   const configuration={...officialExposure.capabilityConfigurations,liveware:{accessPolicy:'private'}};
   run(join(connector.directory,'clawchat-connect'),['plugin','replace','clawling.exposure.liveware',officialExposureCandidate.bundlePath,
    '--capability-config-json',JSON.stringify(configuration),'--config',configFile],60000);
  }
  if(read(plan.lockFile).plugins['clawling.exposure.liveware'].status!=='active')
   run(join(connector.directory,'clawchat-connect'),['plugin','enable','clawling.exposure.liveware','--config',configFile],60000);
  const enabled=read(plan.lockFile).plugins['clawling.exposure.liveware'];
  assert.equal(enabled.status,'active','Official Liveware Exposure did not activate');
  assert.equal(enabled.capabilityConfigurations?.liveware?.accessPolicy,'private');
  assert.equal(enabled.integrity,officialExposureCandidate.integrity,'The running official Exposure is not from the verified target bundle');
 }
 if(officialPlan)record.officialVerified=officialCutover.verify(officialPlan,beforeHealth.identity);
 if(candidate.realtime?.enabled){
  await callReady(candidate.realtime.port??8897);
  const session=await fetch('http://127.0.0.1:'+voiceSessionPort(candidate)+'/voice/v1/settings',{
   headers:{'X-Voice-Secret':readFileSync(join(candidate.dataDir,'realtime/session-secret'),'utf8')},signal:AbortSignal.timeout(5000),
  });
  assert.ok(session.ok,'The original private Session bridge did not start');
  record.realtimeCall={enabled:true,port:candidate.realtime.port??8897,interface:'private-liveware'};
 }
 if(candidate.singing?.playback?.enabled){await songPageReady(candidate.singing.playback.port??8898);record.songPlayback={enabled:true,port:candidate.singing.playback.port??8898};}
 record.livewareRoutes=await livewareReady(candidate);
 assert.ok(installed.manifest.capabilities.every(c=>c.type==='runtime'||c.type==='managed-web-app'&&c.id==='whalenest-liveware'),'Unexpected standalone page capability');
 record.state='active';record.deployedAt=new Date().toISOString();record.ready=true;record.connected=true;record.independentPage=false;
 record.independentLiveware=enabledPrograms.map(program=>program.name);
 writeState(recordFile,record);
 console.log(JSON.stringify({phase:'active',version:distributionVersion,ready:true,connected:true,independentPage:false,originalSessionPreserved:true,stickerCatalog:record.stickerCatalog}));
}catch(error){
 writeFileSync(join(privateRoot,'last-error.private.log'),(error.stack??String(error))+'\n'+(error.stderr?.toString()??'')+'\n'+(error.stdout?.toString()??''),{mode:0o600});
 record.failure=error.code??error.name;writeState(recordFile,record);
 if(cutoverStarted)await rollback(record);
 else if(stopped){await waitForSdkExit(candidate);supervisor('start');await ready();}
 throw Error('M2 update failed; see private deployment receipt');
}
