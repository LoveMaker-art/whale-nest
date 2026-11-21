import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildConnectBridge} from './build-connect.mjs';
import {buildRuntimeBase} from './build-runtime-base.mjs';
import {buildAurabotHost} from './build-aurabot-host.mjs';
import {updateCompatibility} from '../src/plugin-release.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const integrity=bytes=>'sha256-'+createHash('sha256').update(bytes).digest('base64');
export const distributionVersion=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;

export async function buildDistribution(destination,{target='linux-x64',version=distributionVersion,notes}={}){
 assert.ok(['linux-x64','darwin-arm64'].includes(target),'Unsupported distribution target');
 assert.ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),'Invalid distribution version');
 destination=resolve(destination);await mkdir(destination,{recursive:true,mode:0o700});
 await buildAurabotHost();
 const qrSource=JSON.parse(await readFile(join(root,'vendor/qrcode-generator/SOURCE.json')));
 for(const name of ['qrcode.cjs','LICENSE'])assert.equal(sha(await readFile(join(root,'vendor/qrcode-generator',name))),qrSource.files[name],'QR vendor source changed: '+name);
 const scoreSource=JSON.parse(await readFile(join(root,'vendor/abcjs/SOURCE.json')));
 for(const name of ['abcjs-basic-min.js','LICENSE.md','abcjs-basic-min.js.LICENSE'])
  assert.equal(sha(await readFile(join(root,'vendor/abcjs',name))),scoreSource.files[name],'ABCJS vendor source changed: '+name);
 const bridge=await buildConnectBridge(join(destination,'bridge'),{portable:true});
 const manifest=JSON.parse(await readFile(join(root,'integration/clawchat/base/manifest.json')));
 manifest.version=version;
 manifest.capabilities=manifest.capabilities.filter(c=>c.type==='runtime');
 manifest.dependencies=manifest.dependencies.filter(d=>d.id!=='managed-web-app-provider');
 const files={},sources={};
 const add=async(name,path)=>{
  const bytes=await readFile(path);sources[name]=sha(bytes);
  files[name]={encoding:'base64',content:bytes.toString('base64')};
 };
 await add('artifacts/'+target+'-base.mjs',await buildRuntimeBase(join(destination,'base'),{portable:true}));
 for(const name of ['deepseek-harness-tool-policy.mjs','deepseek-harness-question-provider.mjs'])await add('artifacts/'+name,join(destination,'bridge',name));
 await add('artifacts/deepseek-harness-bridge.mjs',bridge);
 const entry="import base from './"+target+"-base.mjs';\nimport {extendRuntimeEntry} from './whalenest/src/runtime-extension.mjs';\nexport default extendRuntimeEntry(base);\n";
 files['artifacts/'+target+'.mjs']={encoding:'utf8',content:entry};
 async function tree(relative){
  const entries=await readdir(join(root,relative),{withFileTypes:true});
  entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
  for(const item of entries){
   if(['node_modules','__pycache__'].includes(item.name)||item.name.startsWith('.')||item.name.endsWith('.pyc'))continue;
   if(relative==='src'&&item.name==='connector-extension.mjs')continue;
   const path=join(relative,item.name);
   if(item.isDirectory())await tree(path);
   else if(item.isFile())await add('artifacts/whalenest/'+path,join(root,path));
  }
 }
 for(const dir of ['src','vendor/aurabot','vendor/qrcode-generator','vendor/abcjs','vendor/platform-liveware','licenses'])await tree(dir);
 const lock=JSON.parse(await readFile(join(root,'upstream.lock.json')));
 const persona=lock.personaReference;
 for(const path of ['upstream.lock.json','vendor/aurabot.provenance.json',persona.localFile,persona.licenseFile,'integration/clawchat/LICENSE','integration/clawchat/SOURCE.json'])await add('artifacts/whalenest/'+path,join(root,path));
 assert.equal(sources['artifacts/whalenest/'+persona.localFile],persona.sha256,'Default persona content differs from source lock');
 assert.equal(sources['artifacts/whalenest/'+persona.licenseFile],persona.licenseSha256,'Default persona license differs from source lock');
 files['artifacts/whalenest/package.json']={encoding:'utf8',content:JSON.stringify({name:'whalenest-companion-runtime',private:true,type:'module',version})};
 manifest.artifacts=[{target,entry:'artifacts/'+target+'.mjs',integrity:integrity(entry)}];
 const bundle={format:'clawchat-connect-plugin-bundle-v1',manifest,files};
 const path=join(destination,'whalenest-companion-'+version+'-'+target+'.connect-plugin');
 await writeFile(path,JSON.stringify(bundle),{mode:0o600});
 const report={schema:1,pluginId:manifest.pluginId,version,target,compatibility:updateCompatibility,...(notes?{notes}:{}),files:Object.keys(files).length,sha256:sha(await readFile(path)),dataLocation:'DSH_HOME/companion/aurabot-v1',uninstall:'remove plugin code; preserve external instance data',sources};
 await writeFile(join(destination,'distribution.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 return path;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [, , destination='.whale-nest/distribution',target='linux-x64',version=distributionVersion,notesFile]=process.argv;
 const notes=notesFile?await readFile(notesFile,'utf8'):undefined;
 console.log(await buildDistribution(destination,{target,version,notes}));
}
