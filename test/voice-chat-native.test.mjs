import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {buildRuntimeBase} from '../scripts/build-runtime-base.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {enablePlatformSpeech} from '../src/runtime-upgrade.mjs';
import {startPlatformVoiceLiveware,voiceSessionPort} from '../src/platform-voice-liveware.mjs';
import {connectPlatformVoice} from './platform-voice-client.mjs';
import {defaultPlatformVoice} from '../src/speech.mjs';

test('owner chat selects the shared voice; Liveware only reads it and each call pins its starting voice',{timeout:120000},async t=>{
  const dir=await bridgeDirectory(),voices=[],errors=[];
  let bridge,adapter,session,gateway,call,provider,nativeId,turn=0;
  const model=createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req)body+=chunk;
      assert.equal(req.headers.authorization,'Bearer voice-fixture');
      if(req.url==='/v1/audio/transcriptions'){
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({text:'运维自测：你好呀。'}));
      }else{
        assert.equal(req.url,'/v1/audio/speech');voices.push(JSON.parse(body).voice);
        res.writeHead(200,{'content-type':'audio/pcm'}).end(Buffer.alloc(4000));
      }
    }catch(error){errors.push(error.message);res.writeHead(500).end();}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await call?.close();await gateway?.close();await session?.close();await adapter?.close();await bridge?.close();
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await rm(dir.root,{recursive:true,force:true});
  });
  const providerFile=join(dir.root,'provider.json');
  await writeFile(providerFile,JSON.stringify({models:{providers:{clawling:{apiKey:'voice-fixture',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'}}}}));
  dir.options.speech=enablePlatformSpeech({providerConfigPath:providerFile});
  dir.options.clawchat.delivery.mediaEnabled=true;
  dir.options.realtime={enabled:true,port:0,python:process.env.WHALENEST_TEST_PYTHON};
  await writeFile(dir.configPath,JSON.stringify(dir.options));
  await mkdir(join(dir.options.home,'companion/aurabot-v1'),{recursive:true});
  await writeFile(join(dir.options.home,'companion/aurabot-v1/instance.json'),JSON.stringify(dir.options));
  const route=dir.options.clawchat.route,workspace={workingDirectory:dir.root};
  const base=await import(pathToFileURL(await buildRuntimeBase(join(dir.root,'runtime'))));
  const entry=base.createDeepSeekHarnessOfficialPluginEntry({runtimeAdapter:{probeExecutable:()=>({path:process.execPath}),createBridge:async()=>bridge}});
  await extendRuntimeEntry(entry).activate({installationConfiguration:{},hostCapabilities:{get:()=>({register:value=>{provider=value;}})}});
  async function boot(){
    bridge=await bootBridge(dir);
    adapter=provider.create({homePath:dir.options.home,profile:'whalenest'},{
      async withPrivateVoiceSession(request,signal,run){
        assert.equal(request.chatId,route.conversation);assert.equal(request.ownerId,route.sender);signal.throwIfAborted();
        return run(session,{workspace,sessionRef:'original-private',model:dir.options.model});
      },
    });
    session=await adapter.start({bindingId:route.account,chatId:route.conversation,sessionId:'original-private',
      ...(nativeId?{runtimeThreadId:nativeId}:{}),onRuntimeThreadId:id=>{nativeId=id;}});
  }
  const prompt=async(text,turnId='chat-voice-'+(++turn))=>{
    await Array.fromAsync(session.prompt({turnId,prompt:text,workspace,model:dir.options.model}));
    return JSON.parse((await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').at(-1));
  };
  const command=async(args,text)=>{
    const trace=await prompt('运维自测：'+text+'\nFOUNDATION_TOOL '+JSON.stringify({name:'companion_voice',args}));
    const result=trace.messages.filter(message=>message.role==='tool').at(-1);
    assert.ok(result&&!result.isError,JSON.stringify(result));return JSON.stringify(result);
  };
  const selectedVoice=async()=>JSON.parse(await readFile(join(dir.options.dataDir,'aurabot/config.json'))).voice.platformVoice;
  await boot();
  const list=await command({action:'list'},'你有哪些音色？');
  for(const name of ['鲸鱼娘','小鲸娘1','小鲸娘2','小鲸娘3','小鲸娘4','大鲸娘1'])assert.ok(list.includes(name));
  assert.match(list,/搞怪逗趣/);assert.match(list,/元气活力/);
  assert.doesNotMatch(list,/龙翼雀菊|龙晖泉晴|龙薇梅翼|龙萱桃烁|龙晖杉朔/);
  assert.equal(voices.length,0,'Reading choices must not synthesize or change the preference');
  const first='qwen-audio-3.0-tts-flash-longxuantaoshuo',second='qwen-audio-3.0-tts-flash-longhuishanshuo';
  assert.match(await command({action:'update',voice:'小鲸娘4'},'换成小鲸娘4。'),/小鲸娘4/);
  assert.deepEqual(voices,[first]);assert.equal(await selectedVoice(),first);
  gateway=await startPlatformVoiceLiveware(dir.options,{bridgePort:voiceSessionPort(dir.options)});
  const origin='http://127.0.0.1:'+gateway.port,headers={'x-clawchat-user-id':route.sender};
  const page=await (await fetch(origin,{headers})).text(),script=await (await fetch(origin+'/page.js',{headers})).text();
  assert.doesNotMatch(page+script,/whalenest-voice-choice|voice-http\/settings|说话音色/);
  assert.equal((await fetch(origin+'/voice-http/settings',{method:'POST',headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify({voice:'小鲸娘1'})})).status,404,'The removed page write route must not remain callable');
  const secret=await readFile(join(dir.options.dataDir,'realtime/session-secret'),'utf8');
  assert.equal((await fetch('http://127.0.0.1:'+voiceSessionPort(dir.options)+'/voice/v1/settings',{
    method:'POST',headers:{'x-voice-secret':secret,'content-type':'application/json'},body:JSON.stringify({voice:'小鲸娘1'}),
  })).status,404,'The internal voice bridge must retain only its read contract');
  assert.equal(await selectedVoice(),first);assert.deepEqual(voices,[first]);
  const pcm=Buffer.alloc(16000,40);
  const speakInCall=async id=>{
    const before=voices.length;call.upload(id,pcm);
    await call.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id===id);
    assert.ok(voices.length>before);return voices.slice(before);
  };
  call=await connectPlatformVoice(origin,route.sender);
  assert.ok((await speakInCall('first-choice')).every(voice=>voice===first));
  await command({action:'update',voice:'大鲸娘1'},'换成大鲸娘1。');assert.equal(await selectedVoice(),second);
  assert.ok((await speakInCall('same-call')).every(voice=>voice===first),'An active call keeps its original voice');
  await call.close();call=null;
  call=await connectPlatformVoice(origin,route.sender);
  assert.ok((await speakInCall('next-call')).every(voice=>voice===second),'The next call reads the chat selection');
  await call.close();call=null;
  const beforeMessage=voices.length;await prompt('运维自测：SEND_VOICE_FIXTURE 请用语音回复。');
  assert.deepEqual(voices.slice(beforeMessage),[second],'Chat voice messages use the same saved preference');
  await gateway.close();gateway=null;await session.close();session=null;await adapter.close();adapter=null;await bridge.close();bridge=null;
  const beforeRestart=voices.length;await boot();
  assert.match(await command({action:'status'},'现在用的是什么音色？'),/大鲸娘1/);
  assert.equal(await selectedVoice(),second);assert.equal(voices.length,beforeRestart);
  await command({action:'update',voice:'默认'},'恢复默认音色。');assert.equal(await selectedVoice(),defaultPlatformVoice);
  assert.deepEqual(errors,[]);
});
