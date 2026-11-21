import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { prepareRuntimeInput, mediaLimits } from './media.mjs';
import { createSpeechClient } from './speech.mjs';
import {qqManagementFallback} from './qq-management-message.mjs';
import {withRequiredCommands} from './reply-notice.mjs';
import { startPlatformVoiceLiveware } from './platform-voice-liveware.mjs';
import { startSongPlayback } from './song-playback.mjs';
import { fastVoiceModel } from './voice-model.mjs';

function adaptImages(input, models) {
  if (!input.media?.length) return input;
  const model = input.model ? models.find(m => m.selection?.provider === input.model.provider && m.selection?.model === input.model.model)
    : models.find(m => m.isDefault) ?? (models.length === 1 ? models[0] : undefined);
  const capability = model?.turnSubmissionCapability?.attachments;
  const matches = (mime, pattern) => pattern === '*/*' || mime === pattern || pattern.endsWith('/*') && mime?.startsWith(pattern.slice(0, -1));
  const compatible = model?.inputModalities?.includes('image') && capability?.allowedKinds?.includes('image')
    && (capability.maxCount === undefined || input.media.length <= capability.maxCount)
    && input.media.every(m => capability.allowedMediaTypes.some(pattern => matches(m.mime, pattern))
      && (capability.maxBytesEach === undefined || m.size <= capability.maxBytesEach))
    && (capability.maxBytesTotal === undefined || input.media.reduce((n, m) => n + m.size, 0) <= capability.maxBytesTotal);
  return compatible ? input : { ...input, media: [], prompt: input.prompt + '\n\n当前模型的图片输入能力或格式、大小限制不满足本次附件；图片已接收并保存，但不能判断画面内容。请明确告知用户，不要编造图片内容。' };
}

/** Wrap only the public Runtime Adapter interface. Core continues to own the
 * same transport, account connection, input acknowledgement and session lifecycle.
 */
