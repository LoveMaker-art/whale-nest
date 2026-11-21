import test from 'node:test';
import assert from 'node:assert/strict';
import {protectBiliRollback} from '../src/runtime-upgrade.mjs';
test('rollback to an older writer holds new inbox notices and disables adapters it cannot guard',()=>{
 const runtime={outbox:{new:{state:'pending',biliNoticeId:'new-notice',text:'private new message'},confirmed:{state:'confirmed',biliNoticeId:'confirmed-notice',messageId:'ack'},reminder:{state:'pending',source:'schedule'}}},inbox={notices:{new:{state:'queued',text:'private new message'},old:{state:'confirmed'}}};
 const result=protectBiliRollback(runtime,inbox,'0.3.0-whalenest.m3.3');assert.equal(result.disableActivities,true);assert.equal(runtime.outbox.new.state,'uncertain');assert.equal(inbox.notices.new.state,'held');assert.equal(inbox.notices.new.text,'private new message');assert.equal(runtime.outbox.confirmed.state,'confirmed');assert.equal(runtime.outbox.reminder.state,'pending');
 const supported={outbox:{next:{state:'pending',biliNoticeId:'notice'}}};assert.equal(protectBiliRollback(supported,{notices:{}},'0.3.0-whalenest.m3.4').disableActivities,false);assert.equal(supported.outbox.next.state,'pending');
});
