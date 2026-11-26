import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createStickerStore} from './aurabot-stickers.generated.mjs';
import {wantsVoice} from '../vendor/aurabot/src/chat/reply.js';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {createSpeechClient} from './speech.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {readState,writeState} from './state.mjs';
import {hash,routeKey,senderKey} from './routing.mjs';
import {requireManualOwnerTurn} from './native-tool.mjs';
import {humanMessageText} from './memory-adapter.mjs';
import {createExpressionSettings} from './expression-settings.mjs';
import {selectReplyItems} from './aurabot-expression.generated.mjs';
import {createStickers} from './stickers.mjs';
import {initializeDefaultStickers} from './default-stickers.mjs';

const messageOf=e=>e.data.message??e.data;
const textOf=m=>(m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
const confirmedVoice=value=>value?.state==='confirmed'&&typeof value.messageId==='string'&&!!value.messageId.trim();

function manualVoiceResult(events) {
  const calls=events.filter(e=>e.type==='assistant/message').flatMap(e=>(messageOf(e).content??[]).filter(b=>b.type==='tool-call'));
  if(!calls.length||calls.some(call=>call.name!=='send_voice'||typeof call.id!=='string'))return null;
  const results=new Map();
  for(const event of events)if(event.type==='tool/result') {
    const message=messageOf(event),id=message.toolCallId??message.source?.callId;
    try{results.set(id,JSON.parse(textOf(message)));}catch{ /* An invalid result cannot authorize hiding text. */ }
  }
  const voices=calls.map(call=>results.get(call.id));
  return voices.every(value=>confirmedVoice(value)&&value.textReply!==true)?voices.at(-1):null;
}

/** Reuses the original library and mood. Native completed turns authorize media;
 * the Runtime Adapter only replaces its displayed final text after confirmation. */
export async function createExpressions(ctx,options,{getConfig,mood,policy,settings:sharedSettings,stickers:sharedStickers,store:sharedStore,stickerSelection,random=Math.random,speech=createSpeechClient(options),senderFor=(route,id)=>createMediaSender(options,route,{sessionId:id})}) {
  const directory=join(options.dataDir,'expressions');
  const cfg=getConfig();
  const settingsStore=sharedSettings??createExpressionSettings(options,cfg),flights=new Map(),controllers=new Map(),cancelled=new Set();
  const configured=options.expressions?.enabled===true;
  const store=sharedStore??createStickerStore({dsh:ctx,getConfig,onebot:{call:()=>{throw Error('QQ actions are not connected');}},log:{debug(){},info(){},warn(){}}});
  const stickers=sharedStickers??createStickers(options,{getConfig,store,senderFor});
  const seedFile=join(directory,'seed.json');
  if(configured&&options.expressions?.stickerCatalog)await initializeDefaultStickers(options,store);
  else if(configured&&!existsSync(seedFile)) {
    if(!store.library().items.length) {
      const r=await store.addFromBuffer(readFileSync(new URL('../vendor/aurabot/assets/dafeiyu.jpg',import.meta.url)),
        {name:'大肥鱼开心',tags:['开心','卖萌','早晚安'],from:'manual',toQQ:false});
      assert.ok(r.ok,'Original starter sticker could not be imported');
    }
    writeState(seedFile,{source:'aurabot/assets/dafeiyu.jpg',initializedAt:new Date().toISOString()});
  }
  const status=()=>({configured,settings:settingsStore.read(),enabled:configured&&settingsStore.read().enabled,
    paused:policy.status().settings.paused,stickerCount:store.library().items.length,mood: mood.label(),effects:mood.effects(),
    voiceBilling:'foreground TTS; separate from background memory request limit'});
  function configure(patch) {
    settingsStore.configure(patch);return {ok:true,...status()};
  }
  function authorize(route) {
    assert.ok(route?.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'Owner private conversation required');
  }
  async function sendSticker(item,route,sessionId,requestId,signal) {
    assert.ok(item,'No matching sticker');
    const result=await stickers.sendCC(item,route,sessionId,requestId,signal);
    if(result.state==='confirmed')store.markUsed(item.md5);
    return result;
  }
  function tools(route,sessionId) {
    authorize(route);
    return [defineTool({name:'companion_expression',description:'主人管理心情驱动的自动语音与表情。action=status查看；action=update，patch可设enabled/voiceEnabled/stickersEnabled布尔开关、voiceChance/stickerChance基础概率0..1、voiceMaxChars自动朗读上限1..80。不开启后台活动或模型判心情。',
      render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
      properties:{action:str('status/update'),patch:{type:'object',properties:{enabled:{type:'boolean'},voiceEnabled:{type:'boolean'},stickersEnabled:{type:'boolean'},voiceChance:{type:'number'},stickerChance:{type:'number'},voiceMaxChars:{type:'integer'}},additionalProperties:false}},
      execute(args,exec){requireManualOwnerTurn(exec);assert.ok(['status','update'].includes(args.action??'status'),'Unknown expression action');return args.action==='update'?configure(args.patch??{}):{ok:true,...status()};}}),
    stickers.tool(route,sessionId)];
  }
  async function deliver(agent,inputId,{allowVoice=true,afterReply=false}={}) {
    const session=agent.session,events=[];
    for(let n=session.seq;n>=0;n--){const e=session.eventAt(n);if(!e)continue;events.unshift(e);if(e.type==='turn/start')break;}
    const end=events.findLast(e=>e.type==='turn/end');
    const user=events.findLast(e=>e.type==='user/message'&&['user','schedule'].includes(messageOf(e).source?.kind));
    const sessionId=String(session.id??agent.id);
    const scene=stickerSelection?.scene(sessionId,end?.data.turn);
    if(!afterReply)stickerSelection?.forget(sessionId);
    if(!end||end.data.reason.kind!=='completed'||!user||messageOf(user).source.kind!=='user')return {state:'skipped'};
    assert.equal(messageOf(user).source.connectInputId,inputId,'Expression request is for a different native input');
    const route=options.clawchat?.route;authorize(route);
    const manualVoice=manualVoiceResult(events);
    if(manualVoice) {
      if(ctx.sessions?.flush)assert.ok(await ctx.sessions.flush(session),'Voice source must be durable');
      return {state:'completed',voice:manualVoice,sticker:null,replacementText:''};
    }
    const final=events.findLast(e=>e.type==='assistant/message'&&!messageOf(e).content.some(b=>b.type==='tool-call'));
    const text=final?textOf(messageOf(final)):'';
    const manualMedia=events.some(e=>e.type==='assistant/message'&&messageOf(e).content.some(b=>{
      if(b.type!=='tool-call')return false;
      if(['send_voice','send_media','draw_image','companion_qq','companion_update'].includes(b.name))return true;
      if(!['companion_stickers','companion_paintings'].includes(b.name))return false;
      try{return (typeof b.arguments==='string'?JSON.parse(b.arguments):b.arguments)?.action==='send';}catch{return true;}
    }));
    const userText=humanMessageText(textOf(messageOf(user)));
    if(!configured||!settingsStore.read().enabled||policy.status().settings.paused||!text||text==='[SKIP]'||manualMedia)return {state:'skipped'};
    const key=hash([options.instanceId,senderKey(route),routeKey(route),String(agent.id),inputId,end.seq]);
    const file=join(directory,'receipts',key+'.json');
    let record=readState(file,null);
    if(record)assert.equal(record.textHash,hash(text),'Expression text changed');
    const completedResult=()=>{
      if(!record?.result)return {state:'skipped'};
      const result={...record.result};delete result.replacementText;
      if(confirmedVoice(record.voiceResult))result.replacementText='';
      if(JSON.stringify(result)!==JSON.stringify(record.result)){record.result=result;writeState(file,record);}
      return result;
    };
    if(afterReply&&(!record?.finished||!record.stickerScene||!record.stickerId||record.stickerResult))return completedResult();
    if(record?.finished&&!afterReply)return completedResult();
    const controller=new AbortController();controllers.set(String(agent.id),{inputId,controller});
    const deadline=setTimeout(()=>controller.abort(),45000);
    try{
      if(ctx.sessions?.flush)assert.ok(await ctx.sessions.flush(session),'Expression source must be durable');
      controller.signal.throwIfAborted();
      if(!record){
        const effects=mood.effects();
        const items=selectReplyItems([{kind:'text',value:text}],{cfg:settingsStore.project(getConfig()),mood:()=>effects,stickers:store,random,
          opts:{userText,wantVoice:wantsVoice(userText),allowVoice:!!(allowVoice&&options.speech?.enabled&&options.speech?.ttsModel)}});
        const voice=items.some(i=>i.kind==='voice');
        const hasImage=/!\[[^\]]*\]\(/.test(text);
        const pick=scene&&!hasImage&&stickerSelection.pick(route,scene,store);
        record={textHash:hash(text),voice:Boolean(voice),stickerId:pick?.md5??null,stickerScene:pick?scene:null,
          mood:mood.label(),effects,createdAt:new Date().toISOString()};
        writeState(file,record);
      }
      const sender=senderFor(route,String(agent.id));
      if(record.voice&&!record.voiceResult){
        try{const audio=await speech.synthesize(text,'whalenest-expression-voice-'+key,{signal:controller.signal});controller.signal.throwIfAborted();
          record.voiceResult=await sender.send({filePath:audio.path,duration:audio.duration,requestId:'whalenest-expression-voice-'+key},{signal:controller.signal});
        }catch{record.voiceResult={state:'unconfirmed',message:'自动语音未获确认，保留文字回复，不自动重试。'};}
        writeState(file,record);
      }
      const voiceConfirmed=confirmedVoice(record.voiceResult);
      if((afterReply||voiceConfirmed)&&record.stickerId&&!record.stickerResult){
        const item=store.library().items.find(i=>i.md5===record.stickerId);
        record.stickerResult={state:'unconfirmed'};
        writeState(file,record); // Reserve this input before touching the media channel.
        try {
          record.stickerResult=stickerSelection.usable(route,item,record.stickerScene)
            ?await sendSticker(item,route,String(agent.id),'whalenest-expression-sticker-'+key,controller.signal)
            :{state:'skipped'};
        } catch { record.stickerResult={state:'unconfirmed'}; }
      }
      record.finished=true;record.result={state:'completed',voice:record.voiceResult??null,sticker:record.stickerResult??null,
        ...(record.stickerId&&!afterReply&&!voiceConfirmed?{stickerPending:true}:{}),
        ...(voiceConfirmed?{replacementText:''}:{})};writeState(file,record);
      return record.result;
    }finally{clearTimeout(deadline);controllers.delete(String(agent.id));cancelled.delete(String(agent.id)+':'+inputId);}
  }
  return {status,tools,configure,store,
    toolsForQQ:()=>[tools(options.clawchat?.route??{...options.owners[0],kind:'private'})[0]],
    reply(agent,inputId,settings){assert.ok(typeof inputId==='string'&&inputId.trim()&&inputId.length<=256,'Native input identity required');const id=String(agent.id);const key=id+':'+inputId+(settings?.afterReply?':after-reply':'');
      if(cancelled.delete(key))return Promise.resolve({state:'cancelled'});if(flights.has(key))return flights.get(key);
      const promise=deliver(agent,inputId,settings).finally(()=>flights.delete(key));flights.set(key,promise);return promise;},
    cancel(id,inputId){if(inputId)cancelled.add(String(id)+':'+inputId);const current=controllers.get(String(id));if(current&&(!inputId||current.inputId===inputId))current.controller.abort();return {ok:true};},
    async dispose(){for(const {controller} of controllers.values())controller.abort();await Promise.allSettled([...flights.values()]);if(!sharedStore)store.dispose();},
  };
}
