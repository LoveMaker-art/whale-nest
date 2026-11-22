import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {hash,resolveDeliveryTarget} from './routing.mjs';
import {readState,writeState} from './state.mjs';

const run=promisify(execFile);
const features={
  call:{name:'鲸栖通话',file:'call-liveware.json'},
  song:{name:'鲸栖歌曲',file:'song-liveware.json'},
};

export async function publishFirstLiveware(options,kind,port,signal) {
  const clawchat=options.clawchat;
  if(clawchat?.firstBinding!==true||!Number.isInteger(port)||port<1||port>65535)return;
  const route=clawchat.route;
  if(!route||!resolveDeliveryTarget(options,{origin:route}).ok)return;
  const binding=readState(join(options.dataDir,'first-binding.json'),null);
  if(!binding?.id)return;
  if(kind==='call'&&options.realtime?.publicOrigin)return;
  const {name,file}=features[kind];
  const path=join(options.dataDir,file);
  if(readState(path,null))return;
  const {connectBin,configPath}=clawchat.delivery??{};
  assert.ok(typeof connectBin==='string'&&isAbsolute(connectBin)&&typeof configPath==='string'&&isAbsolute(configPath),
    'Liveware requires the configured Connect executable and configuration');
  const request=operation=>'whalenest-liveware-'+hash([binding.id,kind,operation]);
  async function tool(area,operation,args) {
    for(let attempt=0;attempt<3;attempt++){
      signal.throwIfAborted();
      try {
        const {stdout}=await run(connectBin,['liveware',area,operation,...args,'--agent',route.account,
          '--request-id',request(operation),'--config',configPath],{timeout:45000,maxBuffer:128*1024,signal});
        const receipt=JSON.parse(stdout);
        assert.equal(receipt.status,'succeeded');
        return receipt.result;
      } catch {
        if(attempt===2)throw Error('Connect Liveware '+operation+' did not return a successful receipt');
        await delay(2000,undefined,{signal});
      }
    }
  }
  // Core journals these two operations under stable request IDs. Resume an
  // unfinished publication with the original app and tunnel receipts.
  const app=await tool('app','create',['--name',name,'--policy','private']);
  assert.ok(app?.name===name&&typeof app.appId==='string'&&app.appId.length>0,'Liveware app receipt mismatch');
  const receipt=await tool('tunnel','bind',['--app-id',app.appId,'--upstream','http://127.0.0.1:'+port]);
  assert.equal(receipt?.appId,app.appId,'Liveware tunnel receipt mismatch');
  assert.equal(receipt.registeredInClawChat,true,'Liveware registration was not confirmed');
  const url=new URL(receipt.publicUrl);
  assert.match(url.href,/^https:\/\/app-[a-z0-9-]+\.apps\.clawling\.io\/$/,'Unexpected Liveware URL');
  writeState(path,{binding:route.account,owner:route.sender,appId:app.appId,url:url.href});
}
