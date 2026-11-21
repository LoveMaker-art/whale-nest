import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQQGateway} from '../src/qq-gateway.mjs';
import {createHash} from 'node:crypto';
import {qrPng} from '../src/qr-png.mjs';
import {createQQConnection} from '../src/qq-connection.mjs';

test('SnowLuma authenticates its local console and verifies the actual OneBot identity and online state',async()=>{
 let accounts=[],online=false,loginId='20000002';const calls=[];
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-console-password',onebot:{httpUrl:'http://127.0.0.1:3000',httpToken:'private-onebot-token'}},{fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,options});
  let value;
  if(u.pathname==='/api/login'){assert.equal(JSON.parse(options.body).password,'private-console-password');value={success:true,token:'private-console-session'};}
  else if(u.pathname==='/api/qq-list'){assert.equal(options.headers['x-snowluma-token'],'private-console-session');value={list:accounts};}
  else {assert.equal(options.headers.Authorization,'Bearer private-onebot-token');assert.equal(options.headers['x-snowluma-token'],undefined);value={status:'ok',data:u.pathname==='/get_login_info'?{user_id:loginId,nickname:'验收QQ'}:{online}};}
  return new Response(JSON.stringify(value));
 }});
 assert.deepEqual(await gateway.status(),{state:'offline'});
 accounts=[{uin:'20000002',nickname:'不能仅凭列表说在线'}];assert.deepEqual(await gateway.status(),{state:'reconnecting'});
 online=true;assert.deepEqual(await gateway.status(),{state:'online',botQQ:'20000002',name:'验收QQ'});
 loginId='20000003';await assert.rejects(gateway.status(),/身份/);
 accounts.push({uin:'20000004'});await assert.rejects(gateway.status(),/多个/);
 assert.equal(calls.filter(c=>c.url.endsWith('/api/login')).length,1);
 await assert.rejects(gateway.logout(),/退出接口/);
});

test('SnowLuma uses only a fresh QQ-client QR snapshot and does not pretend an unchanged code was refreshed',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-snow-qr-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const qrFile=join(root,'qr.json');let now=100000;
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile},{now:()=>now,fetchImpl:()=>{throw Error('QR comes from the prepared local QQ client');}});
 writeFileSync(qrFile,JSON.stringify({url:'https://ntqqlogin.qq.com/qr/valid-test',updatedAt:now}));
 assert.equal((await gateway.qr()).state,'waiting');await assert.rejects(gateway.qr({refresh:true}),/尚未更新/);
 now+=31000;await assert.rejects(gateway.qr(),/过期/);
 writeFileSync(qrFile,JSON.stringify({url:'https://qq.com.attacker.test/qr',updatedAt:now}));await assert.rejects(gateway.qr(),/来源/);
 writeFileSync(qrFile,'x'.repeat(9000));await assert.rejects(gateway.qr(),/过大/);
});

test('SnowLuma renews an expired console session once for account lookup after a managed restart',async()=>{
 let logins=0,reads=0;
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password'},{fetchImpl:async url=>{
  if(new URL(url).pathname==='/api/login')return new Response(JSON.stringify({success:true,token:'session-'+ ++logins}));
  reads++;
  return reads===2 ? new Response('{}',{status:401}) : new Response(JSON.stringify({list:[]}));
 }});
 assert.equal((await gateway.status()).state,'offline');
 assert.equal((await gateway.status()).state,'offline');
 assert.equal(logins,2);assert.equal(reads,3);
});

test('SnowLuma reuses a currently rendered code without requesting a desktop restart, and reports native expiry',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-fast-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const qrFile=join(root,'qr.json'),requestFile=join(root,'request.json'),statusFile=join(root,'status.json'),now=100000;
 const image=qrPng('https://ssl.ptlogin2.qq.com/fast-fixture'),imageSha256=createHash('sha256').update(image).digest('hex');
 writeFileSync(join(root,'qr.png'),image);writeFileSync(qrFile,JSON.stringify({phase:'waiting',imageSha256,updatedAt:now}));
 writeFileSync(statusFile,JSON.stringify({state:'waiting',updatedAt:now}));
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile,loginRequestFile:requestFile},
  {now:()=>now,fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/api/login'?{success:true,token:'private-session'}:{list:[]}))});
 const first=await gateway.qr();assert.deepEqual(first.image,image);assert.equal(first.reused,true);assert.equal(existsSync(requestFile),false);
 writeFileSync(statusFile,JSON.stringify({state:'wide-saved-account',updatedAt:now}));
 assert.equal((await gateway.status()).state,'offline','A saved account page does not display a scannable code');
 writeFileSync(statusFile,JSON.stringify({state:'expired',updatedAt:now}));assert.equal((await gateway.status()).state,'expired');
 writeFileSync(statusFile,JSON.stringify({state:'expired',updatedAt:now-11000}));assert.equal((await gateway.status()).state,'offline','Stale UI cannot determine current authentication state');
});

