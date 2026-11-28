import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {bootBridge} from './bridge-helper.mjs';
import {linkedFixture,until,call} from './native-qq-helper.mjs';

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
