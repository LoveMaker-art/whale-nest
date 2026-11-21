import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTurnSource,requireManualOwnerTurn} from '../src/native-tool.mjs';
const session=sources=>({seq:sources.length-1,eventAt:n=>({type:'user/message',data:{source:sources[n]}})});
test('native actor lookup ignores generated time/runtime context and preserves the authenticated source',()=>{
 const owner={kind:'aurabot',speaker:{role:'owner',chat:'private'}},s=session([owner,{kind:'time-context'},{kind:'runtime-context'}]);assert.equal(nativeTurnSource(s),owner);assert.doesNotThrow(()=>requireManualOwnerTurn({agent:{session:s}}));
 assert.equal(nativeTurnSource(session([{kind:'runtime-context'}])),null);
});
test('generated context after a background source never restores an earlier manual owner authorization',()=>{
 const background={kind:'aurabot',speaker:{role:'none'},taskId:'whalenest-job-test'},s=session([{kind:'user'},background,{kind:'runtime-context'}]);assert.equal(nativeTurnSource(s),background);assert.throws(()=>requireManualOwnerTurn({agent:{session:s}}),/后台/);
});
