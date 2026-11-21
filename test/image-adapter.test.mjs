import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {listPaintings} from '../vendor/aurabot/src/features/paintings.js';
import {createImageAdapter} from '../src/image-adapter.mjs';
import {prepareRuntimeInput} from '../src/media.mjs';
import {stickerMaterial} from '../src/sticker-material.mjs';

const route={channel:'clawchat',account:'agent',sender:'owner',conversation:'dm-owner',kind:'private'};
function actor(turn,text,{callId=turn,source={kind:'user',connectInputId:turn},sessionId='session'}={}){
 const events=[{type:'user/message',data:{message:{id:'user-'+turn,source,content:[{type:'text',text}]}}},{type:'assistant/message',data:{message:{id:'assistant-'+callId,content:[{type:'tool-call',id:callId}]}}}];
 return {callId,agent:{id:sessionId,session:{seq:1,eventAt:n=>events[n]}}};
}
async function fixture(t,{uncertain=false,downloadFailure=false}={}){
 const root=await mkdtemp(join(tmpdir(),'whalenest-image-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const options={instanceId:'image',dataDir,cwd:root,owners:[route],clawchat:{route,delivery:{mediaEnabled:true}},image:{enabled:true,model:'qwen-image-3.0'}};
 const cfg=normalize({imageGen:{enabled:true}}),png=await readFile(new URL('./fixtures/media/image.png',import.meta.url));let generated=0,sends=0,events=0,recoveries=0;const paid=new Map();
 const client={enabled:true,inspect:id=>paid.get(id),generate:async(_p,{requestId,image})=>{generated++;paid.set(requestId,{state:'completed'});if(downloadFailure)throw Error('Download unavailable');return png;},recover:async()=>{recoveries++;return png;}};
 const hub={turnSendersAllOwner:()=>true,canSeeImages:async()=>false};let factory;
 const deps={getConfig:()=>cfg,getNative:()=>({hub}),getRoute:()=>route,client,senderFor:()=>({send:async()=>{assert.ok(listPaintings({}).total>0,'Save before delivery');sends++;return uncertain?{state:'uncertain',requestId:'media-held'}:{state:'confirmed',messageId:'image-ack',requestId:'media-ack'};},check:async()=>({state:'uncertain',requestId:'media-held'})})};
 const adapter=createImageAdapter({},options,deps);adapter.module().setup({core:{hub,local:{active:()=>false}},dsh:{},config:()=>cfg,lazy:()=>({addEvent:()=>events++}),route(){},onDispose(){},log:{info(){},warn(){},debug(){}},tool(fn){factory=fn;}});
 const tool=(sessionId='session')=>factory({chat:{chatId:'private:1',kind:'private',userId:'1'},sessionId})[0];
 return {root,options,adapter,tool,png,counts:()=>({generated,sends,events,recoveries}),deps};
}
test('the original drawing tool saves first, generates once per user turn and retains one shared archive across restart',async t=>{
 const f=await fixture(t);const args={prompt:'小鱼',shape:'square'},exec=actor('draw','运维自测，请画一张小鱼');
 const first=await f.tool().execute(args,exec);assert.equal(first.ok,true);assert.equal(first.state,'confirmed');assert.ok(first.file);
 const again=await f.tool().execute(args,actor('draw','运维自测，请画一张小鱼',{callId:'second-call'}));assert.equal(again.file,first.file);assert.deepEqual(f.counts(),{generated:1,sends:1,events:0,recoveries:0});
 assert.ok(f.tool().output.render(args,first).some(b=>b.type==='text'&&b.text.includes('"messageId":"image-ack"')&&b.text.includes('"state":"confirmed"')),'The model receives the actual ACK separately from its own vision access');
 const conflict=await f.tool().execute({prompt:'另外一张'},actor('draw','运维自测，请画一张小鱼',{callId:'third-call'}));assert.equal(conflict.ok,false);assert.equal(f.counts().generated,1);
 const restarted=createImageAdapter({},f.options,f.deps),listed=await restarted.managementTool(route,'session').execute({action:'list'},actor('list','查看作品'));assert.equal(listed.total,1);assert.ok(!listed.items[0].prompt.includes('--wn-'));
 const duplicate=await restarted.managementTool(route,'session').execute({action:'send',file:first.file},actor('draw','运维自测，请画一张小鱼',{callId:'compensating-send'}));assert.equal(duplicate.alreadyDelivered,true);assert.equal(duplicate.messageId,'image-ack');assert.equal(f.counts().sends,1,'The model cannot compensate a confirmed drawing with a second send in the same user turn');
 const material=await stickerMaterial(f.options,route,'session',{painting:'#1'},actor('collect','请把刚画的图 #1 收录为表情'));assert.deepEqual(material,f.png,'Sticker collection reuses the original painting map and archive');
 await restarted.managementTool(route,'session').execute({action:'send',file:first.file},actor('resend-later','请再发一次已有作品'));assert.equal(f.counts().sends,2,'A new explicit user turn can send the existing artwork');assert.equal(f.counts().generated,1);
});
test('ordinary chat, scheduled turns and arbitrary reference URLs never invoke the image service',async t=>{
 const f=await fixture(t);
 for(const [id,text,source]of [['chat','今天聊聊天',undefined],['background','画一张图',{kind:'schedule'}]])assert.equal((await f.tool().execute({prompt:'小鱼'},actor(id,text,{source}))).ok,false);
 const bad=await f.tool().execute({prompt:'修改图片',image:'https://untrusted.invalid/a.png'},actor('bad-ref','请修改这张图'));assert.equal(bad.ok,false);assert.equal(f.counts().generated,0);
});
test('reference images stay in the current Session, and ambiguous inputs fail before generation',async t=>{
 const f=await fixture(t),media=[{kind:'image',mime:'image/png',name:'image.png',url:'https://fixture.invalid/image'}];
 await prepareRuntimeInput({turnId:'received',prompt:'图片',media},{bindingId:route.account,chatId:route.conversation,sessionId:'session',cacheMedia:async()=>fileURLToPath(new URL('./fixtures/media/image.png',import.meta.url))},f.options,{});
 assert.equal((await f.tool('other').execute({prompt:'修改小鱼',image:'last'},actor('edit-other','请修改图片',{sessionId:'other'}))).ok,false);assert.equal(f.counts().generated,0);
 assert.equal((await f.tool().execute({prompt:'修改小鱼',image:'last'},actor('received','请修改这张图片'))).ok,true);assert.equal(f.counts().generated,1);
});
test('an unknown send holds its receipt; recover downloads a known result without another generation',async t=>{
 const f=await fixture(t,{uncertain:true});const result=await f.tool().execute({prompt:'小鱼'},actor('draw','请画一张小鱼'));assert.equal(result.ok,false);assert.ok(result.saved&&result.file);
 const held=await f.adapter.managementTool(route,'session').execute({action:'send',file:result.file},actor('retry','请发送已有作品'));assert.equal(held.state,'uncertain');assert.equal(f.counts().sends,1);assert.equal(f.counts().generated,1);
 const g=await fixture(t,{downloadFailure:true}),failed=await g.tool().execute({prompt:'小鱼'},actor('download','请画一张小鱼'));assert.equal(failed.ok,false);
 const restored=await g.adapter.managementTool(route,'session').execute({action:'recover',operationId:failed.operationId},actor('recover','请恢复已有结果'));assert.ok(restored.ok&&restored.file);assert.equal(g.counts().generated,1);assert.equal(g.counts().recoveries,1);assert.equal(g.counts().sends,0);
});