export function extendRuntimeEntry(base) {
  return {
    async activate(context) {
      const providers = context.hostCapabilities;
      const runtime = providers.get('runtime-provider');
      return await base.activate({ ...context, hostCapabilities: {
        get(id) {
          // The reviewed baseline also offers DSH Web. This plugin exposes only runtime adaptation.
          if (id === 'managed-web-app-provider') return { interfaceVersion: '1', register() {} };
          if (id !== 'runtime-provider') return providers.get(id);
          return { ...runtime, register(provider) {
            runtime.register({ ...provider, create(configuration, instance) {
              const adapter = provider.create(configuration, instance);
              const readOptions = () => {
                const home = configuration.homePath || process.env.DSH_HOME || join(homedir(), '.dsh');
                return JSON.parse(readFileSync(join(home, 'companion/aurabot-v1/instance.json'), 'utf8'));
              };
              let callServer, songServer=Promise.resolve(null), closing=false;
              function startCallGateway() {
                if(callServer||closing)return;
                const options=readOptions();
                if(!options.realtime?.enabled||!options.clawchat?.route)return;
                callServer=startPlatformVoiceLiveware(options,{
                  withPrivateVoiceSession:instance?.withPrivateVoiceSession,listModels:()=>adapter.listModels?.()??[],
                }).catch(error=>{console.error('[whalenest-call] platform gateway unavailable: '+error.message);return null;});
              }
              try {
                const options=readOptions();
                startCallGateway();
                if(options.singing?.playback?.enabled) songServer=startSongPlayback(options).catch(error=>{
                  console.error('[whalenest-song] Liveware playback unavailable: '+error.message);
                  return null;
                });
              } catch {}
              return new Proxy(adapter, { get(target, key) {
                if(key==='close')return async()=>{
                  closing=true;
                  try { await Promise.allSettled([callServer,songServer].map(async server=>(await server)?.close())); }
                  finally { await target.close?.(); }
                };
                if(key==='prepare'&&typeof target.prepare==='function')return async()=>{
                  const result=await target.prepare();
                  // First binding is resolved inside the DSH bridge.
                  startCallGateway();
                  return result;
                };
                if (key === 'listModels' && typeof target.listModels === 'function') return async (...args) => {
                  const models = await target.listModels(...args), limits = mediaLimits(readOptions());
                  return models.filter(model=>model.selection?.provider!==fastVoiceModel.provider).map(model => ({ ...model, turnSubmissionCapability: {
                    prompt: { ...model.turnSubmissionCapability?.prompt, allowed: true, required: false },
                    attachments: { allowedKinds: ['image','audio','file','video'], allowedMediaTypes: ['*/*'], ...limits },
                  } }));
                };
                if (key === 'start') return async startContext => {
                  const session = await target.start(startContext);
                  let expressing=false,cancelled=false,activeInputId,pendingSticker;
                  return {
                    prepareVoice: session.prepareVoice,
                    voiceMode: session.voiceMode,
                    voicePlayback: session.voicePlayback,
                    async afterClawChatReply(inputId) {
                      if(!pendingSticker||pendingSticker!==inputId||cancelled)return;
                      pendingSticker=undefined;
                      expressing=true;
                      try { await session.expressReply({inputId,afterReply:true}); }
                      finally { expressing=false; }
                    },
                    async *prompt(input) {
                      cancelled=false;pendingSticker=undefined;
                      activeInputId=input.turnId;
                      const options = readOptions();
                      assert.equal(startContext.bindingId, options.clawchat.route.account, '未经验证的账号来源');
                      assert.equal(startContext.chatId, options.clawchat.route.conversation, '未经验证的会话来源');
                      const prepared = await prepareRuntimeInput(input, startContext, options, createSpeechClient(options));
                      if(prepared.metadata?.whalenestSource==='realtime-call'){
                        yield* session.prompt(prepared);
                        return;
                      }
                      let models = [];
                      if (prepared.media?.length) {
                        try { models = await target.listModels?.() ?? []; } catch { /* Unverified vision stays disabled. */ }
                      }
                      const enabled=options.expressions?.enabled===true&&Boolean(input.turnId)&&!input.command;
                      const held=new Map();let streamed=false,qqManaged=false,qqResult,qqResultSeq,lastItem=-1;
                      for await(const activity of session.prompt(adaptImages(prepared, models))) {
                        if(activity.kind==='user'){qqManaged=false;qqResult=undefined;qqResultSeq=undefined;lastItem=-1;}
                        const [turn,item]=String(activity.position).split('.').map(Number);
                        if(Number.isInteger(item))lastItem=Math.max(lastItem,item);
                        if(activity.kind==='tool'&&activity.data?.name==='companion_qq') {
                          qqManaged=true;held.clear();
                          if(activity.data.nativeType==='tool/result') {
                            try{qqResult=JSON.parse(activity.text);qqResultSeq=activity.data.nativeSeq;}catch{qqResult=undefined;}
                            // Replay the displayed text of already completed, older turns.
                            if(activity.source!=='live'&&!qqResult?.action&&typeof qqResult?.userMessage!=='string')qqManaged=false;
                          }
                        }
                        if(activity.kind==='assistant'&&qqManaged) {
                          const finalSeq=activity.data?.nativeSeq;
                          const currentAnswer=!Number.isInteger(qqResultSeq)||!Number.isInteger(finalSeq)||finalSeq>qqResultSeq;
                          if(activity.data?.outputKind==='final'&&(!qqResult?.action||activity.text?.trim()&&currentAnswer)) {
                            held.clear();
                            const previousText = activity.source!=='live' && !qqResult?.action
                              ? qqResult?.userMessage : undefined;
                            yield {...activity,text:previousText??withRequiredCommands(activity.text??'',qqResult?.verificationText,qqResult?.confirmationRequired),data:{...activity.data,qqManagement:true}};
                            qqManaged=false;qqResult=undefined;
                          }
                          continue;
                        }
                        if(activity.kind==='turn'&&activity.data?.nativeType==='turn/end') {
                          if(qqManaged&&qqResult?.action&&!cancelled&&activity.state!=='cancelled'&&Number.isInteger(turn)) {
                            const text=withRequiredCommands(qqManagementFallback(qqResult),qqResult.verificationText,qqResult.confirmationRequired);
                            yield {...activity,id:activity.id+':qq-result',position:turn+'.'+(lastItem+1),kind:'assistant',text,state:'complete',
                              data:{...activity.data,outputKind:'final',qqManagement:true,qqFallback:true}};
                          }
                          qqManaged=false;qqResult=undefined;
                        }
                        if(!enabled||activity.kind!=='assistant'||activity.source!=='live'){yield activity;continue;}
                        if(activity.data?.outputKind!=='final') {
                          if(streamed){yield activity;continue;}
                          held.set(activity.id,activity);
                          if(activity.text.length>(options.expressions?.voiceMaxChars??80)) {
                            for(const item of held.values())yield item;held.clear();streamed=true;
                          }
                          continue;
                        }
                        let expression;
                        if(!cancelled&&session.expressReply) {
                          expressing=true;
                          try{expression=await session.expressReply({inputId:input.turnId,allowVoice:!streamed});}catch{ /* Media failure retains the native text. */ }
                          finally{expressing=false;}
                        }
                        if(expression?.stickerPending)pendingSticker=input.turnId;
                        for(const [id,item]of held)if(id!==activity.id)yield item;
                        held.clear();
                        yield {...activity,text:expression?.replacementText??activity.text,
                          data:{...activity.data,...(expression?.voice?{expression:{voice:expression.voice}}:{})}};
                      }
                      for(const item of held.values())yield item;
                    },
                    close: async () => {cancelled=true;if(expressing)await session.cancelExpression?.({inputId:activeInputId});return session.close();},
                    ...(session.cancel ? { cancel: async () => {cancelled=true;if(expressing){await session.cancelExpression?.({inputId:activeInputId});return true;}return session.cancel();} } : {}),
                  };
                };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              } });
            } });
          } };
        },
      } });
    },
  };
}
