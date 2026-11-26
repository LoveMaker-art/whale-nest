import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startMockOneBot} from '../vendor/aurabot/test/helpers/mock-onebot.js';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {seedBiliAccount} from './bili-test-helper.mjs';
import {createServer} from 'node:http';
import {enablePlatformSpeech} from '../src/runtime-upgrade.mjs';
import {enablePlatformImage,enablePlatformSinging} from '../src/runtime-upgrade.mjs';

const call=(name,args)=>'FOUNDATION_TOOL '+JSON.stringify({name,args});
async function until(predicate) {
  const deadline=Date.now()+18000;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(30);}
  throw Error('Native QQ test timed out');
}

async function linkedFixture(t,{limit,contactMode,loginDelayMs=700,bili=false,inbox=false,voiceServer,imageServer,songServer,expressions=false,nativeModules=false,lateNotice=false}={}){
  const mock=await startMockOneBot({selfId:'20000002',loginDelayMs});
  t.after(()=>mock.close());
  const directory=await bridgeDirectory();
  directory.options.owners=[directory.options.owners[0],{channel:'qq',account:'20000002',sender:'10000001'}];
  directory.options.qq={enabled:true,nativeModules};
  if(expressions){directory.options.expressions={enabled:true};directory.options.clawchat.delivery.mediaEnabled=true;}
  if(imageServer){const provider=join(directory.root,'image-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:imageServer,apiKey:'image-fixture'}}}}));directory.options.image=enablePlatformImage({providerConfigPath:provider});directory.options.clawchat.delivery.mediaEnabled=true;}
  if(songServer){const provider=join(directory.root,'song-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:songServer,apiKey:'song-fixture'}}}}));directory.options.singing=enablePlatformSinging({providerConfigPath:provider,pollMs:3000});directory.options.clawchat.delivery.mediaEnabled=true;}
  if(voiceServer){
    const provider=join(directory.root,'speech-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:voiceServer,apiKey:'voice-fixture'}}}}));
    directory.options.speech=enablePlatformSpeech({providerConfigPath:provider});directory.options.expressions={enabled:true};directory.options.clawchat.delivery.mediaEnabled=true;
  }
  if(limit!==undefined)directory.options.activities={enabled:false,automatic:false,maxDailyBackgroundModelCalls:limit};
  if(bili){directory.biliFixture=true;directory.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:limit??0};}
  if(inbox){directory.biliInboxFixture=join(directory.root,'bili-inbox-fixture.json');seedBiliAccount(directory.options,directory.options.clawchat.route);await writeFile(directory.biliInboxFixture,JSON.stringify({sessions:{session_list:[],has_more:0},messages:{messages:[],has_more:0},at:{items:[],cursor:{is_end:true}},reply:{items:[],cursor:{is_end:true}}}));}
  if(contactMode)directory.nativeModelEnv={WHALENEST_CONTACT_FIXTURE:contactMode};
  if(lateNotice)directory.nativeModelEnv={...directory.nativeModelEnv,WHALENEST_TEST_LATE_NOTICE:'1'};
  await writeFile(directory.configPath,JSON.stringify(directory.options));
  const data=join(directory.options.dataDir,'aurabot');
  await mkdir(data,{recursive:true});
  await writeFile(join(data,'config.json'),JSON.stringify({
    enabled:true,dryRun:false,safeMode:true,gateway:'onebot',botQQ:'20000002',ownerQQ:'10000001',
    workspaceDir:join(directory.root,'qq-workspace'),persona:{current:'dafeiyu-original'},model:directory.options.model,
    modules:Object.fromEntries(['stickers','mood','memory','bili','companion-management','qq-tools','qq-api'].map(id=>[id,{enabled:true}]).concat(
      ['voice','imagegen','diary','qzone-social','speakup','purpose','song','profile','contacts','video'].map(id=>[id,{enabled:false}]))),
    snowluma:{autoStart:false,autoAttach:false,httpUrl:mock.httpUrl,wsUrl:mock.wsUrl,httpToken:mock.token,wsToken:mock.token},
    approvalViaQQ:false,security:{dangerConfirm:false},
    merge:{enabled:false},voice:{enabled:!!voiceServer,autoChance:0},stickers:{autoChance:0,collect:false,caption:false},
    mood:{enabled:true,judge:false},memory:{enabled:true,dailyConsolidate:false,shortTerm:false,extractIdleMinutes:0,vector:{enabled:false}},
    speakUp:{enabled:false},bili:{enabled:bili,minViews:0},chat:{seedHistory:false},
  }));
  const bridge=await bootBridge(directory);t.after(()=>bridge.close());
  return {mock,directory,bridge,data};
}

test('original QQ host and Hub run in real SDK beside ClawChat with shared modules and separate Sessions',{timeout:60000},async t=>{
  const {mock,directory,bridge,data}=await linkedFixture(t);
  const sent=()=>mock.calls.filter(row=>row.action==='send_private_msg');
  const push=(id,text)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',
    self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),
    message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
  await until(()=>mock.calls.some(row=>row.action==='get_login_info'));
  push(101,'QQ_BUFFERED_HELLO，谢谢');
  await until(()=>sent().length===1);
  assert.ok(sent()[0].t-mock.calls.find(row=>row.action==='get_login_info').t>=500,'Original login verification buffers early events');
  const native=await bridge.control('nativeState');
  assert.equal(native.webServer,false);
  assert.equal(native.onebotState,'connected');
  assert.equal(native.modules.filter(id=>id==='memory').length,1);
  const qqSession=native.sessions['private:10000001'].sessionId;
  assert.ok(qqSession);
  const ccSession='clawchat-preserved';
  const presets=await bridge.request('presets');
  assert.ok(presets.presets.every(preset=>!preset.id.startsWith('aurabot-')),'QQ-only presets are not offered to ClawChat');
  await bridge.request('create',{sessionId:ccSession,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});
  await bridge.turn(ccSession,'cc-remember',call('remember',{text:'主人喜欢茉莉茶 SHARED_APPROVED_FACT'}));
  await bridge.turn(ccSession,'cc-canary','CC_RAW_ONLY_CANARY_7324');
  const moodBefore=JSON.parse(await readFile(join(data,'mood.json'),'utf8')).value;
  await bridge.turn(ccSession,'cc-mood-canary','CC秘密7324，谢谢抱抱');
  assert.ok(JSON.parse(await readFile(join(data,'mood.json'),'utf8')).value>moodBefore);
  const before=sent().length;push(102,'请回想我的茉莉茶偏好');
  await until(()=>sent().length===before+1);
  const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const qqRequest=trace.findLast(row=>row.messages.some(m=>m.source?.kind==='aurabot'));
  assert.ok(JSON.stringify(qqRequest).includes('SHARED_APPROVED_FACT'),'QQ sees the same approved memory');
  assert.ok(!JSON.stringify(qqRequest).includes('CC_RAW_ONLY_CANARY_7324'),'QQ does not inherit the other platform raw Session');
  assert.ok(!JSON.stringify(qqRequest).includes('CC秘密7324'),'Shared mood does not automatically quote the other Session private text');
  assert.ok(qqRequest.tools.some(tool=>tool.name.startsWith('qq_')),'Original QQ tools are not cut by the ClawChat whitelist');
  assert.ok(qqRequest.tools.some(tool=>tool.name==='companion_persona'));
  assert.notEqual(qqSession,ccSession);
  assert.equal((await bridge.control('memoryState')).items.filter(m=>m.text.includes('SHARED_APPROVED_FACT')).length,1);
  await bridge.turn(ccSession,'cc-persona-create',call('companion_persona',{action:'create',id:'blue',body:'PERSONA_FIXTURE_BLUE 你是小蓝。'}));
  await bridge.turn(ccSession,'cc-persona-use',call('companion_persona',{action:'use',id:'blue'}));
  assert.equal((await bridge.control('nativeState')).persona,'blue');
  const beforeBlue=sent().length;push(103,'请用现在的人格回答');
  await until(()=>sent().length===beforeBlue+1);
  const last=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(row=>row.messages.some(m=>m.source?.kind==='aurabot'));
  assert.ok(JSON.stringify(last.messages.filter(m=>m.role==='system')).includes('PERSONA_FIXTURE_BLUE'));
  const beforeManage=sent().length;push(104,call('companion_persona',{action:'get'}));
  await until(()=>sent().length===beforeManage+1);
  const managed=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(row=>row.messages.some(m=>m.source?.kind==='aurabot'));
  assert.ok(managed.messages.some(message=>(message.content??[]).some(block=>block.type==='tool-call'&&block.name==='companion_persona')),
    'Native QQ owner can invoke the same management tool through an original aurabot-source turn');
  assert.ok(managed.messages.some(message=>(message.content??[]).some(block=>block.type==='text'&&block.text?.includes('"currentId":"blue"'))));
  const beforeSwitch=sent().length,traceCount=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').length;
  push(105,call('companion_persona',{action:'use',id:'dafeiyu-original'}));
  await until(()=>sent().length===beforeSwitch+1);
  const switchRequests=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).slice(traceCount);
  assert.ok(switchRequests.length>=2,'Native QQ executes a full switching tool loop');
  assert.ok(switchRequests.every(row=>JSON.stringify(row.messages.filter(message=>message.role==='system')).includes('PERSONA_FIXTURE_BLUE')),
    'A native QQ mid-turn switch keeps the original card until the next turn');
  const beforeNext=sent().length;push(106,'用下一轮的人格继续回答');
  await until(()=>sent().length===beforeNext+1);
  const next=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(!JSON.stringify(next.messages.filter(message=>message.role==='system')).includes('PERSONA_FIXTURE_BLUE'));
  assert.ok(mock.calls.every(row=>row.action!=='send_group_msg'),'No unrelated group delivery');
});

test('QQ owner commands use model wording and keep exact references and command effects',{timeout:60000},async t=>{
 const {mock,bridge}=await linkedFixture(t,{limit:2,loginDelayMs:0});
 await bridge.control('companionConfigure',{awakeFrom:0,awakeTo:24});
 const sent=()=>mock.calls.filter(row=>row.action==='send_private_msg');
 const push=(id,text)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',
   self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),
   message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
 await until(async()=> (await bridge.control('nativeState')).onebotState==='connected');
 push(901,'/silent');
 await until(()=>sent().length===1);
 const quiet=sent()[0].params.message[0].data.text;
 assert.match(quiet,/^我收到你的指令啦。/);
 assert.match(quiet,/\/active/);
 push(902,'不应在静音期间回复');await delay(350);
 assert.equal(sent().length,1);
 push(903,'/active');
 await until(()=>sent().length===2);
 assert.match(sent()[1].params.message[0].data.text,/^我收到你的指令啦。/);
 push(904,'/help');
 await until(()=>sent().length===3);
 assert.match(sent()[2].params.message[0].data.text,/\/silent 30/);
 assert.equal((await bridge.control('companionState')).usage.modelRequests,2);
});

test('one original speakup sends through QQ then ClawChat, with real SDK guards, shared receipts and no duplicate writer',{timeout:90000},async t=>{
 const f=await linkedFixture(t,{limit:3,contactMode:'guard-once',loginDelayMs:0});let bridge=f.bridge;
 const sent=()=>f.mock.calls.filter(row=>row.action==='send_private_msg');
 const push=(id,text)=>f.mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
 await until(()=>f.mock.calls.some(row=>row.action==='get_login_info'));
 push(401,'先在QQ聊一句');await until(()=>sent().length===1);
 assert.equal((await bridge.control('policyState')).qqOnboarding.state,'offered');
 const sessionId='contact-clawchat';await bridge.request('create',{sessionId,whalenestChatId:'dm-alice',cwd:f.directory.root,model:f.directory.options.model});
 await bridge.turn(sessionId,'contact-cc-canary','CONTACT_CC_PRIVATE_CANARY');
 await bridge.turn(sessionId,'contact-enable',call('companion_settings',{action:'update',contactEnabled:true,proactivePlatform:'qq',idleMinutes:0,cooldownMinutes:0,awakeFrom:0,awakeTo:24}));
 const configured=await bridge.control('policyState');assert.equal(configured.settings.automatic,false);assert.equal(configured.usage.modelRequests,0);
 await bridge.control('contactTick');
 const first=await until(async()=>{const s=await bridge.control('policyState');return s.jobs.find(j=>j.kind==='contact'&&j.state==='confirmed')?s:null;});
 const qq=first.jobs.find(j=>j.kind==='contact');assert.equal(qq.route.channel,'qq');assert.equal(qq.nativeReceipts.length,2);assert.equal(qq.nativeAttempts,2);
 assert.equal(first.usage.automaticMessages,1);assert.equal(first.usage.modelRequests,2,'A rejected native tool call and its continuation both count');
 assert.equal(first.settings.contactEnabled,true,'Background tool could not change owner settings');
 const trace=()=>readFile(join(f.directory.root,'trace.jsonl'),'utf8').then(s=>s.trim().split('\n').map(JSON.parse));
 const requests=(await trace()).filter(r=>r.messages.some(m=>m.source?.taskId===qq.id));
 assert.equal(requests.length,2);assert.ok(requests.every(r=>!JSON.stringify(r).includes('CONTACT_CC_PRIVATE_CANARY')));
 assert.ok(JSON.stringify(requests).includes('后台任务不可作为主人手动授权'));
 const guideInputs=new Set((await trace()).flatMap(r=>r.messages.filter(m=>m.role==='user'&&JSON.stringify(m.content).includes('一次性的接入提示')).map(m=>m.id)));
 assert.equal(guideInputs.size,1,'The guide is inserted into one input; later history may still contain that input');
 const before=sent().length;push(402,call('companion_settings',{action:'update',proactivePlatform:'clawchat'}));await until(()=>sent().length===before+1);
 assert.equal((await bridge.control('policyState')).settings.proactivePlatform,'clawchat');
 await bridge.control('contactTick');
 const second=await until(async()=>{const s=await bridge.control('policyState');return s.jobs.filter(j=>j.kind==='contact'&&j.state==='confirmed').length===2?s:null;});
 assert.equal(second.usage.automaticMessages,2);assert.equal(second.usage.modelRequests,3);
 const deliveries=(await readFile(join(f.directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].input.chatId,'dm-alice');assert.equal(deliveries[0].input.text,'CONTACT_CC_COMPLETE');
 await bridge.control('contactTick');await delay(150);assert.equal((await bridge.control('policyState')).jobs.filter(j=>j.kind==='contact').length,2);
 assert.ok(!(await bridge.control('policyState')).jobs.some(j=>j.kind==='share'));
 assert.equal((await bridge.control('nativeState')).modules.filter(id=>id==='speakup').length,1);
 await bridge.close();bridge=await bootBridge(f.directory);t.after(()=>bridge.close());
 const restored=await bridge.control('policyState');assert.equal(restored.settings.proactivePlatform,'clawchat');assert.equal(restored.usage.automaticMessages,2);assert.equal(restored.usage.modelRequests,3);assert.ok(restored.qqOnboarding);
 await bridge.control('contactTick');await delay(150);assert.equal((await readFile(join(f.directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').length,1);
});


test('linked native QQ and ClawChat invoke one Bili module and share approved experiences without raw Session merging',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const cc='bili-shared-cc';await bridge.request('create',{sessionId:cc,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});
 await bridge.turn(cc,'cc-read',call('bili_watch',{link:'BV1xx411c7mD'}));await bridge.turn(cc,'cc-private','CC_BILI_RAW_CANARY_8192');
 const sent=()=>mock.calls.filter(r=>r.action==='send_private_msg'),push=(id,text)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
 let before=sent().length;push(801,call('companion_experiences',{}));await until(()=>sent().length>before);
 let trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),qq=trace.findLast(r=>r.messages.some(m=>m.source?.kind==='aurabot'));
 assert.match(JSON.stringify(qq),/TEST_OCEAN/);assert.ok(!JSON.stringify(qq).includes('CC_BILI_RAW_CANARY_8192'));
 for(const name of ['bili_watch','bili_search','bili_reply','bili_set_avatar','bili_set_sign','bili_comment','qq_send_shot','companion_experiences'])assert.equal(qq.tools.filter(t=>t.name===name).length,1,name);
 before=sent().length;push(802,call('bili_watch',{link:'BV1xx411c7mD'}));await until(()=>sent().length>before);
 await bridge.turn(cc,'cc-recall',call('companion_experiences',{}));
 const files=(await readdir(join(directory.options.dataDir,'activities'))).filter(n=>n.startsWith('whalenest-activity-'));assert.equal(files.length,2,'Two real manual reads of the same BV remain two experiences');
 const records=await Promise.all(files.map(n=>readFile(join(directory.options.dataDir,'activities',n),'utf8').then(JSON.parse)));assert.equal(new Set(records.map(r=>r.scope)).size,1);assert.equal(new Set(records.map(r=>r.sessionId)).size,2);
 trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(files.every(n=>JSON.stringify(trace.at(-1)).includes(n.replace('.json',''))));
 assert.equal((await readdir(join(directory.options.dataDir,'bili'))).filter(n=>n==='account.json').length,1);
});

test('original automatic Bili uses one shared budget and sends once through the preferred native QQ transport',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:5});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 await bridge.control('companionConfigure',{automatic:true,proactivePlatform:'qq',awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,diaryHour:23,interests:['鲸鱼']});
 const tick=await bridge.control('companionTick'),state=await bridge.control('companionState'),job=state.jobs.find(j=>j.id===tick.jobId);
 assert.equal(job.kind,'browse');assert.equal(job.engine,'aurabot-bili');assert.equal(job.route.channel,'qq');assert.equal(job.state,'confirmed');assert.equal(state.usage.modelRequests,2);assert.equal(state.usage.automaticMessages,1);
 assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('TEST_OCEAN')).length,1);
 await assert.rejects(access(join(directory.root,'delivered.jsonl')),{code:'ENOENT'});
 await bridge.control('companionConfigure',{automatic:false});await bridge.control('companionTick');assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('TEST_OCEAN')).length,1);
});


