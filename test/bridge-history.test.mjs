import test from 'node:test';
import assert from 'node:assert/strict';
import {readBridgeHistory} from '../src/bridge-history.mjs';
import {pageHistoryEvents} from '../integration/clawchat/base/deepseek-harness-history.mjs';

test('the probe reconstructs history from the official bounded bridge pages',async()=>{
  const snapshot={header:{id:'large-session'},events:Array.from({length:320},(_,seq)=>({seq,type:'user/message',data:{text:'历史'.repeat(4000)}}))};
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>1_048_576);
  let pages=0;
  const client={async request(method,params){assert.equal(method,'history');const page={header:snapshot.header,...pageHistoryEvents(snapshot.events,{...params,maxBytes:700_000})};pages++;
    assert.ok(Buffer.byteLength(JSON.stringify({type:'response',result:page}))<1_048_576);return page;}};
  assert.deepEqual(await readBridgeHistory(client,'large-session'),snapshot);assert.ok(pages>1);
  await assert.rejects(readBridgeHistory({request:async()=>({header:{},events:[],nextBeforeSeq:-1})},'bad'),/cursor/);
});
