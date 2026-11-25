import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeState,readState} from '../src/state.mjs';
import {updateProgress,updateFiles} from '../src/plugin-update-worker.mjs';

const exec=promisify(execFile);

test('separate worker processes continue one native deferred job through the public CLI',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'whalenest-native-update-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const route={channel:'clawchat',kind:'private',account:'agent',conversation:'private',sender:'owner'};
  const options={instanceId:'isolated-update',cwd:dir,dataDir:dir,owners:[route],clawchat:{route,delivery:{connectBin:'/bin/false',configPath:join(dir,'connect.json')}},
    pluginUpdates:{repository:'fixture/releases',connectorExecutable:join(dir,'native.mjs')}};
  const target='0.2.22-'+'c'.repeat(64),id='d'.repeat(64),integrity='sha256-'+Buffer.alloc(32).toString('base64');
  const old={status:'active',version:'1.0.0-beta.3',target:'linux-x64',source:{type:'local'},integrity};
  const release={repository:'fixture/releases',tag:'v1.0.0-beta.5',version:'1.0.0-beta.5',sha256:'a'.repeat(64),compatibility:{dataSchema:1},
    prerequisites:{clawchatIntegration:{minimumVersion:'0.2.22',upgradeVersion:'0.2.22'}},notes:''};
  writeState(join(dir,'fixture.json'),{options,release,old,id});
  writeState(updateFiles(options).request,{id,instanceId:options.instanceId,release,route});
  writeState(join(dir,'installed.json'),old);
  const before={id:'0.2.20-before',version:'0.2.20'};
  writeState(join(dir,'native-state.json'),{status:'running',selected:before,
    running:{...before,health:{version:before.version,identity:'same-agent',ready:true,connected:true,draining:false}},job:{id:'prior',status:'succeeded'}});
  await writeFile(options.pluginUpdates.connectorExecutable,`#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const at=name=>new URL('./'+name,import.meta.url);
const state=JSON.parse(readFileSync(at('native-state.json'))),args=process.argv.slice(2);
appendFileSync(at('commands.jsonl'),JSON.stringify(args)+'\\n');
let result;
if(args[1]==='status')result=state;
else if(args[1]==='check')result={status:'update_available',downgrade_requested:false,release:{version:'0.2.22',runtime:'deepseek-harness',plugin:'clawchat-connect',artifact:{sha256:'c'.repeat(64)}}};
else if(args[1]==='upgrade'){
 state.job={id:'durable-native-job',action:'upgrade',status:'accepted',target:${JSON.stringify(target)},previous:state.selected.id,identity:'same-agent'};
 writeFileSync(at('native-state.json'),JSON.stringify(state));result=state.job;
}else throw Error('Unexpected mutation');
console.log(JSON.stringify(result));
`);
  await chmod(options.pluginUpdates.connectorExecutable,0o700);
  const workerModule=new URL('../src/plugin-update-worker.mjs',import.meta.url).href;
  const stateModule=new URL('../src/state.mjs',import.meta.url).href;
  const driver=join(dir,'worker.mjs');
  await writeFile(driver,`
import {executePluginUpdate} from ${JSON.stringify(workerModule)};
import {readState,writeState} from ${JSON.stringify(stateModule)};
const root=${JSON.stringify(dir)},f=readState(root+'/fixture.json'),file=root+'/installed.json';
const host={installed:()=>readState(file),identity:async()=>({key:'same-private-binding',idle:true,accountId:'same-agent'}),versions:async()=>({dataSchema:1}),
 async change(action,body){writeState(file,{...f.old,version:f.release.version,source:{type:'github',repository:f.release.repository,release:f.release.tag},retainedVersions:[f.old]});return true;}};
// Runtime activation has its own production-lease tests. This fixture covers
// persisted official CLI jobs and must not restart a real SDK or supervisor.
console.log(JSON.stringify(await executePluginUpdate(f.options,f.id,{host,discover:async()=>f.release,activate:async()=>({state:'ready'})})));
`);
  const invoke=async()=>JSON.parse((await exec(process.execPath,[driver],{cwd:dir,timeout:15000,maxBuffer:1024*1024})).stdout);
  assert.equal((await invoke()).phase,'connector-updating');
  assert.equal(readState(join(dir,'installed.json')).version,old.version);
  assert.equal((await invoke()).phase,'connector-updating');
  const native=readState(join(dir,'native-state.json'));
  native.selected={id:target,version:'0.2.22'};
  native.running={...native.selected,health:{...native.running.health,version:'0.2.22'}};
  native.job.status='succeeded';writeState(join(dir,'native-state.json'),native);
  assert.equal((await invoke()).phase,'completed');
  assert.equal((await invoke()).phase,'completed');
  assert.equal(readState(updateProgress(options,id)).connectorVersion,'0.2.22');
  assert.equal(readState(join(dir,'installed.json')).version,release.version);
  const commands=(await readFile(join(dir,'commands.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(commands.filter(row=>row[1]==='upgrade').length,1);
  assert.ok(commands.every(row=>!row.includes('--latest')));
});
