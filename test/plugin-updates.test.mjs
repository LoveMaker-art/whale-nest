import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {comparePluginVersions,discoverPluginRelease,pluginId,updateCompatibility,updatePrerequisites,verifyUpdateCompatibility,validateUpdatePrerequisites} from '../src/plugin-release.mjs';
import {queryPlatformPlugins} from '../src/platform-query.mjs';
import {installedPlugin} from '../src/platform-client.mjs';
import {createOfficialConnectorInspector} from '../src/official-connector-update.mjs';
import {createPluginUpdates} from '../src/plugin-updates.mjs';
import {connectUpdateHost,executePluginUpdate,updateFiles,updateProgress} from '../src/plugin-update-worker.mjs';
import {readState,writeState} from '../src/state.mjs';
import {ensureRuntimeActivation} from '../src/runtime-activation.mjs';
import {planWorkspaceInstructions,applyWorkspaceInstructions} from '../src/workspace-instructions.mjs';

const repository='whalenest-fixture/releases';
const current='0.3.0-whalenest.m4.1-dev.22', next='0.3.0-whalenest.m4.1-dev.23';
const digest='a'.repeat(64);
const release={repository,tag:'v'+next,version:next,sha256:digest,compatibility:updateCompatibility,notes:'修复重启后的更新回执恢复'};
const integrity='sha256-'+Buffer.alloc(32,3).toString('base64');
const old={status:'active',version:current,target:'linux-x64',source:{type:'local'},integrity};
const qq={channel:'qq',kind:'private',account:'1000',conversation:'1001',sender:'1001'};
const clawchat={channel:'clawchat',kind:'private',account:'agent',conversation:'claw-chat',sender:'owner'};

test('update admission ignores Core and DSH versions and historical custom capability requirements',()=>{
  const actual={...updateCompatibility,core:'a-new-official-build'};
  assert.doesNotThrow(()=>verifyUpdateCompatibility(actual,updateCompatibility));
  for (const dsh of ['0.2.2-rc.5','0.2.2-rc.6','future-build',undefined]) {
    assert.doesNotThrow(()=>verifyUpdateCompatibility({...actual,dsh},updateCompatibility));
  }
  assert.doesNotThrow(()=>verifyUpdateCompatibility({dataSchema:1},updateCompatibility));
  assert.deepEqual(updateCompatibility,{dataSchema:1});
  const legacy={dsh:'0.2.2-rc.1',dshVersions:['0.2.2-rc.1'],core:updateCompatibility.core,dataSchema:1};
  assert.doesNotThrow(()=>verifyUpdateCompatibility(updateCompatibility,legacy));
  assert.doesNotThrow(()=>verifyUpdateCompatibility({...updateCompatibility,dsh:'future-build'},legacy));
  assert.doesNotThrow(()=>verifyUpdateCompatibility(actual,legacy));
  assert.doesNotThrow(()=>verifyUpdateCompatibility({dataSchema:1},{...legacy,coreCapabilities:['unavailable_custom_interface']}));
  assert.throws(()=>verifyUpdateCompatibility({...actual,dataSchema:2},updateCompatibility),/data schema/);
});

function gitRelease(version, {changed=false,immutable=true,prerelease=version.includes('-'),compatibility=updateCompatibility,prerequisites}={}) {
  const tag='v'+version;
  const root='https://github.com/'+repository+'/releases/download/'+tag+'/';
  const name='whalenest-companion-'+version+'-linux-x64.connect-plugin';
  const body=JSON.stringify({schema:1,pluginId,target:'linux-x64',version,sha256:digest,compatibility,notes:release.notes,...(prerequisites?{prerequisites}:{})});
  const meta='sha256:'+createHash('sha256').update(body).digest('hex');
  return {manifestBody:body, row:{tag_name:tag,immutable,draft:false,prerelease,assets:[
    {name,browser_download_url:root+name,digest:'sha256:'+(changed?'b'.repeat(64):digest)},
    {name:'distribution.json',browser_download_url:root+'distribution.json',digest:meta},
  ]}};
}

