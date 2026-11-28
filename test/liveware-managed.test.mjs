import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {livewareCommands} from '../src/liveware-command.mjs';
import {createManagedLivewareProvider,startManagedLiveware} from '../src/liveware-managed.mjs';
import {discoverManagedLiveware,prepareLegacyLivewareMigration,readManagedLiveware,
  restoreLegacyLivewareLauncher,rollbackManagedLiveware,livewarePublication} from '../src/liveware-migration.mjs';
import {realtimeCallUrl} from '../src/chat-liveware.mjs';
import {retryUnexecutedLivewareOperation} from '../src/liveware-operation.mjs';

const oldUrl = 'https://app-original-call.apps.clawling.io/';
const stableUrl = 'https://app-stable-call.apps.clawling.io/';
const managedUrl = 'https://app-managed-call.apps.clawling.io/';
const route = {channel:'clawchat',kind:'private',account:'dsh',conversation:'private',sender:'owner'};
const managedApp = {appId:'app-managed-call',name:'鲸栖通话 · dsh',publicUrl:managedUrl};
async function migrationReady(f){
  for(let n=0;n<100;n++){
    const state=readManagedLiveware(f.options);
    if(state?.legacy&&['legacy-launcher-retired','managed','ready'].includes(state.phase))return;
    await delay(10);
  }
  assert.fail('Background stable call initialization did not settle');
}

async function fixture(t, {legacy = true} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'whalenest-managed-liveware-'));
  const cleanup=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();await rm(directory,{recursive:true,force:true});});
  const options = {instanceId:'test',dataDir:directory,owners:[route],clawchat:{route,
    delivery:{connectBin:'/verified/connect',configPath:'/verified/config.json'}},
  realtime:{enabled:true,port:8897,...(legacy?{publicOrigin:oldUrl}:{})},singing:{playback:{enabled:true}}};
  const original = {binding:route.account,owner:route.sender,appId:'app-original-call',url:oldUrl};
  if (legacy) await writeFile(join(directory,'call-liveware.json'),JSON.stringify(original));
  const apps = [...(legacy?[{appId:'app-original-call',name:'鲸栖通话',publicUrl:oldUrl}]:[]),
    {appId:'app-songs',name:'鲸栖歌曲',publicUrl:'https://app-songs.apps.clawling.io/'}];
  const launchers = apps.map(app=>({app_id:app.appId,name:app.name,url:app.publicUrl}));
  const effects = [];
  const commands = {
    async inspectApp(appId) { effects.push(['inspect',appId]);return apps.find(app=>app.appId===appId); },
    async listApps() { return structuredClone(apps); },
    async listLaunchers() { return {apps:structuredClone(launchers)}; },
    async createApp(name,control) {
      effects.push(['create',name,control.requestId]);
      let app=apps.find(app=>app.appId==='app-stable-call');
      if(!app) {app={appId:'app-stable-call',name,publicUrl:stableUrl};apps.push(app);}
      return app;
    },
    async bindTunnel(appId,upstream,control) {
      effects.push(['bind',appId,control.requestId,upstream]);
      const app=apps.find(app=>app.appId===appId);
      if(!launchers.some(row=>row.app_id===appId))launchers.push({app_id:appId,name:app.name,url:app.publicUrl});
      return {appId,publicUrl:app.publicUrl,registeredInClawChat:true};
    },
    async unregisterLauncher(appId,control) {
      effects.push(['unregister',appId,control.requestId]);
      const index=launchers.findIndex(app=>app.app_id===appId);
      if (index >= 0) launchers.splice(index,1);
      return {ok:true};
    },
    async registerLauncher(app,control) {
      effects.push(['register',app.appId,control.requestId]);
      launchers.push({app_id:app.appId,name:app.name,url:app.url});
      return {ok:true};
    },
  };
  return {directory,options,original,apps,launchers,effects,commands,cleanup};
}

