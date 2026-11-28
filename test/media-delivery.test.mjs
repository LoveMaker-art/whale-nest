import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm,readdir,chmod,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {createMediaSender,mediaTools} from '../src/media-delivery.mjs';
import {officialDeliveryPaths,cleanupOfficialDelivery} from '../src/official-delivery.mjs';
import {hash,routeKey,senderKey} from '../src/routing.mjs';
import {writeState} from '../src/state.mjs';

const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'cnv_owner'};
async function fixture(t,send=async()=>({stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'msg-ok'}})})){
 const cwd=await mkdtemp(join(tmpdir(),'whalenest-media-send-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const options={instanceId:'fixture',cwd,dataDir:join(cwd,'data'),owners:[route],media:{maxBytesEach:1024*1024},
  clawchat:{route,delivery:{connectBin:'/fake/core',configPath:'/fake/config',mediaEnabled:true}}};
 const run=async(bin,args,opts)=>args[0]==='__clawnest-state'?{stdout:JSON.stringify({userId:'agent',ownerId:'owner',conversationId:'cnv_owner',connected:true})}:
  args[0]==='plugin'?{stdout:JSON.stringify({running:null})}:send(bin,args,opts);
 for(const name of ['audio.wav','document.txt','video.mp4','image.png'])await copyFile(resolve('test/fixtures/media',name),join(cwd,name));
 const sender=createMediaSender(options,route,{sessionId:'session',run});return {cwd,options,sender,run};
}
const inputOf=args=>JSON.parse(args[args.indexOf('--input-json')+1]);
const jobFor=async(f,id)=>JSON.parse(await readFile(join(officialDeliveryPaths(f.options).root,'jobs',id+'.json')));

test('official image/voice/file tools send to the owner and temporary artifacts are reclaimed',async t=>{
 const calls=[];const f=await fixture(t,async(_bin,args,opts)=>{
  const input=inputOf(args);calls.push(args[2]);assert.equal(input.chat_id,'cnv_owner');assert.equal(input.chat_type,'direct');
  assert.equal(opts.signal,undefined,'Cancelling the waiter must not kill an accepted sender');
  assert.ok((await readFile(input.path)).length);assert.ok(input.path.includes('.whalenest-delivery'));
  assert.equal(input.sha256,undefined);return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'msg-'+calls.length}})};
 });
 for(const [name,kind]of [['image.png','image'],['audio.wav','audio'],['document.txt','file'],['video.mp4','unknown']]){
  const input={filePath:join(f.cwd,name),requestId:name};const first=await f.sender.send(input);
  assert.equal(first.state,'confirmed');assert.equal(first.kind,kind);
  await writeFile(input.filePath,'edited original');
  const resumed=createMediaSender(f.options,route,{sessionId:'session',run:f.run});
  assert.equal((await resumed.send(input)).messageId,first.messageId);
 }
 assert.deepEqual(calls,['clawchat_send_image','clawchat_send_voice','clawchat_send_file','clawchat_send_file']);
 await delay(30);f.sender.cleanup();assert.deepEqual(await readdir(officialDeliveryPaths(f.options).temporary),[]);
});

test('a read-only stable Workspace file is sent directly and never removed',async t=>{
 let path;const f=await fixture(t,async(_bin,args)=>{path=inputOf(args).path;return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'direct'}})};});
 const source=join(f.cwd,'document.txt');await chmod(source,0o400);
 assert.equal((await f.sender.send({filePath:source,requestId:'readonly'})).state,'confirmed');assert.equal(path,source);
 f.sender.cleanup();assert.ok((await readFile(source)).length);
});

test('waiter cancellation returns uncertain while the original execution persists its later acknowledgement',async t=>{
 let started,release,sends=0;const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const f=await fixture(t,async()=>{sends++;started();await wait;return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'late'}})};});
 const controller=new AbortController(),input={filePath:join(f.cwd,'audio.wav'),requestId:'cancel-wait'};
 const pending=f.sender.send(input,{signal:controller.signal});await began;controller.abort();
 const result=await pending;assert.equal(result.state,'uncertain');assert.equal((await f.sender.check(result.requestId)).pending,true);
 release();for(let i=0;i<100&&(await f.sender.check(result.requestId)).state!=='confirmed';i++)await delay(20);
 const resumed=createMediaSender(f.options,route,{sessionId:'session',run:()=>assert.fail('Must use the local receipt')});
 assert.equal((await resumed.check(result.requestId)).messageId,'late');assert.equal((await resumed.send(input)).messageId,'late');assert.equal(sends,1);
});

test('lost response is held across restart and status never sends or reads the official database',async t=>{
 let sends=0;const f=await fixture(t,async()=>{sends++;throw Error('lost response');});
 const input={filePath:join(f.cwd,'audio.wav'),requestId:'lost'},receipt=await f.sender.send(input);
 assert.equal(receipt.state,'uncertain');
 f.options.clawchat.delivery.configPath='/nonexistent/platform-database-must-not-be-read';
 const resumed=createMediaSender(f.options,route,{sessionId:'session',run:()=>assert.fail('Status must not launch any CLI')});
 assert.equal((await resumed.check(receipt.requestId)).state,'uncertain');assert.equal((await resumed.send(input)).state,'uncertain');assert.equal(sends,1);
 const job=await jobFor(f,receipt.requestId);assert.ok((await readFile(job.artifact.path)).length,'Unfinished reading cannot be assumed safe to delete');
});

