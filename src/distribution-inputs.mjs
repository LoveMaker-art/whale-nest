import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {bootstrapFiles} from './bootstrap-deployment.mjs';
/** Shared by the real bundle producer and the source-stage completeness check. */
export async function distributionInputs(root){
 const files=new Set([...bootstrapFiles(root),'integration/clawchat/SOURCE.json','integration/clawchat/LICENSE']);
 async function tree(dir){for(const item of await readdir(join(root,dir),{withFileTypes:true})){
  if(item.name.startsWith('.')||['node_modules','__pycache__','connector-extension.mjs'].includes(item.name)||item.name.endsWith('.pyc'))continue;
  const path=join(dir,item.name);if(item.isDirectory())await tree(path);else if(item.isFile())files.add(path);
 }}
 for(const dir of ['src','scripts','deploy','integration/clawchat/base','vendor/aurabot','vendor/qrcode-generator','vendor/abcjs','vendor/platform-liveware','licenses'])await tree(dir);
 return [...files].sort();
}