test('migration retires only the old launcher before Exposure can publish, retaining old App, URL and song',async t=>{
  const f=await fixture(t);
  const service=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>service.release());
  assert.equal(service.health(),'ready');
  await migrationReady(f);
  assert.deepEqual(f.launchers.map(app=>app.app_id),['app-songs']);
  assert.ok(f.apps.some(app=>app.appId==='app-original-call'));
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'call-liveware.json'))),f.original);
  assert.equal(f.options.realtime.publicOrigin,oldUrl);
  f.apps.push(managedApp);
  // This is the official publisher's action, after the provider is ready.
  f.launchers.push({app_id:managedApp.appId,name:managedApp.name,url:managedApp.publicUrl});
  await discoverManagedLiveware(f.options,{commands:f.commands});
  assert.equal(f.launchers.length,2);
  assert.equal(readManagedLiveware(f.options).publication.url,managedUrl);
  await service.release();
  assert.equal(service.health(),'stopped');
  assert.equal(f.apps.length,3,'historical App remains as a working alias, without a launcher');
  assert.equal(f.launchers.length,2);
  const next=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>next.release());
  assert.equal(f.effects.filter(([action])=>action==='unregister').length,1);
  assert.equal(f.launchers.length,2,'restart does not restore or duplicate the old launcher');
});

test('unknown unregister reuses its journaled request, and rollback/re-migration uses a new operation',async t=>{
  const f=await fixture(t), original=f.commands.unregisterLauncher;
  let first=true;
  f.commands.unregisterLauncher=async(appId,control)=>{
    if (first) { first=false;f.effects.push(['unknown',appId,control.requestId]);throw Error('receipt lost'); }
    return await original(appId,control);
  };
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),/receipt lost/);
  const pending=readManagedLiveware(f.options).retireOperation.requestId;
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  assert.equal(f.effects.find(([action])=>action==='unregister')[2],pending);
  await assert.rejects(restoreLegacyLivewareLauncher(f.options,{commands:f.commands}),/Stop official Exposure/);
  await restoreLegacyLivewareLauncher(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(f.launchers.length,2);
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  const retirements=f.effects.filter(([action])=>action==='unregister');
  assert.equal(retirements.length,2);
  assert.notEqual(retirements[0][2],retirements[1][2],'a completed operation must not mask a later rollback');
  assert.equal(f.apps.length,2);
});

test('a changed owner blocks admission; an auxiliary registration error does not block the real local service',async t=>{
  const f=await fixture(t);
  const provider=createManagedLivewareProvider({readOptions:()=>f.options,commands:{...f.commands,
    listLaunchers:async()=>({unexpected:[]})}});
  assert.throws(()=>provider.instanceKey({bindingId:'someone-else'}),/verified private binding/);
  const service=await provider.acquire({bindingId:'dsh'});f.cleanup.push(()=>service.release());
  assert.equal(service.health(),'ready');assert.equal((await fetch(service.upstream+'/healthz')).status,200);
  await delay(30);
  assert.equal(f.effects.filter(([action])=>action==='unregister').length,0);
  assert.equal(f.launchers.length,2);
});

test('fresh instances retain a stable card App while official publication identity can change',async t=>{
  const f=await fixture(t,{legacy:false});
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  f.apps.push(managedApp);
  await discoverManagedLiveware(f.options,{commands:f.commands});
  const card=JSON.parse(await readFile(join(f.directory,'call-liveware.json')));
  assert.equal(card.url,stableUrl);
  assert.equal(card.stable,true);
  assert.equal(f.effects.find(([action])=>action==='bind')[3],'http://127.0.0.1:8897');
  f.apps.push({...managedApp,appId:'app-duplicate',publicUrl:'https://app-duplicate.apps.clawling.io/'});
  await assert.rejects(discoverManagedLiveware(f.options,{commands:f.commands}),/Multiple official/);
  f.apps.splice(f.apps.findIndex(app=>app.appId===managedApp.appId),1);
  await discoverManagedLiveware(f.options,{commands:f.commands});
  assert.equal(readManagedLiveware(f.options).publication.appId,'app-duplicate');
  assert.equal(JSON.parse(await readFile(join(f.directory,'call-liveware.json'))).url,stableUrl);
});

