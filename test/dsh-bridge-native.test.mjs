import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';

test('Whale DSH bridge preserves trusted ownership, QQ isolation and native catalogs without running a model',{timeout:45000},async t=>{
 const dir=await bridgeDirectory();let bridge;
 t.after(async()=>{await bridge?.close();await rm(dir.root,{recursive:true,force:true});});
 bridge=await bootBridge(dir);
 assert.equal(bridge.hello.protocol.major,2);
 assert.equal(bridge.hello.home,dir.options.home);
 assert.equal(bridge.hello.capabilities.durableReceipt,true);
 await assert.rejects(bridge.request('resume',{sessionId:'foreign-cold-session'}),/Cold activation has no verified route/);
 await assert.rejects(bridge.request('create',{sessionId:'qq-preset-attempt',cwd:dir.root,
  whalenestChatId:'dm-alice',agentPreset:'aurabot-private',model:dir.options.model}),/QQ Agent Presets are reserved/);
 const presets=await bridge.request('presets');
 assert.ok(presets.presets.every(preset=>!preset.id.startsWith('aurabot-')));
 const permission=await bridge.request('permissionPresets');
 assert.ok(permission.presets.some(preset=>preset.id==='workspace-write'));
 const sessionId='whale-owned-native';
 await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 const status=await bridge.request('companionStatus',{sessionId});
 assert.equal(status.nativeQQHost,true);
 assert.equal(status.tools.filter(name=>name==='companion_settings').length,1);
 assert.ok(Array.isArray(await bridge.request('commands',{sessionId})));
 assert.ok(Array.isArray(await bridge.request('skills',{sessionId,cwd:dir.root})));
 await assert.rejects(bridge.request('prompt',{sessionId,inputId:'whalenest-call-11111111-1111-1111-1111-111111111111',
  text:'运维自测：禁止伪造实时通话来源',whalenestSource:'realtime-call'}),/Unverified voice input/);
 await assert.rejects(bridge.request('constructor'),/Unsupported Bridge method/);
 const history=await bridge.request('history',{sessionId});
 assert.equal(history.events.filter(event=>event.type==='user/message').length,0);
 await assert.rejects(bridge.request('resume',{sessionId,whalenestChatId:'other-private-chat'}),/Unverified ClawChat conversation/);
 assert.equal((await bridge.request('companionStatus',{sessionId})).sessionId,sessionId);
});
