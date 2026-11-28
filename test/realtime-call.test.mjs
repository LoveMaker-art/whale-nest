import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {startPlatformVoiceLiveware} from '../src/platform-voice-liveware.mjs';
import {defaultPlatformVoice} from '../src/speech.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {serveLiveware} from '../src/liveware-service.mjs';
import {prepareConnect} from '../scripts/prepare-connect.mjs';
import {connectPlatformVoice,connectPlatformVoiceHttp} from './platform-voice-client.mjs';

test('optional companion settings cannot fail official preparation or model discovery',async t=>{
  const home = await mkdtemp(join(tmpdir(),'whalenest-optional-call-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  let provider, closed=false;
  const base = {activate(context) {
    context.hostCapabilities.get('runtime-provider').register({create:()=>({
      prepare:async()=> 'official-ready',
      listModels:async()=>[{id:'model',selection:{provider:'fixture',model:'chat'}}],
      close:async()=>{closed=true;},
    })});
  }};
  await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:value=>{provider=value;}})}});
  const adapter = provider.create({homePath:home},{});
  assert.equal(await adapter.prepare(),'official-ready');
  assert.equal((await adapter.listModels())[0].id,'model');
  await adapter.close();
  assert.equal(closed,true);
});

test('a temporary unknown manager keeps the page healthy and pauses publication until selection is known',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-manager-restart-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const route={channel:'clawchat',kind:'private',account:'agent',sender:'owner',conversation:'dm'},file=join(root,'instance.json');
 await writeFile(file,JSON.stringify({dataDir:root,cwd:root,owners:[route],clawchat:{route},realtime:{enabled:true,sessionEnabled:false,port}}));
 const stop=new AbortController();let selection=null,failure;
 const running=serveLiveware('call',file,stop.signal,20,async()=>selection);running.catch(e=>{failure=e;});
 t.after(async()=>{stop.abort();await running.catch(()=>{});});
 let healthy=false;
 for(let i=0;i<50&&!healthy;i++){if(failure)throw failure;try{healthy=(await fetch('http://127.0.0.1:'+port+'/healthz')).ok;}catch{}if(!healthy)await delay(20);}
 assert.ok(healthy);assert.equal((await fetch('http://127.0.0.1:'+port+'/healthz')).status,200);
 assert.deepEqual((await readdir(root)).sort(),['instance.json'],'Unknown selection must not submit or persist publication');
 selection=false;await running;assert.equal(failure,undefined);
});

