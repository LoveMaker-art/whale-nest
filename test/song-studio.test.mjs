import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {createSongAlignment} from '../src/song-alignment.mjs';
import {createSongClient} from '../src/song-client.mjs';
import {startSongPlayback} from '../src/song-playback.mjs';
import {songRequestMaterial} from '../src/song-studio.mjs';
import {ownerScope} from '../src/routing.mjs';

const owner = 'usr_owner', guest = 'usr_guest', stranger = 'usr_stranger';
const route = {channel:'clawchat',kind:'private',account:'dsh',sender:owner,conversation:'private'};
const id = char=>'whalenest-song-'+char.repeat(64);
const melodyAsset = await readFile(new URL('../vendor/platform-liveware/songsmith/static/melody.js',import.meta.url),'utf8');
const exports = {};
runInNewContext(melodyAsset,exports);
const motif = exports.Melody.fromEvents([[0,4,60],[4,4,64],[8,4,67],[12,4,72]],{bpm:100,key:'C'}).abc;
const plan = exports.Melody.fromEvents([[0,4,62],[4,4,65],[8,4,69],[12,4,74]],{bpm:100,key:'C'}).abc;
const metadata = {title:'实际样曲',style:'Mandarin acoustic folk warm female vocal, 100 BPM',lyrics:'[Verse]\n一行\n第二行'};

