import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createSongAdapter} from '../src/song-adapter.mjs';
import {createSongClient} from '../src/song-client.mjs';
import {startSongPlayback} from '../src/song-playback.mjs';
const route={channel:'clawchat',account:'dsh',sender:'usr_owner',conversation:'dm',kind:'private'};
const abc='X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=87\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:Eb\n% verse\nV: Vocal\ne4B2f2z2c2A2B2|c2f2z2b2e8|\nV: Ins\nZ2|\n% chorus\nV: Vocal\ne4B2f2z2c2A2B2|c2f2z2b2e8|\nV: Ins\nZ2|\n';
const words={title:'自己的光',lyrics:'[Verse]\n我不想再等谁来给我光\n[Chorus]\n我就是我自己的那道光',style:'Mandarin Chinese rock, warm female vocal, electric guitar, clear diction, 87 BPM'};
function actor(text){
 const callId='call',events=[{type:'user/message',data:{message:{id:'owner-turn',source:{kind:'user',connectInputId:'input'},content:[{type:'text',text}]}}},{type:'assistant/message',data:{message:{id:'assistant',content:[{type:'tool-call',id:callId}]}}}];
 return {callId,agent:{id:'session',session:{seq:1,eventAt:i=>events[i]}}};
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-melody-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://music.invalid/v1',apiKey:'fixture'}}}}));
 const options={instanceId:'melody',dataDir:root,cwd:root,owners:[route],clawchat:{route},singing:{enabled:true,providerConfigPath:provider,playback:{enabled:true,port:0}}};
 await writeFile(join(root,'song-liveware.json'),JSON.stringify({binding:route.account,owner:route.sender,url:'https://app-fixture.apps.clawling.io/'}));
 const posts=[];const client=createSongClient(options,{fetchImpl:async(_url,request)=>{assert.equal(request.method,'POST');posts.push(JSON.parse(request.body));return Response.json({id:'job-fixture'});}});
 const adapter=createSongAdapter(options,{client,getConfig:()=>({ownerQQ:'1'}),getNative:()=>({}),getRoute:()=>route});t.after(()=>adapter.close());
 const id=kind=>kind+'-'+createHash('sha256').update(abc).digest('hex').slice(0,32);
 const store=async kind=>{await mkdir(join(root,'media/song-melodies'),{recursive:true});await writeFile(join(root,'media/song-melodies',id(kind)+'.json'),JSON.stringify({id:id(kind),abc,createdAt:'2026-11-24T04:27:22Z'}));return id(kind);};
 return {root,options,client,adapter,posts,id,store};
}
test('both saved melody kinds are readable by the model and receipts state the actual adopted score',async t=>{
 for(const kind of ['hum','draw']){
  const f=await fixture(t),id=await f.store(kind),text='写歌：给自己加油 〔旋律:'+id+':whole〕';
  const draft=await f.adapter.managementTool(route,'session').execute({action:'draft'},actor(text));
  assert.equal(draft.ok,true);assert.equal(draft.melody.id,id);assert.equal(draft.melody.sections.length,2);
  assert.deepEqual(draft.melody.sections.map(s=>s.phrases.map(p=>p.notes)),[[10],[10]]);
  assert.equal(f.posts.length,0,'Reading a draft cannot generate anything');
  const result=await f.adapter.create(words,{sessionId:'session'},actor(text));
  assert.equal(result.melody.id,id);assert.equal(result.melody.mode,'whole');assert.equal(result.melody.attached,true);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].abc,abc);assert.equal(f.posts[0].cot,'melody');
 }
});
test('the actual excessive lyrics are rejected before a paid submission and the same turn can correct them',async t=>{
 const f=await fixture(t),id=await f.store('hum'),text='写歌：摇滚 〔旋律:'+id+':whole〕';
 const excessive={...words,lyrics:Array(8).fill(words.lyrics).join('\n')};
 await assert.rejects(f.adapter.create(excessive,{sessionId:'session'},actor(text)),/歌词|乐句|段落|音符/);
 assert.equal(f.posts.length,0);assert.equal(f.client.list().length,0);
 assert.equal((await f.adapter.create(words,{sessionId:'session'},actor(text))).state,'queued');
 assert.equal(f.posts.length,1);
});
test('the default melody route extends a song and an accepted owner project opens while it is being made',async t=>{
 const f=await fixture(t),id=await f.store('draw'),text='写歌：海边的夏夜 〔旋律:'+id+'〕';
 const result=await f.adapter.create(words,{sessionId:'session'},actor(text));
 assert.equal(f.client.inspect(result.operationId).composition.melodyMode,'graft');
 assert.equal(f.posts[0].cot,'full');assert.equal(f.posts[0].abc,undefined);
 assert.match(result.page,/\/song\/whalenest-song-/);
 const server=await startSongPlayback(f.options,{client:f.client,readAgentId:()=> 'usr_agent'});t.after(()=>server.close());
 const path=new URL(result.page).pathname;
 assert.equal((await fetch('http://127.0.0.1:'+server.port+path,{headers:{'x-clawchat-user-id':route.sender}})).status,200);
 assert.equal((await fetch('http://127.0.0.1:'+server.port+path)).status,404);
});
test('melody upload retains validated phrase metadata and rejects a forged note plan',async t=>{
 const f=await fixture(t),server=await startSongPlayback(f.options,{client:f.client,readAgentId:()=> 'usr_agent'});t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.port,headers={'x-clawchat-user-id':route.sender};
 const data=await(await fetch(base+'/api/data',{headers})).json();
 const send=async params=>fetch(base+'/api/hum?'+new URLSearchParams({...params,token:data.actionToken}),{method:'POST',headers});
 const transfer={id:'fixture123',kind:'draw'};
 await send({...transfer,op:'chunk',off:0,data:Buffer.from(abc).toString('base64')});
 const meta={bpm:87,key:'Eb',bars:4,seconds:11.034,sections:[{tag:'verse',bars:[1,2],phrases:[{notes:10,bars:[1,2]}]},{tag:'chorus',bars:[3,4],phrases:[{notes:10,bars:[3,4]}]}],quality:{kind:'fixture'}};
 const stored=await(await send({...transfer,op:'commit',meta:JSON.stringify(meta)})).json();
 const saved=JSON.parse(await readFile(join(f.root,'media/song-melodies',stored.id+'.json'),'utf8'));
 assert.deepEqual(saved.sections,meta.sections);assert.equal(saved.bpm,87);assert.equal(saved.kind,'draw');
 await send({...transfer,op:'chunk',off:0,data:Buffer.from(abc).toString('base64')});
 meta.sections[0].phrases[0].notes=100;
 assert.equal((await send({...transfer,op:'commit',meta:JSON.stringify(meta)})).status,400);
});