test('Bili inbox preference changes cancel unsent notices even after switching back, while new notices use QQ without a model',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,inbox:true,limit:0});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 await bridge.control('companionConfigure',{awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,maxProactivePerDay:0});await bridge.control('biliConfigure',{watchOn:true,watchInterval:60});await bridge.control('biliTick');
 const fixture=JSON.parse(await readFile(directory.biliInboxFixture));
 async function incoming(sequence){fixture.sessions.session_list=[{session_type:1,system_msg_type:0,talker_id:'456',max_seqno:String(sequence),session_ts:'9223372036854775807',unread_count:1,account_info:{name:'fixture'}}];fixture.messages={messages:[{msg_key:String(9000+sequence),msg_seqno:String(sequence),sender_uid:'456',receiver_id:'123',receiver_type:1,msg_type:1,msg_status:0,timestamp:Math.floor(Date.now()/1000)+sequence,content:JSON.stringify({content:'BILI_NOTICE_'+sequence})}],has_more:0,max_seqno:String(sequence),min_seqno:String(sequence)};await writeFile(directory.biliInboxFixture,JSON.stringify(fixture));await bridge.control('biliTick');}
 await incoming(1);assert.equal((await bridge.control('biliState')).pending,1);
 await bridge.control('companionConfigure',{proactivePlatform:'qq'});await bridge.control('companionConfigure',{proactivePlatform:'clawchat',maxProactivePerDay:2});await bridge.control('biliTick');
 await assert.rejects(access(join(directory.root,'delivered.jsonl')),{code:'ENOENT'});assert.equal((await bridge.control('companionState')).usage.automaticMessages,0);assert.equal((await bridge.control('biliState')).pending,0);
 await bridge.control('companionConfigure',{proactivePlatform:'qq'});await incoming(2);
 assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('BILI_NOTICE_2')).length,1);assert.equal((await bridge.control('companionState')).usage.modelRequests,0);
 await assert.rejects(access(join(directory.root,'trace.jsonl')),{code:'ENOENT'});
});


