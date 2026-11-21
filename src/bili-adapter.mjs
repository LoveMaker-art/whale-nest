import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import originalModule from './aurabot-bili-module.generated.mjs';
import {createBiliApi} from './aurabot-bili-api.generated.mjs';
import {activityTools} from './activities.mjs';
import {nativeOperationId,requireManualOwnerTurn,nativeTurnSource} from './native-tool.mjs';
import {senderKey} from './routing.mjs';
import {localClock} from './companion-policy.mjs';
import {readState,writeState} from './state.mjs';
import {avatarSource} from '../vendor/aurabot/src/modules/profile/index.js';

export const biliCallContext=new AsyncLocalStorage();
const log={debug(){},info(){},warn(){}};
export const isBiliTool=name=>name.startsWith('bili_')||['qq_send_shot','qq_list_shots','companion_experiences'].includes(name);

/** One original module, one vault/ledger; per-call context only selects transport. */
export function createBiliAdapter(ctx,options,{policy,account,http,activities,features,rules,getConfig,getRoute,sendImage,queueDelivery,referenceImage,now=Date.now}){
 const stateFile=join(options.dataDir,'aurabot','bili.json');let backend,closed=false;
 const raw=createBiliApi({getCookie:account.getCookie,log,fetchImpl:(url,init={})=>{
  const signal=biliCallContext.getStore()?.signal;return fetch(url,{...init,...(signal?{signal:init.signal?AbortSignal.any([signal,init.signal]):signal}:{}),redirect:'error'});
 }});
 activities.importOriginalHistory(readState(stateFile,{history:[]}).history??[]);
 function owner(route){return route?.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route));}
 function contextFor(sessionId,exec,original=false,chat){
  const route=getRoute(sessionId,chat);assert.ok(route,'Unverified Bili caller');
  return {sessionId,route,actor:exec,owner:owner(route),original,requestId:nativeOperationId(exec),signal:exec.signal};
 }
 function config(){const cfg=getConfig(),call=biliCallContext.getStore(),s=policy.status().settings;
  return {...cfg,enabled:true,dryRun:call?.route?.channel==='clawchat'?false:cfg.dryRun,
   bili:{...cfg.bili,cookie:account.getCookie(),minViews:rules.settings().minViews,...(call?.job?{perRun:1,keywords:s.interests,comment:false,reply:false,like:false,autoDanmaku:false,shotChance:0,shareToOwner:true}:{})}};
 }
 async function mutation(kind,input,action){
  const call=biliCallContext.getStore();assert.ok(call?.actor&&!call.job,'自动任务不能写入B站账号');
  const source=nativeTurnSource(call.actor.agent.session);assert.ok(source&&!source.taskId&&!policy.nativeJob(call.actor.agent.session),'后台任务不能写入B站账号');
  if(!call.original)requireManualOwnerTurn(call.actor);
  else assert.ok(source.kind==='user'&&call.owner||source.kind==='aurabot','原工具需要真实用户请求');
  const result=await account.mutate({requestId:call.sessionId+':'+call.requestId,kind,input},action);call.receipt=result;
  if(!result.ok)throw Object.assign(Error(result.message??'B站操作未确认'),{operationResult:result});
  return result.receipt;
 }
 const api=new Proxy(raw,{get(target,key){
  if(key==='nav')return async()=>{const r=await account.whoami(http);return {isLogin:r.state==='logged-in',mid:account.status().uid,uname:account.status().name};};
  if(key==='search')return async query=>(await activities.search(query,{limit:50})).results.map(v=>({...v,pubdate:v.publishedAt,play:v.play}));
  if(key==='popular')return async(...args)=>{const s=rules.settings();return(await raw.popular(...args)).filter(v=>(!s.minViews||Number(v.play)>=s.minViews)&&(!s.minAgeDays||Number(v.pubdate)>0&&Number(v.pubdate)<=now()-s.minAgeDays*86400000));};
  if(key==='postComment')return (aid,text,{root,parent}={})=>mutation('reply',{aid,text,root:root??null,parent:parent??null},async()=>{
   const result=await raw.postComment(aid,text,{root,parent});assert.match(String(result.rpid??''),/^\d+$/,'评论缺少确认编号');return {...result,commentId:String(result.rpid)};
  });
  if(key==='likeVideo')return aid=>mutation('interact',{aid,mode:'like'},async()=>{await raw.likeVideo(aid);return {action:'like',accepted:true};});
  if(key==='setSign')return text=>mutation('profile',{action:'sign',text},async()=>{await raw.setSign(text);return {action:'sign',accepted:true};});
  if(key==='setFace')return image=>mutation('profile',{action:'avatar',image:Buffer.isBuffer(image)?{sha256:createHash('sha256').update(image).digest('hex')}:image},async()=>{await raw.setFace(image);return {action:'avatar',accepted:true};});
  if(key==='postDanmaku')return(info,text,progress,mode,config)=>mutation('danmaku',{cid:info.cid,text,progress,mode},async()=>{
   const result=await raw.postDanmaku(info,text,progress,mode,config);assert.match(String(result.dmid_str??result.dmid??''),/^\d+$/,'弹幕缺少确认编号');return result;
  });
  const value=target[key];if(typeof value!=='function')return value;
  return async(...args)=>{const signal=biliCallContext.getStore()?.signal;signal?.throwIfAborted();const result=await value(...args);signal?.throwIfAborted();return result;};
 }});
 function withTool(tool,where,original){return {...tool,description:tool.description?.replaceAll('当前 QQ 聊天','当前会话'),async execute(args,exec){
  return biliCallContext.run(contextFor(where.sessionId,exec,original,where.chat),async()=>{
   const call=biliCallContext.getStore();try{const result=await tool.execute(args,exec);return call.receipt?{...result,...call.receipt}:result;}
   catch(error){if(error.operationResult)return error.operationResult;throw error;}
  });
 }};}
 function onRead(read){const call=biliCallContext.getStore();if(!call?.owner||call.readThroughLedger)return;
  const saved=activities.recordRead(read,{sessionId:call.sessionId,requestId:call.requestId,trigger:call.job?'automatic':'manual',jobId:call.job?.id});call.activityId=saved.activityId;
 }
 function onHistory(item){const call=biliCallContext.getStore();if(call?.activityId)activities.annotate(call.activityId,item);}
 function loadState(){const s=readState(stateFile,{day:'',runs:0,comments:0,replies:0,lastRun:0,lastReplyCheck:0,seen:[],repliedFeed:[]});return {...s,history:activities.originalHistory()};}
 function saveState(s){const {history,...rest}=s;writeState(stateFile,rest);}
 function module(){return {...originalModule,setup(host){
  const nativeHub=host.core.hub;
  const hub=new Proxy(nativeHub,{get(target,key){
   if(key==='runSystemTurn')return(name,title,prompt,config={})=>{
    const call=biliCallContext.getStore();assert.ok(call?.job,'B站自动模型调用必须归属共同任务');
    return nativeHub.runSystemTurn(name,title,prompt,{...config,noTools:true,key:'shared-owner',backgroundTask:{id:call.job.id,admit(sessionId,inputId){policy.bindSystemInput(call.job.id,sessionId,inputId);call.sessionId=String(sessionId);}}});
   };
   if(key==='sendText')return async(_chat,text)=>{const call=biliCallContext.getStore();assert.ok(call?.job,'B站自动分享必须归属共同任务');call.shares.push(text);return {queued:true};};
   if(key==='sendImage')return async(_chat,file)=>{const call=biliCallContext.getStore();assert.ok(call?.owner&&!call.job,'截图仅按主人本轮要求发送');return sendImage(call,file);};
   return Reflect.get(target,key);
  }});
  const originalRegister=host.tool.bind(host);
  const wrapped={...host,config,core:{...host.core,hub},
   every(ms,fn,label){if(label!=='刷B站')host.every(ms,fn,label);},
   tool(factory){originalRegister(where=>{
    const values=factory(where),items=(Array.isArray(values)?values:values?[values]:[]);
    const linkedOwner=where.chat.kind==='private'&&String(where.chat.userId)===getConfig().ownerQQ;
    const common=linkedOwner?new Set([...activityTools(activities,where.sessionId),...features.tools(where.sessionId)].map(t=>t.name)):new Set();
    return items.filter(t=>!common.has(t.name)).map(t=>withTool(t,where,true));
   });},
   biliPorts:{api,now,day:()=>localClock(now()).date,loadState,saveState,onRead,onHistory,afterBrowse:async()=>{},
    danmaku:{prepare:async({video,part,signal,beforePost})=>{const info=await api.danmakuInfo(video,part,{signal});return {info,post:(text,progress,mode)=>api.postDanmaku(info,text,progress,mode,{signal,beforePost})};}},
    async avatarSource(raw,{sessionId,chat,previous}){
     if(!/^(last|刚才|上一张|最近)/i.test(raw)&&raw)return avatarSource(raw);
     const call=biliCallContext.getStore();
     if(call?.route.channel==='qq')return avatarSource(previous??'');
     const image=await referenceImage?.(sessionId,call?.actor,chat);if(!image)return {ok:false,message:'当前会话没有可取得的参考图片，请提供图片或明确图片网址。'};
     assert.ok(image.length<=2*1024*1024,'头像图片超过2MiB');return {ok:true,file:image};
    },
   }};
  backend=originalModule.setup(wrapped);
  originalRegister(where=>config().bili.enabled&&where.level==='full'&&where.chat.kind==='private'&&String(where.chat.userId)===getConfig().ownerQQ
   ?[...activityTools(activities,where.sessionId,{backgroundJob:exec=>policy.nativeJob(exec.agent.session)}),...features.tools(where.sessionId)].map(t=>withTool(t,where,false)):[]);
  host.context(({chat})=>chat.kind==='private'&&String(chat.userId)===getConfig().ownerQQ?[activities.context(),features.inbox.context()].filter(Boolean).join('\n'):'');
  return backend;
 }};}
 async function read(link,context){assert.ok(backend,'Original Bili module unavailable');const parent=biliCallContext.getStore();
  return biliCallContext.run({...parent,...context,route:parent?.route??options.clawchat?.route,owner:true,readThroughLedger:true},()=>backend.watch(link,{details:true}));
 }
 async function comment(link,text,settings,exec,sessionId){
  requireManualOwnerTurn(exec);const call=contextFor(sessionId,exec,false);return biliCallContext.run(call,async()=>{
   try{const result=await backend.comment(link,text,settings);return call.receipt?{...result,...call.receipt}:result;}
   catch(error){if(error.operationResult)return error.operationResult;throw error;}
  });
 }
 async function run(job){
  assert.ok(backend&&!closed,'Original Bili module unavailable');if(!getConfig().bili.enabled)return false;const target=policy.assignTarget(job.id);if(!target.available)return false;
  const call={job:target,owner:true,route:target.route,sessionId:'bili:'+job.id,requestId:job.id,shares:[]};
  const result=await biliCallContext.run(call,()=>backend.run());
  const current=policy.getJob(job.id);assert.ok(current.inputId,'Bili model job was not admitted');
  const finished=policy.finish([current.inputId],{text:result.ok?(call.shares.length?call.shares.join('\n\n'):'[沉默]'):result.message,completed:result.ok});
  if(finished.state==='awaiting-delivery')await queueDelivery(finished);
  return true;
 }
 async function resume(){for(const job of policy.pendingBrowses())if(job.engine==='aurabot-bili'&&job.state==='awaiting-delivery'&&!job.cancelRequested&&!job.deliveryHeld)await queueDelivery(job);}
 return {module,read,comment,run,resume,modelContext:()=>biliCallContext.getStore()?.job?{jobId:biliCallContext.getStore().job.id}:null,close(){closed=true;},get backend(){return backend;}};
}