test('release metadata needs only the instance schema and ignores historical environment restrictions',async()=>{
  assert.equal(Object.hasOwn(updateCompatibility,'dsh'),false);
  assert.equal(Object.hasOwn(updateCompatibility,'dshVersions'),false);
  for (const compatibility of [{dataSchema:1},{dataSchema:1,dsh:'historical-version',dshVersions:'unused',core:'older-core',coreCapabilities:['missing_custom_tool']}]) {
    const git=gitRelease(next,{compatibility});
    const fetchImpl=async value=>new URL(value).hostname==='api.github.com'
      ?Response.json(git.row):new Response(git.manifestBody);
    const found=await discoverPluginRelease({repository},current,{fetchImpl,tag:'v'+next});
    assert.deepEqual(found.compatibility,compatibility);
    verifyUpdateCompatibility({...updateCompatibility,core:'current-core'},found.compatibility);
  }
});

test('the next public beta sorts after the deployed development candidate',async()=>{
  const candidate='1.0.0-beta.4.dev.14',publicBeta='1.0.0-beta.5';
  assert.ok(comparePluginVersions(candidate,'1.0.0-beta.4.dev.13')>0);
  assert.ok(comparePluginVersions(publicBeta,candidate)>0);
  const earlier=gitRelease('1.0.0-beta.4'),nextBeta=gitRelease(publicBeta);
  const found=await discoverPluginRelease({repository,channel:'beta'},candidate,{
    fetchImpl:async url=>new URL(url).hostname==='api.github.com'
      ?Response.json([earlier.row,nextBeta.row]):new Response(nextBeta.manifestBody),
  });
  assert.equal(found.version,publicBeta);
});

test('manual update checks bypass the six-hour cache while automatic checks reuse it',async t=>{
  const f=await fixture(t);let calls=0,offered=null;
  const service=createPluginUpdates(f.options,join(f.options.dataDir,'instance.json'),{
    host:f.host,connector:f.connector,discover:async()=>{calls++;return offered;},
  });
  await service.tick();assert.equal(calls,1);
  offered=release;
  await service.tick();assert.equal(calls,1,'Background checks retain their interval');
  assert.equal((await service.perform(clawchat,{action:'check'},'检查更新')).target,next);
  assert.equal(calls,2,'Manual check fetches fresh release data');
  offered=null;
  assert.equal((await service.perform(clawchat,{action:'check'},'检查更新')).state,'current');
  assert.equal(calls,3,'A second explicit check also bypasses the refreshed cache');
});

test('manual checks recover immediately after an automatic check failed',async t=>{
  const f=await fixture(t);let calls=0,fail=true;
  const service=createPluginUpdates(f.options,join(f.options.dataDir,'instance.json'),{
    host:f.host,connector:f.connector,discover:async()=>{calls++;if(fail)throw Error('Temporary release outage');return release;},
  });
  await service.tick();assert.equal(calls,1);
  await service.tick();assert.equal(calls,1);
  fail=false;
  assert.equal((await service.perform(clawchat,{action:'check'},'检查更新')).target,next);
  assert.equal(calls,2);
  assert.equal(readState(updateFiles(f.options).cache,null).failedUntil,undefined);
});

test('release discovery checks the pinned digest and immutable source, and orders numeric development releases',async()=>{
  assert.ok(comparePluginVersions('0.3.0-whalenest.m4.1-dev.20','0.3.0-whalenest.m4.1-dev.9')>0);
  assert.ok(comparePluginVersions('0.3.0','0.3.0-whalenest.m4.1-dev.99')>0);
  const git=gitRelease(next),older=gitRelease('0.3.0-whalenest.m4.1-dev.9'),mutable=gitRelease('0.3.1',{immutable:false});
  let changed=false;
  const fetchImpl=async u=>{
    const url=new URL(u);
    if (url.hostname==='api.github.com') {
      if (url.pathname.includes('/tags/')) return Response.json(changed?gitRelease(next,{changed}).row:git.row);
      return Response.json([older.row,mutable.row,git.row]);
    }
    assert.equal(url.href,git.row.assets[1].browser_download_url);
    return new Response(git.manifestBody);
  };
  assert.deepEqual(await discoverPluginRelease({repository},current,{fetchImpl}),release);
  assert.equal(await discoverPluginRelease({repository,channel:'stable'},current,{fetchImpl}),null);
  changed=true;
  await assert.rejects(discoverPluginRelease({repository},current,{fetchImpl,tag:release.tag}),/checksum disagrees/);
});

