import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {bootBridge} from './bridge-helper.mjs';
import {createServer} from 'node:http';
import {linkedFixture,until,call} from './native-qq-helper.mjs';

test('native QQ and ClawChat use original voice, shared tone/settings and platform ASR without local or QQ STT fallback',{timeout:90000},async t=>{
 const wav=await readFile(new URL('./fixtures/media/audio.wav',import.meta.url)),requests=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c.toString();requests.push({path:req.url,body});
  if(req.url.endsWith('/transcriptions')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({text:'QQ_PLATFORM_ASR_VERIFIED 请用文字回复'}));}
  else{res.writeHead(200,{'content-type':'audio/wav'});res.end(wav);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const {mock,directory,bridge}=await linkedFixture(t,{voiceServer:'http://127.0.0.1:'+server.address().port+'/v1'});
 const cc='shared-voice-cc';await bridge.request('create',{sessionId:cc,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});
 await bridge.turn(cc,'set-voice',call('companion_voice',{action:'update',voice:'shared-fixture-voice'}));
 await bridge.turn(cc,'default-text',call('companion_expression',{action:'update',patch:{voiceEnabled:false}}));
 const push=(id,message)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message,sender:{user_id:10000001,nickname:'主人'}});
 const sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');
 await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 push(8201,[{type:'text',data:{text:'请用语音回复。'}}]);
 await until(()=>sent().some(c=>c.params.message.some(s=>s.type==='record')));
 const tts=requests.filter(r=>r.path.endsWith('/speech'));assert.equal(tts.length,2);assert.ok(tts.every(r=>JSON.parse(r.body).voice==='shared-fixture-voice'));
 assert.match(sent().find(c=>c.params.message.some(s=>s.type==='record')).params.message[0].data.file,/^base64:\/\//,'Gateway receives bytes, not a cloud-only file path');
 const speechFile=join(directory.root,'qq-record.wav');await writeFile(speechFile,wav);await bridge.control('setQQRecord',{filePath:speechFile});
 const before=sent().length;push(8202,[{type:'record',data:{file:'voice.silk'}}]);await until(()=>sent().length>before);
 assert.equal(requests.filter(r=>r.path.endsWith('/transcriptions')).length,1);assert.ok(!mock.calls.some(c=>c.action==='fetch_ptt_text'),'No second QQ ASR backend');
 const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(trace.some(r=>r.messages.some(m=>m.source?.kind==='aurabot'&&JSON.stringify(m.content).includes('QQ_PLATFORM_ASR_VERIFIED'))));
 assert.equal(requests.filter(r=>r.path.endsWith('/speech')).length,2,'Default text and explicit text do not auto speak');
 const beforeManage=sent().length;push(8203,[{type:'text',data:{text:call('companion_voice',{action:'status'})}}]);await until(()=>sent().length>beforeManage);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.settings.voiceEnabled,false);
 const native=await bridge.control('nativeState');assert.equal(native.modules.filter(n=>n==='voice').length,1);
});