test('a lost fresh create receipt is durable, cannot be replayed, and cannot be reported as a completed rollback',async t=>{
  const f=await fixture(t,{legacy:false}),create=f.commands.createApp;
  let calls=0;
  f.commands.createApp=async(...args)=>{calls++;await create(...args);throw Error('create response lost');};
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),/create response lost/);
  const pending=readManagedLiveware(f.options).stableCall;
  assert.equal(pending.create.state,'pending');assert.equal(pending.bind.state,'unissued');
  assert.ok(pending.create.requestId);
  assert.equal(JSON.parse(await readFile(join(f.directory,'call-liveware.json'))).provisioning,true);
  assert.equal(realtimeCallUrl(f.options),null,'an uncertain App is not advertised as a usable card');
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),error=>
    error.status==='unknown' && error.requestId===pending.create.requestId);
  const result=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(result.ok,false);assert.equal(result.migrated,true);assert.equal(result.status,'unknown');
  assert.equal(result.requestId,pending.create.requestId);assert.equal(calls,1);
  assert.ok(f.apps.some(app=>app.appId==='app-stable-call'),'the possible owned App is preserved');
  assert.deepEqual(f.launchers.map(app=>app.app_id),['app-songs']);
  assert.equal(f.effects.filter(([action])=>action==='bind' || action==='unregister').length,0);
});

test('an uncertain auxiliary App cannot block provider acquisition; exact receipts recover it without another write',async t=>{
  const f=await fixture(t,{legacy:false});
  f.commands.createApp=async()=>{throw Error('lost after submit');};
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),/lost after/);
  const original=readManagedLiveware(f.options).stableCall.create.requestId;
  let receipt={requestId:original,status:'pending'},creates=0;
  f.commands.createApp=async()=>{creates++;assert.fail('Do not replay the unknown create');};
  f.commands.readReceipt=async(name,id)=>{assert.equal(name,'liveware_app_create');assert.equal(id,original);return receipt;};
  f.apps.push({appId:'app-stable-call',name:'鲸栖通话',publicUrl:stableUrl});
  const service=await startManagedLiveware(()=>f.options,{commands:f.commands,bindingId:'dsh',pollInterval:10});
  f.cleanup.push(()=>service.release());
  assert.equal((await fetch(service.upstream+'/healthz')).status,200);
  assert.equal(service.health(),'ready');assert.equal(readManagedLiveware(f.options).stableCall.create.state,'pending');
  receipt={requestId:original,status:'succeeded',result:f.apps.at(-1)};
  await migrationReady(f);
  assert.equal(creates,0);assert.equal(realtimeCallUrl(f.options),stableUrl);
  assert.equal(f.effects.filter(([kind])=>kind==='bind').length,1);
  await service.release();
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  assert.equal(f.effects.filter(([kind])=>kind==='bind').length,1);
});

