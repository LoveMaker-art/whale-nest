import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createQQGateway} from '../src/qq-gateway.mjs';
import {createQQConnection} from '../src/qq-connection.mjs';
import {applyQQTransition,finishQQTransition,recoverQQTransition,qqManagementFile} from '../src/qq-transition.mjs';
import {reloadQQConnection} from '../src/qq-reload.mjs';
import {writeState,readState} from '../src/state.mjs';
import {hash,senderKey} from '../src/routing.mjs';
import {createMemoryStorage} from '../vendor/aurabot/src/features/memory-store.js';
import {startMockOneBot} from '../vendor/aurabot/test/helpers/mock-onebot.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
async function loginServer(t,type='llbot') {
  const state={online:false,scanned:false,botQQ:'20000002',calls:[],fail:false};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    state.calls.push({path:req.url,headers:req.headers,method:req.method,body:raw?JSON.parse(raw):null});
    let data;
    switch(req.url) {
      case '/api/auth/login': data={Credential:'private-session-secret'};break;
      case '/api/login-info':data={selfInfo:{online:state.online,uin:state.botQQ}};break;
      case '/api/QQLogin/CheckLoginStatus':data={isLogin:state.online,qrLoginAccepted:state.scanned,loginPhase:state.phase};break;
      case '/api/QQLogin/GetQQLoginInfo':data={online:state.online,uin:state.botQQ};break;
      case '/api/logout':state.online=false;data={};break;
      default:data={qrcodeUrl:state.qrURL??'https://ssl.ptlogin2.qq.com/login/fixture-token',qrcodeurl:state.qrURL??'https://ssl.ptlogin2.qq.com/login/fixture-token'};
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(type==='llbot'?{success:!state.fail,data,message:'gateway-secret-must-not-leak'}
      :{code:state.fail?-1:0,data,message:'gateway-secret-must-not-leak'}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return {state,config:{type,url:'http://127.0.0.1:'+server.address().port,token:'operator-secret-1234'}};
}
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'whalenest-qq-management-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const route={channel:'clawchat',account:'local-agent',sender:'alice',kind:'private',conversation:'dm-alice'};
  const options={instanceId:'qq-fixture',dataDir:join(root,'data'),cwd:root,owners:[{channel:route.channel,account:route.account,sender:route.sender}],
    clawchat:{route,delivery:{configPath:join(root,'connect/config.json')}},qq:{enabled:false}};
  const configPath=join(root,'instance.json');writeState(configPath,options);
  const nativeConfig={enabled:false,ownerQQ:'1',botQQ:'',modules:{},persona:{current:'dafeiyu-original'}};
  writeState(join(options.dataDir,'aurabot/config.json'),nativeConfig);
  const native={getConfig:()=>nativeConfig,setConfig:value=>Object.assign(nativeConfig,value),onebot:{state:'stopped',start(){native.started=true;}}};
  const actor=(text='',operationId='operation-1')=>({route,sessionId:'cc-session',operationId,text});
  return {root,options,configPath,native,nativeConfig,actor};
}

test('gateway HTTP authentication, scanned/online distinction, failures and real logout contract',async t=>{
  for(const type of ['napcat','llbot']) {
    const {state,config}=await loginServer(t,type),gateway=createQQGateway(config);
    const qr=await gateway.qr();assert.match(qr.url,/qq\.com/);
    if(type==='napcat') {
      assert.deepEqual(state.calls[0].body,{hash:digest(config.token+'.napcat')});
      assert.equal(state.calls[1].headers.authorization,'Bearer private-session-secret');
      state.scanned=true;assert.equal((await gateway.status()).state,'scanned');
      await assert.rejects(gateway.logout(),/退出接口/);
    } else assert.equal(state.calls[0].headers['x-webui-token'],digest(config.token));
    state.online=true;assert.deepEqual(await gateway.status(),{state:'online',botQQ:'20000002',name:''});
    state.fail=true;await assert.rejects(gateway.status(),error=>!error.message.includes('gateway-secret'));
    state.fail=false;
    if(type==='llbot') {assert.equal((await gateway.logout()).credentialsRetained,true);assert.equal(state.online,false);}
    assert.ok(state.calls.every(call=>JSON.stringify(call.body).indexOf(config.token)<0));
  }
});

test('gateway refuses an unrelated QR origin and bounds the response before JSON parsing',async t=>{
  const {state,config}=await loginServer(t);state.qrURL='https://qq.com.attacker.example/login';
  await assert.rejects(createQQGateway(config).qr(),/来源不受支持/);
  await assert.rejects(createQQGateway(config,{fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))}).status(),/响应过大/);
});

