import assert from 'node:assert/strict';
import {existsSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {verifyStickerCatalog,readVerifiedSticker} from './sticker-catalog.mjs';
import {readState,writeState} from './state.mjs';

/** The reviewed product resources live outside erasable user data. The
 * original library remains the single editable copy shared by both channels. */
export function inspectDefaultStickerCatalog(options){
  const path=options.expressions?.stickerCatalog;
  if(path===undefined)return null;
  assert.ok(typeof path==='string'&&isAbsolute(path),'Default sticker catalog needs an absolute product resource path');
  const data=existsSync(options.dataDir)?realpathSync(options.dataDir):resolve(options.dataDir);
  const outside=(root,target)=>{const value=relative(root,target);return value==='..'||value.startsWith('..'+sep)||isAbsolute(value);};
  assert.ok(outside(resolve(options.dataDir),resolve(path))&&outside(data,realpathSync(path)),
    'Default sticker resources must live outside user data so a reset preserves them');
  return {path,...verifyStickerCatalog(path)};
}

export async function initializeDefaultStickers(options,store){
  const catalog=inspectDefaultStickerCatalog(options);
  if(!catalog)return null;
  const file=join(options.dataDir,'expressions/seed.json'),previous=readState(file,null);
  const state=previous?.schema===2?previous:{schema:2,instanceId:options.instanceId,imported:{},
    ...(previous?{legacy:previous}:{}),initializedAt:new Date().toISOString()};
  assert.equal(state.instanceId,options.instanceId,'Default sticker initialization belongs to a different instance');
  assert.ok(state.imported&&typeof state.imported==='object'&&!Array.isArray(state.imported));
  let added=0,existing=0;
  for(const entry of catalog.entries){
    // A successfully initialized item that is now absent was deleted by its
    // owner. Only an explicit complete user reset clears this record.
    if(Object.hasOwn(state.imported,entry.sha256))continue;
    const result=await store.addFromBuffer(readVerifiedSticker(entry),{
      name:entry.name,tags:entry.tags,from:'manual',toQQ:false,
    });
    assert.ok(result.ok,result.reason);assert.ok(result.item?.md5);
    if(result.existed)existing++;else added++;
    state.imported[entry.sha256]=result.item.md5;
    writeState(file,state);
  }
  if(state.catalogSha256!==catalog.manifestSha256){
    state.catalogSha256=catalog.manifestSha256;writeState(file,state);
  }
  return {added,existing,defaults:catalog.entries.length,count:store.library().items.length};
}
