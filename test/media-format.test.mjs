import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {prepareOutgoingFormat,wavDuration} from '../src/media-format.mjs';

test('media format preserves PNG/GIF/WAV content and obtains WAV duration from actual chunks',async()=>{
 for(const [name,kind]of [['image.png','image'],['animation.gif','image'],['audio.wav','audio'],['document.txt','file']]){
  const bytes=await readFile(new URL('./fixtures/media/'+name,import.meta.url));
  const result=await prepareOutgoingFormat(bytes,{name,maxBytes:1024*1024});assert.equal(result.kind,kind);assert.equal(result.bytes,bytes);
  if(kind==='audio')assert.ok(result.duration>0);
 }
});
test('FLAC can be decoded for voice without resampling, artifacts on disk, or overwriting the original',async t=>{
 const bytes=await readFile(new URL('./fixtures/media/audio.wav',import.meta.url));
 const encoded=spawnSync('ffmpeg',['-nostdin','-loglevel','error','-i','pipe:0','-c:a','flac','-f','flac','pipe:1'],{input:bytes,maxBuffer:1024*1024});
 if(encoded.error?.code==='ENOENT'){t.skip('ffmpeg is not installed; deployment preflight must verify it');return;}
 assert.equal(encoded.status,0,encoded.stderr?.toString());const flac=encoded.stdout,original=Buffer.from(flac);
 const result=await prepareOutgoingFormat(flac,{name:'song.flac',maxBytes:1024*1024});
 assert.equal(result.kind,'audio');assert.equal(result.mime,'audio/wav');assert.equal(result.name,'song.wav');assert.equal(result.converted,true);
 assert.equal(result.duration,wavDuration(bytes));assert.deepEqual(flac,original);
 const preserved=await prepareOutgoingFormat(flac,{name:'song.flac',maxBytes:1024*1024,allowFileFallback:true});assert.equal(preserved.bytes,flac);
 await assert.rejects(prepareOutgoingFormat(flac,{name:'song.flac',maxBytes:50}),/超过附件大小限制/);
 await assert.rejects(prepareOutgoingFormat(flac,{name:'song.flac',maxBytes:1024*1024,ffmpeg:'/missing/ffmpeg'}),/ENOENT/);
});
