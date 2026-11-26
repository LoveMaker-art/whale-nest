import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createStickerStore} from '../src/aurabot-stickers.generated.mjs';
import {loadLibrary as loadOriginalLibrary} from '../vendor/aurabot/src/features/stickers.js';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {createStickers} from '../src/stickers.mjs';
import {prepareRuntimeInput} from '../src/media.mjs';
import {selectReplyItems} from '../src/aurabot-expression.generated.mjs';
import {createExpressionSettings} from '../src/expression-settings.mjs';
import {createStickerSelection} from '../src/sticker-selection.mjs';

const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'dm-owner'};
function actor(id,text,{sessionId='session',source={kind:'user',connectInputId:id}}={}){
 const events=[{type:'user/message',data:{message:{source,content:[{type:'text',text}]}}},{type:'assistant/message',data:{message:{id:'assistant-'+id,content:[{type:'tool-call',id}]}}}];
 return {callId:id,agent:{id:sessionId,session:{seq:1,eventAt:n=>events[n]}}};
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-stickers-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'data'),cwd=join(root,'work');await mkdir(join(dataDir,'aurabot'),{recursive:true});await mkdir(cwd);process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const options={instanceId:'stickers',dataDir,cwd,owners:[route],clawchat:{route}},cfg=normalize({stickers:{collect:false,caption:false},dryRun:false}),calls=[];
 const store=createStickerStore({dsh:{},getConfig:()=>cfg,onebot:{call:async(action)=>{calls.push(action);throw Error('No implicit QQ action');}},log:{info(){},debug(){},warn(){}}});
 const sent=[],deps={store,getConfig:()=>cfg,senderFor:()=>({send:async input=>{sent.push(input);return {state:'confirmed',messageId:'ack-'+sent.length};}})};
 const service=createStickers(options,deps),tool=service.tool(route,'session');
 async function input(id,files=['image.png'],sessionId='session'){
  const media=files.map((name,index)=>({kind:'image',name,mime:name.endsWith('.gif')?'image/gif':'image/png',url:'https://fixture.invalid/'+index}));
  return prepareRuntimeInput({turnId:id,prompt:'运维素材',media},{bindingId:route.account,chatId:route.conversation,sessionId,cacheMedia:async m=>fileURLToPath(new URL('./fixtures/media/'+m.name,import.meta.url))},options,{});
 }
 return {root,options,cfg,store,calls,sent,service,tool,input,deps};
}
test('collect=false still permits explicit collection; ordinary images, negation and scheduled calls cannot collect',async t=>{
 const f=await fixture(t);await f.input('pic');
 for(const [id,text,source]of [['plain','看看这张图片',undefined],['no','不要收录这张图片',undefined],['scheduled','请收录这张表情',{kind:'schedule'}]]){
  const r=await f.tool.execute({action:'add'},actor(id,text,{source}));assert.equal(r.ok,false);assert.equal(f.store.library().items.length,0);
 }
 const a=await f.tool.execute({action:'add',name:'共享小图'},actor('pic','请把这张图片收录为表情'));assert.equal(a.ok,true);assert.equal(f.store.library().items.length,1);
 const again=await f.tool.execute({action:'add'},actor('duplicate','请收录刚才那张表情'));
 // This synthetic actor has no admitted picture history: no guessing another turn.
 assert.equal(again.ok,false);assert.deepEqual(f.calls,[]);
 assert.equal(loadOriginalLibrary().items[0].name,'共享小图','Original store reads the same unchanged format');
 await f.tool.execute({action:'delete',id:a.item.md5},actor('remove','请删除这张表情'));
 assert.equal((await createStickers(f.options,f.deps).tool(route,'session').execute({action:'add',name:'共享小图'},actor('pic','请把这张图片收录为表情'))).ok,true);assert.equal(f.store.library().items.length,0,'An old add cannot resurrect deletion');
});
test('multiple attachments need an index; images in another Session, symlinks and modified files are rejected',async t=>{
 const f=await fixture(t);await f.input('two',['image.png','animation.gif']);
 assert.equal((await f.tool.execute({action:'add'},actor('two','请收录这张图片'))).ok,false);
 assert.equal((await f.tool.execute({action:'add',index:2,name:'动图'},actor('two-index','请收录这张图片',{source:{kind:'user',connectInputId:'two'}}))).ok,true);
 const other=createStickers(f.options,f.deps).tool(route,'other');assert.equal((await other.execute({action:'add',inputId:'two'},actor('cross','请收录这张图片',{sessionId:'other'}))).ok,false);
 const key=f.sent.length;assert.equal(key,0);
 const receipt=(await import('../src/routing.mjs')).hash([route.account,route.conversation,'session','two']);
 const file=join(f.options.dataDir,'media/incoming',receipt,'0-image.png');await writeFile(file,Buffer.from('modified'));
 assert.equal((await f.tool.execute({action:'add',index:1},actor('corrupt','请收录这张图片',{source:{kind:'user',connectInputId:'two'}}))).ok,false);
 const owned=join(f.options.cwd,'owned.png'),link=join(f.options.cwd,'linked.png');await writeFile(owned,await readFile(new URL('./fixtures/media/image.png',import.meta.url)));await symlink(owned,link);
 assert.equal((await f.tool.execute({action:'add',filePath:link},actor('link','请收录这张图片 '+link))).ok,false);
 const stranger=createStickers(f.options,f.deps).tool({...route,sender:'stranger'},'session');assert.equal((await stranger.execute({action:'delete',query:'动图'},actor('stranger','请删除这个表情'))).ok,false);
 assert.equal((await f.tool.execute({action:'add',painting:'刚画的'},actor('painting','请收录刚画的图片为表情'))).ok,false,'An unbound painting alias cannot fall back to another Session latest work');
});
test('common rename/delete never alter QQ favorites, repeated input cannot resurrect deletion, and restart preserves the library',async t=>{
 const f=await fixture(t),bytes=await readFile(new URL('./fixtures/media/image.png',import.meta.url));const added=await f.store.addFromBuffer(bytes,{name:'旧名字',toQQ:false});
 const index=join(f.options.dataDir,'aurabot/stickers/index.json'),lib=JSON.parse(await readFile(index));lib.items[0].emojiId='existing-qq-favorite';await writeFile(index,JSON.stringify(lib));
 const r=await f.tool.execute({action:'update',id:added.item.md5,name:'新名字',tags:['开心']},actor('rename','请给这张表情改名并加标签'));assert.equal(r.ok,true);assert.deepEqual(f.calls,[]);
 const deleted=await f.tool.execute({action:'delete',id:added.item.md5},actor('delete','请删除这张表情'));assert.equal(deleted.ok,true);assert.deepEqual(f.calls,[]);
 const restarted=createStickers(f.options,f.deps).tool(route,'session');assert.equal((await restarted.execute({action:'update',id:added.item.md5,name:'新名字',tags:['开心']},actor('rename','请给这张表情改名并加标签'))).ok,true);
 assert.equal(loadOriginalLibrary().items.length,0,'Replay does not recreate a deleted image');
});
test('same-image dedup and persisted send receipts prevent reselection, repeat sending and repeat use counts',async t=>{
 const f=await fixture(t);await f.input('pic');const add=await f.tool.execute({action:'add',name:'测试图'},actor('pic','请收录这张图片'));
 const id=add.item.md5;let tool=f.tool;
 const args={action:'send',id},exec=actor('send','请发这个表情');const sent=await tool.execute(args,exec);assert.equal(sent.ok,true);assert.equal(f.sent.length,1);
 tool=createStickers(f.options,f.deps).tool(route,'session');assert.equal((await tool.execute(args,exec)).messageId,sent.messageId);assert.equal(f.sent.length,1);assert.equal(f.store.library().items[0].uses,1);
 const uncertain=createStickers(f.options,{...f.deps,senderFor:()=>({send:async()=>({state:'uncertain',requestId:'whalenest-media-held'})})}).tool(route,'session');
 const held=await uncertain.execute({action:'send',id},actor('held','请发这个表情'));assert.equal(held.ok,false);
 assert.equal((await tool.execute({action:'send',id},actor('held','请发这个表情'))).state,'uncertain');assert.equal(f.sent.length,1);
});
test('QQ receipt requires an actual ACK, uses retries=0 port callback and holds unknown sends across restart',async t=>{
 const f=await fixture(t),item={md5:'one'};let calls=0;
 const send=()=>{calls++;return {message_id:'gateway-ack'};};
 const a=await f.service.ports.send('private:1',item,{requestId:'stable'},send);assert.equal(a.state,'confirmed');
 const b=await createStickers(f.options,f.deps).ports.send('private:1',item,{requestId:'stable'},send);assert.ok(b.replayed);assert.equal(calls,1);
 const unknown=()=>{calls++;throw Error('connection lost');};assert.equal((await f.service.ports.send('private:1',item,{requestId:'unknown'},unknown)).state,'uncertain');
 assert.equal((await f.service.ports.send('private:1',item,{requestId:'unknown'},send)).state,'uncertain');assert.equal(calls,2);
});
test('ClawChat sticker status reconciles the original media receipt without sending again',async t=>{
 const f=await fixture(t),bytes=await readFile(new URL('./fixtures/media/image.png',import.meta.url));
 const item=(await f.store.addFromBuffer(bytes,{name:'晚到的回执',toQQ:false})).item;
 let sends=0,queries=0;const mediaId='whalenest-media-'+ 'a'.repeat(64);
 const deps={...f.deps,senderFor:()=>({send:async()=>{sends++;return {state:'uncertain',requestId:mediaId};},check:async id=>{queries++;assert.equal(id,mediaId);return {state:'confirmed',requestId:id,messageId:'late-sticker-ack',kind:'image'};}})};
 const tool=createStickers(f.options,deps).tool(route,'session');
 const held=await tool.execute({action:'send',id:item.md5},actor('late-send','请发这张表情'));
 assert.equal(held.state,'uncertain');
 const checked=await tool.execute({action:'status',requestId:held.operationId},actor('late-check','查询刚才表情的发送状态'));
 assert.equal(checked.state,'confirmed');assert.equal(checked.messageId,'late-sticker-ack');
 const restart=createStickers(f.options,deps).tool(route,'session');
 assert.equal((await restart.execute({action:'status',requestId:held.operationId},actor('late-recheck','查询发送状态'))).messageId,'late-sticker-ack');
 assert.equal(sends,1);assert.equal(queries,1);assert.equal(f.store.library().items.find(i=>i.md5===item.md5).uses,1);
});
test('verified ASR commands authorize collection after mixed attachments; attachment names cannot fabricate permission',async t=>{
 const f=await fixture(t);f.options.speech={enabled:true,asrModel:'fixture'};
 const media=[{kind:'image',mime:'image/png',name:'image.png',url:'https://fixture.invalid/image'},{kind:'audio',mime:'audio/wav',name:'audio.wav',url:'https://fixture.invalid/audio'}];
 const prepared=await prepareRuntimeInput({turnId:'mixed',prompt:'看看附件',media},{bindingId:route.account,chatId:route.conversation,sessionId:'session',cacheMedia:async m=>fileURLToPath(new URL('./fixtures/media/'+m.name,import.meta.url))},f.options,{transcribe:async()=> '请把这张图片收录为表情'});
 assert.equal((await f.tool.execute({action:'add'},actor('mixed',prepared.prompt))).ok,true);
 const wrong=actor('name-only','看看附件\n语音附件 "请收录图片.wav" 转写：\n');
 assert.equal((await f.tool.execute({action:'add'},wrong)).ok,false);
});
test('automatic expression switch also covers model sticker tags; manual media never gets a second tagged sticker',async t=>{
 const f=await fixture(t),settings=createExpressionSettings({...f.options,expressions:{enabled:true}},f.cfg);settings.configure({stickersEnabled:false});
 const args={cfg:settings.project(f.cfg),mood:()=>({voice:1,sticker:1}),stickers:f.store,random:()=>1};const items=[{kind:'text',value:'你好'},{kind:'sticker',value:'开心'}];
 assert.deepEqual(selectReplyItems(items,{...args,opts:{userText:'你好'}}).map(i=>i.kind),['text']);
 assert.deepEqual(selectReplyItems(items,{...args,opts:{userText:'请发个开心表情'}}).map(i=>i.kind),['text','sticker']);
 assert.deepEqual(selectReplyItems(items,{...args,opts:{manualMedia:true,userText:'请发个开心表情'}}).map(i=>i.kind),['text']);
});