test('LLBot release login-info uses flat account fields and retains compatibility with nested responses',async()=>{
 let online=true;
 const gateway=createQQGateway({type:'llbot',url:'http://127.0.0.1:3080',token:'local-webui-token'},
  {fetchImpl:async()=>new Response(JSON.stringify({success:true,data:{online,uin:'20000002',nick:'测试QQ',mode:'direct'}}))});
 assert.deepEqual(await gateway.status(),{state:'online',botQQ:'20000002',name:'测试QQ'});
 online=false;assert.deepEqual(await gateway.status(),{state:'offline'});
});

test('local wait timeout removes the QR without claiming native expiry; uncertain switching is never repeated',async t=>{
  const f=fixture(t),{config,state}=await loginServer(t);f.options.qq.gateway=config;
  let clock=Date.now();const deliveries=[];
  const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,now:()=>clock,
    mediaSender:()=>({send:async input=>{deliveries.push(input);return {state:'uncertain'};}})});t.after(()=>manager.close());
  await manager.execute({action:'start_login'},f.actor());clock+=300001;
  assert.equal((await manager.execute({action:'poll'},f.actor())).login.state,'timed-out');
  assert.equal(existsSync(deliveries[0].filePath),false);
  state.online=true;state.fail=true;const actor=f.actor('确认更换机器人QQ','switch-once');
  await assert.rejects(manager.execute({action:'switch_bot',confirm:true},actor),/QQ网关未完成/);
  const count=state.calls.filter(call=>call.path==='/api/logout').length;
  assert.equal(count,1);
  assert.equal((await manager.execute({action:'switch_bot',confirm:true},actor)).switchState,'uncertain');
  assert.equal(state.calls.filter(call=>call.path==='/api/logout').length,count);
});

test('QQ automatically reports native expiration and a later verified login without another chat command',async t=>{
 const f=fixture(t),{config,state}=await loginServer(t,'napcat');f.options.qq.gateway=config;
 let clock=Date.now();const notices=[];
 const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,now:()=>clock,
  mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'qr-auto-fixture'})}),queueNotification:value=>notices.push(value)});
 t.after(()=>manager.close());
 const login=await manager.execute({action:'start_login'},f.actor());
 state.phase='expired';clock+=3100;
 const waitFor=async predicate=>{const until=Date.now()+5000;while(!predicate()&&Date.now()<until)await new Promise(r=>setTimeout(r,30));assert.ok(predicate());};
 await waitFor(()=>manager.status().login.state==='expired');
 assert.equal(notices.length,1,'Native expiration is reported before the fixed five-minute timeout');
 state.online=true;clock=login.login.expiresAt+3100;
 await waitFor(()=>manager.status().login.state==='online');
 assert.equal(notices.length,2,'A successful login must still be announced after expiration');
 assert.equal(manager.status().binding,null,'Automatic account detection never links an owner');
});

test('repeating connect during phone confirmation preserves the current attempt instead of fetching another code',async t=>{
 const f=fixture(t),{config,state}=await loginServer(t,'napcat');f.options.qq.gateway=config;
 let images=0;
 const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,mediaSender:()=>({send:async()=>{images++;return {state:'confirmed',messageId:'phone-fixture'};}})});t.after(()=>manager.close());
 const first=await manager.execute({action:'start_login'},f.actor());state.scanned=true;
 const next=await manager.execute({action:'start_login'},f.actor('连接QQ','repeat-during-confirm'));
 assert.equal(next.login.state,'scanned');assert.equal(next.login.id,first.login.id);assert.equal(images,1);assert.equal(next.qrDelivery,undefined);
 const refreshed=await manager.execute({action:'refresh_login'},f.actor('重新扫码','explicit-refresh'));
 assert.notEqual(refreshed.login.id,first.login.id);assert.equal(images,2);
 assert.equal(state.calls.filter(c=>c.path==='/api/QQLogin/RefreshQRcode').length,1,'Only the explicit refresh starts a new QR during phone verification');
});

