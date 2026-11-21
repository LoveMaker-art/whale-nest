import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImageClient} from '../src/image-client.mjs';
import {createImageGen} from '../src/aurabot-image.generated.mjs';
import {savePainting} from '../src/aurabot-painting-save.generated.mjs';
import {listPaintings,rememberPainting,resolvePainting} from '../vendor/aurabot/src/features/paintings.js';
import {normalize} from '../vendor/aurabot/src/core/config.js';
import {enablePlatformImage,protectImageRollback} from '../src/runtime-upgrade.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'whalenest-image-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=join(root,'provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://model.test/v1',apiKey:{source:'env',id:'IMAGE_FIXTURE_KEY'}}}}}));await writeFile(join(root,'.env'),'IMAGE_FIXTURE_KEY=image-key\n');
 const options={dataDir:join(root,'data'),image:enablePlatformImage({providerConfigPath:provider})},png=await readFile(new URL('./fixtures/media/image.png',import.meta.url));return {root,options,png};}
test('original createImageGen calls one selected platform for generation/editing, with no local fallback or credential on downloads',async t=>{
 const f=await fixture(t),requests=[],cfg=normalize({imageGen:{enabled:true}});
 const deps={verifyResultURL:async()=>{},fetchImpl:async(url,init)=>{requests.push({url,init});if(url.endsWith('/generations')){const body=JSON.parse(init.body);assert.equal(body.model,'qwen-image-3.0');assert.equal(body.n,1);assert.equal(body.response_format,'url');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer image-key');return Response.json({data:[{url:'https://images.test/result.png'}]});}assert.ok(!init.headers);return new Response(f.png);}};
 let client=createImageClient(f.options,deps);const gen=createImageGen({platform:client,getConfig:()=>cfg,local:{active(){throw Error('Must not use local generator');}},log:{info(){}},codexAuth:{dispose(){}}});
 const [a,b]=await Promise.all([gen.generate('海边的小鱼',{requestId:'one'}),gen.generate('海边的小鱼',{requestId:'one'})]);assert.deepEqual(a,b);assert.equal(requests.length,2);
 client=createImageClient(f.options,deps);assert.deepEqual(await client.generate('海边的小鱼',{requestId:'one'}),f.png);assert.equal(requests.length,2);
 await gen.generate('把小鱼改成蓝色',{requestId:'edit',image:f.png});assert.equal(requests.filter(r=>r.init.method==='POST').length,2);const edit=JSON.parse(requests.findLast(r=>r.init.method==='POST').init.body);assert.ok(Array.isArray(edit.image)&&edit.image.length===1);assert.match(edit.image[0],/^data:image\/png;base64,/);
});
test('unknown image submissions never post again after restart, including parameter errors and cancellation',async t=>{
 const f=await fixture(t);let posts=0;
 for(const [id,fetchImpl]of [['network',async()=>{posts++;throw Error('lost connection');}],['parameter',async()=>{posts++;return Response.json({error:{code:'invalid_image'}},{status:400});}]]){
  const client=createImageClient(f.options,{fetchImpl,verifyResultURL:async()=>{}});await assert.rejects(client.generate('测试',{requestId:id}));const before=posts;
  await assert.rejects(createImageClient(f.options,{fetchImpl}).generate('测试',{requestId:id}),/不确定/);assert.equal(posts,before);
 }
 const controller=new AbortController();controller.abort();await assert.rejects(createImageClient(f.options,{fetchImpl:async()=>{posts++;}}).generate('测试',{requestId:'cancel',signal:controller.signal}));assert.equal(posts,2);
});
test('a returned URL is persisted before download; recover performs only GET and never leaks the model credential',async t=>{
 const f=await fixture(t);let posts=0,gets=0;
 const deps={verifyResultURL:async()=>{},fetchImpl:async(url,init)=>{if(init.method==='POST'){posts++;return Response.json({data:[{url:'https://cdn.test/a.png'}]});}gets++;assert.ok(!init.headers);if(gets===1)throw Error('download lost');return new Response(f.png);}};
 const client=createImageClient(f.options,deps);await assert.rejects(client.generate('先保存结果',{requestId:'recover'}),/download lost/);assert.equal(client.inspect('recover').state,'received');
 assert.deepEqual(await createImageClient(f.options,deps).recover('recover'),f.png);assert.equal(posts,1);assert.equal(gets,2);
});
test('reference and size validation reject unsupported requests before any billable call',async t=>{
 const f=await fixture(t);let calls=0;const c=createImageClient(f.options,{fetchImpl:async()=>{calls++;}});
 await assert.rejects(c.generate('测试',{requestId:'gif',image:await readFile(new URL('./fixtures/media/animation.gif',import.meta.url))}),/PNG/);
 await assert.rejects(c.generate('测试',{requestId:'small',size:'16x16'}),/尺寸/);assert.equal(calls,0);
});
test('original paintings archive stays shared; stable saves neither overwrite same-second requests nor duplicate after restart',async t=>{
 const f=await fixture(t);await mkdir(join(f.options.dataDir,'aurabot'),{recursive:true});process.env.AURABOT_DATA_DIR=join(f.options.dataDir,'aurabot');
 const now=new Date('2026-11-17T02:00:00Z'),a=savePainting(f.png,'相同提示',{now,requestId:'a'}),b=savePainting(f.png,'相同提示',{now,requestId:'b'});assert.notEqual(a,b);
 assert.equal(savePainting(f.png,'相同提示',{now:new Date(now.getTime()+60000),requestId:'a'}),a);assert.equal(listPaintings({}).total,2);
 rememberPainting('private:123',a);rememberPainting('clawchat:session',b);assert.equal(resolvePainting('private:123','#1').path,a);assert.equal(resolvePainting('clawchat:session','#1').path,b);
});
test('rollback disables the unsupported older image writer and retains archives/receipts',()=>{
 const native={modules:{imagegen:{enabled:true}},imageGen:{enabled:true}},instance={image:{enabled:true,model:'qwen-image-3.0'}};
 assert.equal(protectImageRollback(native,instance,'0.3.0-whalenest.m3.18').disableImages,false);
 assert.equal(protectImageRollback(native,instance,'0.3.0-whalenest.m3.17').artifactsAndReceiptsPreserved,true);assert.equal(native.modules.imagegen.enabled,false);assert.equal(instance.image.enabled,false);
});