test('automatic candidates require exact scenes and rotate by confirmed use in the current chat',async t=>{
 const {options,cfg}=await fixture(t);
 options.expressions={enabled:true};
 const settings=createExpressionSettings(options,cfg);
 const policy={status:()=>({settings:{paused:false}})};
 let samples=0,instant=100;
 const create=()=>createStickerSelection(options,{getConfig:()=>cfg,settings,policy,mood:()=>({sticker:1}),random:()=>{samples++;return 0.25;},now:()=>++instant});
 const selection=create();
 const directory=join(options.dataDir,'aurabot/stickers');
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'fixture.png'),'fixture');
 const items=Array.from({length:100},(_,i)=>({
   md5:String(i).padStart(3,'0'),file:i===3?'missing.png':'fixture.png',
   tags:i===0?['庆祝','不随机']:i===1?['庆祝','晚安']:i===2||i===3?['庆祝']:['恭喜'],
 }));
 const store={library:()=>({items})};
 const qq={channel:'qq',account:'bot',conversation:'private:owner'};
 assert.equal(selection.pick(route,'庆祝',store).md5,'001');
 selection.record(route,items[1]);
 const restarted=create();
 assert.equal(restarted.pick(route,'庆祝',store).md5,'002');
 assert.equal(restarted.pick(qq,'庆祝',store).md5,'001');
 assert.equal(restarted.pick(route,'安慰',store),null);
 assert.equal(restarted.pick(route,'恭喜',store),null);
 selection.prepare('private',1,['请发张图']);
 assert.equal(samples,0);
 selection.prepare('private',2,['我拿到 offer 了']);
 assert.equal(samples,1);
 assert.match(selection.guide('private'),/本轮已抽中/);
 const chunks=await Array.fromAsync(selection.stream({sessionId:'private'},async function*(){
   yield {type:'text-delta',index:0,text:'恭喜！<wha'};
   yield {type:'text-delta',index:0,text:'lenest-sticker>庆祝</whale'};
   yield {type:'text-delta',index:0,text:'nest-sticker>'};
   yield {type:'finish',reason:{kind:'stop'}};
 }));
 assert.deepEqual(chunks.map(c=>c.text).filter(Boolean),['恭喜！']);
 assert.equal(selection.scene('private',2),'庆祝');
 assert.equal(selection.scene('private',1),null);
});

