import assert from 'node:assert/strict';
import {readdirSync,existsSync} from 'node:fs';
import {open,mkdir,rename,rm,stat,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hash,ownerScope} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {readPlatformProvider} from './platform-provider.mjs';
import {sniffMedia} from './media.mjs';
import {validMelody} from './song-studio.mjs';
import {graftSongScore} from './song-score.mjs';
import {analyzeSongMelody,validateSongLyrics,revisionLyricPlan} from './song-melody.mjs';

export const recoverableSongJob = record => record.jobId || (record.phase === 'plan' ? record.planJobId : null);

/** MusicHub only. Creating a song happens once; recovery never POSTs again. */
export function createSongClient(options,{fetchImpl=fetch,requestTimeoutMs=30000,downloadTimeoutMs=120000}={}){
 const settings=options.singing??{},directory=join(options.dataDir,'media/song-requests'),scope=ownerScope(options),flights=new Map();
 const file=id=>{assert.match(id,/^whalenest-song-[a-f0-9]{64}$/);return join(directory,id+'.json');};
 const scoreDetails=id=>{assert.match(id,/^whalenest-song-[a-f0-9]{64}$/);return join(options.dataDir,'media/song-score-data',id+'.json');};
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
  if(args.cfgScale!==undefined)assert.ok(Number.isFinite(args.cfgScale)&&args.cfgScale>=0&&args.cfgScale<=3,'歌曲演唱引导强度必须在0到3之间');
  return {title:args.title.trim(),lyrics:args.lyrics.trim(),style:args.style.trim(),voicePreset:voice,...(args.cfgScale!==undefined?{cfgScale:args.cfgScale}: {})};
 }
 async function submit(record, signal, abc){
  const p = record.parameters;
  const {response}=await call('/api/jobs',{record,signal,body:{title:p.title,lyrics:p.lyrics,style:p.style,cot:abc?'melody':'full',voice_preset:p.voicePreset,
   seed:parseInt(hash(record.requestId).slice(0,8),16)%2000000000,max_tokens:9000,...(p.cfgScale!==undefined?{cfg_scale:p.cfgScale}: {}),...(abc ? {abc} : {})}});
  const body=await response.json();assert.ok(typeof body.id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(body.id),'平台未返回有效歌曲任务ID');
  return body.id;
 }
 async function create(args,{requestId,route,sessionId,signal,material}={}){
  const params=parameters(args),old=inspect(requestId);
  const composition = material && Object.keys(material).length ? material : undefined;
  const fingerprint = composition ? hash([params,composition]) : hash(params);
  if(old){assert.equal(old.fingerprint,fingerprint,'同一主人回合只生成一首，不能改变参数后重新付费');return old;}
  assert.ok(/[A-Za-z]{3}/.test(args.style) && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(args.style),'歌曲 style 请用英文描述，包含歌唱语言、曲风、演唱、乐器和节奏；歌词继续使用主人要求的语言');
  if (composition?.abc !== undefined) assert.ok(validMelody(composition.abc),'无效的 ABC 乐谱');
  const result=await exclusive(requestId,async()=>{
   const existing=inspect(requestId);
   if(existing){assert.equal(existing.fingerprint,fingerprint,'同一主人回合只生成一首，不能改变参数后重新付费');return existing;}
   if (composition?.abc && composition.melodyMode!=='graft') {
    const melody=await analyzeSongMelody(composition.abc,{python:settings.python,signal});
    validateSongLyrics(params.lyrics,composition.lyricTemplate&&!['structure','phrase'].includes(composition.scoreEdit?.mode)?revisionLyricPlan(composition.lyricTemplate):melody);
   }
   // Credential errors are resolved before writing a submitted intent.
   const {base}=await readPlatformProvider(settings);
   const r={schema:1,scope,requestId,fingerprint,parameters:params,route:structuredClone(route),sessionId,state:'submitting',createdAt:new Date().toISOString(),origin:new URL(base).origin,
    ...(composition ? {composition,projectId:composition.projectId,parentId:composition.parentId,version:composition.version} : {})};save(r);
   try{
    if (composition?.melodyMode === 'graft') {
     r.planJobId=await submit(r,signal);
     r.phase='plan';
    } else r.jobId=await submit(r,signal,composition?.abc);
    r.state='queued';return save(r);
   }catch(error){r.state='uncertain';r.error=error.message;return save(r);}
  });
  assert.equal(result.fingerprint,fingerprint,'同一主人回合只生成一首，不能改变参数后重新付费');
  return result;
 }
 async function readScore(record,jobId,signal){
  const {response}=await call('/api/jobs/'+encodeURIComponent(jobId)+'/score.abc',{record,signal,allowMissing:true});
  if(response.status===404){await response.body?.cancel();return null;}
  const chunks=[];let size=0;
  for await(const chunk of response.body){
   size+=chunk.length;
   assert.ok(size<=128*1024,'平台乐谱超过读取上限');
   chunks.push(Buffer.from(chunk));
  }
  const contents=Buffer.concat(chunks).toString('utf8');
  assert.ok(/^X:\s*\d+/m.test(contents)&&/^K:/m.test(contents),'平台未返回有效的 ABC 乐谱');
  return contents;
 }
 async function pollPlan(record,job,signal){
  if (!record.grafted && (job.has_score || job.status === 'succeeded')) {
   const score = await readScore(record,record.planJobId,signal);
   if (score) {
    try { record.grafted=await graftSongScore(score,record.composition.abc,{python:settings.python,signal}); }
    catch (error) {
     if (signal?.aborted) throw error;
     record.state='failed';record.error='原旋律无法嵌入整首曲式，可以选择按原旋律唱短歌';return save(record);
    }
    save(record);
   }
  }
  if (record.grafted) {
   if (job.status !== 'succeeded') await call('/api/jobs/'+encodeURIComponent(record.planJobId)+'/cancel',
    {record,body:{},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)})
    .then(({response})=>response.body?.cancel()).catch(()=>{});
   signal?.throwIfAborted();
   // Persist intent before the second paid call. A lost response cannot restart either pass.
   record.phase='performance';record.state='submitting';record.melodySection=record.grafted.section;save(record);
   try { record.jobId=await submit(record,signal,record.grafted.abc);record.state='queued'; }
   catch (error) { record.state='uncertain';record.error=error.message; }
   return save(record);
  }
  if (['queued','running'].includes(job.status)) record.state=job.status;
  else { record.state='failed';record.error='平台未返回可用于扩展旋律的乐谱'; }
  return save(record);
 }
 async function poll(id,{signal}={}){return exclusive(id,async()=>{
  const r=inspect(id);const known = r && recoverableSongJob(r);assert.ok(known,'没有可查询的任务ID，不能重新生成');
  if(['saved','failed'].includes(r.state))return r;
  if (r.phase==='plan' && r.grafted) return pollPlan(r,{},signal);
  const {response}=await call('/api/jobs/'+encodeURIComponent(known),{record:r,signal}),job=await response.json();
  r.stage=String(job.stage??'').slice(0,100);r.updatedAt=new Date().toISOString();delete r.error;
  if(job.truncated!==undefined)r.truncated=!!job.truncated;
  if(job.has_score!==undefined)r.hasScore=!!job.has_score;
  if (r.phase === 'plan') return pollPlan(r,job,signal);
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
  await handle.close();const path=join(dir,id+'.'+({'audio/flac':'flac','audio/wav':'wav','audio/mpeg':'mp3'}[mime]));await rename(part,path);r.artifact={path,size:bytes,mime,sha256:digest.digest('hex')};r.state='saved';if(r.error){r.lastError=r.error;delete r.error;}save(r);
  if(r.hasScore)try{await score(id);}catch{ /* Audio remains usable if the optional score is unavailable. */ }
  return inspect(id);
 });}
 async function score(id){return exclusive('score:'+id,async()=>{
  const r=inspect(id);
  if(r?.state!=='saved'||!r.jobId)return null;
  const path=file(id).replace(/\.json$/,'.abc');
  try{
   const cached=await readFile(path,'utf8');
   if(!readState(scoreDetails(id),null))try{writeState(scoreDetails(id),await analyzeSongMelody(cached,{python:settings.python}));}catch{ /* Keep the original score downloadable. */ }
   return cached;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const contents = await readScore(r,r.jobId);
  if (contents === null) return null;
  const part=path+'.'+randomUUID()+'.part';
  try{await writeFile(part,contents,{mode:0o600});await rename(part,path);}
  finally{await rm(part,{force:true});}
  try{writeState(scoreDetails(id),await analyzeSongMelody(contents,{python:settings.python}));}catch{ /* Timing is optional; do not invent note positions. */ }
  return contents;
 });}
 return {enabled:settings.enabled===true,create,poll,download,score,inspect,save,scoreDetails:id=>readState(scoreDetails(id),null),
  list:()=>existsSync(directory)?readdirSync(directory).filter(n=>/^whalenest-song-[a-f0-9]{64}\.json$/.test(n))
   .map(n=>inspect(n.slice(0,-5))).filter(Boolean).sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??'')):[],
 };
}
