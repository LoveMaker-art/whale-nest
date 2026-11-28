import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,copyFileSync,existsSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir,homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectSourceCandidate,sourceTarget,sourceIdentity,sourceCandidateFile,sourceNodeOptions,sourceBunOptions} from '../src/source-candidate.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'whalenest-source-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
  const options={instanceId:'fixture',home:root,cwd:root,dataDir:join(root,'data'),
    clawchat:{route:{account:'agent',sender:'owner',conversation:'dm'},delivery:{connectBin:join(root,'public-cli'),configPath:join(root,'connect/config.json')}}};
  const selected={status:'active',version:'1.0.0-beta.4.dev.21',integrity:'installed-integrity',activationGeneration:107,
    activeArtifact:join(root,'installed/artifacts/linux-x64.mjs')};
  const source=join(root,'candidate with spaces'),files={};
  for(const name of ['package.json','src/runtime-extension.mjs','src/runtime-provider.mjs','src/dsh-bridge.mjs',
    'src/liveware-service.mjs','src/assets/workspace-instructions.json','src/voice-fixture.mjs','src/assets/fixture.txt']){
    const text=name==='package.json'?'implementation-package':name==='src/voice-fixture.mjs'
      ?'import {readFileSync} from "node:fs"; export default readFileSync(new URL("./assets/fixture.txt",import.meta.url),"utf8");'
      :name==='src/assets/fixture.txt'?'candidate voice':'{}';
    const bytes=name==='package.json'?JSON.stringify({type:'module',version:'1.0.0-beta.4.dev.22'}):text;
    put(join(source,name),bytes);files[name]=sha(bytes);
  }
  const manifest=JSON.stringify({schema:1,version:'1.0.0-beta.4.dev.22',files});
  put(join(source,'source-manifest.json'),manifest);
  const installedRoot=join(dirname(selected.activeArtifact),'whalenest');
  put(join(installedRoot,'package.json'),'{"type":"module"}');
  put(join(installedRoot,'src/voice-fixture.mjs'),'export default "installed voice";');
  const official=join(root,'installed/artifacts/official-runtime-provider.mjs');put(official,'export default "official unchanged";');
  const registry=join(options.dataDir,'installation.json');
  const saveSelected=value=>{put(registry,JSON.stringify({schema:1,version:value.version,integrity:value.integrity,activationGeneration:value.activationGeneration,entryPath:value.activeArtifact,root:installedRoot}));};saveSelected(selected);
  put(options.clawchat.delivery.connectBin,'#!'+process.execPath+'\nthrow Error("Cold bootstrap must not query the platform manager");');
  chmodSync(options.clawchat.delivery.connectBin,0o700);
  const record={schema:1,mode:'source-test',identity:sourceIdentity(options),target:sourceTarget(selected),root:source,
    version:'1.0.0-beta.4.dev.22',manifestSha256:sha(manifest)};put(sourceCandidateFile(options),JSON.stringify(record));
  const config=join(root,'instance.json');put(config,JSON.stringify(options));
  const run=()=>execFileSync(process.execPath,['--input-type=module','-e',
    `import own from ${JSON.stringify(pathToFileURL(join(installedRoot,'src/voice-fixture.mjs')).href)};
     import official from ${JSON.stringify(pathToFileURL(official).href)};console.log(JSON.stringify({own,official}));`],{
    encoding:'utf8',env:{...process.env,WHALENEST_SOURCE_INSTANCE:config,
      NODE_OPTIONS:sourceNodeOptions(process.env.NODE_OPTIONS,fileURLToPath(new URL('../scripts/source-preload.mjs',import.meta.url)))},
    stdio:['ignore','pipe','pipe'],
  });
  return {root,options,selected,source,record,run,saveSelected,installedRoot,config,official};
}

test('source selection loads our modules and their resources without touching official or installed files',t=>{
  const f=fixture(t),before=readFileSync(join(f.installedRoot,'src/voice-fixture.mjs'));
  assert.equal(inspectSourceCandidate(f.options).version,f.record.version);
  assert.deepEqual(JSON.parse(f.run()),{own:'candidate voice',official:'official unchanged'});
  assert.deepEqual(readFileSync(join(f.installedRoot,'src/voice-fixture.mjs')),before);
});

test('cold startup selects own modules while the manager is offline and CLI formatting changes',t=>{
 const f=fixture(t);
 writeFileSync(f.options.clawchat.delivery.connectBin,'#!'+process.execPath+'\nthrow Error("Manager offline; human output changed");');
 assert.deepEqual(JSON.parse(f.run()),{own:'candidate voice',official:'official unchanged'});
 assert.equal(inspectSourceCandidate(f.options).manifestSha256,f.record.manifestSha256);
});