test('QQ favorites import PNG and GIF once while leaving their reviewed labels intact',async t=>{
 const f=await fixture(t);
 const png=await readFile(new URL('./fixtures/media/image.png',import.meta.url));
 const gif=await readFile(new URL('./fixtures/media/animation.gif',import.meta.url));
 const calls=[];
 const store=createStickerStore({dsh:{},getConfig:()=>f.cfg,onebot:{async call(action){
   calls.push(action);
   return [png,gif].map(bytes=>({url:'base64://'+bytes.toString('base64')}));
 }},log:{info(){},debug(){},warn(){}}});
 const first=await store.importFromQQ();
 assert.deepEqual([first.added,first.existed,first.failed],[2,0,0]);
 const rows=store.library().items;
 assert.ok(rows.every(i=>i.from==='qq'&&!i.tags.length));
 const animated=rows.find(i=>i.file.endsWith('.gif'));
 assert.ok(animated);
 store.rename(animated.md5,'庆祝小图',['庆祝'],{toQQ:false});
 const second=await store.importFromQQ();
 assert.deepEqual([second.added,second.existed,second.failed],[0,2,0]);
 assert.deepEqual(store.library().items.find(i=>i.md5===animated.md5).tags,['庆祝']);
 assert.deepEqual(calls,['fetch_custom_face','fetch_custom_face']);
});

