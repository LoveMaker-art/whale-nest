import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ensureRuntimeActivation,runtimeActivationTarget,probeRuntimeVoice,probeRuntimeReady} from '../src/runtime-activation.mjs';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'whalenest-activation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const options={instanceId:'activation-fixture',dataDir:directory,cwd:directory,realtime:{enabled:true}};
 const installed={status:'active',version:'1.0.0-fixture',integrity:'sha256-fixture',activationGeneration:7};
 const identity={key:'original-private-owner',idle:true},host={installed:()=>installed,identity:async()=>identity};
 let record;const ports={host,expected:runtimeActivationTarget(installed,identity),read:()=>record,save:value=>{record=value;},
  attempts:2,wait:async()=>{},intervalMs:0};
 return {options,ports,installed,identity,record:()=>record};
}

test('voice readiness is an authenticated local metadata request',async t=>{
 const f=await fixture(t),secret='a'.repeat(64);await mkdir(join(f.options.dataDir,'realtime'));
 await writeFile(join(f.options.dataDir,'realtime/session-secret'),secret,{mode:0o600});
 let requests=0;
 const server=createServer((req,res)=>{
  requests++;assert.equal(req.url,'/voice/v1/settings');assert.equal(req.method,'GET');
  if(req.headers['x-voice-secret']!==secret){res.writeHead(403);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({voice:'fixture-voice'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 f.options.realtime.bridgePort=server.address().port;
 assert.equal(await probeRuntimeVoice(f.options),true);
 assert.equal(await probeRuntimeReady(f.options),false,'The endpoint alone cannot stand in for a running native writer');
 await writeFile(join(f.options.dataDir,'runtime.lock'),JSON.stringify({instanceId:f.options.instanceId,hostname:hostname(),pid:process.pid}));
 assert.equal(await probeRuntimeReady(f.options),true);
 await writeFile(join(f.options.dataDir,'realtime/session-secret'),'b'.repeat(64));
 assert.equal(await probeRuntimeVoice(f.options),false);assert.equal(requests,3);
});

test('disabled voice and an already ready Runtime never submit a restart',async t=>{
 assert.deepEqual(await ensureRuntimeActivation({realtime:{enabled:false}}),{state:'ready',skipped:true});
 const f=await fixture(t);let restarts=0;
 assert.equal((await ensureRuntimeActivation(f.options,{...f.ports,probe:async()=>true,restart:async()=>{restarts++;}})).state,'ready');
 assert.equal(restarts,0);assert.equal(f.record(),undefined);
});

test('the exact activation intent is durable before the single restart and readiness gates completion',async t=>{
 const f=await fixture(t);let ready=false,restarts=0;
 const result=await ensureRuntimeActivation(f.options,{...f.ports,probe:async()=>ready,
  save:async value=>{await Promise.resolve();f.ports.save(value);},
  restart:async()=>{
   assert.equal(f.record().state,'restart-submitting');assert.deepEqual(f.record().target,f.ports.expected);
   restarts++;ready=true;
  }});
 assert.equal(result.state,'ready');assert.equal(restarts,1);assert.equal(f.record().ack,'accepted');
});

test('a lost restart ACK and a restarted worker only reconcile the original intent',async t=>{
 const f=await fixture(t);let ready=false,restarts=0;
 const ports={...f.ports,probe:async()=>ready,restart:async()=>{restarts++;throw Error('lost supervisor acknowledgement');}};
 assert.equal((await ensureRuntimeActivation(f.options,ports)).state,'uncertain');
 assert.equal(f.record().ack,'unknown');assert.equal(restarts,1);
 assert.equal((await ensureRuntimeActivation(f.options,ports)).state,'uncertain');assert.equal(restarts,1);
 ready=true;assert.equal((await ensureRuntimeActivation(f.options,ports)).state,'ready');assert.equal(restarts,1);
});

test('a busy, different owner or changed selection cannot be restarted by this job',async t=>{
 for(const change of [f=>{f.identity.idle=false;},f=>{f.identity.key='different-owner';},f=>{f.installed.activationGeneration++;}]){
  const f=await fixture(t);let restarts=0;change(f);
  const result=await ensureRuntimeActivation(f.options,{...f.ports,probe:async()=>false,restart:async()=>{restarts++;}});
  assert.ok(['pending','unavailable'].includes(result.state));assert.equal(restarts,0);assert.equal(f.record(),undefined);
 }
});

test('concurrent callers cannot submit two supervisor restarts',async t=>{
 const f=await fixture(t),started=Promise.withResolvers(),release=Promise.withResolvers();let ready=false,restarts=0;
 const ports={...f.ports,probe:async()=>ready,restart:async()=>{restarts++;started.resolve();await release.promise;ready=true;}};
 const first=ensureRuntimeActivation(f.options,ports);await started.promise;
 assert.deepEqual(await ensureRuntimeActivation(f.options,ports),{state:'pending',reason:'activation-busy'});
 release.resolve();assert.equal((await first).state,'ready');assert.equal(restarts,1);
});

 test('paused realtime does not gate native writer readiness on a removed voice endpoint',async t=>{
 const f=await fixture(t);f.options.realtime.sessionEnabled=false;
 assert.equal(await probeRuntimeReady(f.options),false);
 await writeFile(join(f.options.dataDir,'runtime.lock'),JSON.stringify({instanceId:f.options.instanceId,hostname:hostname(),pid:process.pid}));
 assert.equal(await probeRuntimeReady(f.options,{fetchImpl:()=>{throw Error('voice endpoint must not be queried');}}),true);
});
