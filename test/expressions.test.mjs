import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {createMood} from '../vendor/aurabot/src/features/companion.js';
import {createExpressions} from '../src/expressions.mjs';

function agent(inputId,text='好呀，今天很开心',source='user',reply='今天很开心！'){
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'user/message',data:{message:{source:{kind:source,connectInputId:inputId},content:[{type:'text',text}]}}},
 {seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:reply}]}}},{seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}];
 return{id:'session',session:{seq:3,eventAt:n=>events[n]}};
}
test('original mood changes expression probability; persisted results do not regenerate or resend',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-expression-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});
 process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const cfg=normalize({mood:{enabled:true,judge:false},stickers:{caption:false},dryRun:true});
 const mood=createMood({getConfig:()=>cfg}),route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'chat'};
 const options={instanceId:'test',dataDir,cwd:root,owners:[route],clawchat:{route},expressions:{enabled:true},speech:{enabled:true,ttsModel:'test'}};
 let paused=false,tts=0,send=0;
 const deps={getConfig:()=>cfg,mood,policy:{status:()=>({settings:{paused}})},random:()=>0.17,
 speech:{async synthesize(){tts++;return{path:join(root,'audio.wav'),duration:100};}},senderFor:()=>({async send(){return{state:'confirmed',messageId:'ack-'+(++send)};}})};
 let expressions=await createExpressions({},options,deps);assert.equal(expressions.status().stickerCount,1);
 await expressions.reply(agent('normal'),'normal');assert.equal(tts,0,'0.17 exceeds the original neutral 0.15');
 mood.nudge(40,'开心');const result=await expressions.reply(agent('happy'),'happy');assert.equal(tts,1);assert.equal(result.replacementText,'');assert.equal(send,1);
 const receipts=join(dataDir,'expressions/receipts');
 const savedVoice=(await Promise.all((await readdir(receipts)).map(async name=>({file:join(receipts,name),value:JSON.parse(await readFile(join(receipts,name),'utf8'))})))).find(r=>r.value.voice);
 savedVoice.value.result.replacementText='（语音回复）';await writeFile(savedVoice.file,JSON.stringify(savedVoice.value));
 await expressions.dispose();expressions=await createExpressions({},options,deps);t.after(()=>expressions.dispose());
 const repeated=await expressions.reply(agent('happy'),'happy');assert.equal(repeated.voice.messageId,result.voice.messageId);assert.equal(repeated.replacementText,'');assert.equal(tts,1);assert.equal(send,1);
 assert.equal(JSON.parse(await readFile(savedVoice.file,'utf8')).result.replacementText,'');
 await expressions.reply(agent('text-only','请用文字回复'),'text-only');assert.equal(tts,1);
 await expressions.reply(agent('schedule','定时任务','schedule'),'schedule');assert.equal(send,1);
 paused=true;await expressions.reply(agent('paused'),'paused');assert.equal(send,1);
 paused=false;expressions.configure({enabled:false});await expressions.reply(agent('off'),'off');assert.equal(send,1);
});

test('manual voice omits a follow-up only for matching confirmed tool results, including when automatic expression is off',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-manual-voice-reply-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const cfg=normalize({dryRun:true}),route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'chat'};
 const options={instanceId:'manual-voice',dataDir,cwd:root,owners:[route],clawchat:{route},expressions:{enabled:true}};
 const expressions=await createExpressions({},options,{getConfig:()=>cfg,mood:createMood({getConfig:()=>cfg}),policy:{status:()=>({settings:{paused:true}})},
  speech:{synthesize:async()=>{throw Error('must not synthesize again');}},senderFor:()=>({send:async()=>{throw Error('must not send again');}})});
 t.after(()=>expressions.dispose());expressions.configure({enabled:false});
 const manual=(result,{callId='voice-call',resultId=callId,extra=false}={})=>{
  const events=[{seq:0,type:'turn/start',data:{}},
   {seq:1,type:'user/message',data:{message:{source:{kind:'user',connectInputId:'manual'},content:[{type:'text',text:'请用语音回复'}]}}},
   {seq:2,type:'assistant/message',data:{message:{content:[{type:'tool-call',id:callId,name:'send_voice'},...(extra?[{type:'tool-call',id:'other',name:'companion_update'}]:[])]}}},
   {seq:3,type:'tool/result',data:{message:{toolCallId:resultId,content:[{type:'text',text:JSON.stringify(result)}]}}},
   {seq:4,type:'assistant/message',data:{message:{content:[{type:'text',text:'发好了'}]}}},
   {seq:5,type:'turn/end',data:{reason:{kind:'completed'}}}];
  return{id:'session',session:{seq:5,eventAt:n=>events[n]}};
 };
 const confirmed={state:'confirmed',messageId:'real-audio-ack',kind:'audio'};
 assert.equal((await expressions.reply(manual(confirmed),'manual')).replacementText,'');
 for(const result of [{state:'failed'},{state:'uncertain'},{state:'confirmed'}, {...confirmed,textReply:true}])
  assert.equal((await expressions.reply(manual(result),'manual')).replacementText,undefined);
 assert.equal((await expressions.reply(manual(confirmed,{resultId:'unrelated-call'}),'manual')).replacementText,undefined);
 assert.equal((await expressions.reply(manual(confirmed,{extra:true}),'manual')).replacementText,undefined);
});