test('one original diary composer and private archive serve ClawChat and native QQ without a second generation',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:0});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const cc='diary-shared-cc';await bridge.request('create',{sessionId:cc,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});
 await bridge.turn(cc,'diary-source','EXPLORE_BILI_FIXTURE');await bridge.turn(cc,'cc-private','CC_DIARY_RAW_ONLY_CANARY');await bridge.turn(cc,'cc-diary','DIARY_WRITE_FIXTURE');
 const sent=()=>mock.calls.filter(r=>r.action==='send_private_msg'),push=(id,text)=>mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}});
 let before=sent().length;push(901,call('companion_diary',{action:'read'}));await until(()=>sent().length>before);before=sent().length;push(902,call('companion_diary',{action:'write'}));await until(()=>sent().length>before);
 const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),generated=trace.filter(r=>r.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('【私人活动日记】'))),qq=trace.findLast(r=>r.messages.some(m=>m.source?.kind==='aurabot'));
 assert.equal(generated.length,1);assert.equal((generated[0].tools??[]).length,0);assert.match(JSON.stringify(qq),/TEST_DIARY_FEELING/);assert.ok(!JSON.stringify(qq).includes('CC_DIARY_RAW_ONLY_CANARY'));assert.equal(qq.tools.filter(t=>t.name==='companion_diary').length,1);
 assert.equal((await readdir(join(directory.options.dataDir,'diary'))).length,1);assert.equal((await bridge.control('companionState')).usage.modelRequests,0);assert.equal(mock.calls.filter(r=>r.action==='send_qzone_msg').length,0);
});