test('a lost fresh bind receipt keeps the confirmed App and original request but never rebinds or mutates other launchers',async t=>{
  const f=await fixture(t,{legacy:false}),bind=f.commands.bindTunnel;
  let calls=0;
  f.commands.bindTunnel=async(...args)=>{
    calls++;
    const state=readManagedLiveware(f.options).stableCall;
    assert.equal(state.create.state,'succeeded');assert.equal(state.app.appId,'app-stable-call');
    assert.equal(state.bind.state,'pending','App identity is durable before binding is dispatched');
    await bind(...args);throw Error('bind response lost');
  };
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),/bind response lost/);
  const pending=readManagedLiveware(f.options).stableCall;
  assert.equal(pending.app.appId,'app-stable-call');assert.equal(pending.bind.state,'pending');
  assert.equal(realtimeCallUrl(f.options),null);
  // Even an unrelated same-name App must not be guessed as our publication.
  f.apps.push({...managedApp,appId:'app-user-other',publicUrl:'https://app-user-other.apps.clawling.io/'});
  f.launchers.push({app_id:'app-user-other',name:managedApp.name,url:'https://app-user-other.apps.clawling.io/'});
  const before=structuredClone(f.launchers);
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),error=>
    error.status==='unknown' && error.requestId===pending.bind.requestId);
  const result=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(result.ok,false);assert.equal(result.phase,'stable-call-bind');
  assert.equal(result.requestId,pending.bind.requestId);assert.equal(calls,1);
  assert.equal(f.effects.filter(([action])=>action==='create').length,1);
  assert.deepEqual(f.launchers,before,'unknown bind cannot authorize deleting any guessed launcher');
  assert.equal(f.effects.filter(([action])=>action==='unregister' || action==='register').length,0);
});

test('stable App recovery requires terminal zero-execution proof and preserves the original expired operation',async t=>{
 const f=await fixture(t,{legacy:false}),create=f.commands.createApp;let creates=0;
 f.commands.createApp=async(...args)=>{creates++;if(creates===1)throw Error('queue timed out');return create(...args);};
 await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),/queue timed out/);
 const original=readManagedLiveware(f.options).stableCall.create.requestId;
 f.commands.readReceipt=async(name,id)=>({requestId:id,status:'expired',unexecuted:true});
 await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
 const progress=readManagedLiveware(f.options).stableCall;
 assert.equal(creates,2);assert.equal(realtimeCallUrl(f.options),stableUrl);
 assert.equal(progress.create.attempts[0].requestId,original);
 let op={requestId:'original',state:'pending'};
 for(let i=0;i<2;i++){op=retryUnexecutedLivewareOperation(op,{status:'expired',unexecuted:true});assert.ok(op);}
 assert.equal(retryUnexecutedLivewareOperation(op,{status:'expired',unexecuted:true}),null);
});

test('restart after a confirmed create resumes only an unissued bind, without replaying create',async t=>{
  const f=await fixture(t,{legacy:false});
  const app=livewarePublication(await f.commands.createApp('鲸栖通话',{requestId:'create-before-crash'}));
  await writeFile(join(f.directory,'managed-liveware.json'),JSON.stringify({schema:1,instanceId:f.options.instanceId,
    binding:route.account,owner:route.sender,phase:'provisioning-stable-call',stableCall:{
      upstream:'http://127.0.0.1:8897',app,create:{requestId:'create-before-crash',state:'succeeded'},
      bind:{requestId:'bind-not-issued-before-crash',state:'unissued'},
    }}));
  await writeFile(join(f.directory,'call-liveware.json'),JSON.stringify({binding:route.account,owner:route.sender,provisioning:true}));
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  assert.equal(f.effects.filter(([action])=>action==='create').length,1);
  const binds=f.effects.filter(([action])=>action==='bind');assert.equal(binds.length,1);
  assert.equal(binds[0][2],'bind-not-issued-before-crash');assert.equal(realtimeCallUrl(f.options),stableUrl);
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  assert.equal(f.effects.filter(([action])=>action==='create' || action==='bind').length,2);
});

