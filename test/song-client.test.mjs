import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../src/routing.mjs';
import {createSongClient} from '../src/song-client.mjs';
import {enablePlatformSinging,protectSongRollback} from '../src/runtime-upgrade.mjs';
import {createServer} from 'node:http';

const parameters={title:'小鱼的歌',lyrics:'[Verse]\n小鱼游过清晨的光',style:'gentle female vocal, acoustic pop'};
const id='whalenest-song-'+hash('song');
const route={channel:'clawchat',account:'agent',sender:'owner',conversation:'dm',kind:'private'};
const audio=Buffer.from('fLaC fixture audio');
async function fixture(t,behavior={}){
 const root=await mkdtemp(join(tmpdir(),'whalenest-song-client-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://api.fixture.invalid/v1',apiKey:'private-fixture-key'}}}}));
 const options={instanceId:'songs',dataDir:root,singing:{enabled:true,providerConfigPath:provider,...behavior.settings}},requests=[];
 const fetchImpl=async(url,args)=>{
  requests.push({url,args});assert.equal(args.redirect,'error');assert.equal(args.headers.Authorization,'Bearer private-fixture-key');
  if(args.method==='POST'){if(behavior.reject)throw Error('connection lost after submit');return Response.json(behavior.noId?{}:{id:'song-job-1'});}
  if(url.endsWith('/audio.flac'))return new Response(behavior.audio??audio);
  return Response.json({status:behavior.status??'succeeded',stage:'saving'});
 };
 return {options,requests,client:createSongClient(options,{fetchImpl}),fetchImpl};
}
test('MusicHub uses the paired origin root, one durable POST, and authenticated FLAC retrieval across restart',async t=>{
 const f=await fixture(t);await f.client.create(parameters,{requestId:id,route,sessionId:'session'});
 const request=f.requests[0];assert.equal(request.url,'https://api.fixture.invalid/api/jobs');
 const body=JSON.parse(request.args.body);assert.equal(body.voice_preset,'none');assert.equal(body.lyrics,parameters.lyrics);assert.equal(body.cot,'full');assert.equal(body.max_tokens,9000);assert.equal(body.voice,undefined);
 const restarted=createSongClient(f.options,{fetchImpl:f.fetchImpl});await restarted.create(parameters,{requestId:id,route,sessionId:'session'});
 assert.equal(f.requests.filter(r=>r.args.method==='POST').length,1);
 await restarted.poll(id);const saved=await restarted.download(id);assert.equal(saved.state,'saved');assert.deepEqual(await readFile(saved.artifact.path),audio);
 assert.equal(restarted.list().length,1);assert.equal(restarted.list()[0].route.conversation,'dm');
 await restarted.download(id);assert.equal(f.requests.filter(r=>r.url.endsWith('/audio.flac')).length,1);
 await assert.rejects(restarted.create({...parameters,title:'另一首'},{requestId:id,route,sessionId:'session'}),/同一主人回合/);
});
test('lost create responses and missing task IDs never cause a second paid submission',async t=>{
 for(const behavior of [{reject:true},{noId:true}]){
  const f=await fixture(t,behavior),first=await f.client.create(parameters,{requestId:id,route,sessionId:'session'});assert.equal(first.state,'uncertain');
  await createSongClient(f.options,{fetchImpl:f.fetchImpl}).create(parameters,{requestId:id,route,sessionId:'session'});
  assert.equal(f.requests.length,1);await assert.rejects(f.client.poll(id),/没有可查询/);
 }
});
test('concurrent duplicate creation shares one POST, and platform voice IDs are checked before any request',async t=>{
 const f=await fixture(t);await Promise.all([f.client.create(parameters,{requestId:id,route,sessionId:'session'}),f.client.create(parameters,{requestId:id,route,sessionId:'session'})]);
 assert.equal(f.requests.length,1);await assert.rejects(f.client.create({...parameters,voicePreset:'longanfengyue'},{requestId:'whalenest-song-'+hash('other'),route}),/none\/hope/);assert.equal(f.requests.length,1);
});
test('failed jobs, oversized results and invalid audio retain their original task without resubmission',async t=>{
 const failed=await fixture(t,{status:'failed'});await failed.client.create(parameters,{requestId:id,route});assert.equal((await failed.client.poll(id)).state,'failed');await assert.rejects(failed.client.download(id),/尚未确认/);
 for(const behavior of [{settings:{maxBytes:8}},{audio:Buffer.from('not music')}]){
  const f=await fixture(t,behavior);await f.client.create(parameters,{requestId:id,route});await f.client.poll(id);await assert.rejects(f.client.download(id));assert.equal(f.client.inspect(id).state,'ready');
  assert.equal(f.requests.filter(r=>r.args.method==='POST').length,1);
 }
});
test('changing provider origins cannot send the current key to an old job host',async t=>{
 const f=await fixture(t);await f.client.create(parameters,{requestId:id,route});await writeFile(f.options.singing.providerConfigPath,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://new.fixture.invalid/v1',apiKey:'new-key'}}}}));
 await assert.rejects(f.client.poll(id),/地址已变更/);assert.equal(f.requests.length,1);
});
test('platform enablement preserves settings and rollback disables only the unsupported writer',()=>{
 const singing=enablePlatformSinging({providerConfigPath:'/existing/provider',maxBytes:1234});assert.equal(singing.maxBytes,1234);assert.equal(singing.enabled,true);
 assert.throws(()=>enablePlatformSinging({provider:'external'}));const native={modules:{song:{enabled:true}},song:{enabled:false}},instance={singing};
 assert.equal(protectSongRollback(native,instance,'0.3.0-whalenest.m3.22').disableSinging,false);
 assert.equal(protectSongRollback(native,instance,'0.3.0-whalenest.m3.21').disableSinging,true);assert.equal(native.modules.song.enabled,false);assert.equal(instance.singing.enabled,false);assert.equal(instance.singing.providerConfigPath,'/existing/provider');
});
test('a slow FLAC body outlives the metadata deadline and recovers the same job without another POST',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-song-slow-body-'));t.after(()=>rm(root,{recursive:true,force:true}));let posts=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST'){posts++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'slow-job'}));}
  else if(req.url.endsWith('/audio.flac')){res.writeHead(200,{'content-type':'audio/flac'});res.write('fLaC');setTimeout(()=>res.end(' slow audio body'),300);}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'succeeded'}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'fixture'}}}}));
 const client=createSongClient({instanceId:'slow',dataDir:root,singing:{enabled:true,providerConfigPath:provider}},{requestTimeoutMs:100,downloadTimeoutMs:1000});
 await client.create(parameters,{requestId:id,route});await client.poll(id);const saved=await client.download(id);assert.equal(saved.state,'saved');assert.equal(posts,1);assert.equal((await readFile(saved.artifact.path)).toString(),'fLaC slow audio body');
});
test('an older ready record adopts the platform-advertised WAV, with no request to a foreign result host',async t=>{
 const f=await fixture(t),wav=await readFile(new URL('./fixtures/media/audio.wav',import.meta.url));let files=0;
 await f.client.create(parameters,{requestId:id,route});const record=f.client.inspect(id);record.state='ready';record.error='previous download timeout';f.client.save(record);
 const recovered=createSongClient(f.options,{fetchImpl:async(url,args)=>{
  assert.equal(args.method,'GET');assert.ok(url.startsWith('https://api.fixture.invalid/'));
  if(url.endsWith('/audio.wav')){files++;return new Response(wav);}
  return Response.json({status:'succeeded',audio_url:'/api/jobs/song-job-1/audio.wav',duration_seconds:1.25});
 }});
 const saved=await recovered.download(id);assert.equal(saved.artifact.mime,'audio/wav');assert.equal(saved.durationMs,1250);assert.ok(saved.artifact.path.endsWith('.wav'));assert.equal(saved.error,undefined);assert.equal(saved.lastError,'previous download timeout');assert.equal(files,1);assert.equal(f.requests.filter(r=>r.args.method==='POST').length,1);
 const foreign=await fixture(t);await foreign.client.create(parameters,{requestId:id,route});
 const client=createSongClient(foreign.options,{fetchImpl:async(url)=>{assert.ok(url.startsWith('https://api.fixture.invalid/'));return url.endsWith('/audio.flac')?new Response(audio):Response.json({status:'succeeded',audio_url:'https://foreign.invalid/api/jobs/song-job-1/audio.wav'});}});
 await client.poll(id);assert.equal((await client.download(id)).artifact.mime,'audio/flac');
});

