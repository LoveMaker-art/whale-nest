import assert from 'node:assert/strict';
import {readdirSync,existsSync} from 'node:fs';
import {open,mkdir,rename,rm,stat,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hash,ownerScope} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {readPlatformProvider} from './platform-provider.mjs';
import {sniffMedia} from './media.mjs';

/** MusicHub only. Creating a song happens once; recovery never POSTs again. */
export function createSongClient(options,{fetchImpl=fetch,requestTimeoutMs=30000,downloadTimeoutMs=120000}={}){
 const settings=options.singing??{},directory=join(options.dataDir,'media/song-requests'),scope=ownerScope(options),flights=new Map();
 const file=id=>{assert.match(id,/^whalenest-song-[a-f0-9]{64}$/);return join(directory,id+'.json');};
 function inspect(id){const r=readState(file(id),null);if(r)assert.equal(r.scope,scope,'歌曲归属不符');return r;}
 const save=r=>{writeState(file(r.requestId),r);return r;};
 function audioPath(r,job){
  const legacy='/api/jobs/'+encodeURIComponent(r.jobId)+'/audio.flac';let path=legacy;
  if(typeof job.audio_url==='string'){
   const url=new URL(job.audio_url,r.origin),prefix='/api/jobs/'+encodeURIComponent(r.jobId)+'/audio.';
   if(url.origin===r.origin&&!url.search&&!url.hash&&['wav','mp3','flac'].some(ext=>url.pathname===prefix+ext))path=url.pathname;
  }
  r.downloadPath=path;
  if(Number.isFinite(job.duration_seconds)&&job.duration_seconds>0&&job.duration_seconds<=86400)r.durationMs=Math.round(job.duration_seconds*1000);
 }
 async function call(path,{record,body,signal,download=false,allowMissing=false}={}){
  assert.ok(settings.enabled,'平台唱歌尚未启用');const {base,key}=await readPlatformProvider(settings),url=new URL(path,base);
  assert.equal(url.origin,new URL(base).origin,'音乐服务地址不可信');
  if(record?.origin)assert.equal(url.origin,record.origin,'服务地址已变更，请核对原歌曲任务');
  const timeout=AbortSignal.timeout(body?65000:download?downloadTimeoutMs:requestTimeoutMs);
  const response=await fetchImpl(url.href,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok&&!(allowMissing&&response.status===404)){
   await response.body?.cancel();throw Error('平台音乐接口返回HTTP '+response.status);
  }
  return {response,origin:url.origin};
 }
 async function exclusive(id,fn){if(flights.has(id))return flights.get(id);const p=fn();flights.set(id,p);try{return await p;}finally{flights.delete(id);}}
 function parameters(args){
  for(const [name,max]of [['title',160],['lyrics',8000],['style',2000]])assert.ok(typeof args[name]==='string'&&args[name].trim()&&args[name].length<=max,'歌曲'+name+'为空或过长');
  const voice=args.voicePreset??'none';assert.ok(['none','hope'].includes(voice),'只支持平台现有none/hope声音选项');
  return {title:args.title.trim(),lyrics:args.lyrics.trim(),style:args.style.trim(),voicePreset:voice};
 }
 async function create(args,{requestId,route,sessionId,signal}={}){
  const params=parameters(args),fingerprint=hash(params),old=inspect(requestId);
  if(old){assert.equal(old.fingerprint,fingerprint,'同一主人回合只生成一首，不能改变参数后重新付费');return old;}
  return exclusive(requestId,async()=>{
   // Credential errors are resolved before writing a submitted intent.
   const {base}=await readPlatformProvider(settings);
   const r={schema:1,scope,requestId,fingerprint,parameters:params,route:structuredClone(route),sessionId,state:'submitting',createdAt:new Date().toISOString(),origin:new URL(base).origin};save(r);
   try{
    const {response}=await call('/api/jobs',{record:r,signal,body:{title:params.title,lyrics:params.lyrics,style:params.style,cot:'full',voice_preset:params.voicePreset,
     seed:parseInt(hash(requestId).slice(0,8),16)%2000000000,max_tokens:9000}});
    const body=await response.json();assert.ok(typeof body.id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(body.id),'平台未返回有效歌曲任务ID');
    r.jobId=body.id;r.state='queued';return save(r);
   }catch(error){r.state='uncertain';r.error=error.message;return save(r);}
  });
 }
 async function poll(id,{signal}={}){return exclusive(id,async()=>{
  const r=inspect(id);assert.ok(r?.jobId,'没有可查询的任务ID，不能重新生成');
  if(['saved','failed'].includes(r.state))return r;
  const {response}=await call('/api/jobs/'+encodeURIComponent(r.jobId),{record:r,signal}),job=await response.json();
  r.stage=String(job.stage??'').slice(0,100);r.updatedAt=new Date().toISOString();delete r.error;
  if(job.status==='succeeded'){r.state='ready';audioPath(r,job);}
  else if(['failed','cancelled'].includes(job.status)){r.state='failed';r.error='平台歌曲任务'+job.status;}
  else if(['queued','running'].includes(job.status))r.state=job.status;
  else{r.state='uncertain';r.error='平台返回未知歌曲状态，保留原任务待核对';}
  return save(r);
 });}
 async function download(id,{signal}={}){return exclusive(id,async()=>{
  const r=inspect(id);assert.ok(r,'歌曲请求不存在');
  if(r.state==='saved'){assert.equal((await stat(r.artifact.path)).size,r.artifact.size,'已保存歌曲发生变化');return r;}
  assert.equal(r.state,'ready','平台尚未确认生成完成');
  const dir=join(options.dataDir,'media/outgoing/songs');await mkdir(dir,{recursive:true,mode:0o700});
  if(!r.downloadPath){const {response}=await call('/api/jobs/'+encodeURIComponent(r.jobId),{record:r,signal});const job=await response.json();assert.equal(job.status,'succeeded','原歌曲任务尚未完成');audioPath(r,job);save(r);}
  const part=join(dir,id+'.part'),max=settings.maxBytes??32*1024*1024;
  const {response}=await call(r.downloadPath,{record:r,signal,download:true});
  await rm(part,{force:true});const handle=await open(part,'wx',0o600),digest=createHash('sha256');let bytes=0,head=Buffer.alloc(0);
  let mime;
  try{
   for await(const chunk of response.body){const b=Buffer.from(chunk);bytes+=b.length;assert.ok(bytes<=max,'歌曲超过本实例保存上限，已保留原平台任务，不重新生成');
    if(head.length<8192)head=Buffer.concat([head,b.subarray(0,8192-head.length)]);digest.update(b);let written=0;while(written<b.length){const result=await handle.write(b,written,b.length-written);assert.ok(result.bytesWritten>0,'歌曲写入中断');written+=result.bytesWritten;}
   }
   mime=sniffMedia(head);assert.ok(bytes>4&&['audio/flac','audio/wav','audio/mpeg'].includes(mime),'平台未返回受支持的歌曲音频');await handle.sync();
  }catch(error){await handle.close();await rm(part,{force:true});throw error;}
  await handle.close();const path=join(dir,id+'.'+({'audio/flac':'flac','audio/wav':'wav','audio/mpeg':'mp3'}[mime]));await rename(part,path);r.artifact={path,size:bytes,mime,sha256:digest.digest('hex')};r.state='saved';if(r.error){r.lastError=r.error;delete r.error;}return save(r);
 });}
 async function score(id){return exclusive('score:'+id,async()=>{
  const r=inspect(id);
  if(r?.state!=='saved'||!r.jobId)return null;
  const path=file(id).replace(/\.json$/,'.abc');
  try{return await readFile(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const {response}=await call('/api/jobs/'+encodeURIComponent(r.jobId)+'/score.abc',{record:r,allowMissing:true});
  if(response.status===404){await response.body?.cancel();return null;}
  const chunks=[];let size=0;
  for await(const chunk of response.body){
   size+=chunk.length;
   assert.ok(size<=128*1024,'平台乐谱超过读取上限');
   chunks.push(Buffer.from(chunk));
  }
  const contents=Buffer.concat(chunks).toString('utf8');
  assert.ok(/^X:\s*\d+/m.test(contents)&&/^K:/m.test(contents),'平台未返回有效的 ABC 乐谱');
  const part=path+'.part';
  try{await writeFile(part,contents,{mode:0o600});await rename(part,path);}
  finally{await rm(part,{force:true});}
  return contents;
 });}
 return {enabled:settings.enabled===true,create,poll,download,score,inspect,save,
  list:()=>existsSync(directory)?readdirSync(directory).filter(n=>/^whalenest-song-[a-f0-9]{64}\.json$/.test(n))
   .map(n=>inspect(n.slice(0,-5))).filter(Boolean).sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??'')):[],
 };
}
