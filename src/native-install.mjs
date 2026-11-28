import {activeCall} from './call-state.mjs';
import {programFiles,retiredProgramFiles,syncBootstrap} from './bootstrap-deployment.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,copyFileSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {platformConfig,platformState,installedPlugin,installationFile} from './platform-client.mjs';
import {createClawChatCore} from './clawchat-core.mjs';
import {sdkProcesses,waitForSdkExit} from './recovery.mjs';
import {probeRuntimeReady} from './runtime-activation.mjs';
import {inspectPreparedRuntimeBundle} from './live-update.mjs';
import {workspaceInstructionsSource,planWorkspaceInstructions,applyWorkspaceInstructions} from './workspace-instructions.mjs';
const id='whalenest.runtime.deepseek-harness',read=p=>JSON.parse(readFileSync(p)),sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export const launcherFiles=programFiles();
export function inspectNativeInstall(options,bundlePath,projectRoot,{run=execFileSync}={}){
 assert.ok(isAbsolute(bundlePath)&&isAbsolute(projectRoot));
 const bundle=read(bundlePath);inspectPreparedRuntimeBundle(bundlePath,bundle.manifest.version);
 const state=platformState(options,{run});assert.ok(state.available&&state.connected&&state.running===0&&state.queued===0&&!activeCall(options)&&state.ownerId===options.clawchat.route.sender&&state.conversationId===options.clawchat.route.conversation,'Original conversation must be healthy, owned and idle');
 const config=platformConfig(options,{run}),selected=installedPlugin(options,id,{run});
 assert.equal(config.agents?.[options.clawchat.route.account]?.runtime?.pluginId,id,'Update the existing Whale binding only');
 assert.ok(selected?.status==='active','Whale plugin is not active');
 for(const name of launcherFiles)assert.ok(bundle.files['artifacts/whalenest/'+name],'Bundle lacks launcher: '+name);
 const instructions=planWorkspaceInstructions(options,workspaceInstructionsSource({bundle}));
 return {instanceId:options.instanceId,version:bundle.manifest.version,bundlePath,sha256:sha(bundlePath),projectRoot,selected,config,instructions,
  selectionFingerprint:createHash('sha256').update(JSON.stringify([selected.version,selected.integrity,selected.source,config.agents])).digest('hex')};
}
function put(path,bytes,mode=0o600){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path+'.install.tmp',bytes,{flag:'wx',mode});renameSync(path+'.install.tmp',path);}
function snapshot(options,project,backup){
 mkdirSync(backup,{recursive:false,mode:0o700});const files=[join(options.dataDir,'instance.json'),installationFile(options),join(options.dataDir,'source-candidate.json'),...[...launcherFiles,...retiredProgramFiles].map(n=>join(project,n))];
 const record={instanceId:options.instanceId,project,files:[]};
 for(const [index,path]of files.entries()){
  const existed=existsSync(path);if(existed){assert.ok(!lstatSync(path).isSymbolicLink(),'Launcher/input must not be a symlink: '+path);copyFileSync(path,join(backup,String(index)));}
  record.files.push({path,index,existed,mode:existed?lstatSync(path).mode&0o777:0o600});
 }
 return record;
}
function restoreOwnFiles(backup,record){for(const f of record.files){if(f.existed)put(f.path,readFileSync(join(backup,String(f.index))),f.mode);else rmSync(f.path,{force:true});}}
export async function installNativePlugin(instancePath,bundlePath,projectRoot,{run=execFileSync}={}){
 const options=read(instancePath),plan=inspectNativeInstall(options,bundlePath,projectRoot,{run});
 const command=(bin,args,timeout=45000)=>run(bin,args,{cwd:options.cwd,encoding:'utf8',timeout,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
 const ctl=(verb,service)=>service==='whalenest-qq'&&verb==='stop'?command('/usr/bin/python3',[join(projectRoot,'deploy/stop-qq-desktop.py')],60000):command('/opt/clawnest/bin/supervisord',['ctl',verb,service]);
 const core=createClawChatCore(options),before=await core.state();assert.ok(before.connected&&before.available&&before.running===0&&before.queued===0&&!activeCall(options),'Original conversation must be healthy and idle');
 const backup=join(options.dataDir,'source-backups',new Date().toISOString().replaceAll(':','').replaceAll('.','')+'-native-install');mkdirSync(dirname(backup),{recursive:true,mode:0o700});
 let stopped=false,changed=false,record;
 try{
  const again=inspectNativeInstall(options,bundlePath,projectRoot,{run});assert.equal(again.selectionFingerprint,plan.selectionFingerprint);assert.equal(again.sha256,plan.sha256);
  stopped=true;for(const service of ['whalenest-qq','whalenest-call','whalenest-song','dsh-agent'])ctl('stop',service);
  await waitForSdkExit(options);
  record=snapshot(options,projectRoot,backup);record.previous=plan.selected;put(join(backup,'install.json'),JSON.stringify(record));
  const bundle=read(bundlePath),root=join(options.dataDir,'deployments',plan.version+'-'+plan.sha256.slice(0,16));assert.ok(!existsSync(root),'Use an already selected installation or a fresh deployment root');mkdirSync(root,{recursive:true,mode:0o700});
  for(const [name,f]of Object.entries(bundle.files)){
   if(!name.startsWith('artifacts/whalenest/'))continue;
   const relative=name.slice('artifacts/whalenest/'.length);assert.ok(relative&&!relative.split('/').some(p=>p==='..'||p==='.'||p===''));
   put(join(root,relative),Buffer.from(f.content,f.encoding==='base64'?'base64':'utf8'),relative.endsWith('.sh')?0o755:0o600);
  }
  symlinkSync('/opt/dsh/node_modules',join(root,'node_modules'),'dir');
  for(const name of launcherFiles)put(join(projectRoot,name),readFileSync(join(root,name)),name.endsWith('.sh')?0o755:0o600);
  syncBootstrap(options,{ownedRoot:root,bootstrapRoot:projectRoot});
  // Official replacement owns its own selection, retention and configuration.
  // The stopped manager has no HTTP API. Mark the attempted selection first:
  // a lost command acknowledgement must also restore the original selection.
  changed=true;command(options.clawchat.delivery.connectBin,['plugin','replace',id,bundlePath,'--offline','--config',options.clawchat.delivery.configPath],120000);
  put(installationFile(options),JSON.stringify({schema:1,pluginId:id,root,entryPath:join(root,'src/runtime-extension.mjs'),version:plan.version,activationGeneration:0,projectRoot}));
  options.clawchat.officialHost=true;put(instancePath,JSON.stringify(options));applyWorkspaceInstructions(plan.instructions);
  ctl('start','dsh-agent');for(const name of ['whalenest-call','whalenest-song'])ctl('start',name);
  for(let i=0;i<60;i++){try{const state=await core.state();if(await probeRuntimeReady(options)&&state.connected){assert.equal(state.userId,before.userId);assert.equal(state.ownerId,before.ownerId);assert.equal(state.conversationId,before.conversationId);break;}}catch{}if(i===59)throw Error('Updated native runtime did not become ready');await delay(1000);}
  const selected=installedPlugin(options,id,{run}),target=bundle.manifest.artifacts.find(a=>a.target==='linux-x64');
  assert.ok(selected?.version===plan.version&&selected.integrity===target.integrity,'Official replacement did not select the exact target');
  ctl('start','whalenest-qq');record.state='active';put(join(backup,'install.json'),JSON.stringify(record));return {state:'active',version:plan.version,backup};
 }catch(error){
  if(stopped){for(const name of ['whalenest-qq','whalenest-call','whalenest-song','dsh-agent'])try{ctl('stop',name);}catch{}await waitForSdkExit(options);
   if(changed)command(options.clawchat.delivery.connectBin,['plugin','select',id,plan.selected.version,'--integrity',plan.selected.integrity,'--config',options.clawchat.delivery.configPath],120000);
   if(record){restoreOwnFiles(backup,record);applyWorkspaceInstructions(planWorkspaceInstructions(options,workspaceInstructionsSource({installedRoot:plan.selected.ownedRoot})));}
   ctl('start','dsh-agent');for(const name of ['whalenest-call','whalenest-song','whalenest-qq'])ctl('start',name);
  }
  throw error;
 }
}