test('rollback after a durable bind confirmation finalizes local identity without replaying either platform write',async t=>{
  const f=await fixture(t,{legacy:false});
  const app=livewarePublication(await f.commands.createApp('鲸栖通话',{requestId:'confirmed-create'}));
  const bound=await f.commands.bindTunnel(app.appId,'http://127.0.0.1:8897',{requestId:'confirmed-bind'});
  const publication=livewarePublication({...app,publicUrl:bound.publicUrl});
  await writeFile(join(f.directory,'managed-liveware.json'),JSON.stringify({schema:1,instanceId:f.options.instanceId,
    binding:route.account,owner:route.sender,phase:'provisioning-stable-call',stableCall:{
      upstream:'http://127.0.0.1:8897',app,publication,
      create:{requestId:'confirmed-create',state:'succeeded'},bind:{requestId:'confirmed-bind',state:'succeeded'},
    }}));
  await writeFile(join(f.directory,'call-liveware.json'),JSON.stringify({binding:route.account,owner:route.sender,provisioning:true}));
  const result=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(result.ok,true);assert.equal(result.appId,app.appId);
  assert.equal(realtimeCallUrl(f.options),stableUrl);
  assert.equal(f.effects.filter(([action])=>action==='create').length,1);
  assert.equal(f.effects.filter(([action])=>action==='bind').length,1);
  assert.equal(f.effects.filter(([action])=>action==='unregister' || action==='register').length,0);
  assert.deepEqual(f.launchers.map(app=>app.app_id).sort(),['app-songs','app-stable-call']);
});

test('an interrupted dev.18 provisioning marker remains unknown rather than claiming an empty rollback',async t=>{
  const f=await fixture(t,{legacy:false});
  await writeFile(join(f.directory,'managed-liveware.json'),JSON.stringify({schema:1,instanceId:f.options.instanceId,
    binding:route.account,owner:route.sender,phase:'provisioning-stable-call'}));
  const result=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(result.ok,false);assert.equal(result.status,'unknown');assert.equal(result.migrated,true);
  assert.match(result.requestId,/^whalenest-stable-call-create-/);
  await assert.rejects(prepareLegacyLivewareMigration(f.options,{commands:f.commands}),error=>error.status==='unknown');
  assert.equal(f.effects.length,0,'the historical marker must not cause a fresh platform write');
});

test('official hot replacement keeps stable cards and two launchers without recreating or rebinding the stable App',async t=>{
  const f=await fixture(t,{legacy:false});
  const first=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>first.release());
  await migrationReady(f);
  f.apps.push(managedApp);f.launchers.push({app_id:managedApp.appId,name:managedApp.name,url:managedApp.publicUrl});
  await discoverManagedLiveware(f.options,{commands:f.commands});
  const stableCard=await readFile(join(f.directory,'call-liveware.json'),'utf8');
  await first.release();
  // Official replacement retires only its own managed App, then selects the
  // next provider generation and publishes a new managed identity.
  f.apps.splice(f.apps.findIndex(app=>app.appId===managedApp.appId),1);
  f.launchers.splice(f.launchers.findIndex(app=>app.app_id===managedApp.appId),1);
  const second=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>second.release());
  const next={...managedApp,appId:'app-managed-next',publicUrl:'https://app-managed-next.apps.clawling.io/'};
  f.apps.push(next);f.launchers.push({app_id:next.appId,name:next.name,url:next.publicUrl});
  await discoverManagedLiveware(f.options,{commands:f.commands});
  assert.equal(await readFile(join(f.directory,'call-liveware.json'),'utf8'),stableCard);
  assert.equal(f.launchers.length,2);
  assert.equal(f.effects.filter(([action])=>action==='create').length,1);
  assert.equal(f.effects.filter(([action])=>action==='bind').length,1);
  assert.ok(f.apps.some(app=>app.appId==='app-stable-call'));
  f.options.realtime.enabled=false;
  assert.equal((await fetch(second.upstream+'/',{headers:{'x-clawchat-user-id':'owner',origin:new URL(managedUrl).origin}})).status,403);
  assert.equal((await fetch(second.upstream+'/',{headers:{'x-clawchat-user-id':'owner',origin:new URL(next.publicUrl).origin}})).status,503);
});

