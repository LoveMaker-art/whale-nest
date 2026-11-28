import assert from 'node:assert/strict';
import {join} from 'node:path';
import {hash,resolveDeliveryTarget} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {clawchatBindingState} from './clawchat-state.mjs';
import {livewareCommands} from './liveware-command.mjs';
import {livewarePublication} from './liveware-migration.mjs';
import {startupStatus} from './startup-state.mjs';
import {retryUnexecutedLivewareOperation} from './liveware-operation.mjs';

const verified=new Map();
const rows=value=>Array.isArray(value)?value:value?.apps;

export async function publishFirstLiveware(options,kind,port,signal,dependencies={}){
  if(kind==='call')return; // Official Exposure owns the managed call entry.
  if(options.clawchat?.firstBinding!==true||!Number.isInteger(port)||port<1||port>65535)return;
  assert.equal(kind,'song');
  if(!startupStatus(options).appsAllowed)return;
  const route=options.clawchat.route;
  if(!route||!resolveDeliveryTarget(options,{origin:route}).ok)return;
  const binding=readState(join(options.dataDir,'first-binding.json'),null);
  if(!binding?.identity)return;
  const platform=dependencies.platform??clawchatBindingState(options.clawchat.delivery.configPath,route.account,{options});
  platform.verify(binding.identity);
  const commands=dependencies.commands??livewareCommands(options);
  const path=join(options.dataDir,'song-liveware.json'),previous=readState(path,null);
  const stamp=hash([binding.identity,previous]);
  if(verified.get(path)===stamp)return;
  const control={signal};
  const upstream='http://127.0.0.1:'+port;
  if(previous?.url){
    const apps=rows(await commands.listApps(control));
    assert.ok(Array.isArray(apps),'Invalid account app list');
    const id=previous.appId??new URL(previous.url).hostname.split('.')[0];
    const found=apps.find(app=>app.appId===id&&app.name==='鲸栖歌曲');
    if(found){
      const publication=livewarePublication(found);
      assert.equal(publication.url,new URL(previous.url).href,'Song app URL changed');
      const record={...previous,binding:route.account,owner:route.sender,agent:binding.identity.agent,
        appId:id,url:publication.url,upstream};
      writeState(path,record);verified.set(path,hash([binding.identity,record]));return;
    }
    // Retire a copied local reference without deleting the source cloud app.
  }
  const key=hash([binding.id,'song']);
  let progress=previous?.identity?.agent===binding.identity.agent&&previous?.operations?previous:
    {identity:binding.identity,operations:{
      create:{requestId:'whalenest-song-create-'+key,state:'unissued'},
      bind:{requestId:'whalenest-song-bind-'+key,state:'unissued'}}};
  const save=()=>writeState(path,progress);
  save();
  async function operation(kind,perform){
    let entry=progress.operations[kind];
    if(entry.state==='succeeded')return entry.result;
    if(kind==='create'&&progress.adoption){
      platform.verify(binding.identity);
      const listed=rows(await commands.listApps(control));
      assert.ok(Array.isArray(listed));
      const candidates=listed.filter(a=>a.name==='鲸栖歌曲');
      assert.equal(candidates.length,1,'Adopted song app is no longer unique');
      const app=livewarePublication(await commands.inspectApp(candidates[0].appId,control));
      assert.equal(app.appId,progress.adoption.app.appId);assert.equal(app.url,progress.adoption.app.url);
      platform.verify(binding.identity);
      return app;
    }
    if(entry.state==='pending'){
      const raw=await commands.readReceipt(kind==='create'?'liveware_app_create':'liveware_tunnel_bind',entry.requestId);
      const receipt={...raw,state:raw.status};
      if(receipt?.state==='succeeded'){
        Object.assign(entry,{state:'succeeded',result:receipt.result});save();return entry.result;
      }
      if(kind==='create'&&!['pending','running','prepared'].includes(receipt?.state)&&commands.listApps&&commands.inspectApp){
        platform.verify(binding.identity);
        const listed=rows(await commands.listApps(control));
        assert.ok(Array.isArray(listed),'Invalid account app list');
        const candidates=listed.filter(a=>a.name==='鲸栖歌曲');
        assert.equal(candidates.length,1,'Unknown song create needs one uniquely owned app');
        const app=livewarePublication(await commands.inspectApp(candidates[0].appId,control));
        assert.equal(app.appId,candidates[0].appId);assert.equal(app.name,'鲸栖歌曲');
        assert.equal(app.url,livewarePublication(candidates[0]).url);
        platform.verify(binding.identity);
        // Adopt a verified existing resource, without fabricating the original ACK.
        progress.adoption={source:'current-account-list-and-inspect',identity:binding.identity,
          originalRequestId:entry.requestId,originalState:receipt.state,app};
        save();return app;
      }
      const retry=retryUnexecutedLivewareOperation(entry,receipt);
      if(!retry)throw Error('Song '+kind+' is awaiting its original Core receipt');
      progress.operations[kind]=entry=retry;save();
    }
    assert.equal(entry.state,'unissued');
    entry.state='pending';save(); // Unknown delivery is observed, never replayed.
    entry.result=await perform({...control,requestId:entry.requestId});entry.state='succeeded';save();
    return entry.result;
  }
  const app=livewarePublication(await operation('create',c=>commands.createApp('鲸栖歌曲',c)));
  platform.verify(binding.identity);
  const result=await operation('bind',c=>commands.bindTunnel(app.appId,upstream,c));
  assert.equal(result.appId,app.appId);assert.equal(result.registeredInClawChat,true);
  const publication=livewarePublication({...app,publicUrl:result.publicUrl});
  assert.equal(publication.url,app.url);
  progress={...progress,binding:route.account,owner:route.sender,agent:binding.identity.agent,
    appId:app.appId,url:publication.url,upstream};
  save();verified.set(path,hash([binding.identity,progress]));
}