async function fixture(t, mode='ok') {
  const dir=await mkdtemp(join(tmpdir(),'whalenest-update-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={instanceId:'test-instance',dataDir:dir,cwd:dir,owners:[clawchat,qq],clawchat:{route:clawchat,delivery:{connectBin:'/bin/false',configPath:join(dir,'config.json')}},pluginUpdates:{repository}};
  const calls=[], notices=new Map(), state={installed:old,active:true,idle:true}, userState=join(dir,'conversation.json');
  await writeFile(userState,'first entry');
  const host={
    installed:()=>state.installed,
    identity:async()=>state.active?{key:'original-private-binding',idle:state.idle}:null,
    versions:async()=>updateCompatibility,
    async change(action,body) {
      calls.push([action,body]);
      if(action==='select'){
        state.installed=old;state.active=true;return true;
      }
      if(mode==='rejected')return false;
      if(mode==='unknown')throw Error('Management connection interrupted');
      state.installed={...old,version:next,source:{type:'github',repository,release:release.tag},retainedVersions:[old]};
      if(mode==='unhealthy'){
        state.active=false;
        await writeFile(userState,'first entry and newly added entry');
        return false;
      }
      return true;
    },
  };
  const discover=async()=>release;
  const connector={check:async()=>({state:'current',current:'0.2.26',latest:'0.2.26',automaticUpdate:false,managedBy:'user'})};
  const service=createPluginUpdates(options,join(dir,'instance.json'),{
    host,connector,discover,target:()=>({ok:true,route:qq}),notify:intent=>notices.set(intent.id,notices.get(intent.id)??intent),
  });
  const delivery={async sendText(intent){notices.set(intent.id,{...intent,source:'plugin-update-result'});return {messageId:'private-result-receipt'};}};
  return {options,service,host,state,connector,discover,calls,notices,userState,delivery,wait:async()=>{},activate:async()=>({state:'ready'})};
}

function toolContext(content, source={kind:'user'}) {
  const events=[
    {type:'user/message',data:{source,content:[{type:'text',text:content}]}},
    {type:'assistant/message',data:{message:{id:'assistant',content:[{type:'tool-call',id:'call'}]}}},
  ];
  return {callId:'call',agent:{session:{seq:events.length-1,eventAt:index=>events[index]}}};
}

test('managed instructions conflicts stop an update before installation, while success synchronizes the selected version',async t=>{
  const blocked=await fixture(t);
  await blocked.service.perform(clawchat,{action:'check'},'检查更新');
  const held=await blocked.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  blocked.host.prepareInstructions=()=>{throw Error('managed instructions were edited');};
  assert.equal((await executePluginUpdate(blocked.options,held.jobId,blocked)).phase,'failed');
  assert.equal(blocked.calls.length,0);
  const f=await fixture(t),events=[];
  f.host.prepareInstructions=()=>events.push('preflight');
  f.host.syncInstructions=entry=>{events.push('sync');assert.equal(entry.version,next);return {state:'managed',version:entry.version};};
  const change=f.host.change;f.host.change=async(...args)=>{events.push('switch');return change(...args);};
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  const result=await executePluginUpdate(f.options,job.jobId,f);
  assert.equal(result.phase,'completed');assert.equal(result.workspaceInstructions.version,next);
  assert.ok(events.indexOf('preflight')<events.indexOf('switch')&&events.indexOf('sync')>events.indexOf('switch'));
});

test('the update worker restores the old managed overview while retaining notes added by a failed new version',async t=>{
  const f=await fixture(t,'unhealthy');
  const source=version=>{const template=version===current?'原版能力。\n':'新版能力。\n';return {version,template,sha256:createHash('sha256').update(template).digest('hex')};};
  const apply=entry=>applyWorkspaceInstructions(planWorkspaceInstructions(f.options,source(entry.version)));
  apply(f.state.installed);
  f.host.prepareInstructions=()=>planWorkspaceInstructions(f.options,source(f.state.installed.version));
  f.host.syncInstructions=apply;
  const change=f.host.change;
  f.host.change=async(...args)=>{
    const accepted=await change(...args);
    if(args[0]!=='select'){
      apply(f.state.installed);
      const path=join(f.options.cwd,'AGENTS.md');await writeFile(path,(await readFile(path,'utf8'))+'\n切换后新增的用户规则。\n');
    }
    return accepted;
  };
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'rolled-back');
  const text=await readFile(join(f.options.cwd,'AGENTS.md'),'utf8');
  assert.match(text,/原版能力/);assert.doesNotMatch(text,/新版能力/);assert.match(text,/切换后新增的用户规则/);
});

test('a shared owner job requires an exact current message and delivers one result to the asking private chat', async t=>{
  const f=await fixture(t);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.notices.size,1);
  assert.equal([...f.notices.values()][0].route.channel,'qq');
  const tool=f.service.tool(clawchat);
  const pending=await tool.execute({action:'check'},toolContext('检查更新'));
  assert.equal(pending.confirmationRequired,'确认更新 '+next);
  const pasted=await tool.execute({action:'confirm',version:next},toolContext('别人说过：确认更新 '+next));
  assert.equal(pasted.ok,false);assert.match(pasted.message,/完整确认文字/);
  const scheduled=await tool.execute({action:'confirm',version:next},toolContext('确认更新 '+next,{kind:'schedule'}));
  assert.equal(scheduled.ok,false);assert.match(scheduled.message,/后台任务/);
  const group=await f.service.tool({...clawchat,kind:'group'}).execute({action:'check'},toolContext('检查更新'));
  assert.equal(group.ok,false);assert.match(group.message,/主人私聊/);
  const job=await tool.execute({action:'confirm',version:next},toolContext('<clawchat_turn_context>\ntrusted metadata\n</clawchat_turn_context>\n\n确认更新 '+next));
  const duplicate=await f.service.tool(qq).execute({action:'confirm',version:next},toolContext('',{
    kind:'aurabot',speaker:{role:'owner',chat:'private'},humanText:'确认更新 '+next,
  }));
  assert.equal(duplicate.jobId,job.jobId);
  f.state.idle=false;
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'queued');
  assert.equal(f.calls.length,0);
  f.state.idle=true;
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'completed');
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'completed');
  assert.deepEqual(f.calls,[['replace',{source:'github:'+repository+'@'+release.tag}]]);
  const restarted=createPluginUpdates(f.options,'fixture',{host:f.host,connector:f.connector,discover:f.discover,notify:intent=>f.notices.set(intent.id,f.notices.get(intent.id)??intent)});
  await restarted.tick({notices:false});
  await restarted.tick({notices:false});
  const result=[...f.notices.values()].filter(n=>n.source==='plugin-update-result');
  assert.equal(result.length,1);
  assert.deepEqual(result[0].route,clawchat);
});

