import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {readState} from './state.mjs';
import {hash,routeKey,senderKey} from './routing.mjs';
import {createOfficialDelivery,officialDeliveryPaths} from './official-delivery.mjs';
import {prepareOutgoingFormat} from './media-format.mjs';
import {defineTool,str,int} from '../vendor/aurabot/src/tools/tools.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),flights=new Map();
const contains=(root,path)=>{const rel=relative(root,path);return rel&&!rel.startsWith('..')&&!isAbsolute(rel);};
const legacyView=r=>({ok:r.state==='confirmed',state:['confirmed','failed'].includes(r.state)?r.state:'uncertain',requestId:r.requestId,
 kind:r.deliveredKind??r.artifact.kind,name:r.artifact.name,...(r.messageId?{messageId:r.messageId}:{}),
 message:r.state==='confirmed'?'附件已发送，平台消息确认：'+r.messageId:'原发送结果待确认，保留原记录，不自动重发。'});

/** Official tools own upload, authentication and transport. Status reads only
 * our journals, never a platform database, and never creates a send. */
export function createMediaSender(options,route,{sessionId,run}={}){
 assert.equal(routeKey(route),routeKey(options.clawchat?.route),'Unverified media route');
 assert.equal(senderKey(route),senderKey(options.clawchat.route),'Unverified media sender');
 assert.ok(typeof sessionId==='string'&&sessionId,'Media session identity required');
 assert.ok(options.clawchat.delivery.mediaEnabled,'Media delivery is not enabled');
 const delivery=createOfficialDelivery(options,route,{run});
 const scope=hash([options.instanceId,routeKey(route),senderKey(route),sessionId]);
 const idFor=inputId=>'whalenest-media-'+hash([scope,inputId]);
 const old=id=>{
  const record=readState(join(options.dataDir,'media/outgoing/receipts',id+'.json'),null);
  if(record)assert.equal(record.scope,scope,'Legacy media scope conflict');return record;
 };
 function view(record){
  assert.equal(record.sourceScope,scope,'Media receipt belongs to another session');
  const known=record.tool==='clawchat_send_image'?'image':record.tool==='clawchat_send_voice'?'audio':record.input.as_document===true?'file':null;
  return {ok:record.state==='confirmed',...delivery.check(record.id),name:record.artifact.name,
   kind:known??'unknown',kindVerified:!!known,artifactKind:record.artifact.kind,
   message:record.state==='confirmed'?'附件已发送，平台消息确认：'+record.messageId:
    record.state==='failed'?'附件未发送：'+record.error:'发送结果待确认；查询只检查本地回执，不自动重发。'};
 }
 async function snapshot(input,signal){
  const source=input.filePath;assert.ok(isAbsolute(source),'附件必须使用绝对路径');
  assert.ok(!(await lstat(source)).isSymbolicLink(),'附件不能是符号链接');
  const path=await realpath(source),workspace=await realpath(options.cwd);
  const data=await realpath(options.dataDir);
  const roots=[workspace,...await Promise.all(['media','aurabot/stickers','aurabot/bili-shots','aurabot/imagegen'].map(async name=>{
   const expected=join(data,name);try{const actual=await realpath(expected);return actual===expected?actual:null;}catch{return null;}
  }))];
  assert.ok(roots.some(root=>root&&contains(root,path)),'只允许发送工作区或受控附件目录中的文件');
  const pieces=path.toLowerCase().split('/'),leaf=basename(path).toLowerCase();
  assert.ok(!pieces.some(part=>['.ssh','.aws','.gnupg','.kube','.docker','.clawchat-connect','.clawchat-dsh','.deepseek','.bitterbot'].includes(part))
   &&!pieces.some((part,index)=>part==='.config'&&pieces[index+1]==='gh')
   &&!['.git-credentials','.netrc','.npmrc','.pypirc'].includes(leaf)&&!/^\.env(?:\.|$)|^id_|\.(?:key|pem)$/.test(leaf),
  '凭据文件不允许复制为附件');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes,stat;
  const maxBytes=options.media?.maxBytesEach??16*1024*1024;
  try{
   stat=await handle.stat();assert.ok(stat.isFile()&&stat.size>0&&stat.size<=maxBytes,'附件为空、不是普通文件或超过限制');
   bytes=await handle.readFile();const after=await handle.stat();
   assert.ok(bytes.length===stat.size&&after.size===stat.size&&after.mtimeMs===stat.mtimeMs,'附件读取期间发生变化');
  }finally{await handle.close();}
  signal?.throwIfAborted();
  const name=basename(path).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160);assert.ok(name&&name!=='.'&&name!=='..','附件名称无效');
  const formatted=await prepareOutgoingFormat(bytes,{name,maxBytes,allowFileFallback:input.allowFileFallback,
   ffmpeg:options.media?.ffmpeg??'ffmpeg',signal});
  const direct=!formatted.converted&&(stat.mode&0o222)===0&&contains(workspace,path)
   &&!contains(officialDeliveryPaths(options).temporary,path);
  return {bytes:formatted.bytes,artifact:{path,name:formatted.name,mime:formatted.mime,kind:formatted.kind,size:formatted.bytes.length,
   sha256:sha(formatted.bytes),direct,...(formatted.duration?{duration:formatted.duration}:{})}};
 }
 return {
  async send(input,{signal}={}){
   assert.ok(typeof input.requestId==='string'&&input.requestId&&input.requestId.length<=256,'Stable media request ID required');
   const id=idFor(input.requestId),normalized={filePath:resolve(input.filePath),caption:input.caption??'',duration:input.duration??null,
    width:input.width??null,height:input.height??null,...(input.allowFileFallback===true?{allowFileFallback:true}:{})};
   assert.ok(typeof normalized.caption==='string'&&normalized.caption.length<=4000,'Caption too long');
   for(const key of ['duration','width','height'])if(normalized[key]!==null)assert.ok(Number.isSafeInteger(normalized[key])&&normalized[key]>0,'Invalid media '+key);
   const fingerprint=hash(normalized),previous=old(id);
   if(previous){assert.equal(previous.fingerprint,fingerprint,'Legacy media request ID conflict');return legacyView(previous);}
   const existing=delivery.inspect(id);
   if(existing){assert.equal(existing.sourceFingerprint,fingerprint,'Media request ID conflict');return view(existing);}
   const key=join(options.dataDir,id),busy=flights.get(key);
   if(busy){assert.equal(busy.fingerprint,fingerprint,'Media request ID conflict');return busy.promise;}
   const promise=(async()=>{
    signal?.throwIfAborted();const {artifact,bytes}=await snapshot(normalized,signal);
    const tool=artifact.kind==='image'?'clawchat_send_image':artifact.kind==='audio'&&!normalized.allowFileFallback?'clawchat_send_voice':'clawchat_send_file';
    if(tool==='clawchat_send_image')assert.ok((normalized.width===null)===(normalized.height===null),'图片宽高必须同时提供');
    const payload={chat_id:route.conversation,chat_type:'direct',path:artifact.path,
     ...(normalized.caption?{caption:normalized.caption}:{}),...(artifact.kind==='file'?{as_document:true}:{}),
     ...(tool==='clawchat_send_voice'&&(normalized.duration??artifact.duration)?{duration_ms:normalized.duration??artifact.duration}:{}),
     ...(tool==='clawchat_send_image'&&normalized.width?{width:normalized.width,height:normalized.height}:{})};
    await delivery.submit({id,tool,input:payload,artifact,bytes,sourceFingerprint:fingerprint,sourceScope:scope},{signal});
    return view(delivery.inspect(id));
   })();
   flights.set(key,{fingerprint,promise});try{return await promise;}finally{flights.delete(key);}
  },
  async check(id){assert.match(id,/^whalenest-media-[a-f0-9]{64}$/);const previous=old(id);if(previous)return legacyView(previous);
   const record=delivery.inspect(id);assert.ok(record,'Unknown media receipt in this session');return view(record);},
  checkRequest(inputId){return this.check(idFor(inputId));},
  cleanup:()=>delivery.cleanup(),
 };
}

