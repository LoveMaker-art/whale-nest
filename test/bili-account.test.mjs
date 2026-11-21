import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBiliAccount} from '../src/bili-account.mjs';

async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'whalenest-bili-account-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const route={channel:'clawchat',account:'a',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'test',dataDir,owners:[route],clawchat:{route}};let at=10000,pollCode=86101,cookies=true,login=true,calls=[];
 const fetchImpl=async(input)=>{const url=new URL(input);calls.push(url.pathname);if(url.pathname.endsWith('/generate'))return Response.json({code:0,data:{url:'https://passport.bilibili.com/test-login?key=TEST_PRIVATE_QR',qrcode_key:'TEST_PRIVATE_QR'}});
  if(url.pathname.endsWith('/poll')){const headers=new Headers();if(cookies)for(const value of ['SESSDATA=TEST_PRIVATE_SESSION','bili_jct=TEST_PRIVATE_CSRF','DedeUserID=123'])headers.append('set-cookie',value+'; Path=/; HttpOnly');return Response.json({code:0,data:{code:pollCode}},{headers});}
  assert.ok(url.pathname.endsWith('/nav'));return Response.json({code:0,data:{isLogin:login,mid:123,uname:'测试账号'}});
 };
 const deps={fetchImpl,now:()=>at};const account=createBiliAccount(options,route,deps);return {account,options,route,deps,calls,advance:n=>{at+=n;},setCode:v=>{pollCode=v;},setCookies:v=>{cookies=v;},setLogin:v=>{login=v;}};
}
test('QR state is private, bounded, persisted and verified before replacing credentials',async t=>{const f=await fixture(t);assert.equal(f.calls.length,0);const start=await f.account.start('start');assert.equal(start.state,'waiting');assert.ok(!JSON.stringify(start).includes('TEST_PRIVATE_QR'));assert.ok((await readFile(start.imagePath)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
 assert.equal((await f.account.start('start')).challengeId,start.challengeId);assert.equal(f.calls.length,1);assert.equal((await f.account.poll(start.challengeId)).state,'waiting');const n=f.calls.length;assert.ok((await f.account.poll(start.challengeId)).retryAfterMs>0);assert.equal(f.calls.length,n);
 f.advance(3100);f.setCode(86090);assert.equal((await f.account.poll(start.challengeId)).state,'scanned');f.advance(3100);f.setCode(0);const done=await f.account.poll(start.challengeId);assert.equal(done.state,'confirmed');assert.ok(!JSON.stringify(done).includes('TEST_PRIVATE_SESSION'));assert.equal(f.account.status().uid,'123');await assert.rejects(access(start.imagePath),{code:'ENOENT'});
 assert.equal((await stat(join(f.options.dataDir,'bili/account.json'))).mode&0o777,0o600);const restart=createBiliAccount(f.options,f.route,f.deps);assert.equal(restart.status().uid,'123');assert.equal((await restart.poll(start.challengeId)).state,'confirmed');assert.ok(restart.getCookie().includes('TEST_PRIVATE_SESSION'));restart.logout();assert.equal(restart.getCookie(),'');await assert.rejects(restart.poll(start.challengeId),/未知/);
});
test('missing login cookies or failed account validation never overwrites an existing identity',async t=>{const f=await fixture(t);const first=await f.account.start('first');f.setCode(0);await f.account.poll(first.challengeId);const saved=f.account.getCookie();f.advance(4000);
 const missing=await f.account.start('missing');f.setCookies(false);assert.equal((await f.account.poll(missing.challengeId)).state,'uncertain');assert.equal(f.account.getCookie(),saved);
 const unverified=await f.account.start('unverified');f.setCookies(true);f.setLogin(false);assert.equal((await f.account.poll(unverified.challengeId)).state,'unverified');assert.equal(f.account.getCookie(),saved);assert.equal(f.account.status().uid,'123');
 f.setLogin(true);assert.equal((await f.account.poll(unverified.challengeId)).state,'confirmed');
});
test('expired QR and another owner cannot continue a private login',async t=>{const f=await fixture(t),start=await f.account.start('old');f.advance(180001);const before=f.calls.length;assert.equal((await f.account.poll(start.challengeId)).state,'expired');assert.equal(f.calls.length,before);await assert.rejects(access(start.imagePath),{code:'ENOENT'});
 assert.throws(()=>createBiliAccount(f.options,{...f.route,sender:'other'},f.deps),/Owner/);assert.throws(()=>createBiliAccount(f.options,{...f.route,conversation:'different'},f.deps),/归属/);
});
test('account write journal preserves exact receipts, conflicts and unknown outcomes over restart',async t=>{const f=await fixture(t),start=await f.account.start('login');f.setCode(0);await f.account.poll(start.challengeId);let count=0;
 const input={receiver:'456',text:'测试'};const action=async()=>{count++;return {messageKey:'9223372036854775807'};};const one=await f.account.mutate({requestId:'one',kind:'message',input},action);assert.equal(one.state,'confirmed');assert.equal(one.receipt.messageKey,'9223372036854775807');await f.account.mutate({requestId:'one',kind:'message',input},action);assert.equal(count,1);
 await assert.rejects(f.account.mutate({requestId:'one',kind:'message',input:{...input,text:'changed'}},action),/冲突/);
 const lost=async()=>{count++;throw Error('timeout TEST_PRIVATE_SESSION');};assert.equal((await f.account.mutate({requestId:'lost',kind:'message',input:{...input,text:'lost'}},lost)).state,'uncertain');
 const restarted=createBiliAccount(f.options,f.route,f.deps);const held=await restarted.mutate({requestId:'different-tool-call',kind:'message',input:{...input,text:'lost'}},action);assert.equal(held.state,'uncertain');assert.equal(count,2);assert.ok(!JSON.stringify(restarted.receipts()).includes('TEST_PRIVATE_SESSION'));
});
