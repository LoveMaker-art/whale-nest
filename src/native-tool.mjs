import assert from 'node:assert/strict';

export function nativeTurnSource(session){
 for(let n=session.seq;n>=0;n--){const event=session.eventAt(n);if(event?.type!=='user/message')continue;
  const source=(event.data.message??event.data).source;if(['user','schedule','aurabot'].includes(source?.kind))return source;
 }return null;
}

export function nativeOperationId(ctx){
 assert.ok(ctx?.callId&&ctx.agent?.session,'Native tool identity required');const session=ctx.agent.session;
 for(let n=session.seq;n>=0;n--){const event=session.eventAt(n),message=event?.data?.message;
  if(event?.type==='assistant/message'&&message?.content?.some(b=>b.type==='tool-call'&&String(b.id)===String(ctx.rootCallId??ctx.callId)))return String(message.id)+':'+String(ctx.callId);
 }throw Error('Persisted native tool call required');
}
export function requireManualOwnerTurn(ctx){
 assert.ok(ctx?.agent?.session,'Native session required');const session=ctx.agent.session;
 for(let n=session.seq;n>=0;n--){const event=session.eventAt(n);
  if(event?.type==='user/message'){const message=event.data.message??event.data,source=message.source;
   if(source?.kind==='aurabot'){
    assert.ok(!source.taskId,'后台任务不可作为主人手动授权');
    assert.ok(source.speaker?.role==='owner'&&source.speaker?.chat==='private','账号操作仅允许主人当前手动私聊请求');return;
   }
   if(!['user','schedule'].includes(source?.kind))continue;assert.equal(source.kind,'user','账号操作仅允许主人当前手动请求，后台任务不可执行');return;}
 }throw Error('需要主人当前手动请求');
}
