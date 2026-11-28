import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {queryPlatformPlugins} from './platform-query.mjs';
import {readState,writeState} from './state.mjs';

const ownId='whalenest.runtime.deepseek-harness';
export const installationFile=options=>join(options.dataDir,'installation.json');
export function platformCommand(options,args,{run=execFileSync}={}){
 const delivery=options.clawchat?.delivery??options;
 assert.ok(isAbsolute(delivery.connectBin)&&isAbsolute(delivery.configPath),'Public platform executable and configuration are required');
 return run(delivery.connectBin,[...args,'--config',delivery.configPath],{cwd:options.cwd,encoding:'utf8',timeout:12000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:delivery.configPath}});
}
export const platformConfig=(options,ports)=>JSON.parse(platformCommand(options,['config','get'],ports));
export const platformState=(options,ports)=>JSON.parse(platformCommand(options,['__clawnest-state'],ports));

export function platformPlugins(options,{run=execFileSync}={}){
 const node=process.versions.bun?(process.env.WHALENEST_NODE_EXECUTABLE??'/usr/local/bin/node'):process.execPath;
 const configPath=options.clawchat?.delivery?.configPath??options.configPath;assert.ok(isAbsolute(configPath??''));
 const bytes=run(node,[fileURLToPath(new URL('./platform-query.mjs',import.meta.url)),configPath],{
  cwd:options.cwd,encoding:'utf8',timeout:7000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
  env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',BUN_OPTIONS:''},
 });
 const rows=JSON.parse(bytes);assert.ok(Array.isArray(rows),'Invalid structured plugin metadata');return rows;
}
export function installedPlugin(options,id=ownId,ports){
 return selectInstalledPlugin(options,platformPlugins(options,ports),id);
}
export async function installedPluginAsync(options,id=ownId,ports){
 const configPath=options.clawchat?.delivery?.configPath??options.configPath;
 return selectInstalledPlugin(options,await queryPlatformPlugins(configPath,ports),id);
}
function selectInstalledPlugin(options,metadata,id){
 const rows=metadata.filter(row=>row.pluginId===id);
 assert.ok(rows.length<=1,'Conflicting plugin identities');const selected=rows[0];if(!selected)return null;
 assert.ok(['version','target','integrity','status'].every(key=>typeof selected[key]==='string'&&selected[key]),'Incomplete structured plugin metadata');
 assert.ok(selected.source&&typeof selected.source.type==='string','Missing public plugin source');
 const owned=readState(installationFile(options),null);
 if(id===ownId&&owned?.version===selected.version&&(!selected.activeArtifact||selected.activeArtifact===owned.entryPath)
   &&(!owned.integrity||owned.integrity===selected.integrity)){
  const source=readState(join(options.dataDir,'source-candidate.json'),null);
  const generation=selected.activationGeneration??owned.activationGeneration;
  const matches=source?.target?.version===selected.version&&source.target.integrity===selected.integrity&&source.target.activationGeneration===generation;
  return {...selected,activationGeneration:generation,activeArtifact:selected.activeArtifact??owned.entryPath,manifestPath:installationFile(options),ownedRoot:owned.root,bootstrapRoot:owned.projectRoot,...(matches?{ownedSourceRoot:source.root}:{})};
 }
 return selected;
}

/** Bootstrap module selection only. Actual platform operations and update
 * admission still query the live manager. A cold Core cannot query itself. */
export function registeredRuntime(options){
 const own=readState(installationFile(options),null);if(!own)return null;
 assert.ok(isAbsolute(own.root??'')&&isAbsolute(own.entryPath??'')&&own.version,'Invalid own runtime registration');
 const integrity=own.integrity??'sha256-'+createHash('sha256').update(readFileSync(own.entryPath)).digest('base64');
 return {pluginId:ownId,status:'active',version:own.version,integrity,activationGeneration:own.activationGeneration,
  activeArtifact:own.entryPath,ownedRoot:own.root,bootstrapRoot:own.projectRoot};
}

/** Only our package records its own locations, using the public activation generation.
 * No path is discovered from the connector's private installation ledger. */
export function registerInstallation(options,context,{root,entryPath,version}={}){
 if(!Number.isSafeInteger(context?.activationGeneration))return;
 const old=readState(installationFile(options),null);
 root??=old?.root;entryPath??=old?.entryPath;version??=old?.version;
 assert.ok(isAbsolute(root??'')&&isAbsolute(entryPath??'')&&version,'Our installation location must be prepared before activation');
 const integrity='sha256-'+createHash('sha256').update(readFileSync(entryPath)).digest('base64');
 const next={schema:1,pluginId:ownId,root,entryPath,version,integrity,activationGeneration:context.activationGeneration,...(old?.projectRoot?{projectRoot:old.projectRoot}:{})};
 if(JSON.stringify(old)!==JSON.stringify(next))writeState(installationFile(options),next);
 return next;
}
export function ownRoot(options,entry=registeredRuntime(options)){
 assert.ok(entry?.status==='active'&&isAbsolute(entry.ownedRoot??''),'Our current installation has not registered its own code');
 return entry.ownedRoot;
}