test('automatic original diary saves privately and sends its single notification to the global QQ preference',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:5});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 await bridge.control('companionConfigure',{automatic:true,proactivePlatform:'qq',awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,diaryHour:0,interests:['鲸鱼']});
 await bridge.control('companionTick');const tick=await bridge.control('companionTick'),state=await bridge.control('companionState'),job=state.jobs.find(j=>j.id===tick.jobId);
 assert.equal(job.kind,'diary');assert.equal(job.engine,'aurabot-diary');assert.equal(job.route.channel,'qq');assert.equal(job.state,'confirmed');assert.equal(state.usage.modelRequests,3);assert.equal(state.usage.automaticMessages,2);
 const files=await readdir(join(directory.options.dataDir,'diary'));assert.equal(files.length,1);assert.equal(JSON.parse(await readFile(join(directory.options.dataDir,'diary',files[0]))).generator,'aurabot-diary-compose');
 assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('伙伴日记')).length,1);assert.equal(mock.calls.filter(r=>r.action==='send_qzone_msg').length,0);
 await assert.rejects(access(join(directory.root,'delivered.jsonl')),{code:'ENOENT'});await bridge.control('companionConfigure',{automatic:false});
});

test('explicit QQ space publishing uses the original post, keeps a separate receipt and never publishes private diary text',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:0});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const cc='diary-publish-cc';await bridge.request('create',{sessionId:cc,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});await bridge.turn(cc,'source','EXPLORE_BILI_FIXTURE');await bridge.turn(cc,'write','DIARY_WRITE_FIXTURE');assert.equal(mock.qzone.size,0);
 const draft=await bridge.control('diaryPreview',{platform:'qq',visibility:'self'});assert.equal(draft.visibility,'self');assert.ok(!draft.text.includes('TEST_DIARY_FEELING'));
 const args={action:'publish',platform:'qq',date:draft.date,visibility:'self',approvedText:draft.text};await bridge.turn(cc,'publish-qq',call('companion_diary',args));await bridge.turn(cc,'publish-qq-repeat',call('companion_diary',args));assert.equal(mock.qzone.size,1);assert.equal(mock.calls.filter(r=>r.action==='send_qzone_msg').length,1);assert.equal([...mock.qzone.values()][0].ugc_right,64);
 const before=mock.calls.filter(r=>r.action==='send_private_msg').length;mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:903,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:call('qq_send_qzone',{content:'NATIVE_EXPLICIT_SPACE_POST',visibility:'self'})}}],sender:{user_id:10000001,nickname:'主人'}});await until(()=>mock.calls.filter(r=>r.action==='send_private_msg').length>before);
 const rows=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),lastQQ=rows.findLast(r=>r.messages.some(m=>m.source?.kind==='aurabot'));assert.equal(mock.qzone.size,2,JSON.stringify({tools:lastQQ?.tools?.filter(t=>t.name.includes('qzone')).map(t=>t.name),messages:lastQQ?.messages.slice(-4)}));assert.ok([...mock.qzone.values()].some(r=>r.content==='NATIVE_EXPLICIT_SPACE_POST'&&r.ugc_right===64));
 const publications=JSON.parse(await readFile(join(directory.options.dataDir,'diary-publications.json')));assert.equal(Object.values(publications.records).filter(r=>r.platform==='qq'&&r.state==='confirmed').length,2);assert.ok(![...mock.qzone.values()].some(r=>r.content.includes('TEST_DIARY_FEELING')));
});