test('QQ login sends one captured login dialog and automatically reports a later verified account without linking it',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-attention-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=100000,online=false;
 const qrFile=join(root,'qr.json'),image=qrPng('https://ssl.ptlogin2.qq.com/dialog-fixture'),digest=createHash('sha256').update(image).digest('hex');
 writeFileSync(join(root,'qr.png'),image);writeFileSync(qrFile,JSON.stringify({imageSha256:digest,updatedAt:now}));
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'},notices=[],deliveries=[];
 const options={instanceId:'attention',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route},qq:{gateway:{type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile,onebot:{httpUrl:'http://127.0.0.1:3000'}}}};
 const manager=createQQConnection(options,{now:()=>now,queueNotification:value=>notices.push(value),fetchImpl:async url=>{
  const path=new URL(url).pathname;
  return new Response(JSON.stringify(path==='/api/login'?{success:true,token:'private-session'}:path==='/api/qq-list'?{list:online?[{uin:'20000002'}]:[]}:{status:'ok',data:path==='/get_login_info'?{user_id:'20000002',nickname:'fixture'}:{online:true}}));
 },mediaSender:()=>({send:async input=>{deliveries.push(input);assert.deepEqual(readFileSync(input.filePath),image);return {state:'confirmed',messageId:'fixture-'+deliveries.length};}})});
 t.after(()=>manager.close());const actor={route,sessionId:'original-session',operationId:'attention-once'};
 await manager.execute({action:'start_login'},actor);
 writeFileSync(join(root,'attention.png'),image);now+=3100;writeFileSync(join(root,'status.json'),JSON.stringify({state:'attention-required',updatedAt:now,attentionSha256:digest}));
 let status=await manager.execute({action:'poll'},actor);assert.equal(status.login.state,'attention-required');assert.equal(notices.length,1);assert.equal(deliveries.length,2);
 assert.equal(JSON.stringify(status).includes('imageSha256'),false);
 now+=3100;await manager.execute({action:'poll'},actor);assert.equal(deliveries.length,2);assert.equal(notices.length,1);
 online=true;now+=3100;status=await manager.execute({action:'poll'},actor);assert.equal(status.login.state,'online');assert.equal(status.login.botQQ,'20000002');assert.equal(notices.length,2);assert.equal(status.binding,null);
});

test('a QQ refresh error is reported as preparation failure without claiming an image was sent',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-prepare-fail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const requestFile=join(root,'request.json'),qrFile=join(root,'qr.json');
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'prepare-fail',dataDir:join(root,'data'),cwd:root,owners:[route],clawchat:{route},qq:{gateway:{type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile,loginRequestFile:requestFile}}};
 let sends=0;
 const manager=createQQConnection(options,{fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/api/login'?{success:true,token:'private-session'}:{list:[]})),mediaSender:()=>({send:async()=>{sends++;throw Error('must not send');}})});
 t.after(()=>manager.close());
 const timer=setInterval(()=>{if(existsSync(requestFile)){const req=JSON.parse(readFileSync(requestFile));writeFileSync(qrFile,JSON.stringify({requestId:req.id,error:'refresh-failed',updatedAt:Date.now()}));}},20);
 try {
  const result=await manager.execute({action:'start_login'},{route,sessionId:'original',operationId:'prepare-fail'});
  assert.equal(result.ok,false);assert.equal(result.login.failureStage,'qr-preparation');assert.equal(result.login.delivery.state,'not-submitted');assert.equal(sends,0);assert.equal(result.qrDelivery,'preparation-failed');
 } finally {clearInterval(timer);}
});

test('SnowLuma accepts an authenticated local PNG snapshot without decoding or regenerating the QQ code',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-snow-image-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const qrFile=join(root,'qr.json'),image=qrPng('https://ssl.ptlogin2.qq.com/test-only');
 const imageSha256=createHash('sha256').update(image).digest('hex'),now=100000;
 writeFileSync(join(root,'qr.png'),image);writeFileSync(qrFile,JSON.stringify({imageSha256,updatedAt:now}));
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile},{now:()=>now});
 assert.deepEqual((await gateway.qr()).image,image);
 await assert.rejects(gateway.qr({refresh:true}),/尚未更新/);
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'snow-image',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route},qq:{gateway:{type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile}}};
 let deliveries=0;
 const connection=createQQConnection(options,{now:()=>now,
  fetchImpl:async url=>new Response(JSON.stringify(String(url).endsWith('/api/login')?{success:true,token:'local-session'}:{list:[]})),
  mediaSender:()=>({send:async ({filePath})=>{assert.deepEqual(readFileSync(filePath),image);deliveries++;return {state:'confirmed',messageId:'cc-real-path-fixture'};}})});
 t.after(()=>connection.close());
 const result=await connection.execute({action:'start_login'},{route,sessionId:'session',operationId:'login-image'});
 assert.equal(result.login.delivery.state,'confirmed');assert.equal(deliveries,1);
 const requestFile=join(root,'request.json');
 const refreshed=createQQGateway({...options.qq.gateway,loginRequestFile:requestFile},{now:()=>now});
 const timer=setInterval(()=>{
  if(existsSync(requestFile)) {
   const request=JSON.parse(readFileSync(requestFile));
   writeFileSync(qrFile,JSON.stringify({imageSha256,updatedAt:now,requestId:request.id}));
  }
 },20);
 try {assert.deepEqual((await refreshed.qr()).image,image);}finally{clearInterval(timer);}
 writeFileSync(join(root,'qr.png'),Buffer.from('not-the-recorded-code'));
 await assert.rejects(gateway.qr(),/快照/);
});

