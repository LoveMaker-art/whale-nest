import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPluginUpdates} from '../src/plugin-updates.mjs';
import {updateFiles,updateProgress} from '../src/plugin-update-worker.mjs';
import {readState} from '../src/state.mjs';
import {hash} from '../src/routing.mjs';

test('one exact owner confirmation pins the final target and every stage without applying its final prerequisite to the bridge',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'whalenest-path-offer-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const repository='offer-fixture/releases',current='1.0.0-beta.4',bridgeVersion='1.0.0-beta.5',finalVersion='1.0.0-beta.6';
  const route={channel:'clawchat',kind:'private',account:'dsh',conversation:'private',sender:'owner'};
  const options={instanceId:'offer-instance',cwd:dir,dataDir:dir,owners:[route],clawchat:{route,delivery:{connectBin:"/bin/false",configPath:join(dir,"connect.json")}},
    pluginUpdates:{repository,channel:'beta'}};
  const release=version=>({repository,version,tag:'v'+version,sha256:hash(version),
    compatibility:{dataSchema:1},notes:'',updateProtocol:1});
  const bridge=release(bridgeVersion),final={...release(finalVersion),
    prerequisites:{clawchatIntegration:{minimumVersion:'0.2.24',upgradeVersion:'0.2.24',officialOnly:true}},
    updatePath:{schema:1,steps:[{version:bridge.version,sha256:bridge.sha256}]}};
  const fetched=[],launches=[];
  const host={installed:()=>({version:current}),change:()=>{throw Error('Checking is read-only');}};
  const discover=async(_options,_current,{tag}={})=>{
    fetched.push(tag??'latest');
    return structuredClone(tag===bridge.tag?bridge:final);
  };
  const connector={check:async()=>({state:'available',current:'0.2.23',latest:'0.2.26',automaticUpdate:false,managedBy:'user'})};
  const service=createPluginUpdates(options,join(dir,'instance.json'),{
    host,connector,discover,launch:id=>{launches.push(id);},
  });
  const offer=await service.perform(route,{action:'check'},'检查更新');
  assert.equal(offer.target,finalVersion);
  assert.equal(offer.connector.state,'available');
  assert.equal(offer.connector.automaticUpdate,false);
  assert.deepEqual(offer.steps,[bridgeVersion,finalVersion]);
  assert.deepEqual(offer.stages,[{version:bridgeVersion},{version:finalVersion}]);
  assert.deepEqual(fetched,['latest',bridge.tag]);
  const confirmed=await service.perform(route,{action:'confirm',version:finalVersion},'确认更新 '+finalVersion);
  const request=readState(updateFiles(options).request);
  assert.equal(request.release.version,finalVersion);
  assert.deepEqual(request.plan.steps,[bridge,final]);
  assert.equal(request.planDigest,hash(request.plan));
  assert.equal((await service.perform(route,{action:'confirm',version:finalVersion},'确认更新 '+finalVersion)).jobId,confirmed.jobId);
  await service.tick({notices:false});
  assert.deepEqual(launches,[confirmed.jobId]);
  assert.equal(readState(updateProgress(options,confirmed.jobId),{phase:'queued'}).phase,'queued');
});

test('a missing or checksum-changed declared bridge never produces an actionable update offer',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'whalenest-path-offer-invalid-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const repository='offer-fixture/releases',route={channel:'clawchat',kind:'private',account:'dsh',conversation:'private',sender:'owner'};
  const options={instanceId:'invalid-offer',cwd:dir,dataDir:dir,owners:[route],clawchat:{route,delivery:{connectBin:"/bin/false",configPath:join(dir,"connect.json")}},pluginUpdates:{repository,channel:'beta'}};
  const bridge={repository,version:'1.0.0-beta.5',tag:'v1.0.0-beta.5',sha256:hash('bridge'),compatibility:{dataSchema:1},notes:'',updateProtocol:1};
  const final={...bridge,version:'1.0.0-beta.6',tag:'v1.0.0-beta.6',sha256:hash('final'),
    updatePath:{schema:1,steps:[{version:bridge.version,sha256:hash('different asset')}]}};
  const service=createPluginUpdates(options,'fixture',{connector:{check:async()=>({state:'unavailable',automaticUpdate:false,managedBy:'user'})},host:{installed:()=>({version:'1.0.0-beta.4'})},
    discover:async(_options,_version,{tag}={})=>tag?bridge:final});
  assert.equal((await service.perform(route,{action:'check'},'检查更新')).state,'check-failed');
  await assert.rejects(service.perform(route,{action:'confirm',version:final.version},'确认更新 '+final.version),/重新检查/);
  assert.equal(readState(updateFiles(options).request,null),null);
});
