import assert from 'node:assert/strict';
import {parseBiliJson} from './bili-json.mjs';

const decimal=value=>/^[0-9]+$/.test(String(value??''))?String(value):null;
const clean=(value,max=500)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max);
const timestamp=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value)*1000:null;
const safeError=error=>({code:Number.isInteger(error.code)?error.code:null,state:error.name==='AbortError'||error.name==='TimeoutError'?'cancelled':'read-failed'});
function sourceUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='bilibili.com'||url.hostname.endsWith('.bilibili.com'))?url.href:undefined;}catch{return undefined;}}

/** First-party GET contracts only; never calls update_ack or account writes. */
export async function readBiliInbox(request,{uid,dm=true,at=true,cursors={},initializing={},since={},signal}={}){
 assert.ok(decimal(uid),'Verified account UID required');const streams={};
 async function feed(kind){const items=[],old=cursors[kind]??{};let cursor=old.next??null,fetched=false,partial=false;const seen=new Set();
  try{for(let page=0;page<3;page++){
   const data=await request('/x/msgfeed/'+kind,{signal,params:{platform:'web',build:0,mobi_app:'web',...(cursor?{id:cursor.id,[kind+'_time']:cursor.time}:{})}});
   assert.ok(data.cursor&&Array.isArray(data.items),'B站消息流结构不完整');fetched=true;
   const rows=data.items.map(row=>{const id=decimal(row.id),mid=decimal(row.user?.mid),item=row.item;if(!id||!mid||!item)return null;
    return {kind,id,mid,nickname:clean(row.user.nickname,100),createdAt:timestamp(row[kind+'_time']),text:clean(item.source_content||item.target_reply_content||item.title||item.desc),url:sourceUrl(item.uri),unread:Number.isFinite(Number(data.last_view_at))?Number(row[kind+'_time'])>Number(data.last_view_at):null,
     source:{business:item.business,type:item.type,subjectId:decimal(item.subject_id),sourceId:decimal(item.source_id),rootId:decimal(item.root_id)}};
   }).filter(Boolean);items.push(...rows);
   const previous=cursor;cursor=data.cursor.is_end||!data.items.length||initializing[kind]||rows.length&&since[kind]&&rows.every(row=>row.createdAt&&row.createdAt<since[kind])?null:{id:decimal(data.cursor.id),time:decimal(data.cursor.time)};
   if(!cursor)break;assert.ok(cursor.id&&cursor.time,'B站消息游标缺失');const key=JSON.stringify(cursor);assert.ok(!seen.has(key)&&JSON.stringify(previous)!==key,'B站消息游标重复');seen.add(key);partial=true;
  }
  return {items,fetched,partial:!!cursor,cursor:{next:cursor}};
  }catch(error){return {items,fetched,partial:true,cursor:{next:cursor},error:safeError(error)};}
 }
 async function messages(session,previous){let end=previous?.nextEndSeqno??null,target=previous?.targetMaxSeqno??decimal(session.max_seqno),oldMax=decimal(previous?.maxSeqno),items=[],fetched=false;
  if(oldMax&&oldMax===decimal(session.max_seqno)&&!end)return {items,cursor:previous,partial:false};
  try{for(let page=0;page<3;page++){
   const data=await request('/svr_sync/v1/svr_sync/fetch_session_msgs',{host:'vc',signed:true,signal,params:{talker_id:String(session.talker_id),session_type:1,size:20,sender_device_id:1,build:0,mobi_app:'web',...(end?{end_seqno:end}:{})}});
   assert.ok(Array.isArray(data.messages),'B站私信结构不完整');fetched=true;if(!end)target=decimal(data.max_seqno)??target;
   for(const m of data.messages){const id=decimal(m.msg_key),seq=decimal(m.msg_seqno);if(!id||!seq||oldMax&&BigInt(seq)<=BigInt(oldMax)||String(m.sender_uid)!==String(session.talker_id)||String(m.sender_uid)===uid||Number(m.receiver_type)!==1||String(m.receiver_id)!==uid||Number(m.msg_status)===1||[5,8].includes(Number(m.msg_type)))continue;
    let text='[消息类型 '+clean(m.msg_type,20)+'，未解析正文]';try{const body=typeof m.content==='string'?parseBiliJson(m.content):m.content;if(Number(m.msg_type)===1&&typeof body?.content==='string')text=body.content;else if(Number(m.msg_type)===2)text='[图片消息]';else if([7,11].includes(Number(m.msg_type)))text=body?.title??body?.content??'[视频或分享卡片]';}catch{text='[消息正文解析失败]';}
    items.push({kind:'dm',id,seq,mid:String(session.talker_id),nickname:clean(session.account_info?.name,100),createdAt:timestamp(m.timestamp),text:clean(text),unread:Number(session.unread_count)>0});
   }
   const min=decimal(data.min_seqno),crossed=oldMax&&min&&BigInt(min)<=BigInt(oldMax),tooOld=since.dm&&data.messages.length&&data.messages.every(m=>timestamp(m.timestamp)&&timestamp(m.timestamp)<since.dm);
   if(!data.has_more||!data.messages.length||crossed||tooOld||initializing.dm)return {items,partial:false,cursor:{maxSeqno:target}};
   assert.ok(min&&min!==end,'私信分页游标缺失或重复');end=min;
  }return {items,partial:true,cursor:{maxSeqno:oldMax,nextEndSeqno:end,targetMaxSeqno:target}};
  }catch(error){return {items,partial:true,cursor:{maxSeqno:oldMax,nextEndSeqno:end,targetMaxSeqno:target},error:safeError(error)};}
 }
 async function direct(){const old=cursors.dm??{},sessions={...old.sessions},items=[];let end=old.nextSessionTs??null,fetched=false,partial=false,error,processed=0;const seen=new Set();
  try{for(let page=0;page<3;page++){
   const data=await request('/session_svr/v1/session_svr/get_sessions',{host:'vc',signed:true,signal,params:{session_type:1,group_fold:1,unfollow_fold:0,sort_rule:2,size:20,build:0,mobi_app:'web',...(end?{end_ts:end}:{})}});
   assert.ok(Array.isArray(data.session_list),'B站私信会话结构不完整');fetched=true;let last=end;
   for(let n=0;n<data.session_list.length;n++){const session=data.session_list[n];last=decimal(session.session_ts)??last;
    if(Number(session.session_type)!==1||Number(session.system_msg_type)!==0||!decimal(session.talker_id)||String(session.talker_id)===uid)continue;
    const key=String(session.talker_id);if(sessions[key]?.maxSeqno===decimal(session.max_seqno)&&!sessions[key]?.nextEndSeqno)continue;
    const result=await messages(session,sessions[key]);items.push(...result.items);sessions[key]=result.cursor;partial||=result.partial;error??=result.error;processed++;
    if(processed>=10){end=n<data.session_list.length-1||data.has_more?last:null;return {items,fetched,partial:partial||!!end,cursor:{sessions,nextSessionTs:end},...(error?{error}:{})};}
   }
   if(!data.has_more||!data.session_list.length){end=null;break;}assert.ok(last&&last!==end&&!seen.has(last),'私信会话游标缺失或重复');seen.add(last);end=last;
  }
  return {items,fetched,partial:partial||!!end,cursor:{sessions,nextSessionTs:end},...(error?{error}:{})};
  }catch(cause){return {items,fetched,partial:true,cursor:{sessions,nextSessionTs:end},error:safeError(cause)};}
 }
 if(dm)streams.dm=await direct();if(at){streams.at=await feed('at');streams.reply=await feed('reply');}
 return {streams};
}