test('a failed switch selects the recorded version and leaves forward data in the original directory',async t=>{
  const f=await fixture(t,'unhealthy');
  await f.service.perform(qq,{action:'check'},'检查更新');
  const job=await f.service.perform(qq,{action:'confirm',version:next},'确认更新 '+next);
  const result=await executePluginUpdate(f.options,job.jobId,f);
  assert.equal(result.phase,'rolled-back');
  assert.deepEqual(f.calls[1],['select',{version:current,integrity}]);
  assert.equal(await readFile(f.userState,'utf8'),'first entry and newly added entry');
  assert.equal((await f.service.perform(clawchat,{action:'status'},'进度')).state,'rolled-back');
});

test('an acknowledged rejection is terminal; a lost ACK reconciles without another switch',async t=>{
  const rejected=await fixture(t,'rejected');
  await rejected.service.perform(qq,{action:'check'},'检查更新');
  const first=await rejected.service.perform(qq,{action:'confirm',version:next},'确认更新 '+next);
  assert.equal((await executePluginUpdate(rejected.options,first.jobId,rejected)).phase,'failed');
  assert.equal(rejected.calls.length,1);
  const f=await fixture(t,'unknown');
  await f.service.perform(qq,{action:'check'},'检查更新');
  const job=await f.service.perform(qq,{action:'confirm',version:next},'确认更新 '+next);
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'uncertain');
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'uncertain');
  f.state.installed={...old,version:next,source:{type:'github',repository,release:release.tag}};
  assert.equal((await executePluginUpdate(f.options,job.jobId,f)).phase,'completed');
  assert.equal(f.calls.length,1);
});

test('the same-source managed update is pinned; concurrent workers admit only one switch',async t=>{
  const f=await fixture(t);
  f.state.installed={...old,source:{type:'github',repository,release:'v'+current}};
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  await Promise.all([executePluginUpdate(f.options,job.jobId,f),executePluginUpdate(f.options,job.jobId,f)]);
  assert.deepEqual(f.calls,[['update',{source:'github:'+repository+'@'+release.tag}]]);
  assert.equal(readState(updateProgress(f.options,job.jobId),null).phase,'completed');
  assert.equal(readState(updateFiles(f.options).request,null).release.sha256,digest);
});

