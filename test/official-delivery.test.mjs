import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createOfficialDelivery,officialDeliveryPaths} from '../src/official-delivery.mjs';

const route={channel:'clawchat',account:'dsh',sender:'owner',kind:'private',conversation:'chat'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'whalenest-outbox-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=join(root,'official-fixture.cjs');
 await writeFile(cli,'#!'+process.execPath+'\n'+String.raw`
const fs=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='__clawnest-state'){console.log(JSON.stringify({userId:'agent',ownerId:'owner',conversationId:'chat',connected:true}));process.exit(0);}
const input=JSON.parse(a[a.indexOf('--input-json')+1]);
setTimeout(()=>{fs.appendFileSync(__dirname+'/effects.jsonl',JSON.stringify(input)+'\n');console.log(JSON.stringify({status:'succeeded',result:{sent:true,messageId:'durable-ack'}}));},150);
`,{mode:0o700});
 const options={instanceId:'outbox',cwd:root,dataDir:join(root,'data'),owners:[route],clawchat:{route,delivery:{connectBin:cli,configPath:join(root,'config')}}};
 return {root,options};
}
function parent(options,id){
 const script='import {createOfficialDelivery} from '+JSON.stringify(pathToFileURL(resolve('src/official-delivery.mjs')).href)+';'+
  'const options='+JSON.stringify(options)+';await createOfficialDelivery(options,options.clawchat.route).submit({id:'+JSON.stringify(id)+',tool:"clawchat_send_message",input:{chatId:"chat",chatType:"direct",text:"original"}},{waitMs:0});';
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 return new Promise((resolve,reject)=>{let error='';child.stderr.on('data',b=>error+=b);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(error)));});
}
test('detached official execution survives caller process exit, and concurrent callers cannot duplicate it',async t=>{
 const f=await fixture(t),id='whalenest-reply-'+'b'.repeat(64);
 await Promise.all([parent(f.options,id),parent(f.options,id)]);
 const outbox=createOfficialDelivery(f.options,route);let result;
 for(let i=0;i<200;i++){
  const record=outbox.inspect(id);if(record?.state==='confirmed'){result=record;break;}await delay(20);
 }
 assert.equal(result?.messageId,'durable-ack');
 assert.equal((await readFile(join(f.root,'effects.jsonl'),'utf8')).trim().split('\n').length,1);
 assert.equal(outbox.check(id).state,'confirmed');
 await outbox.submit({id,tool:'clawchat_send_message',input:{chatId:'chat',chatType:'direct',text:'original'}});
 assert.equal((await readFile(join(f.root,'effects.jsonl'),'utf8')).trim().split('\n').length,1);
 await assert.rejects(outbox.submit({id,tool:'clawchat_send_message',input:{chatId:'chat',chatType:'direct',text:'changed'}}),/conflict/);
});
test('a transport failure mislabeled failed stays uncertain, while a definite validation failure stays failed',async t=>{
 const f=await fixture(t);let error='connection closed before acknowledgement';
 const run=async(_bin,args)=>args[0]==='__clawnest-state'?{stdout:JSON.stringify({userId:'agent',ownerId:'owner',conversationId:'chat',connected:true})}:
  {stdout:JSON.stringify({status:'failed',error})};
 const outbox=createOfficialDelivery(f.options,route,{run});
 assert.equal((await outbox.submit({id:'whalenest-reply-'+'c'.repeat(64),tool:'clawchat_send_message',input:{chatId:'chat',chatType:'direct',text:'one'}})).state,'uncertain');
 error='text exceeds platform input limit';
 assert.equal((await outbox.submit({id:'whalenest-reply-'+'d'.repeat(64),tool:'clawchat_send_message',input:{chatId:'chat',chatType:'direct',text:'two'}})).state,'failed');
});
