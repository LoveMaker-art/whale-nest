import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function buildAurabotQQSocial(root,provenance){
 const source=async path=>{const b=await readFile(new URL('vendor/aurabot/src/'+path,root));assert.equal(createHash('sha256').update(b).digest('hex'),provenance.files['src/'+path]);return b.toString();};
 const patch=(s,a,b)=>{assert.equal(s.split(a).length,2,'QQ social baseline changed: '+a);return s.replace(a,b);};
 let f=await source('features/qzone-social.js');f=f.replaceAll("from '../", "from '../vendor/aurabot/src/");
 f=patch(f,'{ getConfig, onebot, hub, log, memory })','{ getConfig, onebot, hub, log, memory, lifecycle })');
 for(const loop of ['for (const m of list?.msglist || []) {','for (const c of d?.comments || []) {','for (const f of pickFeeds(res?.feeds, self())) {'])f=patch(f,loop,loop+'\n      if (lifecycle?.canContinue && !lifecycle.canContinue()) break');
 f=patch(f,"        record(s, { kind: 'reply', who: last.name, post: String(m.content).slice(0, 30), text })", "        record(s, { kind: 'reply', who: last.name, post: String(m.content).slice(0, 30), text })\n        s.replied[m.tid] = [...handled].slice(-200)\n        save(s)");
 f=patch(f,"      record(s, { kind: 'comment', who: f.nickname, post: content.slice(0, 30), text })", "      record(s, { kind: 'comment', who: f.nickname, post: content.slice(0, 30), text })\n      s.seen = [...seen].slice(-300)\n      save(s)");
 f=patch(f,'  async function tick() {','  async function tick() {\n    if (lifecycle?.tick) return lifecycle.tick(() => run())');
 f=patch(f,'const replies = c.replyOwn ?', 'const replies = c.replyOwn && (!lifecycle?.canContinue || lifecycle.canContinue()) ?');
 f=patch(f,'const comments = c.commentFriends ?', 'const comments = c.commentFriends && (!lifecycle?.canContinue || lifecycle.canContinue()) ?');
 await writeFile(new URL('src/aurabot-qq-social.generated.mjs',root),'// Generated original QQ social business; shared budget gates and partial progress only.\n'+f);
 let m=await source('modules/qzone-social/index.js');
 m=patch(m,"from '../../features/qzone-social.js'", "from './aurabot-qq-social.generated.mjs'");
 m=patch(m,'createQzoneSocial({ getConfig:', 'createQzoneSocial({ lifecycle: api.qqSocialLifecycle, getConfig:');
 await writeFile(new URL('src/aurabot-qq-social-module.generated.mjs',root),'// Generated from the pinned original QQ space module.\n'+m);
}
