import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {buildDistribution,distributionVersion} from '../scripts/build-distribution.mjs';
import {pluginId,updateCompatibility,updatePrerequisites,updateProtocol} from '../src/plugin-release.mjs';

test('distribution moves to another folder, loads without source paths, retains external data on removal',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'whalenest-package-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const notes='更新时保留原有会话';
 const file=await buildDistribution(join(dir,'build'),{notes});const bundleBytes=await readFile(file);const bundle=JSON.parse(bundleBytes);
 const metadata=JSON.parse(await readFile(join(dir,'build','distribution.json')));
 assert.equal(bundle.format,'clawchat-connect-plugin-bundle-v1','official installer bundle format');
 assert.equal(bundle.manifest.version,distributionVersion);
 assert.equal(metadata.pluginId,pluginId);
 assert.equal(metadata.version,bundle.manifest.version);
 assert.equal(metadata.sha256,createHash('sha256').update(bundleBytes).digest('hex'));
 assert.deepEqual(metadata.compatibility,updateCompatibility);
 assert.deepEqual(metadata.prerequisites,updatePrerequisites);
 assert.equal(metadata.updateProtocol,updateProtocol);
 assert.equal(metadata.notes,notes);
 assert.deepEqual(bundle.manifest.capabilities.map(c=>c.type),['runtime','managed-web-app']);
 assert.ok(bundle.manifest.dependencies.some(d=>d.id==='managed-web-app-provider'));
 assert.equal(bundle.manifest.capabilities[1].id,'whalenest-liveware');
 assert.deepEqual(Buffer.from(bundle.files['artifacts/official-runtime-provider.mjs'].content,'base64'),
  await readFile(new URL('../integration/clawchat/base/linux-x64.mjs',import.meta.url)),'Official provider must remain byte-identical');
 assert.ok(!Object.keys(bundle.files).some(p=>p.includes('/whalenest/web/')||/(?:^|\/)(?:management|management-provider)\.mjs$/.test(p)));
  for(const name of ['src/assets/voices.json','src/voice-selection.mjs'])
    assert.ok(bundle.files['artifacts/whalenest/'+name],'Voice choice runtime resource missing: '+name);
 const target=join(dir,'installed-elsewhere');
 for(const [path,entry]of Object.entries(bundle.files)){
  assert.ok(!path.includes('..'));const full=join(target,path);await mkdir(dirname(full),{recursive:true});
  const bytes=Buffer.from(entry.content,entry.encoding==='base64'?'base64':'utf8');await writeFile(full,bytes);
  if(/\.(?:mjs|json)$/.test(path)&&!path.includes('/vendor/'))assert.ok(!bytes.toString().includes('/home/node/projects/whale-nest'),'no development absolute paths');
 }
 const packaged=join(target,'artifacts/whalenest');
 const {workspaceInstructionsSource}=await import(pathToFileURL(join(packaged,'src/workspace-instructions.mjs')).href);
 const instructions=workspaceInstructionsSource();
 assert.equal(instructions.version,bundle.manifest.version);
 assert.equal(instructions.template,await readFile(new URL('../src/assets/capabilities.md',import.meta.url),'utf8'));
 assert.deepEqual(await readFile(join(packaged,'LICENSE')),await readFile(new URL('../LICENSE',import.meta.url)));
 assert.equal(JSON.parse(await readFile(join(packaged,'package.json'))).license,'MIT');
 const {personaReference}=JSON.parse(await readFile(join(packaged,'upstream.lock.json')));
 const personaLicense=await readFile(join(packaged,personaReference.licenseFile));
 assert.equal(createHash('sha256').update(personaLicense).digest('hex'),personaReference.licenseSha256);
 assert.match(personaLicense.toString(),/Copyright \(c\) 2026 zexuanw958-svg/);
 const entry=bundle.manifest.artifacts[0];const bytes=await readFile(join(target,entry.entry));
 assert.equal(entry.integrity,'sha256-'+createHash('sha256').update(bytes).digest('base64'));
 const runtime=await import(pathToFileURL(join(target,entry.entry)).href);
 let runtimeProvider,managedProvider;
 await runtime.default.activate({installationConfiguration:{},hostCapabilities:{get:id=>{
  assert.ok(['runtime-provider','managed-web-app-provider'].includes(id));
  return {register:provider=>{if(id==='runtime-provider')runtimeProvider=provider;else managedProvider=provider;}};
 }}});
 assert.equal(runtimeProvider.capabilityId,'deepseek-harness');
 assert.equal(managedProvider.capabilityId,'whalenest-liveware');
 const fixture=await bridgeDirectory();fixture.entryOverride=join(target,'artifacts/deepseek-harness-bridge.mjs');fixture.options.management={enabled:true};
 await mkdir(join(fixture.options.home,'companion/aurabot-v1'),{recursive:true});
 await writeFile(join(fixture.options.home,'companion/aurabot-v1/instance.json'),JSON.stringify(fixture.options));
 const bridge=await bootBridge(fixture);
 try{
  const status=await bridge.request('companionStatus',{});
  const {verifyLiveModules}=await import('../scripts/lib/live-tools.mjs');verifyLiveModules(status);
  assert.equal(status.persona.currentId,'dafeiyu-original');
  assert.equal(status.companion.settings.contactEnabled,true,'A fresh installation enables the approved companion features by default');
  await assert.rejects(readFile(join(fixture.options.dataDir,'management.json')),{code:'ENOENT'},'legacy page configuration must not start an HTTP server');
 }finally{await bridge.close();await rm(fixture.root,{recursive:true,force:true});}
 const data=join(dir,'private-data.json');await writeFile(data,'private memories');
 await rm(target,{recursive:true});assert.equal(await readFile(data,'utf8'),'private memories');
});
