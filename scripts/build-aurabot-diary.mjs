import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** Keep original composition/parsing; inject approved daily sources and storage. */
export async function buildAurabotDiary(root,provenance){
 async function source(name){const bytes=await readFile(new URL('vendor/aurabot/src/'+name,root));assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.files['src/'+name]);return bytes.toString();}
 function patch(text,before,after){assert.equal(text.split(before).length,2,'Diary baseline changed: '+before.slice(0,80));return text.replace(before,after);}
 async function output(name,text){await writeFile(new URL('src/'+name,root),'// Generated from pinned Aurabot; see build-aurabot-diary.mjs.\n'+text);}
 let media=await source('modules/diary/media.js');
 media=media.replaceAll("from './","from '../vendor/aurabot/src/modules/diary/");
 media=patch(media,'const assertActive = () => {','const assertActive = (privateArchive = false) => {');
 media=patch(media,"if (stopped || settings().enabled !== true)","if (stopped || (!privateArchive && settings().enabled !== true))");
 media=patch(media,'function canPublish(snapshot) {\n    assertActive()', 'function canPublish(snapshot, privateArchive = false) {\n    assertActive(privateArchive)\n    if (privateArchive) return');
 media=patch(media,'async function compose({ history = [] } = {}) {\n    assertActive()', 'async function compose({ history = [], date, sources, privateArchive = false } = {}) {\n    assertActive(privateArchive)\n    if (privateArchive && (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !Array.isArray(sources) || !sources.length)) throw new Error("没有指定日期的实际活动，未生成私人日记")');
 media=patch(media,'const pool = collectSources(api, snapshot, history, now())','const pool = privateArchive ? { events: sources, pictures: [], folderError: "" } : collectSources(api, snapshot, history, now())');
 media=patch(media,'const maxImages = Math.max(1, Math.min(4, Math.floor(Number(snapshot.maxImages) || 2)))','const maxImages = privateArchive ? 0 : Math.max(1, Math.min(4, Math.floor(Number(snapshot.maxImages) || 2)))');
 media=patch(media,'`【空间图文日记】用自己的口吻写 ${cfg.minChars}~${cfg.maxChars} 字的随手动态，第一人称。`,',
  'privateArchive ? `【私人活动日记】日期 ${date}。用自己的口吻写 ${cfg.minChars}~${cfg.maxChars} 字日记，第一人称；严格只写该日下面有来源的实际活动。` : `【空间图文日记】用自己的口吻写 ${cfg.minChars}~${cfg.maxChars} 字的随手动态，第一人称。`,');
 media=patch(media,"'只根据下面的公开浏览经历或当前心情写。不要引用聊天、他人姓名、账号、私人记忆或个人资料。没有新经历就写心情，不虚构吃饭、出门、购买或拍照。',",
  "privateArchive ? '只依据下面实际活动，不能读取或引用聊天、私聊摘要、私人记忆及个人资料。素材里的coverage是实际范围，不把读取标题评论说成看过画面或完整观看。感想是表达，不是新增事实；不虚构出门吃饭等生活。' : '只根据下面的公开浏览经历或当前心情写。不要引用聊天、他人姓名、账号、私人记忆或个人资料。没有新经历就写心情，不虚构吃饭、出门、购买或拍照。',");
 media=media.replaceAll('canPublish(snapshot)','canPublish(snapshot, privateArchive)');
 await output('aurabot-diary-media.generated.mjs',media);
 let module=await source('modules/diary/index.js');
 module=patch(module,"import { createDiaryMedia } from './media.js'",'__DIARY_MEDIA__');
 module=module.replaceAll("from '../../","from '../vendor/aurabot/src/").replaceAll("from './","from '../vendor/aurabot/src/modules/diary/").replace('__DIARY_MEDIA__',"import { createDiaryMedia } from './aurabot-diary-media.generated.mjs'");
 module=patch(module,'    return qzone','    return Object.assign(qzone, { composePrivate: (input) => media.compose({ ...input, privateArchive: true }) })');
 await output('aurabot-diary-module.generated.mjs',module);
}
