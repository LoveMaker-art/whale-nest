import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createMediaSender,mediaTools} from '../src/media-delivery.mjs';

const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'cnv_owner'};
test('media tool output exposes an uncertain request ID so the model can query it',async()=>{
 const f=await fixture(async()=>{throw Error('not used');});
 const receipt={ok:false,state:'uncertain',requestId:'whalenest-media-'+ 'a'.repeat(64),message:'尚未确认'};
 for(const tool of mediaTools(f.options,route,'session')){
  const rendered=tool.output.render({},receipt).map(block=>block.text??'').join('');
  assert.ok(rendered.includes(receipt.requestId),'rendered result must retain the status lookup key');
  assert.ok(rendered.includes('uncertain'));
 }
});
test('a missing local media command is a definite failure, while a lost response stays uncertain',async()=>{
 const f=await fixture(async()=>{throw Object.assign(Error('command failed'),{stderr:'unknown ClawChat tool: clawchat_send_media\n',code:1});});
 const result=await f.sender.send({requestId:'missing-media-command',filePath:join(f.cwd,'document.txt')});
 assert.equal(result.state,'failed');assert.match(result.message,/连接器|媒体/);
});
test('song audio accepts the actual platform file fallback and preserves its receipt kind',async()=>{
 let calls=0;const f=await fixture(async(_bin,args)=>{calls++;const input=JSON.parse(args[args.indexOf('--input-json')+1]);assert.equal(input.expectedKind,undefined);
  return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'song-file-ack',kind:'file'}})};});
 const path=join(f.cwd,'song.flac');await writeFile(path,Buffer.from('fLaC fixture song'));
 const input={requestId:'song-file',filePath:path,allowFileFallback:true};const first=await f.sender.send(input);assert.equal(first.kind,'file');assert.equal(first.state,'confirmed');
 assert.equal((await f.sender.send(input)).messageId,'song-file-ack');assert.equal(calls,1);
});
async function fixture(run){
 const cwd=await mkdtemp(join(tmpdir(),'whalenest-media-send-'));
 const options={instanceId:'fixture',cwd,dataDir:join(cwd,'data'),owners:[route],media:{maxBytesEach:1024*1024},clawchat:{route,delivery:{connectBin:'/fake/core',configPath:'/fake/config',mediaEnabled:true}}};
 for(const name of ['audio.wav','document.txt','video.mp4'])await copyFile(resolve('test/fixtures/media',name),join(cwd,name));
 return {cwd,options,sender:createMediaSender(options,route,{sessionId:'session',run})};
}
test('Media tool sends audio/file/video on the verified route, snapshots content and reuses confirmed receipts after restart',async()=>{
 let calls=0;const run=async(_bin,args)=>{calls++;const input=JSON.parse(args[args.indexOf('--input-json')+1]);
  assert.equal(input.chatId,'cnv_owner');assert.equal(input.chatType,'direct');assert.match(input.sha256,/^[a-f0-9]{64}$/);
  assert.ok((await readFile(input.filePath)).length);return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'msg-'+calls,kind:input.expectedKind}})};};
 const f=await fixture(run);
 for(const [name,kind]of[['audio.wav','audio'],['document.txt','file'],['video.mp4','video']]){
  const args={filePath:join(f.cwd,name),requestId:name};
  const first=await f.sender.send(args);assert.equal(first.state,'confirmed');assert.equal(first.kind,kind);
  await writeFile(args.filePath,'changed original');
  const resumed=createMediaSender(f.options,route,{sessionId:'session',run});
  assert.equal((await resumed.send(args)).messageId,first.messageId);
 }
 assert.equal(calls,3);
});
test('Uncertain media is held across restart and reconciled by a status query without another send',async()=>{
 let sends=0,queries=0;
 const f=await fixture(async(_bin,args)=>{if(args[1]==='status'){queries++;return {stdout:JSON.stringify({status:'succeeded',result:{sent:true,messageId:'msg-late',kind:'audio'}})};}sends++;throw Error('CLI disconnected');});
 const args={filePath:join(f.cwd,'audio.wav'),requestId:'lost'};const receipt=await f.sender.send(args);assert.equal(receipt.state,'uncertain');
 const resumed=createMediaSender(f.options,route,{sessionId:'session',run:async(_bin,args)=>{assert.equal(args[1],'status');queries++;return {stdout:JSON.stringify({status:'succeeded',result:{messageId:'msg-late',sent:true,kind:'audio'}})};}});
 assert.equal((await resumed.send(args)).state,'uncertain');assert.equal(sends,1);
 assert.equal((await resumed.checkRequest(args.requestId)).messageId,'msg-late');
 assert.equal((await resumed.check(receipt.requestId)).messageId,'msg-late');assert.equal(queries,1);assert.equal(sends,1);
});
test('Media is private to its verified owner route, refuses outside paths and detects request-ID conflicts',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return {stdout:JSON.stringify({status:'succeeded',result:{messageId:'msg-ok',sent:true,kind:'file'}})};});
 assert.throws(()=>createMediaSender(f.options,{...route,conversation:'other'},{sessionId:'s'}));
 await assert.rejects(f.sender.send({filePath:'/etc/hosts',requestId:'outside'}),/workspace|工作区|允许/);
 const args={filePath:join(f.cwd,'document.txt'),requestId:'conflict',caption:'one'};await f.sender.send(args);
 await assert.rejects(f.sender.send({...args,caption:'two'}),/conflict|冲突/);assert.equal(calls,1);
});