test('short-score creation stays idempotent across asynchronous inspection and invalid style never submits',async t=>{
 const f=await fixture(t);
 const material={abc,melodyKind:'hum',melodyMode:'whole'};
 const requestId='whalenest-song-'+'7'.repeat(64),opts={requestId,route,material};
 const results=await Promise.all([f.client.create(words,opts),f.client.create(words,opts)]);
 assert.equal(results[0].jobId,results[1].jobId);assert.equal(f.posts.length,1);
 await assert.rejects(f.client.create({...words,style:'摇滚，粗粝的电吉他失真'}, {...opts,requestId:'whalenest-song-'+'8'.repeat(64)}),/英文/);
 assert.equal(f.posts.length,1);
});

test('source queries, manual tags and exported files preserve the original work and do not regenerate it',async t=>{
 const f=await fixture(t),melodyId=await f.store('hum');
 const result=await f.adapter.create(words,{sessionId:'session'},actor('写歌：海边 〔旋律:'+melodyId+':whole〕'));
 let record=f.client.inspect(result.operationId);record.state='saved';record.artifact={path:'unused',size:10,mime:'audio/wav'};f.client.save(record);
 await writeFile(join(f.root,'media/song-requests',record.requestId+'.abc'),abc);
 const notices=[];
 await f.adapter.close();
 const adapter=createSongAdapter(f.options,{client:f.client,getConfig:()=>({ownerQQ:'1'}),getNative:()=>({}),getRoute:()=>route,
  senderFor:()=>({send:async input=>{notices.push(await readFile(input.filePath,'utf8'));return {state:'confirmed',requestId:input.requestId,messageId:'ack-file'};}})});
 t.after(()=>adapter.close());
 const tool=adapter.managementTool(route,'session');
 const inspected=await tool.execute({action:'inspect',operationId:record.requestId},actor('查看这首歌原来的歌词和旋律'));
 assert.equal(inspected.lyrics,words.lyrics);assert.equal(inspected.melody.id,melodyId);
 const draft=await tool.execute({action:'draft',operationId:record.requestId},actor('看看这首歌的精修资料'));
 assert.equal(draft.previous.lyrics,words.lyrics);assert.deepEqual(draft.melody.sections.map(s=>s.phrases[0].notes),[10,10]);
 const tagged=await tool.execute({action:'tags',operationId:record.requestId,tags:['给自己','白饭']},actor('把这首的标签设为给自己和白饭'));
 assert.deepEqual(tagged.tags,['给自己','白饭']);
 for(const format of ['lyrics','score']){
  const ctx=actor('请发这首歌的歌词和乐谱文件');
  const first=await tool.execute({action:'file',format,operationId:record.requestId},ctx);
  assert.equal(first.state,'confirmed');
  await tool.execute({action:'file',format,operationId:record.requestId},ctx);
 }
 assert.deepEqual(notices,[words.lyrics,abc]);assert.equal(f.posts.length,1);
});

