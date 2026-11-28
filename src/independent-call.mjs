import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readState,writeState} from './state.mjs';
import {requireCurrentInstanceBinding} from './instance-binding.mjs';
/** One dedicated voice thread per verified identity; no private-chat history or Core handles. */
export function independentCall(adapter,options,serial){
 const route=options.clawchat.route,scope=createHash('sha256').update(JSON.stringify([options.instanceId,route])).digest('hex');
 const file=join(options.dataDir,'realtime/sessions',scope+'.json'),record=readState(file,null);
 assert.ok(!record||record.scope===scope,'Independent call belongs to another identity');
 let thread=record?.thread,session,closed=false;
 const open=async()=>session??=(await adapter.start({bindingId:route.account,chatId:route.conversation,sessionId:'whalenest-call-'+scope,
  ...(thread?{runtimeThreadId:thread}:{}),onRuntimeThreadId:async id=>{thread=id;writeState(file,{schema:1,scope,thread:id});}}));
 return {async run(request,signal,run){
  requireCurrentInstanceBinding(options);assert.ok(!closed);assert.equal(request.chatId,route.conversation);assert.equal(request.ownerId,route.sender);
  const ref='independent-call:'+scope;assert.ok(!request.sessionRef||request.sessionRef===ref,'Call identity changed');
  const lease=await serial.acquire(signal);
  try{return await lease.run(async()=>{signal.throwIfAborted();const own=await open();return run(own,{sessionRef:ref,workspace:{workingDirectory:options.cwd},model:options.model});});}
  finally{lease.release();}
 },async close(){if(closed)return;closed=true;await session?.close();}};
}
