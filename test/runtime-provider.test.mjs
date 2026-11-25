import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWhaleRuntimeEntry} from '../src/runtime-provider.mjs';

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'whalenest-public-runtime-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const state={calls:[],starts:[],privateReads:[],closed:0,threads:new Map(),startEntered:Promise.withResolvers(),
  bridgeEntered:Promise.withResolvers(),createEntered:Promise.withResolvers(),resumeEntered:Promise.withResolvers(),promptEntered:Promise.withResolvers()};
 const client={hello:{},async request(method,params){
  state.calls.push({method,params});
  if(method==='create'){state.createEntered.resolve();await state.createGate?.promise;state.threads.set(params.sessionId,{cwd:params.cwd});return {sessionId:params.sessionId,header:{cwd:params.cwd}};}
  if(method==='resume'){state.resumeEntered.resolve();await state.resumeGate?.promise;return {sessionId:params.sessionId,header:state.threads.get(params.sessionId)??{cwd:root}};}
  if(method==='archive')throw Object.assign(Error('fixture archive rejected'),{name:'DshBridgeRemoteError',code:state.archiveCode});
  if(method==='history')return {events:state.history??[]};
  return {recorded:true};
 },onEvent:()=>()=>{},onInteraction:()=>()=>{},onFailure:()=>()=>{},close:async()=>{}};
 const factory=options=>({activate(context){
  context.hostCapabilities.get('runtime-provider').register({create(){
   let preparing,bridge;
   const prepare=async()=>{await(preparing??=options.runtimeAdapter.createBridge({home:root}).then(value=>{bridge=value;}));};
   return {prepare,
    async start(start){
     await prepare();state.starts.push(start);state.startEntered.resolve();if(state.startGate)await state.startGate.promise;
     let thread=start.runtimeThreadId;
     const session={
      async *prompt(input){
       if(!thread){
        const created=await bridge.request('create',{sessionId:'native-public-'+state.starts.length,cwd:root});
        thread=created.sessionId;await start.onRuntimeThreadId(thread);
       }else await bridge.request('resume',{sessionId:thread});
       await bridge.request('prompt',{sessionId:thread,inputId:input.turnId,text:input.prompt});
       await input.onAccepted?.();state.promptEntered.resolve();await state.activeGate?.promise;
       if(state.cancelled){yield {kind:'turn',state:'cancelled',source:'live'};return;}
       yield {kind:'assistant',text:input.prompt,source:'live'};
      },async cancel(){state.cancelled=true;state.activeGate?.resolve();return true;},async close(){state.closed++;},
     };
     return new Proxy(session,{get(target,key){
      if(['client','ensureThread','runtimeThreadId'].includes(key)){
       state.privateReads.push(key);throw Error('Forbidden private official Session access: '+key);
      }
      return Reflect.get(target,key);
     }});
    },
    async readActivity(id){await prepare();return await bridge.request('history',{sessionId:id});},
    async archiveThread(id){await prepare();return await bridge.request('archive',{sessionId:id});},
    close:async()=>{},
   };
  }});
 }});
 let provider;
 createWhaleRuntimeEntry(factory,{runtimeAdapter:{createBridge:async()=>{state.bridgeEntered.resolve();await state.bridgeGate?.promise;return client;}}}).activate({
  hostCapabilities:{get:id=>({register:value=>{if(id==='runtime-provider')provider=value;}})},
 });
 const adapter=provider.create({homePath:root},{activationGeneration:1});
 const context=(chatId='private-a',runtimeThreadId=null)=>({chatId,bindingId:'agent',sessionId:'session-'+chatId,runtimeThreadId,
  async onRuntimeThreadId(id){state.callbacks??=[];state.callbacks.push({chatId,id});}});
 const input={workspace:{workingDirectory:root},prompt:'运维自测：公开运行接口',turnId:'fixture-input',model:{provider:'fixture',model:'model'}};
 return {root,state,adapter,context,input};
}

test('voice preparation creates one native thread and lazily starts the public Session on that same thread',async t=>{
 const f=await fixture(t),session=await f.adapter.start(f.context());
 const thread=await session.prepareVoice(f.input);
 assert.equal(f.state.starts.length,0,'Preparing voice must not read or create a private official Session');
 assert.deepEqual(f.state.callbacks,[{chatId:'private-a',id:thread}]);
 assert.equal(await session.prepareVoice(f.input),thread);
 await session.voiceMode(true);
 const playback={played:'已经听到的前缀',interrupted:true};await session.voicePlayback(playback);
 await session.voiceSpeech({text:'测试语音',requestId:'fixture-tts'});
 await session.expressReply({inputId:'fixture-input',afterReply:true});
 assert.deepEqual(await Array.fromAsync(session.prompt(f.input)),[{kind:'assistant',text:f.input.prompt,source:'live'}]);
 assert.equal(f.state.starts.length,1);assert.equal(f.state.starts[0].runtimeThreadId,thread);
 assert.equal(f.state.calls.filter(call=>call.method==='create').length,1);
 assert.ok(f.state.calls.filter(call=>['create','resume'].includes(call.method)).every(call=>call.params.whalenestChatId==='private-a'));
 assert.deepEqual(f.state.calls.find(call=>call.method==='companionVoicePlayback').params,{sessionId:thread,playback});
 assert.equal(f.state.calls.find(call=>call.method==='companionVoiceSpeech').params.sessionId,thread);
 assert.deepEqual(f.state.privateReads,[]);await session.close();await session.close();assert.equal(f.state.closed,1);
});

