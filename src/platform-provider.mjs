import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {parseEnv} from 'node:util';

/** Read the existing credential and its paired base; never persist a copy. */
export async function readPlatformProvider(settings){
 assert.ok(settings?.enabled,'模型服务尚未启用');
 const config=JSON.parse(await readFile(settings.providerConfigPath,'utf8')),p=config.models?.providers?.[settings.provider??'clawling'];
 assert.ok(p?.apiKey&&p.baseUrl,'模型接线不可用');const url=new URL(p.baseUrl);
 assert.ok(!url.username&&!url.password&&!url.search&&!url.hash,'模型接口地址不能夹带凭据或查询参数');
 assert.ok(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname),'模型服务需HTTPS或本机接口');
 let key=p.apiKey;if(key?.source==='env'){
  const name=key.id;let env={};try{env=parseEnv(await readFile(join(dirname(settings.providerConfigPath),'.env'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}key=env[name]??process.env[name];
 }
 assert.ok(typeof key==='string'&&key.trim(),'模型凭据不可用');return {base:p.baseUrl.replace(/\/+$/,''),key};
}
