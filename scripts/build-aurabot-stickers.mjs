import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** Preserve the original store; only make QQ rename synchronization explicit. */
export async function buildAurabotStickers(root,provenance){
 const original=await readFile(new URL('vendor/aurabot/src/features/stickers.js',root));
 assert.equal(createHash('sha256').update(original).digest('hex'),provenance.files['src/features/stickers.js']);
 let text=original.toString().replaceAll("from '../", "from '../vendor/aurabot/src/");
 assert.equal(text.split('function rename(md5, name, tags)').length,2);
 text=text.replace('function rename(md5, name, tags)','function rename(md5, name, tags, { toQQ = true } = {})');
 text=text.replace('if (it.emojiId && !getConfig().dryRun) onebot.call', 'if (toQQ && it.emojiId && !getConfig().dryRun) onebot.call');
 const download='fetchImage(url, { maxBytes: 1024 * 1024 * 1024 })';
 assert.equal(text.split(download).length,2);
 text=text.replace(download,'fetchImage(url, { maxBytes: 5 * 1024 * 1024 })');
 text=text.replace('added++; named.push({ md5, buf })','added++; if (getConfig().stickers.caption) named.push({ md5, buf })');
 await writeFile(new URL('src/aurabot-stickers.generated.mjs',root),'// Generated from pinned original sticker store; bounded import and explicit rename synchronization.\n'+text);
 const moduleBytes=await readFile(new URL('vendor/aurabot/src/modules/stickers/index.js',root));
 assert.equal(createHash('sha256').update(moduleBytes).digest('hex'),provenance.files['src/modules/stickers/index.js']);
 const module=moduleBytes.toString().replace("from '../../features/stickers.js'", "from './aurabot-stickers.generated.mjs'").replaceAll("from '../../", "from '../vendor/aurabot/src/");
 await writeFile(new URL('src/aurabot-stickers-module.generated.mjs',root),'// Generated from pinned original stickers module; same store, adapted tool entrypoints.\n'+module);
}
