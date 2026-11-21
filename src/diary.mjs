import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readdirSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {hash,senderKey,routeKey,ownerScope,resolveDeliveryTarget} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {localClock} from './companion-policy.mjs';

/** One private archive. Composition is injected from the original module. */
export function createDiary(options,route,{activities,now=Date.now,compose}={}){
 assert.ok(resolveDeliveryTarget(options,{origin:route}).ok,'日记仅限已关联主人私聊');
 const scope=ownerScope(options),cc=options.clawchat?.route??route,legacy=hash([options.instanceId,routeKey(cc),senderKey(cc)]);
 const directory=join(resolve(options.dataDir),'diary');mkdirSync(directory,{recursive:true,mode:0o700});const flights=new Map();
 const today=()=>localClock(now()).date;
 function dateKey(date=today()){assert.ok(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date),'日期应为 YYYY-MM-DD');assert.equal(new Date(date+'T00:00:00Z').toISOString().slice(0,10),date,'无效日期');return date;}
 const fileFor=date=>join(directory,scope+'-'+dateKey(date)+'.json');
 for(const name of readdirSync(directory).filter(n=>n.startsWith(legacy+'-')&&n.endsWith('.json'))){
  const file=join(directory,name),old=readState(file),target=fileFor(old.date);assert.equal(old.scope,legacy,'旧日记归属不符');const migrated={...old,schema:2,scope};
  if(existsSync(target))assert.equal(hash(readState(target)),hash(migrated),'两份日记内容冲突，需要核对后迁移');else writeState(target,migrated);unlinkSync(file);
 }
 const raw=date=>{const record=readState(fileFor(date),null);assert.ok(!record||record.scope===scope,'日记归属不符');return record;};
 const sources=date=>activities.list(20,{date:dateKey(date)}).filter(record=>record.ok);
 const view=record=>record?{ok:record.state==='completed',date:record.date,revision:record.revision,state:record.state,audience:'private-owner',sources:record.state==='deleted'?[]:record.sources??[],reflection:record.state==='deleted'?'':record.reflection??'',body:record.state==='deleted'?'':record.body??'',generator:record.generator,message:record.state==='deleted'?'这篇日记已删除，自动任务不会重建。':record.text??'日记生成尚未完成，未作为已完成档案。'}:{ok:false,state:'missing',message:'该日暂无已保存日记。'};
 const held=record=>({...view(record),ok:false,state:'uncertain',message:'上次日记生成或归档未确认，已保留请求且不自动重新生成。可查询原档案；主人明确重新整理时使用revise。'});
 function references(records){const byUrl=new Map();for(const record of records){const prior=byUrl.get(record.url);
  if(prior){prior.activityIds.push(record.activityId);for(const key of Object.keys(prior.coverage))prior.coverage[key]||=record.coverage[key];}
  else byUrl.set(record.url,{activityId:record.activityId,activityIds:[record.activityId],title:record.video.title,url:record.url,coverage:{...record.coverage}});
 }return [...byUrl.values()];}
 async function write({date=today(),reflection='',revise=false,requestId,automatic=false}={}){
  date=dateKey(date);assert.ok(date<=today(),'不能把未来活动写成已经发生的日记');assert.ok(typeof requestId==='string'&&requestId&&requestId.length<=512,'日记写入需要稳定请求标识');
  assert.ok(typeof reflection==='string'&&reflection.length<=2000,'感想最多2000字符');assert.ok(!automatic||!revise,'自动任务不能改写既有日记');assert.ok(!automatic||!reflection,'自动日记只由原生成器表达，不能追加外部感想');
  const fingerprint=hash({date,reflection,revise}),old=raw(date),previous=old?.requests?.[requestId];
  if(previous){assert.equal(previous.fingerprint,fingerprint,'日记请求标识与内容冲突');if(flights.has(date))await flights.get(date);const current=raw(date);return previous.state==='uncertain'&&current.requests[requestId].state==='uncertain'?held(current):{...view(current),duplicate:true};}
  if(flights.has(date)){assert.ok(!revise,'该日日记正在生成，不能并行重新整理');await flights.get(date);return {...view(raw(date)),duplicate:true};}
  if(old&&!revise){if(old.generation?.state==='uncertain')return held(old);return {...view(old),duplicate:true};}
  const records=sources(date);if(!records.length)return {ok:false,state:'empty',date,message:'当天暂无可记录的真实活动，未生成日记。'};
  assert.equal(typeof compose,'function','原日记生成器尚未接入');
  const id=hash([scope,date,requestId,fingerprint]),record={schema:2,scope,date,state:'generating',audience:'private-owner',revision:0,...old,
   requests:{...old?.requests,[requestId]:{fingerprint,state:'uncertain'}},generation:{id,requestId,state:'uncertain',startedAt:now()}};
  if(old?.state==='deleted'){record.state='generating';delete record.deletedAt;}
  writeState(fileFor(date),record);
  const work=(async()=>{try{
   const refs=references(records),draft=await compose({date,sources:records.map(r=>({id:r.activityId,at:r.startedAt,text:JSON.stringify({title:r.video.title,url:r.url,coverage:r.coverage})}))});
   assert.ok(typeof draft?.text==='string'&&draft.text.trim()&&draft.text.length<=16000,'原日记生成正文无效');
   const current=raw(date);if(current.state==='deleted'||current.generation?.id!==id)return view(current);
   const body=draft.text.trim(),text=[date+' · 伙伴日记',body,reflection?'补充感想（明确指定，非活动事实）：\n'+reflection:'','来源与实际读取范围：',...refs.map(s=>'《'+s.title+'》 '+(s.coverage.subtitle?'取得字幕；':'未取得字幕；')+(s.coverage.comments?'取得评论；':'评论未取得；')+(s.coverage.vision?'仅分析抽帧，未完整播放。':'未分析画面，未完整播放。')+'\n'+s.url)].filter(Boolean).join('\n\n');
   Object.assign(current,{state:'completed',revision:(old?.revision??0)+1,createdAt:old?.createdAt??now(),updatedAt:now(),sources:refs,body,reflection,text,generator:'aurabot-diary-compose'});
   current.generation.state='confirmed';current.generation.finishedAt=now();current.requests[requestId]={fingerprint,state:'confirmed',revision:current.revision};writeState(fileFor(date),current);return view(current);
  }catch(error){const current=raw(date);if(current?.state==='deleted'||current?.generation?.id!==id)return view(current);
   current.generation.error=String(error.message).slice(0,300);if(current.state==='generating')current.state='uncertain';writeState(fileFor(date),current);return held(current);
  }})();flights.set(date,work);try{return await work;}finally{flights.delete(date);}
 }
 function read(date=today()){return view(raw(date));}
 function remove(date=today()){const old=raw(date);if(!old)return {ok:false,state:'missing',message:'没有这篇日记。'};
  const record={schema:2,scope,date:dateKey(date),revision:old.revision,state:'deleted',deletedAt:now(),requests:old.requests??{}};writeState(fileFor(date),record);return view(record);
 }
 function list(){return readdirSync(directory).filter(n=>n.startsWith(scope+'-')&&n.endsWith('.json')).map(n=>readState(join(directory,n))).filter(r=>r.scope===scope&&r.state!=='deleted').sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20).map(r=>({date:r.date,revision:r.revision,state:r.state,audience:r.audience}));}
 return {read,write,remove,list,sources,today,exists:date=>raw(date)!==null};
}
