import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);

export function clawchatTextDelivery(options, route, run=exec) {
  const delivery=options.clawchat.delivery;
  return {async sendText(intent) {
    assert.ok(delivery?.connectBin&&delivery?.configPath,'ClawChat delivery bridge is not configured');
    const response=await run(delivery.connectBin,['tool','call','clawchat_mention_message',
      '--agent',route.account,'--request-id',intent.id,'--input-json',
      JSON.stringify({chatId:route.conversation,chatType:'direct',text:intent.text,
        mentions:[{userId:route.sender,display:delivery.ownerDisplay??'主人'}]}),
      '--config',delivery.configPath],{timeout:25000,maxBuffer:1024*1024});
    const receipt=JSON.parse(response.stdout).result;
    assert.ok(typeof receipt?.messageId==='string'&&receipt.messageId,'ClawChat acknowledgement is missing');
    return {messageId:receipt.messageId};
  }};
}