test('independent readers cache one score without racing temporary files or rewriting the song receipt',async t=>{
 const f=await fixture(t);await f.client.create(parameters,{requestId:id,route});
 const record=f.client.inspect(id);record.state='saved';record.delivery={state:'confirmed',messageId:'original-ack'};f.client.save(record);
 const before=await readFile(join(f.options.dataDir,'media/song-requests',id+'.json'),'utf8');
 const score='X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=96\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nC4E4G4c4|\nV: Ins\nZ|\n';
 let reads=0,release;const together=new Promise(resolve=>release=resolve);
 const fetchImpl=async(url,request)=>{assert.equal(request.method,'GET');assert.ok(url.endsWith('/score.abc'));if(++reads===2)release();await together;return new Response(score);};
 const one=createSongClient(f.options,{fetchImpl}),two=createSongClient(f.options,{fetchImpl});
 assert.deepEqual(await Promise.all([one.score(id),two.score(id)]),[score,score]);
 assert.equal(await readFile(join(f.options.dataDir,'media/song-requests',id+'.json'),'utf8'),before);
 assert.equal(one.scoreDetails(id).notes,4);
});

test('legacy accepted parameters remain recoverable without applying new draft rules or creating a second job',async t=>{
 const f=await fixture(t);await f.client.create(parameters,{requestId:id,route});
 const old=f.client.inspect(id);
 old.parameters={...old.parameters,style:'旧版中文曲风',lyrics:Array(16).fill('旧版已经受理的歌词').join('\n')};
 old.composition={abc:'X:1\nK:C\nCDEF|',melodyMode:'whole'};
 old.fingerprint=hash([old.parameters,old.composition]);f.client.save(old);
 const before=await readFile(join(f.options.dataDir,'media/song-requests',id+'.json'),'utf8');
 const reopened=createSongClient(f.options,{fetchImpl:f.fetchImpl});
 const same=await reopened.create(old.parameters,{requestId:id,route,material:old.composition});
 assert.equal(same.jobId,old.jobId);assert.equal(f.requests.length,1);
 assert.equal(await readFile(join(f.options.dataDir,'media/song-requests',id+'.json'),'utf8'),before);
});
