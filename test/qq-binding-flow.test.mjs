import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQQConnection} from '../src/qq-connection.mjs';
import {qqManagementFile} from '../src/qq-transition.mjs';
import {readState,writeState} from '../src/state.mjs';
import {extendRuntimeEntry} from '../src/runtime-extension.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'whalenest-binding-flow-'));let clock=100000,identity='20000002',readyGate;
 const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'dm'};
 const options={instanceId:'binding-flow',dataDir:join(root,'data'),cwd:root,owners:[route],clawchat:{route},qq:{enabled:false,gateway:{type:'llbot',url:'http://127.0.0.1:3080',token:'fixture-only-password',onebot:{wsUrl:'ws://127.0.0.1:3001'}}}};
 const config={enabled:false,ownerQQ:'1',botQQ:'20000002'},native={getConfig:()=>config,onebot:{state:'stopped'},qqConnectionState:()=>({verified:true})};
 const notices=[];const manager=createQQConnection(options,{configPath:join(root,'instance.json'),getNative:()=>native,now:()=>clock,queueNotification:n=>notices.push(n),
  fetchImpl:async()=>new Response(JSON.stringify({success:true,data:{online:true,uin:'20000002'}})),
  makeOneBot:cfg=>({start(){queueMicrotask(()=>cfg.onState('connected'));},stop(){},async call(){if(readyGate)await readyGate;return {user_id:identity};}})});
 t.after(async()=>{await manager.close();rmSync(root,{recursive:true,force:true});});
 const actor=(operationId,text='')=>({route,sessionId:'session',operationId,text});
 const begin=(id,extra={})=>manager.execute({action:'begin_link',botQQ:'20000002',ownerQQ:'10000001',...extra},actor(id,'绑定我的QQ 10000001'));
 const event=code=>({post_type:'message',message_type:'private',self_id:20000002,user_id:10000001,message_id:1,message:code});
 return {root,options,config,native,notices,manager,actor,begin,event,advance:n=>clock+=n,identity:v=>identity=v,gate:v=>readyGate=v};
}

test('binding starts its five-minute window after verified readiness, and failed preparation never waits for user input',async t=>{
 const f=fixture(t);let release;f.gate(new Promise(r=>release=r));const pending=f.begin('prepare');
 while(!readState(qqManagementFile(f.options),{}).challenge)await new Promise(r=>setImmediate(r));
 const preparing=f.manager.status().association.state;f.advance(4000);release();const started=await pending;
 assert.equal(preparing,'preparing');
 assert.equal(started.association.expiresAt,404000);assert.equal(started.association.remainingSeconds,300);assert.match(started.verificationText,/^鲸栖关联 [0-9a-f]{32}$/);assert.equal(started.confirmationRequired,'确认关联 10000001');
 f.advance(300001);f.identity('20000003');await assert.rejects(f.begin('bad-preparation'));
 assert.equal(f.manager.status().association.state,'failed');
});

test('duplicate binding requests preserve a valid code; only an explicit regeneration can replace it',async t=>{
 const f=fixture(t),first=await f.begin('first'),again=await f.begin('second');
 assert.equal(again.association.id,first.association.id);assert.equal(again.verificationReused,true);assert.equal(again.verificationText,undefined);
 const fresh=await f.manager.execute({action:'begin_link',ownerQQ:'10000001',restart:true},f.actor('regenerate','重新生成绑定验证码'));
 assert.notEqual(fresh.association.id,first.association.id);assert.equal(fresh.verificationReplaced,true);
 assert.equal(f.manager.handleEvent(f.event(first.verificationText)),false);assert.equal(f.manager.handleEvent(f.event(fresh.verificationText)),true);
});

test('QQ proof and expiration are reported automatically once, including after a restart; reasons stay distinct',async t=>{
 const f=fixture(t),first=await f.begin('proof');
 await assert.rejects(f.manager.execute({action:'confirm_link',confirm:true},f.actor('early','确认关联 10000001')),/尚未收到/);
 assert.equal(f.manager.handleEvent(f.event(first.verificationText)),true);
 await f.manager.execute({action:'poll'},f.actor('check'));
 assert.equal(f.notices.filter(n=>/验证通过/.test(n.text)).length,1);assert.match(f.notices[0].text,/确认关联 10000001/);
 await f.manager.execute({action:'poll'},f.actor('repeat'));assert.equal(f.notices.length,1);
 f.advance(300001);await f.manager.execute({action:'poll'},f.actor('expired'));
 assert.equal(f.manager.status().association.state,'expired');assert.match(f.notices.at(-1).text,/已过期/);
 await assert.rejects(f.manager.execute({action:'confirm_link',confirm:true},f.actor('late','确认关联 10000001')),/已过期/);
 const restarted=await f.begin('new-after-expiry');assert.notEqual(restarted.association.id,first.association.id);assert.equal(restarted.verificationReplaced,true);
 f.manager.runtimeReady();await f.manager.execute({action:'poll'},f.actor('restart-check'));
 assert.equal(f.manager.status().association.state,'interrupted');assert.match(f.notices.at(-1).text,/中断/);
});

