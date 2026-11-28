import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createReplyDelivery} from '../src/reply-delivery.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';

const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'chat'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-reply-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={instanceId:'reply',home:root,cwd:root,dataDir:join(root,'data'),owners:[route],expressions:{enabled:true},
  clawchat:{route,delivery:{connectBin:'/fake/official',configPath:'/fake/config',mediaEnabled:true}}};
 await mkdir(join(root,'companion/aurabot-v1'),{recursive:true});await mkdir(options.dataDir);
 await writeFile(join(root,'companion/aurabot-v1/instance.json'),JSON.stringify(options));return {root,options};
}
const event=(id,text,kind='final',extra={})=>({id,position:'0.0',parentId:null,kind:kind==='tool'?'tool':'assistant',state:'complete',source:'live',text,data:{outputKind:kind,...extra}});
const prompt={turnId:'msg-01M77M7TV5FQDA2G04WB146BHX',outputPolicy:{mode:'normal'},workspace:{workingDirectory:'/unused'}};
function outbox(submit=async job=>({state:'confirmed',messageId:job.id})){
 const calls=[],saved=new Map();return {calls,inspect:id=>saved.get(id),async submit(job,options){calls.push(job);const r=await submit(job,options);saved.set(job.id,{...r,id:job.id});return r;}};
}

test('acknowledged reply delivery retains visibility, references and multiple output order without another Core callback',async t=>{
 const f=await fixture(t),box=outbox(),coordinator=createReplyDelivery(f.options,route,{run:()=>assert.fail('Core supplied the public output policy'),outbox:box});
 const events=[event('draft','old','assistant'),event('draft','updated','assistant'),event('tool','private tool facts','tool'),
  event('control','already delivered','control',{requiredControl:true}),event('answer','**final answer**')];
 const plan=await coordinator.prepare(events,prompt,'session');
 assert.deepEqual(plan.messages.map(m=>m.text),['updated','**final answer**']);
 const restricted=await coordinator.prepare(events,{...prompt,turnId:'restricted',outputPolicy:{mode:'normal',allowedKinds:['final']}},'restricted-session');
 assert.deepEqual(restricted.messages.map(m=>m.text),['**final answer**']);
 const result=await coordinator.send(plan);assert.equal(result.state,'confirmed');assert.equal(result.followUpAllowed,true);
 assert.ok(box.calls.every(j=>j.tool==='clawchat_send_message'&&j.input.replyToMessageId===prompt.turnId));
 assert.deepEqual(box.calls.map(j=>j.input.text),['updated','**final answer**']);
 assert.equal((await coordinator.send(plan)).followUpAllowed,false);assert.equal(box.calls.length,2);
});

test('a failed or unknown body holds dependent work and a resumed group never creates a send',async t=>{
 for(const state of ['failed','uncertain']){
  const f=await fixture(t),box=outbox(async()=>({state})),coordinator=createReplyDelivery(f.options,route,{outbox:box});
  const plan=await coordinator.prepare([event('answer','body')],prompt,'session');
  assert.equal((await coordinator.send(plan)).state,'uncertain');
  assert.equal((await coordinator.send(plan)).followUpAllowed,false);assert.equal(box.calls.length,1);
 }
});

test('client turns and Markdown images retain their ordinary renderer; UTF-8 chunks preserve all content',async t=>{
 const f=await fixture(t),box=outbox(),coordinator=createReplyDelivery(f.options,route,{outbox:box});
 assert.equal(await coordinator.prepare([event('image','look ![image](/workspace/image.png)')],prompt,'image-session'),null);
 assert.equal(await coordinator.prepare([event('client','client answer')],{...prompt,metadata:{origin:'client'}},'client-session'),null);
 const text='蓝🐋'.repeat(1800);const plan=await coordinator.prepare([event('long',text)],prompt,'long-session');
 assert.ok(plan.messages.every(m=>Buffer.byteLength(m.text)<=4000));assert.equal(plan.messages.map(m=>m.text).join(''),text);
});

async function runtime(f,coordinator,{after=()=>{},events=[event('answer','body')],expression={stickerPending:true}}={}){
 const native={async *prompt(){yield* events;},async expressReply(input){if(input.afterReply){after();return {state:'completed'};}return expression;},async cancel(){return true;},async close(){}};
 let registered;
 const base={async activate(context){context.hostCapabilities.get('runtime-provider').register({create:()=>({async start(){return native;}})});}};
 await extendRuntimeEntry(base,{replyDeliveryFactory:()=>coordinator}).activate({hostCapabilities:{get:()=>({register:p=>{registered=p;}})}});
 return registered.create({homePath:f.root},{}).start({bindingId:'dsh',chatId:'chat',sessionId:'session'});
}

test('Runtime projections remove the original body before official send and sticker waits for actual confirmation',async t=>{
 const f=await fixture(t);let release,started,stickers=0;const began=new Promise(r=>started=r),ack=new Promise(r=>release=r);
 const box=outbox(async job=>{started();await ack;return {state:'confirmed',messageId:job.id};});
 const coordinator=createReplyDelivery(f.options,route,{outbox:box}),session=await runtime(f,coordinator,{after:()=>stickers++});
 assert.equal(session.afterClawChatReply,undefined);
 const pending=Array.fromAsync(session.prompt(prompt));await began;assert.equal(stickers,0);
 release();const activities=await pending;
 assert.equal(stickers,1);assert.equal(box.calls.length,1);
 assert.equal(activities.findLast(a=>a.id==='answer').data.deliveryDisposition,'projection-only');
 await Array.fromAsync(session.prompt(prompt));assert.equal(stickers,1);assert.equal(box.calls.length,1,'Resume must neither resend body nor revive sticker');
});

test('Runtime cancellation stops waiting for a body and cannot authorize a later sticker',async t=>{
 const f=await fixture(t);let started,stickers=0;const began=new Promise(r=>started=r);
 const box=outbox(async(_job,{signal})=>{started();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {state:'uncertain'};});
 const session=await runtime(f,createReplyDelivery(f.options,route,{outbox:box}),{after:()=>stickers++});
 const pending=Array.fromAsync(session.prompt(prompt));await began;assert.equal(await session.cancel(),true);await pending;assert.equal(stickers,0);
});

test('an ordinary reply with no selected sticker never invokes the official text coordinator',async t=>{
 const f=await fixture(t),coordinator={prepare(){assert.fail('No sticker means no text interception');}};
 const session=await runtime(f,coordinator,{expression:{state:'skipped'}});
 const activities=await Array.fromAsync(session.prompt(prompt));assert.equal(activities.at(-1).text,'body');assert.equal(activities.at(-1).data.deliveryDisposition,undefined);
});
