import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {hash,routeKey,senderKey} from './routing.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {stickerTurn} from './sticker-material.mjs';
import {humanMessageText} from './memory-adapter.mjs';
import {createSongClient,recoverableSongJob} from './song-client.mjs';
import {songPlaybackUrl,songProjectUrl} from './song-playback.mjs';
import {isArchivedSong,songRequestMaterial} from './song-studio.mjs';
import {songMelodyFacts,analyzeSongMelody,revisionLyricPlan} from './song-melody.mjs';
import {verifySongScoreEdit} from './song-score.mjs';
import {songGuide} from './song-guidance.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {isDefiniteFailure} from '../vendor/aurabot/src/onebot/client.js';

const bareSongRequest = /^(?:(?:请|帮我|给我|我想|我要|能不能|可以)\s*){0,3}(?:写(?:一首|首)?歌|创作(?:一首|首)?歌曲|来(?:一首|首)歌)(?:吧|呀|吗)?[。！!？?]*$/;
const songRequestText = text => text.replace(/```[\s\S]*?```/g,'').replace(/\{[^\n]*\}/g,'')
 .replace(/^(?:【运维自测】|运维自测[：:，,])\s*/,'').trim()
 .replace(/^(?:write (?:a )?song|寫歌|作曲|노래 만들기|crear (?:una )?canción)[：:]\s*/i,'写歌：')
 .replace(/^(?:revise (?:the )?song|改歌|修改歌曲|曲を直す|노래 수정|modificar (?:la )?canción)[：:]\s*/i,'改歌：')
 .replace(/^(?:(?:please|can you|could you)\s+)?(?:write(?: me)? (?:a )?song|寫歌|作曲|노래 만들기|crear (?:una )?canción)[。.!！?？]*$/i,'写歌');
export const isBareSongRequest = text => bareSongRequest.test(songRequestText(text));
export function songBriefQuestion(text) {
 if(/노래/.test(text))return '어떤 주제의 노래를 만들까요?';
 if(/作曲|曲を/.test(text))return 'どんなテーマの曲にしたいですか？';
 if(/canción/i.test(text))return '¿Sobre qué te gustaría que fuera la canción?';
 if(/\bsong\b/i.test(text))return 'What would you like the song to be about?';
 return /寫/.test(text)?'你想寫什麼主題的歌？':'你想写什么主题的歌？';
}
const revisionRequest = text=>/重唱|再唱|改词|改编|重新作曲|refine|reroll|re-?sing|redo/i.test(text)
 || /(?:这|那|上|原|第|刚才).{0,6}(?:首|版|歌|旋律)|previous|this song/i.test(text)
 && /修改|改一下|改成|改为|改掉|换个|换成|调整|修正|修一下|再来一版|change|edit|fix/i.test(text);

function answersSongBrief(session, current, text){
 if(!text || /[？?]|取消|算了|不写|换个话题|先聊别的/.test(text))return false;
 let beforeCurrent=false,asked=false;
 for(let n=session.seq;n>=0&&n>session.seq-150;n--){
  const event=session.eventAt(n),message=event?.data?.message??event?.data;
  if(event?.type==='user/message'){
   if(!['user','aurabot','schedule'].includes(message.source?.kind))continue;
   if(!beforeCurrent){if(message===current||message.id===current.id)beforeCurrent=true;continue;}
   if(!asked||message.source.taskId||message.source.kind==='schedule')return false;
   const text=message.source.humanText??message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
   return isBareSongRequest(humanMessageText(text).replace(/^【私聊】[^：]*：/,''));
  }
  if(beforeCurrent&&event?.type==='assistant/message'){
   const answer=message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
   if(/(?:主题|主題|风格|想写|歌词|theme|style|what|テーマ|주제|qué).{0,65}[？?]/i.test(answer))asked=true;
  }
 }
 return false;
}

/** One replacement for Aurabot's song slot. QQ and ClawChat share this module,
 * its original completion hooks and one MusicHub archive; no RVC studio runs. */