test('a generation stops remote reads after discovery and the next acquire discovers its replacement',async t=>{
  const f=await fixture(t);f.apps.push(managedApp);
  const list=f.commands.listApps;let reads=0;
  f.commands.listApps=async control=>{reads++;return await list(control);};
  const first=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>first.release());
  for(let n=0;n<30 && !readManagedLiveware(f.options)?.publication;n++)await delay(10);
  assert.equal(readManagedLiveware(f.options)?.publication.appId,managedApp.appId);
  assert.equal(reads,1);await delay(50);assert.equal(reads,1,'healthy generation does not journal repeated CLI reads');
  await first.release();
  f.apps.splice(f.apps.findIndex(app=>app.appId===managedApp.appId),1,
    {...managedApp,appId:'app-replacement',publicUrl:'https://app-replacement.apps.clawling.io/'});
  const second=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>second.release());
  for(let n=0;n<30 && readManagedLiveware(f.options)?.publication.appId!=='app-replacement';n++)await delay(10);
  assert.equal(readManagedLiveware(f.options)?.publication.appId,'app-replacement');
  assert.equal(reads,2);await delay(50);assert.equal(reads,2);
});

test('port zero stable cards bind the actual call gateway, and managed origins pass its original checks',{
  timeout:15000,
},async t=>{
  const f=await fixture(t);
  const {startPlatformVoiceLiveware}=await import('../src/platform-voice-liveware.mjs');
  f.options.cwd=f.directory;f.options.realtime.port=0;
  f.options.realtime.publicOrigin=new URL(oldUrl).origin;
  f.options.realtime.python=process.env.WHALENEST_TEST_PYTHON;
  const provider=join(f.directory,'provider.json');
  await writeFile(provider,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture',baseUrl:'http://127.0.0.1:1/v1'}}}}));
  f.options.speech={enabled:true,providerConfigPath:provider,asrModel:'fixture-asr',ttsModel:'fixture-tts'};
  const gateway=await startPlatformVoiceLiveware(f.options,{readProfile:async()=>({name:'fixture'}),
    withCallSession:async()=>{}});
  f.cleanup.push(()=>gateway.close());
  const managed=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>managed.release());
  f.apps.push(managedApp);await discoverManagedLiveware(f.options,{commands:f.commands});
  const headers={'x-clawchat-user-id':'owner',origin:new URL(managedUrl).origin};
  const page=await fetch(managed.upstream+'/',{headers});
  assert.equal(page.status,200);assert.match(await page.text(),/<title>鲸栖通话<\/title>/);
  assert.equal((await fetch(managed.upstream+'/',{headers:{...headers,origin:'https://unrelated.invalid'}})).status,403);
  const original=await fetch('http://127.0.0.1:'+gateway.port+'/',{
    headers:{'x-clawchat-user-id':'owner',origin:new URL(oldUrl).origin}});
  assert.equal(original.status,200);await original.body.cancel();
  // A fresh allocated backend uses its recorded, live process port as well.
  const fresh=await fixture(t,{legacy:false});fresh.options.realtime.port=0;
  await mkdir(join(fresh.directory,'realtime'));
  await writeFile(join(fresh.directory,'realtime/server.json'),JSON.stringify({state:'ready',pid:process.pid,port:gateway.port}));
  await prepareLegacyLivewareMigration(fresh.options,{commands:fresh.commands});
  assert.equal(fresh.effects.find(([action])=>action==='bind')[3],'http://127.0.0.1:'+gateway.port);
});

test('combined rollback removes only the new launcher and restores the stable launcher repeatedly',async t=>{
  const f=await fixture(t);
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  f.apps.push(managedApp);f.launchers.push({app_id:managedApp.appId,name:managedApp.name,url:managedApp.publicUrl});
  // Publication discovery has not run yet: rollback must discover it publicly.
  const result=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(result.ok,true);
  assert.deepEqual(f.launchers.map(app=>app.app_id).sort(),['app-original-call','app-songs']);
  assert.equal(f.apps.length,3,'rollback retains every App/tunnel identity');
  const writes=f.effects.filter(([action])=>['register','unregister'].includes(action)).length;
  assert.equal((await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true})).ok,true);
  assert.equal(f.effects.filter(([action])=>['register','unregister'].includes(action)).length,writes);
});

