import {bridgeError,optionalObject,requestString} from './dsh-bridge-contract.mjs';

/** Translate native DSH approval/question requests over the same owned FD
 * connection. Native decisions remain authoritative; only unavailable decisions
 * are offered to the connected caller.
 */
export function createDshBridgeInteractions(ctx,{wire,handles,registerClawChatApprovalPolicy,registerQuestionProviderWhenProfileReady}){
 const pending=new Map();let sequence=0;
 const sessionFor=agent=>{
  for(const [id,handle]of handles)if(handle.agent===agent)return id;
 };
 async function ask(sessionId,request,signal){
  const id='dsh-interaction-'+(++sequence);
  const response=new Promise((resolve,reject)=>{
   const abort=()=>{pending.delete(id);reject(bridgeError('interaction-cancelled','DSH interaction was cancelled'));};
   if(signal?.aborted){abort();return;}
   signal?.addEventListener('abort',abort,{once:true});
   pending.set(id,{sessionId,
    resolve(value){signal?.removeEventListener('abort',abort);resolve(value);},
    reject(error){signal?.removeEventListener('abort',abort);reject(error);},
   });
  });
  response.catch(()=>{});
  try{await wire.send({type:'interaction',id,sessionId,request});}
  catch(error){const current=pending.get(id);pending.delete(id);current?.reject(error);throw error;}
  return await response;
 }
 const approval=registerClawChatApprovalPolicy(ctx,{
  owns:agent=>Boolean(sessionFor(agent)),configPath:process.env.CLAWCHAT_CONNECT_CONFIG,
  async ask(request,next){
   const sessionId=sessionFor(request.agent);if(!sessionId)return await next();
   const decision=await next();if(decision!==undefined&&decision!=='unavailable')return decision;
   try{
    const response=await ask(sessionId,{kind:'approval',
     action:request.toolName.toLowerCase().includes('write')?'file-change':'command',
     title:'DeepSeek Harness requests '+request.toolName,description:request.reason??`Allow ${request.toolName} for this turn?`,
     options:[{id:'approve-once',label:'Approve once'},{id:'deny',label:'Deny'}]},request.signal);
    if(response?.kind!=='approval')return 'unavailable';
    if(response.optionId==='approve-once')return 'allowed-once';
    return response.optionId==='cancel'?'cancelled':'rejected';
   }catch{return request.signal?.aborted?'cancelled':'unavailable';}
  },
 });
 const questions=registerQuestionProviderWhenProfileReady(ctx,{
  owns:request=>Boolean(sessionFor(request.agent)),
  async ask(request){
   const sessionId=sessionFor(request.agent);
   if(!sessionId)throw bridgeError('interaction-unavailable','DSH question has no Connect-owned Agent');
   const response=await ask(sessionId,{kind:'user-input',title:'DeepSeek Harness needs your answer',
    description:request.questions.length===1?request.questions[0].question:`Answer ${request.questions.length} DeepSeek Harness questions.`,
    questions:request.questions.map(question=>({id:question.id,header:question.header??question.id,prompt:question.question,
     secret:false,allowOther:true,options:question.options?.length?question.options.map(option=>({id:option.label,label:option.label,
      ...(option.description?{description:option.description}:{})})):null})),autoResolutionMs:null},request.signal);
   if(response?.kind!=='user-input')throw bridgeError('interaction-unavailable','Connect returned an incompatible question response');
   return {answers:request.questions.map(question=>{
    const values=response.answers[question.id]??[],labels=new Set(question.options?.map(option=>option.label)??[]);
    const selected=values.filter(value=>labels.has(value)),custom=values.find(value=>!labels.has(value));
    return {id:question.id,selected,...(custom?{custom}:{})};
   })};
  },
 });
 return {ready:questions.ready,observe:(agent,event)=>approval.observe(agent,event),
  async respond(params){
   const id=requestString(params,'id'),sessionId=requestString(params,'sessionId'),response=optionalObject(params.response);
   if(!response)throw bridgeError('malformed-request','interaction response must be an object');
   const current=pending.get(id);
   if(!current||current.sessionId!==sessionId)throw bridgeError('interaction-not-found','DSH interaction is no longer pending: '+id);
   pending.delete(id);current.resolve(response);return {accepted:true};
  },
  cancelAll(message){
   const error=bridgeError('interaction-cancelled',message);
   for(const current of pending.values())current.reject(error);pending.clear();
  },
  async dispose(){approval.dispose();await questions.dispose();},
 };
}
