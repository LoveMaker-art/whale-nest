import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createStickerStore} from '../src/aurabot-stickers.generated.mjs';
import {stickerDirections,stickerScenes} from '../src/sticker-selection.mjs';
import {mimeOf} from '../vendor/aurabot/src/chat/inbound.js';

const digest = bytes=>createHash('sha256').update(bytes).digest('hex');
const formats = {GIF:'image/gif',PNG:'image/png',JPG:'image/jpeg',WEBP:'image/webp'};
const imageLimit = 5*1024*1024;

function readVerified(entry) {
  const stat=lstatSync(entry.file);
  assert.ok(stat.isFile()&&stat.size===entry.size,'Sticker file size or type changed');
  const bytes=readFileSync(entry.file);
  assert.equal(digest(bytes),entry.sha256,'Sticker file digest changed');
  assert.equal(mimeOf(bytes),entry.mime,'Sticker image format mismatch');
  return bytes;
}

export function verifyStickerCatalog(catalog) {
  const manifest=readFileSync(catalog);
  const {version,items}=JSON.parse(manifest);
  assert.ok(version===1&&Array.isArray(items)&&items.length>0&&items.length<=300,'Invalid sticker catalog');
  const seen=new Set();
  const entries=items.map(({name,primaryScene,tags,direction,suggestedAutomatic,media})=>{
    assert.ok(typeof name==='string'&&name.trim()&&name.length<=12,'Invalid sticker name');
    assert.ok(stickerScenes.includes(primaryScene)&&tags?.[0]===primaryScene&&stickerDirections.includes(direction)
      &&suggestedAutomatic===true,'Invalid sticker scene or direction');
    const reviewed=[...new Set([...tags,direction])];
    assert.ok(reviewed.length<=5&&reviewed.every(tag=>typeof tag==='string'&&/^[\p{L}\p{N}]{1,8}$/u.test(tag))
      &&!reviewed.includes('不随机'),'Invalid sticker tags');
    const {sha256,format,bytes:size}=media;
    assert.match(sha256,/^[0-9a-f]{64}$/);
    assert.ok(!seen.has(sha256)&&formats[format]&&Number.isInteger(size)&&size>0&&size<=imageLimit,'Invalid or repeated sticker image');
    seen.add(sha256);
    const entry={name,tags:reviewed,sha256,mime:formats[format],size,file:join(dirname(catalog),'images',sha256)};
    readVerified(entry);
    return entry;
  });
  return {manifestSha256:digest(manifest),entries,bytes:entries.reduce((total,entry)=>total+entry.size,0)};
}

export async function importStickerCatalog(catalog,dataDir) {
  process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
  const store=createStickerStore({getConfig:()=>({dryRun:true}),log:console});
  try {
    let added=0,existing=0;
    for(const entry of catalog.entries){
      const result=await store.addFromBuffer(readVerified(entry),{name:entry.name,tags:entry.tags,from:'manual',toQQ:false});
      assert.ok(result.ok,result.reason);
      if(result.existed)existing++;
      else added++;
    }
    return {added,existing,count:store.library().items.length};
  } finally { store.dispose(); }
}
