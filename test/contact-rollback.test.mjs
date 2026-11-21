import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {protectContactRollback} from '../src/runtime-upgrade.mjs';
import {createCompanionPolicy} from '../src/companion-policy.mjs';
import {hash,routeKey,senderKey,ownerScope} from '../src/routing.mjs';

test('rollback holds new contacts, preserves new usage and receipts, and permits repeatable forward migration',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'whalenest-contact-rollback-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const route={channel:'clawchat',account:'agent',sender:'owner',kind:'private',conversation:'dm'},options={instanceId:'test',dataDir,owners:[route],clawchat:{route},activities:{maxDailyBackgroundModelCalls:5}};
 const policy={schema:2,scope:ownerScope(options),settings:{automatic:true,contactEnabled:true,proactivePlatform:'clawchat'},contact:{nextAt:1234,sequence:4},days:{'2026-11-16':{modelRequests:3,automaticMessages:1}},jobs:{
  confirmed:{id:'confirmed',kind:'contact',state:'confirmed',nativeReceipts:['ack']},
  unknown:{id:'unknown',kind:'contact',state:'uncertain',deliveryHeld:true,nativeReceipts:['partial-ack']},
  queued:{id:'queued',kind:'contact',state:'queued'},
 },reservations:{r:{state:'uncertain'}},lastOwnerAt:10,lastAutomaticAt:20};
 const runtime={outbox:{i:{id:'i',companionJobId:'queued',state:'pending'},confirmed:{state:'confirmed'}}};
 assert.deepEqual(protectContactRollback(runtime,policy,options,'0.3.0-whalenest.m3.12'),{disableContact:true,held:1});
 assert.equal(policy.scope,hash([options.instanceId,routeKey(route),senderKey(route)]));assert.equal(policy.schema,1);
 assert.equal(policy.jobs.queued.state,'cancelled');assert.equal(policy.jobs.unknown.state,'uncertain');assert.deepEqual(policy.jobs.unknown.nativeReceipts,['partial-ack']);
 assert.equal(policy.jobs.confirmed.state,'confirmed');assert.equal(runtime.outbox.i.state,'uncertain');assert.equal(policy.settings.automatic,false);
 assert.deepEqual(protectContactRollback(runtime,policy,options,'0.3.0-whalenest.m3.12'),{disableContact:false,held:0});
 await writeFile(join(dataDir,'companion-policy.json'),JSON.stringify(policy));
 const next=createCompanionPolicy(options,route,{now:()=>Date.parse('2026-11-16T02:00:00Z')});
 assert.equal(next.status().usage.modelRequests,3);assert.equal(next.status().usage.automaticMessages,1);assert.equal(next.status().contact.nextAt,1234);
 assert.equal(next.getJob('confirmed').nativeReceipts[0],'ack');assert.equal(next.status().settings.contactEnabled,false);
 assert.deepEqual(protectContactRollback({}, {schema:2},options,'0.3.0-whalenest.m3.13'),{disableContact:false,held:0});
});
