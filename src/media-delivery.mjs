import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,mkdir,writeFile,realpath,readFile,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readState,writeState} from './state.mjs';
import {hash,routeKey,senderKey} from './routing.mjs';
import {sniffMedia} from './media.mjs';
import {createClawChatCore} from './clawchat-core.mjs';
import {defineTool,str,int} from '../vendor/aurabot/src/tools/tools.js';

const exec=promisify(execFile),flights=new Map();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const contains=(root,path)=>{const rel=relative(root,path);return !rel.startsWith('..')&&!isAbsolute(rel);};
const kindOf=mime=>mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':mime.startsWith('image/')?'image':'file';

/** Owns media snapshots, durable receipts and read-only recovery. The current Core
 * remains the only connection owner. A status lookup never creates a send. */
export function createMediaSender(options,route,{sessionId,run=exec,readStatus=(name,id)=>createClawChatCore(options).toolStatus(name,id)}={}) {
 assert.equal(routeKey(route),routeKey(options.clawchat?.route),'Unverified media route');
 assert.equal(senderKey(route),senderKey(options.clawchat.route),'Unverified media sender');
 assert.ok(route.channel==='clawchat'&&route.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'Owner private route required');
 assert.ok(typeof sessionId==='string'&&sessionId,'Media session identity required');
 const delivery=options.clawchat.delivery;
 assert.ok(delivery?.mediaEnabled&&delivery.connectBin&&delivery.configPath,'Media delivery is not enabled');
 const root=join(resolve(options.dataDir),'media','outgoing');
 const scope=hash([options.instanceId,routeKey(route),senderKey(route),sessionId]);
 const idFor=inputId=>'whalenest-media-'+hash([scope,inputId]);
 const fileFor=id=>join(root,'receipts',id+'.json');
 const view=r=>({ok:r.state==='confirmed',state:r.state,requestId:r.requestId,kind:r.deliveredKind??r.artifact.kind,name:r.artifact.name,
  ...(r.messageId?{messageId:r.messageId}:{}),message:r.state==='confirmed'?'附件已发送，平台消息确认：'+r.messageId:r.state==='uncertain'?'发送结果尚未确认，请查询 media_status；不要重复发送。':'附件未发送：'+(r.error??r.state)});
 async function snapshot(filePath) {
  assert.ok(typeof filePath==='string'&&isAbsolute(filePath),'文件必须使用工作区内的绝对路径');
  assert.ok(!(await lstat(filePath)).isSymbolicLink(),'附件不能是符号链接');
  await mkdir(root,{recursive:true,mode:0o700});
  const path=await realpath(filePath),roots=await Promise.all([resolve(options.cwd),root,join(resolve(options.dataDir),'media','incoming'),join(resolve(options.dataDir),'aurabot','stickers'),join(resolve(options.dataDir),'aurabot','bili-shots'),join(resolve(options.dataDir),'aurabot','imagegen')].map(async p=>{try{return await realpath(p);}catch{return null;}}));
  assert.ok(roots.some(r=>r&&contains(r,path)),'只允许发送工作区或受控附件目录中的文件');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes;
  try {const s=await handle.stat();assert.ok(s.isFile()&&s.size>0&&s.size<=(options.media?.maxBytesEach??16*1024*1024),'附件为空、不是普通文件或超过限制');bytes=await handle.readFile();assert.equal(bytes.length,s.size,'附件读取期间发生变化');}
  finally {await handle.close();}
  const declared={'.txt':'text/plain','.md':'text/markdown','.json':'application/json','.webm':'video/webm'}[extname(path).toLowerCase()];
  const mime=sniffMedia(bytes.subarray(0,8192),declared),kind=kindOf(mime),digest=sha(bytes);
  const name=basename(path).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160);assert.ok(name&&name!=='.'&&name!=='..','附件名称无效');
  const dir=join(root,'artifacts',digest),target=join(dir,name);await mkdir(dir,{recursive:true,mode:0o700});
  try {await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(sha(await readFile(target)),digest,'缓存附件内容已改变');}
  let duration;
  if(mime==='audio/wav'&&bytes.length>=44){const rate=bytes.readUInt32LE(28);if(rate>0)duration=Math.round((bytes.length-44)*1000/rate);}
  return {path:target,name,mime,kind,sha256:digest,size:bytes.length,...(duration>0?{duration}:{})};
 }
 function settle(record,response) {
  if(['audio','file'].includes(response?.result?.kind))record.deliveredKind=response.result.kind;
  if(response?.status==='succeeded'&&response.result?.sent===true&&typeof response.result.messageId==='string'&&response.result.messageId){record.state='confirmed';record.messageId=response.result.messageId;delete record.error;}
  else if(response?.status==='failed'){record.state='failed';record.error=String(response.error??'平台拒绝发送').slice(0,300);}
  else {record.state='uncertain';record.error='平台尚未给出确定发送结果';}
  record.updatedAt=new Date().toISOString();writeState(fileFor(record.requestId),record);return view(record);
 }
 async function check(requestId,{signal}={}) {
  assert.match(requestId,/^whalenest-media-[a-f0-9]{64}$/,'Invalid media request ID');
  const record=readState(fileFor(requestId),null);assert.ok(record&&record.scope===scope,'Unknown media receipt in this session');
  if(record.state==='confirmed'||record.state==='failed')return view(record);
  try {signal?.throwIfAborted();return settle(record,await readStatus('clawchat_send_media',requestId));}
  catch{return view(record);}
 }
 return {
  async send(input,{signal}={}) {
   assert.ok(typeof input.requestId==='string'&&input.requestId&&input.requestId.length<=256,'Stable media request ID required');
   const id=idFor(input.requestId);
   const normalized={filePath:resolve(input.filePath),caption:input.caption??'',duration:input.duration??null,width:input.width??null,height:input.height??null,
    ...(input.allowFileFallback===true?{allowFileFallback:true}:{})};
   assert.ok(typeof normalized.caption==='string'&&normalized.caption.length<=4000,'Caption too long');
   for(const key of ['duration','width','height'])if(normalized[key]!==null)assert.ok(Number.isSafeInteger(normalized[key])&&normalized[key]>0,'Invalid media '+key);
   const fingerprint=hash(normalized),previous=readState(fileFor(id),null);
   if(previous){assert.equal(previous.scope,scope,'Media scope conflict');assert.equal(previous.fingerprint,fingerprint,'Media request ID conflict');if(previous.state!=='prepared')return view(previous);}
   const busy=flights.get(id);if(busy){assert.equal(busy.fingerprint,fingerprint,'Media request ID conflict');return busy.promise;}
   const promise=(async()=>{
    const record=previous??{requestId:id,scope,fingerprint,state:'prepared',artifact:await snapshot(normalized.filePath),createdAt:new Date().toISOString()};
    writeState(fileFor(id),record);
    const payload={chatId:route.conversation,chatType:'direct',filePath:record.artifact.path,
     ...(normalized.allowFileFallback&&record.artifact.kind==='audio'?{}:{expectedKind:record.artifact.kind}),sha256:record.artifact.sha256,
     ...(normalized.caption?{caption:normalized.caption}:{}),...(normalized.duration??record.artifact.duration?{duration:normalized.duration??record.artifact.duration}:{}),
     ...(normalized.width?{width:normalized.width}:{}),...(normalized.height?{height:normalized.height}:{})};
    record.state='uncertain';record.submittedAt=new Date().toISOString();writeState(fileFor(id),record);
    try {
     const {stdout}=await run(delivery.connectBin,['tool','call','clawchat_send_media','--agent',route.account,'--request-id',id,'--input-json',JSON.stringify(payload),'--config',delivery.configPath],{timeout:125000,maxBuffer:1024*1024,signal});
     return settle(record,JSON.parse(stdout));
    }catch(error){
     try {if(error.stdout)return settle(record,JSON.parse(error.stdout));}catch{}
     if(String(error.stderr??'').trim()==='unknown ClawChat tool: clawchat_send_media'){
      record.state='failed';record.error='当前连接器未安装媒体发送扩展，未提交附件；请先完善连接器配置。';
      record.updatedAt=new Date().toISOString();writeState(fileFor(id),record);return view(record);
     }
     record.error='发送进程中断或结果无法确认';writeState(fileFor(id),record);return view(record);
    }
   })();
   flights.set(id,{fingerprint,promise});try{return await promise;}finally{flights.delete(id);}
  },
  check,
  checkRequest(inputId,options){return check(idFor(inputId),options);},
 };
}

