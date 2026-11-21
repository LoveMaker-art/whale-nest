import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareRuntimeInput,sniffMedia} from '../src/media.mjs';
import {createSpeechClient} from '../src/speech.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';

const wav=await readFile(new URL('./fixtures/media/audio.wav',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');
 await writeFile(provider,JSON.stringify({models:{providers:{test:{apiKey:'private-key',baseUrl:'https://speech.test/v1/'}}}}));
 const options={dataDir:root,speech:{enabled:true,provider:'test',providerConfigPath:provider,asrModel:'asr',ttsModel:'tts',voice:'Cherry'}};
 const path=join(root,'voice.wav');await writeFile(path,wav);
 return {root,path,options,context:{bindingId:'agent',chatId:'owner-chat',sessionId:'session',cacheMedia:async()=>path}};
}
test('mixed media preserves prompt, caches transcripts and rejects duplicate-id mutation',async t=>{
 const f=await fixture(t);let calls=0;
 const input={turnId:'turn',prompt:'身份前缀\n原用户问题',media:[{kind:'audio',name:'../voice.wav',size:wav.length,mime:'audio/wav'}]};
 const speech={transcribe:async()=>{calls++;return '明天一起看海';}};
 const [first,second]=await Promise.all([prepareRuntimeInput(input,f.context,f.options,speech),prepareRuntimeInput(input,f.context,f.options,speech)]);
 assert.equal(calls,1);assert.equal(first.prompt,second.prompt);assert.ok(first.prompt.startsWith(input.prompt+'\n\n'));
 assert.match(first.prompt,/转写：\n明天一起看海/);assert.deepEqual(first.media,[]);
 const replay=await prepareRuntimeInput(input,f.context,f.options,{transcribe:()=>{throw Error('must not bill');}});
 assert.equal(replay.prompt,first.prompt);
 await assert.rejects(prepareRuntimeInput({...input,prompt:'other'},f.context,f.options,speech),/冲突/);
 const png=await readFile(new URL('./fixtures/media/image.png',import.meta.url));const image=join(f.root,'a.png');await writeFile(image,png);
 const result=await prepareRuntimeInput({turnId:'images',prompt:'图',media:[{kind:'image',mime:'image/png'}]}, {...f.context,cacheMedia:async()=>image},f.options,speech);
 assert.equal(result.media[0].kind,'image');
});
test('media checks content and limits, holds ambiguous ASR across restart',async t=>{
 const f=await fixture(t);
 await assert.rejects(prepareRuntimeInput({turnId:'wrong-kind',media:[{kind:'image'}]},f.context,f.options,{}),/类型/);
 await assert.rejects(prepareRuntimeInput({turnId:'too-large',media:[{kind:'file',size:99999999}]},f.context,f.options,{}),/大小/);
 let calls=0;const input={turnId:'uncertain',media:[{kind:'audio'}]};
 const speech={transcribe:async()=>{calls++;throw Error('lost response');}};
 const first=await prepareRuntimeInput(input,f.context,f.options,speech);assert.match(first.prompt,/未完成转写/);
 assert.equal((await prepareRuntimeInput(input,f.context,f.options,speech)).prompt,first.prompt);assert.equal(calls,1);
 assert.equal(sniffMedia(Buffer.from('%PDF-1.0'),'image/png'),'application/pdf');
});
test('speech uses private route, durable idempotency, correct format and bounded response',async t=>{
 const f=await fixture(t);let calls=0;
 const client=createSpeechClient(f.options,async(url,init)=>{
  calls++;assert.equal(url,'https://speech.test/v1/audio/speech');assert.equal(init.headers.authorization,'Bearer private-key');
  assert.ok(init.headers['Idempotency-Key']);return new Response(wav,{headers:{'content-type':'audio/wav'}});
 });
 const result=await client.synthesize('你好','req1');assert.equal(result.mime,'audio/wav');assert.equal(result.state,'generated');
 assert.deepEqual(await readFile(result.path),wav);
 assert.deepEqual(await client.synthesize('你好','req1'),result);assert.equal(calls,1);
 await assert.rejects(client.synthesize('修改内容','req1'),/冲突/);
 const bad=createSpeechClient(f.options,async()=>{calls++;return new Response('bad',{status:503});});
 await assert.rejects(bad.synthesize('失败','req2'),/503/);
 await assert.rejects(bad.synthesize('失败','req2'),/不确定/);assert.equal(calls,2);
});
test('runtime wrapper reuses lifecycle and rejects untrusted route before caching',async t=>{
 const f=await fixture(t);const {mkdir}=await import('node:fs/promises');
 await mkdir(join(f.root,'companion/aurabot-v1'),{recursive:true});
 await writeFile(join(f.root,'companion/aurabot-v1/instance.json'),JSON.stringify({...f.options,clawchat:{route:{account:'agent',conversation:'owner-chat'}}}));
 let registered,prompted=0,closed=0;
 const base={activate:async ctx=>ctx.hostCapabilities.get('runtime-provider').register({create:()=>({listModels:async()=>[{id:'same-model',inputModalities:['text']}],start:async()=>({async *prompt(input){prompted++;yield input;},close:async()=>{closed++;}})})})};
 await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:p=>{registered=p;}})}});
 const adapter=registered.create({homePath:f.root},{});assert.equal((await adapter.listModels())[0].id,'same-model');
 const good=await adapter.start(f.context);assert.equal((await Array.fromAsync(good.prompt({prompt:'hi'})))[0].prompt,'hi');
 const evil=await adapter.start({...f.context,chatId:'other',cacheMedia:()=>{throw Error('must not fetch');}});
 await assert.rejects(Array.fromAsync(evil.prompt({turnId:'bad',media:[{kind:'audio'}]})),/会话来源/);
 assert.equal(prompted,1);await good.close();assert.equal(closed,1);
});

