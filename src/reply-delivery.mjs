import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readState,writeState} from './state.mjs';
import {createOfficialDelivery} from './official-delivery.mjs';

const exec=promisify(execFile),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds={minimal:['final','control'],normal:['final','assistant','control'],full:['final','assistant','tool','progress','reasoning','control']};
const kindOf=event=>kinds.full.includes(event.data?.outputKind)?event.data.outputKind:(event.kind==='assistant'?'assistant':event.kind==='error'?'final':event.kind==='reasoning'?'reasoning':
 ['tool','command','file-change'].includes(event.kind)?'tool':'progress');
function chunks(text){
 const result=[];let part='',size=0;
 for(const char of text){const length=Buffer.byteLength(char);if(size+length>4000){result.push(part);part='';size=0;}part+=char;size+=length;}
 if(part)result.push(part);return result;
}

/** Coordinates public text tools only when a reply needs an acknowledged
 * dependent sticker. Other replies remain on the ordinary Core surface. */
export function createReplyDelivery(options,route,{run=exec,outbox=createOfficialDelivery(options,route)}={}){
 return {
  async prepare(events,input,sessionId){
   const delivery=options.clawchat.delivery;
   if(input.metadata?.origin==='client'||input.outputPolicy?.mode==='client-full')return null;
   let mode=input.outputPolicy?.mode;
   if(!mode){
    let config;
    try{config=JSON.parse((await run(delivery.connectBin,['config','get','--config',delivery.configPath],
     {cwd:options.cwd,timeout:8000,maxBuffer:1024*1024})).stdout);}catch{return null;}
    mode=config.agents?.[route.account]?.outputVisibility??config.outputVisibility??'normal';
   }
   if(!kinds[mode])return null;
   const allowed=new Set(Array.isArray(input.outputPolicy?.allowedKinds)?input.outputPolicy.allowedKinds:kinds[mode]);
   const latest=new Map(events.map(event=>[event.id,event]));
   const visible=[...latest.values()].filter(event=>event.data?.deliveryDisposition!=='projection-only'
    &&event.data?.requiredControl!==true&&allowed.has(kindOf(event))&&typeof event.text==='string'&&event.text.trim());
   // Preserve Core's explicit media renderer; this path must never turn a
   // local image into a literal file path or upload it a second time.
   if(!visible.length||visible.some(event=>/!\[[^\]]*\]\(/.test(event.text)))return null;
   const id=hash([options.instanceId,route,input.turnId,sessionId]);
   const messages=visible.flatMap(event=>chunks(event.text).map((text,index)=>({id:'whalenest-reply-'+hash([id,event.id,index,text]),text})));
   const fingerprint=hash(messages),file=join(options.dataDir,'expressions','reply-groups',id+'.json');
   const previous=readState(file,null);
   if(previous)assert.equal(previous.fingerprint,fingerprint,'Reply text changed for an existing operation');
   else writeState(file,{schema:1,id,fingerprint,state:'prepared',messages,receipts:[],createdAt:Date.now()});
   return {file,fingerprint,messages,events:visible,turnId:input.turnId};
  },
  async send(plan,{signal,isCurrent=()=>true}={}){
   const record=readState(plan.file,null);assert.equal(record.fingerprint,plan.fingerprint);
   if(record.state!=='prepared'){
    // Recover only our already persisted results. A resumed old group never
    // resurrects its dependent sticker or submits a missing operation.
    const receipts=plan.messages.map(message=>outbox.inspect?.(message.id)).filter(Boolean);
    if(receipts.length===plan.messages.length&&receipts.every(r=>r.state==='confirmed')){
     record.state='confirmed';record.receipts=receipts.map(r=>({state:r.state,messageId:r.messageId,requestId:r.id}));writeState(plan.file,record);
    }
    return {state:record.state==='confirmed'?'confirmed':'uncertain',followUpAllowed:false};
   }
   record.state='sending';writeState(plan.file,record);
   try{
    for(const message of plan.messages){
     if(signal?.aborted||!isCurrent()){record.state='cancelled';writeState(plan.file,record);return {state:'cancelled'};}
     const receipt=await outbox.submit({id:message.id,tool:'clawchat_send_message',input:{chatId:route.conversation,chatType:'direct',text:message.text,
      ...(/^msg[-_][0-9A-HJKMNP-TV-Z]{26}$/.test(plan.turnId)?{replyToMessageId:plan.turnId}:{})}},{signal});
     record.receipts.push(receipt);writeState(plan.file,record);
     if(receipt.state!=='confirmed'){record.state='uncertain';writeState(plan.file,record);return {state:'uncertain'};}
    }
    record.state='confirmed';writeState(plan.file,record);return {state:'confirmed',followUpAllowed:true,messageIds:record.receipts.map(r=>r.messageId)};
   }catch(error){record.state='uncertain';record.error=String(error.message).slice(0,300);writeState(plan.file,record);return {state:'uncertain'};}
  },
 };
}
