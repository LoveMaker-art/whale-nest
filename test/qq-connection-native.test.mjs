import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {buildConnectBridge} from '../scripts/build-connect.mjs';
import {startMockOneBot} from '../vendor/aurabot/test/helpers/mock-onebot.js';

test('ClawChat native tools link, unlink and relink QQ while preserving the owner memory and CC Session',{timeout:90000},async t=>{
  const directory=await bridgeDirectory(),onebot=await startMockOneBot();t.after(()=>onebot.close());
  // This routing test asserts literal fallback notices. Give it an explicit
  // zero budget; the fresh default and model-written notices have separate tests.
  directory.options.activities={automatic:false,maxDailyBackgroundModelCalls:0};
  const gateway=createServer((_req,res)=>res.end(JSON.stringify({success:true,data:{selfInfo:{online:true,uin:'20000002'}}})));
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{gateway.close(r);gateway.closeAllConnections();}));
  directory.options.owners=directory.options.owners.filter(owner=>owner.channel==='clawchat');
  directory.options.qq={enabled:false,gateway:{type:'llbot',url:'http://127.0.0.1:'+gateway.address().port,token:'native-gateway-token',
    onebot:{httpUrl:onebot.httpUrl,wsUrl:onebot.wsUrl,token:onebot.token}}};
  await writeFile(directory.configPath,JSON.stringify(directory.options));
  const entry=await buildConnectBridge(join(directory.root,'bridge'));
  // Controlled Core lifecycle: record the request, then this test drains and
  // boots the actual SDK. Core's HTTP reconfigure contract has its own test.
  await copyFile(entry,join(directory.root,'bridge/base-entry.mjs'));
  await writeFile(entry,'import {appendFileSync as qqRecordReload} from "node:fs";\n'+
    'import {createEntry} from "./base-entry.mjs";\n'+
    'const bridge=createEntry({qqRequestReload:async job=>qqRecordReload('+JSON.stringify(join(directory.root,'reloads.jsonl'))+',JSON.stringify({id:job.id})+"\\n")});\n'+
    'export const name=bridge.name;\nexport const inject=bridge.inject;\nexport const apply=bridge.apply;\n');
  directory.entryOverride=entry;
  let bridge=await bootBridge(directory);t.after(()=>bridge.close());
  const sessionId='cc-onboarding',tool=(args,text='')=>text+'\nFOUNDATION_TOOL '+JSON.stringify({name:'companion_qq',args});
  await bridge.request('create',{sessionId,whalenestChatId:'dm-alice',cwd:directory.root,model:directory.options.model});
  await bridge.turn(sessionId,'remember-before-link','FOUNDATION_TOOL '+JSON.stringify({name:'remember',args:{text:'主人喜欢茉莉茶 QQ_LINK_SHARED_FACT'}}));
  await bridge.turn(sessionId,'cc-history-before-link','CC_RAW_ONBOARDING_CANARY');
  await bridge.turn(sessionId,'begin-qq-link',tool({action:'begin_link',botQQ:'20000002',ownerQQ:'10000001'}));
  const values=[];
  function scan(value) {
    if(typeof value==='string') {try{scan(JSON.parse(value));}catch{}return;}
    if(!value||typeof value!=='object')return;
    if(value.verificationText)values.push(value.verificationText);
    for(const child of Object.values(value))scan(child);
  }
  async function latestVerification(){
    values.length=0;
    (await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).forEach(scan);
    assert.ok(values.length,'verification challenge comes from actual native tool result');
    return values.at(-1);
  }
  const firstVerification=await latestVerification();
  onebot.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,
    message_id:123,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:firstVerification}}],sender:{user_id:10000001,nickname:'主人'}});
  const stateFile=join(directory.options.dataDir,'qq-connection.json');
  await bridge.wait(async()=>JSON.parse(await readFile(stateFile)).challenge.state==='verified');
  const notices=async()=>{try{return (await readFile(join(directory.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).map(row=>row.input.text);}catch{return [];}};
  await bridge.wait(async()=>(await notices()).some(text=>text.includes('QQ身份验证通过')));
  await bridge.turn(sessionId,'confirm-link',tool({action:'confirm_link',confirm:true},'确认关联 10000001'));
  assert.equal(JSON.parse(await readFile(stateFile)).transition?.state,'queued','native URL configuration must reach the QQ management queue');
  await bridge.wait(async()=>{try{return (await readFile(join(directory.root,'reloads.jsonl'),'utf8')).includes('whalenest-qq-change-');}catch{return false;}});
  await bridge.close();bridge=await bootBridge(directory);
  await bridge.wait(async()=>(await bridge.control('nativeState')).onebotState==='connected');
  await bridge.wait(async()=>(await bridge.request('companionStatus',{})).qqConnection.verified);
  assert.equal(JSON.parse(await readFile(stateFile)).transition.state,'confirmed');
  await bridge.wait(async()=>(await notices()).some(text=>text.startsWith('QQ已连接')));
  assert.equal((await notices()).filter(text=>text.startsWith('QQ已连接')).length,1,'Verified readiness is automatically delivered once without a user status query');
  const native=await bridge.control('nativeState');assert.equal(native.modules.filter(id=>id==='memory').length,1);
  const items=(await bridge.control('memoryState')).items;assert.equal(items.find(x=>x.text.includes('QQ_LINK_SHARED_FACT')).about,'10000001');
  directory.options=JSON.parse(await readFile(join(directory.root,'bridge/instance.json')));
  await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});
  const history=await bridge.request('history',{sessionId});assert.ok(JSON.stringify(history).includes('CC_RAW_ONBOARDING_CANARY'));
  const sent=()=>onebot.calls.filter(call=>call.action==='send_private_msg');
  onebot.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:124,
    time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'请回想我的茉莉茶偏好'}}],sender:{user_id:10000001,nickname:'主人'}});
  await bridge.wait(()=>sent().length>0);
  const last=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(row=>row.messages.some(m=>m.source?.kind==='aurabot'));
  assert.ok(JSON.stringify(last).includes('QQ_LINK_SHARED_FACT'));assert.ok(!JSON.stringify(last).includes('CC_RAW_ONBOARDING_CANARY'));
  const beforeWrongBot=sent().length;
  onebot.push({post_type:'message',message_type:'private',self_id:20000003,user_id:10000001,message_id:125,
    message:[{type:'text',data:{text:'错误机器人不应进入原Hub'}}]});
  await bridge.wait(async()=>(await bridge.control('nativeState')).onebotState==='stopped');
  assert.equal(sent().length,beforeWrongBot,'account switch on an existing WS cannot impersonate the linked bot');
  await bridge.turn(sessionId,'unlink-qq',tool({action:'unlink',confirm:true},'确认解绑QQ'));
  await bridge.close();bridge=await bootBridge(directory);
  const saved=JSON.parse(await readFile(join(directory.root,'bridge/instance.json')));assert.equal(saved.owners.filter(o=>o.channel==='qq').length,0);
  assert.equal(saved.qq.enabled,false);assert.equal((await bridge.control('nativeState')).onebotState,'stopped');
  // The boot helper writes its options to disk. Carry forward the config saved by unlink.
  directory.options=saved;
  await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});
  assert.ok(JSON.stringify(await bridge.request('history',{sessionId})).includes('CC_RAW_ONBOARDING_CANARY'));
  assert.ok((await bridge.control('memoryState')).items.some(x=>x.text.includes('QQ_LINK_SHARED_FACT')));

  await bridge.turn(sessionId,'replay-old-confirmation',tool({action:'confirm_link',confirm:true},'确认关联 10000001'));
  assert.equal(JSON.parse(await readFile(stateFile)).transition.action,'unlink','A consumed proof cannot reauthorize the old QQ owner');
  await bridge.turn(sessionId,'begin-qq-relink',tool({action:'begin_link',botQQ:'20000002',ownerQQ:'10000001'}));
  const relinkVerification=await latestVerification();
  assert.notEqual(relinkVerification,firstVerification);
  onebot.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,
    message_id:126,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:relinkVerification}}],sender:{user_id:10000001,nickname:'主人'}});
  await bridge.wait(async()=>JSON.parse(await readFile(stateFile)).challenge.state==='verified');
  await bridge.turn(sessionId,'confirm-relink',tool({action:'confirm_link',confirm:true},'确认关联 10000001'));
  await bridge.close();bridge=await bootBridge(directory);
  await bridge.wait(async()=>(await bridge.request('companionStatus',{})).qqConnection.verified);
  await bridge.request('resume',{sessionId,whalenestChatId:'dm-alice'});
  assert.ok(JSON.stringify(await bridge.request('history',{sessionId})).includes('CC_RAW_ONBOARDING_CANARY'));
  const matching=(await bridge.control('memoryState')).items.filter(item=>item.text.includes('QQ_LINK_SHARED_FACT'));
  assert.equal(matching.length,1,'Reassociation keeps one copy of the approved memory');
  assert.equal(matching[0].about,'10000001');
  const beforeRecall=sent().length;
  onebot.push({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,
    message_id:127,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'重绑后请回想我的茉莉茶偏好'}}],sender:{user_id:10000001,nickname:'主人'}});
  await bridge.wait(()=>sent().length>beforeRecall);
  const relinkedTurn=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(row=>row.messages.some(m=>m.source?.kind==='aurabot'));
  assert.ok(JSON.stringify(relinkedTurn).includes('QQ_LINK_SHARED_FACT'));
});
