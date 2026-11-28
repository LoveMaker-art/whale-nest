import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOfficialDeliveryCapabilities} from '../src/official-delivery-preflight.mjs';

const options={cwd:'/tmp',clawchat:{delivery:{connectBin:'/official/core',configPath:'/official/config'}}};
test('source deployment checks public tool capabilities, without connector or DSH version gates',async()=>{
 const calls=[];
 const run=async(bin,args)=>{
  calls.push([bin,...args]);
  if(bin==='ffmpeg')return {stdout:'ffmpeg'};
  assert.equal(args[0],'tool');assert.equal(args[1],'describe');
  const fields=args[2]==='clawchat_send_message'?['chatId','chatType','text']:['chat_id','path'];
  return {stdout:JSON.stringify({name:args[2],inputSchema:{properties:Object.fromEntries(fields.map(f=>[f,{}]))}})};
 };
 assert.equal((await inspectOfficialDeliveryCapabilities(options,{run})).ok,true);
 assert.equal(calls.length,5);assert.ok(calls.every(c=>!c.includes('--version')));
 const unsupported=await inspectOfficialDeliveryCapabilities(options,{run:async(bin,args)=>{
  if(args[2]==='clawchat_send_image')throw Error('unknown tool');return run(bin,args);
 }});
 assert.equal(unsupported.ok,false);assert.deepEqual(unsupported.missing,['clawchat_send_image']);
 const conversion=await inspectOfficialDeliveryCapabilities(options,{run:async(bin,args)=>{
  if(bin==='ffmpeg')throw Error('missing ffmpeg');return run(bin,args);
 }});assert.equal(conversion.ok,false);assert.equal(conversion.conversion,false);
});
