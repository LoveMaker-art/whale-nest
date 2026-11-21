import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hash,routeKey,senderKey,ownerScope,resolveDeliveryTarget} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {resolveAudience} from '../vendor/aurabot/src/features/qzone-audience.js';

const exec=promisify(execFile);
/** Publishes an explicitly approved projection of public activity facts.
 * Credentials and transport remain owned by the existing Core. */
export function createDiaryPublisher(options,route,{diary,run=exec,now=Date.now,getQzone}={}){
 assert.ok(resolveDeliveryTarget(options,{origin:route}).ok,'发布档案仅限已关联主人私聊');
 const scope=ownerScope(options),cc=options.clawchat.route,legacy=hash([options.instanceId,routeKey(cc),senderKey(cc)]),file=join(resolve(options.dataDir),'diary-publications.json');
 const state=readState(file,{schema:2,scope,identityScope:legacy,records:{}});assert.ok(state.scope===scope||state.schema===1&&state.scope===legacy,'发布档案归属不符');
 state.schema=2;state.scope=scope;state.identityScope??=legacy;assert.equal(state.identityScope,legacy,'旧发布请求身份不符');
 Object.assign(state.records,state.retainedQQRecords??{});delete state.retainedQQRecords;
 for(const record of Object.values(state.records))if(record.scope===legacy)record.scope=scope;
 const save=()=>writeState(file,state),flights=new Map();save();
 const delivery=options.clawchat.delivery;
 async function call(tool,input,requestId){assert.ok(delivery?.connectBin&&delivery.configPath,'Core接线不可用');
  try{const {stdout}=await run(delivery.connectBin,['tool','call',tool,'--agent',route.account,'--request-id',requestId,'--input-json',JSON.stringify(input),'--config',delivery.configPath],{timeout:40000,maxBuffer:1024*1024});return JSON.parse(stdout);}
  catch(error){try{if(error.stdout)return JSON.parse(error.stdout);}catch{}return {status:'unknown'};}
 }
 async function permissions(){const response=await call('clawchat_get_agent_permissions',{},'whalenest-permissions-'+randomUUID());if(response.status!=='succeeded')return {ok:false,state:'unavailable',message:'当前未能读取ClawChat动态权限，禁止据默认值发布。'};
  const data=response.result;assert.ok(data&&typeof data==='object','权限响应不完整');return {ok:true,visibility:data['moment.visibility'],publish:data['moment.publish'],delete:data['moment.delete'],windows:data.permission_windows??{},checkedAt:now(),message:'可见范围属于Agent全局设置，未来修改也会影响历史动态。'};
 }
 function preview(date){const entry=diary.read(date);if(!entry.ok)return entry;
  const id='whalenest-diary-publish-'+hash([state.identityScope,entry.date,entry.revision]);
  const text=[entry.date+' · 伙伴活动',...entry.sources.map(s=>'整理了《'+s.title+'》的实际可用资料。没有分析画面或完整播放视频。\n'+s.url),'[鲸栖日记 '+id.slice(-16)+']'].join('\n\n');
  assert.ok(Buffer.byteLength(text,'utf8')<=5000,'日记公开活动摘要超过平台5000字节限制，请先减少素材');
  return {ok:true,date:entry.date,revision:entry.revision,requestId:id,text,audience:'owner',enabled:options.activities?.momentPublicationEnabled===true,message:'这是仅含公开活动来源的拟发布正文，不包含私人感想或主人私聊；动态受众以后可能随主人全局设置变化。'};
 }
 const view=record=>({ok:record.state==='confirmed',state:record.state,date:record.date,revision:record.revision,requestId:record.id,...(record.momentId?{momentId:record.momentId}:{}),...(record.deletion?{deletion:record.deletion.state}:{}),message:record.state==='confirmed'?'平台已确认动态发布；私人日记原件独立保留。':'发布结果尚未确认，禁止另起请求重发，请查询publication_status。'});
 function settle(record,response){const moment=response?.result?.moment;
  if(response?.status==='succeeded'&&Number.isSafeInteger(moment?.id)&&moment.id>0&&moment.text===record.text){record.state='confirmed';record.momentId=moment.id;}
  // A failed CLI result can conceal a server-side approval or a lost reply.
  // Only its stable Core request may be reconciled; it is never resubmitted.
  record.checkedAt=now();save();return view(record);
 }
 async function publish(date,approvedText){const draft=preview(date);if(!draft.ok)return draft;
  if(options.activities?.momentPublicationEnabled!==true)return {ok:false,state:'approval-required',draft,message:'当前仅私人归档。请先确认这份正文、全局受众和删除条件，再启用动态发布。'};
  assert.equal(approvedText,draft.text,'需要主人确认的完整拟发布正文，不能发布未核对的私人日记');
  const previous=state.records[draft.requestId];if(previous){assert.equal(previous.text,draft.text);if(flights.has(previous.id))await flights.get(previous.id);return {...view(previous),duplicate:true};}
  const permission=await permissions();if(!permission.ok)return permission;
  if(JSON.stringify(permission.visibility)!=='["owner"]')return {ok:false,state:'audience-changed',message:'当前受众不再是仅主人，未执行发布，需要重新核对受众。'};
  if(permission.publish!=='allow'&&!(Number(permission.windows['moment.publish'])>now()))return {ok:false,state:'permission-required',message:'当前平台未允许直接发布，未提交审批或写入。'};
  // Recheck content after the read-only permission call, before reserving.
  assert.equal(preview(date).text,draft.text,'读取权限期间日记版本已变化，未发布');
  if(state.records[draft.requestId])return view(state.records[draft.requestId]);
  const record={id:draft.requestId,date:draft.date,revision:draft.revision,text:draft.text,scope,platform:'clawchat',state:'uncertain',permissions:permission,createdAt:now()};state.records[record.id]=record;save();
  const work=call('clawchat_create_moment',{text:record.text},record.id).then(response=>settle(record,response));flights.set(record.id,work);try{return await work;}finally{flights.delete(record.id);}
 }
 async function check(date){const records=Object.values(state.records).filter(r=>r.date===date&&(r.platform??'clawchat')==='clawchat').sort((a,b)=>b.revision-a.revision);const record=records[0];if(!record)return {ok:false,state:'not-published',message:'该日日记没有动态提交记录。'};
  if(record.state!=='confirmed')try{const {stdout}=await run(delivery.connectBin,['tool','status',record.id,'--agent',route.account,'--config',delivery.configPath],{timeout:15000,maxBuffer:1024*1024});settle(record,JSON.parse(stdout));}catch{}
  if(record.state==='confirmed'){const response=await call('clawchat_list_moments',{limit:100},'whalenest-moment-read-'+randomUUID());const rows=response.result?.moments;
   return {...view(record),readback:response.status==='succeeded'&&Array.isArray(rows)&&rows.some(row=>row.id===record.momentId&&row.text===record.text)?'matched':'unconfirmed'};
  }return view(record);
 }
 async function remove(date){const record=Object.values(state.records).filter(r=>r.date===date&&(r.platform??'clawchat')==='clawchat'&&r.state==='confirmed').sort((a,b)=>b.revision-a.revision)[0];if(!record)return {ok:false,state:'not-published',message:'没有可删除的确认发布记录。'};
  if(record.deletion)return {...view(record),ok:record.deletion.state==='confirmed',state:record.deletion.state,message:record.deletion.state==='confirmed'?'该平台动态已删除，私人日记仍保留。':'删除结果不确定，未重发删除请求。'};
  const permission=await permissions();if(!permission.ok)return permission;
  if(permission.delete!=='allow'&&!(Number(permission.windows['moment.delete'])>now()))return {ok:false,state:'permission-required',message:'当前ClawChat删除策略需要主人审批或禁止，未擅自提交或更改权限。'};
  record.deletion={id:record.id+'-delete',state:'uncertain',createdAt:now()};save();const result=await call('clawchat_delete_moment',{momentId:record.momentId},record.deletion.id);
  if(result.status==='succeeded'&&result.result?.ok===true)record.deletion.state='confirmed';save();return {ok:record.deletion.state==='confirmed',state:record.deletion.state,momentId:record.momentId,message:record.deletion.state==='confirmed'?'该平台动态已删除，私人日记仍保留。':'删除结果不确定，未重发请求。'};
 }

 const qqView=r=>({ok:r.state==='confirmed',platform:'qq',state:r.state,date:r.date,revision:r.revision,requestId:r.id,...(r.tid?{tid:r.tid}:{}),...(r.deletion?{deletion:r.deletion.state}:{}),visibility:r.visibility,
  message:r.state==='confirmed'?'QQ空间已返回确认编号；私人日记保留。':'QQ空间发布结果未确认，原请求已持有，不自动重发。'});
 function qqPermissions(visibility){const service=getQzone?.();assert.ok(service,'原QQ空间模块尚未接入');return {ok:true,platform:'qq',...resolveAudience(service.config(),visibility),connected:service.connected(),message:'使用原QQ空间受众规则；单次仅可收窄，接收通知首选不改变公开发布位置。'};}
 function qqPreview(date,visibility){const entry=diary.read(date);if(!entry.ok)return entry;const audience=qqPermissions(visibility),id='whalenest-qzone-diary-'+hash([scope,entry.date,entry.revision,audience.visibility,audience.target_uins??[]]);
  const text=[entry.date+' · 伙伴活动',...entry.sources.map(s=>'整理了《'+s.title+'》的实际可用资料。'+(s.coverage?.vision?'仅分析抽帧，未完整播放。':'未分析画面或完整播放。')+'\n'+s.url),'[鲸栖日记 '+id.slice(-16)+']'].join('\n\n');
  return {ok:true,platform:'qq',date:entry.date,revision:entry.revision,requestId:id,text,...audience,message:'仅含活动事实的QQ空间拟发布正文；请明确确认正文和受众，私人正文不会直接发布。'};
 }
 async function submitQQ({id,date,revision,text,images=[],visibility,expectedAudience,beforeSend}){
  const fingerprint=hash({text,images,visibility}),old=state.records[id];if(old){assert.equal(old.fingerprint,fingerprint,'空间发布请求与内容冲突');if(flights.has(id))await flights.get(id);return {...qqView(state.records[id]),duplicate:true};}
  const service=getQzone?.();assert.ok(service,'原QQ空间模块尚未接入');const cfg=service.config();
  if(!cfg.enabled||cfg.dryRun||!service.connected())return {ok:false,platform:'qq',state:'channel-unavailable',message:'QQ尚未连接或处于试运行，未提交空间发布。'};
  assert.ok(typeof text==='string'&&text.trim()&&text.length<=16000,'空间正文为空或过长');assert.ok(Array.isArray(images)&&images.length<=4,'空间图片最多4张');
  const audience=resolveAudience(cfg,visibility);if(expectedAudience)assert.deepEqual(audience,expectedAudience,'空间受众已变化，请重新预览');
  const record={id,scope,platform:'qq',date,revision,text,fingerprint,visibility:audience.visibility,state:'uncertain',createdAt:now()};state.records[id]=record;save();
  const work=(async()=>{try{const result=await service.post(text,{images,visibility,beforeSend:()=>{assert.deepEqual(resolveAudience(service.config(),visibility),audience,'发布前空间受众已变化');beforeSend?.();}});
    if(result.ok&&!result.dryRun&&typeof result.tid==='string'&&result.tid.trim()&&!/^(?:undefined|null|\[object)/.test(result.tid)){record.tid=result.tid;record.state='confirmed';}
    else record.error=String(result.message??'未返回真实空间编号').slice(0,300);
   }catch(error){record.error=String(error.message).slice(0,300);}record.checkedAt=now();save();return qqView(record);})();flights.set(id,work);try{return await work;}finally{flights.delete(id);}
 }
 async function qqPublish(date,approvedText,visibility){const draft=qqPreview(date,visibility);if(!draft.ok)return draft;
  assert.equal(approvedText,draft.text,'需要主人确认完整QQ空间正文');assert.equal(visibility,draft.visibility,'需要明确确认QQ空间受众');
  const {ugc_right,target_uins}=draft,expectedAudience={ugc_right,visibility:draft.visibility,label:draft.label,...(target_uins?{target_uins}:{})};
  return submitQQ({id:draft.requestId,date:draft.date,revision:draft.revision,text:draft.text,visibility,expectedAudience,beforeSend:()=>assert.equal(qqPreview(date,visibility).text,draft.text,'日记版本已变化')});
 }
 function qqCheck(date){const record=Object.values(state.records).filter(r=>r.platform==='qq'&&r.date===date).sort((a,b)=>b.revision-a.revision||b.createdAt-a.createdAt)[0];return record?qqView(record):{ok:false,platform:'qq',state:'not-published',message:'该日日记没有QQ空间提交记录。'};}
 async function qqRemove(date){const record=Object.values(state.records).filter(r=>r.platform==='qq'&&r.date===date&&r.state==='confirmed').sort((a,b)=>b.revision-a.revision||b.createdAt-a.createdAt)[0];if(!record)return qqCheck(date);
  if(record.deletion)return {...qqView(record),ok:record.deletion.state==='confirmed',state:record.deletion.state};const service=getQzone?.();if(!service?.connected())return {ok:false,state:'channel-unavailable'};
  record.deletion={state:'uncertain',at:now()};save();try{await service.remove(record.tid);record.deletion.state='confirmed';}catch{}save();return {...qqView(record),ok:record.deletion.state==='confirmed',state:record.deletion.state};
 }
 return {preview,permissions,publish,check,remove,qq:{preview:qqPreview,permissions:qqPermissions,publish:qqPublish,check:qqCheck,remove:qqRemove},
  postQQ:({requestId,...input})=>submitQQ({id:'whalenest-qzone-post-'+hash([scope,requestId]),...input})};
}
