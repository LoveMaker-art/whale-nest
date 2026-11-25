import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,chmodSync,existsSync,readdirSync,lstatSync,mkdtempSync,renameSync,rmSync} from 'node:fs';
import {join,dirname,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {writeState} from './state.mjs';

export const coreCommit='adfec616c51f61ee6cccf8ce08dd99b80c825c50';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=path=>digest(readFileSync(path));
const copiedDirectories=['runtime','official-plugins','updater-skill'];
const requiredRuntimeFiles=['cli.mjs','dsh-bridge.sh','greeting.mjs','lib.mjs','permission-mode.mjs','update-skill.mjs','browser-chat.mjs','browser-assistant-stream.mjs','web-activity.mjs','media-upload-url.mjs'];
const safePath=name=>typeof name==='string'&&name&&!name.includes('\\')&&!name.startsWith('/')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
function fileTree(directory,prefix='') {
 assert.ok(lstatSync(directory).isDirectory(),'Connector code directory must be a real directory: '+directory);
 const files={};
 for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
  const name=prefix?prefix+'/'+entry.name:entry.name,path=join(directory,entry.name);
  assert.ok(!entry.isSymbolicLink(),'Connector code must not contain symbolic links: '+name);
  if(entry.isDirectory())Object.assign(files,fileTree(path,name));
  else {assert.ok(entry.isFile(),'Connector code must be regular files: '+name);files[name]=sha(path);}
 }
 return files;
}
function verifiedBaseFiles(baseDirectory,base) {
 assert.ok(Array.isArray(base.files)&&base.files.length,'Official integration file manifest missing');
 const files={};
 for(const entry of base.files) {
  assert.ok(safePath(entry.path)&&/^[a-f0-9]{64}$/.test(entry.sha256),'Invalid official integration file record');
  assert.ok(!Object.hasOwn(files,entry.path),'Duplicate official integration file: '+entry.path);
  const file=join(baseDirectory,entry.path);
  const metadata=lstatSync(file);
  assert.ok(metadata.isFile(),'Official integration file must be regular: '+entry.path);
  assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0,'Official integration file size missing: '+entry.path);
  assert.equal(metadata.size,entry.bytes,'Official integration file size mismatch: '+entry.path);
  assert.ok([0o644,0o755].includes(entry.mode),'Official integration file mode missing: '+entry.path);
  assert.equal(metadata.mode&0o777,entry.mode,'Official integration file mode mismatch: '+entry.path);
  assert.equal(sha(file),entry.sha256,'Official integration file integrity mismatch: '+entry.path);
  files[entry.path]=entry.sha256;
 }
 assert.ok(files['clawchat-connect']&&files['source.json'],'Official platform executable and source record required');
 for(const name of requiredRuntimeFiles)assert.ok(files['runtime/'+name],'Official runtime dependency missing: '+name);
 for(const directory of copiedDirectories) {
  const actual=fileTree(join(baseDirectory,directory));
  const expected=Object.fromEntries(Object.entries(files).filter(([name])=>name.startsWith(directory+'/')).map(([name,hash])=>[name.slice(directory.length+1),hash]));
  assert.deepEqual(actual,expected,'Official copied directory differs from its manifest: '+directory);
 }
 return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}

/** New installations verify every shipped file; historical records retain their original checks. */
export function verifyInstalledConnector(record) {
 assert.ok(lstatSync(record.directory).isDirectory(),'Installed connector directory missing');
 assert.equal(sha(join(record.directory,'clawchat-connect-core')),record.binarySha256,'Media connector integrity mismatch');
 assert.equal(sha(join(record.directory,'clawchat-connect')),record.launcherSha256,'Platform compatibility launcher changed');
 if(record.runtimeLibSha256)assert.equal(sha(join(record.directory,'runtime/lib.mjs')),record.runtimeLibSha256,'Official runtime library changed');
 if(record.livewareCompanion)assert.equal(sha(record.livewareCompanion.path),record.livewareCompanion.sha256,'Liveware companion changed');
 if(record.fileIntegrity) {
  assert.ok(Object.keys(record.fileIntegrity).length,'Installed connector file manifest missing');
  for(const [name,expected]of Object.entries(record.fileIntegrity)) {
   assert.ok(safePath(name)&&/^[a-f0-9]{64}$/.test(expected),'Invalid installed connector file record');
   assert.equal(sha(join(record.directory,name)),expected,'Installed connector file integrity mismatch: '+name);
  }
  const actual=fileTree(record.directory);delete actual['extension.json'];
  assert.deepEqual(actual,record.fileIntegrity,'Installed connector file set changed');
 }
 return record;
}