test('unconfirmed automatic voice preserves text, is not retried, and starter deletion survives restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-expression-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const cfg=normalize({voice:{autoChance:1},stickers:{autoChance:0,caption:false},mood:{enabled:true,judge:false},dryRun:true});
 const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'chat'};
 const options={instanceId:'failure',dataDir,cwd:root,owners:[route],clawchat:{route},expressions:{enabled:true},speech:{enabled:true,ttsModel:'test'}};
 let calls=0;const deps={getConfig:()=>cfg,mood:createMood({getConfig:()=>cfg}),policy:{status:()=>({settings:{paused:false}})},random:()=>0,
 speech:{async synthesize(){calls++;throw Error('uncertain upstream result');}},senderFor:()=>({async send(){throw Error('must not send');}})};
 let expressions=await createExpressions({},options,deps);
 const result=await expressions.reply(agent('uncertain'),'uncertain');assert.equal(result.replacementText,undefined);assert.equal(result.voice.state,'unconfirmed');
 await expressions.reply(agent('uncertain'),'uncertain');assert.equal(calls,1);
 await assert.rejects(()=>expressions.reply(agent('uncertain'),'wrong-input'),/different native input/);
 expressions.cancel('session','early-cancel');assert.equal((await expressions.reply(agent('early-cancel'),'early-cancel')).state,'cancelled');assert.equal(calls,1);
 await expressions.store.remove(expressions.store.library().items[0].md5,{fromQQ:false});await expressions.dispose();
 expressions=await createExpressions({},options,deps);assert.equal(expressions.status().stickerCount,0,'Deleting the starter is respected');await expressions.dispose();
});

test('account and plugin update replies preserve text without automatic mood media',async t=>{
 const root=await mkdtemp(join(tmpdir(),'whalenest-expression-qq-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'data');await mkdir(join(dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
 const cfg=normalize({voice:{autoChance:1},stickers:{autoChance:1,caption:false},mood:{enabled:true,judge:false},dryRun:true});
 const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'chat'};
 const options={instanceId:'qq-quiet',dataDir,cwd:root,owners:[route],clawchat:{route},expressions:{enabled:true},speech:{enabled:true,ttsModel:'test'}};
 let sends=0,voices=0;
 const expressions=await createExpressions({},options,{getConfig:()=>cfg,mood:createMood({getConfig:()=>cfg}),policy:{status:()=>({settings:{paused:false}})},random:()=>0,
  speech:{synthesize:async()=>{voices++;return {path:join(root,'voice.wav')};}},senderFor:()=>({send:async()=>{sends++;return {state:'confirmed',messageId:'fixture'};}})});
 t.after(()=>expressions.dispose());
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'user/message',data:{message:{source:{kind:'user',connectInputId:'qq-login'},content:[{type:'text',text:'连接QQ'}]}}},
  {seq:2,type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'companion_qq',arguments:{action:'start_login'}}]}}},
  {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'二维码暂未准备完成。'}]}}},{seq:4,type:'turn/end',data:{reason:{kind:'completed'}}}];
 const result=await expressions.reply({id:'session',session:{seq:4,eventAt:n=>events[n]}},'qq-login');
 assert.equal(result.state,'skipped');assert.equal(sends,0);assert.equal(voices,0);
 events[2].data.message.content[0]={type:'tool-call',name:'companion_update',arguments:{action:'check'}};
 assert.equal((await expressions.reply({id:'session',session:{seq:4,eventAt:n=>events[n]}},'qq-login')).state,'skipped');
 assert.equal(sends,0);assert.equal(voices,0);
});
