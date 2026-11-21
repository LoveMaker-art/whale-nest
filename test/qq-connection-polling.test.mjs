import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createQQConnection} from '../src/qq-connection.mjs';

test('one slow background login check cannot queue repeated checks ahead of an owner status request',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-qq-poll-'));
 const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'poll',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route},qq:{gateway:{type:'llbot',url:'http://127.0.0.1:3080',token:'private-token'}}};
 let slow=false,slowCalls=0;const gates=[];
 const manager=createQQConnection(options,{fetchImpl:async url=>{
  const login=new URL(url).pathname==='/api/login-info';
  if(login&&slow){slowCalls++;await new Promise(resolve=>gates.push(resolve));}
  return new Response(JSON.stringify({success:true,data:login?{online:false}:{qrcodeUrl:'https://ssl.ptlogin2.qq.com/poll-fixture'}}));
 },mediaSender:()=>({send:async()=>({state:'confirmed',messageId:'poll-fixture'})})});
 t.after(async()=>{slow=false;gates.forEach(resolve=>resolve());await manager.close();rmSync(root,{recursive:true,force:true});});
 const actor={route,sessionId:'original',operationId:'start'};
 await manager.execute({action:'start_login'},actor);slow=true;
 const until=Date.now()+5000;while(!gates.length&&Date.now()<until)await delay(20);assert.equal(gates.length,1);
 await delay(3200); // The second background timer fires while the first is held.
 const query=manager.execute({action:'status'},{...actor,operationId:'query'});
 gates[0]();
 const result=await Promise.race([query,delay(600).then(()=>null)]);
 assert.ok(result,'Owner status must not sit behind a backlog of background checks');
 assert.equal(slowCalls,1);
});
