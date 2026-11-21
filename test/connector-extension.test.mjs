import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {prepareConnectorExtension,extensionHostConfig,coreCommit,verifiedLivewareCompanion} from '../src/connector-extension.mjs';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {createDeepSeekHarnessOfficialPluginEntry} from '../integration/clawchat/base/linux-x64.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {prepareRuntimeInput} from '../src/media.mjs';
import {createSpeechClient} from '../src/speech.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-connector-')),base=join(root,'base');await mkdir(join(base,'runtime'),{recursive:true});
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['official-plugins','skills','updater-skill'])await mkdir(join(base,dir));
 const official='#!/bin/sh\nprintf "native:%s" "$1"\n',patched='#!/bin/sh\nprintf "patched:%s" "$1"\n';
 await writeFile(join(base,'runtime/cli.mjs'),'original wrapper');await writeFile(join(base,'clawchat-connect'),official,{mode:0o755});
 await cp(new URL('../integration/clawchat/core-media/runtime-lib.original.mjs',import.meta.url),join(base,'runtime/lib.mjs'));
 const hash=text=>createHash('sha256').update(text).digest('hex');
 await writeFile(join(base,'source.json'),JSON.stringify({connect_commit:coreCommit}));
 await writeFile(join(base,'integration.json'),JSON.stringify({version:'0.2.10',files:[{path:'clawchat-connect',sha256:hash(official)}]}));
 const binary=join(root,'patched'),manifest=join(root,'build.json'),skillsDirectory=join(root,'packaged-skills');await writeFile(binary,patched);
 await mkdir(skillsDirectory);await writeFile(join(skillsDirectory,'manifest.json'),JSON.stringify({connectVersion:'media-test',files:{}}));
 await writeFile(manifest,JSON.stringify({version:'media-test',upstreamCommit:coreCommit,binarySha256:hash(patched)}));
 return {root,base,official,patched,hash,binary,manifest,skillsDirectory,parameters:{home:root,binary,manifestFile:manifest,baseDirectory:base,skillsDirectory}};
}
test('Local connector extension preserves the verified base and refuses a source mismatch',async t=>{
 const {root,base,official,patched,hash,binary,manifest,skillsDirectory,parameters}=await fixture(t);
 const record=prepareConnectorExtension(parameters);
 assert.equal(await readFile(join(base,'clawchat-connect'),'utf8'),official);assert.equal(await readFile(join(record.directory,'clawchat-connect-core'),'utf8'),patched);
 const existingUpdater=join(root,'existing-updater');await mkdir(existingUpdater);
 await cp(join(record.directory,'updater-skill'),existingUpdater,{recursive:true});
 const wrapper=await readFile(join(record.directory,'clawchat-connect'),'utf8');
 assert.ok(wrapper.includes('__clawnest-state|__clawnest-owner'));assert.ok(wrapper.includes(join(base,'clawchat-connect')));assert.ok(wrapper.includes(join(record.directory,'clawchat-connect-core')));
 for(const command of ['__clawnest-state','__clawnest-owner'])assert.equal(execFileSync(join(record.directory,'clawchat-connect'),[command],{encoding:'utf8'}),'native:'+command);
 assert.equal(execFileSync(join(record.directory,'clawchat-connect'),['--version'],{encoding:'utf8'}),'patched:--version');
 const config=extensionHostConfig({entries:{agent:'runtime/cli.mjs',connect:'clawchat-connect'},host:{id:'pinned'}},record);
 assert.equal(resolve(base,config.entries.agent),join(record.directory,'runtime/cli.mjs'));assert.equal(config.entries.connect,'clawchat-connect');assert.equal(config.host.id,'pinned');
 await writeFile(manifest,JSON.stringify({version:'bad',upstreamCommit:'old',binarySha256:hash(patched)}));
 assert.throws(()=>prepareConnectorExtension({home:root,binary,manifestFile:manifest,baseDirectory:base}),/actual source/);
 await writeFile(manifest,JSON.stringify({version:'media-test',upstreamCommit:coreCommit,binarySha256:hash(patched)}));
 await writeFile(join(skillsDirectory,'manifest.json'),JSON.stringify({connectVersion:'old-version',files:{}}));
 assert.throws(()=>prepareConnectorExtension({home:root,binary,manifestFile:manifest,baseDirectory:base,skillsDirectory}),/skills version/);
});

