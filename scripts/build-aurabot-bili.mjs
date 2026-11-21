import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** The pinned Bili implementation, with data/transport ports, not a rewrite. */
export async function buildAurabotBili(root,provenance){
 async function source(name){const bytes=await readFile(new URL('vendor/aurabot/src/'+name,root));assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.files['src/'+name]);return bytes.toString();}
 function patch(text,before,after){assert.equal(text.split(before).length,2,'Bili baseline changed: '+before.slice(0,100));return text.replace(before,after);}
 const relocate=(text,dir)=>text.replaceAll("from '../","from '../vendor/aurabot/src/").replaceAll("from './","from '../vendor/aurabot/src/"+dir+'/');
 async function output(name,text){await writeFile(new URL('src/'+name,root),'// Generated from pinned Aurabot; see build-aurabot-bili.mjs.\n'+text);}

 let api=await source('bili/api.js');
 api=patch(api,"const j = await r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }))",
  "const j = await r.text().then(parseBiliJson).catch(() => ({ code: r.status, message: 'HTTP ' + r.status }))");
 api=patch(api,'      e.code = j.code','      e.code = j.code\n      e.definitelyNotApplied = [-101, -111, -400, -403, -404].includes(j.code)');
 api=patch(api,"    const r = await fetchImpl(imageUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })",
  "    const r = Buffer.isBuffer(imageUrl) ? { ok: true, status: 200, headers: { get: () => sniffImageType(imageUrl) }, arrayBuffer: async () => imageUrl } : await fetchImpl(imageUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })");
 await output('aurabot-bili-api.generated.mjs',"import {parseBiliJson} from './bili-json.mjs';\n"+relocate(api,'bili'));

 let duty=await source('bili/duty.js');
 duty=patch(duty,'api: injected, vision: see = lookWithVision, afterBrowse })',
  'api: injected, vision: see = lookWithVision, afterBrowse, loadState, saveState, onRead, onHistory, now = Date.now, day = () => dayKey(new Date(now())) })');
 const marker=duty.indexOf('export function createBili(');assert.ok(marker>0);
 let body=duty.slice(marker).replaceAll('Date.now()','now()').replaceAll('dayKey()','day()');
 body=patch(body,"const load = () => readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, lastRun: 0, lastReplyCheck: 0, seen: [], repliedFeed: [], history: [] }))",
  "const load = () => loadState ? loadState() : readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, lastRun: 0, lastReplyCheck: 0, seen: [], repliedFeed: [], history: [] }))");
 body=patch(body,'const save = (s) => writeJson(file(), s)','const save = (s) => saveState ? saveState(s) : writeJson(file(), s)');
 body=patch(body,'const record = (s, item) => { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 40) }',
  'const record = (s, item) => { if (onHistory) onHistory({ at: now(), ...item }); else { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 40) } }');
 body=patch(body,'const rawInfo = await api.view({ bvid: v.bvid })','const rawInfo = await api.view({ bvid: v.bvid, aid: v.aid })');
 body=patch(body,"const [subtitle, comments] = await Promise.all([api.subtitle(info).catch(() => ''), api.comments(info.aid).catch(() => [])])",
  "const reads = await Promise.allSettled([api.subtitle(info), api.comments(info.aid)])\n    const subtitle = reads[0].status === 'fulfilled' && typeof reads[0].value === 'string' ? reads[0].value : ''\n    const comments = reads[1].status === 'fulfilled' && Array.isArray(reads[1].value) ? reads[1].value : []");
 body=patch(body,'return { info, subtitle, comments, vision, shotIds, digest: digestOf(info, { subtitle, comments, vision }) }',
  "const result = { info, subtitle, comments, vision, shotIds, coverage: { metadata: true, subtitle: Boolean(subtitle), comments: reads[1].status === 'fulfilled' && Array.isArray(reads[1].value), vision: Boolean(vision) }, digest: digestOf(info, { subtitle, comments, vision }) }\n    await onRead?.(result)\n    return result");
 body=patch(body,'async function watch(text) {','async function watch(text, { details = false } = {}) {');
 body=patch(body,'return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title }',
  'return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title, ...(details ? { read: x } : {}) }');
 body=patch(body,'async function comment(text, rawMessage) {','async function comment(text, rawMessage, { root, parent, maxChars = 200 } = {}) {');
 body=patch(body,"const message = cleanOutboundText(atOwner(rawMessage || ''), { warn: (message) => log.warn(`B 站评论：${message}`) }).slice(0, 200)",
  "const message = cleanOutboundText(atOwner(rawMessage || ''), { warn: (message) => log.warn(`B 站评论：${message}`) }).slice(0, maxChars)");
 body=patch(body,'const r = await api.postComment(w.aid, message)','const r = await api.postComment(w.aid, message, { root, parent })');
 body=patch(body,"if (!/^https?:\\/\\//i.test(String(file || ''))) return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }",
  "if (!Buffer.isBuffer(file) && !/^https?:\\/\\//i.test(String(file || ''))) return { ok: false, message: '头像只能用网址图片、当前会话附件或刚才发的那张图' }");
 body=patch(body,'async function sendShot({ chatId, query = \'\' } = {}) {','async function sendShot({ chatId, query = \'\' } = {}) {');
 body=patch(body,'          await hub.sendText(`private:${getConfig().ownerQQ}`, `${share}\\n${link(v.bvid)}`)\n          shared++\n          record(s, { kind: \'share\', title: v.title, bvid: v.bvid, text: share })',
  '          const sent = await hub.sendText(`private:${getConfig().ownerQQ}`, `${share}\\n${link(v.bvid)}`)\n          if (sent?.message_id !== undefined) { shared++; record(s, { kind: \'share\', title: v.title, bvid: v.bvid, text: share }) }');
 duty=duty.slice(0,marker)+body;
 await output('aurabot-bili.generated.mjs',relocate(duty,'bili'));

 let module=await source('modules/bili/index.js');
 module=patch(module,"import { createBili } from '../../bili/duty.js'",'__BILI_IMPORT__');
 module=module.replaceAll("from '../profile/","from '../vendor/aurabot/src/modules/profile/")
  .replaceAll("from '../../","from '../vendor/aurabot/src/")
  .replaceAll("from './","from '../vendor/aurabot/src/modules/bili/");
 module=module.replace('__BILI_IMPORT__',"import { createBili } from './aurabot-bili.generated.mjs'");
 module=patch(module,'createBili({\n      getConfig:', 'createBili({\n      ...api.biliPorts,\n      getConfig:');
 module=patch(module,'const danmaku = createDanmaku(api)','const danmaku = createDanmaku(api, api.biliPorts?.danmaku)');
 module=patch(module,'afterBrowse: danmaku.afterBrowse,','afterBrowse: api.biliPorts?.afterBrowse ?? danmaku.afterBrowse,');
 module=patch(module,'const src = avatarSource(useLast ? previous : raw)',
  'const src = api.biliPorts?.avatarSource ? await api.biliPorts.avatarSource(raw, { chat, sessionId, previous }) : avatarSource(useLast ? previous : raw)');
 module=patch(module,"if (useLast && !previous) return { ok: false, message: '这个聊天里还没人发过可用的图片网址' }",
  "if (useLast && !previous && !api.biliPorts?.avatarSource) return { ok: false, message: '这个聊天里还没人发过可用的图片网址' }");
 await output('aurabot-bili-module.generated.mjs',module);
}
