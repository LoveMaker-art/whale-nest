import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLiveTools,verifyLiveModules} from '../scripts/lib/live-tools.mjs';
test('the actual deployment gate accepts original speakup and QQ modules while rejecting missing/duplicate shared instances',()=>{
 const modules=['bili','diary','companion-management','memory','mood','speakup','stickers','voice'];
 assert.deepEqual(verifyLiveModules({modules}),{sharedModulesPresent:true});
 assert.doesNotThrow(()=>verifyLiveModules({modules:[...modules,'qq-tools','qq-api']}));
 const qq=['qq-tools','qq-api','profile','contacts','qzone-social'];
 assert.doesNotThrow(()=>verifyLiveModules({modules:[...modules,...qq],qqNative:{configured:true}}));
 assert.throws(()=>verifyLiveModules({modules:[...modules,...qq.filter(n=>n!=='contacts')],qqNative:{configured:true}}),/contacts/);
 assert.throws(()=>verifyLiveModules({modules:modules.filter(id=>id!=='speakup')}),/speakup/);
 assert.throws(()=>verifyLiveModules({modules:[...modules,'memory']}),/Duplicated/);
 assert.throws(()=>verifyLiveModules({modules,singing:{enabled:true}}),/song/);
 assert.doesNotThrow(()=>verifyLiveModules({modules:[...modules,'song'],singing:{enabled:true}}));
});
test('a legacy package or unique memory tool still fails the actual deployment check',()=>{
 assert.throws(()=>verifyLiveTools({tools:[]},{dsh:{profile:{bundles:['dsh-bili-subagent']}}}),/package remains/);
 assert.throws(()=>verifyLiveTools({tools:['mnemon_search']},{}),/exclusive plugin/);
 assert.throws(()=>verifyLiveTools({tools:['bili_watch']},{},{activitiesEnabled:true}),/Missing or duplicated/);
 assert.throws(()=>verifyLiveTools({tools:['sing_song']},{},{songsEnabled:true}),/companion_songs/);
 assert.doesNotThrow(()=>verifyLiveTools({tools:['sing_song','companion_songs']},{},{songsEnabled:true}));
});
test('legacy-compatible Bili names alone never prove the old independent plugin is loaded',()=>{
 const status={tools:['remember','recall_memory','bili_scan','bili_login_start']};assert.equal(verifyLiveTools(status,{dependencies:{'@deepseek-ai/dsh-base':'x'}}).oldPluginPackagesAbsent,true);
});
