import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {buildRuntimeBase} from '../scripts/build-runtime-base.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';
import {enablePlatformSpeech} from '../src/runtime-upgrade.mjs';
import {startPlatformVoiceLiveware,voiceSessionPort} from '../src/platform-voice-liveware.mjs';
import {connectPlatformVoice} from './platform-voice-client.mjs';

test('Liveware uses an independent native Session, shares authorized memory, preserves tools and keeps private histories separate',{timeout:120000},async t=>{
  const dir=await bridgeDirectory();
  let bridge,adapter,call,gateway,tts=0,asr=0;
  let heard='运维自测：WRITE_BLUE 周五五点在东门见。';
  const model=createServer(async(req,res)=>{
    for await(const _ of req){}
    if(req.url.endsWith('transcriptions')){
      asr++;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({text:heard}));
    } else {
      tts++;
      res.writeHead(200,{'content-type':'audio/pcm'}).end(Buffer.alloc(12000,42));
    }
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await call?.close();
    await gateway?.close();
    await adapter?.close();
    await bridge?.close();
    model.closeAllConnections();
    await new Promise(resolve=>model.close(resolve));
    await rm(dir.root,{recursive:true,force:true});
  });
  const provider=join(dir.root,'provider.json');
  await writeFile(provider,JSON.stringify({models:{providers:{clawling:{apiKey:'fixture-key',
    baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'}}}}));
  dir.options.speech=enablePlatformSpeech({providerConfigPath:provider});
  dir.options.realtime={enabled:true,sessionEnabled:true,mode:'independent',port:0,python:process.env.WHALENEST_TEST_PYTHON};
  dir.options.singing={enabled:true,providerConfigPath:provider};
  const privateCallUrl='https://app-test-call.apps.clawling.io/';
  await mkdir(dir.options.dataDir,{recursive:true});
  await writeFile(join(dir.options.dataDir,'call-liveware.json'),JSON.stringify({
    binding:dir.options.clawchat.route.account,owner:dir.options.clawchat.route.sender,appId:'app-test-call',url:privateCallUrl,
  }));
  await mkdir(join(dir.options.home,'companion/aurabot-v1'),{recursive:true});
  await writeFile(join(dir.options.home,'companion/aurabot-v1/instance.json'),JSON.stringify(dir.options));
  bridge=await bootBridge(dir);
  const pid=bridge.child.pid;
  const base=await import(pathToFileURL(await buildRuntimeBase(join(dir.root,'base'))));
  let registered;
  const entry=base.createDeepSeekHarnessOfficialPluginEntry({runtimeAdapter:{probeExecutable:()=>({path:process.execPath}),createBridge:async()=>bridge}});
  await extendRuntimeEntry(entry).activate({installationConfiguration:{},hostCapabilities:{get:()=>({register:provider=>{registered=provider;}})}});
  const workspace={workingDirectory:dir.root};
  const route=dir.options.clawchat.route;
  let textSession, nativeId;
  const createAdapter=()=>registered.create({homePath:dir.options.home,profile:'whalenest'});
  adapter=createAdapter();
  await adapter.prepare();
  textSession=await adapter.start({bindingId:route.account,chatId:route.conversation,sessionId:'original-private',
    onRuntimeThreadId:id=>{nativeId=id;}});
  const textInput=turnId=>({workspace,turnId,model:dir.options.model});
  await Array.fromAsync(textSession.prompt({...textInput('text-before'),prompt:'原私聊保留的文字'}));
  gateway=await startPlatformVoiceLiveware(dir.options,{bridgePort:voiceSessionPort(dir.options)});
  let server;
  for(let i=0;i<125;i++){
    try { server=JSON.parse(await readFile(join(dir.options.dataDir,'realtime/server.json')));break; }
    catch { await delay(40); }
  }
  assert.equal(server?.provider,'clawnest-voice');
  call=await connectPlatformVoice('http://127.0.0.1:'+server.port,dir.options.clawchat.route.sender);
  const pcm=Buffer.alloc(24000,40);
  call.upload('first',pcm);
  await call.waitFor(frame=>frame.type==='turn_complete'&&frame.client_turn_id==='first');
  assert.equal(asr,1);
  assert.ok(tts>0);
  const trace=JSON.parse((await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').at(-1));
  const transcript=trace.messages.find(message=>message.source?.whalenestOrigin==='realtime-call');
  assert.ok(transcript?.content.some(block=>block.text==='【实时通话】'));
  assert.doesNotMatch(JSON.stringify(trace.messages),/原私聊保留的文字/);
  const sessions=join(dir.options.dataDir,'realtime/sessions');
  const voiceRows=await readdir(sessions);assert.equal(voiceRows.length,1);
  const callNativeId=JSON.parse(await readFile(join(sessions,voiceRows[0]),'utf8')).thread;
  assert.ok(callNativeId);assert.notEqual(callNativeId,nativeId);
  assert.ok(trace.messages.some(message=>message.role==='tool'&&message.toolCallId==='fixture-remember'&&!message.isError));
  const shell=trace.tools.find(tool=>tool.name?.toLowerCase()==='bash');
  assert.ok(shell,'Native Bash tool required for interruption regression');
  const props=(shell.inputSchema??shell.parameters??shell.schema)?.properties??{};
  const commandKey=Object.hasOwn(props,'cmd')?'cmd':'command';
  const marker=join(dir.root,'call-child.pid');
  heard='运维自测 FOUNDATION_TOOL '+JSON.stringify({name:shell.name,args:{
    description:'Wait in a cancellable realtime regression',[commandKey]:'echo $$ > '+marker+'; exec sleep 30',
  }});
  call.upload('tool',pcm);
  let child;
  for(let i=0;i<250;i++){
    try {child=Number((await readFile(marker,'utf8')).trim());break;}
    catch {await delay(20);}
  }
  assert.ok(child,'Native tool starts before interruption');
  await call.waitFor(frame=>frame.type==='turn_activity'&&frame.client_turn_id==='tool'&&frame.state==='waiting');
  call.send({type:'barge_in',client_turn_id:'tool'});
  const ledger=join(dir.options.dataDir,'realtime/platform-turns');
  let interrupted;
  for(let i=0;i<150&&!interrupted;i++){
    const rows=await Promise.all((await readdir(ledger)).map(async file=>JSON.parse(await readFile(join(ledger,file)))));
    interrupted=rows.find(row=>row.state==='interrupted');
    if(!interrupted)await delay(40);
  }
  assert.ok(interrupted,'The DSH cancellation finishes and records the interrupted turn');
  assert.throws(()=>process.kill(child,0),'The native tool child drains before the interruption receipt');
  assert.equal(bridge.child.pid,pid);
  assert.ok((await readFile(join(dir.root,'trace.jsonl'),'utf8')).includes('上一轮通话已完整播放的前缀'));
  assert.equal(interrupted.sessionId,callNativeId);
  await call.close();
  call=undefined;
  await assert.rejects(bridge.request('prompt',{sessionId:nativeId,
    inputId:'whalenest-call-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',text:'伪造通话'}),/Unverified voice input|not owned by this process/);
  const textActivities=await Array.fromAsync(textSession.prompt({...textInput('text-after'),prompt:'TOOL_RECALL_BLUE 运维自测查询共享长期记忆'}));
  const textRequest=JSON.parse((await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').at(-1));
  assert.doesNotMatch(JSON.stringify(textRequest.messages),/周五五点在东门见/);
  assert.match(JSON.stringify(textRequest.messages.filter(message=>message.role==='tool').at(-1)),/SECRET_BLUEBERRY/);
  assert.doesNotMatch(JSON.stringify(textRequest.messages.filter(message=>message.source?.kind==='runtime-context').at(-1)),/当前正在与主人实时语音通话/);
  assert.doesNotMatch(JSON.stringify(textActivities),/FOUNDATION_TOOL|实时通话|WRITE_BLUE/);
  const snapshot=await adapter.readActivity(nativeId);
  assert.deepEqual(snapshot.activities.filter(item=>item.kind==='user').map(item=>item.text),
    ['原私聊保留的文字','TOOL_RECALL_BLUE 运维自测查询共享长期记忆']);
  assert.doesNotMatch(JSON.stringify(snapshot.activities),/周五五点在东门见|等一下|barge|Wait in a cancellable realtime regression/);
  await textSession.close();
  await adapter.close();
  await bridge.close();
  bridge=await bootBridge(dir);
  adapter=createAdapter();
  await adapter.prepare();
  const restored=await adapter.readActivity(nativeId);
  assert.deepEqual(restored.activities,snapshot.activities,'Cold history restoration keeps voice hidden');
  textSession=await adapter.start({bindingId:route.account,chatId:route.conversation,sessionId:'original-private',
    runtimeThreadId:nativeId,onRuntimeThreadId(){throw Error('Expected to resume the original native Session');}});
  await Array.fromAsync(textSession.prompt({...textInput('text-after-restart'),prompt:'那么几点见？'}));
  const afterRestart=JSON.parse((await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').at(-1));
  assert.doesNotMatch(JSON.stringify(afterRestart.messages),/周五五点在东门见|WRITE_BLUE/);
  assert.equal(JSON.parse(await readFile(join(sessions,voiceRows[0]),'utf8')).thread,callNativeId);
  for(const [id,request,expectLink] of [
    ['call-card','请给我通话入口',true],
    ['call-declined','不要发起通话',false],
    ['voice-message','请发语音消息',false],
  ]){
    const prompt=request+'\nFOUNDATION_TOOL {"name":"open_realtime_call"}';
    await Array.fromAsync(textSession.prompt({...textInput(id),prompt}));
    const trace=JSON.parse((await readFile(join(dir.root,'trace.jsonl'),'utf8')).trim().split('\n').at(-1));
    const result=JSON.stringify(trace.messages.filter(message=>message.role==='tool').at(-1));
    assert.ok(result.includes(expectLink?privateCallUrl:'仅主人当前要求时提供通话入口'));
    if(!expectLink)assert.ok(!result.includes(privateCallUrl));
  }
  const draft=await Array.fromAsync(textSession.prompt({...textInput('write-song'),prompt:'【运维自测】写歌'}));
  assert.ok(draft.some(activity=>activity.kind==='assistant'&&activity.text==='你想写什么主题的歌？'));
  assert.doesNotMatch(await readFile(join(dir.root,'trace.jsonl'),'utf8'),/"connectInputId":"write-song"/);
});