test('a selected release waits for authenticated Runtime activation and an unknown restart is not repeated',async t=>{
  const f=await fixture(t);f.options.realtime={enabled:true};let ready=false,restarts=0;
  const activate=(options,ports)=>ensureRuntimeActivation(options,{...ports,attempts:2,wait:async()=>{},probe:async()=>ready,
    restart:async()=>{restarts++;throw Error('supervisor ACK lost');}});
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  assert.equal((await executePluginUpdate(f.options,job.jobId,{...f,activate})).phase,'uncertain');
  assert.equal(readState(updateProgress(f.options,job.jobId)).runtimeActivation.ack,'unknown');
  assert.equal(f.calls.length,1);assert.equal(restarts,1);
  ready=true;
  assert.equal((await executePluginUpdate(f.options,job.jobId,{...f,activate})).phase,'completed');
  assert.equal(f.calls.length,1);assert.equal(restarts,1);
});

test('rollback has its own Runtime activation intent and preserves new user data',async t=>{
  const f=await fixture(t,'unhealthy');f.options.realtime={enabled:true};let ready=false,restarts=0;
  const activate=(options,ports)=>ensureRuntimeActivation(options,{...ports,attempts:2,wait:async()=>{},probe:async()=>ready,
    restart:async()=>{restarts++;ready=true;}});
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  const result=await executePluginUpdate(f.options,job.jobId,{...f,activate});
  assert.equal(result.phase,'rolled-back');assert.equal(result.rollbackActivation.target.version,current);
  assert.equal(result.runtimeActivation,undefined);assert.equal(restarts,1);
  assert.equal(await readFile(f.userState,'utf8'),'first entry and newly added entry');
});

test('updates also activate the native writer for QQ and background work when voice is disabled',async t=>{
  const f=await fixture(t);f.options.realtime={enabled:false};f.options.qq={enabled:true};f.options.activities={enabled:true};let restarts=0;
  const activate=(options,ports)=>{
    assert.equal(ports.required,true);
    return ensureRuntimeActivation(options,{...ports,attempts:2,wait:async()=>{},restart:async()=>{
      restarts++;writeState(join(options.dataDir,'runtime.lock'),{instanceId:options.instanceId,hostname:hostname(),pid:process.pid});
    }});
  };
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  const result=await executePluginUpdate(f.options,job.jobId,{...f,activate});
  assert.equal(result.phase,'completed');assert.equal(result.runtimeActivation.state,'ready');assert.equal(restarts,1);
});

test('the production updater reads instance schema without version commands or custom connector records',async t=>{
  const f=await fixture(t);
  const {configPath}=f.options.clawchat.delivery;
  writeState(configPath,{agents:{agent:{runtime:{pluginId,capabilityId:'deepseek-harness'}}},stateDbPath:'/tmp/state.db'});
  writeState(join(f.options.dataDir,'runtime.json'),{instanceId:f.options.instanceId,schema:1});
  writeState(join(f.options.dataDir,'plugins.lock.json'),{plugins:{[pluginId]:old}});
  const directory=join(f.options.dataDir,'connector'),binary=Buffer.from('verified-core-fixture');
  await mkdir(directory);
  await writeFile(join(directory,'clawchat-connect-core'),binary);
  f.options.clawchat.delivery.connectBin=join(directory,'clawchat-connect');
  f.options.pluginUpdates.dshExecutable='/unavailable/dsh';
  writeState(join(f.options.dataDir,'connector-override.json'),{directory,
    binarySha256:createHash('sha256').update(binary).digest('hex'),coreCapabilities:updateCompatibility.coreCapabilities});
  const host=connectUpdateHost(f.options,{
    runSync:(_bin,args)=>args[0].endsWith('/platform-query.mjs')?JSON.stringify([{pluginId,version:current,status:'active',source:{type:'local',path:'/fixture'},target:'linux-x64',integrity:'sha256-fixture'}]):JSON.stringify({agents:{agent:{runtime:{pluginId,capabilityId:'deepseek-harness'}}}}),
    run:async (bin,args)=>{
      assert.equal(bin,f.options.clawchat.delivery.connectBin);
      assert.equal(args[0],'__clawnest-state','Neither Core nor DSH --version may gate updates');
      return {stdout:JSON.stringify({ownerId:clawchat.sender,conversationId:clawchat.conversation,available:true,connected:true,running:0,queued:0})};
    },
    fetchImpl:async (url,request)=>{
      assert.equal(url,'http://127.0.0.1:47822/core/v1/plugins/'+pluginId+'/update');
      assert.equal(request.headers['X-ClawChat-Connect-Core-Config-Path'],configPath);
      assert.equal(request.method,'POST');
      assert.deepEqual(JSON.parse(request.body),{source:'github:'+repository+'@'+release.tag});
      return Response.json({active:true});
    },
  });
  assert.equal(host.installed().version,current);
  assert.equal((await host.identity()).idle,true);
  assert.deepEqual(await host.versions(),{dataSchema:updateCompatibility.dataSchema});
  verifyUpdateCompatibility(await host.versions(),updateCompatibility);
  assert.equal(await host.change('update',{source:'github:'+repository+'@'+release.tag}),true);
  await writeFile(join(directory,'clawchat-connect-core'),'changed-core');
  await writeFile(join(f.options.dataDir,'connector-override.json'),'unreadable legacy record');
  assert.deepEqual(await host.versions(),{dataSchema:updateCompatibility.dataSchema});
});