test('native model conversion preserves explicit image and text declarations without inventing undeclared input',async t=>{
 const {root,base,hash,parameters}=await fixture(t);
 const original=await readFile(join(base,'runtime/lib.mjs'),'utf8');
 const record=prepareConnectorExtension(parameters);
 const directory=join(root,'.clawchat-dsh');await mkdir(directory);
 const config={agents:{defaults:{model:{primary:'clawling/vision'}}},models:{providers:{clawling:{api:'openai-completions',baseUrl:'https://model.invalid/v1',apiKey:'test-provider-key',models:[{id:'vision',input:['text','image'],contextWindow:12000,maxTokens:300},{id:'text',input:['text']},{id:'undeclared'}]}}}};
 const before=JSON.stringify(config);await writeFile(join(directory,'config.json'),before);
 const script=`import {readFileSync} from 'node:fs';
 const {nativeModel,modelPatch}=await import(${JSON.stringify(pathToFileURL(join(record.directory,'runtime/lib.mjs')).href)});
 const native=nativeModel();
 const patch=JSON.parse(readFileSync(modelPatch,'utf8'));
 console.log(JSON.stringify({patch,hasCloudToken:Object.hasOwn(native.env,'CLAWCLOUD_TOKEN'),provider:native.provider,model:native.model}));`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,HOME:root,CLAWCLOUD_TOKEN:'fixture-cloud-secret'}}));
 const provider=result.patch.find(x=>x.id==='llm-pi-ai').config.providers.clawling;
 assert.deepEqual(provider.models[0].input,['text','image']);assert.deepEqual(provider.models[1].input,['text']);assert.equal(Object.hasOwn(provider.models[2],'input'),false);
 assert.equal(provider.models[0].contextWindow,12000);assert.equal(provider.models[0].maxTokens,300);
 assert.equal(provider.baseURL,config.models.providers.clawling.baseUrl);assert.equal(provider.api,'openai-completions');assert.equal(Object.hasOwn(provider,'apiKey'),false);
 assert.deepEqual([result.provider,result.model],['clawling','vision']);assert.equal(result.hasCloudToken,false);
 assert.equal(await readFile(join(directory,'config.json'),'utf8'),before);assert.equal(await readFile(join(base,'runtime/lib.mjs'),'utf8'),original);
 assert.equal(hash(await readFile(join(record.directory,'runtime/lib.mjs'),'utf8')),record.runtimeLibSha256);
 assert.equal(prepareConnectorExtension(parameters).directory,record.directory);
 await writeFile(join(record.directory,'runtime/lib.mjs'),'changed installed runtime');
 assert.throws(()=>prepareConnectorExtension(parameters),/runtime.*integrity/i);
});

test('an unreviewed upstream runtime is refused before staging an extension',async t=>{
 const {root,base,parameters}=await fixture(t);
 await writeFile(join(base,'runtime/lib.mjs'),'changed upstream runtime');
 assert.throws(()=>prepareConnectorExtension(parameters),/runtime.*source/i);
 await assert.rejects(stat(join(root,'.local/share/whale-nest/connectors')),e=>e.code==='ENOENT');
});

