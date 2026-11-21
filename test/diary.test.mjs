import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile,unlink,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createActivities} from '../src/activities.mjs';
import {createDiary} from '../src/diary.mjs';
import {hash,ownerScope,routeKey,senderKey} from '../src/routing.mjs';
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'whalenest-diary-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let at=Date.parse('2026-11-13T10:00:00Z');
 const route={channel:'clawchat',account:'a',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'test',dataDir,owners:[route],clawchat:{route},activities:{enabled:true}};
 const api={search:async()=>[{bvid:'BV1xx411c7mD'}],view:async()=>({bvid:'BV1xx411c7mD',aid:123,cid:456,title:'真实海洋资料',author:'作者',desc:'实际简介'}),subtitle:async()=>'',comments:async()=>[]},now=()=>at;
 const activities=createActivities(options,route,{api,now}),diary=createDiary(options,route,{activities,now,compose:async()=>({text:'原生成器的日记正文'})});return {options,route,activities,diary,now,setTime:v=>{at=Date.parse(v);}};}
test('date-scoped private diaries cite only actual completed experiences and reuse an existing version',async t=>{
 const f=await fixture(t);await f.activities.run({query:'旧日',requestId:'old',sessionId:'s'});f.setTime('2026-11-14T10:00:00Z');
 const actual=await f.activities.run({query:'今日',requestId:'today',sessionId:'s'});
 const first=await f.diary.write({requestId:'write',reflection:'TEST_PRIVATE_THOUGHT'});assert.equal(first.ok,true);assert.equal(first.sources.length,1);assert.equal(first.sources[0].activityId,actual.activityId);assert.equal(first.audience,'private-owner');
 assert.match(first.message,/未取得字幕/);assert.equal((await f.diary.write({requestId:'write',reflection:'TEST_PRIVATE_THOUGHT'})).revision,1);
 const restarted=createDiary(f.options,f.route,{activities:f.activities,now:f.now,compose:async()=>({text:'新的原日记正文'})});assert.equal(restarted.read('2026-11-14').reflection,'TEST_PRIVATE_THOUGHT');assert.equal(restarted.list().length,1);
 await assert.rejects(restarted.write({requestId:'write',reflection:'changed'}),/冲突/);
 assert.equal((await restarted.write({requestId:'revise',reflection:'新的感想',revise:true})).revision,2);
});
test('deletion removes diary content, stops automatic regeneration and permits only explicit new manual revision',async t=>{
 const f=await fixture(t);await f.activities.run({query:'资料',requestId:'read',sessionId:'s'});await f.diary.write({requestId:'write',reflection:'PRIVATE_DELETE_ME'});f.diary.remove();
 assert.equal(f.diary.read().state,'deleted');assert.deepEqual(f.diary.list(),[]);
 assert.equal((await f.diary.write({requestId:'automatic',automatic:true})).state,'deleted');await assert.rejects(f.diary.write({requestId:'automatic-new',automatic:true,revise:true}),/自动任务/);
 const file=(await readdir(join(f.options.dataDir,'diary')))[0];assert.ok(!(await readFile(join(f.options.dataDir,'diary',file),'utf8')).includes('PRIVATE_DELETE_ME'));
 assert.equal((await f.diary.write({requestId:'explicit-new',revise:true})).revision,2);
});
test('empty, invalid and future days cannot fabricate a diary or source activity',async t=>{
 const f=await fixture(t);assert.equal((await f.diary.write({requestId:'none'})).state,'empty');assert.equal((await readdir(join(f.options.dataDir,'diary'))).length,0);
 await assert.rejects(f.diary.write({date:'2026-02-30',requestId:'invalid'}),/无效日期/);await assert.rejects(f.diary.write({date:'2026-12-01',requestId:'future'}),/未来/);
});
test('the same video is one diary source while distinct actual visits remain traceable',async t=>{
 const f=await fixture(t);const one=await f.activities.run({query:'第一次',requestId:'one',sessionId:'s'}),two=await f.activities.run({query:'第二次',requestId:'two',sessionId:'s'});
 const diary=await f.diary.write({requestId:'daily'});assert.equal(diary.sources.length,1);assert.equal(new Set(diary.sources[0].activityIds).size,2);assert.ok(diary.sources[0].activityIds.includes(one.activityId)&&diary.sources[0].activityIds.includes(two.activityId));
});
test('legacy archive migration retains text, version and requests and exposes one archive to linked QQ',async t=>{
 const f=await fixture(t);await f.activities.run({query:'资料',requestId:'source',sessionId:'s'});const written=await f.diary.write({requestId:'old-request',reflection:'保留感想'});
 const dir=join(f.options.dataDir,'diary'),file=join(dir,(await readdir(dir))[0]),old=JSON.parse(await readFile(file));const legacy=hash([f.options.instanceId,routeKey(f.route),senderKey(f.route)]);
 old.schema=1;old.scope=legacy;const legacyFile=join(dir,legacy+'-'+old.date+'.json');await writeFile(legacyFile,JSON.stringify(old));await unlink(file);
 const qq={channel:'qq',account:'20000002',sender:'10000001',conversation:'10000001',kind:'private'},options={...f.options,owners:[f.route,qq]};
 const shared=createDiary(options,qq,{activities:f.activities,now:f.now,compose:()=>{throw Error('must not regenerate');}});
 assert.equal(shared.read().message,written.message);assert.equal((await shared.write({requestId:'old-request',reflection:'保留感想'})).duplicate,true);assert.equal(shared.read().revision,1);
 const migrated=JSON.parse(await readFile(join(dir,(await readdir(dir))[0])));assert.equal(migrated.scope,ownerScope(options));assert.equal(migrated.requests['old-request'].state,'confirmed');await assert.rejects(access(legacyFile),{code:'ENOENT'});
 shared.remove();assert.equal(createDiary(options,f.route,{activities:f.activities,now:f.now}).read().state,'deleted');
 assert.throws(()=>createDiary(options,{...qq,sender:'99999999'},{activities:f.activities}),/主人/);
});
test('concurrent requests share one generation and deleting during generation prevents a late save',async t=>{
 const f=await fixture(t);await f.activities.run({query:'资料',requestId:'source',sessionId:'s'});let calls=0,release;
 const compose=()=>{calls++;return new Promise(r=>{release=r;});},diary=createDiary(f.options,f.route,{activities:f.activities,now:f.now,compose});
 const one=diary.write({requestId:'one'}),two=diary.write({requestId:'two'});await assert.rejects(diary.write({requestId:'revision',revise:true}),/并行/);assert.equal(calls,1);
 release({text:'实际原正文'});const results=await Promise.all([one,two]);assert.ok(results.every(r=>r.revision===1));assert.equal(calls,1);
 const pending=diary.write({requestId:'next',revise:true});diary.remove();release({text:'不能重新出现的内容'});assert.equal((await pending).state,'deleted');assert.equal(diary.read().state,'deleted');
});
test('unknown generation results stay held after restart until an explicit new manual revision',async t=>{
 const f=await fixture(t);await f.activities.run({query:'资料',requestId:'source',sessionId:'s'});let calls=0;
 const diary=createDiary(f.options,f.route,{activities:f.activities,now:f.now,compose:async()=>{calls++;throw Error('timeout');}});assert.equal((await diary.write({requestId:'uncertain'})).state,'uncertain');
 const resumed=createDiary(f.options,f.route,{activities:f.activities,now:f.now,compose:async()=>{calls++;return {text:'明确重新整理'};}});
 assert.equal((await resumed.write({requestId:'uncertain'})).state,'uncertain');assert.equal((await resumed.write({requestId:'another'})).state,'uncertain');assert.equal(calls,1);
 assert.equal((await resumed.write({requestId:'explicit',revise:true})).state,'completed');assert.equal(calls,2);
});
