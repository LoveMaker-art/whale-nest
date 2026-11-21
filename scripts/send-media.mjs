import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createMediaSender} from '../src/media-delivery.mjs';

const argv=process.argv.slice(2),value=flag=>{const i=argv.indexOf(flag);return i<0?undefined:argv[i+1];};
const file=value('--file'),requestId=value('--request-id');
assert.ok(file&&requestId,'Usage: send-media.mjs --file ABSOLUTE_PATH --request-id ID [--caption TEXT] [--duration MS] [--width PX --height PX]');
const options=JSON.parse(readFileSync(value('--instance')??join(homedir(),'.dsh/companion/aurabot-v1/instance.json'),'utf8'));
const route=options.clawchat.route,delivery=options.clawchat.delivery;
const state=JSON.parse(execFileSync(delivery.connectBin,['__clawnest-state','--config',delivery.configPath],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}));
assert.equal(state.ownerId,route.sender,'Owner changed');assert.equal(state.conversationId,route.conversation,'Conversation changed');assert.ok(state.connected,'Core disconnected');
const input={filePath:resolve(file),requestId,...(value('--caption')?{caption:value('--caption')}:{})};
for(const name of ['duration','width','height'])if(value('--'+name))input[name]=Number(value('--'+name));
const sender=createMediaSender(options,route,{sessionId:'operator-media-probe'}),result=await sender.send(input);
console.log(JSON.stringify(result));process.exitCode=result.state==='confirmed'?0:1;
