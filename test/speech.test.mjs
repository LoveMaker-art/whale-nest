import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSpeechClient} from '../src/speech.mjs';
import {voiceTools} from '../src/voice.mjs';
import {parseWav} from '../vendor/aurabot/src/voice/wav.js';
import {enablePlatformSpeech} from '../src/runtime-upgrade.mjs';

const initialVoice = 'qwen-audio-3.0-tts-flash-fy1ae4cdd1-95f01c83d3984a62bffbfcaae018a8cf';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-speech-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{apiKey:{source:'env',id:'SPEECH_TEST_KEY'},baseUrl:'https://speech.test/v1'}}}}));await writeFile(join(root,'.env'),'SPEECH_TEST_KEY=fixture-key\n');
 return {root,options:{instanceId:'test',dataDir:root,speech:enablePlatformSpeech({provider:'clawling',providerConfigPath:provider})}};
}
test('official PCM request becomes a playable WAV even if its first bytes resemble MPEG; concurrent/restarted requests reuse the receipt',async t=>{
 const f=await fixture(t),pcm=Buffer.from([255,255,20,0,30,0,40,0]);let calls=0;
 delete f.options.speech.voice;
 const fetcher=async(url,init)=>{calls++;assert.equal(url,'https://speech.test/v1/audio/speech');assert.equal(init.headers.authorization,'Bearer fixture-key');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{model:'qwen-audio-3.0-tts-flash',voice:initialVoice,input:'你好',response_format:'pcm',stream_format:'audio',sample_rate:22050,extra:{qwen:{sample_rate:22050}}});return new Response(pcm,{headers:{'content-type':'audio/pcm'}});};
 const client=createSpeechClient(f.options,fetcher),[a,b]=await Promise.all([client.synthesize('你好','same'),client.synthesize('你好','same')]);assert.deepEqual(a,b);assert.equal(calls,1);
 const wav=parseWav(await readFile(a.path));assert.equal(wav.rate,22050);assert.equal(wav.channels,1);assert.deepEqual(wav.data,pcm);
 assert.deepEqual(await createSpeechClient(f.options,fetcher).synthesize('你好','same'),a);assert.equal(calls,1);
 await assert.rejects(client.synthesize('不同内容','same'),/冲突/);
 await writeFile(a.path,Buffer.alloc(a.size));await assert.rejects(client.synthesize('你好','same'),/发生变化/);assert.equal(calls,1);
});
test('ASR uses the official multipart fields and existing env credential',async t=>{
 const f=await fixture(t),file=join(f.root,'input.wav');await writeFile(file,Buffer.from('fixture audio'));
 const client=createSpeechClient(f.options,async(url,init)=>{assert.equal(url,'https://speech.test/v1/audio/transcriptions');assert.equal(init.headers.authorization,'Bearer fixture-key');assert.equal(init.body.get('model'),'fun-asr-flash');assert.equal(init.body.get('language'),'zh');assert.equal(init.body.get('file').type,'audio/wav');return Response.json({text:'今天一起看海'});});
 assert.equal(await client.transcribe(file,'audio/wav','input'),'今天一起看海');
});
test('invalid PCM, oversized audio and HTTP failure stay uncertain and never generate twice',async t=>{
 const f=await fixture(t);f.options.media={maxBytesEach:60};let calls=0;
 for(const [id,response]of [['odd',()=>new Response(Buffer.alloc(3),{headers:{'content-type':'audio/pcm'}})],['large',()=>new Response(Buffer.alloc(32),{headers:{'content-type':'audio/pcm'}})],['http',()=>Response.json({error:{type:'bad_voice'}},{status:503})],['json',()=>Response.json({oops:true})]]){
  const client=createSpeechClient(f.options,async()=>{calls++;return response();});await assert.rejects(client.synthesize('测试',id));const count=calls;await assert.rejects(client.synthesize('测试',id),/不确定/);assert.equal(calls,count);
 }
 assert.equal(calls,4);
});
test('voice tool is manual-only and uses a stable synthesis/delivery identity',async t=>{
 const f=await fixture(t);const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'chat'};let syntheses=0,sends=0;const ids=[];
 const [tool]=voiceTools(f.options,route,'session',{speech:{synthesize:async(text,id)=>{syntheses++;ids.push(id);return {path:'/controlled.wav',duration:1000,model:'tts',voice:'voice'};}},sender:{send:async p=>{sends++;assert.equal(p.requestId,ids.at(-1));return {state:'confirmed',messageId:'ack'};}}});
 const ctx=kind=>({callId:'call',agent:{session:{seq:1,eventAt:n=>n===1?{type:'assistant/message',data:{message:{id:'message',content:[{type:'tool-call',id:'call'}]}}}:{type:'user/message',data:{source:{kind}}}}}});
 const blocked=await tool.execute({text:'你好'},ctx('schedule'));assert.match(JSON.stringify(blocked),/后台/);assert.equal(syntheses,0);assert.equal(sends,0);
 await tool.execute({text:'你好'},ctx('user'));await tool.execute({text:'你好'},ctx('user'));assert.equal(ids[0],ids[1]);
});
test('speech enablement keeps explicit settings and avoids the unverified placeholder voice',()=>{
 const next=enablePlatformSpeech({provider:'clawling',ttsModel:'',voice:'Cherry',providerConfigPath:'/private/provider.json'});assert.equal(next.voice,initialVoice);assert.equal(next.responseFormat,'pcm');assert.equal(next.providerConfigPath,'/private/provider.json');
 const old={provider:'clawling',ttsModel:'chosen-model',voice:'chosen-voice',responseFormat:'wav',sampleRate:24000};assert.equal(enablePlatformSpeech(old).voice,'chosen-voice');assert.equal(enablePlatformSpeech(old).responseFormat,'wav');assert.equal(old.voice,'chosen-voice');assert.throws(()=>enablePlatformSpeech({provider:'other'}),/differs/);
});

