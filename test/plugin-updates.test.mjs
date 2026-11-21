import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {comparePluginVersions,discoverPluginRelease,pluginId,updateCompatibility} from '../src/plugin-release.mjs';
import {createPluginUpdates} from '../src/plugin-updates.mjs';
import {connectUpdateHost,executePluginUpdate,updateFiles,updateProgress} from '../src/plugin-update-worker.mjs';
import {readState,writeState} from '../src/state.mjs';

const repository='whalenest-fixture/releases';
const current='0.3.0-whalenest.m4.1-dev.22', next='0.3.0-whalenest.m4.1-dev.23';
const digest='a'.repeat(64);
const release={repository,tag:'v'+next,version:next,sha256:digest,compatibility:updateCompatibility,notes:'修复重启后的更新回执恢复'};
const integrity='sha256-'+Buffer.alloc(32,3).toString('base64');
const old={status:'active',version:current,target:'linux-x64',source:{type:'local'},integrity};
const qq={channel:'qq',kind:'private',account:'1000',conversation:'1001',sender:'1001'};
const clawchat={channel:'clawchat',kind:'private',account:'agent',conversation:'claw-chat',sender:'owner'};

function gitRelease(version, {changed=false,immutable=true,prerelease=version.includes('-')}={}) {
  const tag='v'+version;
  const root='https://github.com/'+repository+'/releases/download/'+tag+'/';
  const name='whalenest-companion-'+version+'-linux-x64.connect-plugin';
  const body=JSON.stringify({schema:1,pluginId,target:'linux-x64',version,sha256:digest,compatibility:updateCompatibility,notes:release.notes});
  const meta='sha256:'+createHash('sha256').update(body).digest('hex');
  return {manifestBody:body, row:{tag_name:tag,immutable,draft:false,prerelease,assets:[
    {name,browser_download_url:root+name,digest:'sha256:'+(changed?'b'.repeat(64):digest)},
    {name:'distribution.json',browser_download_url:root+'distribution.json',digest:meta},
  ]}};
}

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
  const service=createPluginUpdates(options,join(dir,'instance.json'),{
    host,discover,target:()=>({ok:true,route:qq}),notify:intent=>notices.set(intent.id,notices.get(intent.id)??intent),
  });
  const delivery={async sendText(intent){notices.set(intent.id,{...intent,source:'plugin-update-result'});return {messageId:'private-result-receipt'};}};
  return {options,service,host,state,discover,calls,notices,userState,delivery,wait:async()=>{}};
}

function toolContext(content, source={kind:'user'}) {
  const events=[
    {type:'user/message',data:{source,content:[{type:'text',text:content}]}},
    {type:'assistant/message',data:{message:{id:'assistant',content:[{type:'tool-call',id:'call'}]}}},
  ];
  return {callId:'call',agent:{session:{seq:events.length-1,eventAt:index=>events[index]}}};
}

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
  const restarted=createPluginUpdates(f.options,'fixture',{host:f.host,discover:f.discover,notify:intent=>f.notices.set(intent.id,f.notices.get(intent.id)??intent)});
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

test('the production adapter scopes the request to the configured Core and reads the actual runtime versions',async t=>{
  const f=await fixture(t);
  const {configPath}=f.options.clawchat.delivery;
  writeState(configPath,{agents:{agent:{runtime:{pluginId,capabilityId:'deepseek-harness'}}},stateDbPath:'/tmp/state.db'});
  writeState(join(f.options.dataDir,'runtime.json'),{instanceId:f.options.instanceId,schema:1});
  writeState(join(f.options.dataDir,'plugins.lock.json'),{plugins:{[pluginId]:old}});
  const host=connectUpdateHost(f.options,{
    run:async (bin,args)=>({stdout:args[0]==='--version'
      ?bin==='/bin/false'?'clawchat-connect v'+updateCompatibility.core:updateCompatibility.dsh
      :JSON.stringify({ownerId:clawchat.sender,conversationId:clawchat.conversation,available:true,connected:true,running:0,queued:0})}),
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
  assert.deepEqual(await host.versions(),updateCompatibility);
  assert.equal(await host.change('update',{source:'github:'+repository+'@'+release.tag}),true);
});
