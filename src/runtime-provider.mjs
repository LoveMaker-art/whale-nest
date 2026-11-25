import assert from 'node:assert/strict';
import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startRuntimeBridge,scopedRuntimeBridge} from './runtime-bridge-client.mjs';

/** Consume the official factory and Runtime Adapter as public interfaces.
 * The thread/RPC state below is ours; no private official Session fields are
 * read, patched, or assumed. */
export function createWhaleRuntimeEntry(officialFactory,options={}) {
  return {activate(context){
    const runtime=context.hostCapabilities.get('runtime-provider');
    runtime.register({capabilityId:'deepseek-harness',family:'deepseek-harness',create(configuration,instance){
      let official,bridge;
      const entry=officialFactory({...options,runtimeAdapter:{...options.runtimeAdapter,
        createBridge:async configuration=>{
          const client=await (options.runtimeAdapter?.createBridge??startRuntimeBridge)(configuration);
          return bridge=scopedRuntimeBridge(client);
        },
      }});
      entry.activate({...context,hostCapabilities:{get(id){
        if(id==='runtime-provider')return {register(provider){official=provider.create(configuration,instance);}};
        if(id==='managed-web-app-provider')return {interfaceVersion:'1',register(){}};
        return context.hostCapabilities.get(id);
      }}});
      assert.ok(official,'Official runtime factory did not register its public provider');
      return new Proxy(official,{get(target,key){
        if(key==='start')return async start=>{
          let thread=start.runtimeThreadId,session,creating,closingSession,closed=false,generation=0,pendingOperations=0;
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
              try {
                const active=await ensure();assertActive(version);
                // Once native admission is confirmed, preserve the official
                // cancellation acknowledgement and terminal activity stream.
                let admitted=false;
                const forwarded={...input,onAccepted:async()=>{admitted=true;await input.onAccepted?.();}};
                const context=scope(forwarded,version,()=>admitted);
                const iterator=active.prompt(forwarded);
                try {
                  while(true){
                    context.assertActive();
                    const item=await bridge.run(context,()=>iterator.next());
                    if(item.done)return item.value;
                    yield item.value;
                  }
                } finally {if(iterator.return)await bridge.run(context,()=>iterator.return());}
              } finally {pendingOperations--;}
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
              const pending=pendingOperations>0;generation++;
              return Boolean(await session?.cancel?.())||pending;
            },
            async close(){if(closed)return;closed=true;generation++;await creating?.catch(()=>{});await closeNative();},
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
      }});
    }});
  }};
}