test('read-only tool continuations retain the original draw and can select a sticker',async t=>{
 const {options,cfg}=await fixture(t);options.expressions={enabled:true};
 const settings=createExpressionSettings(options,cfg);settings.configure({stickerChance:1});let draws=0;
 const selection=createStickerSelection(options,{getConfig:()=>cfg,settings,policy:{status:()=>({settings:{paused:false}})},mood:()=>({sticker:1}),random:()=>{draws++;return 0;}});
 const reads=[['recall_memory',{query:'兴趣'}],['bili_search',{query:'音乐'}],['bili_explore',{query:'音乐'}],['companion_stickers',{action:'list'}],['companion_memory',{action:'status'}],['companion_paintings',{action:'read',file:'test.png'}],['web_fetch',{url:'https://example.test'}],['read_file',{path:'/data.json'}],['str_replace_editor',{command:'view',path:'/test'}]];
 for(const [n,[name,args]]of reads.entries()){
  selection.prepare('native',n,['我今天很开心']);
  assert.match(selection.guide('native'),/本轮已抽中/,'A read request is eligible before a tool runs');
  await Array.fromAsync(selection.stream({sessionId:'native',messages:[]},async function*(){
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'tool-call-delta',index:0,id:'lookup',name,argumentsDelta:'{'};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'lookup',name,arguments:JSON.stringify(args)}};
   yield {type:'finish',reason:{kind:'tool-calls'}};
  }));
  assert.match(selection.guide('native'),/本轮已抽中/,'A successful read must not cancel the draw');
  await Array.fromAsync(selection.stream({sessionId:'native',messages:[{role:'tool',toolCallId:'lookup',isError:false,content:[{type:'text',text:name==='read_file'?' {"ok":false}':'{"ok":true}'}]}]},async function*(){
   yield {type:'block-end',index:0,block:{type:'text',text:'真替你高兴！<whalenest-sticker>庆祝</whalenest-sticker>'}};
   yield {type:'finish',reason:{kind:'stop'}};
  }));
  assert.equal(selection.scene('native',n),'庆祝');
 }
 assert.equal(draws,reads.length,'Continuation steps must not draw again');
});

