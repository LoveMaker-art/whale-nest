import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {startPlatformVoiceLiveware} from '../src/platform-voice-liveware.mjs';
import {defaultPlatformVoice} from '../src/speech.mjs';
import {connectPlatformVoice,connectPlatformVoiceHttp} from './platform-voice-client.mjs';

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
  ],async withPrivateVoiceSession(request,signal,run){
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
  assert.equal(Buffer.from(await avatar.arrayBuffer()).subarray(1,4).toString(),'PNG');
  const page=await (await fetch(origin,{headers})).text();
  assert.match(page,/<title>鲸栖通话<\/title>/);
  assert.match(page,/鲸栖通话<\/h1>/);
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
  client=await connectPlatformVoice(origin,route.sender,{startupFallback:true,browserOrigin:publicOrigin});
  client.upload('fallback',pcm);
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='fallback');
  assert.equal(speechRequests[1].voice,verifiedVoice);
  assert.ok(client.frames.some(frame=>frame.type==='audio'&&frame.pcm.length>0));
  await client.close();
  for(let i=0;i<30&&voiceActive;i++)await delay(25);
  assert.equal(voiceActive,false);
  const unauthenticated=await fetch(origin+'/voice-http/start',{method:'POST',body:'{}'});
  assert.equal(unauthenticated.status,403);
  client=await connectPlatformVoiceHttp(origin,route.sender,{browserOrigin:publicOrigin,chunked:true,dropFirstWriteReceipt:true});
  assert.equal(client.session.downstream_transport,'https');
  client.upload('https',pcm);
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='https');
  assert.ok(client.frames.some(frame=>frame.type==='subtitle'));
  assert.ok(client.frames.some(frame=>frame.type==='audio'&&frame.pcm.length>0));
  assert.ok(client.lostReceipt);
  assert.equal(speechRequests.length,3);
  transcript='流式测试';
  client.upload('https-stream',pcm);
  await client.waitFor(frame=>frame.type==='audio'&&frame.client_turn_id==='https-stream',1600);
  assert.ok(!client.frames.some(frame=>frame.type==='generation_done'&&frame.client_turn_id==='https-stream'));
  releaseStream();
  await client.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='https-stream');
  assert.equal(client.frames.filter(frame=>frame.type==='subtitle'&&frame.client_turn_id==='https-stream').map(frame=>frame.text).join(''),
    '海面上的风很轻。浪花正在醒来。');
  transcript='等一下';
  const thinking=new Promise(resolve=>{stopPrompt=resolve;});
  client.upload('https-thinking',pcm);
  await thinking;
  client.send({type:'barge_in',source:'vad_confirmed'});
  await delay(150);
  release();
  const afterNoise=await client.waitFor(frame=>['clear','turn_complete'].includes(frame.type)&&frame.client_turn_id==='https-thinking');
  assert.equal(afterNoise.type,'turn_complete','Local microphone detection must not cancel a reply before playback');
  assert.equal(cancelCount,1);
  transcript='流式测试';
  client.upload('https-audible',pcm);
  const audible=await client.waitFor(frame=>frame.type==='audio'&&frame.client_turn_id==='https-audible');
  client.send({type:'audio_started',client_turn_id:'https-audible',segment_id:audible.segment_id});
  client.send({type:'barge_in',source:'vad_confirmed'});
  await client.waitFor(frame=>frame.type==='clear'&&frame.client_turn_id==='https-audible');
  releaseStream();
  for(let i=0;i<70&&cancelCount<2;i++)await delay(20);
  assert.equal(cancelCount,2);
  transcript='等一下';
  const httpsPending=new Promise(resolve=>{stopPrompt=resolve;});
  client.upload('https-cancel',pcm);
  await httpsPending;
  client.send({type:'barge_in',client_turn_id:'https-cancel'});
  for(let i=0;i<70&&cancelCount<3;i++)await delay(20);
  assert.equal(cancelCount,3);
});