export function prepareConnectorExtension({home,binary,manifestFile,baseDirectory,skillsDirectory,realtime=false,liveware=realtime,voice=false}) {
 const build=read(manifestFile),base=read(join(baseDirectory,'integration.json')),source=read(join(baseDirectory,'source.json'));
 assert.equal(source.connect_commit,coreCommit,'Actual integration source changed');assert.equal(build.upstreamCommit,coreCommit,'Core patch must match the actual source');
 assert.equal(sha(binary),build.binarySha256,'Core build integrity mismatch');
 assert.match(build.version,/^[A-Za-z0-9][A-Za-z0-9.-]*$/,'Invalid Core build version');
 const skillManifest=join(skillsDirectory,'manifest.json'),skills=read(skillManifest);
 assert.equal(skills.connectVersion,build.skillsConnectVersion??build.version,'Bundled skills version mismatch');
 for(const [file,digest]of Object.entries(skills.files)){assert.ok(safePath(file),'Unsafe bundled skill');assert.equal(sha(join(skillsDirectory,file)),digest,'Bundled skill integrity mismatch');}
 // All official host files remain byte-identical. Call model configuration
 // is owned by our bridge process overlay.
 const baseFiles=verifiedBaseFiles(baseDirectory,base),runtimeLibSha256=baseFiles['runtime/lib.mjs'];
 const baseManifestSha256=sha(join(baseDirectory,'integration.json'));
 const baseFingerprint=digest(JSON.stringify({directory:resolve(baseDirectory),manifest:baseManifestSha256,files:baseFiles}));
 // Official Exposure owns and verifies its own companion. The extension no
 // longer copies or overrides that program, or starts an account relay.
 const directory=join(home,'.local/share/whale-nest/connectors',build.version+'-'+build.binarySha256.slice(0,12)+'-'+sha(skillManifest).slice(0,8)+'-base'+baseFingerprint.slice(0,16)+'-layout9'+(voice?'-voice2':''));
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 const launcher='#!/bin/sh\ncase "$1" in\n__clawnest-state|__clawnest-owner|__clawnest-usage) exec '+quote(join(baseDirectory,'clawchat-connect'))+' "$@" ;;\n*) exec '+quote(join(directory,'clawchat-connect-core'))+' "$@" ;;\nesac\n';
 const expectedFiles={'clawchat-connect-core':build.binarySha256,'clawchat-connect':digest(launcher)};
 for(const [name,hash]of Object.entries(baseFiles))if(copiedDirectories.some(prefix=>name.startsWith(prefix+'/')))expectedFiles[name]=hash;
 for(const [name,hash]of Object.entries(fileTree(skillsDirectory)))expectedFiles['skills/'+name]=hash;
 const fileIntegrity=Object.fromEntries(Object.entries(expectedFiles).sort(([a],[b])=>a.localeCompare(b)));
 const pointer=join(home,'.dsh/companion/aurabot-v1/connector-override.json');
 const record={schema:1,baseDirectory,baseVersion:base.version,baseReleaseId:baseDirectory.split('/').at(-1),upstreamCommit:coreCommit,directory,binarySha256:build.binarySha256,version:build.version,...(build.officialCoreVersion?{officialCoreVersion:build.officialCoreVersion}:{}),coreCapabilities:build.coreCapabilities??[],
  launcherSha256:digest(launcher),runtimeLibSha256,baseManifestSha256,baseFingerprint,fileIntegrity,startupProfileScoped:true,managedLiveware:true,pointer,supervisorFile:join(home,'.clawling/supervisord/whalenest-media.conf')};
 if(!existsSync(directory)) {
  mkdirSync(dirname(directory),{recursive:true,mode:0o700});
  const staging=mkdtempSync(join(dirname(directory),'.prepare-'));
  try {
   copyFileSync(binary,join(staging,'clawchat-connect-core'));chmodSync(join(staging,'clawchat-connect-core'),0o755);
   writeFileSync(join(staging,'clawchat-connect'),launcher,{mode:0o755});
   for(const name of copiedDirectories)cpSync(join(baseDirectory,name),join(staging,name),{recursive:true});
   cpSync(skillsDirectory,join(staging,'skills'),{recursive:true});
   writeState(join(staging,'extension.json'),record);
   renameSync(staging,directory);
  } finally {rmSync(staging,{recursive:true,force:true});}
 }
 verifyInstalledConnector(record);return record;
}

export function extensionHostConfig(config,record) {
 return {...config,entries:{...config.entries,agent:relative(record.baseDirectory,join(record.directory,'runtime/cli.mjs'))}};
}