for (const [kind,unavailable] of [['call','song-playback.mjs'],['song','platform-voice-liveware.mjs']]) {
  test(kind+' Liveware remains healthy when the other backend cannot load',{timeout:20000},async t=>{
    const root = await mkdtemp(join(tmpdir(),'whalenest-isolated-liveware-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const reservation = createServer();
    await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const port = reservation.address().port;
    await new Promise(resolve=>reservation.close(resolve));
    const provider = join(root,'provider.json');
    await writeFile(provider,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture',baseUrl:'http://127.0.0.1:1/v1'}}}}));
    const route = {channel:'clawchat',kind:'private',account:'agent',conversation:'private',sender:'owner'};
    const config = join(root,'instance.json');
    await writeFile(config,JSON.stringify({dataDir:root,cwd:root,owners:[route],clawchat:{route},
      realtime:{enabled:true,port,python:process.env.WHALENEST_TEST_PYTHON},
      speech:{enabled:true,providerConfigPath:provider,asrModel:'fixture-asr',ttsModel:'fixture-tts'},
      singing:{enabled:true,providerConfigPath:provider,playback:{enabled:true,port}},
    }));
    const source = new URL('../src/liveware-service.mjs',import.meta.url).href;
    const script = `
      import {registerHooks} from 'node:module';
      import assert from 'node:assert/strict';
      registerHooks({resolve(specifier,context,next) {
        if (specifier.endsWith(${JSON.stringify(unavailable)})) throw Error('unavailable unrelated backend');
        return next(specifier,context);
      }});
      const {serveLiveware} = await import(${JSON.stringify(source)});
      const stop = new AbortController();
      const running = serveLiveware(${JSON.stringify(kind)},${JSON.stringify(config)},stop.signal,50);
      let failure, healthy=false;
      running.catch(error=>{failure=error;});
      try {
        for (let n=0;n<80 && !healthy;n++) {
          if (failure) throw failure;
          try { healthy=(await fetch('http://127.0.0.1:'+${port}+'/healthz',{signal:AbortSignal.timeout(1000)})).ok; } catch {}
          if (!healthy) await new Promise(resolve=>setTimeout(resolve,50));
        }
        assert.ok(healthy);
      } finally {
        stop.abort();
        await running.catch(error=>{if(error.name!=='AbortError')throw error;});
      }
      console.log('isolation-ok');
    `;
    assert.match(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000}),/isolation-ok/);
  });
}

test('HTTPS polls keep queued playback ahead over a 1200 ms relay round trip',()=>{
  const result = execFileSync(process.env.WHALENEST_TEST_PYTHON ?? 'python3',['-B','-c',`
import asyncio
import json
from types import SimpleNamespace
from clawnest_voice.config import Config
from clawnest_voice.dsh_http import HttpCall

async def run():
    config = Config()
    call = HttpCall('fixture')
    call.session = SimpleNamespace(closed=False)
    await call.emit({'type': 'segment_start'})
    for i in range(23):
        await call.emit({'type': 'audio', 'seq': i}, bytes(config.audio_frame_bytes))
    page = await call.poll(0)
    audio = [frame['seq'] for frame in page['frames'] if frame['type'] == 'audio']
    duration = len(audio) * config.audio_frame_bytes * 1000 / (2 * config.tts_sample_rate)
    next_page = await call.poll(page['after'])
    remaining = [frame['seq'] for frame in next_page['frames']]
    print(json.dumps({'duration': duration, 'audio': audio, 'cursor': page['after'], 'remaining': remaining}))

asyncio.run(run())
`],{encoding:'utf8',cwd:fileURLToPath(new URL('../vendor/platform-liveware/',import.meta.url))});
  const page = JSON.parse(result);
  assert.ok(page.duration >= 1200, 'A 1200 ms round trip outruns the queued PCM in one page');
  assert.deepEqual([...page.audio,...page.remaining], Array.from({length:23},(_, index)=>index));
  assert.ok(page.remaining.length>0,'A slow client still receives bounded responses');
  assert.equal(page.cursor, page.audio.length+1);
});

test('official page and gateway use the verified DSH lane, shared voice, playback receipts and cancellation',{timeout:30000},async t=>{
  const root = await mkdtemp(join(tmpdir(),'whalenest-platform-voice-'));
  let service, client, stopPrompt, release, releaseStream, cancelCount=0, turnCount=0, speechRequests=[];
  let transcript='你好大肥鱼';
  const platform = createServer(async(req,res)=>{
    const body = [];
    for await (const chunk of req) body.push(chunk);
    assert.equal(req.headers.authorization,'Bearer fixture');
    if (req.url==='/v1/audio/transcriptions') {
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({text:transcript}));
    } else if (req.url==='/v1/audio/speech') {
      speechRequests.push(JSON.parse(Buffer.concat(body)));
      res.writeHead(200,{'Content-Type':'audio/pcm'}).end(Buffer.alloc(11000,40));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve=>platform.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    releaseStream?.();
    await client?.close();
    await service?.close();
    platform.closeAllConnections();
    await new Promise(resolve=>platform.close(resolve));
    await rm(root,{recursive:true,force:true});
  });
  const provider = join(root,'provider.json');
  await writeFile(provider,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture',
    baseUrl:'http://127.0.0.1:'+platform.address().port+'/v1'}}}}));
  const verifiedVoice = 'qwen-audio-3.0-tts-flash-fixture';
  await mkdir(join(root,'aurabot'));
  const route={account:'verified',conversation:'private',sender:'owner'};
  const publicOrigin='https://app-fixture.apps.clawling.io';
  const options={dataDir:root,cwd:root,clawchat:{route},speech:{enabled:true,providerConfigPath:provider,
    asrModel:'fixture-asr',ttsModel:'fixture-tts'},realtime:{port:0,publicOrigin,python:process.env.WHALENEST_TEST_PYTHON}};
  let playback, voiceActive=false, prepared=0, profileReads=0, resolveProfile;
  const profile = new Promise(resolve=>{resolveProfile=resolve;});
  service=await startPlatformVoiceLiveware(options,{readProfile:()=>{profileReads++;return profile;},listModels:async()=>[
    {isDefault:true,selection:{provider:'clawling',model:'deepseek-v4.1-flash'}},
    {selection:{provider:'clawling-voice',model:'deepseek-v4.1-flash'},supportedReasoningEfforts:['off','low']},
  ],async withCallSession(request,signal,run){
    assert.equal(request.chatId,route.conversation);
    assert.equal(request.ownerId,route.sender);
    if(request.sessionRef)assert.equal(request.sessionRef,'text-session');
    else prepared++;
    signal.throwIfAborted();
    await run({
      async prepareVoice(){return 'dsh-thread';},
      async voiceMode(enabled){voiceActive=enabled;}, async voicePlayback(value){playback=value;},
      async *prompt({prompt,model,reasoningEffort,onAccepted}){
        assert.deepEqual(model,{provider:'clawling-voice',model:'deepseek-v4.1-flash'});
        assert.equal(reasoningEffort,'off');
        await onAccepted();
        turnCount++;
        yield {kind:'reasoning',text:'private reasoning'};
        if (prompt==='流式测试') {
          yield {id:'streamed',kind:'assistant',state:'streaming',text:'海面上的风很轻。',data:{outputKind:'assistant'}};
          await new Promise(resolve=>{releaseStream=resolve;});
          yield {id:'streamed',kind:'assistant',state:'complete',text:'海面上的风很轻。浪花正在醒来。',data:{outputKind:'final'}};
          return;
        }
        if (prompt==='等一下') {
          stopPrompt?.();
          await new Promise(resolve=>{release=resolve;});
        }
        yield {kind:'assistant',text:'你好，我在这里。',data:{outputKind:'final'}};
      },
      async cancel(){cancelCount++;release?.();},
    },{sessionRef:'text-session',workspace:{workingDirectory:root}});
  }});
  const origin='http://127.0.0.1:'+service.port;
  assert.equal((await fetch(origin)).status,403);
  assert.equal((await fetch(origin,{headers:{'x-clawchat-user-id':'different'}})).status,403);
  assert.equal((await fetch(origin+'/health',{headers:{'x-clawchat-user-id':route.sender,origin:'https://app-unrelated.apps.clawling.io'}})).status,403);
  const headers={'x-clawchat-user-id':route.sender};
  assert.equal((await fetch(origin+'/profile')).status,403);
  assert.equal((await fetch(origin+'/default-avatar.png')).status,403);
  const avatar=await fetch(origin+'/default-avatar.png',{headers});
  assert.equal(avatar.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()),await readFile(new URL('../src/assets/whalenest-avatar.png',import.meta.url)));
  const page=await (await fetch(origin,{headers})).text();
  assert.match(page,/<title>鲸栖通话<\/title>/);
  assert.match(page,/鲸栖通话<\/h1>/);
  assert.match(page,/dsh-http\.js/);
  assert.equal((await fetch(origin+'/voice-http/start',{method:'POST',body:'{}'})).status,403);
  const portrait=page.match(/<img id="agent-avatar"[^>]*>/)?.[0]??'';
  assert.match(portrait,/\bhidden\b/);
  assert.doesNotMatch(portrait,/\ssrc=/,'The browser must wait for the account profile before displaying any portrait');
  const fallback=portrait.match(/data-fallback="([^"]+)"/)?.[1];
  assert.match(fallback,/^default-avatar\.png\?v=[0-9a-f]{12}$/);
  const pageScript=await (await fetch(origin+'/page.js',{headers})).text();
  const transports=[];
  const timers=new Map();
  const context={
    running:true,paused:false,reconnects:0,preferHttps:false,micPrepare:null,
    ws:undefined,socketUpgradeTimer:undefined,connectionDeadline:undefined,
    location:{pathname:'/',protocol:'https:',host:'app-fixture.apps.clawling.io'},t:text=>text,
    state(){},notice(){},releaseMedia:action=>action(),
    setTimeout(callback,ms){timers.set(ms,callback);return ms;},
    clearTimeout(ms){timers.delete(ms);},
    WebSocket:class { constructor(){transports.push('websocket');} close(){} },
    DshHttpVoiceSocket:class { constructor(){transports.push('https');} },
  };
  runInNewContext(pageScript.slice(pageScript.indexOf('function connect()'),pageScript.indexOf('async function begin()'))
    +'\nconnect();',context);
  assert.deepEqual(transports,['websocket']);
  timers.get(2000)();
  assert.deepEqual(transports,['websocket','https']);
  const script=pageScript.slice(pageScript.indexOf('async function loadAgentProfile()'),pageScript.indexOf('function showCaptionHistory('));
  const avatarLoads=[],avatarEvents={};
  const image={dataset:{fallback},hidden:true,set src(value){avatarLoads.push(value);},get src(){return avatarLoads.at(-1);},
    addEventListener(name,callback){avatarEvents[name]=callback;}};
  const correctedAvatar='https://media.clawling.chat/current.png';
  const queuedProfiles=[{pending:true},{name:'',avatar:correctedAvatar,pending:false}];
  await runInNewContext(script+'\nloadAgentProfile()',{
    $:()=>image,URL,location:{href:origin+'/'},basePath:()=>'/',setTimeout:callback=>callback(),
    fetch:async()=>({ok:true,json:async()=>queuedProfiles.shift()}),
  });
  assert.deepEqual(avatarLoads,[correctedAvatar]);
  assert.equal(image.hidden,true,'Do not reveal the browser image until it has loaded');
  avatarEvents.load();
  assert.equal(image.hidden,false);
  assert.match(await (await fetch(origin+'/classic',{headers})).text(),/<title>鲸栖通话<\/title>/);
  for (const id of ['agent-avatar','agent-name','mic-toggle','captions-toggle','text-sync']) assert.match(page,new RegExp('id="'+id+'"'));
  const readProfile=async()=>await (await fetch(origin+'/profile',{headers})).json();
  assert.deepEqual(await readProfile(),{pending:true});
  assert.deepEqual(await readProfile(),{pending:true});
  client=await connectPlatformVoice(origin,route.sender);
  for(let i=0;i<30&&prepared===0;i++)await delay(25);
  assert.equal(prepared,1,'Opening the call prepares the DSH session before the first utterance');
  resolveProfile({nickname:' 测试大肥鱼 ',avatar_url:'https://media.clawling.chat/fixture.png',private:'unused'});
  assert.deepEqual(await readProfile(),{name:'测试大肥鱼',avatar:'https://media.clawling.chat/fixture.png',pending:false});
  assert.equal(profileReads,1);
  const pcm=Buffer.alloc(24000,41);
  client.upload('first',pcm);
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='first');
  assert.ok(client.frames.some(frame=>frame.type==='subtitle'&&frame.text==='你好，我在这里。'));
  assert.ok(client.frames.some(frame=>frame.type==='audio'&&frame.pcm.length>0));
  assert.ok(!JSON.stringify(client.frames).includes('private reasoning'));
  assert.equal(speechRequests[0].voice,defaultPlatformVoice);
  assert.equal(speechRequests.length,1);
  client.upload('first',pcm);
  await delay(150);
  assert.equal(turnCount,1);
  transcript='等一下';
  const pending=new Promise(resolve=>{stopPrompt=resolve;});
  client.upload('second',pcm);
  await pending;
  assert.deepEqual(playback,{played:'你好，我在这里。',interrupted:false});
  client.send({type:'barge_in',client_turn_id:'second'});
  for(let i=0;i<70&&cancelCount===0;i++)await delay(20);
  assert.equal(cancelCount,1);
  await client.close();
  for(let i=0;i<70&&voiceActive;i++)await delay(20);
  assert.equal(voiceActive,false);
  const dir=join(root,'realtime/platform-turns');
  const evidence=await Promise.all((await readdir(dir)).map(async name=>JSON.parse(await readFile(join(dir,name)))));
  assert.ok(evidence.some(row=>row.state==='played'&&row.played==='你好，我在这里。'));
  assert.ok(evidence.some(row=>row.state==='interrupted'&&row.played===''));
  const status='/startup-status?stage=4&socket=1&mic=1';
  assert.equal((await fetch(origin+status)).status,403);
  assert.equal((await fetch(origin+status,{headers:{'x-clawchat-user-id':route.sender}})).status,200);
  await writeFile(join(root,'aurabot/config.json'),JSON.stringify({voice:{platformVoice:verifiedVoice}}));
  transcript='你好大肥鱼';
  client=await connectPlatformVoice(origin,route.sender,{browserOrigin:publicOrigin});
  client.upload('new-voice',pcm);
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='new-voice');
  assert.equal(speechRequests[1].voice,verifiedVoice);
  assert.ok(client.frames.some(frame=>frame.type==='audio'&&frame.pcm.length>0));
  assert.equal(speechRequests.length,2);
  transcript='流式测试';
  client.upload('sse-stream',pcm);
  await client.waitFor(frame=>frame.type==='audio'&&frame.client_turn_id==='sse-stream',1600);
  assert.ok(!client.frames.some(frame=>frame.type==='generation_done'&&frame.client_turn_id==='sse-stream'));
  releaseStream();
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='sse-stream');
  assert.equal(client.frames.filter(frame=>frame.type==='subtitle'&&frame.client_turn_id==='sse-stream').map(frame=>frame.text).join(''),
    '海面上的风很轻。浪花正在醒来。');
  transcript='等一下';
  const thinking=new Promise(resolve=>{stopPrompt=resolve;});
  client.upload('sse-thinking',pcm);
  await thinking;
  client.send({type:'barge_in',source:'vad_confirmed'});
  await delay(150);
  release();
  const afterNoise=await client.waitFor(frame=>['clear','turn_complete'].includes(frame.type)&&frame.client_turn_id==='sse-thinking');
  assert.equal(afterNoise.type,'turn_complete','Local microphone detection must not cancel a reply before playback');
  assert.equal(cancelCount,1);
  transcript='流式测试';
  client.upload('sse-audible',pcm);
  const audible=await client.waitFor(frame=>frame.type==='audio'&&frame.client_turn_id==='sse-audible');
  client.send({type:'audio_started',client_turn_id:'sse-audible',segment_id:audible.segment_id});
  client.send({type:'barge_in',source:'vad_confirmed'});
  await client.waitFor(frame=>frame.type==='clear'&&frame.client_turn_id==='sse-audible');
  releaseStream();
  for(let i=0;i<70&&cancelCount<2;i++)await delay(20);
  assert.equal(cancelCount,2);
  transcript='等一下';
  const cancelPending=new Promise(resolve=>{stopPrompt=resolve;});
  client.upload('sse-cancel',pcm);
  await cancelPending;
  client.send({type:'barge_in',client_turn_id:'sse-cancel'});
  for(let i=0;i<70&&cancelCount<3;i++)await delay(20);
  assert.equal(cancelCount,3);
  await client.close();
  client=undefined;
  for(let i=0;i<30&&voiceActive;i++)await delay(25);
  assert.equal(voiceActive,false);
  transcript='你好大肥鱼';
  client=await connectPlatformVoiceHttp(origin,route.sender,{browserOrigin:publicOrigin,chunked:true,dropFirstWriteReceipt:true});
  assert.equal(client.session.downstream_transport,'https');
  client.upload('https',pcm);
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='https');
  assert.ok(client.frames.some(frame=>frame.type==='audio'&&frame.pcm.length>0));
  assert.ok(client.lostReceipt);
  assert.equal(speechRequests.at(-1).voice,verifiedVoice);
});