test('unknown rollback writes are never reissued and settle from fresh public observations',async t=>{
  const f=await fixture(t);
  await prepareLegacyLivewareMigration(f.options,{commands:f.commands});
  f.apps.push(managedApp);f.launchers.push({app_id:managedApp.appId,name:managedApp.name,url:managedApp.publicUrl});
  let writes=0;
  f.commands.unregisterLauncher=async()=>{writes++;throw Error('connection lost after dispatch');};
  const pending=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(pending.status,'unknown');assert.equal(writes,1);
  const repeated=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(repeated.requestId,pending.requestId);assert.equal(writes,1);
  f.launchers.splice(f.launchers.findIndex(app=>app.app_id===managedApp.appId),1);
  const settled=await rollbackManagedLiveware(f.options,{commands:f.commands,exposureStopped:true});
  assert.equal(settled.ok,true);assert.equal(writes,1);
  assert.deepEqual(f.launchers.map(app=>app.app_id).sort(),['app-original-call','app-songs']);
});

test('private managed entry streams HTTP/SSE and forwards polling, owner, Origin and Host without relaxing admission',async t=>{
  const f=await fixture(t,{legacy:false});
  f.apps.push(managedApp);
  let finishSse, received=[];
  const backend=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    received.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
    if(req.url==='/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\n\n');
      await new Promise(resolve=>finishSse=resolve);
      res.end('data: second\n\n');
    } else res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(received.at(-1)));
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  f.cleanup.push(()=>new Promise(resolve=>backend.close(resolve)));
  f.options.realtime.port=backend.address().port;
  const service=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:20});
  f.cleanup.push(()=>service.release());
  await discoverManagedLiveware(f.options,{commands:f.commands});
  const headers={'x-clawchat-user-id':'owner',origin:new URL(managedUrl).origin};
  assert.equal((await fetch(service.upstream+'/healthz')).status,200);
  assert.equal((await fetch(service.upstream+'/',{headers:{...headers,'x-clawchat-user-id':'intruder'}})).status,403);
  assert.equal((await fetch(service.upstream+'/',{headers:{...headers,origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(service.upstream+'/',{headers:{'x-clawchat-user-id':'owner'}})).status,403);
  assert.equal(received.length,0);
  const reply=await fetch(service.upstream+'/api/poll?session=s&after=16',{method:'POST',headers,body:'pcm-frames'});
  const data=await reply.json();
  assert.equal(data.url,'/api/poll?session=s&after=16');assert.equal(data.body,'pcm-frames');
  assert.equal(data.headers.host,'app-managed-call.apps.clawling.io');
  assert.equal(data.headers['x-forwarded-host'],'app-managed-call.apps.clawling.io');
  assert.equal(data.headers.origin,headers.origin);assert.equal(data.headers['x-clawchat-user-id'],'owner');
  const stream=await fetch(service.upstream+'/events',{headers}),reader=stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/first/);
  finishSse();
  assert.match(new TextDecoder().decode((await reader.read()).value),/second/);
  assert.equal((await reader.read()).done,true);
  for(const [call,song] of [[true,true],[false,true],[true,false],[false,false]]) {
    f.options.realtime.enabled=call;f.options.singing.playback.enabled=song;
    assert.equal(service.health(),'ready');
    const response=await fetch(service.upstream+'/',{headers});
    assert.equal(response.status,call?200:503);
    if(!call)assert.equal(await response.text(),'通话已关闭。');else await response.body.cancel();
  }
});

