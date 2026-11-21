import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {protectDiaryRollback} from '../src/runtime-upgrade.mjs';
import {hash,ownerScope,routeKey,senderKey} from '../src/routing.mjs';
import {readState,writeState} from '../src/state.mjs';
import {createDiary} from '../src/diary.mjs';
import {createDiaryPublisher} from '../src/diary-publisher.mjs';

test('rollback retains new diary text, tombstones, unknown requests and platform receipts while stopping unsupported writers',t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'whalenest-diary-rollback-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const route={channel:'clawchat',account:'dsh',sender:'owner',conversation:'dm',kind:'private'},options={instanceId:'fixture',dataDir,owners:[route],clawchat:{route}},scope=ownerScope(options),legacy=hash([options.instanceId,routeKey(route),senderKey(route)]);
 const data={diaries:[{schema:2,scope,date:'2026-11-15',revision:3,state:'completed',text:'保留新正文',requests:{uncertain:{state:'uncertain'}}},{schema:2,scope,date:'2026-11-14',revision:2,state:'deleted'}],
  publications:{schema:2,scope,identityScope:legacy,records:{cc:{id:'cc',scope,platform:'clawchat',date:'2026-11-15',revision:3,state:'confirmed',momentId:123},qq:{id:'qq',scope,platform:'qq',date:'2026-11-15',revision:3,state:'uncertain'}}},
  policy:{settings:{automatic:true,contactEnabled:true},jobs:{d:{id:'d',kind:'diary',engine:'aurabot-diary',state:'awaiting-delivery',inputId:'input'},c:{kind:'contact',state:'confirmed'}}},runtime:{outbox:{d:{state:'pending',companionJobId:'d'},c:{state:'confirmed',messageId:'keep'}}}};
 assert.deepEqual(protectDiaryRollback(data,options,'0.3.0-whalenest.m3.14'),{disableDiary:true,held:1});assert.equal(data.diaries[0].scope,legacy);assert.equal(data.diaries[0].text,'保留新正文');assert.equal(data.diaries[1].state,'deleted');assert.equal(data.diaries[0].requests.uncertain.state,'uncertain');assert.equal(data.publications.records.qq,undefined);assert.equal(data.publications.retainedQQRecords.qq.state,'uncertain');assert.equal(data.policy.settings.contactEnabled,true);assert.equal(data.runtime.outbox.c.messageId,'keep');
 for(const record of data.diaries)writeState(join(dataDir,'diary',record.scope+'-'+record.date+'.json'),record);writeState(join(dataDir,'diary-publications.json'),data.publications);
 const diary=createDiary(options,route,{activities:{list:()=>[]}});assert.equal(diary.read('2026-11-15').message,'保留新正文');assert.equal(diary.read('2026-11-14').state,'deleted');
 const publisher=createDiaryPublisher(options,route,{diary});assert.equal(publisher.qq.check('2026-11-15').state,'uncertain');assert.equal(readState(join(dataDir,'diary-publications.json')).records.cc.momentId,123);
 assert.ok(readdirSync(join(dataDir,'diary')).every(n=>n.startsWith(scope)));assert.deepEqual(protectDiaryRollback(data,options,'0.3.0-whalenest.m3.15'),{disableDiary:false,held:0});
});
