import {installAurabotBridge} from './connect-bridge.mjs';
import {createDshBridgeWire} from './dsh-bridge-wire.mjs';
import {createDshBridgeInteractions} from './dsh-bridge-interactions.mjs';
import {createDshBridgeSessions} from './dsh-bridge-sessions.mjs';
import {bridgeProtocol,requiredPositiveInteger,requiredString,optionalString} from './dsh-bridge-contract.mjs';

const inject=['agents','agentLoop','sessions','sessionPersistence','llm','tools','systemPrompt','permissionPresets',
 'agentDefaultModel','attachments','fileUploads','fs','remoteAccess','sessionProjections','sessionQuery',
 'typert','typertGateway','workspaceRegistry','timer'];

/** Our DSH plugin owns conversation mounting and the protocol. The four fixed
 * compatibility helpers are passed by the packaging entry, not patched into an
 * official plugin. Native handles, business state and FD resources each have
 * one owner and a single disposal path.
 */
export function createWhaleDshBridgeEntry({encodeBridgeFrame,pageHistoryEvents,registerClawChatApprovalPolicy,
 registerQuestionProviderWhenProfileReady,resolveConfigPath},businessAdapters={}){
 return {name:'whalenest-dsh-business-bridge',inject,
  async apply(ctx,config={}){
   const maxFrameBytes=requiredPositiveInteger(config.maxFrameBytes,'Bridge maxFrameBytes');
   const wire=createDshBridgeWire({maxFrameBytes,encodeBridgeFrame});
   let business,disposed=false,markInstalled;
   const installed=new Promise(resolve=>{markInstalled=resolve;});
   const native=createDshBridgeSessions(ctx,{companion:()=>business,pageHistoryEvents});
   const interactions=createDshBridgeInteractions(ctx,{wire,handles:native.handles,
    registerClawChatApprovalPolicy,registerQuestionProviderWhenProfileReady});
   const hello=interactions.ready.then(async questions=>{
    await installed;if(disposed)return;
    native.captureServices();
    await wire.send({type:'hello',protocol:{...bridgeProtocol,build:requiredString(config.build,'Bridge build'),maxFrameBytes},
     home:requiredString(config.home,'DSH Home'),profile:optionalString(config.profile)??null,
     capabilities:native.capabilities(questions)});
   });
   hello.catch(error=>{if(!disposed)wire.terminate('hello failed: '+(error?.message??error));});
   const offEvents=ctx.on('session/event',(session,event)=>{
    const id=String(session.id),handle=native.handles.get(id);if(!handle)return;
    interactions.observe(handle.agent,event);
    wire.send({type:'event',sessionId:id,event}).catch(error=>wire.terminate('event write failed: '+(error?.message??error)));
   });
   const methods={...native.methods,
    companionExpression:params=>business.express(params),cancelCompanionExpression:params=>business.cancelExpression(params),
    companionVoiceMode:params=>business.voiceMode(params),companionVoiceSpeech:params=>business.voiceSpeech(params),
    cancelCompanionVoiceSpeech:params=>business.cancelVoiceSpeech(params),companionVoicePlayback:params=>business.voicePlayback(params),
    companionStatus:params=>business.inspect(params.sessionId),interactionResponse:params=>interactions.respond(params),
    async shutdown(){
     await business.dispose();interactions.cancelAll('DSH Bridge is shutting down');await native.closeAll();
     return {disposed:true};
    },
   };
   async function dispose(){
    if(disposed)return;disposed=true;markInstalled();
    await business?.dispose();offEvents();await interactions.dispose();await hello.catch(()=>{});
    interactions.cancelAll('DSH Bridge disposed');wire.stopReading();await native.closeAll();await wire.dispose();
   }
   try{
    business=await installAurabotBridge(ctx,{...businessAdapters,handles:native.handles,ready:hello,
     configPath:config.aurabotConfigPath??resolveConfigPath(config),
     activate:sessionId=>wire.enqueue(()=>methods.resume({sessionId})),
    });
    wire.start(methods,(method,params)=>business.record(method,params));
    ctx.provide('sdkSessionActivation',{ready:true});markInstalled();
    return dispose;
   }catch(error){
    await wire.send({type:'startupError',code:error?.code==='FIRST_BINDING_PENDING'
      ?'FIRST_BINDING_PENDING':'BUSINESS_INITIALIZATION_FAILED'}).catch(()=>{});
    await dispose();throw error;
   }
  },
 };
}
