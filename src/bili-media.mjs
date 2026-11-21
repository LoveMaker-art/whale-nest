import assert from 'node:assert/strict';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {hash} from './routing.mjs';
import {readState} from './state.mjs';

/** Resolve a received image from this native Session's durable input journal. */
export function readBiliReferenceImage(options,sessionId,actor){
 const session=actor?.agent?.session,route=options.clawchat?.route;if(!session||!route)return null;
 assert.equal(String(actor.agent.id),String(sessionId),'Reference image Session mismatch');
 for(let n=session.seq;n>=0;n--){
  const event=session.eventAt(n);if(event?.type!=='user/message')continue;
  const message=event.data.message??event.data,turnId=message.source?.connectInputId;if(!turnId||message.source.kind!=='user')continue;
  const root=join(options.dataDir,'media','incoming',hash([route.account,route.conversation,sessionId,turnId]));
  const receipt=readState(join(root,'input.json'),null);if(receipt?.state!=='completed')continue;
  const file=receipt.files.findLast(f=>f.kind==='image');if(!file)continue;
  assert.ok(!lstatSync(file.path).isSymbolicLink(),'Reference image cannot be a symlink');
  const path=realpathSync(file.path),rel=relative(realpathSync(root),path);assert.ok(!rel.startsWith('..')&&!isAbsolute(rel),'Reference image escaped input directory');
  const bytes=readFileSync(path);assert.ok(bytes.length>0&&bytes.length<=2*1024*1024,'头像图片超过2MiB');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,'Reference image changed');return bytes;
 }
 return null;
}
