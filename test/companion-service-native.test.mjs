import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';

async function fixture(t,{limit=0,media=false,speech=false}={}){
 const dir=await bridgeDirectory();dir.biliFixture=true;dir.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:limit};dir.options.clawchat.delivery.mediaEnabled=media;
 if(speech)dir.options.speech={enabled:true,ttsModel:'fixture-tts',providerConfigPath:'/must-not-read-speech-provider.json'};
 await writeFile(dir.configPath,JSON.stringify(dir.options));let bridge=await bootBridge(dir);
 t.after(async()=>{await bridge.close();await rm(dir.root,{recursive:true,force:true});});
 const sessionId='companion-service';await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 return {dir,sessionId,get bridge(){return bridge;},async restart(){await bridge.close();bridge=await bootBridge(dir);await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});}};
}
test('real DSH can write and read a private diary at zero automatic budget, preserving it across restart',{timeout:90000},async t=>{
 const f=await fixture(t);await f.bridge.turn(f.sessionId,'manual-experience','EXPLORE_BILI_FIXTURE');await f.bridge.turn(f.sessionId,'manual-diary','DIARY_WRITE_FIXTURE');
 const files=await readdir(join(f.dir.options.dataDir,'diary'));assert.equal(files.length,1);const diary=JSON.parse(await readFile(join(f.dir.options.dataDir,'diary',files[0])));assert.equal(diary.reflection,'TEST_DIARY_FEELING');assert.equal(diary.audience,'private-owner');
 assert.equal((await f.bridge.control('companionState')).usage.modelRequests,0);
 await f.restart();await f.bridge.turn(f.sessionId,'read-diary','DIARY_READ_FIXTURE');
 const trace=(await readFile(join(f.dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(JSON.stringify(trace.at(-1).messages).includes('TEST_DIARY_FEELING'));
 assert.equal((await f.bridge.control('companionState')).dailyModelRequestLimit,0);
});
async function runJob(f){
 const tick=await f.bridge.control('companionTick');assert.ok(tick.jobId,'A native job should be queued');
 const state=await f.bridge.wait(async()=>{const state=await f.bridge.control('companionState'),job=state.jobs.find(j=>j.id===tick.jobId);return ['confirmed','failed','suppressed'].includes(job?.state)?state:null;});
 const job=state.jobs.find(j=>j.id===tick.jobId);return {state,job};
}
test('native background browse and diary share one budget and delivery policy; restarting preserves paused state',{timeout:90000},async t=>{
 const f=await fixture(t,{limit:6});await f.bridge.control('companionConfigure',{automatic:true,awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,diaryHour:0,interests:['鲸鱼']});
 const first=await runJob(f);assert.equal(first.job.kind,'browse');assert.equal(first.job.state,'confirmed',JSON.stringify(first));assert.equal(first.state.usage.modelRequests,2);
 const second=await runJob(f);assert.equal(second.job.kind,'diary');assert.equal(second.job.state,'confirmed');assert.equal(second.state.usage.modelRequests,3);assert.equal(second.state.usage.automaticMessages,2);
 const lines=(await readFile(join(f.dir.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(lines.length,2);assert.equal(new Set(lines.map(line=>line.id)).size,2);
 await f.bridge.control('companionConfigure',{paused:true});await f.restart();const restored=await f.bridge.control('companionState');assert.equal(restored.settings.paused,true);assert.equal(restored.usage.modelRequests,3);assert.equal((await f.bridge.control('companionTick')).reason,'paused');
 assert.equal((await readFile(join(f.dir.root,'delivered.jsonl'),'utf8')).trim().split('\n').length,2);
});
for(const [marker,expected] of [['MEDIA_ESCAPE','后台陪伴任务仅能读取活动资料'],['VOICE_ESCAPE','后台陪伴任务仅能读取活动资料'],['BILI_ACCOUNT_ESCAPE','后台陪伴任务仅能读取活动资料'],['DIARY_PUBLISH_ESCAPE','后台任务不能发布或删除平台动态']])test('background native tool bypass is rejected: '+marker,{timeout:90000},async t=>{
 const f=await fixture(t,{limit:4,media:true,speech:marker==='VOICE_ESCAPE'});await f.bridge.control('companionConfigure',{automatic:true,awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,interests:[marker]});
 const result=await runJob(f);assert.equal(result.job.state,'suppressed');assert.equal(result.state.usage.modelRequests,2);assert.equal(result.state.usage.automaticMessages,0);
 await assert.rejects(access(join(f.dir.root,'delivered.jsonl')),{code:'ENOENT'});
 const trace=(await readFile(join(f.dir.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);const turns=trace.filter(r=>JSON.stringify(r.messages).includes('【刷 B 站，不是聊天'));assert.ok(turns.length>=2);assert.ok(turns.every(r=>!(r.tools??[]).some(t=>['send_media','send_voice','bili_login_start','companion_diary'].includes(t.name))));
});
