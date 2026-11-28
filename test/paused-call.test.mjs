import test from 'node:test';
import assert from 'node:assert/strict';
import {startPausedCall} from '../src/paused-call.mjs';

test('paused call card stays reachable without starting voice services or exposing settings',async t=>{
  const server=await startPausedCall({},{port:0});t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.port;
  assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true,maintenance:true,available:false});
  const page=await fetch(base+'/');assert.match(await page.text(),/通话暂时维护中/);
  assert.equal((await fetch(base+'/voice/v1/settings')).status,404);
  assert.equal((await fetch(base+'/',{method:'POST'})).status,404);
});
