import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {createVoiceAdapter} from '../src/voice-adapter.mjs';
import {defaultPlatformVoice} from '../src/speech.mjs';
import {createExpressionSettings} from '../src/expression-settings.mjs';
import {selectReplyItems} from '../src/aurabot-expression.generated.mjs';
import {enablePlatformSpeech,protectVoiceRollback} from '../src/runtime-upgrade.mjs';

const dottedVoice = 'qwen-audio-3.0-tts-flash-fixture';
const exec=(id,kind='user')=>({callId:id,agent:{session:{seq:1,eventAt:n=>n===1?{type:'assistant/message',data:{message:{id:'message-'+id,content:[{type:'tool-call',id}]}}}:{type:'user/message',data:{source:{kind}}}}}});
async function fixture(t,voice){
 const root=await mkdtemp(join(tmpdir(),'whalenest-shared-voice-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'provider.json');await writeFile(path,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture',baseUrl:'https://fixture.test/v1'}}}}));
 const options={instanceId:'one',dataDir:root,expressions:{enabled:true},speech:enablePlatformSpeech({providerConfigPath:path})};
 if(voice)options.speech.voice=voice;
 let cfg=normalize({});
 const calls=[],wav=await readFile(new URL('fixtures/media/audio.wav',import.meta.url));
 const deps={getConfig:()=>cfg,setConfig:value=>{cfg=normalize(value);},getNative:()=>null,expressionSettings:createExpressionSettings(options,cfg),policy:{status:()=>({settings:{paused:false}})},
  fetchImpl:async(url,init)=>{calls.push({url,body:init.body});if(url.endsWith('transcriptions'))return Response.json({text:'来自真实音频的测试转写'});
   if(JSON.parse(init.body).voice==='invalid')return Response.json({error:{code:'bad_voice'}},{status:400});return new Response(wav,{headers:{'content-type':'audio/wav'}});}};
 const adapter=createVoiceAdapter({},options,deps);
 const module=adapter.module().setup({core:{local:{active(){throw Error('Must not use local TTS');}}},config:deps.getConfig,use:()=>null,dataDir:root,log(){},route(){},onDispose(){}});
 return {root,options,deps,adapter,module,calls,wav,getConfig:deps.getConfig};
}
test('original voice.speak uses one platform backend and voice; updates affect only new requests across restart',async t=>{
 const f=await fixture(t);const old=await f.module.speak('你好',{requestId:'old'});assert.equal(old.engine,'platform');assert.equal(old.voice,defaultPlatformVoice);
 const changed=await f.adapter.tool().execute({action:'update',voice:dottedVoice},exec('change'));assert.equal(changed.ok,true);assert.equal(f.getConfig().voice.platformVoice,dottedVoice);
 const next=await f.module.speak('你好',{requestId:'next'});assert.equal(next.voice,dottedVoice);
 const restarted=createVoiceAdapter({},f.options,f.deps);assert.equal((await restarted.speak('你好',{requestId:'old'})).voice,defaultPlatformVoice);
 assert.equal((await restarted.speak('你好',{requestId:'next'})).voice,dottedVoice);assert.equal(f.calls.length,3);
 await restarted.tool().execute({action:'update',voice:'invalid'},exec('bad'));assert.equal(f.getConfig().voice.platformVoice,dottedVoice);
 await restarted.tool().execute({action:'update',voice:'invalid'},exec('bad'));assert.equal(f.calls.length,4,'An unknown paid check is not retried');
 const blocked=await restarted.tool().execute({action:'update',voice:'x'},exec('background','schedule'));assert.match(JSON.stringify(blocked),/后台/);assert.equal(f.calls.length,4);
});
test('QQ ASR uses gateway decoding then the shared platform once; replay, restart and uncertainty do not bill twice',async t=>{
 const f=await fixture(t);let decodes=0;const onebot={call:async(action,params)=>{assert.equal(action,'get_record');assert.equal(params.out_format,'wav');decodes++;return {base64:f.wav.toString('base64')};}};
 const msg={chatId:'private:1',messageId:21,records:[{type:'record',data:{file:'voice.silk'}}]};
 assert.equal(await f.adapter.ports.transcribe(msg,onebot),'来自真实音频的测试转写');
 assert.equal(await createVoiceAdapter({},f.options,f.deps).ports.transcribe(msg,onebot),'来自真实音频的测试转写');assert.equal(decodes,1);assert.equal(f.calls.length,1);
 const bad={...msg,messageId:22};await assert.rejects(f.adapter.ports.transcribe(bad,{call:async()=>{throw Error('uncertain');}}));
 await assert.rejects(f.adapter.ports.transcribe(bad,onebot),/不确定/);assert.equal(decodes,1);
});
test('QQ stable voice delivery retains confirmed/unknown receipts and original voice after preference changes',async t=>{
 const f=await fixture(t);let sends=0;
 const perform=adapter=>adapter.ports.runDelivery('private:1',{operationId:'session:42'},async()=>{
  const request=adapter.ports.request('private:1','你好');const voice=await adapter.speak('你好',request);
  const result=await adapter.ports.send('private:1','你好',async()=>{sends++;return {message_id:'real-mock-ack'};});return {voice,result};});
 const a=await perform(f.adapter);await f.adapter.tool().execute({action:'update',voice:'second'},exec('second'));
 const b=await perform(createVoiceAdapter({},f.options,f.deps));assert.equal(b.voice.voice,a.voice.voice);assert.equal(b.result.replayed,true);assert.equal(sends,1);assert.equal(f.calls.length,2);
 const unknown=()=>f.adapter.ports.runDelivery('private:1',{operationId:'session:43'},()=>f.adapter.ports.send('private:1','未知',async()=>{sends++;throw Error('timeout');}));
 await assert.rejects(unknown(),/timeout/);await assert.rejects(unknown(),/不确定/);assert.equal(sends,2);
});
test('both channels use the original selector and one expression file; explicit voice survives default text',async t=>{
 const f=await fixture(t),settings=f.deps.expressionSettings,cfg=f.getConfig();settings.configure({voiceEnabled:false,stickerChance:0});
 const args={cfg,mood:()=>({voice:1,sticker:1}),stickers:{pickForReply:()=>null},opts:{},random:()=>0};
 assert.equal(selectReplyItems([{kind:'text',value:'你好'}],{...args,cfg:settings.project(cfg)})[0].kind,'text');
 assert.equal(selectReplyItems([{kind:'text',value:'你好'}],{...args,cfg:settings.project(cfg),opts:{wantVoice:true}})[0].kind,'voice');
 assert.equal(selectReplyItems([{kind:'voice',value:'你好'}],{...args,opts:{wantVoice:true,userText:'只用文字回复'}})[0].kind,'text');
 settings.configure({voiceEnabled:true,voiceChance:0.15});
 const selected=f.adapter.ports.runDelivery('private:1',{operationId:'stable-choice'},()=>f.adapter.ports.select([{kind:'text',value:'你好'}],{...args,chatId:'private:1',random:()=>0.17,mood:()=>({voice:2,sticker:1})}));
 assert.equal((await selected)[0].kind,'voice');
 assert.equal((await f.adapter.ports.runDelivery('private:1',{operationId:'stable-choice'},()=>f.adapter.ports.select([{kind:'text',value:'你好'}],{...args,chatId:'private:1',random:()=>1})))[0].kind,'voice');
 assert.equal(createExpressionSettings(f.options,cfg).read().voiceChance,0.15);
});
test('rollback preserves the chosen voice/receipts and stops older QQ desktop TTS; forward build keeps the port',()=>{
 const native={voice:{platformVoice:'new-voice',engine:'http'},modules:{voice:{enabled:true}}},instance={speech:{enabled:true,voice:'old'}};
 assert.equal(protectVoiceRollback(native,instance,'0.3.0-whalenest.m3.16').disableNativeVoice,false);
 assert.equal(native.modules.voice.enabled,true);
 const result=protectVoiceRollback(native,instance,'0.3.0-whalenest.m3.15');assert.equal(result.receiptsPreserved,true);assert.equal(native.modules.voice.enabled,false);assert.equal(instance.speech.voice,'new-voice');assert.equal(native.voice.engine,'http');
});