test('binding completion is announced only after the native channel verifies the linked account, once across restart',async t=>{
 const f=fixture(t);f.options.owners.push({channel:'qq',account:'20000002',sender:'10000001'});f.options.qq.enabled=true;f.config.enabled=true;
 const management={schema:1,instanceId:f.options.instanceId,transition:{id:'complete-once',state:'confirmed',action:'link',enableQQ:true,botQQ:'20000002',ownerQQ:'10000001',completedAt:new Date(100000).toISOString(),reloadState:'accepted-awaiting-runtime'}};
 writeState(qqManagementFile(f.options),management);f.manager.runtimeReady();await f.manager.execute({action:'poll'},f.actor('connecting'));assert.equal(f.notices.length,0);
 f.native.onebot.state='connected';await f.manager.execute({action:'poll'},f.actor('ready'));
 assert.equal(f.notices.length,1);assert.match(f.notices[0].text,/QQ已连接/);assert.equal(f.manager.status().change.reload,'applied');
 f.manager.runtimeReady();await f.manager.execute({action:'poll'},f.actor('restart'));assert.equal(f.notices.length,1);
});

test('duplicate confirmations during application do not stage a second change',async t=>{
 const f=fixture(t);writeState(qqManagementFile(f.options),{schema:1,instanceId:f.options.instanceId,transition:{id:'applying-once',state:'queued',action:'link'}});
 for(const action of ['confirm_link','begin_link']) {
  const result=await f.manager.execute({action,ownerQQ:'10000001',confirm:true},f.actor('duplicate-'+action,'确认关联 10000001'));
  assert.equal(result.change.id,'applying-once');assert.equal(result.change.state,'queued');
 }
});

test('a slow channel reports a bounded wait and later readiness, without timing out immediately on SDK restart',async t=>{
 const f=fixture(t);f.options.owners.push({channel:'qq',account:'20000002',sender:'10000001'});f.options.qq.enabled=true;f.config.enabled=true;f.native.onebot.state='connected';f.native.qqConnectionState=()=>({verified:false});
 writeState(qqManagementFile(f.options),{schema:1,instanceId:f.options.instanceId,transition:{id:'slow-ready',state:'confirmed',action:'link',botQQ:'20000002',ownerQQ:'10000001',completedAt:new Date(0).toISOString()}});
 await f.manager.execute({action:'poll'},f.actor('begin-watch'));assert.equal(f.notices.length,0);
 f.advance(60001);await f.manager.execute({action:'poll'},f.actor('bounded-wait'));assert.equal(f.notices.length,1);assert.match(f.notices[0].text,/暂未核实成功/);
 f.native.qqConnectionState=()=>({verified:true});await f.manager.execute({action:'poll'},f.actor('late-ready'));assert.equal(f.notices.length,2);assert.match(f.notices[1].text,/QQ已连接/);
});

test('management replies keep the model wording and attach the original verification and confirmation text once',async t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-binding-output-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'companion/aurabot-v1'),{recursive:true});writeFileSync(join(root,'companion/aurabot-v1/instance.json'),JSON.stringify({dataDir:root,clawchat:{route:{account:'agent',conversation:'dm'}},expressions:{enabled:false}}));
 const fact='旧版本显示的固定提示。';
 const verificationText='鲸栖关联 1234567890abcdef1234567890abcdef',confirmationRequired='确认关联 10000001';
 const modelReply='用你自己的 QQ 把这句发给我，然后回来确认。两步都请在五分钟内完成。';
 let registered;
 const base={activate:async ctx=>ctx.hostCapabilities.get('runtime-provider').register({create:()=>({start:async()=>({async *prompt(input){
  const source=['history','legacy'].includes(input.prompt)?'history':'live';
  yield {id:'call',position:'1.0',kind:'tool',source,text:'companion_qq',data:{name:'companion_qq',nativeType:'tool/call'}};
  const data=input.prompt==='legacy'?{ok:true,userMessage:fact}:{ok:true,action:'begin_link',verificationText,confirmationRequired};
  yield {id:'call',position:'1.0',kind:'tool',source,text:JSON.stringify(data),data:{name:'companion_qq',nativeType:'tool/result'}};
  yield {id:'answer',position:'2.1',kind:'assistant',source,text:modelReply,data:{outputKind:'assistant'}};
  yield {id:'answer',position:'2.1',kind:'assistant',source,text:modelReply,data:{outputKind:'final'}};
  if(source==='history')yield {id:'ordinary',position:'3.0',kind:'assistant',source:'live',text:'普通聊天保留人格',data:{outputKind:'final'}};
 },close:async()=>{}})})})};
 await extendRuntimeEntry(base).activate({hostCapabilities:{get:()=>({register:p=>registered=p})}});
 const adapter=registered.create({homePath:root},{}),session=await adapter.start({bindingId:'agent',chatId:'dm'});
 const result=await Array.fromAsync(session.prompt({turnId:'same-turn',prompt:'重新发了吗？'}));
 const displayed=result.findLast(a=>a.kind==='assistant').text;
 assert.ok(displayed.startsWith(modelReply));assert.equal(displayed.split(verificationText).length,2);assert.equal(displayed.split(confirmationRequired).length,2);
 const replay=await Array.fromAsync(session.prompt({turnId:'replay',prompt:'history'}));
 assert.equal(replay.find(a=>a.id==='answer').text,displayed);assert.equal(replay.findLast(a=>a.kind==='assistant').text,'普通聊天保留人格');
 const legacy=await Array.fromAsync(session.prompt({turnId:'legacy',prompt:'legacy'}));
 assert.equal(legacy.findLast(a=>a.id==='answer').text,fact,'Legacy replay keeps the text previously shown to the user');
});
