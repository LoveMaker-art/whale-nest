import assert from 'node:assert/strict';
import {hash} from './routing.mjs';
import {localClock} from './companion-policy.mjs';
import originalSpeakUp from './aurabot-speakup.generated.mjs';

/** Original topic/timing strategy with shared state and two dispatch adapters. */
export function createSpeakUpAdapter(ctx,options,{policy,getConfig,getNative,dispatch,now=Date.now,random=Math.random}) {
  const sending=new Set(),flights=new Set();let stopped=false;
  const ownerChat=()=>`private:${getConfig().ownerQQ}`;
  function track(promise){flights.add(promise);promise.finally(()=>flights.delete(promise)).catch(()=>{});return promise;}
  function projectedConfig(){
    const cfg=getConfig(),s=policy.status().settings;
    return {...cfg,enabled:true,speakUp:{...cfg.speakUp,enabled:s.contactEnabled,
      idleMinutes:s.idleMinutes,awakeFrom:s.awakeFrom,awakeTo:s.awakeTo,maxPerDay:s.maxProactivePerDay,nudge:false,allow:[]}};
  }
  async function dispatchContact(job){
    if(stopped)return false;
    if(job.route.channel==='clawchat')return dispatch?.(job)??false;
    const native=getNative();
    if(native.hub.backgroundBusy(ownerChat()))return false;
    const inputId='whalenest-contact-input-'+hash(job.id);
    await native.hub.pushToSession({chatId:ownerChat(),kind:'private',userId:getConfig().ownerQQ,nickname:getConfig().ownerName||'主人'},
      [{type:'text',text:job.prompt}],'',{backgroundJob:{id:job.id,inputId}});
    return true;
  }
  async function queue(content){
    const prompt=content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const job=policy.queueContact(prompt);
    return policy.dispatchJob(job.id,dispatchContact);
  }
  function wrapModule(){return {...originalSpeakUp,setup(api){
    return originalSpeakUp.setup({...api,config:projectedConfig,
      speakUpPorts:{now,random,loadState:policy.contactState,saveState:policy.saveContact,
        clockParts:()=>{const c=localClock(now());return {date:c.date,hour:Math.floor(c.minutes/60)};},
        beforeTick:()=>stopped?'closed':policy.contactReason()},
      core:{...api.core,hub:{get lastOwnerChatAt(){return policy.status().lastOwnerAt;},
        get lastBotToOwner(){return {at:policy.status().lastAutomaticAt,text:''};},
        pushToSession:(_chat,content)=>track(queue(content))}},
    });
  }};}
  async function sendPrepared(job,send){
    if(stopped||job.state!=='awaiting-delivery'||job.deliveryHeld||sending.has(job.id))return;
    sending.add(job.id);
    try{await send();}catch(error){if(policy.getJob(job.id).deliveryHeld)policy.nativeReceipt(job.id,{error:true});throw error;}
    finally{policy.nativeReceipt(job.id,{done:true});sending.delete(job.id);}
  }
  const background={
    admit({jobId,sessionId,inputId,chat}){
      const job=policy.getJob(jobId);assert.ok(job?.kind==='contact'&&job.route.channel==='qq'&&chat.chatId===ownerChat(),'Unverified QQ background route');
      policy.accept(jobId,String(sessionId),String(inputId));
    },
    jobForSession:session=>{const job=policy.nativeJob(session);return job?.kind==='contact'?job:null;},
    completeTurn({jobId,session,text,completed,send}){return track((async()=>{
      const job=policy.getJob(jobId);assert.equal(job?.sessionId,String(session.id),'QQ completion identity mismatch');
      assert.ok(await ctx.sessions.flush(session),'QQ background completion must be durable');
      const finished=policy.finish([job.inputId],{text,completed});
      await sendPrepared(finished,send);
    })());},
    beforeSend(jobId,{chatId}){
      const job=policy.getJob(jobId);
      assert.ok(job?.kind==='contact'&&chatId===ownerChat()&&sending.has(jobId),'Unverified QQ background sender');
      if(job.nativeUncertain)return 'held';
      const blocked=policy.delivery(jobId,{begin:!job.deliveryHeld,continuing:!!job.deliveryHeld});
      if(!blocked)policy.nativeReceipt(jobId,{attempt:true});
      else if(job.deliveryHeld)policy.nativeReceipt(jobId,{incomplete:true});
      return blocked;
    },
    sent(jobId,result){policy.nativeReceipt(jobId,result?.message_id!==undefined?{messageId:result.message_id}:{error:true});},
    sendError(jobId){policy.nativeReceipt(jobId,{error:true});},
    ownerInput(msg){
      if(msg.kind!=='private'||String(msg.userId)!==getConfig().ownerQQ)return;
      const owner=options.owners.find(o=>o.channel==='qq'&&o.sender===String(msg.userId)&&o.account===getConfig().botQQ);
      if(owner)policy.input(msg.text,{id:msg.id,route:{...owner,kind:'private',conversation:owner.sender}});
    },
    ownerGuide({text}){
      if(text.includes('运维自测'))return '';
      const guide=policy.qqOnboarding();
      return guide?'【一次性的接入提示，不是主人发言】本轮正常回复后顺口问：QQ这边也能聊啦，以后主动消息发QQ还是ClawChat？未回答保持当前设置，不反复问；选择平台不自动开启任何功能。主人回答后可用companion_settings更新proactivePlatform。':'';
    },
  };
  async function resume(){
    if(stopped)return;
    for(const job of policy.pendingContacts()){
      if(['queued','deferred'].includes(job.state))return policy.dispatchJob(job.id,dispatchContact);
      if(job.state==='awaiting-delivery'&&job.route.channel==='qq'&&!job.deliveryHeld)
        return track(sendPrepared(job,()=>getNative().hub.deliver(ownerChat(),job.reply,{own:true,backgroundJob:job.id})));
    }
  }
  return {wrapModule,background,resume,async dispose(){stopped=true;await Promise.allSettled([...flights]);}};
}