test('first connect opens scan login and a retry does not interrupt native phone confirmation',async t=>{
 const f=fixture(t),{config,state}=await loginServer(t,'napcat');
 f.options.qq.gateway=config;
 let clock=Date.now(),images=0;
 const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,now:()=>clock,
  mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'first-connect-'+(++images)})})});
 t.after(()=>manager.close());
 const first=await manager.execute({action:'connect'},f.actor('连接QQ','first-connect'));
 assert.equal(first.qrDelivery,'delivered');
 assert.equal(first.binding,null);
 const repeated=await manager.execute({action:'start_login'},f.actor('再连接一次QQ','first-connect-again'));
 assert.equal(repeated.login.id,first.login.id);
 assert.equal(images,1);
 state.scanned=true;clock=first.login.expiresAt+1000;
 const resumed=await manager.execute({action:'start_login'},f.actor('连接QQ','phone-still-working'));
 assert.equal(resumed.login.state,'scanned');
 assert.equal(resumed.login.id,first.login.id);
 assert.equal(images,1);
 const unrequestedRefresh=await manager.execute({action:'refresh_login'},f.actor('现在连接好了吗','model-selected-refresh'));
 assert.equal(unrequestedRefresh.login.state,'scanned');
 const declinedRefresh=await manager.execute({action:'refresh_login'},f.actor('先不要刷新二维码','declined-refresh'));
 assert.equal(declinedRefresh.login.state,'scanned');
 assert.equal(images,1);
 assert.equal(state.calls.filter(c=>c.path==='/api/QQLogin/RefreshQRcode').length,0);
 state.online=true;
 const connected=await manager.execute({action:'connect'},f.actor('连接QQ','first-connect-verified'));
 assert.equal(connected.login.state,'online');
 assert.equal(connected.nextAction,'provide-owner-qq');
 assert.equal(connected.binding,null);
 assert.equal(connected.confirmationRequired,undefined);
 assert.equal(connected.change,undefined);
});

test('an uncertain QR delivery is checked through its original receipt before offering another image',async t=>{
 const f=fixture(t),{config}=await loginServer(t,'napcat');f.options.qq.gateway=config;
 const mediaRequest='whalenest-media-'+'a'.repeat(64),checks=[];
 let sends=0,received=false;
 const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,
  mediaSender:()=>({send:async()=>{sends++;return {state:'uncertain',requestId:mediaRequest};},
   check:async id=>{checks.push(id);return received?{state:'confirmed',requestId:id,messageId:'original-qr'}:{state:'uncertain',requestId:id};}})});
 t.after(()=>manager.close());
 const first=await manager.execute({action:'start_login'},f.actor('连接QQ','original-receipt'));
 assert.equal(first.qrDelivery,'unconfirmed');
 const retry=await manager.execute({action:'start_login'},f.actor('连接QQ','pending-receipt'));
 assert.equal(retry.login.id,first.login.id);
 assert.equal(retry.qrDelivery,'unconfirmed');
 received=true;
 const recovered=await manager.execute({action:'start_login'},f.actor('连接QQ','resolved-receipt'));
 assert.equal(recovered.login.delivery.messageId,'original-qr');
 assert.equal(recovered.reused,true);
 assert.equal(sends,1);
 assert.deepEqual(checks,[mediaRequest,mediaRequest]);
});

test('a recovered QQ reports chat availability once only after the existing channel is verified',async t=>{
 const f=fixture(t),{config,state}=await loginServer(t,'napcat');
 f.options.qq={enabled:true,gateway:config};
 f.options.owners.push({channel:'qq',account:'20000002',sender:'30000003'});
 f.nativeConfig.enabled=true;
 f.native.onebot.state='connecting';
 let verified=false;
 f.native.qqConnectionState=()=>({verified});
 const notices=[];
 const dependencies={configPath:f.configPath,getNative:()=>f.native,queueNotification:notice=>notices.push(notice),
  mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'channel-recovery-qr'})})};
 let manager=createQQConnection(f.options,dependencies);t.after(()=>manager.close());
 await manager.execute({action:'connect'},f.actor('连接QQ','recover-channel'));
 state.online=true;
 assert.equal((await manager.execute({action:'poll'},f.actor())).verified,false);
 assert.equal(notices.length,1);
 assert.match(notices[0].text,/核实QQ聊天通道/);
 const pending=await manager.execute({action:'connect'},f.actor('连接QQ','channel-still-starting'));
 assert.equal(pending.nextAction,'wait-for-channel');
 assert.equal(pending.confirmationRequired,undefined);
 assert.equal(pending.change,undefined);
 f.native.onebot.state='connected';verified=true;
 await manager.execute({action:'poll'},f.actor());
 assert.equal(notices.length,2);
 assert.match(notices[1].text,/QQ聊天已恢复/);
 await manager.close();
 manager=createQQConnection(f.options,dependencies);
 await manager.execute({action:'poll'},f.actor());
 assert.equal(notices.length,2);
});

