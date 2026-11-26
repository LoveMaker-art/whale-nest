import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import originalVoice from './aurabot-voice.generated.mjs';
import {selectReplyItems} from './aurabot-expression.generated.mjs';
import {createSpeechClient} from './speech.mjs';
import {createVoiceSelection} from './voice-selection.mjs';
import {readState,writeState} from './state.mjs';
import {hash} from './routing.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {fetchImage} from '../vendor/aurabot/src/core/net.js';
import {parseWav} from '../vendor/aurabot/src/voice/wav.js';

/** Original voice/Hub own the behavior; this port supplies platform I/O and
 * durable identities. It never starts a local model or a second voice engine. */
export function createVoiceAdapter(ctx,options,{getConfig,setConfig,getNative,expressionSettings,policy,fetchImpl=fetch}={}){
 const delivery=new AsyncLocalStorage(),toolCalls=new AsyncLocalStorage(),flights=new Map(),dir=join(options.dataDir,'voice');
 const enabled=options.speech?.enabled===true;
 const speech=createSpeechClient(options,fetchImpl,{getVoice:()=>selection.current()});
 const selection=createVoiceSelection(options,{getConfig,setConfig,speech}),status=selection.status;
 async function speak(text,request){
  assert.ok(request?.requestId,'语音合成需要持久调用标识');
  // Both channels enter the original voice module. Read its shared mood,
  // without a second score, model call or change to the chosen speaker.
  const mood=getConfig().mood?.enabled?getNative()?.modules.use('mood'):null;
  const emotion={'超开心':'excited','心情不错':'excited','有点低落':'sad','不太开心':'sad'}[mood?.label()];
  const artifact=await speech.synthesize(text,request.requestId,{...request,emotion});
  return {...artifact,file:artifact.path,engine:'platform'};
 }
 const current=(chatId)=>{const value=delivery.getStore();assert.ok(value&&value.chatId===chatId&&value.operationId,'QQ语音需要当前持久回合标识');return value;};
 function key(chatId,text){const d=current(chatId);return 'whalenest-qq-voice-'+hash([options.instanceId,d.operationId,chatId,d.index,text]);}
 const ports={enabled,
  async runDelivery(chatId,opts,run){
   let operationId=opts.operationId??toolCalls.getStore();
   if(!operationId){
    const native=getNative(),sessionId=native?.hub.sessions()?.[chatId]?.sessionId;
    const agent=ctx.agents?.list().find(a=>String(a.id)===String(sessionId));
    if(agent){for(let n=agent.session.seq;n>=0;n--){const e=agent.session.eventAt(n),m=e?.data?.message;if(e?.type==='assistant/message'&&m?.content?.some(b=>b.type==='tool-call')){operationId=String(m.id)+':delivery';break;}if(e?.type==='turn/start')break;}}
   }
   return delivery.run({chatId,operationId,index:0},run);
  },
  request(chatId,text){return {requestId:key(chatId,text)};},
  select(items,args){
   const d=delivery.getStore(),cfg=expressionSettings.project(args.cfg,{paused:policy.status().settings.paused});
   const select=()=>selectReplyItems(items,{...args,cfg});
   if(!d?.operationId)return select();
   const file=join(dir,'choices',hash([options.instanceId,d.chatId,d.operationId])+'.json'),fingerprint=hash(items);
   const old=readState(file,null);if(old){assert.equal(old.fingerprint,fingerprint,'QQ表达回合内容冲突');return old.items;}
   const selected=select();writeState(file,{fingerprint,items:selected});return selected;
  },
  async send(chatId,text,send){
   const id=key(chatId,text),file=join(dir,'qq-outgoing',hash(id)+'.json'),old=readState(file,null);
   if(old){assert.equal(old.state,'confirmed','QQ语音发送结果不确定，禁止重复发送');current(chatId).index++;return {message_id:old.messageId,replayed:true};}
   writeState(file,{state:'uncertain',requestId:id});
   const result=await send();assert.ok(result?.message_id||result?.messageId,'QQ网关未返回实际语音消息回执');
   writeState(file,{state:'confirmed',requestId:id,messageId:String(result.message_id??result.messageId)});current(chatId).index++;return result;
  },
  async transcribe(msg,onebot){
   if(!msg.records?.length)return '';
   assert.ok(msg.messageId!==undefined&&msg.chatId,'QQ语音缺少消息标识');
   const id='whalenest-qq-asr-'+hash([options.instanceId,getConfig().botQQ,msg.chatId,String(msg.messageId)]),file=join(dir,'qq-incoming',hash(id)+'.json');
   const fingerprint=hash(msg.records);
   const run=async()=>{
    const old=readState(file,null);if(old){assert.equal(old.fingerprint,fingerprint,'QQ语音消息标识冲突');assert.equal(old.state,'confirmed','QQ识别结果不确定，禁止重复识别');return old.text;}
    writeState(file,{state:'uncertain',fingerprint});
    const info=await onebot.call('get_record',{file:msg.records[0].data?.file,out_format:'wav'},{timeoutMs:30000,retries:0});
    const max=options.media?.maxBytesEach??16*1024*1024;
    if(info?.base64)assert.ok(info.base64.length<=Math.ceil(max/3)*4,'QQ音频超过限制');
    const bytes=info?.base64?Buffer.from(info.base64,'base64'):await fetchImage(info?.file||info?.url,{maxBytes:max});
    assert.ok(bytes.length>0&&bytes.length<=max,'QQ音频大小无效');parseWav(bytes);
    const folder=join(dir,'qq-incoming');await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,hash(id)+'.wav');await writeFile(path,bytes,{mode:0o600});
    const text=await speech.transcribe(path,'audio/wav',id);writeState(file,{state:'confirmed',fingerprint,text});return text;
   };
   if(flights.has(id))return flights.get(id);const promise=run();flights.set(id,promise);try{return await promise;}finally{flights.delete(id);}
  },
 };
 function tool(){return defineTool({name:'companion_voice',description:'主人通过私聊管理语音消息和实时通话共用音色。status查看当前音色；list查询昵称、声音特点和当前选择。面向用户使用目录返回的昵称（如小鲸娘1、大鲸娘1、默认鲸鱼娘）和声音特点，不展示后台原名或ID，也不要求用户提供ID。update的voice填所选昵称，“默认”恢复鲸鱼娘；后台兼容原名及完整ID。用户可说“查看可选音色”“换成小鲸娘4”。切换先实际合成一句短语验证，成功才保存，失败保留原音色；仅影响后续语音和下次通话，歌曲演唱预设独立。自动文字/语音偏好用companion_expression。',properties:{action:str('status/list/update'),voice:str('音色昵称，如小鲸娘1、大鲸娘1或默认')},
  render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}],
  async execute(args,exec){requireManualOwnerTurn(exec);const action=args.action??'status';assert.ok(['status','list','update'].includes(action),'Unknown voice action');
   if(action!=='update')return {ok:true,...status()};
   return selection.change(args.voice,{requestId:'whalenest-voice-check-'+hash([options.instanceId,nativeOperationId(exec)]),signal:exec.signal});
  }});}
 return {ports,speech,status,tool,speak,
  wrapTools(def){return {...def,setup(api){return def.setup({...api,tool(factory){return api.tool(where=>factory(where).map(t=>({...t,execute:(args,exec)=>toolCalls.run(nativeOperationId(exec),()=>t.execute(args,exec))})));}});}};},
  module(){return {...originalVoice,setup(api){return originalVoice.setup({...api,voicePorts:{enabled,speak}});}};}};
}
