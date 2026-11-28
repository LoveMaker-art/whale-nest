import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startRuntimeBridge,scopedRuntimeBridge} from '../src/runtime-bridge-client.mjs';

async function fixture(t,mode='normal',overrides={}){
 const root=await mkdtemp(join(tmpdir(),'whalenest-wire-test-')),logFile=join(root,'process.jsonl');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const options={executable:process.execPath,executableArguments:[fileURLToPath(new URL('./fixtures/runtime-bridge-child.mjs',import.meta.url))],
  cwd:root,home:root,profile:'fixture',bridgePath:'/fixture/owned-bridge.mjs',bridgeBuild:'fixture-protocol2',
  startTimeoutMs:1000,requestTimeoutMs:1000,stopTimeoutMs:100,
  ...overrides,env:{HOME:root,WHALENEST_TEST_BRIDGE_LOG:logFile,WHALENEST_TEST_BRIDGE_MODE:mode,...overrides.env}};
 const rows=async()=>{try{return(await readFile(logFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 return {options,rows};
}
async function cleaned(f){
 const start=(await f.rows()).find(row=>row.kind==='start');
 assert.ok(start,'The real child must have started');
 await assert.rejects(stat(dirname(start.overlay)),{code:'ENOENT'});
 assert.throws(()=>process.kill(start.pid,0),{code:'ESRCH'});
}

test('real FD bridge validates fragmented UTF-8 hello, multiplexes frames, and removes its process directory',async t=>{
 const f=await fixture(t),client=await startRuntimeBridge(f.options);t.after(()=>client.close());
 assert.equal(client.hello.protocol.build,'运维自测鲸鱼');
 const observed=[],questions=[];const offEvent=client.onEvent(frame=>observed.push(frame)),offQuestion=client.onInteraction(frame=>questions.push(frame));
 assert.deepEqual(await client.request('fragment'),{text:'鲸鱼回复'});
 assert.equal(observed[0].event.data.text,'鲸鱼回复');assert.equal(questions[0].id,'question-1');
 offEvent();offQuestion();
 await client.request('fragment');assert.equal(observed.length,1);assert.equal(questions.length,1);
 const start=(await f.rows())[0];assert.equal(start.home,f.options.home);assert.equal(start.inputFd,4);assert.equal(start.outputFd,3);
 await client.close();await client.close();await cleaned(f);
});

test('a timed-out request is never resent and a late or missing ACK leaves the connection usable',async t=>{
 const f=await fixture(t),client=await startRuntimeBridge(f.options);t.after(()=>client.close());
 await assert.rejects(client.request('hang',{operation:'one-submit-only'},25),{name:'BridgeTimeoutError'});
 await assert.rejects(client.request('delayed',{},25),{name:'BridgeTimeoutError'});await delay(100);
 assert.deepEqual(await client.request('echo',{next:true}),{method:'echo',params:{next:true}});
 const requests=(await f.rows()).filter(row=>row.kind==='request');
 assert.equal(requests.filter(row=>row.method==='hang').length,1);
 assert.equal(requests.filter(row=>row.method==='delayed').length,1);
 assert.equal(requests.filter(row=>row.method==='echo').length,1);
 await assert.rejects(client.request('error'),error=>error.name==='DshBridgeRemoteError'&&error.code==='session-not-found');
});

test('a peer frame budget rejects an oversized outbound request before writing it',async t=>{
 const f=await fixture(t,'normal',{env:{WHALENEST_TEST_BRIDGE_LIMIT:'1024'}}),client=await startRuntimeBridge(f.options);t.after(()=>client.close());
 await assert.rejects(client.request('echo',{body:'x'.repeat(2048)}),/request exceeds limit/);
 assert.equal((await f.rows()).filter(row=>row.kind==='request').length,0);
});

test('bad identity, incompatible protocol, missing hello and early child exit all clean up',async t=>{
 for(const mode of ['bad-home','bad-major','silent','early-exit']){
  const f=await fixture(t,mode,{startTimeoutMs:250});
  await assert.rejects(startRuntimeBridge(f.options),error=>{
   assert.doesNotMatch(error.message,/fixture-only-private-token/);return true;
  });
  await cleaned(f);
 }
});

test('an initialization failure returns a bounded code before timeout without exposing child stderr',async t=>{
 const f=await fixture(t,'startup-error');
 await assert.rejects(startRuntimeBridge(f.options),error=>{
  assert.equal(error.code,'BUSINESS_INITIALIZATION_FAILED');assert.doesNotMatch(error.message,/fixture-only-private-token|timed out/);return true;
 });
 await cleaned(f);
});

test('malformed frames, repeated hello and unexpected exits reject every in-flight request',async t=>{
 for(const method of ['malformed','duplicate-hello','exit']){
  const f=await fixture(t),client=await startRuntimeBridge(f.options);t.after(()=>client.close());
  const failures=[];client.onFailure(error=>failures.push(error));
  const pending=client.request('hang').catch(error=>error),failed=client.request(method).catch(error=>error);
  const result=await failed;assert.ok(result instanceof Error);assert.doesNotMatch(result.message,/fixture-only-private-token/);
  assert.ok(await pending instanceof Error);assert.equal(failures.length,1);
  await client.close();await cleaned(f);
 }
});

test('shutdown escalates for an unresponsive child and rejects pending work without resubmission',async t=>{
 const f=await fixture(t,'stubborn',{stopTimeoutMs:25}),client=await startRuntimeBridge(f.options);
 const pending=client.request('hang').catch(error=>error);
 await client.close();assert.ok(await pending instanceof Error);await cleaned(f);
 const requests=(await f.rows()).filter(row=>row.kind==='request');
 assert.equal(requests.filter(row=>row.method==='shutdown').length,1);assert.equal(requests.filter(row=>row.method==='hang').length,1);
});

test('a closed request pipe reports failure without crashing the host process',async t=>{
 const f=await fixture(t,'closed-input',{stopTimeoutMs:25}),client=await startRuntimeBridge(f.options);t.after(()=>client.close());
 await delay(30);await assert.rejects(client.request('echo'),/write failed|exited|closed|pipe/i);
 await client.close();await cleaned(f);
});

function memoryBridge(){
 const calls=[],listeners=new Set();
 const id='11111111-1111-1111-1111-111111111111';
 const events=[{type:'turn/start',data:{turn:0}},{type:'user/message',data:{source:{kind:'user',connectInputId:'whalenest-call-'+id}}},
  {type:'assistant/message',data:{text:'call-only'}},{type:'turn/end',data:{turn:0}},
  {type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{kind:'user',connectInputId:'ordinary'}}},
  {type:'assistant/message',data:{text:'visible'}},{type:'turn/end',data:{turn:1}},{type:'model/selection',data:{}}];
 const client={hello:{},async request(method,params){calls.push({method,params});await delay(params?.delay??0);return method==='history'?{events}:{};},
  onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},onInteraction:()=>()=>{},close:async()=>{}};
 return {scope:scopedRuntimeBridge(client),calls,events,emit:frame=>{for(const listener of listeners)listener(frame);}};
}
test('concurrent request scopes keep chat ownership, call source and historical projection separate',async()=>{
 const f=memoryBridge(),gate=Promise.withResolvers();
 await Promise.all([
  f.scope.run({chatId:'private-a',input:{metadata:{whalenestSource:'realtime-call'}}},async()=>{
   await gate.promise;await f.scope.request('create',{sessionId:'a',whalenestChatId:'untrusted'});await f.scope.request('prompt',{sessionId:'a'});
  }),
  f.scope.run({chatId:'private-b',input:{}},async()=>{
   await f.scope.request('resume',{sessionId:'b'});gate.resolve();await f.scope.request('prompt',{sessionId:'b'});
  }),
 ]);
 assert.equal(f.calls.find(call=>call.method==='create').params.whalenestChatId,'private-a');
 assert.equal(f.calls.find(call=>call.method==='resume').params.whalenestChatId,'private-b');
 assert.equal(f.calls.find(call=>call.method==='prompt'&&call.params.sessionId==='a').params.whalenestSource,'realtime-call');
 assert.equal(f.calls.find(call=>call.method==='prompt'&&call.params.sessionId==='b').params.whalenestSource,undefined);
 const [chat,native]=await Promise.all([f.scope.run({projection:true},()=>f.scope.request('history',{delay:10})),f.scope.request('history')]);
 assert.equal(chat.events.filter(event=>event.type==='user/message').length,1);
 assert.equal(native.events.filter(event=>event.type==='user/message').length,2);
 assert.equal(f.events.length,9,'The native history must not be mutated');
});

test('aborted voice input never reaches the request writer and quiet events remain in native data only',async()=>{
 const f=memoryBridge(),controller=new AbortController();controller.abort();
 await assert.rejects(f.scope.run({input:{voiceSignal:controller.signal}},()=>f.scope.request('prompt',{sessionId:'cancelled'})),{name:'AbortError'});
 assert.equal(f.calls.length,0);
 const output=[];f.scope.onEvent(frame=>output.push(frame));
 f.emit({event:{type:'model/selection'}});f.emit({event:{type:'compaction/prune'}});f.emit({event:{type:'assistant/message'}});
 assert.equal(output.length,1);assert.equal(output[0].event.type,'assistant/message');
});
