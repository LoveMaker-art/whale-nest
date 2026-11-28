import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,copyFileSync,lstatSync,rmSync,readdirSync} from 'node:fs';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
export const bootstrapMode=name=>name.endsWith('.sh')?0o755:0o600;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seeds=['deploy/serve-media.mjs','deploy/startup-status.mjs','src/liveware-service.mjs','scripts/source-preload.mjs','src/platform-query.mjs','src/platform-operation-worker.mjs','deploy/serve-qq-gateway.py','deploy/qq_gateway_lifecycle.py','deploy/qq_gateway_memory.py','deploy/qq_login_window.py','deploy/stop-qq-desktop.py','deploy/qq-pre-stop.py','deploy/native-dsh-bridge.sh'];
/** Only our own bootstrap files and their static dependencies, not a connector layout. */
export function bootstrapFiles(root=fileURLToPath(new URL('../',import.meta.url))){
 const result=new Set(),visit=name=>{
  assert.ok(name&&!name.startsWith('../')&&!isAbsolute(name));if(result.has(name))return;result.add(name);
  if(!name.endsWith('.mjs'))return;
  const text=readFileSync(join(root,name),'utf8');
  for(const m of text.matchAll(/(?:from\s*|import\s*)['"]([.][.]?\/[^'"]+)['"]/g))visit(relative(root,resolve(root,dirname(name),m[1])));
 };
 for(const name of seeds)visit(name);return [...result];
}
export const retiredProgramFiles=['src/connector-extension.mjs','src/connector-cutover.mjs','integration/clawchat/core-media/LICENSE','integration/clawchat/core-media/README.md','integration/clawchat/core-media/SOURCE.json','integration/clawchat/core-media/core-extension.patch','integration/clawchat/core-media/runtime-lib.original.mjs','test/connector-extension.test.mjs','test/connector-cutover.test.mjs'];
export function programFiles(root=fileURLToPath(new URL('../',import.meta.url))){
 const files=new Set(bootstrapFiles(root));
 const tree=dir=>{if(!existsSync(join(root,dir)))return;for(const item of readdirSync(join(root,dir),{withFileTypes:true})){const name=join(dir,item.name);if(item.name.startsWith('.')||item.name==='__pycache__')continue;if(item.isDirectory())tree(name);else if(item.isFile())files.add(name);}};
 tree('src');tree('scripts');tree('deploy');tree('integration/clawchat/base');
 for(const name of ['integration/clawchat/SOURCE.json','integration/clawchat/LICENSE'])if(existsSync(join(root,name)))files.add(name);
 return [...files];
}
export function syncBootstrap(options,entry){
 const project=entry.bootstrapRoot;assert.ok(isAbsolute(project??''),'This instance has not registered its own bootstrap root');
 const root=entry.ownedRoot,files=programFiles(root),changes=[];
 for(const name of files){
  const target=join(project,name),bytes=readFileSync(join(root,name));
  if(existsSync(target)){assert.ok(!lstatSync(target).isSymbolicLink());if(hash(readFileSync(target))===hash(bytes))continue;}
  changes.push({name,target,bytes,expected:existsSync(target)?hash(readFileSync(target)):null});
 }
 for(const name of retiredProgramFiles){const target=join(project,name);if(existsSync(target))changes.push({name,target,bytes:null,expected:hash(readFileSync(target))});}
 if(!changes.length)return {changed:false};
 const backup=join(options.dataDir,'bootstrap-backups',randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});
 for(const [index,c]of changes.entries())if(c.expected)copyFileSync(c.target,join(backup,String(index)));
 const record=changes.map(({name,target,expected,bytes},index)=>({name,target,before:expected,after:bytes?hash(bytes):null,index}));writeFileSync(join(backup,'files.json'),JSON.stringify(record));
 const completed=[];
 try{
  for(const c of changes){assert.equal(existsSync(c.target)?hash(readFileSync(c.target)):null,c.expected,'Bootstrap was edited during update');if(!c.bytes){rmSync(c.target);completed.push(c);continue;}mkdirSync(dirname(c.target),{recursive:true,mode:0o700});const temp=c.target+'.'+randomUUID();writeFileSync(temp,c.bytes,{mode:bootstrapMode(c.name)});renameSync(temp,c.target);completed.push(c);}
 }catch(error){
  for(const c of completed.reverse())if((existsSync(c.target)?hash(readFileSync(c.target)):null)===(c.bytes?hash(c.bytes):null)){if(c.expected)copyFileSync(join(backup,String(changes.indexOf(c))),c.target);else rmSync(c.target);}
  throw error;
 }
 return {changed:true,backup,files:changes.length};
}