test('connecting an existing QQ after gateway sign-out prepares a QR before asking to change the channel',async t=>{
 const f=fixture(t),{config,state}=await loginServer(t,'napcat');
 f.options.qq={enabled:true,gateway:config};
 f.options.owners.push({channel:'qq',account:'20000002',sender:'30000003'});
 f.nativeConfig.enabled=true;
 f.native.onebot.state='disconnected';
 state.online=true;
 let images=0;
 const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,
  mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'reconnect-qr-'+(++images)})})});
 t.after(()=>manager.close());
 assert.equal((await manager.execute({action:'start_login'},f.actor())).login.state,'online');
 state.online=false;
 const status=await manager.execute({action:'status'},f.actor());
 assert.equal(status.login.state,'waiting');
 assert.equal(status.login.lastKnownState,'online');
 const qr=await manager.execute({action:'connect'},f.actor('连接QQ','restore-existing'));
 assert.equal(qr.qrDelivery,'delivered');
 assert.equal(qr.confirmationRequired,undefined);
 assert.equal(qr.binding.botQQ,'20000002');
 assert.equal(qr.change,undefined);
 const waiting=await manager.execute({action:'connect'},f.actor('连接QQ','still-waiting'));
 assert.equal(waiting.login.state,'waiting');
 assert.equal(images,1);
 state.scanned=true;
 const scanned=await manager.execute({action:'connect'},f.actor('确认连接QQ','scanned-existing'));
 assert.equal(scanned.login.state,'scanned');
 assert.equal(scanned.confirmationRequired,undefined);
 assert.equal(images,1);
 state.online=true;state.botQQ='20000009';
 const wrong=await manager.execute({action:'connect',confirm:true},f.actor('确认连接QQ','wrong-bot'));
 assert.equal(wrong.errorCode,'account-changed');
 assert.equal(wrong.change,undefined);
});

test('QR login delivers a PNG, distinguishes scan from login, validates owner proof then stages one change',async t=>{
  const f=fixture(t),{config,state}=await loginServer(t),onebot=await startMockOneBot();t.after(()=>onebot.close());
  f.options.qq.gateway={...config,onebot:{httpUrl:onebot.httpUrl,wsUrl:onebot.wsUrl,token:onebot.token}};
  writeState(f.configPath,f.options);
  const deliveries=[],notices=[],reloads=[];let clock=Date.now();
  const manager=createQQConnection(f.options,{configPath:f.configPath,getNative:()=>f.native,now:()=>clock,
    mediaSender:()=>({async send(input){deliveries.push(input);assert.equal(readFileSync(input.filePath).subarray(0,8).toString('hex'),'89504e470d0a1a0a');return {state:'confirmed',messageId:'cc-qr-42'};}}),
    queueNotification:notice=>notices.push(notice),requestReload:job=>reloads.push(job.id)});
  t.after(()=>manager.close());
  await assert.rejects(manager.execute({action:'start_login'},{...f.actor(),route:{...f.actor().route,sender:'mallory'}}),/主人私聊/);
  const login=await manager.execute({action:'start_login',botQQ:state.botQQ},f.actor());
  assert.equal(login.login.state,'waiting');assert.equal(login.login.delivery.messageId,'cc-qr-42');
  assert.equal(login.qrDelivery,'delivered');assert.equal(login.message,undefined);
  await manager.execute({action:'start_login'},f.actor());assert.equal(deliveries.length,1,'same operation does not send QR twice');
  assert.ok(!JSON.stringify(login).includes('fixture-token'));assert.ok(!JSON.stringify(login).includes(config.token));
  state.online=true;clock+=3100;assert.equal((await manager.execute({action:'poll'},f.actor())).login.state,'online');
  assert.equal(notices.length,1);assert.equal(existsSync(deliveries[0].filePath),false);
  assert.equal(manager.status().binding,null,'login alone never grants owner access');
  const link=await manager.execute({action:'begin_link',botQQ:state.botQQ,ownerQQ:'10000001'},f.actor('', 'link-1'));
  const event={post_type:'message',message_type:'private',self_id:20000002,user_id:10000001,message_id:9,message:link.verificationText};
  assert.equal(manager.handleEvent({...event,user_id:10000003}),false);
  assert.equal(manager.handleEvent({...event,message_type:'group'}),false);
  assert.equal(manager.handleEvent({...event,self_id:20000003}),false);
  assert.equal(manager.handleEvent(event),true);assert.equal(manager.handleEvent(event),false);
  await assert.rejects(manager.execute({action:'confirm_link',confirm:true},f.actor('继续','link-confirm')),/明确发送/);
  const changed=await manager.execute({action:'confirm_link',confirm:true},f.actor('确认关联 10000001','link-confirm'));
  assert.equal(changed.change.state,'queued');assert.equal(f.nativeConfig.enabled,false);
  await manager.afterTurn('other-session');assert.equal(reloads.length,0);
  await manager.afterTurn('cc-session');await manager.afterTurn('cc-session');assert.equal(reloads.length,1);
  assert.ok(!JSON.stringify(changed).includes(onebot.token));
});

