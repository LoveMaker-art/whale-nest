import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {defineTool,str,bool} from '../vendor/aurabot/src/tools/tools.js';
import originalSocial from './aurabot-qq-social-module.generated.mjs';
import {nativeOperationId,requireManualOwnerTurn,nativeTurnSource} from './native-tool.mjs';
import {hash} from './routing.mjs';
import {readState,writeState} from './state.mjs';

export const QQ_NATIVE_MODULES=['qq-tools','qq-api','profile','contacts','qzone-social'];

/** Select the original modules. Loading a module must not opt into its timer. */
export function enableQQNativeModules(config){
 const first=config.modules?.['qzone-social']?.enabled!==true;
 return {...config,modules:{...config.modules,...Object.fromEntries(QQ_NATIVE_MODULES.map(id=>[id,{...config.modules?.[id],enabled:true,useBuiltin:true}]))},
  qzoneSocial:{...config.qzoneSocial,...(first?{enabled:false}:{})}};
}

export function qqSocialModule(def,ports={}){return {...def,setup(api){
 const {onebot,hub}=api.core;
 const result=def.setup({...api,qqSocialLifecycle:ports.lifecycle,core:{...api.core,hub:{...hub,runSystemTurn:(name,title,prompt,settings)=>
  ports.draft?ports.draft(hub,name,title,prompt,settings):hub.runSystemTurn(name,title,prompt,{...settings,noTools:true})},onebot:{...onebot,call:(action,params,settings)=>
  ports.call?ports.call(onebot,action,params,settings):onebot.call(action,params,['comment_qzone','like_qzone'].includes(action)?{...settings,retries:0}:settings)}}});
 ports.bind?.(result);return result;
}};}