test('an existing public thread is resumed with its trusted chat and no duplicate thread callback',async t=>{
 const f=await fixture(t),thread='existing-native-thread';
 f.state.threads.set(thread,{cwd:f.root});
 const session=await f.adapter.start(f.context('private-existing',thread));
 assert.equal(await session.prepareVoice(f.input),thread);await Array.fromAsync(session.prompt(f.input));
 assert.equal(f.state.calls.filter(call=>call.method==='create').length,0);
 assert.equal(f.state.callbacks,undefined);
 assert.ok(f.state.calls.filter(call=>call.method==='resume').every(call=>call.params.whalenestChatId==='private-existing'));
 await session.close();
});

test('concurrent public Sessions carry their own chat and call metadata across iterator awaits',async t=>{
 const f=await fixture(t),a=await f.adapter.start(f.context('private-a')),b=await f.adapter.start(f.context('private-b'));
 await a.prepareVoice(f.input);await b.prepareVoice(f.input);
 await Promise.all([Array.fromAsync(a.prompt({...f.input,turnId:'voice-a',metadata:{whalenestSource:'realtime-call'}})),
  Array.fromAsync(b.prompt({...f.input,turnId:'chat-b'}))]);
 const voice=f.state.calls.find(call=>call.method==='prompt'&&call.params.inputId==='voice-a');
 const chat=f.state.calls.find(call=>call.method==='prompt'&&call.params.inputId==='chat-b');
 assert.notEqual(voice.params.sessionId,chat.params.sessionId);assert.equal(voice.params.whalenestSource,'realtime-call');
 assert.equal(chat.params.whalenestSource,undefined);assert.deepEqual(f.state.privateReads,[]);
 await a.close();await b.close();
});

test('an aborted voice turn never submits a native prompt',async t=>{
 const f=await fixture(t),session=await f.adapter.start(f.context()),controller=new AbortController();
 await session.prepareVoice(f.input);controller.abort();
 await assert.rejects(Array.fromAsync(session.prompt({...f.input,voiceSignal:controller.signal})),{name:'AbortError'});
 assert.equal(f.state.calls.filter(call=>call.method==='prompt').length,0);await session.close();
});

test('closing during public start releases the eventual Session and cannot submit after close',async t=>{
 const f=await fixture(t);f.state.startGate=Promise.withResolvers();
 const session=await f.adapter.start(f.context()),running=Array.fromAsync(session.prompt(f.input)).catch(error=>error);
 await f.state.startEntered.promise;
 const closed=session.close();f.state.startGate.resolve();await closed;await running;
 assert.equal(f.state.closed,1,'A Session returned after close must still be disposed exactly once');
 assert.equal(f.state.calls.filter(call=>call.method==='prompt').length,0,'No prompt may be submitted after Session close');
 await assert.rejects(session.prepareVoice(f.input),/closed/);
});

test('cancelling during public start blocks that prompt and the next explicit turn uses the same Session once',async t=>{
 const f=await fixture(t);f.state.startGate=Promise.withResolvers();
 const session=await f.adapter.start(f.context());let admissions=0;
 const cancelled=Array.fromAsync(session.prompt({...f.input,onAccepted:async()=>{admissions++;}})).catch(error=>error);
 await f.state.startEntered.promise;
 assert.equal(await session.cancel(),true);
 f.state.startGate.resolve();
 assert.equal((await cancelled).name,'AbortError');
 assert.equal(f.state.calls.filter(call=>call.method==='prompt').length,0);
 assert.equal(admissions,0);
 await Array.fromAsync(session.prompt({...f.input,turnId:'next-explicit-turn',onAccepted:async()=>{admissions++;}}));
 assert.deepEqual(f.state.calls.filter(call=>call.method==='prompt').map(call=>call.params.inputId),['next-explicit-turn']);
 assert.equal(f.state.starts.length,1);assert.equal(admissions,1);
 await session.close();assert.equal(f.state.closed,1);
});

test('closing during voice preparation cannot submit later RPCs or publish a late native identity',async t=>{
 for(const phase of ['bridge','create','resume']) {
  const f=await fixture(t),gate=Promise.withResolvers();
  f.state[phase+'Gate']=gate;
  const session=await f.adapter.start(f.context('private-a',phase==='resume'?'existing-thread':null));
  const preparing=session.prepareVoice(f.input).catch(error=>error);
  await f.state[phase+'Entered'].promise;
  await session.close();gate.resolve();
  assert.match((await preparing).message,/closed/);
  assert.equal(f.state.callbacks,undefined);
  assert.equal(f.state.calls.filter(call=>call.method==='create').length,phase==='create'?1:0);
  assert.equal(f.state.calls.filter(call=>call.method==='prompt').length,0);
  const requests=f.state.calls.length;
  await assert.rejects(session.voiceSpeech({text:'must not send'}),/closed/);
  assert.equal(f.state.calls.length,requests);
 }
});

test('cancelling an admitted turn retains its native terminal cancellation acknowledgement without replay',async t=>{
 const f=await fixture(t);f.state.activeGate=Promise.withResolvers();
 const session=await f.adapter.start(f.context());let admissions=0;
 const running=Array.fromAsync(session.prompt({...f.input,onAccepted:async()=>{admissions++;}}));
 await f.state.promptEntered.promise;
 assert.equal(await session.cancel(),true);
 const output=await running;
 assert.equal(output.at(-1)?.state,'cancelled');
 assert.equal(admissions,1);assert.equal(f.state.calls.filter(call=>call.method==='prompt').length,1);
 await session.close();
});

test('archive protocol errors retain the public lifecycle classifications with an independent Bridge client',async t=>{
 const f=await fixture(t);
 for(const [wireCode,publicCode]of [['conflict','conflict'],['session-not-owned','conflict'],['session-not-found','not-found']]){
  f.state.archiveCode=wireCode;
  await assert.rejects(f.adapter.archiveThread('archived-native'),error=>error.name==='RuntimeLifecycleError'&&error.code===publicCode);
 }
});
