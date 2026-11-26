import assert from 'node:assert/strict';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {createSpeechClient} from './speech.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {hash,routeKey,senderKey} from './routing.mjs';

export function voiceTools(options,route,sessionId,{speech=createSpeechClient(options),sender=createMediaSender(options,route,{sessionId})}={}){
 return [defineTool({name:'send_voice',description:'将一段简短回复用平台TTS生成语音并发送到当前主人私聊。仅在主人要求语音回复或朗读时使用，text为实际朗读内容（1–500字符）。confirmed且有messageId才算发出，语音本身就是回复，成功后结束本轮；仅主人同时要求文字时设textReply=true并补所需文字。结果不确定时用media_status查询，禁止新建请求重复生成。后台任务不可使用。',properties:{text:str('要朗读的内容，1–500字符'),textReply:{type:'boolean',description:'仅主人同时要求语音和文字时设为true，默认只发语音'}},required:['text'],
  render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
  execute:async(args,ctx)=>{
   requireManualOwnerTurn(ctx);
   assert.ok(typeof args.text==='string'&&args.text.trim()&&args.text.length<=500,'语音回复需为1–500字符');
   const requestId='whalenest-voice-'+hash([options.instanceId,routeKey(route),senderKey(route),sessionId,nativeOperationId(ctx)]);
   const audio=await speech.synthesize(args.text.trim(),requestId,{signal:ctx.signal});
   const result=await sender.send({filePath:audio.path,requestId,duration:audio.duration},{signal:ctx.signal});
   return {...result,model:audio.model,voice:audio.voice,duration:audio.duration,...(args.textReply===true?{textReply:true}:{})};
  }})];
}
