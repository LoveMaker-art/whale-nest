import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {AsyncLocalStorage} from 'node:async_hooks';
import {voiceModelOverlay} from './voice-model.mjs';
import {visibleChatEvents} from './voice-history.mjs';

const limit=16*1024*1024;
const quiet=new Set(['model/selection','compaction/summary','compaction/prune']);
const capabilities=['promptQueue','promptSteer','cancel','durableReceipt','history','approvals','questions','models','presets','permissionPresets','skills','commands','imageInput','localProducedFilePresentation','portableArtifactOutput','archive','restore','delete','crossProcessSessionOwnership'];
function deadline(promise,ms,message) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}

/** Process and framing implementation for the official createBridge interface.
 * The official provider is consumed unchanged. */
export async function startRuntimeBridge(options) {
  const directory=await mkdtemp(join(tmpdir(),'whalenest-runtime-'));
  const overlay=join(directory,'bridge.patch.json');
  let child,client,closing=false,closed=false,failure,sequence=0,helloFrame;
  const pending=new Map(),events=new Set(),interactions=new Set(),failures=new Set();
  const failed=error=>{
    if(failure)return;
    failure=error;
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}
    pending.clear();
    for(const listener of [...failures])listener(error);
    failures.clear();
  };
  try {
    await writeFile(overlay,JSON.stringify([
      ...voiceModelOverlay({env:options.env}),{id:'sdk-jsonrpc-server',disabled:true},
      {insert:[{id:'clawchat-connect-bridge',name:options.bridgePath,config:{home:options.home,
        profile:options.profile??null,build:options.bridgeBuild,maxFrameBytes:limit}}]},
    ]),{mode:0o600});
    child=spawn(options.executable,[...(options.executableArguments??[]),
      ...(options.profile?['--profile',options.profile]:[]),'--patch',overlay],{
      cwd:options.cwd,env:{...process.env,...options.env,DSH_HOME:options.home,
        CONNECT_DSH_BRIDGE_FD_OUT:'3',CONNECT_DSH_BRIDGE_FD_IN:'4'},
      stdio:['pipe','ignore','pipe','pipe','pipe'],windowsHide:true,
    });
    let resolveHello,rejectHello;
    const hello=new Promise((resolve,reject)=>{resolveHello=resolve;rejectHello=reject;});
    const exit=new Promise(resolve=>child.once('close',(code,signal)=>{
      closed=true;
      const error=Error(`Whale DSH bridge exited (${signal??code??'unknown'})`);
      rejectHello(error);
      if(!closing)failed(error);
      resolve();
    }));
    const abort=error=>{rejectHello(error);failed(error);child.kill('SIGTERM');};
    child.once('error',cause=>abort(Error('Whale DSH bridge process failed to start',{cause})));
    for(const stream of [child.stdin,child.stdio[3],child.stdio[4]])
      stream.on('error',cause=>{if(!closing)abort(Error('Whale DSH bridge pipe failed',{cause}));});
    // Avoid exposing credentials or user content through platform errors.
    child.stderr.on('data',()=>{});
    const decoder=new StringDecoder('utf8');let buffered='';
    child.stdio[3].on('data',chunk=>{
      buffered+=decoder.write(chunk);
      let boundary;
      while((boundary=buffered.indexOf('\n'))>=0) {
        const line=buffered.slice(0,boundary);buffered=buffered.slice(boundary+1);
        if(Buffer.byteLength(line)>limit){abort(Error('Whale DSH bridge frame exceeds limit'));return;}
        let frame;
        try {
          frame=JSON.parse(line);
          assert.ok(frame&&typeof frame==='object'&&!Array.isArray(frame));
          if(!helloFrame) {
            assert.equal(frame.type,'hello');assert.equal(frame.protocol?.name,'clawchat-connect-dsh-bridge');
            assert.equal(frame.protocol.major,2);assert.equal(typeof frame.protocol.build,'string');
            assert.equal(frame.home,options.home);assert.equal(frame.profile,options.profile??null);
            assert.ok(frame.protocol.maxFrameBytes===undefined||(Number.isSafeInteger(frame.protocol.maxFrameBytes)&&frame.protocol.maxFrameBytes>0));
            assert.ok(capabilities.every(key=>typeof frame.capabilities?.[key]==='boolean'));
            helloFrame=frame;resolveHello(frame);continue;
          }
          assert.notEqual(frame.type,'hello');
          if(frame.type==='response') {
            assert.equal(typeof frame.id,'string');assert.equal(typeof frame.ok,'boolean');
            if(!frame.ok)assert.ok(typeof frame.error?.code==='string'&&typeof frame.error?.message==='string');
            const request=pending.get(frame.id);if(!request)continue;
            pending.delete(frame.id);clearTimeout(request.timer);
            if(frame.ok)request.resolve(frame.result);
            else request.reject(Object.assign(Error(frame.error.message),{name:'DshBridgeRemoteError',code:frame.error.code}));
          } else if(frame.type==='event') {
            assert.equal(typeof frame.sessionId,'string');assert.ok(Number.isSafeInteger(frame.event?.seq)&&Number.isFinite(frame.event?.time)&&typeof frame.event?.type==='string'&&Object.hasOwn(frame.event,'data'));
            for(const listener of [...events])listener(frame);
          } else {
            assert.equal(frame.type,'interaction');assert.equal(typeof frame.id,'string');assert.equal(typeof frame.sessionId,'string');
            assert.ok(['approval','user-input'].includes(frame.request?.kind));
            for(const listener of [...interactions])listener(frame);
          }
        } catch(cause) {abort(Error('Whale DSH bridge emitted an invalid frame',{cause}));return;}
      }
      if(Buffer.byteLength(buffered)>limit)abort(Error('Whale DSH bridge frame exceeds limit'));
    });
    await deadline(hello,options.startTimeoutMs??30000,'Whale DSH bridge handshake timed out');
    const subscribe=(set,listener)=>{set.add(listener);return()=>set.delete(listener);};
    client={
      hello:helloFrame,
      request(method,params={},timeoutMs=options.requestTimeoutMs??30000) {
        if(failure)return Promise.reject(failure);
        if(closing&&method!=='shutdown')return Promise.reject(Error('Whale DSH bridge is closing'));
        const id='whalenest-'+ ++sequence,encoded=JSON.stringify({type:'request',id,method,params})+'\n';
        if(Buffer.byteLength(encoded)>Math.min(limit,helloFrame.protocol.maxFrameBytes??limit))return Promise.reject(Error('Whale DSH bridge request exceeds limit'));
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('Whale DSH bridge request timed out: '+method),{name:'BridgeTimeoutError'}));},timeoutMs);
          pending.set(id,{resolve,reject,timer});
          child.stdio[4].write(encoded,error=>{
            if(!error)return;
            const request=pending.get(id);if(!request)return;
            pending.delete(id);clearTimeout(timer);reject(Error('Whale DSH bridge request write failed',{cause:error}));
          });
        });
      },
      onEvent:listener=>subscribe(events,listener),
      onInteraction:listener=>subscribe(interactions,listener),
      onFailure(listener){if(failure){listener(failure);return()=>{};}return subscribe(failures,listener);},
      async close() {
        if(closing){await exit;return;}
        closing=true;
        try {
          if(!closed&&!failure)await client.request('shutdown',{},options.stopTimeoutMs??5000).catch(()=>{});
          child.stdio[4].end();child.stdin.end();
          if(!closed)await deadline(exit,options.stopTimeoutMs??5000,'Whale DSH bridge did not stop').catch(async()=>{
            child.kill('SIGTERM');
            if(!closed)await deadline(exit,options.stopTimeoutMs??5000,'Whale DSH bridge did not terminate').catch(()=>child.kill('SIGKILL'));
          });
          if(!closed)await exit;
        } finally {failed(Error('Whale DSH bridge closed'));await rm(directory,{recursive:true,force:true});}
      },
    };
    return client;
  } catch(error) {
    closing=true;
    if(child&&!closed){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
    await rm(directory,{recursive:true,force:true});throw error;
  }
}