test('temporary budget includes uncertain files and a full budget never submits another attachment',async t=>{
 let sends=0;const f=await fixture(t,async()=>{sends++;throw Error('lost');});
 const size=(await readFile(join(f.cwd,'document.txt'))).length;f.options.media.temporaryMaxBytes=size;
 await f.sender.send({requestId:'first',filePath:join(f.cwd,'document.txt')});
 await assert.rejects(f.sender.send({requestId:'second',filePath:join(f.cwd,'document.txt')}),/临时附件空间不足/);
 assert.equal(sends,1);assert.equal((await readdir(officialDeliveryPaths(f.options).temporary)).length,1);
});

test('cleanup removes only our orphan or settled artifacts; unknown outcomes keep their records',async t=>{
 const f=await fixture(t,async()=>{throw Error('lost');});const result=await f.sender.send({requestId:'unknown',filePath:join(f.cwd,'document.txt')});
 const p=officialDeliveryPaths(f.options);await mkdir(join(p.temporary,'orphan'));await writeFile(join(p.temporary,'orphan/file'),'orphan');
 assert.equal(cleanupOfficialDelivery(f.options).removed,1);assert.equal((await f.sender.check(result.requestId)).state,'uncertain');
 const file=join(p.root,'jobs',result.requestId+'.json'),record=await jobFor(f,result.requestId);
 record.corePid=99999999;record.workerPid=99999998;record.deadlineAt=Date.now()-1;await writeFile(file,JSON.stringify(record));
 assert.equal(cleanupOfficialDelivery(f.options).removed,1);assert.equal((await f.sender.check(result.requestId)).state,'uncertain');
 assert.ok((await readFile(join(f.cwd,'document.txt'))).length);
});

test('same-operation concurrent callers cannot duplicate a submission and differing parameters conflict',async t=>{
 let sends=0;const f=await fixture(t,async()=>{sends++;await delay(50);return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'one'}})};});
 const input={requestId:'concurrent',filePath:join(f.cwd,'document.txt')};
 const [a,b]=await Promise.all([f.sender.send(input),f.sender.send(input)]);assert.equal(a.messageId,b.messageId);assert.equal(sends,1);
 await assert.rejects(f.sender.send({...input,caption:'changed'}),/conflict/);
 const other=createMediaSender(f.options,route,{sessionId:'other',run:f.run});await assert.rejects(other.check(a.requestId),/another session/);
});

test('legacy confirmed and unknown receipts survive without invoking the removed tool or private status',async t=>{
 const f=await fixture(t,()=>assert.fail('Legacy status is local only'));
 const scope=hash([f.options.instanceId,routeKey(route),senderKey(route),'session']);
 for(const state of ['confirmed','uncertain']){
  const id='whalenest-media-'+hash([scope,state]);
  const source={filePath:join(f.cwd,'document.txt'),caption:'',duration:null,width:null,height:null};
  writeState(join(f.options.dataDir,'media/outgoing/receipts',id+'.json'),{requestId:id,scope,fingerprint:hash(source),state,
   artifact:{kind:'file',name:'document.txt'},...(state==='confirmed'?{messageId:'old-real-ack'}:{})});
  assert.equal((await f.sender.check(id)).state,state);assert.equal((await f.sender.send({requestId:state,filePath:source.filePath})).state,state);
 }
});

test('credentials, external paths, changed identity and incomplete image metadata never reach an official send',async t=>{
 let sends=0;const f=await fixture(t,async()=>{sends++;throw Error('unexpected');});
 await assert.rejects(f.sender.send({requestId:'external',filePath:'/etc/hosts'}),/允许/);
 await writeFile(join(f.cwd,'.env'),'key=private');await assert.rejects(f.sender.send({requestId:'secret',filePath:join(f.cwd,'.env')}),/凭据/);
 await assert.rejects(f.sender.send({requestId:'bad-dimensions',filePath:join(f.cwd,'image.png'),width:100}),/宽高/);
 const link=join(f.cwd,'linked.txt');await symlink(join(f.cwd,'document.txt'),link);await assert.rejects(f.sender.send({requestId:'link',filePath:link}),/符号链接/);
 assert.equal(sends,0);
 const changed=createMediaSender(f.options,route,{sessionId:'session',run:async()=>({stdout:JSON.stringify({userId:'other',ownerId:'another',conversationId:'another',connected:true})})});
 assert.equal((await changed.send({requestId:'changed-owner',filePath:join(f.cwd,'document.txt')})).state,'failed');assert.equal(sends,0);
});

test('missing official tools fail explicitly, and generic song fallback does not invent an audio confirmation',async t=>{
 const f=await fixture(t,async()=>{throw Object.assign(Error('unknown tool'),{stderr:'unknown ClawChat tool: clawchat_send_voice\n'});});
 assert.equal((await f.sender.send({requestId:'missing',filePath:join(f.cwd,'audio.wav')})).state,'failed');
 let tool,input;const song=await fixture(t,async(_bin,args)=>{tool=args[2];input=inputOf(args);return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'song'}})};});
 const file=join(song.cwd,'song.flac');await writeFile(file,Buffer.from('fLaC fixture song'));
 const receipt=await song.sender.send({requestId:'song-file',filePath:file,allowFileFallback:true});
 assert.equal(tool,'clawchat_send_file');assert.equal(input.as_document,undefined);assert.equal(receipt.kind,'unknown');assert.equal(receipt.artifactKind,'audio');assert.equal(receipt.kindVerified,false);
});

test('tool output exposes stable uncertain request IDs and actual states',async t=>{
 const f=await fixture(t);const result={state:'uncertain',requestId:'whalenest-media-'+ 'a'.repeat(64)};
 for(const tool of mediaTools(f.options,route,'session'))assert.match(tool.output.render({},result).map(b=>b.text??'').join(''),/uncertain.*whalenest-media/);
});
