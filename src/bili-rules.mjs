import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {hash,routeKey,senderKey} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {localClock} from './companion-policy.mjs';
import {loadBiliOwnerState} from './bili-state.mjs';

const defaults={minViews:0,minAgeDays:0,inboxOn:true,inboxUids:'',inboxOnceOnly:true,inboxMaxRemind:2,inboxPerDay:5,
 watchOn:false,watchDm:true,watchAt:true,watchInterval:120,watchScope:'valley',dynamicOn:false,dynamicPerDay:3,dynamicGapMin:10,
 replyPerDay:null,replyGapMin:0,messagePerDay:null,messageGapMin:0,interactPerDay:null,interactGapMin:0,profilePerDay:null,profileGapMin:0,danmakuPerDay:null,danmakuGapMin:0};
/** Bili-specific settings and durable account-operation limits. No timers or LLM. */
export function createBiliRules(options,route,{now=Date.now}={}){
 const file=join(resolve(options.dataDir),'bili','rules.json'),store=loadBiliOwnerState(options,route,file,{settings:{...defaults},reservations:{}});
 const state=store.state,save=store.save;state.settings={...defaults,...state.settings};save();
 function validate(patch){assert.ok(patch&&typeof patch==='object'&&!Array.isArray(patch),'B站配置须为对象');
  for(const key of Object.keys(patch))assert.ok(Object.hasOwn(defaults,key),'Unsupported Bili setting: '+key);
  const next={...state.settings,...patch};for(const key of ['inboxOn','inboxOnceOnly','watchOn','watchDm','watchAt','dynamicOn'])assert.equal(typeof next[key],'boolean',key+' must be boolean');
  for(const [key,min,max] of [['minViews',0,100000000],['minAgeDays',0,365],['inboxMaxRemind',1,10],['inboxPerDay',0,1000],['watchInterval',60,1800],['dynamicPerDay',0,10],['dynamicGapMin',0,720]])assert.ok(Number.isInteger(next[key])&&next[key]>=min&&next[key]<=max,'Invalid '+key);
  for(const kind of ['reply','message','interact','profile','danmaku']){const count=next[kind+'PerDay'],gap=next[kind+'GapMin'];assert.ok(count===null||(Number.isInteger(count)&&count>=0&&count<=1000),'Invalid '+kind+'PerDay');assert.ok(Number.isInteger(gap)&&gap>=0&&gap<=720,'Invalid '+kind+'GapMin');}
  assert.ok(['valley','always'].includes(next.watchScope),'watchScope must be valley/always');assert.ok(typeof next.inboxUids==='string'&&next.inboxUids.length<=2000,'Invalid inboxUids');
  const uids=next.inboxUids.split(/[,，\s]+/).filter(Boolean);assert.ok(uids.length<=100&&uids.every(id=>/^[1-9]\d*$/.test(id)),'inboxUids须为最多100个UID');next.inboxUids=[...new Set(uids)].join(',');return next;
 }
 validate({});
 function configure(patch){const next=validate(patch);if(next.watchOn&&!state.settings.watchOn)state.watchStartedAt=now();state.settings=next;save();return status();}
 function counted(record){return ['reserved','uncertain','confirmed'].includes(record.state);}
 const keysFor=(kind,input)=>kind==='reply'&&(input?.parent||input?.root)?['reply','inbox']: [kind];
 function reserve(id,{kind,uid,input}={}){
  assert.ok(typeof id==='string'&&id&&id.length<=256,'Stable operation ID required');
  assert.ok(['dynamic','reply','message','interact','profile','danmaku'].includes(kind)&&/^\d+$/.test(uid),'Invalid account quota identity');
  if(state.reservations[id])return {ok:false,state:'uncertain',reason:'existing-reservation',message:'此操作已有待核对记录，未重新执行。'};
  const keys=keysFor(kind,input),date=localClock(now()).date;
  for(const key of keys){const max=state.settings[key==='inbox'?'inboxPerDay':key+'PerDay'],gap=state.settings[key==='inbox'?'replyGapMin':key+'GapMin'];const rows=Object.values(state.reservations).filter(r=>r.uid===uid&&r.keys.includes(key)&&counted(r));
   if(max!==null&&rows.filter(r=>r.date===date).length>=max)return {ok:false,state:'limited',reason:'daily-limit',message:'B站'+key+'今日次数已达上限，本次未执行。',limit:max};
   const last=rows.reduce((at,r)=>Math.max(at,r.at),0);if(last&&now()-last<gap*60000)return {ok:false,state:'limited',reason:'cooldown',retryAfterMs:gap*60000-(now()-last),message:'B站'+key+'尚未到允许间隔，本次未执行。'};
  }
  state.reservations[id]={id,uid,kind,keys,date,at:now(),state:'reserved'};save();return {ok:true};
 }
 function settle(id,result){const record=state.reservations[id];assert.ok(record,'Unknown account reservation');assert.ok(['confirmed','uncertain','failed'].includes(result),'Invalid account result');record.state=result;record.updatedAt=now();save();}
 function importReceipts(records){let changed=false;for(const r of records){if(!r?.id||state.reservations[r.id]||!r.uid||!['dynamic','reply','message','interact','profile','danmaku'].includes(r.kind))continue;
   assert.ok(Number.isFinite(r.createdAt),'Legacy operation lacks a timestamp');state.reservations[r.id]={id:r.id,uid:r.uid,kind:r.kind,keys:r.kind==='reply'?['reply','inbox']:[r.kind],date:localClock(r.createdAt).date,at:r.createdAt,state:r.state==='confirmed'?'confirmed':r.state==='failed'?'failed':'uncertain',imported:true};changed=true;
  }if(changed)save();}
 function status(uid){const date=localClock(now()).date,usage={};for(const key of ['dynamic','reply','message','interact','profile','danmaku','inbox']){const rows=Object.values(state.reservations).filter(r=>(!uid||r.uid===uid)&&r.keys.includes(key)&&counted(r));usage[key]={today:rows.filter(r=>r.date===date).length,lastAt:rows.reduce((at,r)=>Math.max(at,r.at),0)};}
  return {settings:structuredClone(state.settings),date,usage,watchStartedAt:state.watchStartedAt??null};
 }
 return {settings:()=>structuredClone(state.settings),owns:key=>Object.hasOwn(defaults,key),validate,configure,reserve,settle,importReceipts,status};
}
