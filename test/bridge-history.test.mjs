import test from 'node:test';
import assert from 'node:assert/strict';
import {historyPage,readBridgeHistory} from '../src/bridge-history.mjs';

test('history paging preserves large native journals within the existing frame size',async()=>{
  const snapshot={header:{id:'large-session'},events:Array.from({length:320},(_,seq)=>({seq,type:'user/message',data:{text:'历史'.repeat(4000)}}))};
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>1_048_576);
  let pages=0;
  const client={async request(method,params){assert.equal(method,'history');const page=historyPage(snapshot,params);pages++;
    assert.ok(Buffer.byteLength(JSON.stringify({type:'response',result:page}))<1_048_576);return page;}};
  assert.deepEqual(await readBridgeHistory(client,'large-session'),snapshot);assert.ok(pages>1);
  assert.equal(historyPage(snapshot,{}),snapshot,'Legacy callers retain the full contract');
  await assert.rejects(readBridgeHistory({request:async()=>({header:{},events:[],more:true,nextSeq:-1})},'bad'),/Empty/);
});
