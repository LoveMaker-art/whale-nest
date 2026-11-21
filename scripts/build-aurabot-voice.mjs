import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function buildAurabotVoice(root,provenance,hub){
 const bytes=await readFile(new URL('vendor/aurabot/src/modules/voice/index.js',root));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.files['src/modules/voice/index.js']);
 let module=bytes.toString().replaceAll("from '../../", "from '../vendor/aurabot/src/");
 module=module.replace('async function speak(text) {','async function speak(text, request) {\n      if (api.voicePorts?.enabled) return api.voicePorts.speak(text, request)');
 await writeFile(new URL('src/aurabot-voice.generated.mjs',root),'// Generated from pinned original voice module; injected platform backend only.\n'+module);
 const start=hub.indexOf('    // 对方明确要语音、她却只打了字：'),end=hub.indexOf('    if (hooks?.items)',start);
 assert.ok(start>=0&&end>start,'Original expression block missing');
 const original=hub.slice(start,end);
 const auto=original.indexOf('    // 按概率补一张表情');
 assert.ok(auto>0,'Original automatic sticker block missing');
 let selection=original.slice(0,auto).replaceAll('Math.random()','random()');
 selection=selection.replace('if (cfg.voice.enabled && items.length', 'if (!textOnly && opts.allowVoice !== false && cfg.voice.enabled && items.length');
 selection=selection.replace('if (opts.wantVoice && cfg.voice.enabled', 'if (!textOnly && opts.allowVoice !== false && opts.wantVoice && cfg.voice.enabled');
 selection=selection.replace('if (all.length <= cfg.voice.autoMaxChars', 'if (!/```|!\\[|https?:\\/\\//.test(all) && all.length <= cfg.voice.autoMaxChars');
 const source=`// Generated from the pinned QQ Hub voice expression block. Both channels call this function.
import {requestedSticker} from './sticker-selection.mjs';
export function selectReplyItems(items,{cfg,mood,opts={},chatId='',random=Math.random}) {
 const textOnly=/(不要|不用|别|只用|仅用).{0,6}语音|文字回复|打字回复/.test(opts.userText??'');
 if (textOnly) items=items.map(i=>i.kind==='voice'?{...i,kind:'text'}:i);
 if (opts.manualMedia) return items.filter(i=>i.kind!=='sticker').map(i=>i.kind==='voice'?{...i,kind:'text'}:i);
 if (!requestedSticker(opts.userText??'')) items=items.filter(i=>i.kind!=='sticker');
 if (opts.backgroundJob) return items;
${selection}
 return items;
}
`;
 await writeFile(new URL('src/aurabot-expression.generated.mjs',root),source);
 return hub.replace(original,"    items = speech?.select ? speech.select(items, { cfg, mood, stickers, opts, chatId, random }) : selectReplyItems(items, { cfg, mood, stickers, opts, chatId, random })\n    const inGroup = chatId.startsWith('group:')\n");
}
