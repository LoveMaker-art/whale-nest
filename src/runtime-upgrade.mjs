import assert from 'node:assert/strict';
import {hash,routeKey,senderKey,ownerScope} from './routing.mjs';
import {defaultPlatformVoice} from './speech.mjs';
const reviewedReleases=['1.0.0-beta.3','1.0.0-beta.4.dev.1','1.0.0-beta.4.dev.4','1.0.0-beta.4.dev.5','1.0.0-beta.4.dev.6','1.0.0-beta.4.dev.7','1.0.0-beta.4.dev.8','1.0.0-beta.4.dev.9','1.0.0-beta.4.dev.10','1.0.0-beta.4.dev.11','1.0.0-beta.4.dev.12','1.0.0-beta.4.dev.13','1.0.0-beta.4.dev.14','1.0.0-beta.4.dev.15','1.0.0-beta.4.dev.16','1.0.0-beta.4.dev.17','1.0.0-beta.4.dev.18','1.0.0-beta.4.dev.19','1.0.0-beta.4.dev.20','1.0.0-beta.4.dev.21','1.0.0-beta.4.dev.22','1.0.0'];
function supportsM3Writer(version,minimum){
 if(reviewedReleases.includes(version))return true;
 const m3=/^0\.3\.0-whalenest\.m3\.(\d+)$/.exec(version);
 if(m3)return Number(m3[1])>=minimum;
 // The M4 runtime inherited the feature writers from m3.27.
 const m4=/^0\.3\.0-whalenest\.m4\.1-dev\.(\d+)$/.exec(version);
 return m4!==null&&Number(m4[1])>=4;
}
/** Older writers do not understand inbox delivery gates or account limits. */
export function protectBiliRollback(runtime,inbox,targetVersion){
 if(supportsM3Writer(targetVersion,4))return {disableActivities:false,held:0};let held=0;
 for(const intent of Object.values(runtime.outbox??{}))if(intent.biliNoticeId&&intent.state==='pending'){intent.state='uncertain';intent.rollbackHold='bili-adapter-not-supported';held++;}
 for(const notice of Object.values(inbox.notices??{}))if(notice.state==='queued'){notice.state='held';notice.rollbackHold='bili-adapter-not-supported';}
 return {disableActivities:true,held};
}
/** Preserve new receipts and data while exposing them to the m3.13 writer. */
export function protectBiliOwnerRollback(data,options,targetVersion){
 if(supportsM3Writer(targetVersion,14))return {disableBrowse:false,held:0};
 const files=[data.account,data.rules,data.inbox,data.index,...(data.activities??[])].filter(Boolean),scope=ownerScope(options);
 if(!files.some(s=>s.schema===2&&s.scope===scope))return {disableBrowse:false,held:0};
 const route=options.clawchat.route,legacy=hash([options.instanceId,routeKey(route),senderKey(route)]);
 for(const s of files)if(s.schema===2&&s.scope===scope){s.schema=1;s.scope=legacy;}
 const jobs=new Set();let held=0;
 for(const job of Object.values(data.policy?.jobs??{}))if(job.kind==='browse'&&job.engine==='aurabot-bili'){
  jobs.add(job.id);if(job.state!=='confirmed'){job.cancelRequested=true;job.rollbackHold='original-bili-not-supported';job.state=job.inputId?'uncertain':'cancelled';}
 }
 for(const intent of Object.values(data.runtime.outbox??{}))if(intent.state==='pending'&&(intent.biliNoticeId||jobs.has(intent.companionJobId)||intent.source==='bili-browse')){
  intent.state='uncertain';intent.rollbackHold='shared-bili-not-supported';held++;
 }
 for(const notice of Object.values(data.inbox?.notices??{}))if(notice.state==='queued'){notice.state='held';notice.rollbackHold='shared-bili-not-supported';}
 if(data.policy)data.policy.settings.automatic=false;
 return {disableBrowse:true,held};
}
/** Older writers keep the new private text; only unsupported writers stop. */
export function protectDiaryRollback(data,options,targetVersion){
 const scope=ownerScope(options);
 if(supportsM3Writer(targetVersion,15))return {disableDiary:false,held:0};
 const diaries=data.diaries??[],publication=data.publications;
 if(!diaries.some(r=>r.schema===2&&r.scope===scope)&&!(publication?.schema===2&&publication.scope===scope))return {disableDiary:false,held:0};
 const route=options.clawchat.route,legacy=hash([options.instanceId,routeKey(route),senderKey(route)]);
 for(const record of diaries)if(record.schema===2&&record.scope===scope){record.schema=1;record.scope=legacy;}
 if(publication?.scope===scope){
  publication.schema=1;publication.scope=legacy;publication.retainedQQRecords??={};
  for(const [id,record]of Object.entries(publication.records))if(record.platform==='qq'){publication.retainedQQRecords[id]=record;delete publication.records[id];}else if(record.scope===scope)record.scope=legacy;
 }
 const ids=new Set();let held=0;
 for(const job of Object.values(data.policy?.jobs??{}))if(job.kind==='diary'&&job.engine==='aurabot-diary'){
  ids.add(job.id);if(job.state!=='confirmed'){job.cancelRequested=true;job.rollbackHold='original-diary-not-supported';job.state=job.inputId?'uncertain':'cancelled';}
 }
 for(const intent of Object.values(data.runtime?.outbox??{}))if(intent.state==='pending'&&(ids.has(intent.companionJobId)||intent.source==='diary-notice')){intent.state='uncertain';intent.rollbackHold='original-diary-not-supported';held++;}
 if(data.policy)data.policy.settings.automatic=false;
 return {disableDiary:true,held};
}
/** Re-expose the same data to an older writer without replaying new contacts. */
export function protectContactRollback(runtime,policy,options,targetVersion){
 if(!policy||policy.schema!==2||supportsM3Writer(targetVersion,13))return {disableContact:false,held:0};
 const ids=new Set();let held=0;
 for(const job of Object.values(policy.jobs??{}))if(job.kind==='contact'){
  ids.add(job.id);
  if(job.state!=='confirmed'){
   job.cancelRequested=true;job.rollbackHold='native-contact-not-supported';
   if(job.deliveryHeld||job.state==='uncertain'||job.state==='running')job.state='uncertain';else job.state='cancelled';
  }
 }
 for(const intent of Object.values(runtime.outbox??{}))if(ids.has(intent.companionJobId)&&intent.state==='pending'){
  intent.state='uncertain';intent.rollbackHold='native-contact-not-supported';held++;
 }
 policy.schema=1;const route=options.clawchat.route;
 policy.scope=hash([options.instanceId,routeKey(route),senderKey(route)]);
 policy.settings.automatic=false;policy.settings.contactEnabled=false;
 return {disableContact:true,held};
}
export function enablePlatformSpeech(speech={}){
 assert.ok(!speech.provider||speech.provider==='clawling','Existing speech provider differs from the selected platform');
 const existing=Boolean(speech.ttsModel);
 return {...speech,enabled:true,provider:'clawling',asrModel:speech.asrModel||'fun-asr-flash',language:speech.language??'zh',
  ttsModel:speech.ttsModel||'qwen-audio-3.0-tts-flash',voice:existing&&speech.voice?speech.voice:defaultPlatformVoice,
  responseFormat:existing?(speech.responseFormat??'pcm'):'pcm',sampleRate:speech.sampleRate??22050};
}
export function enablePlatformImage(image={}){
 assert.ok(!image.provider||image.provider==='clawling','Existing image provider differs from the selected platform');
 assert.ok(!image.model||image.model==='qwen-image-3.0','Image model must be verified before changing');
 return {...image,enabled:true,provider:'clawling',model:'qwen-image-3.0',size:image.size??'1024x1024'};
}
export function enablePlatformSinging(singing={}){
 assert.ok(!singing.provider||singing.provider==='clawling','Singing must use the selected platform');
 return {...singing,enabled:true,provider:'clawling',maxBytes:singing.maxBytes??32*1024*1024};
}
export function protectSongRollback(native,instance,targetVersion){
 if(supportsM3Writer(targetVersion,22))return {disableSinging:false};
 if(!instance.singing?.enabled&&!native.modules?.song?.enabled)return {disableSinging:false};
 instance.singing={...instance.singing,enabled:false};
 native.modules={...native.modules,song:{...native.modules?.song,enabled:false}};
 return {disableSinging:true};
}
export function protectImageRollback(native,instance,targetVersion){
 if(supportsM3Writer(targetVersion,18))return {disableImages:false};
 if(!instance.image?.enabled&&!native.modules?.imagegen?.enabled)return {disableImages:false};
 instance.image={...instance.image,enabled:false};native.imageGen={...native.imageGen,enabled:false};native.modules={...native.modules,imagegen:{...native.modules?.imagegen,enabled:false}};
 return {disableImages:true,artifactsAndReceiptsPreserved:true};
}
export function protectQQSocialRollback(native,targetVersion){
 if(supportsM3Writer(targetVersion,21))return {disableAutomaticSocial:false};
 if(!native.qzoneSocial?.enabled)return {disableAutomaticSocial:false};
 native.qzoneSocial={...native.qzoneSocial,enabled:false};return {disableAutomaticSocial:true,recordsAndBudgetPreserved:true};
}
export function protectVoiceRollback(native,instance,targetVersion){
 if(supportsM3Writer(targetVersion,16)||!native.voice?.platformVoice)return {disableNativeVoice:false};
 // Older builds do not have the platform port. Keep the current voice for
 // their ClawChat client and prevent the QQ module starting desktop TTS.
 instance.speech={...instance.speech,voice:native.voice.platformVoice};
 native.modules={...native.modules,voice:{...native.modules?.voice,enabled:false}};
 return {disableNativeVoice:true,voice:native.voice.platformVoice,receiptsPreserved:true};
}