const requirement={minimumVersion:'0.2.22',upgradeVersion:'0.2.22'};
const prerequisites={clawchatIntegration:requirement};
function nativeStatus(version='0.2.20') {
  return {status:'running',selected:{id:version+'-package',version},
    running:{id:version+'-package',version,health:{version,identity:'agent-identity',ready:true,connected:true,draining:false}}};
}

async function connectorFixture(t,mode='ok') {
  const f=await fixture(t,mode),candidate={...release,prerequisites};
  f.discover=async()=>candidate;
  f.connectorCalls=[];
  f.connector={
    async check(){return {state:'available',current:'0.2.20',latest:'0.2.99',automaticUpdate:false,managedBy:'user'};},
    async prepare(){f.connectorCalls.push('prepare');throw Error('No automatic preparation');},
    async upgrade(){f.connectorCalls.push('upgrade');throw Error('No automatic upgrade');},
    async rollback(){f.connectorCalls.push('rollback');throw Error('No automatic rollback');},
  };
  f.service=createPluginUpdates(f.options,'fixture',{host:f.host,connector:f.connector,discover:f.discover});
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  f.job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  return f;
}

test('new releases omit connector prerequisites while authenticated historical metadata remains readable',async()=>{
  assert.equal(updatePrerequisites,undefined);
  const git=gitRelease(next,{prerequisites});
  const found=await discoverPluginRelease({repository},current,{tag:'v'+next,fetchImpl:async u=>
    new URL(u).hostname==='api.github.com'?Response.json(git.row):new Response(git.manifestBody)});
  assert.deepEqual(found.prerequisites,prerequisites);
  for(const bad of [null,{}, {clawchatIntegration:{...requirement,executable:'/bin/false'}},
    {clawchatIntegration:{...requirement,minimumVersion:'future'}},
    {clawchatIntegration:{...requirement,upgradeVersion:'0.2.21'}},
    {clawchatIntegration:{...requirement,officialOnly:'yes'}}])assert.throws(()=>validateUpdatePrerequisites(bad));
});

test('connector versions are advisory and historical minimum versions cannot block a Whale Nest update',async t=>{
  const f=await connectorFixture(t);
  const offer=await f.service.perform(clawchat,{action:'check'},'检查更新');
  assert.deepEqual(offer.connector,{state:'available',current:'0.2.20',latest:'0.2.99',automaticUpdate:false,managedBy:'user'});
  assert.match(offer.interruption,/只更新鲸栖/);
  assert.equal(offer.connector.minimumVersion,undefined);
  assert.equal((await executePluginUpdate(f.options,f.job.jobId,f)).phase,'completed');
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.connectorCalls,[]);
  assert.equal(await readFile(f.userState,'utf8'),'first entry');
});

test('connector check outages and newer versions neither block nor mutate the connector during Whale Nest updates',async t=>{
  for(const mode of ['unavailable','newer']) {
    const f=await connectorFixture(t);
    f.connector.check=async()=>{
      if(mode==='unavailable')throw Error('Official version service unavailable');
      return {state:'current',current:'0.2.99',latest:'0.2.99',automaticUpdate:false,managedBy:'user'};
    };
    const offer=await f.service.perform(clawchat,{action:'check'},'检查更新');
    assert.equal(offer.state,'available');
    assert.equal(offer.connector.state,mode==='unavailable'?'unavailable':'current');
    assert.equal((await executePluginUpdate(f.options,f.job.jobId,f)).phase,'completed',mode);
    assert.deepEqual(f.connectorCalls,[],mode);
  }
});