test('offline diary generation still archives privately, then confirms one QQ notification without regeneration',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:5});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const cc='diary-offline';await bridge.request('create',{sessionId:cc,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});await bridge.turn(cc,'source','EXPLORE_BILI_FIXTURE');
 await bridge.control('companionConfigure',{automatic:true,proactivePlatform:'qq',awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,diaryHour:0});await bridge.control('nativeConfigure',{enabled:false});
 const tick=await bridge.control('companionTick');let state=await bridge.control('companionState');assert.equal(state.jobs.find(j=>j.id===tick.jobId).state,'awaiting-delivery');assert.equal(state.usage.modelRequests,1);assert.equal(state.usage.automaticMessages,0);
 const file=join(directory.options.dataDir,'diary',(await readdir(join(directory.options.dataDir,'diary')))[0]);assert.equal(JSON.parse(await readFile(file)).state,'completed');await assert.rejects(access(join(directory.root,'delivered.jsonl')),{code:'ENOENT'});
 await bridge.control('nativeConfigure',{enabled:true});await bridge.control('companionTick');state=await bridge.control('companionState');assert.equal(state.jobs.find(j=>j.id===tick.jobId).state,'confirmed');assert.equal(state.usage.modelRequests,1);assert.equal(state.usage.automaticMessages,1);assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('伙伴日记')).length,1);
});

