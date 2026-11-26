import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createExpressions} from '../src/expressions.mjs';
import {createStickerStore} from '../src/aurabot-stickers.generated.mjs';
import {normalize} from '../vendor/aurabot/src/core/config.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'whalenest-default-stickers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dataDir=join(root,'data'),assets=join(root,'product-assets');
  await mkdir(join(dataDir,'aurabot'),{recursive:true});await mkdir(join(assets,'images'),{recursive:true});
  process.env.AURABOT_DATA_DIR=join(dataDir,'aurabot');
  const items=[];
  for(const [name,file,format]of [['预置庆祝','image.png','PNG'],['预置陪伴','animation.gif','GIF']]){
    const bytes=await readFile(new URL('./fixtures/media/'+file,import.meta.url));
    const sha256=createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(assets,'images',sha256),bytes);
    items.push({name,primaryScene:'庆祝',tags:['庆祝','通用'],direction:'给对方',suggestedAutomatic:true,
      media:{sha256,format,bytes:bytes.length}});
  }
  const catalog=join(assets,'catalog.json');await writeFile(catalog,JSON.stringify({version:1,items}));
  const options={instanceId:'fixture',dataDir,cwd:root,owners:[],expressions:{enabled:true,stickerCatalog:catalog}};
  const cfg=normalize({dryRun:true,stickers:{caption:false}});
  const store=createStickerStore({getConfig:()=>cfg,log:{info(){},warn(){},debug(){}},
    onebot:{call(){throw Error('Default resources must not modify QQ favorites');}}});
  t.after(()=>store.dispose());
  const deps={getConfig:()=>cfg,store,mood:{label:()=>'',effects:()=>({sticker:1,voice:1})},
    policy:{status:()=>({settings:{paused:false}})},senderFor:()=>({send(){throw Error('Initialization must not send messages');}})};
  return {root,dataDir,assets,catalog,items,options,store,deps,
    async boot(){const service=await createExpressions({},options,deps);t.after(()=>service.dispose());return service;}};
}

test('a legacy single-sticker instance receives the reviewed defaults without overwriting its current material',async t=>{
  const f=await fixture(t),bytes=await readFile(new URL('../vendor/aurabot/assets/dafeiyu.jpg',import.meta.url));
  const old=(await f.store.addFromBuffer(bytes,{name:'原有素材',tags:['不随机','用户标签'],toQQ:false})).item;
  f.store.markUsed(old.md5);
  await mkdir(join(f.dataDir,'expressions'));await writeFile(join(f.dataDir,'expressions/seed.json'),JSON.stringify({source:'aurabot/assets/dafeiyu.jpg'}));
  const service=await f.boot();assert.equal(service.status().stickerCount,3);
  const library=f.store.library().items,retained=library.find(item=>item.md5===old.md5);
  assert.equal(retained.name,'原有素材');assert.deepEqual(retained.tags,['不随机','用户标签']);assert.equal(retained.uses,1);
  for(const item of f.items){const imported=library.find(value=>value.name===item.name);assert.deepEqual(imported.tags,['庆祝','通用','给对方']);}
});

test('normal restart preserves user edits and deletions; a complete user reset restores the protected defaults',async t=>{
  const f=await fixture(t);await f.boot();assert.equal(f.store.library().items.length,2);
  const [first,second]=f.store.library().items;
  f.store.rename(first.md5,'主人修改的名字',['不随机','用户标签'],{toQQ:false});
  await f.store.remove(second.md5,{fromQQ:false});await f.boot();
  assert.equal(f.store.library().items.length,1);assert.equal(f.store.library().items[0].name,'主人修改的名字');
  assert.deepEqual(f.store.library().items[0].tags,['不随机','用户标签']);
  await rm(f.dataDir,{recursive:true});await mkdir(join(f.dataDir,'aurabot'),{recursive:true});
  const fresh=await f.boot();assert.equal(fresh.status().stickerCount,2);
  assert.deepEqual(f.store.library().items.map(item=>item.name),f.items.map(item=>item.name));
});

test('a damaged default resource is rejected before importing a partial library',async t=>{
  const f=await fixture(t);await writeFile(join(f.assets,'images',f.items[1].media.sha256),'damaged');
  await assert.rejects(f.boot(),/Sticker file/);assert.equal(f.store.library().items.length,0);
});

test('interrupted initialization resumes without duplicating a previously imported default',async t=>{
  const f=await fixture(t),add=f.store.addFromBuffer;let interrupted=true;
  f.store.addFromBuffer=async(bytes,metadata)=>{
    if(metadata.name==='预置陪伴'&&interrupted){interrupted=false;throw Error('interrupted import');}
    return add(bytes,metadata);
  };
  await assert.rejects(f.boot(),/interrupted import/);assert.equal(f.store.library().items.length,1);
  await f.boot();assert.equal(f.store.library().items.length,2);
  await f.boot();assert.equal(f.store.library().items.length,2);
});

test('a catalog path inside erasable user data is rejected even when it links to protected resources',async t=>{
  const f=await fixture(t),link=join(f.dataDir,'catalog-link.json');await symlink(f.catalog,link);
  f.options.expressions.stickerCatalog=link;
  await assert.rejects(f.boot(),/outside user data/);assert.equal(f.store.library().items.length,0);
});
