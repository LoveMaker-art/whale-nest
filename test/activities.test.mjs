import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createActivities} from '../src/activities.mjs';

async function fixture(t){
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-activities-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const route={channel:'clawchat',account:'agent',sender:'alice',conversation:'owner-dm',kind:'private'};
 const options={instanceId:'fixture',dataDir,owners:[route],clawchat:{route},activities:{enabled:true}};
 const calls={search:0,view:0,subtitle:0,comments:0};
 const api={search:async()=>{calls.search++;return [{bvid:'BV1xx411c7mD',title:'海洋资料',author:'作者'}];},view:async({bvid})=>{calls.view++;return {bvid,aid:123,cid:456,title:'海洋资料',author:'作者',desc:'标题与简介'};},subtitle:async()=>{calls.subtitle++;return '鲸鱼生活在海洋。';},comments:async()=>{calls.comments++;return [{name:'评论者',text:'公开热评'}];}};
 return {options,route,calls,api,store:createActivities(options,route,{api})};
}
test('public search, real evidence, concurrent idempotency and private recall survive restart',async t=>{
 const f=await fixture(t),request={query:'鲸鱼',requestId:'same-native-call',sessionId:'native-session'};
 const [first,repeat]=await Promise.all([f.store.run(request),f.store.run(request)]);
 assert.equal(first.ok,true);assert.equal(repeat.activityId,first.activityId);assert.equal(f.calls.search,1);assert.equal(f.calls.view,1);
 assert.deepEqual(first.coverage,{metadata:true,subtitle:true,comments:true,vision:false});assert.match(first.message,/鲸鱼生活在海洋/);assert.match(first.message,/未完整播放/);
 const restarted=createActivities(f.options,f.route,{api:f.api});assert.equal(restarted.get(first.activityId).video.title,'海洋资料');assert.match(restarted.context(),/海洋资料/);
 await restarted.run(request);assert.equal(f.calls.view,1);
 await assert.rejects(restarted.run({...request,query:'改了内容'}),/different content/);
 assert.equal(restarted.list().length,1);
 const foreign={...f.route,sender:'bob'};assert.throws(()=>createActivities(f.options,foreign,{api:f.api}),/owner/);
 const otherOptions={...f.options,clawchat:{route:{...f.route,conversation:'other-owner-chat'}}};
 const other=createActivities(otherOptions,otherOptions.clawchat.route,{api:f.api});assert.equal(other.list().length,1);assert.equal(other.get(first.activityId).activityId,first.activityId,'The verified instance owner shares approved experiences across routes');
});
test('missing subtitle and failed comments stay explicit; failed and empty reads never become completed experiences',async t=>{
 const f=await fixture(t);f.api.subtitle=async()=>'';f.api.comments=async()=>{throw Error('offline');};
 const partial=await f.store.run({link:'BV1xx411c7mD',requestId:'partial',sessionId:'s'});
 assert.equal(partial.ok,true);assert.equal(partial.coverage.subtitle,false);assert.equal(partial.coverage.comments,false);assert.match(partial.message,/未取得字幕/);assert.match(partial.message,/热评资料暂未取得/);
 f.api.search=async()=>[];const empty=await f.store.run({query:'没有结果',requestId:'empty',sessionId:'s'});assert.equal(empty.state,'empty');
 f.api.view=async()=>{throw Object.assign(Error('upstream denied'),{code:-412});};
 const failed=await f.store.run({link:'BV1xx411c7mD',requestId:'denied',sessionId:'s'});assert.equal(failed.ok,false);assert.equal(failed.state,'failed');assert.match(failed.message,/-412/);
 assert.equal(f.store.list().filter(item=>item.ok).length,1);
});
test('an interrupted activity is held across restart; cancellation and invalid identities do not trigger new work',async t=>{
 const f=await fixture(t),request={query:'鲸鱼',requestId:'interrupted',sessionId:'s'};
 const first=await f.store.run(request),file=join(f.options.dataDir,'activities',first.activityId+'.json');
 const record=JSON.parse(await readFile(file));record.state='running';await writeFile(file,JSON.stringify(record));
 const replay=await createActivities(f.options,f.route,{api:f.api}).run(request);assert.equal(replay.state,'interrupted');assert.equal(f.calls.view,1);
 const signal=AbortSignal.abort();const cancelled=await f.store.run({query:'鲸鱼',requestId:'cancel',sessionId:'s',signal});assert.equal(cancelled.state,'cancelled');assert.equal(f.calls.search,1);
 await assert.rejects(f.store.run({query:'a',link:'b',requestId:'bad',sessionId:'s'}),/either/);
 assert.throws(()=>f.store.get('../../instance.json'),/Invalid activity/);
 assert.equal((await readdir(join(f.options.dataDir,'activities'))).filter(n=>n.startsWith('whalenest-activity-')).length,2);
});
test('configured video thresholds apply to searches and selection; missing metadata never bypasses a threshold',async t=>{
 const f=await fixture(t),now=Date.parse('2026-11-15T01:00:00Z');let filters={minViews:1000,minAgeDays:7},requested;
 const videos=[{bvid:'BV1xx411c7mD',play:2000,pubdate:now-8*86400000,title:'符合条件'},{bvid:'BV1xx411c7mE',play:10,pubdate:now-8*86400000,title:'播放量不足'},{bvid:'BV1xx411c7mF',play:2000,pubdate:now-86400000,title:'太新'},{bvid:'BV1xx411c7mG',title:'缺少数据'}];
 const store=createActivities(f.options,f.route,{api:f.api,now:()=>now,getFilters:()=>filters,searcher:async(_query,options)=>{requested=options;return videos;}});
 const search=await store.search('海洋',{limit:5});assert.equal(requested.limit,50);assert.equal(search.excluded,3);assert.equal(search.results.length,1);assert.equal(search.results[0].title,'符合条件');
 const activity=await store.run({query:'海洋',requestId:'threshold',sessionId:'native'});assert.equal(activity.video.bvid,'BV1xx411c7mD');filters={minViews:100000,minAgeDays:7};assert.equal((await store.run({query:'海洋',requestId:'empty-after-filters',sessionId:'native'})).state,'empty');assert.equal(f.calls.view,1);
 const targeted=await store.run({link:'BV1xx411c7mE',requestId:'explicit-video',sessionId:'native'});assert.equal(targeted.ok,true,'explicit owner-selected links are not secretly replaced by search filters');
});