test('a retrieved QR does not imply a successful send', async t => {
  const f=fixture(t),{config}=await loginServer(t);
  f.options.qq.gateway=config;
  let receipt;
  const manager=createQQConnection(f.options,{
    mediaSender:()=>({async send(){return receipt;}}),
  });
  t.after(()=>manager.close());
  for(const [response,expected] of [
    [{state:'failed'},'send-failed'],
    [{state:'uncertain'},'unconfirmed'],
    [{state:'confirmed'},'unconfirmed'],
  ]) {
    receipt=response;
    const result=await manager.execute({action:'start_login'},f.actor('',`receipt-${response.state}`));
    assert.equal(result.qrDelivery,expected);
    assert.equal(result.ok,false);
    assert.equal(result.login.delivery.messageId,undefined);
    assert.equal(result.message,undefined);
  }
});

test('offline owner transition migrates original SQLite metadata, keeps native history and receipts, and resumes once',t=>{
  const f=fixture(t),root=f.options.dataDir,id='change-one';
  const storage=createMemoryStorage({directory:()=>join(root,'aurabot')});
  storage.save({items:[{id:'tea',text:'主人喜欢茶',about:'1',speaker:'1',chatId:'private:1'}],
    profiles:{1:{name:'主人'}},insights:{'qq:1':[{text:'耐心'}]},styles:{'qq:1':['温和']},
    processed:{'2026-11-18':{chats:{'private:1':4}}}});storage.close();
  const oldFingerprint=hash(f.options.owners.map(senderKey).sort());
  writeState(join(root,'runtime.json'),{instanceId:f.options.instanceId,ownersFingerprint:oldFingerprint,sharedMemoryOwnerId:'1',
    outbox:{qq:{state:'pending',route:{channel:'qq'}},unknown:{state:'uncertain',route:{channel:'qq'}},cc:{state:'confirmed',messageId:'kept'}}});
  mkdirSync(join(root,'aurabot/chatlog'),{recursive:true});
  writeFileSync(join(root,'aurabot/chatlog/2026-11-18.jsonl'),JSON.stringify({uid:'1',who:'主人',chatId:'private:1',text:'原文1 private:1必须保留'})+'\n');
  writeState(join(root,'aurabot/sessions.json'),{chats:{'private:12345':{sessionId:'qq-old'}}});
  writeState(join(root,'native-session.json'),{raw:'private:1 QQ_HISTORY_CANARY'});
  writeState(qqManagementFile(f.options),{schema:1,instanceId:f.options.instanceId,transition:{id,state:'queued',action:'link',
    instanceId:f.options.instanceId,actor:f.actor().route,configPath:f.configPath,beforeFingerprint:oldFingerprint,
    previousOwnerId:'1',ownerQQ:'10000001',botQQ:'20000002',onebot:{wsUrl:'ws://127.0.0.1:1234',httpToken:'operator-only'}}});
  applyQQTransition(f.options,f.configPath);
  applyQQTransition(f.options,f.configPath);
  const migrated=storage.load();storage.close();
  assert.equal(migrated.items[0].about,'10000001');assert.equal(migrated.items[0].speaker,'10000001');
  assert.ok(migrated.profiles['10000001']);assert.ok(migrated.insights['qq:10000001']);
  assert.equal(migrated.processed['2026-11-18'].chats['private:10000001'],4);
  const runtime=readState(join(root,'runtime.json'));assert.equal(runtime.outbox.qq.state,'suppressed');assert.equal(runtime.outbox.unknown.state,'uncertain');assert.equal(runtime.outbox.cc.messageId,'kept');
  assert.equal(readState(join(root,'native-session.json')).raw,'private:1 QQ_HISTORY_CANARY');
  assert.equal(JSON.parse(readFileSync(join(root,'aurabot/chatlog/2026-11-18.jsonl'))).text,'原文1 private:1必须保留');
  assert.equal(readState(join(root,'aurabot/sessions.json')).chats['private:12345'],undefined);
  Object.assign(f.nativeConfig,readState(join(root,'aurabot/config.json')));
  finishQQTransition(f.options,f.native);assert.equal(f.native.started,true);
  assert.equal(readState(qqManagementFile(f.options)).transition.state,'confirmed');
  assert.equal(applyQQTransition(f.options,f.configPath),null);
});