test('original QQ sticker aliases and ClawChat share one store, explicit collection and ACKs without QQ favorites or auto duplicates',{timeout:90000},async t=>{
 const {mock,directory,bridge,data}=await linkedFixture(t,{expressions:true});
 const cc='shared-stickers-cc';await bridge.request('create',{sessionId:cc,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});
 const gif=await readFile(new URL('./fixtures/media/animation.gif',import.meta.url)),sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');
 const push=(id,text,pics=[])=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}},...pics],sender:{user_id:10000001,nickname:'主人'}});
 await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 push(8301,'看这张图',[{type:'image',data:{file:'base64://'+gif.toString('base64'),sub_type:1}}]);await until(()=>sent().length===1);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.stickerCount,1,'Ordinary image is not collected');
 let n=sent().length;push(8302,'这张很有趣。'+call('qq_collect_sticker',{index:1,name:'不应收录'}));await until(()=>sent().length>n);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.stickerCount,1,'Model tool choice alone is not collection permission');
 n=sent().length;push(8303,'请收录刚才这张表情。'+call('qq_collect_sticker',{index:1,name:'共享QQ动图',tags:['不随机']}));await until(()=>sent().length>n);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.stickerCount,2,'Manual QQ collection works with collect=false');
 n=sent().length;push(8313,'请收录刚才这张图片为表情。'+call('qq_save_sticker',{name:'另一个名字'}));await until(()=>sent().length>n);
 const workspaceGif=join(directory.root,'explicit-sticker.gif');await writeFile(workspaceGif,gif);
 n=sent().length;push(8314,'请收录这张图片 '+workspaceGif+'。'+call('qq_add_sticker',{source:workspaceGif,name:'同一张图'}));await until(()=>sent().length>n);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.stickerCount,2,'Original add/save aliases use the same MD5 dedup');
 n=sent().length;push(8304,'请把共享QQ动图改名为双端动图。'+call('qq_edit_sticker',{sticker:'共享QQ动图',new_name:'双端动图'}));await until(()=>sent().length>n);
 await bridge.turn(cc,'cc-list-sticker',call('companion_stickers',{action:'list'}));
 let trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(JSON.stringify(trace.at(-1)).includes('双端动图'));
 await bridge.turn(cc,'cc-send-sticker','请发双端动图表情。'+call('companion_stickers',{action:'send',query:'双端动图'}));
 const delivered=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(delivered.length,1);assert.equal(delivered[0].tool,'clawchat_send_image');assert.equal(delivered[0].input.expectedKind,undefined);assert.match(delivered[0].input.path,/\.gif$/);
 await bridge.control('expressionConfigure',{stickerChance:1,voiceChance:0});
 const imageCount=()=>sent().filter(c=>c.params.message.some(s=>s.type==='image')).length;
 const priorImages=imageCount();n=sent().length;push(8305,'请发表情双端动图。'+call('companion_stickers',{action:'send',query:'双端动图'}));await until(()=>sent().length>=n+2);
 assert.equal(imageCount(),priorImages+1,'One manual sticker, no second random sticker');
 n=sent().length;push(8317,'请给大肥鱼开心增加庆祝标签。'+call('qq_edit_sticker',{sticker:'大肥鱼开心',tags:['庆祝']}));await until(()=>sent().length>n);
 n=sent().length;push(8318,'我拿到 offer 了！STICKER_FIXTURE_CELEBRATE');await until(()=>sent().length>=n+2);
 assert.equal(sent()[n].params.message[0].type,'text');
 assert.equal(sent()[n+1].params.message[0].type,'image');
 assert.doesNotMatch(JSON.stringify(sent().slice(n)),/whalenest-sticker/);
 n=sent().length;push(8319,'我一点也不开心 STICKER_FIXTURE_COMFORT');await until(()=>sent().length===n+1);
 assert.equal(sent()[n].params.message[0].type,'text');
 await bridge.control('expressionConfigure',{stickerChance:0});
 n=sent().length;push(8306,'请删除双端动图表情。'+call('qq_edit_sticker',{sticker:'双端动图',delete:true}));await until(()=>sent().length>n);
 assert.equal((await bridge.request('companionStatus',{sessionId:cc})).expressions.stickerCount,1);
 assert.ok(!mock.calls.some(c=>['add_custom_face','modify_custom_face','delete_custom_face','fetch_custom_face'].includes(c.action)),'Shared CRUD does not touch QQ favorites');
 n=sent().length;push(8315,'看看这个表情。'+call('qq_import_qq_stickers',{}));await until(()=>sent().length>n);assert.ok(!mock.calls.some(c=>c.action==='fetch_custom_face'));
 n=sent().length;push(8316,'请导入QQ收藏里的表情。'+call('qq_import_qq_stickers',{}));await until(()=>sent().length>n);assert.equal(mock.calls.filter(c=>c.action==='fetch_custom_face').length,1,'Explicit QQ-only import remains native');
 const nativeConfig=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(nativeConfig.stickers.collect,false);assert.equal(nativeConfig.stickers.caption,false);
});

