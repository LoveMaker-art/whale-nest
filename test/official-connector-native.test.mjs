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
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'whalenest-native-update-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const route={channel:'clawchat',kind:'private',account:'agent',conversation:'private',sender:'owner'};
 const options={instanceId:'isolated-update',cwd:dir,dataDir:dir,owners:[route],clawchat:{route,delivery:{connectBin:'/bin/false',configPath:join(dir,'connect.json')}},
  pluginUpdates:{repository:'fixture/releases',connectorExecutable:join(dir,'native.mjs')}};
 const id='d'.repeat(64),integrity='sha256-'+Buffer.alloc(32).toString('base64');
 const old={status:'active',version:'1.0.0-beta.3',target:'linux-x64',source:{type:'local'},integrity};
 const release={repository:'fixture/releases',tag:'v1.0.0-beta.5',version:'1.0.0-beta.5',sha256:'a'.repeat(64),compatibility:{dataSchema:1},
  prerequisites:{clawchatIntegration:{minimumVersion:'0.2.22',upgradeVersion:'0.2.22'}},notes:''};
 writeState(join(dir,'fixture.json'),{options,release,old,id});writeState(join(dir,'installed.json'),old);
 const native={status:'running',selected:{id:'official-old',version:'0.2.20'},running:{id:'official-old',version:'0.2.20'}};
 writeState(join(dir,'native-state.json'),native);
 await writeFile(options.pluginUpdates.connectorExecutable,`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const at=name=>new URL('./'+name,import.meta.url),args=process.argv.slice(2);
appendFileSync(at('commands.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]!=='plugin'||!['status','check'].includes(args[1]))throw Error('Unexpected connector mutation');
console.log(JSON.stringify(args[1]==='status'?JSON.parse(readFileSync(at('native-state.json'))):
 {status:'update_available',release:{version:'0.2.22',runtime:'deepseek-harness',plugin:'clawchat-connect'}}));
`);await chmod(options.pluginUpdates.connectorExecutable,0o700);
 const module=name=>new URL('../src/'+name,import.meta.url).href,driver=join(dir,'worker.mjs');
 await writeFile(driver,`
import {executePluginUpdate} from ${JSON.stringify(module('plugin-update-worker.mjs'))};
import {createPluginUpdates} from ${JSON.stringify(module('plugin-updates.mjs'))};
import {readState,writeState} from ${JSON.stringify(module('state.mjs'))};
import {appendFileSync} from 'node:fs';
const root=${JSON.stringify(dir)},f=readState(root+'/fixture.json'),file=root+'/installed.json';
const host={installed:()=>readState(file),identity:async()=>({key:'same-private-binding',idle:true}),versions:async()=>({dataSchema:1}),
 async change(action,body){appendFileSync(root+'/changes.jsonl',JSON.stringify({action,body})+'\\n');writeState(file,{...f.old,version:f.release.version,source:{type:'github',repository:f.release.repository,release:f.release.tag},retainedVersions:[f.old]});return true;}};
const service=createPluginUpdates(f.options,'fixture',{host,discover:async()=>f.release});
// Activation is covered through real leases elsewhere; this child verifies
// the production updater/CLI contract without restarting a local SDK.
const result=process.argv[2]==='check'?await service.perform(f.options.clawchat.route,{action:'check'},'检查更新'):
 await executePluginUpdate(f.options,f.id,{host,discover:async()=>f.release,activate:async()=>({state:'ready'})});
console.log(JSON.stringify(result));
`);
 const invoke=async action=>JSON.parse((await exec(process.execPath,[driver,...(action?[action]:[])],{cwd:dir,timeout:15000,maxBuffer:1024*1024})).stdout);
 const queue=()=>writeState(updateFiles(options).request,{id,instanceId:options.instanceId,release,route});
 const lines=async name=>{try{return (await readFile(join(dir,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 return {dir,options,id,release,old,native,invoke,queue,lines};
}

test('native connector checks only report versions; separate Whale workers ignore historical prerequisites without upgrading or downgrading the connector',async t=>{
 const f=await fixture(t),offer=await f.invoke('check');
 assert.equal(offer.connector.current,'0.2.20');assert.equal(offer.connector.latest,'0.2.22');assert.equal(offer.connector.automaticUpdate,false);
 f.queue();assert.equal((await f.invoke()).phase,'completed');assert.equal((await f.invoke()).phase,'completed');
 assert.deepEqual(readState(join(f.dir,'native-state.json')),f.native);
 assert.deepEqual((await f.lines('commands.jsonl')).sort((a,b)=>a[1].localeCompare(b[1])),[['plugin','check'],['plugin','status']]);
 assert.equal((await f.lines('changes.jsonl')).length,1);assert.equal(readState(join(f.dir,'installed.json')).version,f.release.version);
});

test('old connector mutation intents remain held across worker processes without another CLI command or Whale switch',async t=>{
 for(const phase of ['connector-submitting','connector-updating','connector-rolling-back']){
  const f=await fixture(t);f.queue();const change={jobId:'original-job',target:'new',before:{selectedId:'old'}};
  writeState(updateProgress(f.options,f.id),{phase,connector:change});
  for(let attempt=0;attempt<2;attempt++){
   const result=await f.invoke();assert.equal(result.phase,'uncertain');assert.equal(result.reason,'legacy-connector-task-manual');assert.deepEqual(result.connector,change);
  }
  assert.deepEqual(await f.lines('commands.jsonl'),[]);assert.deepEqual(await f.lines('changes.jsonl'),[]);
  assert.equal(readState(join(f.dir,'installed.json')).version,f.old.version);
 }
});