test('deleting a private diary cancels its unstarted notification without resurrecting text or publishing',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,limit:5});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const cc='diary-delete-pending';await bridge.request('create',{sessionId:cc,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});await bridge.turn(cc,'source','EXPLORE_BILI_FIXTURE');
 // Keep this diary-deletion scenario independent of the default browse topics.
 await bridge.control('companionConfigure',{automatic:true,interests:[],proactivePlatform:'qq',awakeFrom:0,awakeTo:24,idleMinutes:0,cooldownMinutes:0,diaryHour:0,maxProactivePerDay:0});const tick=await bridge.control('companionTick');assert.equal((await bridge.control('companionState')).usage.modelRequests,1);
 await bridge.turn(cc,'delete',call('companion_diary',{action:'delete'}));await bridge.control('companionConfigure',{maxProactivePerDay:2});await bridge.control('companionTick');const state=await bridge.control('companionState');assert.equal(state.jobs.find(j=>j.id===tick.jobId).state,'cancelled');assert.equal(state.usage.automaticMessages,0);assert.equal(state.usage.modelRequests,1);
 assert.equal(mock.calls.filter(r=>r.action==='send_private_msg'&&JSON.stringify(r.params).includes('伙伴日记')).length,0);assert.equal(mock.qzone.size,0);const entry=JSON.parse(await readFile(join(directory.options.dataDir,'diary',(await readdir(join(directory.options.dataDir,'diary')))[0])));assert.equal(entry.state,'deleted');assert.ok(!JSON.stringify(entry).includes('TEST_DIARY_FEELING'));
});

test('native Bili account edits keep working after generated runtime context and use the common confirmed journal',{timeout:60000},async t=>{
 const {mock,directory,bridge}=await linkedFixture(t,{bili:true,inbox:true,limit:0});await until(()=>mock.calls.some(r=>r.action==='get_login_info'));await delay(800);
 const before=mock.calls.filter(r=>r.action==='send_private_msg').length;mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:909,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:call('bili_set_sign',{text:'原生测试签名'})}}],sender:{user_id:10000001,nickname:'主人'}});await until(()=>mock.calls.filter(r=>r.action==='send_private_msg').length>before);
 const records=Object.values(JSON.parse(await readFile(join(directory.options.dataDir,'bili/account.json'))).mutations);assert.equal(records.length,1);assert.equal(records[0].kind,'profile');assert.equal(records[0].state,'confirmed');
 const calls=(await readFile(join(directory.root,'trace.jsonl.bili-api-calls'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.path.endsWith('/sign/update')&&c.method==='POST').length,1);
});

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
 const delivered=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(delivered.length,1);assert.equal(delivered[0].input.expectedKind,'image');assert.match(delivered[0].input.filePath,/\.gif$/);
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
 const deliveries=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(deliveries.length,1);assert.equal(deliveries[0].input.expectedKind,'image');
 await bridge.turn(cc,'gallery-query','运维自测，查看共同作品。'+call('companion_paintings',{action:'list'}));const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(JSON.stringify(trace.at(-1)).includes(files[0]));
 await bridge.close();const restarted=await bootBridge(directory);t.after(()=>restarted.close());await restarted.request('resume',{sessionId:cc,whalenestChatId:'dm-alice'});await restarted.request('prompt',{sessionId:cc,inputId:'image-edit',text:'运维自测，请修改这幅作品。'+call('draw_image',{prompt:'运维小鱼改蓝色',shape:'square',image:files[0]})});assert.equal(posts.length,2,'Restart reuses the original native request and paid image');
});