test('connector checks remain visible when Whale Nest has no release or its release service fails',async t=>{
  for(const failed of [false,true]) {
    const f=await connectorFixture(t);
    const service=createPluginUpdates(f.options,'fixture',{host:f.host,connector:f.connector,discover:async()=>{
      if(failed)throw Error('Release service unavailable');
      return null;
    }});
    const result=await service.perform(clawchat,{action:'check'},'检查更新');
    assert.equal(result.state,failed?'check-failed':'current');
    assert.equal(result.connector.state,'available');
    assert.equal(result.connector.current,'0.2.20');
  }
});

test('automatic checks notify about the connector without a Whale Nest release and retain the six-hour cache',async t=>{
  const f=await fixture(t);let checks=0;
  const notices=new Map();
  const service=createPluginUpdates(f.options,'fixture',{host:f.host,discover:async()=>null,
    connector:{check:async()=>{checks++;return {state:'available',current:'0.2.26',latest:'0.2.27'};}},
    target:()=>({ok:true,route:clawchat}),notify:intent=>notices.set(intent.id,intent)});
  await service.tick();await service.tick();
  assert.equal(checks,1);assert.equal(notices.size,1);
  assert.equal([...notices.values()][0].source,'connector-update-available');
  assert.match([...notices.values()][0].text,/你决定/);
});

test('Whale Nest rejection and rollback never roll back the independently managed connector',async t=>{
  for(const mode of ['rejected','unhealthy']) {
    const f=await connectorFixture(t,mode);
    const result=await executePluginUpdate(f.options,f.job.jobId,f);
    assert.equal(result.phase,mode==='rejected'?'failed':'rolled-back');
    assert.deepEqual(f.connectorCalls,[]);
    assert.equal(f.calls.some(([op])=>op==='select'),mode==='unhealthy');
    if(mode==='unhealthy')assert.equal(await readFile(f.userState,'utf8'),'first entry and newly added entry');
  }
});

test('legacy pending connector intents stop for manual verification without replay or rollback',async t=>{
  for(const phase of ['connector-submitting','connector-updating','connector-rolling-back','uncertain']) {
    const f=await connectorFixture(t),file=updateProgress(f.options,f.job.jobId);
    const change={before:{selectedId:'old',identity:'agent'},target:'new',jobId:'old-job'};
    writeState(file,{phase,reason:'connector-ack-unknown',connector:change,identity:'original-private-binding'});
    for(let attempt=0;attempt<2;attempt++) {
      const result=await executePluginUpdate(f.options,f.job.jobId,f);
      assert.equal(result.phase,'uncertain');assert.equal(result.reason,'legacy-connector-task-manual');
      assert.deepEqual(result.connector,change);
    }
    assert.deepEqual(f.connectorCalls,[]);assert.deepEqual(f.calls,[]);
  }
});

test('the official version adapter only issues status and check, reports actual running version and filters unrelated data',async t=>{
  const f=await fixture(t),calls=[];
  f.options.clawchat.delivery.connectBin='/retired/custom/clawchat-connect';
  writeState(join(f.options.dataDir,'connector-override.json'),{baseVersion:'0.2.20'});
  const adapter=createOfficialConnectorInspector(f.options,{run:async(bin,args,settings)=>{
    assert.equal(bin,'/usr/local/bin/clawchat-dsh');assert.equal(settings.cwd,f.options.cwd);calls.push(args);
    return {stdout:JSON.stringify(args[1]==='status'?{...nativeStatus('0.2.26'),selected:{version:'0.2.28'}}:
      {status:'update_available',secret:'never expose',release:{version:'0.2.27',runtime:'deepseek-harness',plugin:'clawchat-connect'}})};
  }});
  const checked=await adapter.check();
  assert.equal(checked.current,'0.2.26');assert.equal(checked.latest,'0.2.27');assert.equal(checked.state,'available');
  assert.equal(checked.automaticUpdate,false);assert.equal(checked.managedBy,'user');assert.equal(checked.secret,undefined);
  assert.deepEqual(Object.keys(adapter),['check']);
  assert.deepEqual(calls.sort((a,b)=>a[1].localeCompare(b[1])),[['plugin','check'],['plugin','status']]);
});

