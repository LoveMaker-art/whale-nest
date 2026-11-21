import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sniffMedia,prepareRuntimeInput} from '../src/media.mjs';
import {mp4Fixture} from './mp4-helper.mjs';

test('MP4 track handlers distinguish audio-only mp42 recordings from video, independent of declared MIME',()=>{
 assert.equal(sniffMedia(mp4Fixture(),'audio/mp4'),'audio/mp4');
 assert.equal(sniffMedia(mp4Fixture({brand:'isom',extended:false}),'video/mp4'),'audio/mp4');
 assert.equal(sniffMedia(mp4Fixture({handlers:['soun','vide']}),'audio/mp4'),'video/mp4');
 assert.equal(sniffMedia(mp4Fixture({brand:'M4A ',handlers:['vide']}),'audio/mp4'),'video/mp4');
});

test('late moov audio survives the real input preparation boundary and replays without a second ASR',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-mp4-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const bytes=mp4Fixture(),source=join(dataDir,'voice.m4a');await writeFile(source,bytes);let calls=0;
 const options={dataDir,speech:{enabled:true,asrModel:'configured'}},context={bindingId:'dsh',chatId:'owner',sessionId:'original',cacheMedia:async()=>source};
 const input={turnId:'native-mp42',prompt:'运维自测',media:[{kind:'audio',mime:'audio/mp4',size:bytes.length,name:'voice.m4a'}]};
 const speech={transcribe:async(file,mime)=>{calls++;assert.equal(mime,'audio/mp4');assert.deepEqual(await readFile(file),bytes);return '收到真实音频';}};
 const first=await prepareRuntimeInput(input,context,options,speech);assert.equal(calls,1);assert.match(first.prompt,/收到真实音频/);assert.deepEqual(first.media,[]);
 assert.deepEqual(await prepareRuntimeInput(input,context,options,speech),first);assert.equal(calls,1);
});

test('video tracks declared as audio remain rejected before ASR even under an m4a name',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-mp4-video-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const source=join(dataDir,'voice.m4a');await writeFile(source,mp4Fixture({handlers:['soun','vide']}));let calls=0;
 await assert.rejects(prepareRuntimeInput({turnId:'mislabeled',media:[{kind:'audio',mime:'audio/mp4',name:'voice.m4a'}]},{bindingId:'dsh',chatId:'owner',sessionId:'original',cacheMedia:async()=>source},{dataDir,speech:{enabled:true,asrModel:'configured'}},{transcribe:async()=>{calls++;return 'must not transcribe video';}}),/附件内容与媒体类型不符/);
 assert.equal(calls,0);
});

test('truncated or invalid boxes and handler text inside mdat cannot masquerade as an audio track',()=>{
 const bytes=mp4Fixture();assert.equal(sniffMedia(bytes.subarray(0,8192),'audio/mp4'),'video/mp4');
 const corrupt=Buffer.from(bytes);corrupt.writeUInt32BE(0xffffffff,24);assert.equal(sniffMedia(corrupt,'audio/mp4'),'video/mp4');
 const noTrack=mp4Fixture({handlers:[]});noTrack.write('hdlrxxxxsoun',80);assert.equal(sniffMedia(noTrack,'audio/mp4'),'video/mp4');
});