test('verified emotion keeps the speaker, preserves plain text identity and never rebills after mood changes or restart',async t=>{
 const f=await fixture(t),bodies=[],pcm=Buffer.from([1,0,2,0,3,0,4,0]);
 f.options.speech.voice='longanfengyue';
 const fetcher=async(_url,init)=>{bodies.push(JSON.parse(init.body));return new Response(pcm,{headers:{'content-type':'audio/pcm'}});};
 const client=createSpeechClient(f.options,fetcher);
 const excited=await client.synthesize('你回来啦','excited',{emotion:'excited'});
 assert.equal(bodies[0].input,'[excited]你回来啦');assert.equal(bodies[0].voice,'longanfengyue');assert.equal(excited.emotion,'excited');
 assert.deepEqual(await createSpeechClient(f.options,fetcher).synthesize('你回来啦','excited'),excited);
 const plain=await client.synthesize('你回来啦','plain');
 assert.deepEqual(await client.synthesize('你回来啦','plain',{emotion:'excited'}),plain);assert.equal(bodies.length,2);
 await client.synthesize('[excited]你回来啦','prefixed',{emotion:'excited'});assert.equal(bodies.at(-1).input,'[excited]你回来啦');
 const sad=await client.synthesize('你回来啦','sad',{emotion:'sad'});assert.equal(bodies.at(-1).input,'[sad]你回来啦');assert.equal(sad.emotion,'sad');assert.equal(sad.voice,excited.voice);
 const count=bodies.length;assert.deepEqual(await createSpeechClient(f.options,fetcher).synthesize('你回来啦','sad',{emotion:'excited'}),sad);assert.equal(bodies.length,count);
 await client.synthesize('[sad]你回来啦','sad-prefixed',{emotion:'sad'});assert.equal(bodies.at(-1).input,'[sad]你回来啦');
 await client.synthesize('你回来啦','other-voice',{emotion:'excited',voice:'unverified'});assert.equal(bodies.at(-1).input,'你回来啦');
 const other=createSpeechClient({...f.options,speech:{...f.options.speech,ttsModel:'another-model'}},fetcher);
 await other.synthesize('你回来啦','other-model',{emotion:'excited'});assert.equal(bodies.at(-1).input,'你回来啦');
 await client.synthesize('你回来啦','other-emotion',{emotion:'angry'});assert.equal(bodies.at(-1).input,'你回来啦');
 await client.synthesize('你'.repeat(2000),'max-length',{emotion:'excited'});assert.equal(bodies.at(-1).input.length,2000);
 await client.synthesize('你'.repeat(1995),'sad-max-length',{emotion:'sad'});assert.equal(bodies.at(-1).input.length,2000);assert.ok(bodies.at(-1).input.startsWith('[sad]'));
 let failures=0;const failed=createSpeechClient(f.options,async()=>{failures++;throw Error('unknown');});
 await assert.rejects(failed.synthesize('不重试','unknown-emotion',{emotion:'excited'}),/unknown/);
 await assert.rejects(failed.synthesize('不重试','unknown-emotion'),/不确定/);assert.equal(failures,1);
});