/** Request scopes carry the trusted public Runtime context across async work. */
export function scopedRuntimeBridge(client) {
  const scope=new AsyncLocalStorage();
  return {
    hello:client.hello,
    async request(method,params={},timeoutMs) {
      const current=scope.getStore();let input=params;
      if(['create','resume','selectModel','prompt','command'].includes(method))current?.assertActive?.();
      if(['create','resume'].includes(method)&&current?.chatId)input={...input,whalenestChatId:current.chatId};
      if(method==='prompt'&&current?.input){
        current.input.voiceSignal?.throwIfAborted();
        if(current.input.metadata?.whalenestSource==='realtime-call')input={...input,whalenestSource:'realtime-call'};
      }
      const response=await client.request(method,input,timeoutMs);
      if(method==='history'&&Array.isArray(response?.events))return {...response,
        events:(current?.projection?visibleChatEvents(response.events):response.events).filter(event=>!quiet.has(event.type))};
      return response;
    },
    run:(context,operation)=>scope.run(context,operation),
    onEvent:listener=>client.onEvent(frame=>{if(!quiet.has(frame.event.type))listener(frame);}),
    onInteraction:listener=>client.onInteraction(listener),
    onFailure:listener=>client.onFailure?.(listener),
    close:()=>client.close(),
  };
}