async function fixture(t, fetchImpl, extra={}) {
  const dir = await mkdtemp(join(tmpdir(),'whalenest-studio-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const providerConfigPath = join(dir,'provider.json');
  await writeFile(providerConfigPath,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://music.invalid/v1',apiKey:'test'}}}}));
  const options = {instanceId:'song-test',dataDir:dir,owners:[route],clawchat:{route},
    singing:{enabled:true,providerConfigPath,playback:{enabled:true,port:0,audience:[guest],...extra}}};
  return {dir,options,client:createSongClient(options,{fetchImpl})};
}

async function savedRecord(f, requestId, fields={}) {
  const directory = join(f.dir,'media/outgoing/songs');
  const path = join(directory,requestId+'.wav');
  await mkdir(directory,{recursive:true});
  const sample = Buffer.from('RIFFFAKEWAVE sample');
  await writeFile(path,sample);
  const record = {scope:ownerScope(f.options),requestId,
    state:'saved',parameters:metadata,artifact:{path,mime:'audio/wav',size:sample.length},durationMs:20000,...fields};
  f.client.save(record);
  return record;
}

test('SongSmith writes only through authenticated owner or audience actions, and serves precise shared versions',async t=>{
  const f = await fixture(t);
  const first = await savedRecord(f,id('a'),{createdAt:'2026-11-22T00:00:00Z'});
  const second = await savedRecord(f,id('b'),{createdAt:'2026-11-23T00:00:00Z',projectId:first.requestId,parentId:first.requestId,version:2});
  await savedRecord(f,id('c'),{parameters:{...metadata,title:'仅主人知道的另一首'}});
  f.client.save({...first,requestId:id('d'),projectId:first.requestId,version:3,state:'running',stage:'composing'});
  const server = await startSongPlayback(f.options,{client:f.client});
  t.after(()=>server.close());
  const base = 'http://127.0.0.1:'+server.port;
  const get = (viewer,path,extra={})=>fetch(base+path,{headers:{'x-clawchat-user-id':viewer},...extra});
  const data = async viewer=>(await get(viewer,'/api/data')).json();
  const initial = await data(owner);
  assert.equal(initial.isOwner,true);
  const admin = await (await get(owner,'/api/admin')).json();
  assert.equal(admin.production.projects,2);
  assert.equal(admin.production.total,3);
  assert.equal(admin.friends.count,1);
  assert.match(await (await get(owner,'/admin')).text(),/鲸栖歌曲后台/);
  assert.equal((await get(guest,'/admin')).status,404);
  const gallery = initial.projects.find(item=>item.slug===first.requestId);
  assert.deepEqual(gallery.takes.map(take=>take.v),[1,2]);
  assert.deepEqual(initial.busy.map(work=>work.version),[3]);
  assert.match(await (await get(owner,'/song/'+second.requestId)).text(),new RegExp('#/p/'+first.requestId+'/v2'));
  const make = async (viewer,path,details,token=initial.actionToken,extra={})=>
    get(viewer,'/api/'+path+'?'+new URLSearchParams({...details,token}),{method:'POST',...extra});
  const audio = gallery.takes[1].audio;
  assert.equal((await get(stranger,'/')).status,404);
  assert.equal((await get(guest,audio)).status,404);
  assert.equal((await make(owner,'share',{op:'set',audio},'old-token')).status,405);
  assert.equal((await make(owner,'share',{op:'set',audio},initial.actionToken,
    {headers:{'x-clawchat-user-id':owner,'sec-fetch-site':'cross-site'}})).status,405);
  assert.equal((await make(guest,'share',{op:'set',audio})).status,400);
  assert.equal((await make(owner,'share',{op:'set',audio,title:'给好友听的第二版'})).status,200);
  let other = await data(guest);
  assert.deepEqual(other.projects,[]);
  assert.deepEqual(other.shared.map(song=>song.title),['给好友听的第二版']);
  assert.ok(other.shared[0].tags.includes('lang.zh'));
  assert.ok(!JSON.stringify(other).includes('仅主人知道的另一首'));
  assert.equal((await get(guest,gallery.takes[0].audio)).status,404);
  assert.equal((await get(guest,audio)).status,200);
  assert.equal((await get(guest,gallery.takes[1].score)).status,404);
  assert.equal((await make(guest,'like',{op:'set',audio})).status,200);
  const note = {op:'add',audio,text:'好听',request:'4b3d6683-af74-4655-8230-16ca1a8daaaa'};
  assert.equal((await make(guest,'comment',note)).status,200);
  assert.equal((await make(guest,'comment',note)).status,200);
  other = await data(guest);
  assert.equal(other.shared[0].likes,1);
  assert.equal(other.shared[0].comments.length,1);
  assert.equal((await make(guest,'admin',{op:'set',key:'comments',on:'0'})).status,400);
  const closed = await (await make(owner,'admin',{op:'set',key:'comments',on:'0'})).json();
  assert.equal(closed.conf.comments,false);
  assert.equal((await data(guest)).shared[0].comments.length,0);
  assert.equal((await make(guest,'comment',note)).status,400);
  assert.equal((await make(owner,'admin',{op:'set',key:'comments',on:'1'})).status,200);
  assert.equal((await data(guest)).shared[0].comments.length,1);
  assert.equal((await make(owner,'comment',{op:'del',id:other.shared[0].comments[0].id})).status,200);
  assert.equal((await make(owner,'share',{op:'unset',audio})).status,200);
  assert.equal((await get(guest,audio)).status,404);
  assert.equal((await make(owner,'delete',{op:'take',audio})).status,200);
  assert.equal((await get(owner,audio)).status,404);
  assert.ok(await readFile(second.artifact.path),'Archiving keeps the original bytes and rollback data');
  assert.equal(f.client.inspect(second.requestId).version,2);

  const transfer = {id:'testmelody',kind:'draw'};
  const bytes = Buffer.from(motif).toString('base64');
  assert.equal((await make(guest,'hum',{...transfer,op:'chunk',off:0,data:bytes})).status,400);
  const chunk = await make(owner,'hum',{...transfer,op:'chunk',off:0,data:bytes});
  assert.ok((await chunk.json()).ok);
  const stored = await (await make(owner,'hum',{...transfer,op:'commit'})).json();
  assert.match(stored.id,/^draw-[a-f0-9]{32}$/);
  const material = await songRequestMaterial(f.dir,f.client,'写歌：沿用旋律 〔旋律:'+stored.id+':whole〕');
  assert.equal(material.abc,motif);
  assert.equal(material.melodyMode,'whole');
  const prior = await songRequestMaterial(f.dir,f.client,'改歌：保留第三句 〔版本:'+first.requestId+':change〕');
  assert.deepEqual(prior,{projectId:first.requestId,parentId:first.requestId,version:4});

  const cover = Buffer.from([0xff,0xd8,0xff,0xdb,0,0]);
  const upload = {project:first.requestId,id:'testcover'};
  assert.ok((await (await make(owner,'cover',{...upload,op:'chunk',off:0,data:cover.toString('base64')})).json()).ok);
  const image = await (await make(owner,'cover',{...upload,op:'commit'})).json();
  assert.deepEqual(Buffer.from(await (await get(owner,image.cover)).arrayBuffer()),cover);
  assert.equal((await get(guest,image.cover)).status,404);
});

test('MusicHub retries reuse recorded plan and performance receipts while keeping the grafted notes',async t=>{
  const posts = [];
  let unknown = false;
  const fetchImpl = async (url, request)=>{
    if (request.method === 'POST') {
      if (url.endsWith('/cancel')) return Response.json({ok:true});
      const payload = JSON.parse(request.body);
      posts.push(payload);
      if (payload.abc && unknown) throw new Error('Performance acknowledgement lost');
      return Response.json({id:payload.abc?'performance':'plan'});
    }
    if (url.endsWith('/plan/score.abc')) return new Response(plan);
    if (url.endsWith('/plan')) return Response.json({status:'running',has_score:true,stage:'composing'});
    return Response.json({status:'succeeded',stage:'saving'});
  };
  const f = await fixture(t,fetchImpl);
  const material = {abc:motif,melodyKind:'draw',melodyMode:'graft'};
  const opts = {requestId:id('e'),route,sessionId:'session',material};
  const submitted = await f.client.create(metadata,opts);
  assert.equal(submitted.planJobId,'plan');
  assert.equal(posts[0].cot,'full');
  const reopened = createSongClient(f.options,{fetchImpl});
  const performed = await reopened.poll(opts.requestId);
  assert.equal(performed.jobId,'performance');
  assert.equal(performed.melodySection,'chorus');
  assert.equal(posts[1].cot,'melody');
  assert.match(posts[1].abc,/% chorus\nV: Vocal\nC4E4G4c4\|/);
  assert.equal((await reopened.poll(opts.requestId)).state,'ready');
  await reopened.create(metadata,opts);
  assert.equal(posts.length,2);

  const uncertain = {...opts,requestId:id('f')};
  await reopened.create(metadata,uncertain);
  unknown = true;
  assert.equal((await reopened.poll(uncertain.requestId)).state,'uncertain');
  const afterFailure = createSongClient(f.options,{fetchImpl});
  assert.equal((await afterFailure.create(metadata,uncertain)).state,'uncertain');
  await assert.rejects(afterFailure.poll(uncertain.requestId),/没有可查询的任务ID/);
  assert.equal(posts.length,4);
});

test('Optional alignment stores real timing anchors only after the owner starts it',async t=>{
  const f = await fixture(t);
  const score = await savedRecord(f,id('1'));
  const configPath = join(f.dir,'alignment.json');
  await writeFile(configPath,JSON.stringify({baseUrl:'https://align.invalid',apiKey:'fixture'}));
  f.options.singing.playback.alignment = {configPath,ffmpeg:join(f.dir,'absent-ffmpeg')};
  let calls = 0;
  const alignment = createSongAlignment(f.options,{fetchImpl:async (url,request)=>{
    assert.equal(url.href,'https://align.invalid/api/align');
    assert.deepEqual(JSON.parse(request.body.get('lines')),['一行','第二行']);
    assert.equal(request.body.get('audio').size,score.artifact.size);
    calls++;
    return Response.json({ok:true,lines:[{source:'asr',index:0,start:1.2},{source:'asr',index:1,start:6.8}]});
  }});
  t.after(()=>alignment.close());
  const sections = [{tag:'Verse',lines:['一行','第二行']}];
  assert.equal(alignment.view(score,sections).canRefine,true);
  assert.equal(calls,0);
  alignment.start(score,sections);
  alignment.start(score,sections);
  await new Promise((resolve,reject)=>{
    const start = Date.now();
    const interval = setInterval(()=>{
      if (alignment.view(score,sections).timing.kind === 'measured') { clearInterval(interval); resolve(); }
      else if (Date.now()-start > 3000) { clearInterval(interval); reject(new Error('Alignment did not finish')); }
    },20);
  });
  assert.equal(calls,1);
  const reopen = createSongAlignment(f.options);
  assert.deepEqual(reopen.view(score,sections).align[0].lineT,[1.2,6.8]);
});
