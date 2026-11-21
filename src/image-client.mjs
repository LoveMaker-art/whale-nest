import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {readPlatformProvider} from './platform-provider.mjs';
import {sniffMedia} from './media.mjs';
import {assertPublicUrl} from '../vendor/aurabot/src/core/net.js';
import {createHash} from 'node:crypto';

const digest=b=>createHash('sha256').update(b).digest('hex'),flights=new Map();
/** Selected platform HTTP only. Original imagegen supplies the one drawing
 * interface; downloaded results and unknown submissions survive restart. */
export function createImageClient(options,{fetchImpl=fetch,verifyResultURL=assertPublicUrl}={}){
 const settings=options.image??{},directory=join(options.dataDir,'media/image-requests');
 const file=id=>join(directory,hash(id)+'.json');
 async function artifact(record,signal){
  if(record.state==='completed'){
   const bytes=await readFile(record.artifact.path);assert.equal(digest(bytes),record.artifact.sha256,'已生成作品发生变化');return bytes;
  }
  assert.ok(record.url&&record.state==='received','上次图像请求结果不确定，不能重新付费生成');
  const url=new URL(record.url);assert.ok(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password,'作品下载地址无效');
  const configuredLocal=url.origin===record.providerOrigin&&['127.0.0.1','localhost'].includes(url.hostname);
  if(!configuredLocal)await verifyResultURL(url.href);
  const timeout=AbortSignal.timeout(120000),r=await fetchImpl(url.href,{redirect:'error',signal:signal?AbortSignal.any([timeout,signal]):timeout});
  assert.ok(r.ok,'作品下载失败，已保留生成结果，不重新生成');
  const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;assert.ok(size<=32*1024*1024,'作品超过32MiB下载限制');chunks.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(chunks),mime=sniffMedia(bytes.subarray(0,8192));assert.ok(['image/png','image/jpeg','image/webp'].includes(mime),'服务没有返回有效PNG/JPEG/WebP图片');
  const dir=join(options.dataDir,'media/outgoing');await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,digest(bytes)+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]));
  await writeFile(path,bytes,{mode:0o600});record.artifact={path,mime,size:bytes.length,sha256:digest(bytes)};record.state='completed';writeState(file(record.requestId),record);return bytes;
 }
 return {
  enabled:settings.enabled===true,
  inspect:id=>readState(file(id),null),
  async recover(id,{signal}={}){const r=readState(file(id),null);assert.ok(r,'没有已提交的图像请求');return artifact(r,signal);},
  async generate(prompt,{requestId,image,size,signal}={}){
   assert.ok(settings.enabled&&settings.model,'图像服务尚未配置');assert.ok(typeof requestId==='string'&&requestId.length<=256&&requestId,'图像生成需要持久请求标识');
   assert.ok(typeof prompt==='string'&&prompt.trim()&&prompt.length<=8000,'画面描述需为1–8000字');
   size=size??settings.size??'1024x1024';const dims=/^(\d+)x(\d+)$/.exec(size);assert.ok(dims,'本轮需明确图像尺寸');const w=Number(dims[1]),h=Number(dims[2]);assert.ok(w*h>=512**2&&w*h<=2048**2&&w/h>=1/8&&w/h<=8,'图像尺寸超出平台范围');
   let mime;if(image){assert.ok(Buffer.isBuffer(image)&&image.length<=10*1024*1024,'参考图需为10MiB以内图片');mime=sniffMedia(image.subarray(0,8192));assert.ok(['image/png','image/jpeg','image/webp'].includes(mime),'参考图需为PNG/JPEG/WebP');}
   const {base,key}=await readPlatformProvider(settings),fingerprint=hash([prompt,settings.model,size,image?digest(image):null,base]);
   const active=flights.get(file(requestId));if(active){assert.equal(active.fingerprint,fingerprint,'图像请求内容冲突');return active.promise;}
   const run=async()=>{
    let record=readState(file(requestId),null);if(record){assert.equal(record.fingerprint,fingerprint,'图像请求内容冲突');return artifact(record,signal);}
    const body=JSON.stringify({model:settings.model,prompt,n:1,size,prompt_extend:false,response_format:'url',...(image?{image:['data:'+mime+';base64,'+image.toString('base64')]}:{})});
    assert.ok(Buffer.byteLength(body)<=32*1024*1024,'图像请求超过32MiB');signal?.throwIfAborted();
    record={requestId,fingerprint,state:'submitting',model:settings.model,size,providerOrigin:new URL(base).origin,reference:Boolean(image),submittedAt:new Date().toISOString()};writeState(file(requestId),record);
    try{
     const timeout=AbortSignal.timeout(660000),r=await fetchImpl(base+'/images/generations',{method:'POST',redirect:'error',signal:signal?AbortSignal.any([timeout,signal]):timeout,headers:{authorization:'Bearer '+key,'content-type':'application/json','Idempotency-Key':requestId},body});
     if(!r.ok){let code='upstream-error';try{const e=await r.json(),c=e.error?.code??e.error?.type??e.code;if(typeof c==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(c))code=c;}catch{}throw Error('图像服务请求未确认（HTTP '+r.status+'，'+code+'），已保留原请求，不自动重试');}
     const result=await r.json();assert.equal(result.data?.length,1,'图像服务未返回恰好一张作品');assert.equal(typeof result.data[0].url,'string','图像服务未返回作品地址');
     record.url=result.data[0].url;record.state='received';writeState(file(requestId),record);
    }catch(error){record.state='uncertain';writeState(file(requestId),record);throw error;}
    return artifact(record,signal);
   };
   const promise=run();flights.set(file(requestId),{fingerprint,promise});try{return await promise;}finally{flights.delete(file(requestId));}
  },
 };
}