export function mediaTools(options,route,sessionId) {
 const sender=createMediaSender(options,route,{sessionId});
 const operationId=ctx=>{
  assert.ok(ctx?.callId&&ctx.agent?.session,'Native tool call identity required');
  const session=ctx.agent.session;
  for(let i=session.seq;i>=0;i--){const e=session.eventAt(i),message=e?.data?.message;
   if(e?.type==='assistant/message'&&message?.content?.some(b=>b.type==='tool-call'&&String(b.id)===String(ctx.rootCallId??ctx.callId)))return String(message.id)+':'+String(ctx.callId);
  }
  throw Error('Persisted native media tool call required');
 };
 return [defineTool({name:'send_media',description:'将工作区现成的图片、音频、文件或视频发送到当前主人私聊。仅在用户要求或同意发送时使用；确认消息ID后才算已发送。结果不确定时用media_status查询，勿另起请求重发。',
  render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
  properties:{filePath:str('工作区中真实文件的绝对路径'),caption:str('可选说明'),duration:int('音频或视频时长，毫秒；WAV可自动读取'),width:int('图片或视频宽度，像素'),height:int('图片或视频高度，像素')},required:['filePath'],
  execute:async(args,ctx)=>sender.send({...args,requestId:operationId(ctx)},{signal:ctx.signal})}),
 defineTool({name:'media_status',description:'查询本会话先前附件发送结果；只查询回执，不重新发送。',properties:{requestId:str('send_media返回的requestId')},required:['requestId'],render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],execute:async(args,ctx)=>sender.check(args.requestId,{signal:ctx?.signal})})];
}
