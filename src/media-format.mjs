import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {extname} from 'node:path';
import {sniffMedia} from './media.mjs';

export function wavDuration(bytes){
 if(bytes.length<12||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')return;
 let rate,data;
 for(let offset=12;offset+8<=bytes.length;){
  const kind=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
  if(kind==='fmt '&&size>=16&&start+16<=bytes.length)rate=bytes.readUInt32LE(start+8);
  if(kind==='data')data=Math.min(size,bytes.length-start);
  if(start+size>bytes.length)break;offset=start+size+(size%2);
 }
 if(rate>0&&data>0)return Math.max(1,Math.round(data*1000/rate));
}
function decodeWav(bytes,{executable,maxBytes,signal}){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['-nostdin','-loglevel','error','-protocol_whitelist','file,pipe','-i','pipe:0',
   '-map','0:a:0','-vn','-map_metadata','-1','-c:a','pcm_s32le','-f','wav','pipe:1'],{stdio:['pipe','pipe','pipe'],signal});
  const chunks=[];let length=0,error='',tooLarge=false,timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);timeout.unref();
  child.stdout.on('data',chunk=>{length+=chunk.length;if(length>maxBytes){tooLarge=true;child.kill('SIGKILL');}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{error=(error+chunk).slice(-500);});
  child.stdin.on('error',()=>{});child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('close',code=>{
   clearTimeout(timeout);
   if(timedOut)return reject(Error('音频转换超时，原作品保留，未发送'));
   if(tooLarge)return reject(Error('转换后的音频超过附件大小限制，原作品保留，未发送'));
   if(code!==0)return reject(Error('音频格式转换失败，原作品保留，未发送'+(error?'：'+error:'')));
   const result=Buffer.concat(chunks);if(result.length<44)return reject(Error('音频转换结果为空'));
   result.writeUInt32LE(result.length-8,4);
   for(let offset=12;offset+8<=result.length;){
    const size=result.readUInt32LE(offset+4);
    if(result.toString('ascii',offset,offset+4)==='data'){result.writeUInt32LE(result.length-offset-8,offset+4);break;}
    offset+=8+size+(size%2);
   }
   resolve(result);
  });
  child.stdin.end(bytes);
 });
}

/** Decode unsupported voice formats in bounded memory without changing the
 * sample rate/channels or overwriting the original work. */
export async function prepareOutgoingFormat(bytes,{name,maxBytes,allowFileFallback=false,ffmpeg='ffmpeg',signal}={}){
 assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0,'Invalid outgoing media size limit');signal?.throwIfAborted();
 const declared={'.txt':'text/plain','.md':'text/markdown','.json':'application/json','.webm':'video/webm'}[extname(name).toLowerCase()];
 const mime=sniffMedia(bytes,declared),kind=mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':mime.startsWith('image/')?'image':'file';
 if(kind==='audio'&&!allowFileFallback&&!['audio/wav','audio/mpeg','audio/ogg','audio/webm'].includes(mime)){
  const converted=await decodeWav(bytes,{executable:ffmpeg,maxBytes,signal});
  return {bytes:converted,name:name.replace(/\.[^.]+$/,'')+'.wav',mime:'audio/wav',kind:'audio',duration:wavDuration(converted),converted:true};
 }
 return {bytes,name,mime,kind,...(mime==='audio/wav'?{duration:wavDuration(bytes)}:{})};
}
