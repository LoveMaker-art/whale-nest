import assert from 'node:assert/strict';
import {realpath} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {runtimeSerial} from './runtime-serial.mjs';
import {independentCall} from './independent-call.mjs';
import {randomUUID} from 'node:crypto';
import {startRuntimeBridge,scopedRuntimeBridge} from './runtime-bridge-client.mjs';

/** Consume the official factory and Runtime Adapter as public interfaces.
 * The thread/RPC state below is ours; no private official Session fields are
 * read, patched, or assumed. */
export function createWhaleRuntimeEntry(officialFactory,options={}) {
  return {activate(context){
    const runtime=context.hostCapabilities.get('runtime-provider');
    runtime.register({capabilityId:'deepseek-harness',family:'deepseek-harness',create(configuration,instance){
      let official,bridge,call;const serial=runtimeSerial();
      const entry=officialFactory({...options,runtimeAdapter:{...options.runtimeAdapter,
        createBridge:async configuration=>{
          // Older own packages did not pin the business bridge explicitly.
          // Its location belongs to our registry, independent of where the
          // unchanged official factory is loaded from during source testing.
          const file=join(configuration.home,'companion/aurabot-v1/installation.json');
          let bridgePath=options.runtimeAdapter?.bridgePath;
          if(!bridgePath&&existsSync(file)){
            const own=JSON.parse(readFileSync(file,'utf8'));
            assert.equal(own.pluginId,'whalenest.runtime.deepseek-harness');
            assert.ok(isAbsolute(own.entryPath??''));
            bridgePath=join(dirname(own.entryPath),'deepseek-harness-bridge.mjs');
          }
          const client=await (options.runtimeAdapter?.createBridge??startRuntimeBridge)({...configuration,...(bridgePath?{bridgePath}:{})});
          return bridge=scopedRuntimeBridge(client);
        },
      }});
      entry.activate({...context,hostCapabilities:{get(id){
        if(id==='runtime-provider')return {register(provider){official=provider.create(configuration,instance);}};
        if(id==='managed-web-app-provider')return {interfaceVersion:'1',register(){}};
        return context.hostCapabilities.get(id);
      }}});
      assert.ok(official,'Official runtime factory did not register its public provider');
      const adapter=new Proxy(official,{get(target,key){
        if(key==='withCallSession')return async(request,signal,run)=>{
          await target.prepare?.();const home=configuration.homePath||process.env.DSH_HOME||join(homedir(),'.dsh');
          const instance=JSON.parse(readFileSync(join(home,'companion/aurabot-v1/instance.json'),'utf8'));
          call??=independentCall(adapter,instance,serial);return call.run(request,signal,run);
        };
        if(key==='close')return async()=>{await call?.close();return target.close?.();};
        if(key==='start')return async start=>{
          let thread=start.runtimeThreadId,session,creating,closingSession,closed=false,generation=0,pendingOperations=0,operation,running=false;
          const assertActive=(version,admitted=false)=>{
            assert.ok(!closed,'Runtime session is closed');
            if(version!==generation&&!admitted)throw Object.assign(Error('Runtime operation was cancelled'),{name:'AbortError'});
          };
          const closeNative=()=>closingSession??=(session?Promise.resolve(session.close()):Promise.resolve());
          const nativeContext={...start,onRuntimeThreadId:async id=>{
            assert.ok(!closed,'Runtime session is closed');
            thread=id;await start.onRuntimeThreadId(id);
          }};
          const scope=(input,version,admitted=()=>false)=>({chatId:start.chatId,input,assertActive:()=>assertActive(version,admitted())});
          const prepare=async input=>{
            const version=generation;assertActive(version);pendingOperations++;
            try {
              await target.prepare?.();assertActive(version);
              assert.ok(typeof input.workspace?.workingDirectory==='string','Native Session needs a workspace');
              const cwd=await realpath(input.workspace.workingDirectory);
              const selection=input.model?{provider:input.model.provider,model:input.model.model,
                ...(input.reasoningEffort?{reasoningEffort:input.reasoningEffort}:{})}:undefined;
              return await bridge.run(scope(input,version),async()=>{
                const result=await bridge.request(thread?'resume':'create',thread?{sessionId:thread}:{
                  sessionId:'clawchat-'+randomUUID(),cwd,...(selection?{model:selection}:{}),
                  ...(input.sessionOptions?.agentPreset?{agentPreset:input.sessionOptions.agentPreset}:{}),
                  ...(input.sessionOptions?.permissionPreset?{permissionPreset:input.sessionOptions.permissionPreset}:{}),
                });
                assertActive(version);
                assert.equal(result.header.cwd,cwd,'Native Session workspace changed');
                if(!thread){thread=result.sessionId;await start.onRuntimeThreadId(thread);assertActive(version);}
                assert.equal(result.sessionId,thread,'Native Session identity changed');return thread;
              });
            } finally {pendingOperations--;}
          };
          const ensure=async()=>{
            assert.ok(!closed,'Runtime session is closed');
            if(session)return session;
            creating??=Promise.resolve(target.start({...nativeContext,runtimeThreadId:thread})).then(async value=>{
              session=value;
              if(closed){await closeNative();throw Error('Runtime session is closed');}
              return value;
            });
            return creating;
          };
          const rpc=async(method,params={},timeout)=>{
            assert.ok(!closed,'Runtime session is closed');
            assert.ok(thread,'Prepare the native Session before its RPC');
            return bridge.request(method,{sessionId:thread,...params},timeout);
          };
          return {
            async *prompt(input){
              const version=generation;assertActive(version);pendingOperations++;
              const controller=new AbortController();operation=controller;
              const signal=input.voiceSignal?AbortSignal.any([input.voiceSignal,controller.signal]):controller.signal;
              let lease;
              try {
                lease=await serial.acquire(signal);
                signal.throwIfAborted();await lease.run(()=>prepare(input));
                const active=await lease.run(ensure);assertActive(version);running=true;
                // Once native admission is confirmed, preserve the official
                // cancellation acknowledgement and terminal activity stream.
                let admitted=false;
                const forwarded={...input,onAccepted:async()=>{admitted=true;await input.onAccepted?.();}};
                const context=scope(forwarded,version,()=>admitted);
                const iterator=lease.run(()=>active.prompt(forwarded));
                try {
                  while(true){
                    context.assertActive();
                    const item=await lease.run(()=>bridge.run(context,()=>iterator.next()));
                    if(item.done)return item.value;
                    yield item.value;
                  }
                } finally {if(iterator.return)await lease.run(()=>bridge.run(context,()=>iterator.return()));}
              } finally {running=false;if(operation===controller)operation=undefined;pendingOperations--;lease?.release();}
            },
            prepareVoice:prepare,
            voiceMode:enabled=>rpc('companionVoiceMode',{enabled}),
            voicePlayback:playback=>rpc('companionVoicePlayback',{playback}),
            voiceSpeech:params=>rpc('companionVoiceSpeech',params,60000),
            cancelVoiceSpeech:()=>rpc('cancelCompanionVoiceSpeech'),
            expressReply:params=>rpc('companionExpression',params,60000),
            cancelExpression:params=>rpc('cancelCompanionExpression',params),
            async cancel(){
              if(closed)return false;
              const pending=pendingOperations>0;generation++;operation?.abort();
              return (running?Boolean(await session?.cancel?.()):false)||pending;
            },
            async close(){if(closed)return;closed=true;generation++;operation?.abort();if(running)await session?.cancel?.();await creating?.catch(()=>{});await closeNative();},
          };
        };
        if(key==='readActivity')return async thread=>{
          await target.prepare?.();
          return bridge.run({projection:true},()=>target.readActivity(thread));
        };
        if(key==='archiveThread')return async thread=>{
          try{return await target.archiveThread(thread);}
          catch(cause){
            const code=['conflict','session-not-owned'].includes(cause.code)?'conflict':cause.code==='session-not-found'?'not-found':undefined;
            if(!code)throw cause;
            throw Object.assign(Error(cause.message,{cause}),{name:'RuntimeLifecycleError',code});
          }
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});return adapter;
    }});
  }};
}
