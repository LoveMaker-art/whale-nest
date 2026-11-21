import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createReplyNarrator} from '../src/reply-notice.mjs';

function setup(stream, disabled=false, firstBinding=false) {
  const calls=[];
  const llm={stream(options){calls.push(options);return stream(options);}};
  const reservations=[];
  const policy={
    maintenanceReason:()=>disabled?'background-model-disabled':null,
    backgroundPressure:()=>false,
    reserveNotice(){reservations.push('reserved');return 'one';},
    settle(id,result){assert.equal(id,'one');reservations.push(result);},
  };
  const narrate=createReplyNarrator({get:()=>llm},{policy,getConfig:()=>({model:{provider:'fixture',model:'test'}}),getPersona:()=>({name:'大肥鱼',body:'当前人格'}),firstBinding});
  return {calls,reservations,narrate};
}

const result={kind:'qq-binding:verified',facts:'已验证，需要主人按程序提供的口令确认。',
  commands:['确认关联 10000001'],appendix:'外部原文',fallback:'QQ身份验证通过。请确认关联。'};

test('first greeting uses the current voice even when recurring background model calls are off',async()=>{
  const {narrate,calls,reservations}=setup(async function *(){
    yield {type:'text-delta',text:'我是大肥鱼呀\n今天想聊点什么'};
    yield {type:'finish',reason:{kind:'stop'}};
  },true,true);
  assert.equal(await narrate({kind:'first-binding',fallback:'固定兜底'}),'我是大肥鱼呀 今天想聊点什么');
  assert.equal(calls.length,1);
  assert.deepEqual(reservations,[]);
});

test('notice narration sends only facts to a tool-free model, then appends literal content',async()=>{
  const {narrate,calls,reservations}=setup(async function *(){
    yield {type:'text-delta',text:'验证过啦，回来确认一下吧。'};
    yield {type:'usage',usage:{inputTokens:13,outputTokens:21}};
    yield {type:'finish',reason:{kind:'stop'}};
  });
  assert.equal(await narrate(result),'验证过啦，回来确认一下吧。\n\n```\n确认关联 10000001\n```\n\n外部原文');
  assert.match(calls[0].system,/当前人格/);
  assert.equal(calls[0].tools,undefined);
  assert.doesNotMatch(JSON.stringify(calls[0].messages),/10000001|外部原文/);
  assert.deepEqual(reservations,['reserved',{complete:true,usage:{inputTokens:13,outputTokens:21}}]);
});

test('a blocked, failed, late or unusable model answer keeps the necessary facts and commands',async()=>{
  const expected='QQ身份验证通过。请确认关联。\n\n```\n确认关联 10000001\n```\n\n外部原文';
  const disabled=setup(()=>{throw Error('should not call');},true);
  assert.equal(await disabled.narrate(result),expected);
  assert.equal(disabled.calls.length,0);
  const failed=setup(async function *(){throw Error('private transport error');});
  assert.equal(await failed.narrate(result),expected);
  assert.equal(failed.reservations[1].complete,false);
  const delayed=setup(async function *({signal}){
    await delay(30,undefined,{signal});
    yield {type:'text-delta',text:'这条提示已经迟到了'};
    yield {type:'finish',reason:{kind:'stop'}};
  });
  assert.equal(await delayed.narrate(result,{timeout:5}),expected);
  assert.equal(delayed.calls[0].signal.aborted,true);
  const unsuitable=setup(async function *(){
    yield {type:'text-delta',text:'{"qrDelivery":"unconfirmed"}'};
    yield {type:'finish',reason:{kind:'stop'}};
  });
  assert.equal(await unsuitable.narrate(result),expected);
});