test('explicit read requests remain eligible while media, writes and text-only requests do not',async t=>{
 const {options,cfg}=await fixture(t);options.expressions={enabled:true};const settings=createExpressionSettings(options,cfg);settings.configure({stickerChance:1});
 const selection=createStickerSelection(options,{getConfig:()=>cfg,settings,policy:{status:()=>({settings:{paused:false}})},mood:()=>({sticker:1}),random:()=>0});
 for(const input of ['请帮我查询一下相关资料','帮我检查一下这个网页讲什么','帮我搜索一下音乐']){
  selection.prepare('native',1,[input]);assert.match(selection.guide('native'),/本轮已抽中/,input);
 }
 for(const input of ['只用文字回复','请给我发个表情包','请帮我修改设置','请帮我记住这件事']){
  selection.prepare('native',1,[input]);assert.equal(selection.guide('native'),'',input);
 }
});

test('writes, media, unknown tools and failed reads cancel an automatic sticker',async t=>{
 const {options,cfg}=await fixture(t);options.expressions={enabled:true};const settings=createExpressionSettings(options,cfg);settings.configure({stickerChance:1});
 const selection=createStickerSelection(options,{getConfig:()=>cfg,settings,policy:{status:()=>({settings:{paused:false}})},mood:()=>({sticker:1}),random:()=>0});
 const cases=[['remember',{text:'test'}],['send_media',{filePath:'/test'}],['companion_stickers',{action:'send'}],['companion_settings',{action:'update',automatic:true}],['bili_config',{action:'status',patch:{watchOn:true}}],['str_replace_editor',{command:'create',path:'/test'}],['unknown_reader',{}],['toString',{}],['companion_memory','{'],['bili_explore',{query:'音乐'},false],['recall_memory',{},true]];
 for(const [n,[name,args,error]]of cases.entries()){
  selection.prepare('native',n,['我今天很开心']);
  await Array.fromAsync(selection.stream({sessionId:'native',messages:[]},async function*(){
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'op',name,arguments:typeof args==='string'?args:JSON.stringify(args)}};
   yield {type:'finish',reason:{kind:'tool-calls'}};
  }));
  const content=error===false?' {"ok":false,"message":"upstream failed"}':'✗ lookup failed';
  await Array.fromAsync(selection.stream({sessionId:'native',messages:[{role:'tool',toolCallId:'op',isError:error===true,content:[{type:'text',text:content}]}]},async function*(){
   yield {type:'block-end',index:0,block:{type:'text',text:'完成<whalenest-sticker>庆祝</whalenest-sticker>'}};
   yield {type:'finish',reason:{kind:'stop'}};
  }));
  assert.equal(selection.scene('native',n),null,name+' must not append a sticker');
 }
});