test('attachment reception does not require an enabled ASR backend',async t=>{
 const f=await fixture(t);f.options.speech.enabled=false;
 const document=join(f.root,'document.txt'),video=join(f.root,'container.mp4'),gif=join(f.root,'image.gif');
 await writeFile(document,'M2 attachment');
 await writeFile(video,await readFile(new URL('./fixtures/media/video.mp4',import.meta.url)));
 await writeFile(gif,await readFile(new URL('./fixtures/media/animation.gif',import.meta.url)));
 const paths=new Map([['audio',f.path],['file',document],['video',video],['gif',gif]]);
 const input={turnId:'attachments',prompt:'平台身份前缀\n看看这些附件',media:[
  {kind:'audio',url:'audio',name:'audio.wav'},
  {kind:'file',url:'file',name:'document.txt',mime:'text/plain'},
  {kind:'video',url:'video',name:'container.mp4'},
  {kind:'image',url:'gif',name:'image.gif'},
 ]};
 let calls=0;
 const result=await prepareRuntimeInput(input,{...f.context,cacheMedia:async m=>paths.get(m.url)},f.options,{transcribe:async()=>{calls++;throw Error('ASR must not be called');}});
 assert.equal(calls,0);assert.equal(result.media.length,1);assert.equal(result.media[0].mime,'image/gif');
 assert.ok(result.prompt.startsWith(input.prompt));assert.match(result.prompt,/未启用转写/);
 const {readdir}=await import('node:fs/promises');
 const directories=await readdir(join(f.root,'media/incoming'));
 const receipt=JSON.parse(await readFile(join(f.root,'media/incoming',directories[0],'input.json')));
 assert.equal(receipt.files.length,4);assert.equal(receipt.state,'completed');
 for(const file of receipt.files)assert.deepEqual(await readFile(file.path),await readFile(paths.get(input.media.find(m=>m.name===file.name).url)));
 assert.equal((await prepareRuntimeInput(input,{...f.context,cacheMedia:()=>{throw Error('cached input must be reused');}},f.options,{})).prompt,result.prompt);
});
test('completed input rejects a same-size change to a preserved attachment',async t=>{
 const f=await fixture(t),input={turnId:'integrity',media:[{kind:'audio',name:'voice.wav'}]};
 await prepareRuntimeInput(input,f.context,f.options,{transcribe:async()=>'测试语音'});
 const {readdir}=await import('node:fs/promises');const entries=await readdir(join(f.root,'media/incoming'));
 const receipt=JSON.parse(await readFile(join(f.root,'media/incoming',entries[0],'input.json')));
 await writeFile(receipt.files[0].path,Buffer.alloc(wav.length,42));
 await assert.rejects(prepareRuntimeInput(input,f.context,f.options,{}),/已接收附件发生变化/);
});