test('QQ quotes admit only same-conversation text and images',{timeout:90000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{loginDelayMs:0});
 const owner=10000001,bot=20000002,group=30000001;
 await bridge.control('nativeConfigure',{allow:{private:[],groups:[String(group)]}});
 const png=await readFile(new URL('./fixtures/media/image.png',import.meta.url));
 const text=value=>({type:'text',data:{text:value}});
 const image={type:'image',data:{file:'base64://'+png.toString('base64')}};
 const samples=[
  {route:'private',source:{message_type:'private',sender:{user_id:owner}},allowed:true},
  {route:'private',source:{message_type:'private',sender:{user_id:bot},target_id:owner},allowed:true},
  {route:'group',source:{message_type:'group',group_id:group,sender:{user_id:owner}},allowed:true},
  {route:'private',source:{message_type:'private',sender:{user_id:bot},target_id:10000008},allowed:false},
  {route:'group',source:{message_type:'group',group_id:30000002,sender:{user_id:owner}},allowed:false},
  {route:'private',source:{message_type:'private',sender:{user_id:bot}},allowed:false},
  {route:'private',source:{message_type:'private',sender:{user_id:bot},target_id:owner},
   allowed:true,attachment:true,history:{}},
  {route:'private',source:{message_type:'private',sender:{user_id:bot},target_id:owner},
   allowed:true,attachment:false,history:{message_type:'private',target_id:10000008}},
 ];
 mock.state.messages=Object.fromEntries(samples.map(({source,history},index)=>[8500+index,{
  ...source,message_id:8500+index,message:[text('QUOTE_CONTENT_'+index),history?{type:'image',data:{file:'picture.png'}}:image],
 }]));
 await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 const log=join(directory.root,'trace.jsonl');
 for(const [index,{route,allowed,attachment=allowed,history}] of samples.entries()){
  const input='QUOTE_CHECK_'+index;
  mock.state.history=history?[{...history,message_id:8500+index,sender:{user_id:bot},message:[text('QUOTE_CONTENT_'+index),image]}]:[];
  const message=[{type:'reply',data:{id:String(8500+index)}},text(input)];
  if(route==='group')message.unshift({type:'at',data:{qq:String(bot)}});
  mock.push({post_type:'message',message_type:route,self_id:bot,user_id:owner,
   ...(route==='group'?{group_id:group}:{sub_type:'friend'}),
   message_id:8600+index,time:Math.floor(Date.now()/1000),message,sender:{user_id:owner,nickname:'主人'}});
  const turn=await until(async()=>{
   const raw=await readFile(log,'utf8').catch(()=> '');
   return raw.trim().split('\n').filter(Boolean).map(JSON.parse).flatMap(row=>row.messages)
    .findLast(m=>m.role==='user'&&m.source?.kind==='aurabot'&&JSON.stringify(m.content).includes(input));
  });
  assert.equal(JSON.stringify(turn.content).includes('QUOTE_CONTENT_'+index),allowed,'Quote text must follow conversation scope');
  assert.equal(turn.content.some(part=>part.type==='image'),attachment,'Quote media must follow conversation scope');
 }
});

test('original QQ imagegen and ClawChat draw/edit share one generator and gallery; saved artifacts survive sends and restart',{timeout:90000},async t=>{
 const png=await readFile(new URL('./fixtures/media/image.png',import.meta.url)),posts=[],downloads=[];let url,traceFile;
 const server=createServer(async(req,res)=>{if(req.url==='/result.png'){downloads.push(req.headers.authorization);res.writeHead(200,{'content-type':'image/png'});res.end(png);return;}
  assert.equal(req.url,'/v1/images/generations');let raw='';for await(const c of req)raw+=c.toString();const body=JSON.parse(raw);assert.equal(req.headers.authorization,'Bearer image-fixture');assert.equal(body.n,1);assert.equal(body.response_format,'url');posts.push(body);
  if(posts.length===1)await until(async()=> (await readFile(traceFile,'utf8')).includes('qq-tool-progress'));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{url:url+'/result.png'}]}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const f=await linkedFixture(t,{imageServer:url+'/v1',expressions:true,limit:1,lateNotice:true});const {mock,directory,bridge}=f;
 traceFile=join(directory.root,'trace.jsonl');
 await bridge.control('companionConfigure',{awakeFrom:0,awakeTo:24});
 const cc='image-clawchat';await bridge.request('create',{sessionId:cc,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});
 const status=await bridge.request('companionStatus',{sessionId:cc});assert.equal(status.tools.filter(n=>n==='draw_image').length,1);assert.equal(status.tools.filter(n=>n==='companion_paintings').length,1);assert.equal(status.modules.filter(n=>n==='imagegen').length,1);
 const sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:8401,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'运维自测，请画一张小鱼。'+call('qq_draw_image',{prompt:'运维小鱼',shape:'square'})}}],sender:{user_id:10000001,nickname:'主人'}});
 await until(()=>sent().some(c=>c.params.message.some(s=>s.type==='image')));await until(()=>sent().some(c=>c.params.message.some(s=>s.type==='text'&&s.data.text.includes('fixture complete'))));assert.equal(posts.length,1);
 await delay(1100);
 assert.ok(!sent().some(call=>call.params.message.some(part=>part.type==='text'&&/我已经在处理|好，我这就去画/.test(part.data.text))),
  'A progress draft still writing when the actual tool finishes must never be sent');
 assert.equal((await bridge.control('companionState')).usage.modelRequests,1);
 const gallery=join(directory.options.dataDir,'aurabot/imagegen'),files=(await readdir(gallery)).filter(n=>n.endsWith('.png'));assert.equal(files.length,1);
 await bridge.turn(cc,'image-edit','运维自测，请修改这幅作品。'+call('draw_image',{prompt:'运维小鱼改蓝色',shape:'square',image:files[0]}));assert.equal(posts.length,2);assert.ok(posts[1].image?.length===1);assert.equal(downloads.length,2);assert.ok(downloads.every(x=>x===undefined));
 assert.equal((await readdir(gallery)).filter(n=>n.endsWith('.png')).length,2);
 const deliveries=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(deliveries.length,1);assert.equal(deliveries[0].tool,'clawchat_send_image');assert.equal(deliveries[0].input.chat_id,directory.options.clawchat.route.conversation);
 await bridge.turn(cc,'gallery-query','运维自测，查看共同作品。'+call('companion_paintings',{action:'list'}));const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(JSON.stringify(trace.at(-1)).includes(files[0]));
 await bridge.close();const restarted=await bootBridge(directory);t.after(()=>restarted.close());await restarted.request('resume',{sessionId:cc,whalenestChatId:'dm-alice'});await restarted.request('prompt',{sessionId:cc,inputId:'image-edit',text:'运维自测，请修改这幅作品。'+call('draw_image',{prompt:'运维小鱼改蓝色',shape:'square',image:files[0]})});assert.equal(posts.length,2,'Restart reuses the original native request and paid image');
});

