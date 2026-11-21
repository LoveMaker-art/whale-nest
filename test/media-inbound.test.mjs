import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareRuntimeInput} from '../src/media.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {hash} from '../src/routing.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-inbound-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={dataDir:root,speech:{enabled:true,asrModel:'existing-asr'},clawchat:{route:{account:'dsh',conversation:'owner-chat'}}};
 await mkdir(join(root,'companion/aurabot-v1'),{recursive:true});
 await writeFile(join(root,'companion/aurabot-v1/instance.json'),JSON.stringify(options));
 const context={bindingId:'dsh',chatId:'owner-chat',sessionId:'same-session',cacheMedia:async media=>join(root,media.name)};
 for(const name of ['audio.wav','image.png','document.txt','video.mp4'])await writeFile(join(root,name),await readFile(new URL('./fixtures/media/'+name,import.meta.url)));
 return {root,options,context};
}
test('an unavailable optional ASR does not block receipt or rebill a repeated audio turn',async t=>{
 const f=await fixture(t);let calls=0;
 const input={turnId:'asr-down',prompt:'身份前缀\n收到请回复',media:[{kind:'audio',name:'audio.wav'}]};
 const speech={transcribe:async()=>{calls++;throw Error('HTTP 503');}};
 const first=await prepareRuntimeInput(input,f.context,f.options,speech);
 assert.ok(first.prompt.startsWith(input.prompt));assert.match(first.prompt,/未完成转写/);assert.deepEqual(first.media,[]);
 const again=await prepareRuntimeInput(input,f.context,f.options,speech);assert.equal(again.prompt,first.prompt);assert.equal(calls,1);
 const dirs=await readdir(join(f.root,'media/incoming'));
 const receipt=JSON.parse(await readFile(join(f.root,'media/incoming',dirs[0],'input.json')));
 assert.equal(receipt.state,'completed');assert.equal(receipt.files.length,1);
 assert.equal(receipt.transcription[0].state,'uncertain');
});
test('an interrupted old transcription journal resumes attachment receipt without another ASR call',async t=>{
 const f=await fixture(t),input={turnId:'interrupted',prompt:'语音',media:[{kind:'audio',name:'audio.wav'},{kind:'file',name:'document.txt',mime:'text/plain'}]};
 const key=hash([f.context.bindingId,f.context.chatId,f.context.sessionId,input.turnId]);
 const directory=join(f.root,'media/incoming',key);await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'input.json'),JSON.stringify({state:'transcribing',fingerprint:hash({text:input.prompt,media:input.media}),files:[{kind:'audio'}],images:[],transcripts:{}}));
 let calls=0;const result=await prepareRuntimeInput(input,f.context,f.options,{transcribe:async()=>{calls++;throw Error('must not retry');}});
 assert.equal(calls,0);assert.match(result.prompt,/未完成转写/);assert.match(result.prompt,/document.txt/);
 const receipt=JSON.parse(await readFile(join(directory,'input.json')));assert.equal(receipt.state,'completed');assert.equal(receipt.files.length,2);
});
async function adapter(f,models){
 let provider;
 const base={activate:async ctx=>ctx.hostCapabilities.get('runtime-provider').register({create:()=>({listModels:async()=>structuredClone(models),start:async()=>({async *prompt(input){yield input;},close:async()=>{}})})})};
 await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:p=>{provider=p;}})}});
 return provider.create({homePath:f.root},{});
}
test('the runtime advertises attachment receipt but keeps text-only models free of image input',async t=>{
 const f=await fixture(t),models=[{id:'provider:text',selection:{provider:'provider',model:'text'},isDefault:true,inputModalities:['text'],turnSubmissionCapability:{prompt:{allowed:true,required:true},attachments:{allowedKinds:[],allowedMediaTypes:[]}}}];
 const a=await adapter(f,models),catalog=await a.listModels();
 assert.deepEqual(catalog[0].turnSubmissionCapability.attachments.allowedKinds,['image','audio','file','video']);assert.deepEqual(catalog[0].inputModalities,['text']);
 const s=await a.start(f.context);
 const input={turnId:'text-model-image',prompt:'帮我看看',model:models[0].selection,media:[{kind:'image',mime:'image/png',name:'image.png'}]};
 const [result]=await Array.fromAsync(s.prompt(input));assert.deepEqual(result.media,[]);assert.match(result.prompt,/image.png/);assert.match(result.prompt,/当前模型.*图片/);
 const [text]=await Array.fromAsync(s.prompt({turnId:'next-text',prompt:'继续聊天'}));assert.equal(text.prompt,'继续聊天');await s.close();
});
test('verified vision input remains enabled; an unknown model receives only cached attachment metadata',async t=>{
 const f=await fixture(t),models=[{id:'provider:vision',selection:{provider:'provider',model:'vision'},isDefault:true,inputModalities:['text','image'],turnSubmissionCapability:{prompt:{allowed:true,required:true},attachments:{allowedKinds:['image'],allowedMediaTypes:['image/png'],maxCount:1,maxBytesEach:10000,maxBytesTotal:10000}}}];
 const a=await adapter(f,models),s=await a.start(f.context),media=[{kind:'image',mime:'image/png',name:'image.png'}];
 const [vision]=await Array.fromAsync(s.prompt({turnId:'vision',prompt:'看图',model:models[0].selection,media}));assert.equal(vision.media.length,1);
 const [unknown]=await Array.fromAsync(s.prompt({turnId:'unknown',prompt:'看图',model:{provider:'provider',model:'missing'},media}));assert.deepEqual(unknown.media,[]);assert.match(unknown.prompt,/当前模型.*图片/);await s.close();
});