test('rich automatic decisions match the topic and direction before rotating for QQ and ClawChat',async t=>{
 const {options,cfg}=await fixture(t);
 options.expressions={enabled:true,stickerChance:1};
 const settings=createExpressionSettings(options,cfg);
 const policy={status:()=>({settings:{paused:false}})};
 const directory=join(options.dataDir,'aurabot/stickers');
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'valid.png'),'fixture');
 const row=(md5,...tags)=>({md5,file:'valid.png',tags});
 const items=[
   row('old-rice','熟人玩笑','白饭','大肥鱼自己'),
   row('best-rice','熟人玩笑','白饭','自嘲','大肥鱼自己','蹭饭'),
   row('wrong-direction','熟人玩笑','白饭','自嘲','给对方'),
   row('wrong-topic','熟人玩笑','摸鱼','自嘲','大肥鱼自己'),
   row('manual','熟人玩笑','白饭','自嘲','大肥鱼自己','不随机'),
   row('drum','音乐','鼓','节拍','大肥鱼自己'),
 ];
 let libraryReads=0;
 const store={library:()=>{libraryReads++;return {items};}};
 const selection=createStickerSelection(options,{getConfig:()=>cfg,settings,policy,mood:()=>({sticker:1}),
   store:()=>store,random:()=>0});
 selection.prepare('native',1,['不要发表情，只回文字']);
 assert.equal(selection.guide('native'),'');
 assert.equal(libraryReads,0);
 selection.prepare('native',2,['你这条鱼又来蹭白饭了']);
 assert.match(selection.guide('native'),/熟人玩笑：.*白饭/);
 assert.match(selection.guide('native'),/音乐：鼓、节拍/);
 const chunks=await Array.fromAsync(selection.stream({sessionId:'native'},async function*(){
   yield {type:'text-delta',index:0,text:'蹭一碗怎么了。<wha'};
   yield {type:'text-delta',index:0,text:'lenest-sticker>熟人玩笑|白饭，自嘲|大肥鱼自己</whalenest-sticker>'};
   yield {type:'finish',reason:{kind:'stop'}};
 }));
 assert.equal(chunks.map(chunk=>chunk.text??'').join(''),'蹭一碗怎么了。');
 const decision=selection.scene('native',2);
 assert.deepEqual(decision,{scene:'熟人玩笑',topics:['白饭','自嘲'],direction:'大肥鱼自己'});
 selection.record(route,items[1]);
 const qq={channel:'qq',account:'bot',conversation:'private:owner'};
 for(const destination of [route,qq]){
   assert.equal(selection.pick(destination,decision,store).md5,'best-rice');
   assert.equal(selection.pick(destination,{...decision,topics:['火锅','自嘲']},store),null);
   assert.equal(selection.pick(destination,{scene:'音乐',topics:['节拍'],direction:'大肥鱼自己'},store).md5,'drum');
   assert.equal(selection.pick(destination,'熟人玩笑',store),null,'Broad legacy frames do not override rich metadata');
 }
 assert.equal(selection.usable(route,items[2],decision),false);
 assert.equal(selection.usable(route,items[1],decision),true);
 const simulate=async (turn,input,text)=>{
   selection.prepare('native',turn,[input]);
   await Array.fromAsync(selection.stream({sessionId:'native'},async function*(){
     yield {type:'block-end',index:0,block:{type:'text',text}};
     yield {type:'finish',reason:{kind:'stop'}};
   }));
   return selection.scene('native',turn);
 };
 const omitted=await simulate(3,'你又来蹭白饭啦','饭不是我端的，是它自己跑我嘴里的');
 assert.equal(selection.pick(qq,omitted,store).md5,'best-rice');
 assert.equal(await simulate(4,'你又来蹭白饭啦','我吃饭了<whalenest-sticker>跳过</whalenest-sticker>'),null);
 assert.equal(await simulate(5,'你又来蹭白饭啦','我吃饭了<whalenest-sticker>坏格式</whalenest-sticker>'),null);
 assert.equal(await simulate(6,'我今天很难过，白饭都吃不下','我陪你聊一会，白饭之后再说'),null);
 assert.equal(await simulate(7,'你又来蹭白饭啦','来聊点别的吧'),null);
});
