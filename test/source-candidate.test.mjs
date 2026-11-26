import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectSourceCandidate,sourceTarget,sourceIdentity,sourceCandidateFile,sourceNodeOptions} from '../src/source-candidate.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'whalenest-source-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
  const options={instanceId:'fixture',home:root,cwd:root,dataDir:join(root,'data'),
    clawchat:{route:{account:'agent',sender:'owner',conversation:'dm'},delivery:{configPath:join(root,'connect/config.json')}}};
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
  const lock=join(dirname(options.clawchat.delivery.configPath),'plugins.lock.json');
  const saveSelected=value=>put(lock,JSON.stringify({plugins:{'whalenest.runtime.deepseek-harness':value}}));saveSelected(selected);
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
  return {root,options,selected,source,record,run,saveSelected,installedRoot};
}

test('source selection loads our modules and their resources without touching official or installed files',t=>{
  const f=fixture(t),before=readFileSync(join(f.installedRoot,'src/voice-fixture.mjs'));
  assert.equal(inspectSourceCandidate(f.options).version,f.record.version);
  assert.deepEqual(JSON.parse(f.run()),{own:'candidate voice',official:'official unchanged'});
  assert.deepEqual(readFileSync(join(f.installedRoot,'src/voice-fixture.mjs')),before);
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
