import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import originalModule from './aurabot-diary-module.generated.mjs';
import {nativeOperationId,nativeTurnSource} from './native-tool.mjs';
import {hash} from './routing.mjs';

const calls=new AsyncLocalStorage();
/** Original compose and QQ space implementation, with one private archive. */
export function createDiaryAdapter(options,{service,policy,getConfig,getNative,queueDelivery}){
 let backend,onebot,closed=false;
 function module(){return {...originalModule,setup(host){
  const hub=host.core.hub,register=host.tool.bind(host);
  onebot=new Proxy(host.core.onebot,{get(target,key){if(key!=='call')return Reflect.get(target,key);
   return async(action,params,settings)=>{const r=await target.call(action,params,{...settings,...(['send_qzone_msg','delete_qzone_msg'].includes(action)?{retries:0}:{})});
    if(action==='send_qzone_msg'){const id=r?.tid??r?.id;assert.ok((typeof id==='string'&&id.trim()||Number.isSafeInteger(id)&&id>0),'QQ空间缺少真实发布编号');}return r;
   };
  }});
  backend=originalModule.setup({...host,core:{...host.core,onebot,hub:new Proxy(hub,{get(target,key){
   if(key==='runSystemTurn')return(name,title,prompt,settings={})=>{const call=calls.getStore();assert.ok(call,'私人日记必须通过共同归档入口生成');
    return target.runSystemTurn(name,title,prompt,{...settings,noTools:true,key:'private-'+hash([call.date,call.requestId]).slice(0,24),...(call.job?{backgroundTask:{id:call.job.id,admit(sessionId,inputId){policy.bindSystemInput(call.job.id,sessionId,inputId);}}}:{})});
   };return Reflect.get(target,key);
  }})},
   every(ms,fn,label){if(!['空间日记','归档公开浏览图'].includes(label))host.every(ms,fn,label);},
   tool(factory){register(where=>{const values=factory(where),tools=Array.isArray(values)?values:values?[values]:[];return tools.map(tool=>tool.name!=='qq_send_qzone'?tool:{...tool,parameters:{...tool.parameters,required:[...tool.parameters.required,'visibility']},description:tool.description+' 必须先明确确认本次实际受众，再填写visibility；通知首选不代表发布授权。',execute(args,exec){
    const source=nativeTurnSource(exec.agent.session);assert.ok(source&&!source.taskId&&!policy.nativeJob(exec.agent.session),'后台任务不能发布QQ空间');
    assert.ok(['aurabot','user'].includes(source.kind),'需要真实用户当前要求');
    assert.equal(args.visibility,service.publisher.qq.permissions(args.visibility).visibility,'需要明确确认实际QQ空间受众');
    return service.publisher.postQQ({requestId:where.sessionId+':'+nativeOperationId(exec),text:String(args.content??''),images:Array.isArray(args.images)?args.images.slice(0,4):[],visibility:args.visibility});
   }});});},
  });
  backend.writeDiary=async()=>({ok:false,state:'legacy-disabled',message:'本实例先按真实活动私人整理日记。请在对话中要求整理，公开发布再明确正文和受众；旧聊天取材直发未启用。'});
  backend.tick=async()=>({state:'shared-policy-only'});backend.nextTime=()=>0;
  register(where=>where.level==='full'&&where.chat.kind==='private'&&String(where.chat.userId)===getConfig().ownerQQ
   ?service.tools().filter(t=>t.name==='companion_diary').map(tool=>({...tool,execute:(args,exec)=>calls.run({sessionId:where.sessionId,requestId:nativeOperationId(exec),date:args.date??service.diary.today(),signal:exec.signal},()=>tool.execute(args,exec))})):[]);
  return backend;
 }};}
 async function compose(input){assert.ok(backend&&!closed,'原日记生成器尚未装载');const call=calls.getStore();assert.ok(call,'缺少可信日记生成上下文');call.signal?.throwIfAborted();const result=await backend.composePrivate(input);call.signal?.throwIfAborted();return result;}
 async function run(job){assert.ok(backend&&!closed,'原日记生成器不可用');const target=policy.assignTarget(job.id,{allowUnavailable:true});
  if(!target.route)return false;
  const result=await calls.run({job:target,date:job.date,requestId:job.id},()=>service.diary.write({date:job.date,requestId:job.id,automatic:true}));
  const current=policy.getJob(job.id);if(!current.inputId){policy.cancelJob(job.id);return true;}
  const finished=policy.finish([current.inputId],{text:result.message,completed:result.ok});
  if(finished.state==='awaiting-delivery')await queueDelivery(finished);return true;
 }
 async function resume(){for(const job of policy.pendingDiaries())if(job.engine==='aurabot-diary'&&job.state==='awaiting-delivery'&&!job.cancelRequested&&!job.deliveryHeld)await queueDelivery(job);}
 return {module,compose,run,resume,modelContext:()=>calls.getStore()?.job?{jobId:calls.getStore().job.id}:null,
  qzone:()=>({config:getConfig,connected:()=>options.qq?.enabled===true&&getConfig().enabled&&!getConfig().dryRun&&getNative()?.onebot.state==='connected',post:(...a)=>backend.post(...a),remove:(...a)=>backend.remove(...a),onebot}),close(){closed=true;}};
}
