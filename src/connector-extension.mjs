import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,chmodSync,existsSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {writeState} from './state.mjs';
import {fastVoiceModel} from './voice-model.mjs';

export const coreCommit='b540bc211dc924d0200e6f71c18082de490d68f4';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=path=>digest(readFileSync(path));
const runtimeModelSourceSha256='153b3200aa410a4fc0d228cfada2d97b138d0c9e96ebd707321939365b1cdde2';
function modelConversion(source,voice){
 assert.equal(digest(source),runtimeModelSourceSha256,'Runtime model source changed; review the host conversion before installing');
 const before='id:m.id,name:m.name||m.id,contextWindow:';
 assert.equal(source.split(before).length,2,'Runtime model conversion source must match once');
 const input=source.replace(before,'id:m.id,name:m.name||m.id,...(m.input===undefined?{}:{input:m.input}),contextWindow:');
 if(!voice)return input;
 const anchor=' writeJSON(modelPatch,[';
 assert.equal(input.split(anchor).length,2,'Runtime provider settings must match once');
 const route=JSON.stringify(fastVoiceModel.provider),id=JSON.stringify(fastVoiceModel.model);
 return input.replace(anchor,` const voiceProvider=nativeProviders.clawling;
 const voiceModel=voiceProvider?.models.find(item=>item.id===${id});
 if(voiceModel&&voiceProvider.api==='openai-completions'&&!Object.hasOwn(nativeProviders,${route}))
  nativeProviders[${route}]={...voiceProvider,compat:{thinkingFormat:'deepseek'},models:[{
   ...voiceModel,reasoningEfforts:{off:null,low:'low'}
  }]};
${anchor}`);
}
export function verifiedLivewareCompanion(home,baseDirectory){
 const integration=read(join(baseDirectory,'integration.json'));
 const entry=integration.files.find(f=>/^official-plugins\/clawling\.exposure\.liveware-.*\.connect-plugin$/.test(f.path));assert.ok(entry,'Official Liveware bundle missing');
 const bundleFile=join(baseDirectory,entry.path);assert.equal(sha(bundleFile),entry.sha256,'Official Liveware bundle changed');
 const bundle=read(bundleFile),file=bundle.files?.['assets/liveware'];assert.ok(file?.content,'Official Liveware companion missing');
 const bytes=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');
 const plugin=read(join(home,'.clawchat-connect/plugins.lock.json')).plugins['clawling.exposure.liveware'];assert.ok(plugin?.manifestPath,'Official Liveware companion installation missing');
 const path=join(dirname(plugin.manifestPath),'assets/liveware');assert.equal(sha(path),digest(bytes),'Installed Liveware companion changed');
 return {path,sha256:digest(bytes)};
}
export function prepareConnectorExtension({home,binary,manifestFile,baseDirectory,skillsDirectory,realtime=false,liveware=realtime,voice=false}) {
 const build=read(manifestFile),base=read(join(baseDirectory,'integration.json')),source=read(join(baseDirectory,'source.json'));
 assert.equal(source.connect_commit,coreCommit,'Actual integration source changed');assert.equal(build.upstreamCommit,coreCommit,'Core patch must match the actual source');
 assert.equal(sha(binary),build.binarySha256,'Core build integrity mismatch');
 const original=base.files.find(f=>f.path==='clawchat-connect');assert.equal(sha(join(baseDirectory,'clawchat-connect')),original.sha256,'Official Core was modified');
 const skillManifest=join(skillsDirectory,'manifest.json'),skills=read(skillManifest);
 assert.equal(skills.connectVersion,build.version,'Bundled skills version mismatch');
 for(const [file,digest]of Object.entries(skills.files)){assert.ok(!file.split('/').includes('..')&&!file.startsWith('/'),'Unsafe bundled skill');assert.equal(sha(join(skillsDirectory,file)),digest,'Bundled skill integrity mismatch');}
 // The reviewed host drops model.input when generating the native DSH patch.
 // Preserve only explicit declarations in our copy; the signed base stays intact.
 const runtimeLib=modelConversion(readFileSync(join(baseDirectory,'runtime/lib.mjs'),'utf8'),voice);
 const runtimeLibSha256=digest(runtimeLib);
 const livewareCompanion=liveware?verifiedLivewareCompanion(home,baseDirectory):null;
 const directory=join(home,'.local/share/whale-nest/connectors',build.version+'-'+build.binarySha256.slice(0,12)+'-'+sha(skillManifest).slice(0,8)+'-layout4-input1'+(liveware?'-liveware1':'')+(voice?'-voice1':''));
 if(!existsSync(directory)) {
  mkdirSync(directory,{recursive:true,mode:0o700});copyFileSync(binary,join(directory,'clawchat-connect-core'));chmodSync(join(directory,'clawchat-connect-core'),0o755);
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const launcher='#!/bin/sh\n'+(livewareCompanion?'export CLAWCHAT_CONNECT_LIVEWARE_PATH='+quote(livewareCompanion.path)+'\n':'')+'case "$1" in\n__clawnest-state|__clawnest-owner) exec '+quote(join(baseDirectory,'clawchat-connect'))+' "$@" ;;\n*) exec '+quote(join(directory,'clawchat-connect-core'))+' "$@" ;;\nesac\n';
  writeFileSync(join(directory,'clawchat-connect'),launcher,{mode:0o755});
  cpSync(join(baseDirectory,'runtime'),join(directory,'runtime'),{recursive:true});
  writeFileSync(join(directory,'runtime/lib.mjs'),runtimeLib,{mode:0o600});
  cpSync(skillsDirectory,join(directory,'skills'),{recursive:true});
  for(const name of ['official-plugins','updater-skill'])cpSync(join(baseDirectory,name),join(directory,name),{recursive:true});
 }
 assert.equal(sha(join(directory,'clawchat-connect-core')),build.binarySha256,'Installed extension integrity mismatch');
 assert.equal(sha(join(directory,'skills/manifest.json')),sha(skillManifest),'Installed skills manifest changed');
 assert.equal(sha(join(directory,'runtime/lib.mjs')),runtimeLibSha256,'Installed runtime model integrity mismatch');
 const pointer=join(home,'.dsh/companion/aurabot-v1/connector-override.json');
 const record={schema:1,baseDirectory,baseVersion:base.version,baseReleaseId:baseDirectory.split('/').at(-1),upstreamCommit:coreCommit,directory,binarySha256:build.binarySha256,version:build.version,
  launcherSha256:sha(join(directory,'clawchat-connect')),runtimeLibSha256,runtimeInputPatch:'input.1',...(livewareCompanion?{livewareCompanion}:{}),pointer,supervisorFile:join(home,'.clawling/supervisord/whalenest-media.conf')};
 writeState(join(directory,'extension.json'),record);return record;
}

export function extensionHostConfig(config,record) {
 return {...config,entries:{...config.entries,agent:relative(record.baseDirectory,join(record.directory,'runtime/cli.mjs'))}};
}