test('plain-chat revisions keep the original score and create the next version only for an explicit request',async t=>{
 const f=await fixture(t),id=await f.store('draw');
 const original=await f.adapter.create(words,{sessionId:'session'},actor('写歌：自己的光 〔旋律:'+id+':whole〕'));
 const record=f.client.inspect(original.operationId);record.state='saved';f.client.save(record);
 await writeFile(join(f.root,'media/song-requests',record.requestId+'.abc'),abc);
 const ctx=actor('这首歌的词改一下，旋律别动');ctx.agent.session.eventAt(0).data.message.id='revision-user';
 const next=await f.adapter.create({...words,sourceOperationId:record.requestId,cfgScale:2},{sessionId:'session'},ctx);
 assert.equal(next.version,2);assert.equal(f.posts[1].abc,abc);assert.equal(f.posts[1].cfg_scale,2);
 const unrelated=actor('今天吃什么');unrelated.agent.session.eventAt(0).data.message.id='unrelated-user';
 await assert.rejects(f.adapter.create({...words,sourceOperationId:record.requestId},{sessionId:'session'},unrelated),/明确请求|明确要求/);
 assert.equal(f.posts.length,2);
});

test('copied scores allow a scoped melody correction and refuse changes outside the requested bars',async t=>{
 const f=await fixture(t),id=await f.store('hum');
 const text='写歌：修正第一句旋律 〔旋律:'+id+':whole〕';
 const inside=abc.replace('e4B2','g4B2');
 const outside=inside.replace('e4B2','g4B2');
 await assert.rejects(f.adapter.create({...words,scoreEdit:{mode:'phrase',startBar:1,endBar:1,abc:outside}},{sessionId:'session'},actor(text)),/以外/);
 assert.equal(f.posts.length,0);
 const result=await f.adapter.create({...words,scoreEdit:{mode:'phrase',startBar:1,endBar:1,abc:inside}},{sessionId:'session'},actor(text));
 assert.equal(f.posts[0].abc,inside);assert.equal(result.melody.edit.verified,true);
 assert.equal(JSON.parse(await readFile(join(f.root,'media/song-melodies',id+'.json'),'utf8')).abc,abc,'The source melody stays unchanged');
});