test('QQ and ClawChat share one platform song module, durable archive and origin delivery in the real SDK',{timeout:90000},async t=>{
 let posts=0;const errors=[];
 const server=createServer(async(req,res)=>{try{
  assert.equal(req.headers.authorization,'Bearer song-fixture');
  if(req.method==='POST'){assert.equal(req.url,'/api/jobs');let body='';for await(const c of req)body+=c;const p=JSON.parse(body);assert.equal(p.voice_preset,'none');posts++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'song-'+posts}));}
  else if(req.url.endsWith('/audio.flac'))res.end(Buffer.from('fLaC fixture song'));
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'succeeded'}));}
 }catch(error){errors.push(error.message);res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const {mock,directory,bridge,data}=await linkedFixture(t,{songServer:'http://127.0.0.1:'+server.address().port+'/v1',limit:0});
 const sid='singing-clawchat';await bridge.request('create',{sessionId:sid,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});
 await bridge.turn(sid,'song-cc','运维自测，请唱一首晚安歌 '+call('sing_song',{title:'晚安小鱼',lyrics:'[Verse]\n小鱼游过月光',style:'gentle female vocal'}));
 const journal=join(directory.options.dataDir,'media/song-requests');
 const records=async()=>{try{return await Promise.all((await readdir(journal)).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await readFile(join(journal,n)))));}catch{return [];}};
 await until(async()=>{const r=await records();return r[0]?.delivery?.state==='confirmed';});assert.equal(posts,1);
 const status=await bridge.request('companionStatus',{sessionId:sid});for(const name of ['sing_song','companion_songs'])assert.equal(status.tools.filter(n=>n===name).length,1);
 assert.equal(status.modules.filter(n=>n==='song').length,1);assert.equal(status.singing.songs,1);assert.equal(status.companion.usage.modelRequests,0);
 assert.equal(JSON.parse(await readFile(join(data,'config.json'))).song.enabled,false,'The original RVC studio stays disabled');
 const first=(await records())[0],push=(id,text)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
 push(9901,'运维自测，请发送已有歌曲 '+call('companion_songs',{action:'send',operationId:first.requestId}));
 await until(()=>mock.calls.some(c=>c.action==='send_private_msg'&&JSON.stringify(c.params.message).includes('record')));assert.equal(posts,1,'Sending the shared ClawChat song on QQ never creates another song');
 push(9902,'运维自测，请唱一首新的小鱼歌 '+call('sing_song',{title:'小鱼清晨',lyrics:'[Verse]\n小鱼迎接晨光',style:'warm male vocal'}));
 await until(async()=>{const r=await records();return r.length===2&&r.every(s=>s.delivery?.state==='confirmed');});assert.equal(posts,2);
 const ccSends=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(ccSends.filter(r=>r.input.path).length,1,'The QQ-generated song stays on its original route');
 assert.deepEqual(errors,[]);
});
