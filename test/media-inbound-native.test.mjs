import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {buildRuntimeBase} from '../scripts/build-runtime-base.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {mp4Fixture} from './mp4-helper.mjs';

test('real Runtime Adapter and native DSH receive five attachment types and generic-brand M4A, deduplicate and recover after rejection',{timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.options.speech={enabled:false};
 await writeFile(dir.configPath,JSON.stringify(dir.options));
 const instance=join(dir.options.home,'companion/aurabot-v1');await mkdir(instance,{recursive:true});await writeFile(join(instance,'instance.json'),JSON.stringify(dir.options));
 const names=['image.png','animation.gif','audio.wav','document.txt','video.mp4'];
 for(const name of names)await copyFile(resolve('test/fixtures/media',name),join(dir.root,name));
 await writeFile(join(dir.root,'voice.m4a'),mp4Fixture());names.push('voice.m4a');
 const {createDeepSeekHarnessOfficialPluginEntry}=await import(pathToFileURL(await buildRuntimeBase(join(dir.root,'runtime'))));
 const bridge=await bootBridge(dir);t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});
 let provider;
 const base=createDeepSeekHarnessOfficialPluginEntry({runtimeAdapter:{probeExecutable:()=>({path:process.execPath}),createBridge:async()=>bridge}});
 await extendRuntimeEntry(base).activate({installationConfiguration:{},hostCapabilities:{get:()=>({register:p=>{provider=p;}})}});
 const adapter=provider.create({homePath:dir.options.home,profile:'whalenest'},{});t.after(()=>adapter.close());
 const models=await adapter.listModels();assert.ok(Array.isArray(models));
 let runtimeId,caches=0;
 const session=await adapter.start({bindingId:'agent',chatId:'dm-alice',sessionId:'original-chat',onRuntimeThreadId:id=>{runtimeId=id;},cacheMedia:async(m,origins)=>{caches++;assert.deepEqual(origins,['https://media.fixture']);return join(dir.root,m.name);}});
 const common={workspace:{workingDirectory:dir.root},model:dir.options.model,trustedMediaOrigins:['https://media.fixture']};
 const inputs=names.map((name,i)=>({...common,turnId:'native-inbound-'+i,prompt:'收到附件请回复。',media:[{kind:i<2?'image':i===2||i===5?'audio':i===3?'file':'video',name,url:'https://media.fixture/'+name,...(i===3?{mime:'text/plain'}:i===5?{mime:'audio/mp4'}:{})}]}));
 for(const input of inputs){const result=await Array.fromAsync(session.prompt(input));assert.ok(result.length>0);}
 const history=await bridge.request('history',{sessionId:runtimeId});
 const received=events=>events.filter(e=>e.type==='user/message' && (e.data.source?.connectInputId?.startsWith('native-inbound-') || e.data.source?.connectInputId==='after-invalid'));
 const messages=received(history.events);assert.equal(messages.length,6);
 for(const [i,message]of messages.entries())assert.match(JSON.stringify(message.data.content),new RegExp(names[i].replaceAll('.','\\.')));
 assert.match(JSON.stringify(messages[0].data.content),/当前模型.*图片/);
 assert.match(JSON.stringify(messages[2].data.content),/未启用转写/);
 assert.match(JSON.stringify(messages[5].data.content),/未启用转写/);
 const originalText=messages[0].data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
 await bridge.request('prompt',{sessionId:runtimeId,inputId:inputs[0].turnId,text:originalText});assert.equal(caches,6);
 assert.equal(received((await bridge.request('history',{sessionId:runtimeId})).events).length,6);
 await assert.rejects(Array.fromAsync(session.prompt({...common,turnId:'bad-kind',media:[{kind:'image',name:'audio.wav',url:'https://media.fixture/audio.wav'}]})),/类型/);
 await Array.fromAsync(session.prompt({...common,turnId:'after-invalid',prompt:'继续聊天'}));
 assert.equal(received((await bridge.request('history',{sessionId:runtimeId})).events).length,7);
 const receipts=await readdir(join(dir.options.dataDir,'media/incoming'));let completed=0;
 for(const key of receipts){const receipt=JSON.parse(await readFile(join(dir.options.dataDir,'media/incoming',key,'input.json')));if(receipt.state==='completed')completed++;}
 assert.equal(completed,6);await session.close();
});
