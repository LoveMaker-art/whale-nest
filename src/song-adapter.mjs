import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {hash,routeKey,senderKey} from './routing.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {stickerTurn} from './sticker-material.mjs';
import {createSongClient} from './song-client.mjs';
import {songPlaybackUrl} from './song-playback.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {isDefiniteFailure} from '../vendor/aurabot/src/onebot/client.js';

/** One replacement for Aurabot's song slot. QQ and ClawChat share this module,
 * its original completion hooks and one MusicHub archive; no RVC studio runs. */
export function createSongAdapter(options,{getConfig,getNative,getRoute,client=createSongClient(options),
 senderFor=(route,id)=>createMediaSender({...options,media:{...options.media,maxBytesEach:options.singing?.maxBytes??32*1024*1024}},route,{sessionId:id}),queueNotice=()=>{},now=Date.now}={}){
 let api,stopped=false,timer,creating=false;const workers=new Map(),controller=new AbortController();
 const view=r=>({ok:!['failed','uncertain','submitting'].includes(r.state),operationId:r.requestId,title:r.parameters.title,state:r.state,jobId:r.jobId??null,saved:!!r.artifact,
  delivery:r.delivery??null,...(r.artifact?{bytes:r.artifact.size}:{}),...(r.error&&!(r.state==='saved'&&r.delivery?.state==='confirmed')?{message:r.error}:{})});
 function actor(where,exec,override){
  nativeOperationId(exec);requireManualOwnerTurn(exec);const sessionId=String(where.sessionId??exec.agent.id),route=override??getRoute(sessionId,where.chat);
  assert.ok(route?.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'唱歌仅供已关联主人私聊');
  const turn=stickerTurn(exec,options,route,sessionId);assert.ok(!turn.message.source.taskId,'后台任务不能生成或发送歌曲');
  if(route.channel==='qq')assert.ok(getNative().hub.turnSendersAllOwner(sessionId),'需要原QQ主人回合');
  return {route,sessionId,turn};
 }
 function requested(call){
  const text=call.turn.text.replace(/```[\s\S]*?```/g,'').replace(/\{[^\n]*\}/g,'');
  assert.ok(!/(?:不要|不用|别|禁止|不需要).{0,20}(?:唱|写歌|生成|歌曲)/.test(text),'主人没有要求生成歌曲');
  assert.ok(/(?:请|给我|帮我|想听|现在).{0,32}(?:唱|写|生成|创作|做).{0,12}(?:歌|首)|(?:唱|写|生成|创作|做|制作)(?:一|首|个|段).{0,10}(?:歌|首)|把.{0,20}歌词.{0,12}唱|来一首|(?:sing|compose|write).{0,20}(?:song|music)/i.test(text),'仅主人明确请求唱歌或创作歌曲时生成');
 }
 const operation=call=>'whalenest-song-'+hash([options.instanceId,routeKey(call.route),call.sessionId,String(call.turn.message.id??call.turn.message.source.connectInputId)]);
 function notice(r,phase,text){return queueNotice({id:'whalenest-song-notice-'+hash([r.requestId,r.state]),route:r.route,sessionId:r.sessionId,text,replyNotice:{kind:'song:'+phase,fallback:text}});}
 function currentRoute(r){
  assert.ok(options.owners.some(o=>senderKey(o)===senderKey(r.route))&&r.route.kind==='private','原歌曲目标已不再关联');
  if(r.route.channel==='clawchat')assert.equal(routeKey(r.route),routeKey(options.clawchat?.route),'原ClawChat会话不符');
  else assert.ok(options.qq?.enabled&&getConfig().enabled&&!getConfig().dryRun&&getNative().onebot.state==='connected','QQ未连接，保留歌曲等待原会话');
 }
 function announcePlayback(r,route,requestId){
  if(route.channel!=='clawchat')return null;
  currentRoute({...r,route});
  const url=songPlaybackUrl(options,r);
  if(!url)return null;
  const fallback='点开这里，可以回听这首歌。';
  queueNotice({id:'whalenest-song-page-'+hash([r.requestId,requestId]),route,text:fallback+'\n\n'+url,
    replyNotice:{kind:'song:playback',facts:'现有歌曲《'+r.parameters.title+'》已有私有播放页，下方附上入口。',fallback,appendix:url}});
  return url;
 }
 async function send(r,{route=r.route,sessionId=r.sessionId,requestId='song-result:'+r.requestId}={}){
  if(r.delivery?.state==='uncertain'){
   const target=r.delivery.route??r.route,sid=r.delivery.sessionId??r.sessionId;
   if(target.channel==='clawchat'){const sender=senderFor(target,sid);if(sender.check)r.delivery={...r.delivery,...await sender.check(r.delivery.requestId,{signal:controller.signal})};client.save(r);
    if(r.delivery.state==='confirmed')announcePlayback(r,target,r.delivery.operationRequestId??r.delivery.requestId);}
   return r.delivery;
  }
  if(r.delivery?.state==='confirmed'&&r.delivery.operationRequestId===requestId)return r.delivery;
  const target={...r,route};currentRoute(target);assert.ok(r.artifact,'歌曲尚未保存');
  const bytes=await readFile(r.artifact.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),r.artifact.sha256,'已保存歌曲发生变化');
  if(route.channel==='clawchat'){
   // The existing uploader may classify FLAC as audio or a downloadable file.
   // Keep its actual fragment type; never fabricate a voice-message receipt.
   r.delivery=await senderFor(route,sessionId).send({filePath:r.artifact.path,requestId,
    ...(r.artifact.mime==='audio/flac'?{allowFileFallback:true}:r.durationMs?{duration:r.durationMs}:{})},{signal:controller.signal});
  }else{
   r.delivery={state:'uncertain',requestId,route:structuredClone(route)};client.save(r);
   try{
    const result=await getNative().hub.sendSegments('private:'+route.sender,[{type:'record',data:{file:'base64://'+bytes.toString('base64')}}],'[歌曲] '+r.parameters.title,{throwOnError:true,retries:0,timeoutMs:120000});
    assert.ok(result?.message_id||result?.messageId,'QQ未返回歌曲发送回执');r.delivery={state:'confirmed',requestId,kind:'audio',messageId:String(result.message_id??result.messageId)};
   }catch(error){
    if(isDefiniteFailure(error)){
     try{await getNative().onebot.call('upload_private_file',{user_id:Number(route.sender),file:'base64://'+bytes.toString('base64'),name:r.parameters.title+'.'+({'audio/flac':'flac','audio/wav':'wav','audio/mpeg':'mp3'}[r.artifact.mime])},{retries:0,timeoutMs:120000});
      r.delivery={state:'confirmed',requestId,kind:'file',acknowledgement:'qq-file-upload'};
     }catch{r.delivery.error='QQ文件投递未确认，保留歌曲及原回执';}
    }else r.delivery.error='QQ歌曲投递未确认，保留原回执，不自动重发';
   }
  }
  r.delivery={...r.delivery,route:structuredClone(route),sessionId,operationRequestId:requestId};client.save(r);
  if(r.delivery.state==='confirmed')announcePlayback(r,route,requestId);
  return r.delivery;
 }
 function completed(r){
  if(r.noted)return;r.noted=true;client.save(r);
  if(r.selftest)return;
  api?.lazy('mood').nudge?.(8,'唱完了「'+r.parameters.title+'」');
  api?.lazy('memory').addEvent?.({text:'给主人唱了《'+r.parameters.title+'》',about:getConfig().ownerQQ,tags:['唱歌'],importance:0.5});
  api?.emit('song/sung',{title:r.parameters.title,chatId:'private:'+getConfig().ownerQQ});
 }
 async function advance(id,{deliver=true}={}){
  if(stopped)return;if(workers.has(id))return workers.get(id);
  const task=(async()=>{
   let r=client.inspect(id);if(!r)return;
   try{
    if(r.jobId&&['queued','running','uncertain','submitting'].includes(r.state))r=await client.poll(id,{signal:controller.signal});
    if(r.state==='ready')r=await client.download(id,{signal:controller.signal});
    if(stopped)return r;
    if(r.state==='saved'){if(deliver&&!r.deliveryHeld)await send(r);if(r.delivery?.state==='confirmed')completed(r);else if(deliver&&!r.deliveryHeld)notice(r,'send-unconfirmed','歌曲《'+r.parameters.title+'》已保存，但发送尚未确认。保留原作品和发送记录，请查询已有歌曲，不用重新生成。');}
    if(r.state==='failed')notice(r,'generation-failed','歌曲《'+r.parameters.title+'》制作失败。原平台任务已保留，没有自动重新生成。');
   }catch(error){if(!stopped){r=client.inspect(id);r.error=error.message;r.pollingHeld=true;if(r.state==='saved')r.deliveryHeld=true;client.save(r);notice(r,'retrieval-interrupted','歌曲《'+r.parameters.title+'》暂未完成取回或投递，原任务已保留，可以查询或恢复已有结果。');}}
   return r;
  })();workers.set(id,task);try{return await task;}finally{workers.delete(id);}
 }
 async function tick(){
  if(stopped||workers.size)return;
  const next=client.list().reverse().find(r=>r.jobId&&!r.pollingHeld&&(['queued','running','ready'].includes(r.state)||r.state==='saved'&&!r.delivery&&!r.deliveryHeld));
  if(!next)return;
  if(now()-Date.parse(next.createdAt)>20*60*1000&&next.state!=='saved'){next.pollingHeld=true;next.error='等待超时，原任务仍保留，请查询或恢复已有歌曲';client.save(next);notice(next,'long-wait','歌曲《'+next.parameters.title+'》等待较久，已保留原平台任务。可以查询或恢复已有结果，没有重新生成。');return;}
  await advance(next.requestId);
 }
 async function create(args,where,exec){
  const call=actor(where,exec);requested(call);
  const id=operation(call),old=client.inspect(id);
  assert.ok(old||!creating&&!client.list().some(r=>['submitting','queued','running','ready'].includes(r.state)),'上一首歌仍在制作，请先查询已有任务');
  let r;if(old)r=await client.create(args,{requestId:id,route:call.route,sessionId:call.sessionId,signal:exec.signal});
  else{creating=true;try{r=await client.create(args,{requestId:id,route:call.route,sessionId:call.sessionId,signal:exec.signal});}finally{creating=false;}}
  if(!r.selftest&&call.turn.text.includes('运维自测')){r.selftest=true;client.save(r);}
  return {...view(r),message:r.jobId?'平台已接受歌曲任务，完成后发回这里；不要重复生成或另发音频。':'创建结果未确认，已保留原请求，不重新付费生成。'};
 }
 function manage(route,sessionId){return defineTool({name:'companion_songs',description:'主人共同歌曲：list列已有作品；status按operationId查询；recover取回已有平台作品；send重发已有歌曲；open在当前ClawChat私聊提供已保存作品的播放与看谱入口。未知投递先核对，不新建歌曲补发。',
  properties:{action:str('list/status/recover/send/open'),operationId:str('歌曲operationId')},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],
  async execute(args,exec){
   const call=actor({sessionId},exec,route),action=args.action??'list';
   if(action==='list')return {ok:true,enabled:client.enabled,backend:'platform-songsmith',background:false,voiceOptions:['none','hope'],items:client.list().slice(0,20).map(view)};
   let r=client.inspect(args.operationId);assert.ok(r,'没有这项歌曲请求');
   if(action==='recover'){if(workers.has(r.requestId))await workers.get(r.requestId);r=client.inspect(r.requestId);r.deliveryHeld=true;r.pollingHeld=false;client.save(r);r=await advance(r.requestId,{deliver:false});return view(r);}
   if(action==='status')return view(r);
   if(action==='open'){
    const url=announcePlayback(r,call.route,operation(call));
    return url?{ok:true,title:r.parameters.title,queued:true,message:'已安排在当前私聊发送作品入口，请勿重复发送链接或歌曲。'}
      :{ok:false,message:'这首歌的 ClawChat 播放页暂不可用，可在支持的私聊中播放已发送的音频。'};
   }
   assert.equal(action,'send','未知歌曲操作');assert.ok(/发|发送|重发|send/i.test(call.turn.text)&&!/(不要|别|不用).{0,10}发/.test(call.turn.text),'仅主人明确要求才重发歌曲');
   if(operation(call)===r.requestId&&r.delivery?.state==='confirmed')return {...r.delivery,alreadyDelivered:true};
   const requestId='song-resend:'+hash([r.requestId,operation(call)]),delivery=await send(r,{route:call.route,sessionId:call.sessionId,requestId});
   if(delivery?.state==='confirmed')completed(r);return delivery;
  }});}
 function module(){return {id:'song',name:'平台唱歌',version:'1.0.0',description:'使用平台生成歌曲，两端共用作品，不运行RVC',setup(context){
  api=context;
  api.rule?.(()=>client.enabled?['- 主人明确要求唱歌时用sing_song；这是平台新生成的歌曲，不保证原曲翻唱或与说话同音色。完成后系统保存并回原会话，不要重复生成或补发；已有歌曲用companion_songs查询或显式重发。']:[]);
  api.tool(where=>client.enabled&&where.chat.kind==='private'&&where.chat.userId===getConfig().ownerQQ&&where.level==='full'?defineTool({
   name:'sing_song',description:'仅主人当前明确要求唱歌或创作歌曲时使用。准备title、lyrics实际歌词、style曲风后调用平台生歌，一次一首，按实际用量计费。voicePreset省略或none随曲风生成，hope为平台固定男声。会后台制作、保存并发回本会话；不能保证原曲翻唱或TTS同音色。返回任务后只说明制作中，不调用send_media补发，不重试创建；用companion_songs查状态。',
   properties:{title:str('歌名'),lyrics:str('完整歌词，不是生成指令'),style:str('曲风、情绪及演唱风格'),voicePreset:str('none或hope；默认none')},required:['title','lyrics','style'],render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],execute:(args,exec)=>create(args,where,exec),
  }):[]);
  for(const r of client.list())if(r.state==='submitting'){r.state='uncertain';r.error='创建响应未保存，保留原请求待核对';client.save(r);}
  if(client.enabled){timer=setInterval(()=>tick().catch(error=>api.log.warn('歌曲恢复：'+error.message)),Math.max(3000,options.singing?.pollMs??5000));timer.unref();}
  api.onDispose?.(close);
  return {status:()=>({enabled:client.enabled,ready:false,platformReady:client.enabled,voices:[],mode:'platform-songsmith'}),
   request:()=>({ok:false,message:'当前使用平台歌曲生成，请在聊天中描述想唱的歌曲主题或提供歌词；不按歌名下载原曲翻唱。'})};
 }};}
 async function close(){if(stopped)return;stopped=true;clearInterval(timer);controller.abort();await Promise.allSettled([...workers.values()]);}
 return {module,managementTool:manage,client,advance,tick,close,create,status:()=>({enabled:client.enabled,backend:'platform-songsmith',background:false,voiceOptions:['none','hope'],songs:client.list().length})};
}