test('ClawChat and QQ share original mood-driven speech; disabled mood and other voices stay plain',async t=>{
 const f=await fixture(t,'longanfengyue');let label='超开心';
 f.deps.setConfig({...f.getConfig(),mood:{...f.getConfig().mood,enabled:true}});
 f.deps.getNative=()=>({modules:{use:id=>{assert.equal(id,'mood');return {label:()=>label};}}});
 const adapter=createVoiceAdapter({},f.options,f.deps);
 const module=adapter.module().setup({core:{local:{active(){throw Error('No local TTS');}}},config:f.deps.getConfig,use:()=>null,dataDir:f.root,log(){},route(){},onDispose(){}});
 const cc=await module.speak('你回来啦',{requestId:'clawchat-emotion'});
 await adapter.ports.runDelivery('private:1',{operationId:'qq-emotion'},()=>module.speak('你回来啦',adapter.ports.request('private:1','你回来啦')));
 assert.deepEqual(f.calls.map(x=>JSON.parse(x.body).input),['[excited]你回来啦','[excited]你回来啦']);
 assert.ok(f.calls.every(x=>JSON.parse(x.body).voice==='longanfengyue'));assert.equal(cc.emotion,'excited');
 label='有点低落';assert.deepEqual(await module.speak('你回来啦',{requestId:'clawchat-emotion'}),cc);assert.equal(f.calls.length,2);
 await module.speak('你回来啦',{requestId:'low'});assert.equal(JSON.parse(f.calls.at(-1).body).input,'[sad]你回来啦');
 for(const [mood,tag] of [['心情不错','[excited]'],['平平常常',''],['不太开心','[sad]']]){
  label=mood;await module.speak('你回来啦',{requestId:'mood-'+mood});assert.equal(JSON.parse(f.calls.at(-1).body).input,tag+'你回来啦');
 }
 label='超开心';f.deps.setConfig({...f.getConfig(),mood:{...f.getConfig().mood,enabled:false}});
 await module.speak('你回来啦',{requestId:'disabled'});assert.equal(JSON.parse(f.calls.at(-1).body).input,'你回来啦');
 f.deps.setConfig({...f.getConfig(),mood:{...f.getConfig().mood,enabled:true},voice:{...f.getConfig().voice,platformVoice:'other-voice'}});
 await module.speak('你回来啦',{requestId:'new-voice'});assert.equal(JSON.parse(f.calls.at(-1).body).input,'你回来啦');assert.equal(JSON.parse(f.calls.at(-1).body).voice,'other-voice');
});
