import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSerial} from '../src/runtime-serial.mjs';
test('chat and voice share a reentrant writer gate; cancelling queued work cannot cancel its successor',async()=>{
 const serial=runtimeSerial(),first=await serial.acquire(),cancel=new AbortController();
 const waiting=serial.acquire(cancel.signal);cancel.abort();await assert.rejects(waiting);
 let ready=false;const next=serial.acquire().then(v=>{ready=true;return v;});await Promise.resolve();assert.equal(ready,false);
 first.release();const lease=await next;await lease.run(async()=>{const nested=await serial.acquire();nested.release();});lease.release();
 const final=await serial.acquire();final.release();
});