/** The only additional QQ entry replaces the absent original manual web route. */
export function createQQNative(options,getNative,{policy,now=Date.now}={}){
 const active=new AsyncLocalStorage(),contexts=new Map(),automaticFile=join(options.dataDir,'qq-native/automatic-social.json');let backend,busy=false;
 function controlReason(){
  const n=getNative(),cfg=n?.getConfig();
  if(!cfg?.qzoneSocial.enabled)return 'social-disabled';
  if(options.qq?.enabled!==true||!cfg.enabled||cfg.dryRun||cfg.debug||n?.onebot.state!=='connected')return 'qq-unavailable';
  if(!policy)return 'budget-not-connected';
  const s=policy.status().settings;if(s.paused)return 'paused';
  // Only the common clock/window applies here; private-message targets and
  // their idle/cooldown counters do not route QQ space interactions.
  const reason=policy.maintenanceReason();return reason==='daily-model-limit'||reason==='background-model-disabled'?null:reason;
 }
 const reason=()=>controlReason()??policy?.maintenanceReason()??null;
 function save(call){writeState(automaticFile,call.record);}
 function allowed(){const call=active.getStore();return !!call&&!call.uncertain&&!controlReason();}
 function modelContext(request){
  const user=request?.messages?.findLast(m=>m.role==='user'&&['user','schedule','aurabot'].includes(m.source?.kind));
  const id=user?.source?.taskId;if(!String(id??'').startsWith('whalenest-qq-social-auto-'))return null;
  const bound=contexts.get(id);assert.ok(bound&&bound.sessionId===String(request.sessionId)&&bound.inputId===String(user.id),'QQ social model context is no longer active');return bound.call;
 }
 async function tick(run){
  const blocked=reason();if(blocked)return {state:'blocked',reason:blocked};
  if(busy)return {state:'blocked',reason:'busy'};
  const previous=readState(automaticFile,null);if(previous&&['running','held'].includes(previous.state))return {state:'held',operationId:previous.runId,reason:'previous-run-unconfirmed'};
  const cfg=getNative().getConfig();if(now()-backend.state().lastRun<cfg.qzoneSocial.intervalMin*60000)return {state:'blocked',reason:'interval'};
  busy=true;const runId='whalenest-qq-social-auto-'+randomUUID(),call={kind:'qq-social',runId,requests:0,effects:0,uncertain:false,record:{runId,state:'running',startedAt:now()}};call.allowed=()=>!call.uncertain&&!controlReason();save(call);
  try{
   const result=await active.run(call,run),interrupted=!result.ok;
   call.record={...call.record,state:call.uncertain||interrupted&&call.effects?'held':interrupted?'blocked':'completed',requests:call.requests,effects:call.effects,result,finishedAt:now()};save(call);return {...result,state:call.record.state,operationId:runId};
  }catch(error){call.record={...call.record,state:call.uncertain||call.effects?'held':'blocked',requests:call.requests,effects:call.effects,error:error.message,finishedAt:now()};save(call);return {ok:false,state:call.record.state,operationId:runId,message:error.message};}
  finally{contexts.delete(runId);busy=false;}
 }
 const ports={bind:value=>{backend=value;},lifecycle:{tick,canContinue:()=>!active.getStore()||!reason()&&!active.getStore().uncertain},
  async draft(hub,name,title,prompt,settings){const call=active.getStore();if(!call)return hub.runSystemTurn(name,title,prompt,{...settings,noTools:true});
   assert.ok(allowed(),'QQ social draft blocked: '+(controlReason()??'uncertain'));
   return hub.runSystemTurn(name,title,prompt,{...settings,noTools:true,backgroundTask:{id:call.runId,admit(sessionId,inputId){contexts.set(call.runId,{call,sessionId:String(sessionId),inputId:String(inputId)});}}});
  },
  async call(onebot,action,params,settings){const call=active.getStore(),write=['comment_qzone','like_qzone'].includes(action);
   if(call){assert.ok(allowed(),'QQ social action blocked: '+(controlReason()??'uncertain'));if(action==='like_qzone')assert.equal(reason(),null,'No budget for the next interaction');if(action==='comment_qzone')assert.ok(call.requests>0,'A comment requires a budgeted model result');}
   if(call&&write){call.record.pendingAction={action,parameters:hash(params),state:'uncertain'};save(call);}
   try{const result=await onebot.call(action,params,write?{...settings,retries:0}:settings);
    if(call&&write){call.effects++;call.record.pendingAction=null;save(call);}return result;
   }catch(error){if(call&&write){call.uncertain=true;save(call);}throw error;}
  },
 };
 function status(){const n=getNative(),last=readState(automaticFile,null);return {configured:options.qq?.nativeModules===true,connected:n?.onebot.state==='connected',
  modules:QQ_NATIVE_MODULES.filter(id=>n?.modules.use(id)),automaticSocial:n?.getConfig().qzoneSocial.enabled===true,budgetConnected:!!policy,automaticBlockedReason:reason()??(last&&['running','held'].includes(last.state)?'previous-run-unconfirmed':null),lastAutomaticRun:last};}
 function socialTool(){return defineTool({name:'qq_qzone_social',description:'仅QQ主人私聊管理原QQ空间互动。status查看记录和额度阻断原因；run在主人明确要求空间点赞、评论或回复时执行原模块一轮，产生实际社交动作及前台模型用量。update用enabled开关自动互动，开启必须有主人明确要求；自动模型请求纳入共同后台额度及暂停/作息，不连带开启其他活动。普通浏览不代表互动授权，未知不重做。',
  properties:{action:str('status/run/update'),enabled:bool('update时设置空间自动互动开关')},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],
  async execute(args,exec){
   nativeOperationId(exec);requireManualOwnerTurn(exec);const source=nativeTurnSource(exec.agent.session);
   assert.equal(source?.kind,'aurabot','QQ专属工具只接受原QQ会话');
   const native=getNative(),social=native.modules.use('qzone-social');assert.ok(social,'原QQ空间互动模块未加载');
   const action=args.action??'status';if(action==='status')return {ok:true,...status(),...social.state()};
   if(action==='update'){
    assert.equal(typeof args.enabled,'boolean','需要明确的自动开关值');
    if(args.enabled)assert.ok(policy&&/空间|说说/.test(source.humanText??'')&&/自动|定时/.test(source.humanText??'')&&/开启|打开|启用/.test(source.humanText??'')&&!/(不要|禁止|别).{0,8}(开|启|自动)/.test(source.humanText??''),'开启需要共同额度已接通及主人明确要求QQ空间自动互动');
    const cfg=native.getConfig();native.setConfig({...cfg,qzoneSocial:{...cfg.qzoneSocial,enabled:args.enabled}});return {ok:true,...status()};
   }
   assert.equal(action,'run','未知空间操作');assert.ok(native.getConfig().enabled&&native.onebot.state==='connected','QQ未连接');
   let message;for(let n=exec.agent.session.seq;n>=0;n--){const e=exec.agent.session.eventAt(n);if(e?.type==='user/message'){message=e.data.message??e.data;break;}}
   const text=source.humanText??message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
   assert.ok(/空间|说说/.test(text)&&/评论|点赞|互动|回复/.test(text)&&!/(不要|禁止|别).{0,8}(评论|点赞|互动|回复)/.test(text),'需要主人明确要求QQ空间互动，普通查看不会自动点赞评论');
   const id='whalenest-qq-social-'+hash([options.instanceId,String(exec.agent.id),String(message.id)]),file=join(options.dataDir,'qq-native/social-requests',id+'.json'),old=readState(file,null);
   if(old)return old.result??{ok:false,operationId:id,state:'uncertain',message:'原空间互动结果未确认，不另起请求重复执行'};
   writeState(file,{operationId:id,state:'uncertain'});
   try{const result={...await social.run({force:true}),operationId:id};writeState(file,{operationId:id,state:'completed',result});return result;}
   catch(error){return {ok:false,operationId:id,state:'uncertain',message:'原空间互动未确认：'+error.message};}
  }});}
 return {status,socialTool,module:()=>qqSocialModule(originalSocial,ports),modelContext,tick:()=>backend.tick()};
}