test('managed entry preserves WebSocket upgrade headers and both directions of raw frame data',async t=>{
  const f=await fixture(t,{legacy:false});f.apps.push(managedApp);
  const frame=Buffer.from([0x81,0x82,1,2,3,4,0x49,0x6b]);
  const backend=createServer();
  backend.on('upgrade',(req,socket,head)=>{
    assert.equal(req.headers['x-clawchat-user-id'],'owner');
    assert.equal(req.headers.origin,new URL(managedUrl).origin);
    assert.equal(req.headers.host,'app-managed-call.apps.clawling.io');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixture\r\n\r\n');
    if(head.length)socket.write(head);
    socket.pipe(socket);
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  f.cleanup.push(()=>new Promise(resolve=>backend.close(resolve)));
  f.options.realtime.port=backend.address().port;
  const service=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:20});
  f.cleanup.push(()=>service.release());await discoverManagedLiveware(f.options,{commands:f.commands});
  const address=new URL(service.upstream);
  await new Promise((resolve,reject)=>{
    const socket=connect(Number(address.port),'127.0.0.1');
    const timer=setTimeout(()=>{socket.destroy();reject(Error('WebSocket proxy did not echo the frame'));},3000);
    let buffer=Buffer.alloc(0),upgraded=false;
    socket.on('error',reject);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(!upgraded) {
        const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
        assert.match(buffer.subarray(0,end).toString(),/^HTTP\/1.1 101/);
        assert.match(buffer.subarray(0,end).toString(),/Sec-WebSocket-Accept: fixture/i);
        buffer=buffer.subarray(end+4);upgraded=true;socket.write(frame);
      }
      if(buffer.length>=frame.length) {assert.deepEqual(buffer,frame);clearTimeout(timer);socket.destroy();resolve();}
    });
    socket.on('connect',()=>socket.write('GET /ws HTTP/1.1\r\nHost: app-managed-call.apps.clawling.io\r\nOrigin: https://app-managed-call.apps.clawling.io\r\nX-ClawChat-User-Id: owner\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: fixture\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  });
});

test('binding identity changes fence an existing managed service and release is repeatable',async t=>{
  const f=await fixture(t,{legacy:false});
  const service=await startManagedLiveware(()=>f.options,{bindingId:'dsh',commands:f.commands,pollInterval:10});
  f.cleanup.push(()=>service.release());
  let exited=false;service.onExit(()=>{exited=true;});
  f.options.clawchat.route={...route,conversation:'other-private'};
  for(let n=0;n<30 && !exited;n++)await delay(10);
  assert.equal(exited,true);assert.equal(service.health(),'error');
  await service.release();await service.release();assert.equal(service.health(),'stopped');
});

test('Liveware commands use only the configured official CLI and generate fresh read request IDs',async t=>{
  const dir=await fixture(t);const invocations=[],options={...dir.options,clawchat:{route,delivery:{connectBin:'/verified/connect',configPath:'/verified/config.json'}}};
  const commands=livewareCommands(options,{run:async(executable,args)=>{
    if(args[0]==='__clawnest-state')return {stdout:JSON.stringify({ownerId:route.sender,conversationId:route.conversation,connected:true})};invocations.push({executable,args});return {stdout:JSON.stringify({status:'succeeded',result:{apps:[]}})};
  }});
  await commands.listLaunchers();await commands.listLaunchers();
  await commands.unregisterLauncher('app-old',{requestId:'stable-remove'});
  assert.ok(invocations.every(call=>call.executable==='/verified/connect' && call.args.includes('dsh') && call.args.includes('/verified/config.json')));
  const id=call=>call.args[call.args.indexOf('--request-id')+1];
  assert.notEqual(id(invocations[0]),id(invocations[1]));assert.equal(id(invocations[2]),'stable-remove');
  assert.ok(invocations[2].args.includes('clawchat_unregister_app'));
  const failed=livewareCommands(options,{run:async()=>{const error=Error('exit 1');
    error.stdout=JSON.stringify({requestId:'known-failure',status:'failed',error:'permission denied'});throw error;}});
  await assert.rejects(failed.unregisterLauncher('app-old',{requestId:'known-failure'}),error=>error.receipt?.status==='failed');
});
