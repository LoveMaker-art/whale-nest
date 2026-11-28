import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync,appendFileSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installNativePlugin} from '../src/native-install.mjs';
import {programFiles} from '../src/bootstrap-deployment.mjs';
const buildRoot=fileURLToPath(new URL('../',import.meta.url));
const put=(file,value)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
const read=file=>JSON.parse(readFileSync(file));
for(const mode of ['success','startup-metadata-unavailable','lost-replace-ack','target-unhealthy'])test('native installer '+mode+' preserves user data and recovers through the offline public API',{skip:process.platform!=='linux'},async()=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-release-installer-'));
 try{
  const artifact=join(root,'target.connect-plugin'),files={};
  for(const name of [...programFiles(buildRoot),'package.json'])files['artifacts/whalenest/'+name]={encoding:'base64',content:readFileSync(join(buildRoot,name)).toString('base64')};
  files['artifacts/entry.mjs']={encoding:'utf8',content:'export default {}'};
  const target={target:'linux-x64',entry:'artifacts/entry.mjs',integrity:'sha256-'+createHash('sha256').update(files['artifacts/entry.mjs'].content).digest('base64')};
  const bundle={format:'clawchat-connect-plugin-bundle-v1',manifest:{pluginId:'whalenest.runtime.deepseek-harness',version:'1.0.0',artifacts:[target]},files};put(artifact,bundle);
  put(join(root,'distribution.json'),{version:'1.0.0',target:'linux-x64',sha256:createHash('sha256').update(readFileSync(artifact)).digest('hex')});
  const data=join(root,'home/companion/aurabot-v1'),project=join(root,'project'),oldRoot=join(root,'old/whalenest'),instance=join(data,'instance.json'),cli=join(root,'public-cli');
  const route={channel:'clawchat',kind:'private',account:'dsh',sender:'owner',conversation:'dm'};
  const options={instanceId:'release-fixture',home:join(root,'home'),dataDir:data,cwd:join(root,'workspace'),owners:[route],clawchat:{route,officialHost:true,delivery:{connectBin:cli,configPath:join(root,'connect.json')}},realtime:{enabled:false}};
  mkdirSync(options.cwd,{recursive:true});put(instance,options);
  put(options.clawchat.delivery.configPath,{agents:{dsh:{runtime:{pluginId:bundle.manifest.pluginId},runtimeConfig:{instancePath:instance}}}});
  const entry=join(root,'old/entry.mjs');put(entry,'export default {};');
  let selected={pluginId:bundle.manifest.pluginId,status:'active',version:'1.0.0-beta.4.dev.22',target:'linux-x64',integrity:'sha256-'+createHash('sha256').update(readFileSync(entry)).digest('base64'),activeArtifact:entry,activationGeneration:1,source:{type:'local',path:join(root,'old-approved.connect-plugin')}};
  put(selected.source.path,{format:bundle.format,manifest:{pluginId:bundle.manifest.pluginId,version:selected.version,artifacts:[{target:'linux-x64',entry:'artifacts/entry.mjs',integrity:selected.integrity}]},files:{'artifacts/entry.mjs':{encoding:'utf8',content:readFileSync(entry,'utf8')}}});
  const previous=structuredClone(selected),registration={schema:1,pluginId:bundle.manifest.pluginId,version:selected.version,root:oldRoot,entryPath:entry,integrity:selected.integrity,activationGeneration:1,projectRoot:project};
  put(join(data,'installation.json'),registration);put(join(data,'runtime.json'),{instanceId:options.instanceId,schema:1});
  put(join(oldRoot,'package.json'),{version:previous.version});
  for(const name of ['src/assets/capabilities.md','src/assets/workspace-instructions.json']){mkdirSync(dirname(join(oldRoot,name)),{recursive:true});copyFileSync(join(buildRoot,name),join(oldRoot,name));}
  for(const name of programFiles(buildRoot)){const file=join(project,name);mkdirSync(dirname(file),{recursive:true});copyFileSync(join(buildRoot,name),file);}
  const userData=join(data,'user-memory.json');put(userData,{text:'original'});put(join(options.cwd,'AGENTS.md'),'User notes before upgrade.\n');
  const state={userId:'agent',ownerId:'owner',conversationId:'dm',available:true,connected:true,running:0,queued:0};
  put(cli,'#!'+process.execPath+'\nconsole.log('+JSON.stringify(JSON.stringify(state))+');');
  // The real Core state adapter invokes this public fixture executable.
  chmodSync(cli,0o700);
  const calls=[];let managerReads=0;
  const run=(bin,args)=>{
   calls.push([bin,args]);
   if(args[0]?.endsWith('/platform-query.mjs')){if(mode==='startup-metadata-unavailable'&&selected.version==='1.0.0'&&managerReads++===0)throw Error('Manager still starting');return JSON.stringify([selected]);}
   if(bin===cli){
    if(args[0]==='__clawnest-state')return JSON.stringify(state);
    if(args[0]==='config')return readFileSync(options.clawchat.delivery.configPath,'utf8');
    assert.equal(args[0],'plugin');
    if(args[1]==='replace'){
     assert.ok(args.includes('--offline'));
     if(args[3]!==artifact){assert.equal(read(args[3]).manifest.version,previous.version);selected={...previous,activationGeneration:3};return '{}';}
     selected={...selected,version:'1.0.0',integrity:mode==='target-unhealthy'?'sha256-unconfirmed':target.integrity,activationGeneration:2};
     put(userData,{text:'original plus new data'});
     if(mode==='lost-replace-ack'){appendFileSync(join(options.cwd,'AGENTS.md'),'\nUser notes added during upgrade.\n');throw Error('Lost acknowledgement after selection');}
    }else if(args[1]==='select')throw Error('The running Connect Plugin manager is unavailable');
    else throw Error('Unexpected public operation');
    return '{}';
   }
   if(bin==='/opt/clawnest/bin/supervisord'&&args[1]==='start'&&args[2]==='dsh-agent'){
    put(join(data,'runtime.lock'),{pid:process.pid,hostname:hostname(),instanceId:options.instanceId});
    if(!readFileSync(join(options.cwd,'AGENTS.md'),'utf8').includes('User notes added during upgrade.'))appendFileSync(join(options.cwd,'AGENTS.md'),'\nUser notes added during upgrade.\n');
   }
   return '';
  };
  let result,error;try{result=await installNativePlugin(instance,artifact,project,{run});}catch(e){error=e;}
  if(['success','startup-metadata-unavailable'].includes(mode)){if(error)throw error;assert.equal(result?.state,'active');assert.equal(selected.version,'1.0.0');}
  else{assert.ok(error);assert.equal(selected.version,previous.version);assert.deepEqual(read(join(data,'installation.json')),registration);assert.equal(calls.filter(([bin,args])=>bin===cli&&args[1]==='replace'&&args[3]!==artifact).length,1);assert.ok(!calls.some(([bin,args])=>bin===cli&&args[1]==='select'));assert.ok(error.message.includes(mode==='lost-replace-ack'?'Lost acknowledgement':'exact target'));}
  assert.equal(read(userData).text,'original plus new data');
  assert.ok(readFileSync(join(options.cwd,'AGENTS.md'),'utf8').includes('User notes added during upgrade.'));
  assert.ok(calls.every(([bin])=>bin!=='/usr/local/bin/clawchat-dsh'),'The installer must not update the official integration');

 }finally{rmSync(root,{recursive:true,force:true});}
});