test('native DSH exposes corrected modalities and the Runtime Adapter forwards image data and cached ASR text',{timeout:90000},async t=>{
 const {parameters}=await fixture(t),record=prepareConnectorExtension({...parameters,voice:true}),dir=await bridgeDirectory();
 let bridge,adapter,session,runtimeId;
 const calls={asr:0,chat:[]},failures=[];
 const server=createServer(async(req,res)=>{
  try{
   let body='';for await(const part of req)body+=part.toString('utf8');
   assert.equal(req.headers.authorization,'Bearer test-provider-key');
   if(req.url==='/v1/audio/transcriptions'){
    calls.asr++;assert.match(body,/name="model"\r\n\r\nfun-asr-flash/);assert.match(body,/name="file"/);assert.match(req.headers['idempotency-key'],/^whalenest-asr-/);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({text:'蓝色灯塔在海边'}));return;
   }
   assert.equal(req.url,'/v1/chat/completions');const input=JSON.parse(body);calls.chat.push(input);
   const chunk=(delta,finish_reason)=>({id:'fixture-completion',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]});
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end('data: '+JSON.stringify(chunk({role:'assistant',content:'已收到测试附件。'},null))+'\n\ndata: '+JSON.stringify(chunk({},'stop'))+'\n\ndata: [DONE]\n\n');
  }catch(error){failures.push(error);res.writeHead(500);res.end('fixture-request-failed');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await session?.close();await adapter?.close();await bridge?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir.root,{recursive:true,force:true});});
 const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
 const providerFile=join(dir.options.home,'.clawchat-dsh/config.json');await mkdir(join(dir.options.home,'.clawchat-dsh'),{recursive:true});
 await writeFile(providerFile,JSON.stringify({agents:{defaults:{model:{primary:'clawling/vision'}}},models:{providers:{clawling:{api:'openai-completions',baseUrl,apiKey:'test-provider-key',models:[{id:'vision',input:['text','image'],contextWindow:32000,maxTokens:256},{id:'text',input:['text']},{id:'undeclared'},{id:'deepseek-v4.1-flash',reasoning:false}]}}}}));
 const generated=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {readFileSync} from 'node:fs';const {nativeModel,modelPatch}=await import(${JSON.stringify(pathToFileURL(join(record.directory,'runtime/lib.mjs')).href)});nativeModel();console.log(readFileSync(modelPatch,'utf8'));`],{encoding:'utf8',env:{...process.env,HOME:dir.options.home}}));
 const nativeProviders=generated.find(x=>x.id==='llm-pi-ai').config.providers;
 assert.equal(nativeProviders['clawling-voice'].apiKeyEnv,nativeProviders.clawling.apiKeyEnv);
 dir.nativeModelPatch=join(dir.root,'native-model.patch.json');
 await writeFile(dir.nativeModelPatch,JSON.stringify(generated.filter(x=>['llm-pi-ai','agent-default-model'].includes(x.id))));
 dir.nativeModelEnv={[nativeProviders.clawling.apiKeyEnv]:'test-provider-key'};
 dir.options.model={provider:'clawling',model:'vision',maxTokens:256};
 dir.options.speech={enabled:true,provider:'clawling',providerConfigPath:providerFile,asrModel:'fun-asr-flash'};
 await writeFile(dir.configPath,JSON.stringify(dir.options));
 const instance=join(dir.options.home,'companion/aurabot-v1');await mkdir(instance,{recursive:true});await writeFile(join(instance,'instance.json'),JSON.stringify(dir.options));
 for(const name of ['image.png','audio.wav'])await cp(new URL('./fixtures/media/'+name,import.meta.url),join(dir.root,name));
 async function connect(runtimeSessionId=null){
  bridge=await bootBridge(dir);let provider;
  const base=createDeepSeekHarnessOfficialPluginEntry({runtimeAdapter:{probeExecutable:()=>({path:process.execPath}),createBridge:async()=>bridge}});
  await extendRuntimeEntry(base).activate({installationConfiguration:{},hostCapabilities:{get:()=>({register:p=>{provider=p;}})}});
  adapter=provider.create({homePath:dir.options.home,profile:'whalenest'},{});
  session=await adapter.start({bindingId:'agent',chatId:'dm-alice',sessionId:'multimodal-fixture',runtimeThreadId:runtimeSessionId,onRuntimeThreadId:id=>{runtimeId=id;},cacheMedia:async m=>join(dir.root,m.name)});
 }
 await connect();
 const models=await adapter.listModels();const model=id=>models.find(m=>m.selection?.provider==='clawling'&&m.selection?.model===id);
 assert.ok(!models.some(model=>model.selection?.provider==='clawling-voice'));
 assert.deepEqual(model('vision').inputModalities,['text','image']);assert.deepEqual(model('text').inputModalities,['text']);assert.deepEqual(model('undeclared').inputModalities,['text']);
 assert.equal(calls.asr,0);assert.equal(calls.chat.length,0);
 const common={workspace:{workingDirectory:dir.root},model:dir.options.model,trustedMediaOrigins:['https://media.fixture']};
 const image={...common,turnId:'native-vision-input',prompt:'运维自测：检查附件链。',media:[{kind:'image',mime:'image/png',name:'image.png',url:'https://media.fixture/image.png'}]};
 await Array.fromAsync(session.prompt(image));assert.equal(calls.chat.length,1);
 const picture=calls.chat[0].messages.filter(m=>m.role==='user').flatMap(m=>Array.isArray(m.content)?m.content:[]).find(block=>block.type==='image_url');
 assert.match(picture.image_url.url,/^data:image\/png;base64,/);
 const audio={...common,turnId:'native-asr-input',prompt:'运维自测：转写后继续聊天。',media:[{kind:'audio',mime:'audio/wav',name:'audio.wav',url:'https://media.fixture/audio.wav'}]};
 await Array.fromAsync(session.prompt(audio));assert.equal(calls.asr,1);assert.equal(calls.chat.length,2);assert.match(JSON.stringify(calls.chat[1].messages),/蓝色灯塔在海边/);
 const userInputs=events=>events.filter(e=>e.type==='user/message'&&e.data.source?.connectInputId?.startsWith('native-'));
 const before=userInputs((await bridge.request('history',{sessionId:runtimeId})).events);assert.equal(before.length,2);
 await session.close();session=null;await adapter.close();adapter=null;await bridge.close();bridge=null;
 await connect(runtimeId);
 const repeated=await prepareRuntimeInput(audio,{bindingId:'agent',chatId:'dm-alice',sessionId:'multimodal-fixture',cacheMedia:async m=>join(dir.root,m.name)},dir.options,createSpeechClient(dir.options));
 await bridge.request('resume',{sessionId:runtimeId});
 await bridge.request('prompt',{sessionId:runtimeId,inputId:audio.turnId,text:repeated.prompt});
 assert.equal(calls.asr,1,'restarted receipt must not transcribe again');assert.equal(calls.chat.length,2,'replayed input must not call the model again');
 const after=userInputs((await bridge.request('history',{sessionId:runtimeId})).events);assert.equal(after.length,2);
 const voiceSession=await adapter.start({bindingId:'agent',chatId:'dm-alice',sessionId:'voice-test',onRuntimeThreadId() {}});
 try {
  await Array.fromAsync(voiceSession.prompt({...common,turnId:'private-call-effort',prompt:'运维自测：检查通话推理设置。',
    model:{provider:'clawling-voice',model:'deepseek-v4.1-flash'},reasoningEffort:'off'}));
 } finally {await voiceSession.close();}
 assert.equal(calls.chat.at(-1).model,'deepseek-v4.1-flash');
 assert.deepEqual(calls.chat.at(-1).thinking,{type:'disabled'});
 assert.equal(calls.chat[0].thinking,undefined);
 assert.deepEqual(failures,[]);
});

test('calls verify the original Liveware companion without enabling the retired management page',async t=>{
 const f=await fixture(t),asset='official-liveware-test',plugin=join(f.root,'plugins/liveware');await mkdir(join(plugin,'assets'),{recursive:true});await writeFile(join(plugin,'assets/liveware'),asset);
 await mkdir(join(f.root,'.clawchat-connect'),{recursive:true});await writeFile(join(f.root,'.clawchat-connect/plugins.lock.json'),JSON.stringify({plugins:{'clawling.exposure.liveware':{status:'disabled',manifestPath:join(plugin,'connect-plugin.json')}}}));
 const bundle=JSON.stringify({files:{'assets/liveware':{encoding:'utf8',content:asset}}}),bundlePath='official-plugins/clawling.exposure.liveware-test.connect-plugin';await writeFile(join(f.base,bundlePath),bundle);
 const integration=JSON.parse(await readFile(join(f.base,'integration.json')));integration.files.push({path:bundlePath,sha256:f.hash(bundle)});await writeFile(join(f.base,'integration.json'),JSON.stringify(integration));
 const companion=verifiedLivewareCompanion(f.root,f.base);assert.equal(companion.path,join(plugin,'assets/liveware'));
 const record=prepareConnectorExtension({...f.parameters,realtime:true});assert.deepEqual(record.livewareCompanion,companion);assert.match(await readFile(join(record.directory,'clawchat-connect'),'utf8'),/export CLAWCHAT_CONNECT_LIVEWARE_PATH=/);
 assert.equal(JSON.parse(await readFile(join(f.root,'.clawchat-connect/plugins.lock.json'))).plugins['clawling.exposure.liveware'].status,'disabled');
 await writeFile(companion.path,'tampered');assert.throws(()=>verifiedLivewareCompanion(f.root,f.base),/changed/);
});
