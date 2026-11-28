import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {protectBiliRollback,protectBiliOwnerRollback,protectContactRollback,protectDiaryRollback,protectImageRollback,protectQQSocialRollback,protectSongRollback,protectVoiceRollback} from '../src/runtime-upgrade.mjs';

for(const previous of ['0.3.0-whalenest.m4.1-dev.19','1.0.0-beta.3','1.0.0-beta.4.dev.1','1.0.0-beta.4.dev.14','1.0.0-beta.4.dev.15','1.0.0']){
test('rolling back to '+previous+' preserves its companion writers and state',()=>{
 const instance={instanceId:'fixture',clawchat:{route:{platform:'clawchat',account:'dsh',sender:'owner',conversation:'dm'}},
  speech:{enabled:true},image:{enabled:true},singing:{enabled:true}};
 const native={voice:{platformVoice:'fixture'},qzoneSocial:{enabled:true},modules:{song:{enabled:true}}};
 const runtime={outbox:{fixture:{state:'pending',biliNoticeId:'notice'}}};
 const policy={schema:2,settings:{automatic:true,contactEnabled:true},jobs:{}};
 const diary={diaries:[{schema:2,scope:'fixture'}],runtime,policy};
 const inbox={notices:{notice:{state:'queued'}}};
 const before=structuredClone({instance,native,runtime,policy,diary,inbox});
 assert.equal(protectBiliRollback(runtime,inbox,previous).disableActivities,false);
 assert.equal(protectBiliOwnerRollback({inbox,runtime,policy},instance,previous).disableBrowse,false);
 assert.equal(protectContactRollback(runtime,policy,instance,previous).disableContact,false);
 assert.equal(protectDiaryRollback(diary,instance,previous).disableDiary,false);
 assert.equal(protectImageRollback(native,instance,previous).disableImages,false);
 assert.equal(protectQQSocialRollback(native,previous).disableAutomaticSocial,false);
 assert.equal(protectSongRollback(native,instance,previous).disableSinging,false);
 assert.equal(protectVoiceRollback(native,instance,previous).disableNativeVoice,false);
 assert.deepEqual({instance,native,runtime,policy,diary,inbox},before);
});
}