test('compiled Bun Core redirects only our external modules, including assets, and drops stale selections',t=>{
  const bun=process.env.WHALENEST_TEST_BUN??join(homedir(),'.bun/bin/bun');
  if(!existsSync(bun)){t.skip('Bun compile fixture runs on the developer machine; actual Core is checked on Linux');return;}
  const f=fixture(t),preload=join(f.root,'scripts/source-preload.mjs');
  mkdirSync(dirname(preload),{recursive:true});mkdirSync(join(f.root,'src'));
  copyFileSync(fileURLToPath(new URL('../scripts/source-preload.mjs',import.meta.url)),preload);
  for(const file of ['source-candidate.mjs','platform-client.mjs','platform-query.mjs','state.mjs'])copyFileSync(fileURLToPath(new URL('../src/'+file,import.meta.url)),join(f.root,'src',file));
  const entry=join(f.root,'entry.mjs'),binary=join(f.root,'clawchat-connect');
  writeFileSync(entry,'const own=(await import(process.env.TEST_OWN)).default;const official=(await import(process.env.TEST_OFFICIAL)).default;console.log(JSON.stringify({own,official}));');
  execFileSync(bun,['build',entry,'--compile','--outfile',binary],{stdio:'pipe',timeout:20000});
  const run=()=>JSON.parse(execFileSync(binary,[],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,
    env:{...process.env,WHALENEST_SOURCE_INSTANCE:f.config,BUN_OPTIONS:sourceBunOptions('',preload),
      TEST_OWN:join(f.installedRoot,'src/voice-fixture.mjs'),TEST_OFFICIAL:f.official}}));
  assert.deepEqual(run(),{own:'candidate voice',official:'official unchanged'});
  assert.match(readFileSync(join(f.installedRoot,'src/voice-fixture.mjs'),'utf8'),/installed voice/);
  f.saveSelected({...f.selected,activationGeneration:108});
  assert.deepEqual(run(),{own:'installed voice',official:'official unchanged'});
  assert.throws(()=>sourceBunOptions('','/path with spaces/preload.mjs'),/plain absolute/);
});

test('a later package activation or owner change makes the old source selection dormant without blocking updates',t=>{
  const f=fixture(t);
  assert.equal(inspectSourceCandidate({...f.options,clawchat:{...f.options.clawchat,route:{...f.options.clawchat.route,sender:'other'}}}),null);
  f.saveSelected({...f.selected,activationGeneration:108});rmSync(f.source,{recursive:true});
  assert.equal(inspectSourceCandidate(f.options),null);
  assert.deepEqual(JSON.parse(f.run()),{own:'installed voice',official:'official unchanged'});
});

test('changed source inputs are rejected before a source process can use them',t=>{
  const f=fixture(t);writeFileSync(join(f.source,'src/assets/fixture.txt'),'changed');
  assert.throws(()=>inspectSourceCandidate(f.options),/Development source changed/);
  assert.throws(f.run);
});

test('launcher preflight rejects an omitted new dependency before touching online services',async t=>{
 const {preflightSourceLaunchers}=await import('../src/source-candidate.mjs');
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'whalenest-launch-overlay-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),project=join(root,'project');for(const p of [source,project])mkdirSync(join(p,'src'),{recursive:true});
 writeFileSync(join(source,'src/liveware-service.mjs'),"import './startup-state.mjs';");
 writeFileSync(join(source,'src/startup-state.mjs'),'export const ready=true;');
 assert.throws(()=>preflightSourceLaunchers(source,project,['src/liveware-service.mjs']),/missing from planned overlay/);
 preflightSourceLaunchers(source,project,['src/liveware-service.mjs','src/startup-state.mjs']);
});

test('source selection upgrades only our vendored factory while leaving the installed package unchanged',t=>{
 const f=fixture(t),name='integration/clawchat/base/linux-x64.mjs';mkdirSync(dirname(join(f.source,name)),{recursive:true});
 const code='export default "candidate official factory";';writeFileSync(join(f.source,name),code);
 const path=join(f.source,'source-manifest.json'),m=JSON.parse(readFileSync(path));m.files[name]=sha(code);const bytes=JSON.stringify(m);writeFileSync(path,bytes);
 f.record.manifestSha256=sha(bytes);writeFileSync(sourceCandidateFile(f.options),JSON.stringify(f.record));
 assert.equal(JSON.parse(f.run()).official,'candidate official factory');assert.equal(readFileSync(f.official,'utf8'),'export default "official unchanged";');
});