test('scanned, restriction and online races resolve without waiting for a nonexistent QR; account checks remain authoritative',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-phase-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const qrFile=join(root,'qr.json'),requestFile=join(root,'request.json');let phase='scanned';
 const gateway=createQQGateway({type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile,loginRequestFile:requestFile},
  {fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/api/login'?{success:true,token:'private-session'}:{list:[]}))});
 const timer=setInterval(()=>{if(existsSync(requestFile)) {const req=JSON.parse(readFileSync(requestFile));writeFileSync(qrFile,JSON.stringify({requestId:req.id,phase,updatedAt:Date.now()}));}},20);
 try {
  for(phase of ['scanned','security-restricted','attention-required']) {
   assert.deepEqual(await gateway.qr(),{state:phase});
   writeFileSync(join(root,'status.json'),JSON.stringify({state:phase,updatedAt:Date.now()}));
   assert.equal((await gateway.status()).state,phase);
  }
  phase='online';rmSync(join(root,'status.json'));assert.equal((await gateway.qr()).state,'offline','A UI online reply without an account never proves successful login');
 } finally {clearInterval(timer);}
});

test('a restriction survives the local timeout, notifies once and recovers only on an explicit new request',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-restriction-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let clock=100000;const notices=[],requests=[];
 const qrFile=join(root,'qr.json'),requestFile=join(root,'request.json'),statusFile=join(root,'status.json');
 const image=qrPng('https://ssl.ptlogin2.qq.com/restriction-fixture');writeFileSync(join(root,'qr.png'),image);
 writeFileSync(qrFile,JSON.stringify({imageSha256:createHash('sha256').update(image).digest('hex'),updatedAt:clock}));
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'restriction',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route},qq:{gateway:{type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile,onebot:{httpUrl:'http://127.0.0.1:3000'}}}};
 let images=0;
 const dependencies={now:()=>clock,queueNotification:v=>notices.push(v),fetchImpl:async url=>{
  const path=new URL(url).pathname;
  return new Response(JSON.stringify(path==='/api/login'?{success:true,token:'private-session'}:{list:[]}));
 },mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'fixture-'+ ++images})})};
 const manager=createQQConnection(options,dependencies);t.after(()=>manager.close());
 const actor={route,sessionId:'original',operationId:'first'};await manager.execute({action:'start_login'},actor);
 clock+=300001;writeFileSync(statusFile,JSON.stringify({state:'security-restricted',updatedAt:clock}));
 let status=await manager.execute({action:'poll'},actor);assert.equal(status.login.state,'security-restricted');assert.equal(notices.length,1);assert.match(notices[0].text,/安全风险/);
 clock+=3100;writeFileSync(statusFile,JSON.stringify({state:'security-restricted',updatedAt:clock}));await manager.execute({action:'poll'},actor);
 assert.equal(notices.length,1);assert.equal(images,1);assert.equal(existsSync(requestFile),false,'Polling a restriction never creates a login request');
 options.qq.gateway.loginRequestFile=requestFile;
 // Use the same controller after a restart, as on a real plugin update.
 await manager.close();
 const resumed=createQQConnection(options,dependencies);t.after(()=>resumed.close());
 const timer=setInterval(()=>{if(existsSync(requestFile)){const req=JSON.parse(readFileSync(requestFile));requests.push(req.id);writeFileSync(qrFile,JSON.stringify({requestId:req.id,phase:'scanned',updatedAt:clock}));}},20);
 try {
  status=await resumed.execute({action:'start_login'},{...actor,operationId:'explicit-retry'});
  assert.equal(status.login.state,'scanned');assert.equal(status.qrDelivery,undefined);assert.ok(requests.length);
 }finally{clearInterval(timer);}
 assert.equal(images,1,'A phone confirmation response never sends a fake QR image');
});

test('a saved login page that needs attention cannot report a QR delivery',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-no-code-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const at=100000, qrFile=join(root,'qr.json');
 writeFileSync(qrFile,JSON.stringify({phase:'attention-required',updatedAt:at}));
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'no-code',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route},
  qq:{gateway:{type:'snowluma',url:'http://127.0.0.1:5099',token:'private-password',loginQrFile:qrFile}}};
 const manager=createQQConnection(options,{now:()=>at,
  fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/api/login'?{token:'private-session'}:{list:[]})),
  mediaSender:()=>{assert.fail('No media should be submitted when no QR was produced');}});
 t.after(()=>manager.close());
 const result=await manager.execute({action:'start_login'},{route,sessionId:'original',operationId:'no-qr'});
 assert.equal(result.ok,false);
 assert.equal(result.qrDelivery,'preparation-failed');
 assert.equal(result.login.state,'attention-required');
 assert.equal(result.login.delivery.state,'not-submitted');
});