export function createSongAdapter(options,{getConfig,getNative,getRoute,client=createSongClient(options),
 senderFor=(route,id)=>createMediaSender({...options,media:{...options.media,maxBytesEach:options.singing?.maxBytes??32*1024*1024}},route,{sessionId:id}),queueNotice=()=>{},now=Date.now}={}){
 let api,stopped=false,timer,creating=false;const workers=new Map(),controller=new AbortController();
 const view=r=>({ok:!['failed','uncertain','submitting'].includes(r.state),operationId:r.requestId,title:r.parameters.title,state:r.state,jobId:r.jobId??null,saved:!!r.artifact,
  projectId:r.projectId??r.requestId,version:r.version??1,page:songProjectUrl(options,r),
  ...(r.composition?.abc?{melody:{...songMelodyFacts(r.composition),...(r.composition.melodyMode==='graft'&&r.jobId?{attached:true}: {})}}: {}),
  ...(r.truncated?{warning:'平台报告歌曲可能因长度上限而截断，请先检查已有作品，不要自动重新生成。',truncated:true}: {}),
  delivery:r.delivery??null,...(r.artifact?{bytes:r.artifact.size}:{}),...(r.error&&!(r.state==='saved'&&r.delivery?.state==='confirmed')?{message:r.error}:{})});
 function actor(where,exec,override){
  nativeOperationId(exec);requireManualOwnerTurn(exec);const sessionId=String(where.sessionId??exec.agent.id),route=override??getRoute(sessionId,where.chat);
  assert.ok(route?.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'唱歌仅供已关联主人私聊');
  const turn=stickerTurn(exec,options,route,sessionId);assert.ok(!turn.message.source.taskId,'后台任务不能生成或发送歌曲');
  if(route.channel==='qq')assert.ok(getNative().hub.turnSendersAllOwner(sessionId),'需要原QQ主人回合');
  return {route,sessionId,turn};
 }
 function requested(call, session, args={}){
  const text=songRequestText(call.turn.text);
  assert.ok(!/(?:不要|不用|别|禁止|不需要).{0,20}(?:唱|写歌|生成|歌曲)|(?:只|仅)(?:需|要|写|作)?.{0,6}歌词/.test(text),'主人没有要求生成歌曲');
  assert.ok(!/^(?:先)?(?:不要|不用|别|禁止|不需要).{0,20}(?:改|修|重唱|再唱)|\b(?:do not|don't|never|no need to|not now|cancel)\b.{0,30}\b(?:sing|generate|create|compose|write|song|music)\b/i.test(text),'主人没有要求生成歌曲');
  assert.ok(!bareSongRequest.test(text),'先问主人想写什么主题或风格');
  const hasBrief = /(?:^|[\n。！？])\s*(?:我想|我要|帮我|请)?\s*(?:写歌|改歌)[：:，,\s]+[^：:，,。！？!?\s]/.test(text);
  assert.ok(hasBrief || /(?:请|给我|帮我|想听|现在).{0,32}(?:唱|写|生成|创作|做).{0,12}(?:歌|首)|(?:唱|写|生成|创作|做|制作)(?:一|首|个|段).{0,10}(?:歌|首)|把.{0,20}歌词.{0,12}唱|来一首|(?:sing|compose|write).{0,20}(?:song|music)/i.test(text)
   || args.sourceOperationId && revisionRequest(text) || answersSongBrief(session,call.turn.message,text),'仅主人明确请求唱歌或创作歌曲时生成');
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
  const url=r.state==='saved'?songPlaybackUrl(options,r):songProjectUrl(options,r);
  if(!url)return null;
  const fallback=r.state==='saved'?'点开这里，可以回听这首歌。':'点开这里，可以查看这首歌的制作进度。';
  queueNotice({id:'whalenest-song-page-'+hash([r.requestId,requestId]),route,text:fallback+'\n\n'+url,
    replyNotice:{kind:'song:playback',facts:'歌曲《'+r.parameters.title+'》当前状态为 '+r.state+'，下方附上私有页面。'+(r.truncated?'平台报告成品可能已截断，需提醒主人检查已有作品。':''),fallback,appendix:url}});
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
    if(recoverableSongJob(r)&&['queued','running','uncertain','submitting'].includes(r.state))r=await client.poll(id,{signal:controller.signal});
    if(r.state==='ready')r=await client.download(id,{signal:controller.signal});
    if(stopped)return r;
    if(r.state==='saved'&&!isArchivedSong(options.dataDir,r)){if(deliver&&!r.deliveryHeld)await send(r);if(r.delivery?.state==='confirmed')completed(r);else if(deliver&&!r.deliveryHeld)notice(r,'send-unconfirmed','歌曲《'+r.parameters.title+'》已保存，但发送尚未确认。保留原作品和发送记录，请查询已有歌曲，不用重新生成。');}
    if(r.state==='failed')notice(r,'generation-failed','歌曲《'+r.parameters.title+'》制作失败。原平台任务已保留，没有自动重新生成。');
   }catch(error){if(!stopped){r=client.inspect(id);r.error=error.message;r.pollingHeld=true;if(r.state==='saved')r.deliveryHeld=true;client.save(r);notice(r,'retrieval-interrupted','歌曲《'+r.parameters.title+'》暂未完成取回或投递，原任务已保留，可以查询或恢复已有结果。');}}
   return r;
  })();workers.set(id,task);try{return await task;}finally{workers.delete(id);}
 }
 async function tick(){
  if(stopped||workers.size)return;
  const next=client.list().reverse().find(r=>recoverableSongJob(r)&&!r.pollingHeld&&(['queued','running','ready'].includes(r.state)
   ||r.state==='saved'&&!r.delivery&&!r.deliveryHeld&&!isArchivedSong(options.dataDir,r)));
  if(!next)return;
  if(now()-Date.parse(next.createdAt)>20*60*1000&&next.state!=='saved'){next.pollingHeld=true;next.error='等待超时，原任务仍保留，请查询或恢复已有歌曲';client.save(next);notice(next,'long-wait','歌曲《'+next.parameters.title+'》等待较久，已保留原平台任务。可以查询或恢复已有结果，没有重新生成。');return;}
  await advance(next.requestId);
 }
 async function create(args,where,exec){
  const call=actor(where,exec);requested(call,exec.agent.session,args);
  const id=operation(call),old=client.inspect(id);
  assert.ok(old||!creating&&!client.list().some(r=>['submitting','queued','running','ready'].includes(r.state)),'上一首歌仍在制作，请先查询已有任务');
  const opts = {requestId:id,route:call.route,sessionId:call.sessionId,signal:exec.signal};
  let r;
  if(old)r=await client.create(args,{...opts,material:old.composition});
  else{
   creating=true;
   try{
    let text=songRequestText(call.turn.text);
    if(args.sourceOperationId!==undefined){
     assert.ok(revisionRequest(text),'只有主人明确要求修改或重唱已有歌曲时才引用原版本');
     assert.match(args.sourceOperationId,/^whalenest-song-[a-f0-9]{64}$/);
     if(text.includes('〔版本:'))assert.ok(text.includes('〔版本:'+args.sourceOperationId+':'),'原版本与主人草稿不一致');
     else {assert.ok(!text.includes('〔旋律:'),'不能用原版本覆盖主人指定的旋律');text+='\n〔版本:'+args.sourceOperationId+':'+(args.preserveMelody===false?'change':'keep')+'〕';}
    }
    const material=await songRequestMaterial(options.dataDir,client,text,{python:options.singing?.python,signal:exec.signal});
    if(args.scoreEdit){
     const edit=args.scoreEdit;
     const intents={tempo:/快|慢|节奏|速度|tempo|faster|slower|速い|遅い|テンポ|빠르|느리|속도|rápid|lento/i,
      arrangement:/编曲|伴奏|arrang|instrument|アレンジ|伴奏|편곡|반주|arreglo/i,
      phrase:/旋律|音|句|调|唱不上|tune|melody|phrase|note|メロディ|멜로디|melodía/i,
      structure:/段|长|短|结尾|intro|outro|bridge|section|long|short|構成|終わり|구성|길|estructura/i};
     assert.ok(intents[edit.mode]?.test(text),'只有主人明确要求对应的乐谱修改时才能改谱');
     assert.ok(typeof edit.abc==='string'&&Buffer.byteLength(edit.abc)<=128*1024,'需要完整且有界的修改后乐谱');
     const original=material.abc??(material.parentId&&await client.score(material.parentId));
     assert.ok(original,'修改乐谱需要引用本轮已有的旋律或作品');
     if(/旋律别动|不改旋律|保持原调|keep.{0,15}(?:tune|melody)/i.test(text))assert.ok(['tempo','arrangement'].includes(edit.mode),'主人要求旋律不变，不能修改音符或段落');
     material.scoreEdit=await verifySongScoreEdit(original,edit.abc,{...edit,python:options.singing?.python,signal:exec.signal});
     material.abc=edit.abc;material.melody=await analyzeSongMelody(edit.abc,{python:options.singing?.python,signal:exec.signal});
     if(edit.mode==='tempo')assert.equal(Number(/(\d{2,3})\s*bpm/i.exec(args.style)?.[1]),material.melody.bpm,'修改速度时英文曲风中的 BPM 必须与新谱一致');
    }
    r=await client.create(args,{...opts,material});
   }finally{creating=false;}
  }
  if(!r.selftest&&call.turn.text.includes('运维自测')){r.selftest=true;client.save(r);}
  return {...view(r),message:recoverableSongJob(r)?'平台已接受歌曲任务，完成后发回这里；不要重复生成或另发音频。':'创建结果未确认，已保留原请求，不重新付费生成。'};
 }
 async function exportFile(r,format,call){
  assert.ok(['lyrics','score'].includes(format),'仅支持歌词或乐谱文件');
  assert.ok(/歌词|乐谱|谱|下载|文件|lyrics|score|download|file/i.test(call.turn.text),'需要主人明确要求歌词或乐谱文件');
  currentRoute({...r,route:call.route});
  const requestId='song-file:'+hash([r.requestId,format,operation(call)]),previous=r.exports?.[requestId];
  if(previous?.state==='confirmed')return previous;
  if(previous?.state==='uncertain'){
   if(call.route.channel==='clawchat'){
    const sender=senderFor(call.route,call.sessionId);
    if(sender.check){r.exports[requestId]={...previous,...await sender.check(previous.requestId,{signal:controller.signal})};client.save(r);}
   }
   return r.exports[requestId];
  }
  const contents=format==='lyrics'?r.parameters.lyrics:await client.score(r.requestId);
  assert.ok(contents,'这份文件暂不可读取，原歌曲保留，不重新生成');
  const directory=join(options.dataDir,'media/outgoing/song-files');await mkdir(directory,{recursive:true});
  const path=join(directory,r.requestId+'-'+format+(format==='lyrics'?'.txt':'.abc'));
  await writeFile(path,contents,{mode:0o600});
  r=client.inspect(r.requestId);
  r.exports??={};r.exports[requestId]={state:'uncertain',requestId};client.save(r);
  let result;
  if(call.route.channel==='clawchat')result=await senderFor(call.route,call.sessionId).send({filePath:path,requestId},{signal:controller.signal});
  else {
   await getNative().onebot.call('upload_private_file',{user_id:Number(call.route.sender),file:'base64://'+Buffer.from(contents).toString('base64'),name:r.parameters.title+(format==='lyrics'?'.txt':'.abc')},{retries:0,timeoutMs:120000});
   result={state:'confirmed',requestId,kind:'file',acknowledgement:'qq-file-upload'};
  }
  r=client.inspect(r.requestId);r.exports??={};r.exports[requestId]=result;client.save(r);return result;
 }
 function manage(route,sessionId){return defineTool({name:'companion_songs',description:'主人共同歌曲。draft读取当前旋律/精修草稿的真实资料，创建前调用，不生成歌曲；inspect读取原作品歌词、曲风和旋律。list列已有作品；status查询；recover恢复原任务；send重发音频；open提供页面；file发送已有歌词或乐谱文件；tags按主人要求设置至多6个标签。未知结果先核对，所有管理动作都不新建歌曲。',
  properties:{action:str('draft/inspect/list/status/recover/send/open/file/tags'),operationId:str('歌曲operationId'),melodyId:str('查询已有哼唱/画线编号，仅供读取'),includeScore:{type:'boolean',description:'inspect时读取完整原谱，供核验或局部精修'},format:str('file时为lyrics或score'),tags:{type:'array',items:{type:'string'},maxItems:6}},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],
  async execute(args,exec){
   const call=actor({sessionId},exec,route),action=args.action??'list';
   if(action==='draft'){
    let text=songRequestText(call.turn.text);
    if(!/〔(?:旋律|版本):/.test(text)&&args.melodyId){assert.match(args.melodyId,/^(hum|draw)-[a-f0-9]{32}$/);text+='\n〔旋律:'+args.melodyId+':whole〕';}
    if(!/〔(?:旋律|版本):/.test(text)&&args.operationId){assert.match(args.operationId,/^whalenest-song-[a-f0-9]{64}$/);text+='\n〔版本:'+args.operationId+':keep〕';}
    const material=await songRequestMaterial(options.dataDir,client,text,{python:options.singing?.python,signal:exec.signal});
    const prior=material.parentId&&client.inspect(material.parentId);
    return {ok:true,readOnly:true,melody:material.abc?{...songMelodyFacts(material),attached:false}:undefined,score:material.abc??null,
     lyricPlan:material.lyricTemplate?revisionLyricPlan(material.lyricTemplate).sections:material.melody?.sections,
     ...(prior?{previous:{operationId:prior.requestId,title:prior.parameters.title,lyrics:prior.parameters.lyrics,style:prior.parameters.style,version:prior.version??1,score:material.abc??null}}: {}),
     instructions:material.abc&&material.melodyMode!=='graft'?'原谱已读取。按上述段落和乐句数写词，每乐句一行，不能额外扩写段落。sing_song会自动带上本轮引用。':'准备正常长度的歌词，sing_song会自动处理本轮原版本或旋律引用。',generated:false};
   }
   if(action==='list')return {ok:true,enabled:client.enabled,backend:'platform-songsmith',background:false,voiceOptions:['none','hope'],items:client.list().filter(r=>!isArchivedSong(options.dataDir,r)).slice(0,20).map(view)};
   let r=client.inspect(args.operationId);assert.ok(r&&!isArchivedSong(options.dataDir,r),'没有这项歌曲请求');
   if(action==='inspect')return {...view(r),lyrics:r.parameters.lyrics,style:r.parameters.style,tags:r.tags??null,...(args.includeScore?{score:await client.score(r.requestId)}: {})};
   if(action==='file'){assert.ok(r.artifact,'作品尚未保存');return exportFile(r,args.format,call);}
   if(action==='tags'){
    assert.ok(/标签|tags?/i.test(call.turn.text),'只有主人明确要求时才修改标签');
    assert.ok(Array.isArray(args.tags)&&args.tags.length<=6&&args.tags.every(s=>typeof s==='string'&&s.trim()&&[...s].length<=40),'标签最多6个，每个最多40字');
    r.tags=[...new Set(args.tags.map(s=>s.trim()))];client.save(r);return {ok:true,tags:r.tags};
   }
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
  api.rule?.(()=>client.enabled?[songGuide]:[]);
  api.tool(where=>client.enabled&&where.chat.kind==='private'&&where.chat.userId===getConfig().ownerQQ&&where.level==='full'?defineTool({
   name:'sing_song',description:'主人明确要求制作歌曲且给出主题或歌词时调用，一次一首，按实际用量计费。页面旋律/版本引用先用companion_songs draft读取，后台会自动带谱，无需上传文件。whole/keep按原谱每乐句一行填词；graft写正常整首。style用英文，歌词用主人要求的语言。受理回执含真实旋律采用状态和page进度链接，完成后系统保存并发回原会话，勿重复生成或补发。',
   properties:{title:str('歌名'),lyrics:str('实际歌词；whole/keep必须符合draft原谱段落及逐句音符数'),style:str('英文曲风，包含歌唱语言、情绪、演唱、乐器和节奏'),voicePreset:str('none或hope；默认none'),cfgScale:{type:'number',minimum:0,maximum:3,description:'演唱指令强度，默认平台值；修复吐字等问题时可用2'},sourceOperationId:str('主人明确要求修改或重唱的已有歌曲编号；页面引用优先'),preserveMelody:{type:'boolean',description:'聊天修改原作品时是否保留旋律，默认true；重新作曲才为false'},scoreEdit:{type:'object',additionalProperties:false,required:['mode','abc'],properties:{mode:{type:'string',enum:['tempo','arrangement','phrase','structure']},abc:str('复制原谱后修改的完整ABC；不覆盖原文件'),startBar:{type:'integer',minimum:1},endBar:{type:'integer',minimum:1}}}},required:['title','lyrics','style'],render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],execute:(args,exec)=>create(args,where,exec),
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