test('independent call gateway and song publication start on first binding and survive a Runtime stop',{timeout:18000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'whalenest-liveware-first-binding-'));
  const directory=join(root,'companion/aurabot-v1');
  await mkdir(directory,{recursive:true});
  let adapter;
  const stop = new AbortController(), services = [];
  t.after(async()=>{stop.abort();await Promise.allSettled(services);await adapter?.close();await rm(root,{recursive:true,force:true});});
  const instancePath=join(directory,'instance.json');
  const providerPath=join(root,'provider.json');
  const connectBin=join(root,'connect');
  const commands=join(root,'commands.jsonl');
  const route={channel:'clawchat',kind:'private',account:'verified',conversation:'private',sender:'owner'};
  const template={instanceId:'provisioned',home:root,dataDir:directory,cwd:root,clawchat:{firstBinding:true,
    delivery:{connectBin,configPath:join(root,'connect.json')}},
    speech:{providerConfigPath:providerPath,asrModel:'fixture-asr',ttsModel:'fixture-tts'},
    realtime:{port:0,python:process.env.WHALENEST_TEST_PYTHON},
    singing:{playback:{port:0}}};
  await writeFile(providerPath,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture',baseUrl:'http://127.0.0.1:1/v1'}}}}));
  const templatePath=join(root,'instance-template.json'),preparation=join(root,'prepared');
  await writeFile(templatePath,JSON.stringify(template));
  await prepareConnect(templatePath,preparation);
  const options=JSON.parse(await readFile(join(preparation,'instance.json'),'utf8'));
  assert.ok(options.realtime.enabled&&options.singing.enabled&&options.singing.playback.enabled);
  assert.equal(options.image.enabled,true);
  assert.equal(options.expressions.enabled,true);assert.equal(options.expressions.stickerChance,0.5);
  assert.equal(options.memory.automatic,true);assert.deepEqual(options.memory.consolidateTimes,['21:00']);
  assert.equal(options.activities.automatic,true);assert.equal(options.activities.maxDailyBackgroundModelCalls,5);
  assert.equal(options.qq.nativeModules,true);assert.ok(!options.qq.enabled);
  await writeFile(instancePath,JSON.stringify(options));
  await writeFile(connectBin,'#!'+process.execPath+'\n'+
    `const fs=require('node:fs');const [channel,type,action,...args]=process.argv.slice(2);
      const get=flag=>args[args.indexOf(flag)+1];
      if(channel==='__clawnest-state'){console.log(JSON.stringify({userId:'agent-id',ownerId:'owner',conversationId:'private',connected:true,available:true}));process.exit(0);}
      if(channel==='config'){console.log(JSON.stringify({defaultAgent:'verified',agents:{verified:{}}}));process.exit(0);}
      if(channel!=='liveware')process.exit(1);
      fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify({type,action,args})+'\\n');
      const key=action==='create'?(get('--name')==='鲸栖通话'?'app-call':'app-songs'):get('--app-id');
      const result=action==='create'?{appId:key,name:get('--name'),publicUrl:'https://'+key+'.apps.clawling.io/'}:
        {appId:key,publicUrl:'https://'+key+'.apps.clawling.io/',registeredInClawChat:true};
      console.log(JSON.stringify({status:'succeeded',result}));`,{mode:0o700});
  let provider;
  const base={activate(context){context.hostCapabilities.get('runtime-provider').register({create:()=>({
    async prepare(){
      await writeFile(join(directory,'first-binding.json'),JSON.stringify({id:'verified-first-binding',identity:{account:'verified',agent:'agent-id',owner:'owner',conversation:'private'}}));
      await writeFile(instancePath,JSON.stringify({...options,owners:[route],clawchat:{...options.clawchat,route}}));
    },
  })});}};
  await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:value=>{provider=value;}})}});
  adapter=provider.create({homePath:root},{withCallSession:async()=>{}});
  for (const kind of ['call', 'song']) services.push(serveLiveware(kind, instancePath, stop.signal, 50));
  await assert.rejects(readFile(commands),{code:'ENOENT'});
  await adapter.prepare();
  const load=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
  let gateway,song;
  for(let i=0;i<100&&!(gateway?.port&&song?.url);i++){
    gateway=await load('realtime/server.json').catch(()=>null);
    song=await load('song-liveware.json').catch(()=>null);
    if(!(gateway?.port&&song?.url))await delay(50);
  }
  assert.ok(gateway?.port>0);
  assert.equal(song?.url,'https://app-songs.apps.clawling.io/');
  await assert.rejects(load('call-liveware.json'),{code:'ENOENT'},'Official Exposure owns call publication');
  assert.equal(song.binding,route.account);
  const invocations=async()=> (await readFile(commands,'utf8')).trim().split('\n').map(JSON.parse);
  const initial=await invocations();
  assert.equal(initial.length,2);
  for(const item of initial.filter(row=>row.action==='create'))assert.ok(item.args.includes('private'));
  for(const item of initial.filter(row=>row.action==='bind')){
    const target=item.args[item.args.indexOf('--upstream')+1];
    assert.match(target,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(target+'/healthz')).status,200);
  }
  await adapter.prepare();
  await adapter.close();
  adapter=undefined;
  assert.equal((await fetch('http://127.0.0.1:'+gateway.port+'/healthz')).status,200);
  for(const item of initial.filter(row=>row.action==='bind')){
    const target=item.args[item.args.indexOf('--upstream')+1];
    assert.equal((await fetch(target+'/healthz')).status,200);
  }
  assert.deepEqual(await invocations(),initial);
});