export function mediaTools(options,route,sessionId){
 const sender=createMediaSender(options,route,{sessionId});
 const operationId=ctx=>{
  assert.ok(ctx?.callId&&ctx.agent?.session,'Native tool call identity required');const session=ctx.agent.session;
  for(let i=session.seq;i>=0;i--){const e=session.eventAt(i),message=e?.data?.message;
   if(e?.type==='assistant/message'&&message?.content?.some(b=>b.type==='tool-call'&&String(b.id)===String(ctx.rootCallId??ctx.callId)))return String(message.id)+':'+String(ctx.callId);}
  throw Error('Persisted native media tool call required');
 };
 return [defineTool({name:'send_media',description:'将工作区现成的图片、音频、文件或视频通过官方工具发送到当前主人私聊。confirmed且有messageId才算已发送；uncertain时查询media_status，禁止另起请求重发。',
  render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
  properties:{filePath:str('工作区内真实文件的绝对路径'),caption:str('可选说明'),duration:int('音频时长，毫秒'),width:int('图片宽度，须同时提供高度'),height:int('图片高度，须同时提供宽度')},required:['filePath'],
  execute:async(args,ctx)=>sender.send({...args,requestId:operationId(ctx)},{signal:ctx.signal})}),
 defineTool({name:'media_status',description:'查询本会话已保存的附件回执；不重新发送、不读平台内部数据库，未知结果可能仍待确认。',properties:{requestId:str('send_media返回的requestId')},required:['requestId'],
  render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],execute:async(args)=>sender.check(args.requestId)})];
}