test('version checks preserve the running version on release lookup failure and never recommend a downgrade',async t=>{
  const f=await fixture(t);
  for(const mode of ['offline','foreign','older','malformed','missing-running']) {
    const adapter=createOfficialConnectorInspector(f.options,{run:async(_bin,args)=>{
      if(args[1]==='status')return {stdout:JSON.stringify(mode==='missing-running'?{selected:{version:'0.2.28'}}:nativeStatus('0.2.26'))};
      if(mode==='offline')throw Error('Offline');
      return {stdout:JSON.stringify({status:'update_available',release:{version:mode==='older'?'0.2.25':mode==='malformed'?'bad':'0.2.27',
        runtime:'deepseek-harness',plugin:mode==='foreign'?'other':'clawchat-connect'}})};
    }});
    const checked=await adapter.check();
    assert.equal(checked.current,mode==='missing-running'?undefined:'0.2.26',mode);
    assert.equal(checked.state,mode==='older'?'current':'unavailable',mode);
    assert.equal(checked.automaticUpdate,false);
  }
});

test('failed Whale Nest jobs require a fresh explicit confirmation and retry gets its own receipt',async t=>{
  const f=await connectorFixture(t,'rejected');
  assert.equal((await executePluginUpdate(f.options,f.job.jobId,f)).phase,'failed');
  const retried=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  assert.notEqual(retried.jobId,f.job.jobId);assert.equal(retried.state,'queued');
  assert.equal(readState(updateProgress(f.options,f.job.jobId),null).phase,'failed');
});

test('unhealthy updates use normalized public rollback metadata and preserve new data through lost ACKs and worker recovery',async t=>{
 for(const mode of ['valid','lost-ack','recovery','missing','wrong-version','wrong-integrity']){
  const f=await fixture(t,'unhealthy');
  let rows;
  async function refresh(){
   const selected={...f.state.installed,pluginId};
   if(selected.version===next){
    selected.status='error';
    const retained={...old,installationConfiguration:{token:'never-export'},capabilityConfigurations:{secret:'hidden'}};
    if(mode==='wrong-version')retained.version='0.3.0-other';
    if(mode==='wrong-integrity')retained.integrity='sha256-'+Buffer.alloc(32,7).toString('base64');
    if(mode==='missing')delete selected.retainedVersions;
    else selected.retainedVersions=[retained];
   }
   rows=await queryPlatformPlugins(f.options.clawchat.delivery.configPath,{fetchImpl:async()=>Response.json([selected])});
  }
  await refresh();
  const change=f.host.change;
  f.host.installed=()=>installedPlugin(f.options,pluginId,{run:(_bin,args)=>{
   assert.ok(args[0].endsWith('/platform-query.mjs'));return JSON.stringify(rows);
  }});
  f.host.change=async(action,body)=>{
   if(mode==='recovery'&&action==='select'){f.calls.push([action,body]);throw Error('Selection accepted; completion delayed');}
   const accepted=await change(action,body);await refresh();
   if(mode==='lost-ack'&&action==='select')throw Error('Response lost after selection');
   return accepted;
  };
  await f.service.perform(clawchat,{action:'check'},'检查更新');
  const job=await f.service.perform(clawchat,{action:'confirm',version:next},'确认更新 '+next);
  let result=await executePluginUpdate(f.options,job.jobId,f);
  if(mode==='recovery'){
   assert.equal(result.phase,'uncertain');assert.equal(result.reason,'rollback-unconfirmed');
   assert.equal(f.calls.filter(([op])=>op==='select').length,1);
   f.state.installed=old;f.state.active=true;await refresh();
   result=await executePluginUpdate(f.options,job.jobId,{...f,host:{...f.host}});
  }
  const restored=['valid','lost-ack','recovery'].includes(mode);
  assert.equal(result.phase,restored?'rolled-back':'uncertain',mode);
  if(restored)assert.equal(f.host.installed().version,current,mode);
  else assert.equal(result.reason,'rollback-point-unconfirmed',mode);
  assert.equal(f.calls.filter(([op])=>op==='select').length,restored?1:0,mode);
  assert.equal(await readFile(f.userState,'utf8'),'first entry and newly added entry',mode);
  assert.ok(!JSON.stringify(rows).includes('never-export'),mode);
  await executePluginUpdate(f.options,job.jobId,f);
  assert.equal(f.calls.filter(([op])=>op==='select').length,restored?1:0,mode);
 }
});
