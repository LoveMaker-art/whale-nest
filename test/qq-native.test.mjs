import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {enableQQNativeModules,createQQNative,qqSocialModule,QQ_NATIVE_MODULES} from '../src/qq-native.mjs';

function actor(id,text,{callId=id,kind='aurabot',role='owner',chat='private'}={}){
 const events=[{type:'user/message',data:{message:{id,source:{kind,humanText:text,speaker:{role,chat}},content:[{type:'text',text}]}}},
  {type:'assistant/message',data:{message:{id:'assistant-'+callId,content:[{type:'tool-call',id:callId}]}}}];
 return {callId,agent:{id:'qq-session',session:{seq:1,eventAt:n=>events[n]}}};
}
test('QQ activation loads original modules without connecting an account or silently starting space interaction',()=>{
 const original=normalize({enabled:false,ownerQQ:'10000001',botQQ:'20000002',modules:Object.fromEntries(QQ_NATIVE_MODULES.map(id=>[id,{enabled:false,useBuiltin:false}]))});
 assert.equal(original.qzoneSocial.enabled,true);
 const next=enableQQNativeModules(original);assert.equal(next.enabled,false);assert.equal(next.ownerQQ,original.ownerQQ);assert.equal(next.botQQ,original.botQQ);
 assert.equal(next.qzoneSocial.enabled,false);assert.ok(QQ_NATIVE_MODULES.every(id=>next.modules[id].enabled&&next.modules[id].useBuiltin));assert.equal(original.qzoneSocial.enabled,true);
 assert.deepEqual(enableQQNativeModules(next),next,'Restart retains the disabled automatic switch');assert.deepEqual(next.profilePerms,original.profilePerms);assert.deepEqual(next.allow,original.allow);
});
test('manual QQ entry calls the original space implementation once per owner turn and preserves unknown results',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-qq-native-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let runs=0,fail=false;
 const social={state:()=>({count:runs,lastRun:1,history:[]}),run:async args=>{assert.deepEqual(args,{force:true});runs++;if(fail)throw Error('lost result');return {ok:true,replies:1,comments:0};}};
 const native={onebot:{state:'connected'},getConfig:()=>({enabled:true,qzoneSocial:{enabled:false}}),modules:{use:id=>id==='qzone-social'?social:{}}};
 const tool=()=>createQQNative({dataDir,instanceId:'test',qq:{nativeModules:true}},()=>native).socialTool();
 const first=await tool().execute({action:'run'},actor('one','请在QQ空间回复评论'));assert.ok(first.ok);assert.equal(runs,1);
 assert.deepEqual(await tool().execute({action:'run'},actor('one','请在QQ空间回复评论',{callId:'another-call'})),first);assert.equal(runs,1,'Restart and another call ID do not repeat the same social run');
 assert.equal((await tool().execute({action:'status'},actor('status','查看空间互动记录'))).count,1);
 fail=true;assert.equal((await tool().execute({action:'run'},actor('unknown','请在QQ空间回复评论'))).state,'uncertain');assert.equal(runs,2);
 assert.equal((await tool().execute({action:'run'},actor('unknown','请在QQ空间回复评论',{callId:'retry'}))).state,'uncertain');assert.equal(runs,2);
 for(const opts of [{kind:'user'},{kind:'schedule'},{role:'friend'},{chat:'group'}])assert.equal((await tool().execute({action:'run'},actor('denied-'+JSON.stringify(opts),'请在QQ空间回复评论',opts))).ok,false);
 assert.equal((await tool().execute({action:'run'},actor('read-only','看看QQ空间有什么'))).ok,false);assert.equal(runs,2);
 native.onebot.state='disconnected';assert.equal((await tool().execute({action:'run'},actor('offline','请在QQ空间回复评论'))).ok,false);assert.equal(runs,2);
});
test('original space comments and likes use zero transport retries while reads retain the original settings',async()=>{
 const calls=[],settings={timeoutMs:20};let core;
 const def={id:'qzone-social',setup(api){core=api.core;return 'original-instance';}};
 const drafts=[];
 assert.equal(qqSocialModule(def).setup({core:{hub:{runSystemTurn:(...args)=>drafts.push(args)},onebot:{call:(...args)=>calls.push(args)},other:42}}),'original-instance');assert.equal(core.other,42);
 for(const action of ['comment_qzone','like_qzone','get_qzone_feeds'])await core.onebot.call(action,{},settings);
 assert.equal(calls[0][2].retries,0);assert.equal(calls[1][2].retries,0);assert.equal(calls[2][2],settings);assert.equal(settings.retries,undefined);
 await core.hub.runSystemTurn('qzone-social','QQ','写评论',{timeoutMs:30});assert.equal(drafts[0][3].noTools,true);assert.equal(drafts[0][3].timeoutMs,30);
});