test('tempo edits preserve note and meter invariants and must agree with the style tempo',async t=>{
 const f=await fixture(t),id=await f.store('draw'),text='写歌：速度慢一点但旋律别动 〔旋律:'+id+':whole〕';
 const scoreEdit={mode:'tempo',abc:abc.replace('Q:1/4=87','Q:1/4=70')};
 await assert.rejects(f.adapter.create({...words,scoreEdit},{sessionId:'session'},actor(text)),/BPM/);
 assert.equal(f.posts.length,0);
 const result=await f.adapter.create({...words,style:words.style.replace('87 BPM','70 BPM'),scoreEdit},{sessionId:'session'},actor(text));
 assert.equal(result.melody.bpm,70);assert.equal(result.melody.edit.preserved,'all-sounding-notes');
 assert.equal(f.posts.length,1);
});

test('score-based lyric positions are available without an aligner and are explicitly approximate',async t=>{
 const f=await fixture(t),id=await f.store('hum');
 const result=await f.adapter.create(words,{sessionId:'session'},actor('写歌：自己的光 〔旋律:'+id+':whole〕'));
 const r=f.client.inspect(result.operationId);r.state='saved';r.durationMs=12000;r.artifact={path:join(f.root,'media/outgoing/songs',r.requestId+'.wav'),size:32,mime:'audio/wav'};f.client.save(r);
 const server=await startSongPlayback(f.options,{client:f.client,readAgentId:()=> 'usr_agent'});t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+server.port+'/api/data',{headers:{'x-clawchat-user-id':route.sender}});
 const take=(await response.json()).projects[0].takes[0];
 assert.equal(take.timing.kind,'score');assert.equal(take.timing.fit,1);assert.ok(take.align[0].lineT1[0]>take.align[0].lineT[0]);
 assert.ok(take.align[1].lineT[0]>take.align[0].lineT[0]);assert.equal(take.canRefine,false);
});

test('reading an old song, preferring its old version and cancelling do not authorize a paid revision',async t=>{
 const f=await fixture(t),sourceOperationId='whalenest-song-'+'4'.repeat(64);
 for(const text of ['查看这首歌歌词','上一版更好听','不要修改这首歌','please do not generate a song']){
  await assert.rejects(f.adapter.create({...words,sourceOperationId},{sessionId:'session'},actor(text)),/没有要求|明确请求|明确要求/);
 }
 assert.equal(f.posts.length,0);
});

test('all six page languages keep draft meaning and bare requests never skip the topic question',async t=>{
 const {isBareSongRequest,songBriefQuestion}=await import('../src/song-adapter.mjs');
 for(const [bare,prefix] of [['写歌','写歌：'],['寫歌','寫歌：'],['Write a song','Write a song: '],['作曲','作曲：'],['노래 만들기','노래 만들기: '],['Crear una canción','Crear una canción: ']]){
  const f=await fixture(t);
  assert.equal(isBareSongRequest(bare),true);assert.ok(songBriefQuestion(bare));
  await assert.rejects(f.adapter.create(words,{sessionId:'session'},actor(bare)),/先问/);
  const result=await f.adapter.create(words,{sessionId:'session'},actor(prefix+'海边的晚风'));
  assert.equal(result.state,'queued');assert.equal(f.posts.length,1);
 }
});

test('arrangement and section edits pass through the same checked original-score route',async t=>{
 for(const mode of ['arrangement','structure']){
  const f=await fixture(t),id=await f.store('draw');
  const changed=mode==='arrangement'?abc.replace('e4B2','"C"e4B2'):abc+'% outro\nV: Vocal\nC4E4G4c4|\nV: Ins\nZ|\n';
  const lyrics=words.lyrics+(mode==='structure'?'\n[Outro]\n白饭来了':'');
  const result=await f.adapter.create({...words,lyrics,scoreEdit:{mode,abc:changed}},{sessionId:'session'},actor('写歌：'+(mode==='structure'?'加一段结尾':'换个编曲，旋律别动')+' 〔旋律:'+id+':whole〕'));
  assert.equal(result.melody.edit.verified,true);assert.equal(f.posts[0].abc,changed);
  assert.equal(JSON.parse(await readFile(join(f.root,'media/song-melodies',id+'.json'),'utf8')).abc,abc);
 }
});