test('transition refuses live writer and recovers failed boot without erasing later memory or unknown receipts',t=>{
  const f=fixture(t),file=qqManagementFile(f.options),id='recover-one',fp=hash(f.options.owners.map(senderKey).sort());
  writeState(file,{schema:1,instanceId:f.options.instanceId,transition:{id,state:'queued',action:'link',actor:f.actor().route,
    instanceId:f.options.instanceId,configPath:f.configPath,beforeFingerprint:fp,previousOwnerId:'1',ownerQQ:'10000001',botQQ:'20000002',onebot:{}}});
  writeState(join(f.options.dataDir,'runtime.lock'),{pid:process.pid,hostname:hostname()});
  assert.throws(()=>applyQQTransition(f.options,f.configPath),/旧DSH/);
  rmSync(join(f.options.dataDir,'runtime.lock'));
  applyQQTransition(f.options,f.configPath);
  const storage=createMemoryStorage({directory:()=>join(f.options.dataDir,'aurabot')}),raw=storage.load();
  raw.items.push({id:'later',text:'恢复时保留新增数据',about:'10000001'});storage.save(raw);storage.close();
  writeState(join(f.options.dataDir,'runtime.json'),{ownersFingerprint:hash(f.options.owners.map(senderKey).sort()),outbox:{u:{state:'uncertain',messageId:'unknown'}}});
  recoverQQTransition(f.options,f.configPath);
  const kept=storage.load();storage.close();assert.equal(kept.items.find(x=>x.id==='later').text,'恢复时保留新增数据');
  assert.equal(kept.items.find(x=>x.id==='later').about,'1');assert.equal(f.options.qq.enabled,false);
  assert.equal(readState(join(f.options.dataDir,'runtime.json')).outbox.u.state,'uncertain');
  assert.equal(readState(file).transition.state,'failed');
});

test('Core reload uses only the current plugin and binding; timeout remains uncertain and is not retried',async t=>{
  const f=fixture(t),file=qqManagementFile(f.options),id='reload-one';
  const coreFile=f.options.clawchat.delivery.configPath;
  writeState(coreFile,{agents:{'local-agent':{runtime:{pluginId:'whalenest.runtime.deepseek-harness'},runtimeConfig:{instancePath:f.configPath}}}});
  writeState(join(f.root,'connect/plugins.lock.json'),{plugins:{'whalenest.runtime.deepseek-harness':{status:'active',installationConfiguration:{},capabilityConfigurations:{}}}});
  writeState(file,{schema:1,instanceId:f.options.instanceId,transition:{id,state:'queued',actor:f.actor().route,instanceId:f.options.instanceId,configPath:f.configPath}});
  let requests=0;
  await reloadQQConnection(f.configPath,id,{fetchImpl:async(url,init)=>{
    requests++;assert.match(url,/127\.0\.0\.1:47822.*configure$/);
    assert.equal(init.headers['X-ClawChat-Connect-Core-Config-Path'],coreFile);
    assert.deepEqual(Object.keys(JSON.parse(init.body).runtimeConfigurations),['local-agent']);
    throw Error('uncertain-network');
  }});
  assert.equal(readState(file).transition.reloadState,'uncertain');
  await reloadQQConnection(f.configPath,id,{fetchImpl:()=>{requests++;}});assert.equal(requests,1);
});