test('QQ-only tools, profile and request modules run in the original Hub and stay out of ClawChat',{timeout:90000},async t=>{
 const f=await linkedFixture(t,{nativeModules:true,loginDelayMs:0}),{mock,directory,data}=f;let bridge=f.bridge;
 const sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');let id=9100;
 async function ask(name,args,text='运维自测：执行本次明确QQ操作。',sender=10000001){const n=sent().length;mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:sender,message_id:++id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:text+call(name,args)}}],sender:{user_id:sender,nickname:sender===10000001?'主人':'获准好友'}});await until(()=>sent().slice(n).some(c=>c.params.message.some(s=>s.type==='text'&&s.data.text.includes('fixture complete'))));}
 await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 const native=await bridge.control('nativeState');for(const n of ['qq-tools','qq-api','profile','contacts','qzone-social'])assert.equal(native.modules.filter(x=>x===n).length,1);
 let cfg=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(cfg.qzoneSocial.enabled,false);assert.equal(cfg.enabled,true);
 mock.state.history=[{message_id:11,sender:{user_id:10000001,nickname:'主人'},message:[{type:'text',data:{text:'QQ_HISTORY_ONLY'}}]}];
 await ask('qq_chat_history',{count:2});assert.ok(mock.calls.some(c=>c.action==='get_friend_msg_history'));
 await ask('qq_whitelist',{action:'add',kind:'group',id:'30000001'});
 await ask('qq_api_find',{keyword:'群公告'});await ask('qq_api_call',{action:'set_group_card',param:JSON.stringify({group_id:30000001,user_id:10000001,card:'运维名片'})});assert.ok(mock.calls.some(c=>c.action==='set_group_card'));
 await ask('qq_get_profile',{});assert.ok(mock.calls.some(c=>c.action==='get_stranger_info'&&String(c.params.user_id)==='20000002'));
 await ask('qq_set_nickname',{name:'QQ模块验收'});assert.equal(mock.state.selfProfile.nickname,'QQ模块验收');
 await ask('qq_set_signature',{text:'保留原资料逻辑'});assert.equal(mock.state.selfProfile.long_nick,'保留原资料逻辑');
 await ask('qq_set_avatar',{image:'https://fixture.invalid/avatar.png'});assert.ok(mock.calls.some(c=>c.action==='set_qq_avatar'));
 mock.push({post_type:'request',request_type:'friend',self_id:20000002,user_id:10000004,flag:'native-friend',comment:'运维申请'});
 await until(async()=>readFile(join(data,'modules-data/contacts/friend-requests.json'),'utf8').then(s=>JSON.parse(s).some(r=>r.flag==='native-friend')).catch(e=>{if(e.code==='ENOENT')return false;throw e;}));
 await ask('qq_handle_friend_request',{qq:'10000004',approve:true});assert.ok(mock.calls.some(c=>c.action==='set_friend_add_request'&&c.params.flag==='native-friend'));
 mock.push({post_type:'request',request_type:'group',sub_type:'invite',self_id:20000002,user_id:10000004,group_id:30000001,invited_id:20000002,flag:'native-group'});
 await until(async()=>readFile(join(data,'modules-data/contacts/group-requests.json'),'utf8').then(s=>JSON.parse(s).some(r=>r.flag==='native-group')).catch(e=>{if(e.code==='ENOENT')return false;throw e;}));
 await ask('qq_list_group_requests',{});await ask('qq_handle_group_request',{flag:'native-group',approve:false,reason:'仅测试'});assert.ok(mock.calls.some(c=>c.action==='set_group_add_request'&&c.params.flag==='native-group'&&c.params.approve===false));
 await ask('qq_whitelist',{action:'add',kind:'private',id:'10000003'});
 const writes=mock.calls.filter(c=>c.action==='set_group_card').length;await ask('qq_api_call',{action:'set_group_card',param:JSON.stringify({group_id:30000001,user_id:10000004,card:'禁止修改'})},'运维自测，普通好友尝试管理。',10000003);assert.equal(mock.calls.filter(c=>c.action==='set_group_card').length,writes);
 const trace=()=>readFile(join(directory.root,'trace.jsonl'),'utf8').then(s=>s.trim().split('\n').map(JSON.parse));const guest=(await trace()).at(-1);assert.ok(!guest.tools.some(t=>['qq_set_nickname','qq_whitelist','qq_qzone_social','companion_update'].includes(t.name)));
 const groupBefore=mock.calls.filter(c=>c.action==='send_group_msg').length;
 mock.push({post_type:'message',message_type:'group',self_id:20000002,user_id:10000003,group_id:30000001,message_id:++id,time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:'20000002'}},{type:'text',data:{text:'运维自测，查询当前群文件。'+call('qq_api_call',{action:'get_group_file_system_info',param:JSON.stringify({group_id:30000001})})}}],sender:{user_id:10000003,nickname:'群成员',role:'member'}});
 await until(()=>mock.calls.filter(c=>c.action==='send_group_msg').slice(groupBefore).some(c=>c.params.message.some(s=>s.type==='text'&&s.data.text.includes('fixture complete'))));assert.ok(mock.calls.some(c=>c.action==='get_group_file_system_info'));
 assert.ok(!(await trace()).at(-1).tools.some(t=>t.name==='companion_update'));
 await ask('companion_update',{action:'status'},'运维自测：查看更新。');
 const qqOwner=(await trace()).at(-1);
 assert.ok(qqOwner.tools.some(t=>t.name==='bash'),'QQ owner retains the original complete tools after guest/group turns');
 assert.ok(qqOwner.tools.some(t=>t.name==='companion_update'));
 assert.ok(JSON.stringify(qqOwner.messages).includes('unconfigured'));
 const cc='qq-only-clawchat';await bridge.request('create',{sessionId:cc,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});const status=await bridge.request('companionStatus',{sessionId:cc});assert.equal(status.qqNative.configured,true);assert.equal(status.qqNative.modules.length,5);assert.equal(status.qqNative.automaticSocial,false);
 assert.ok(!status.tools.some(n=>['qq_api_call','qq_api_find','qq_set_nickname','qq_get_profile','qq_whitelist','qq_qzone_social'].includes(n)));
 assert.ok(status.tools.includes('companion_update'));
 assert.ok(status.tools.includes('bash'),'QQ social restrictions do not remove the ClawChat owner tools');
 const before=mock.calls.filter(c=>['get_qzone_feeds','comment_qzone','like_qzone'].includes(c.action)).length;assert.equal(before,0,'Loading the social module never starts an automatic run');
 await bridge.close();bridge=await bootBridge(directory);t.after(()=>bridge.close());const after=await bridge.control('nativeState');assert.equal(after.modules.filter(n=>n==='contacts').length,1);cfg=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(cfg.qzoneSocial.enabled,false);assert.ok(cfg.allow.private.includes('10000003'));assert.deepEqual(JSON.parse(await readFile(join(data,'modules-data/contacts/group-requests.json'),'utf8')),[]);
});

