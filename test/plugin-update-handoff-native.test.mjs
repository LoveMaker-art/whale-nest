import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hash} from '../src/routing.mjs';
import {readState,writeState} from '../src/state.mjs';
import {updateFiles,updateProgress} from '../src/plugin-update-worker.mjs';
import {plannedUpdateStepId} from '../src/plugin-update-orchestrator.mjs';

const exec=promisify(execFile);
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));

test('artifact-owned worker processes hand off the same confirmed job without an injected current-worker predicate', {timeout:45000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'whalenest-worker-artifacts-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const repository='handoff-native/releases';
  const versions=['1.0.0-beta.4.dev.20','1.0.0-beta.4.dev.21','1.0.0-beta.4.dev.22'];
  const route={channel:'clawchat',kind:'private',account:'dsh',conversation:'same-private',sender:'owner'};
  const options={instanceId:'native-handoff-instance',cwd:directory,dataDir:directory,owners:[route],
    clawchat:{route,delivery:{connectBin:'/bin/false',configPath:join(directory,'connect.json')}},pluginUpdates:{repository,channel:'beta'}};
  const steps=versions.slice(1).map(version=>({repository,tag:'v'+version,version,sha256:hash(['asset',version]),
    compatibility:{dataSchema:1},notes:'',updateProtocol:1}));
  steps[1].updatePath={schema:1,steps:[{version:steps[0].version,sha256:steps[0].sha256}]};
  const plan={schema:1,steps},id=hash([directory,'same-confirmed-job']);
  const artifactDirectories=Object.fromEntries(versions.map(version=>[version,join(directory,'artifacts',version)]));
  const integrity=version=>'sha256-'+Buffer.from(hash(version),'hex').toString('base64');
  const initial={status:'active',version:versions[0],integrity:integrity(versions[0]),target:'linux-x64',source:{type:'local'},
    activationGeneration:1,activeArtifact:join(artifactDirectories[versions[0]],'linux-x64.mjs')};
  writeState(join(directory,'fixture.json'),{options,id,steps,artifactDirectories});
  writeState(join(directory,'installed.json'),initial);
  writeState(updateFiles(options).request,{id,instanceId:options.instanceId,route,release:steps[1],plan,planDigest:hash(plan),confirmedAt:Date.now()});
  await writeFile(join(directory,'conversation.txt'),'preserved private conversation');

  for(const version of versions) {
    const artifact=artifactDirectories[version],owned=join(artifact,'whalenest');
    await mkdir(owned,{recursive:true});
    await cp(join(repositoryRoot,'src'),join(owned,'src'),{recursive:true});
    await symlink(join(repositoryRoot,'vendor'),join(owned,'vendor'),'dir');
    await symlink(join(repositoryRoot,'package.json'),join(owned,'package.json'),'file');
    await symlink(join(repositoryRoot,'node_modules'),join(owned,'node_modules'),'dir');
    await writeFile(join(artifact,'linux-x64.mjs'),'export default {};\n');
    await writeFile(join(artifact,'driver.mjs'),`
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {executePluginUpdate} from './whalenest/src/plugin-update-worker.mjs';
import {readState,writeState} from './whalenest/src/state.mjs';
import {hash} from './whalenest/src/routing.mjs';
const root=${JSON.stringify(directory)},fixture=readState(root+'/fixture.json');
const workerArtifact=${JSON.stringify(artifact)};
const installedFile=root+'/installed.json';
const host={
  installed:()=>readState(installedFile),
  identity:async()=>({key:'original-binding',idle:true,accountId:'same-agent'}),
  versions:async()=>({dataSchema:1}),
  async change(action,body){
    const previous=readState(installedFile);
    const release=fixture.steps.find(step=>body.source==='github:'+fixture.options.pluginUpdates.repository+'@'+step.tag);
    if(!release)throw Error('Unexpected selection or rollback');
    appendFileSync(root+'/switches.jsonl',JSON.stringify({pid:process.pid,workerArtifact,workerFile:fileURLToPath(import.meta.url),action,target:release.version})+'\\n');
    writeState(installedFile,{status:'active',version:release.version,target:'linux-x64',
      integrity:'sha256-'+Buffer.from(hash(release.version),'hex').toString('base64'),
      activationGeneration:previous.activationGeneration+1,
      source:{type:'github',repository:release.repository,release:release.tag},
      activeArtifact:fixture.artifactDirectories[release.version]+'/linux-x64.mjs',
      retainedVersions:[previous,...(previous.retainedVersions??[])]});
    return true;
  }
};
const dependencies={host,wait:async()=>{},activate:async()=>({state:'ready'}),
  discover:async(_config,_current,{tag}={})=>fixture.steps.find(step=>step.tag===tag)??fixture.steps.at(-1)};
if(Object.hasOwn(dependencies,'isCurrentWorker'))throw Error('The test must use production worker ownership');
const results=[];
for(let index=0;index<Number(process.argv[2]??1);index++)results.push(await executePluginUpdate(fixture.options,fixture.id,dependencies));
console.log(JSON.stringify({pid:process.pid,workerArtifact,results}));
`);
  }
  const invoke=async(version,repeats=1)=>JSON.parse((await exec(process.execPath,
    ['--max-old-space-size=384',join(artifactDirectories[version],'driver.mjs'),String(repeats)],
    {cwd:directory,timeout:20000,maxBuffer:1024*1024})).stdout);
  const switches=async()=>{
    const text=await readFile(join(directory,'switches.jsonl'),'utf8');
    return text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  };

  const old=await invoke(versions[0],3);
  assert.ok(old.results.every(result=>result.phase==='handoff-pending'));
  assert.equal(readState(join(directory,'installed.json')).version,versions[1]);
  assert.equal(readState(updateProgress(options,plannedUpdateStepId(id,0,steps[0]))).phase,'completed');
  assert.equal((await switches()).length,1,'Even another call in the old process must not start the final step');
  const oldAfterRestart=await invoke(versions[0]);
  assert.equal(oldAfterRestart.results[0].phase,'handoff-pending');
  assert.equal((await switches()).length,1,'Reopening the old artifact must not bypass ownership');

  const successor=await invoke(versions[1]);
  assert.notEqual(successor.pid,old.pid);
  assert.equal(successor.results[0].phase,'completed');
  assert.equal(readState(updateProgress(options,id)).cursor,1);
  assert.equal(readState(join(directory,'installed.json')).version,versions[2]);
  const mutations=await switches();
  assert.deepEqual(mutations.map(row=>row.target),versions.slice(1));
  assert.deepEqual(mutations.map(row=>row.workerArtifact),[artifactDirectories[versions[0]],artifactDirectories[versions[1]]]);
  assert.ok(mutations.every(row=>dirname(row.workerFile)===row.workerArtifact));
  const final=await invoke(versions[2]);
  assert.equal(final.results[0].phase,'completed');
  assert.equal((await switches()).length,2);
  assert.equal(readState(updateFiles(options).request).id,id);
  assert.equal(await readFile(join(directory,'conversation.txt'),'utf8'),'preserved private conversation');
});
