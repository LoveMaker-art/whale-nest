import test from 'node:test';
import assert from 'node:assert/strict';
import {queryPlatformPlugins} from '../src/platform-query.mjs';

test('structured plugin metadata is configuration-scoped and independent of CLI formatting',async()=>{
 const row={pluginId:'whalenest.runtime.deepseek-harness',status:'active',version:'1.2.3',target:'linux-x64',integrity:'sha256-test',activeArtifact:'/own/entry.mjs',source:{type:'github',repository:'owner/repo',release:'v1.2.3',secret:'must-not-leave-query'},manifest:{secret:'private'},futureField:'supported'};
 const fetchImpl=async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:47822/core/v1/plugins');assert.equal(init.headers['X-ClawChat-Connect-Core-Config-Path'],'/scope/config.json');assert.equal(init.redirect,'error');
  return Response.json([row,{pluginId:'another-plugin',newFormat:true}]);
 };
 const rows=await queryPlatformPlugins('/scope/config.json',{fetchImpl});
 assert.equal(rows[0].version,'1.2.3');assert.equal(rows[0].source.repository,'owner/repo');assert.ok(!JSON.stringify(rows).includes('secret'));assert.ok(!Object.hasOwn(rows[0],'manifest'));
 assert.equal(rows[1].pluginId,'another-plugin');
});
test('unavailable, foreign and malformed management results never become a cached success',async()=>{
 await assert.rejects(queryPlatformPlugins('/scope/config.json',{fetchImpl:async()=>Response.json({error:'foreign'},{status:403})}),/HTTP 403/);
 await assert.rejects(queryPlatformPlugins('/scope/config.json',{fetchImpl:async()=>Response.json({plugins:[]})}),/array/);
 await assert.rejects(queryPlatformPlugins('/scope/config.json',{fetchImpl:async()=>{throw Error('offline');}}),/offline/);
});

test('retained rollback versions preserve only usable version and integrity, excluding historical configurations',async()=>{
 const integrity='sha256-'+Buffer.alloc(32,3).toString('base64');
 const row={pluginId:'whalenest.runtime.deepseek-harness',retainedVersions:[
  {version:'1.0.0-beta.4.dev.20',integrity,target:'linux-x64',source:{type:'local',path:'/private'},
   installationConfiguration:{secret:'must-not-leave-query'},capabilityConfigurations:{secret:'hidden'},manifest:{secret:'hidden'}},
  null,{},'invalid',{version:'bad',integrity},{version:'1.0.0',integrity:'bad'},
 ]};
 const rows=await queryPlatformPlugins('/scope/config.json',{fetchImpl:async()=>Response.json([row])});
 assert.deepEqual(rows[0].retainedVersions,[{version:'1.0.0-beta.4.dev.20',integrity}]);
 assert.ok(!JSON.stringify(rows).includes('secret'));assert.ok(!JSON.stringify(rows).includes('/private'));
 for(const retainedVersions of [undefined,null,'invalid',{}]){
  const value=await queryPlatformPlugins('/scope/config.json',{fetchImpl:async()=>Response.json([{pluginId:row.pluginId,retainedVersions}])});
  assert.equal(value[0].retainedVersions,undefined);
 }
});