test('QQ space interaction delegates one manual run to the original social module and preserves its state',{timeout:90000},async t=>{
 const {mock,directory,bridge,data}=await linkedFixture(t,{nativeModules:true,loginDelayMs:0});await until(()=>mock.calls.some(c=>c.action==='get_login_info'));
 mock.state.feeds=[{appid:311,uin:10000001,nickname:'主人',key:'native-feed',time:Math.floor(Date.now()/1000),html:'运维自测公开动态'}];mock.state.qzoneDetail={'native-feed':{content:'运维自测公开动态',comments:[]}};
 await bridge.control('nativeConfigure',{qzoneSocial:{enabled:false,replyOwn:false,commentFriends:true,friendChance:1,ownerChance:1,like:true,maxPerDay:2,intervalMin:30}});
 const sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');const n=sent().length;
 const text='运维自测：请逛QQ空间并点赞、评论一条动态。'+call('qq_qzone_social',{action:'run'});const event={post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:9201,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{user_id:10000001,nickname:'主人'}};mock.push(event);
 await until(()=>sent().slice(n).some(c=>c.params.message.some(s=>s.type==='text'&&s.data.text.includes('fixture complete'))));
 assert.equal(mock.calls.filter(c=>c.action==='get_qzone_feeds').length,1);assert.equal(mock.calls.filter(c=>c.action==='like_qzone').length,1);assert.equal(mock.calls.filter(c=>c.action==='comment_qzone').length,1);
 const original=JSON.parse(await readFile(join(data,'qzone-social.json'),'utf8'));assert.equal(original.count,1);assert.ok(original.seen.includes('native-feed'));assert.equal(original.history[0].kind,'comment');
 const operations=await readdir(join(directory.options.dataDir,'qq-native/social-requests'));assert.equal(operations.length,1);const record=JSON.parse(await readFile(join(directory.options.dataDir,'qq-native/social-requests',operations[0]),'utf8'));assert.ok(record.result.ok);assert.equal(record.result.comments,1);
 mock.push(event);await delay(200);assert.equal(mock.calls.filter(c=>c.action==='comment_qzone').length,1,'Repeated QQ input does not comment again');
 assert.equal(JSON.parse(await readFile(join(data,'config.json'),'utf8')).qzoneSocial.enabled,false);
});

test('original automatic QQ social uses the shared budget in real SDK, persists pending comments and keeps manual work foreground',{timeout:90000},async t=>{
 const f=await linkedFixture(t,{nativeModules:true,limit:2,loginDelayMs:0}),{mock,directory,data}=f;let bridge=f.bridge;
 await until(()=>mock.calls.some(c=>c.action==='get_login_info'));await bridge.control('policyConfigure',{awakeFrom:0,awakeTo:24});
 const cc='qzone-private-canary';await bridge.request('create',{sessionId:cc,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});await bridge.turn(cc,'qzone-cc-raw','运维自测：CC_RAW_QZONE_PRIVATE_01');await bridge.turn(cc,'qzone-cc-memory',call('remember',{text:'PRIVATE_MEMORY_QZONE_02'}));
 mock.state.qzoneList=[{tid:'automatic-own',comment_num:3,time:Date.now()/1000,content:'运维自测公开动态'}];mock.state.qzoneDetail={'automatic-own':{comments:[0,1,2].map(i=>({comment_id:'c'+i,uin:10000001,name:'主人',content:'公开评论'+i,time:i+1}))}};
 const sent=()=>mock.calls.filter(c=>c.action==='send_private_msg');
 async function ask(id,text,args){const n=sent().length;mock.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:id,time:Date.now()/1000,message:[{type:'text',data:{text:text+call('qq_qzone_social',args)}}],sender:{user_id:10000001,nickname:'主人'}});await until(()=>sent().slice(n).some(c=>c.params.message.some(s=>s.type==='text'&&s.data.text.includes('fixture complete'))));}
 await ask(9301,'运维自测：请开启QQ空间自动互动。',{action:'update',enabled:true});
 const first=await bridge.control('qqSocialTick');assert.equal(first.replies,2);assert.equal(first.state,'completed');assert.equal((await bridge.control('policyState')).usage.modelRequests,2);assert.equal((await bridge.control('policyState')).settings.automatic,false);
 const stored=()=>readFile(join(data,'qzone-social.json'),'utf8').then(JSON.parse);assert.deepEqual((await stored()).replied['automatic-own'],['c0','c1']);assert.equal(mock.calls.filter(c=>c.action==='comment_qzone').length,2);
 assert.equal((await bridge.control('qqSocialTick')).reason,'daily-model-limit');
 await bridge.close();bridge=await bootBridge(directory);t.after(()=>bridge.close());await until(()=>mock.calls.filter(c=>c.action==='get_login_info').length>=2);assert.equal((await bridge.control('qqSocialTick')).reason,'daily-model-limit');assert.equal(mock.calls.filter(c=>c.action==='comment_qzone').length,2);
 await ask(9302,'运维自测：请手动回复QQ空间尚未处理的评论。',{action:'run'});assert.equal(mock.calls.filter(c=>c.action==='comment_qzone').length,3);assert.equal((await stored()).replied['automatic-own'].length,3);assert.equal((await bridge.control('policyState')).usage.modelRequests,2,'Explicit manual social is foreground, even after the automatic allowance is exhausted');
 await ask(9303,'运维自测：关闭QQ空间自动互动。',{action:'update',enabled:false});assert.equal((await bridge.control('qqSocialTick')).reason,'social-disabled');
 const trace=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),automatic=trace.filter(r=>String(r.messages.findLast(m=>m.role==='user'&&['user','schedule','aurabot'].includes(m.source?.kind))?.source?.taskId??'').startsWith('whalenest-qq-social-auto-'));assert.equal(automatic.length,2);assert.ok(automatic.every(r=>(r.tools??[]).length===0));assert.ok(automatic.every(r=>!JSON.stringify(r).includes('CC_RAW_QZONE_PRIVATE_01')&&!JSON.stringify(r).includes('PRIVATE_MEMORY_QZONE_02')),'Public QQ social drafts exclude private ClawChat conversation and owner memory');
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
 const ccSends=(await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(ccSends.filter(r=>r.input.filePath).length,1,'The QQ-generated song stays on its original route');
 assert.deepEqual(errors,[]);
});
