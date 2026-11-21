import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSongAdapter} from '../src/song-adapter.mjs';
import {createSongClient} from '../src/song-client.mjs';
import {OneBotError} from '../vendor/aurabot/src/onebot/client.js';

const cc={channel:'clawchat',account:'agent',sender:'owner',conversation:'dm',kind:'private'};
const qq={channel:'qq',account:'bot',sender:'1',conversation:'1',kind:'private'};
const args={title:'小鱼晚安',lyrics:'[Verse]\n小鱼在月光里游动',style:'soft female vocal, gentle pop'};
function actor(id,text,{channel='clawchat',source}={}){
 const sessionId=channel==='qq'?'qq-session':'cc-session',callId='call-'+id;
 const origin=source??(channel==='qq'?{kind:'aurabot',humanText:text,speaker:{role:'owner',chat:'private'}}:{kind:'user',connectInputId:id});
 const events=[{type:'user/message',data:{message:{id:'user-'+id,source:origin,content:[{type:'text',text}]}}},{type:'assistant/message',data:{message:{id:'assistant-'+id,content:[{type:'tool-call',id:callId}]}}}];
 return {callId,agent:{id:sessionId,session:{seq:1,eventAt:i=>events[i]}}};
}
async function fixture(t,{uncertain=false}={}){
 const root=await mkdtemp(join(tmpdir(),'whalenest-song-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://song.fixture.invalid/v1',apiKey:'key'}}}}));
 const options={instanceId:'songs',dataDir:root,cwd:root,owners:[cc,qq],qq:{enabled:true},clawchat:{route:cc},singing:{enabled:true,providerConfigPath:provider}},cfg={ownerQQ:'1',enabled:true,dryRun:false};
 const counts={posts:0,downloads:0,sends:0,notes:0,qqSends:0};let factory;
 const client=createSongClient(options,{fetchImpl:async(url,o)=>{if(o.method==='POST'){counts.posts++;return Response.json({id:'job-1'});}if(url.endsWith('/audio.flac')){counts.downloads++;return new Response(Buffer.from('fLaC fixture audio'));}return Response.json({status:'succeeded'});}});
 const native={onebot:{state:'connected'},hub:{turnSendersAllOwner:()=>true,sendSegments:async(_chat,segments)=>{assert.ok(segments[0].data.file.startsWith('base64://'),'Remote QQ gateways must receive bytes, not a local server path');counts.qqSends++;return {message_id:'qq-ack'};}}};
 const sent=[];
 const deps={getConfig:()=>cfg,getNative:()=>native,getRoute:id=>id==='qq-session'?qq:cc,client,
  senderFor:(route,sid)=>({send:async input=>{assert.equal(client.list()[0].state,'saved');assert.ok((await readFile(input.filePath)).length);counts.sends++;sent.push({route,sid,input});return uncertain?{state:'uncertain',requestId:'media-held'}:{state:'confirmed',requestId:'media-'+input.requestId,messageId:'cc-ack',kind:'file'};},check:async()=>({state:'uncertain',requestId:'media-held'})})};
 const adapter=createSongAdapter(options,deps);t.after(()=>adapter.close());
 const api={tool(fn){factory=fn;},lazy:name=>name==='mood'?{nudge(){}}:{addEvent:()=>counts.notes++},emit(){},rule(){},onDispose(){},log:{warn(){}}};adapter.module().setup(api);
 const tool=()=>factory({chat:{kind:'private',userId:'1'},level:'full',sessionId:'cc-session'});
 return {root,options,deps,api,adapter,client,counts,sent,tool};
}
test('one song is submitted per real user turn, saved before original-route delivery, and shared across platforms/restart',async t=>{
 const f=await fixture(t),first=await f.tool().execute(args,actor('song','请给我唱一首晚安的歌'));assert.equal(first.state,'queued');
 await f.adapter.advance(first.operationId);assert.equal(f.counts.posts,1);assert.equal(f.counts.sends,1);assert.equal(f.counts.notes,1);assert.equal(f.sent[0].route.channel,'clawchat');assert.equal(f.sent[0].input.allowFileFallback,true);
 const repeat=await f.tool().execute(args,actor('song','请给我唱一首晚安的歌'));assert.equal(repeat.operationId,first.operationId);await f.adapter.advance(first.operationId);assert.equal(f.counts.sends,1);assert.equal(f.counts.notes,1);
 await f.adapter.close();const restarted=createSongAdapter(f.options,f.deps);t.after(()=>restarted.close());restarted.module().setup(f.api);
 const listed=await restarted.managementTool(qq,'qq-session').execute({action:'list'},actor('list','查看歌曲',{channel:'qq'}));assert.equal(listed.items.length,1);assert.equal(listed.items[0].operationId,first.operationId);
 await restarted.managementTool(qq,'qq-session').execute({action:'send',operationId:first.operationId},actor('qq-send','请把这首歌发给我',{channel:'qq'}));assert.equal(f.counts.qqSends,1);
 await restarted.managementTool(qq,'qq-session').execute({action:'send',operationId:first.operationId},actor('qq-send','请把这首歌发给我',{channel:'qq'}));assert.equal(f.counts.qqSends,1);assert.equal(f.counts.posts,1);
 const record=f.client.inspect(first.operationId);record.error='old download timeout';f.client.save(record);
 const status=await restarted.managementTool(cc,'cc-session').execute({action:'status',operationId:first.operationId},actor('status','查询歌曲状态'));assert.equal(status.message,undefined,'An old download error must not hide a confirmed song');
});
test('ordinary chat, design discussion, negative requests, scheduled tasks and unlinked owners cannot generate songs',async t=>{
 const f=await fixture(t);
 for(const [i,text,source]of [['chat','今天聊聊天'],['design','先按照这个逻辑开发唱歌'],['no','不要现在唱歌'],['schedule','请唱一首歌',{kind:'schedule'}],['qq-task','请唱一首歌',{kind:'aurabot',taskId:'automatic',speaker:{role:'owner',chat:'private'}}]])
  assert.equal((await f.tool().execute(args,actor(i,text,{source}))).ok,false,i);
 assert.equal((await f.adapter.managementTool({...cc,sender:'stranger'},'cc-session').execute({action:'list'},actor('stranger','查看歌曲'))).ok,false);
 assert.equal(f.counts.posts,0);
});
test('parallel different requests are serialized before any paid call',async t=>{
 const f=await fixture(t),results=await Promise.all([f.tool().execute(args,actor('one','请唱一首歌')),f.tool().execute(args,actor('two','请唱一首歌'))]);
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(f.counts.posts,1);
});
test('manual recovery saves without auto-sending, then an explicit resend uses the existing song',async t=>{
 const f=await fixture(t),first=await f.tool().execute(args,actor('song','请写一首晚安歌'));
 const recovered=await f.adapter.managementTool(cc,'cc-session').execute({action:'recover',operationId:first.operationId},actor('recover','恢复已有歌曲'));assert.equal(recovered.saved,true);assert.equal(f.counts.sends,0);
 await f.adapter.tick();assert.equal(f.counts.sends,0);
 await f.adapter.managementTool(cc,'cc-session').execute({action:'send',operationId:first.operationId},actor('send','请发送已有歌曲'));assert.equal(f.counts.posts,1);assert.equal(f.counts.sends,1);assert.equal(f.counts.notes,1);
 await f.adapter.managementTool(cc,'cc-session').execute({action:'send',operationId:first.operationId},actor('send','请发送已有歌曲'));assert.equal(f.counts.sends,1);
});
test('unknown delivery is checked rather than resent; self-tests never add fictional shared memories',async t=>{
 const f=await fixture(t,{uncertain:true}),first=await f.tool().execute(args,actor('song','运维自测，请唱一首晚安歌'));await f.adapter.advance(first.operationId);
 assert.equal(f.counts.sends,1);assert.equal(f.counts.notes,0);await f.adapter.managementTool(cc,'cc-session').execute({action:'send',operationId:first.operationId},actor('retry','请发送已有歌曲'));
 assert.equal(f.counts.sends,1);assert.equal(f.counts.posts,1);
});
test('confirmed ClawChat audio can share the original private song page and QQ remains audio-only',async t=>{
 const f=await fixture(t),notices=new Map();await f.adapter.close();
 f.options.singing.playback={enabled:true};
 await writeFile(join(f.root,'song-liveware.json'),JSON.stringify({binding:cc.account,owner:cc.sender,url:'https://app-test.apps.clawling.io/'}));
 const adapter=createSongAdapter(f.options,{...f.deps,queueNotice:n=>notices.set(n.id,n)});t.after(()=>adapter.close());adapter.module().setup(f.api);
 const song=await adapter.create(args,{sessionId:'cc-session'},actor('song','请唱一首歌'));
 await adapter.advance(song.operationId);await adapter.advance(song.operationId);
 assert.equal(f.counts.sends,1);assert.equal(notices.size,1);
 assert.match([...notices.values()][0].replyNotice.appendix,new RegExp('/song/'+song.operationId+'$'));
 await adapter.managementTool(cc,'cc-session').execute({action:'open',operationId:song.operationId},actor('open','我想看谱'));
 await adapter.managementTool(cc,'cc-session').execute({action:'open',operationId:song.operationId},actor('open','我想看谱'));
 assert.equal(f.counts.sends,1);assert.equal(notices.size,2);
 await adapter.managementTool(qq,'qq-session').execute({action:'send',operationId:song.operationId},actor('send','请重发这首歌',{channel:'qq'}));
 assert.equal(f.counts.qqSends,1);assert.equal(notices.size,2);assert.equal(f.counts.posts,1);
});
test('an interrupted submission is retained as uncertain on restart without a new create',async t=>{
 const f=await fixture(t),first=await f.tool().execute(args,actor('song','请唱一首歌'));const record=f.client.inspect(first.operationId);delete record.jobId;record.state='submitting';f.client.save(record);
 await f.adapter.close();const restarted=createSongAdapter(f.options,f.deps);t.after(()=>restarted.close());restarted.module().setup(f.api);await restarted.tick();
 assert.equal(f.client.inspect(first.operationId).state,'uncertain');assert.equal(f.counts.posts,1);assert.equal(f.counts.sends,0);
});
test('QQ falls back to a file only after the original gateway classifier proves the voice was rejected',async t=>{
 const f=await fixture(t),first=await f.tool().execute(args,actor('song','请唱一首歌'));await f.adapter.advance(first.operationId);const n=f.deps.getNative();let files=0;
 n.hub.sendSegments=async()=>{throw new OneBotError('send_private_msg',{status:'failed',retcode:100,message:'upload rejected'});};
 n.onebot.call=async(action,params,settings)=>{assert.equal(action,'upload_private_file');assert.equal(settings.retries,0);assert.ok(params.file.startsWith('base64://'));files++;return {};};
 const result=await f.adapter.managementTool(qq,'qq-session').execute({action:'send',operationId:first.operationId},actor('qq-file','请发送已有歌曲',{channel:'qq'}));
 assert.equal(result.state,'confirmed');assert.equal(result.kind,'file');assert.equal(result.messageId,undefined);assert.equal(result.acknowledgement,'qq-file-upload');assert.equal(files,1);
});
test('async failures queue one stable original-route notice and hold repeated downloads',async t=>{
 const f=await fixture(t),notices=new Map();await f.adapter.close();
 const restarted=createSongAdapter(f.options,{...f.deps,queueNotice:n=>notices.set(n.id,n)});t.after(()=>restarted.close());restarted.module().setup(f.api);
 const first=await restarted.create(args,{sessionId:'cc-session'},actor('song','请唱一首歌'));const poll=f.client.poll;f.client.poll=async()=>{throw Error('temporary service failure');};
 await restarted.advance(first.operationId);assert.equal(notices.size,1);assert.equal([...notices.values()][0].route.conversation,'dm');assert.equal(f.client.inspect(first.operationId).pollingHeld,true);
 await restarted.tick();assert.equal(notices.size,1);f.client.poll=poll;
 await restarted.managementTool(cc,'cc-session').execute({action:'recover',operationId:first.operationId},actor('recover','恢复已有歌曲'));assert.equal(f.client.inspect(first.operationId).state,'saved');assert.equal(f.counts.posts,1);assert.equal(f.counts.sends,0);
});
