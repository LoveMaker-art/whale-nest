import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {dirname,join,resolve,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,readdirSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {readState,writeState} from './state.mjs';
import {routeKey,senderKey} from './routing.mjs';

const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const supported=new Set(['clawchat_send_file','clawchat_send_image','clawchat_send_voice','clawchat_send_message']);
// This is our tiny transaction mutex, never a platform database. OS-backed
// SQLite locks are released after a crash, including after container restarts.
const LockDatabase=process.versions.bun?(await import('bun:sqlite')).Database:(await import('node:sqlite')).DatabaseSync;
const active=new Map(),timers=new Map();
const within=(root,file)=>{const name=relative(root,file);return name&&!name.startsWith('..')&&!isAbsolute(name);};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}};
const canonical=path=>existsSync(path)?realpathSync(path):join(canonical(dirname(path)),path.slice(dirname(path).length+1));
export const officialDeliveryPaths=options=>{
 const data=canonical(resolve(options.dataDir)),workspace=canonical(resolve(options.cwd));
 const identity=sha(JSON.stringify([options.instanceId,data,options.clawchat.route]));
 return {root:join(data,'media','official',identity),temporary:join(workspace,'.whalenest-delivery',identity)};
};

function directories(options){
 const p=officialDeliveryPaths(options);
 for(const path of [p.root,join(p.root,'jobs'),join(p.root,'receipts'),p.temporary]){
  mkdirSync(path,{recursive:true,mode:0o700});assert.equal(realpathSync(path),path,'Delivery directories must not traverse symlinks');
 }
 return p;
}
function locked(p,action){
 const db=new LockDatabase(join(p.root,'writer.sqlite'));let transaction=false;
 try{
  db.exec('PRAGMA busy_timeout=5000');db.exec('BEGIN IMMEDIATE');transaction=true;
  const value=action();db.exec('COMMIT');transaction=false;return value;
 }catch(error){if(transaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
}
async function acquire(p,action){
 const until=Date.now()+5000;
 while(true){try{return locked(p,action);}catch(error){if(error.code!=='DELIVERY_BUSY'||Date.now()>=until)throw error;await delay(20);}}
}
function jobs(p){return readdirSync(join(p.root,'jobs')).filter(n=>n.endsWith('.json')).map(n=>{
 try{return readState(join(p.root,'jobs',n),null);}catch{return {id:n.slice(0,-5),state:'corrupt'};}
}).filter(Boolean);}
const receiptFile=(p,id)=>join(p.root,'receipts',id.slice(-64,-62),id+'.json');
function localRecord(p,id){
 const archive=receiptFile(p,id);
 return readState(archive,null)??readState(join(p.root,'jobs',id+'.json'),null)??readState(archive,null);
}
function archiveRecord(p,record){
 const compact={schema:1,id:record.id,scope:record.scope,tool:record.tool,sourceFingerprint:record.sourceFingerprint,sourceScope:record.sourceScope,
  fingerprint:record.fingerprint,state:record.state,createdAt:record.createdAt,finishedAt:record.finishedAt,
  ...(record.messageId?{messageId:record.messageId}:{}),...(record.error?{error:record.error}:{}),
  input:record.input.as_document===true?{as_document:true}:{},
  ...(record.artifact?{artifact:{name:record.artifact.name,kind:record.artifact.kind,mime:record.artifact.mime}}:{})};
 writeState(receiptFile(p,record.id),compact);unlinkSync(join(p.root,'jobs',record.id+'.json'));
}
function removeTemporary(p,record){
 if(!record.artifact?.temporary)return;
 const directory=join(p.temporary,record.id);
 assert.equal(dirname(record.artifact.path),directory,'Unexpected delivery artifact');
 if(existsSync(directory)){
  assert.ok(!lstatSync(directory).isSymbolicLink(),'Delivery artifact directory was replaced');
  rmSync(directory,{recursive:true,force:true});
 }
}
function sweepLocked(p){
 const records=jobs(p),known=new Map(records.map(r=>[r.id,r]));let removed=0;
 for(const record of records){
  if(record.state==='running'&&record.host===hostname()&&record.workerPid&&!alive(record.workerPid)){record.state='uncertain';record.error='原发送进程已退出，结果未知，不自动重发';record.finishedAt=Date.now();writeState(join(p.root,'jobs',record.id+'.json'),record);}
  if(record.state==='prepared'&&Date.now()>record.deadlineAt){record.state='failed';record.error='发送任务在提交前过期，未发送';writeState(join(p.root,'jobs',record.id+'.json'),record);}
  if(['confirmed','failed'].includes(record.state)){removeTemporary(p,record);archiveRecord(p,record);}
 }
 for(const entry of readdirSync(p.temporary,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const record=known.get(entry.name);
  // A directory without a journal cannot have been submitted: creation and
  // journal persistence share this lock, and submission occurs afterwards.
  const done=record&&['confirmed','failed'].includes(record.state);
  const stopped=record?.state==='uncertain'&&record.host===hostname()&&record.corePid
   &&!alive(record.corePid)&&(!record.workerPid||!alive(record.workerPid))&&Date.now()>record.deadlineAt;
  if(!record||done||stopped){rmSync(join(p.temporary,entry.name),{recursive:true,force:true});removed++;}
 }
 return {removed,retained:records.filter(r=>!['confirmed','failed'].includes(r.state)).length};
}
export function cleanupOfficialDelivery(options){
 const existing=officialDeliveryPaths(options);if(!existsSync(existing.root))return {removed:0,retained:0};
 const p=directories(options);return locked(p,()=>sweepLocked(p));
}
export function pendingOfficialDeliveries(options){
 const p=officialDeliveryPaths(options);if(!existsSync(join(p.root,'jobs')))return [];
 cleanupOfficialDelivery(options);
 return jobs(p).filter(record=>['prepared','running'].includes(record.state)).map(record=>({id:record.id,state:record.state}));
}
function temporaryBytes(p){
 let bytes=0;
 for(const directory of readdirSync(p.temporary,{withFileTypes:true})){
  assert.ok(directory.isDirectory()&&!directory.isSymbolicLink(),'Unexpected temporary delivery entry');
  for(const name of readdirSync(join(p.temporary,directory.name))){
   const stat=lstatSync(join(p.temporary,directory.name,name));
   assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Unexpected temporary delivery file');bytes+=stat.size;
  }
 }
 return bytes;
}
const fingerprint=job=>sha(JSON.stringify([job.scope,job.tool,job.input,job.artifact?.sha256]));
const view=record=>({state:['confirmed','failed'].includes(record.state)?record.state:'uncertain',requestId:record.id,
 ...(record.messageId?{messageId:record.messageId}:{}),...(record.error?{error:record.error}:{}),
 pending:record.state==='prepared'||record.state==='running'});

/** Own journals and temporary artifacts only. All external effects use the
 * public tool CLI. A lookup never invokes that CLI or resubmits an operation. */
export function createOfficialDelivery(options,route,{run}={}){
 assert.equal(routeKey(route),routeKey(options.clawchat.route),'Unverified delivery route');
 assert.equal(senderKey(route),senderKey(options.clawchat.route),'Unverified delivery sender');
 assert.ok(route.kind==='private'&&route.channel==='clawchat'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'Owner private delivery required');
 const p=directories(options),scope=sha(JSON.stringify([options.instanceId,resolve(options.dataDir),route]));
 const fileFor=id=>{assert.match(id,/^whalenest-[a-z-]+[a-f0-9]{64}$/);return join(p.root,'jobs',id+'.json');};
 const read=id=>{fileFor(id);const record=localRecord(p,id);if(record)assert.equal(record.scope,scope,'Delivery scope conflict');return record;};
 if(!timers.has(p.root)){
  const timer=setInterval(()=>{try{cleanupOfficialDelivery(options);}catch{/* A live writer owns this pass. */}},600000);timer.unref();timers.set(p.root,timer);
 }
 return {
  inspect:id=>read(id),
  check:id=>{const record=read(id);assert.ok(record,'Unknown delivery request');return view(record);},
  cleanup:()=>cleanupOfficialDelivery(options),
  async submit({id,tool,input,artifact,bytes,sourceFingerprint,sourceScope},{signal,waitMs=125000}={}){
   signal?.throwIfAborted();assert.ok(supported.has(tool),'Unsupported official delivery tool');
   const file=fileFor(id),draft={schema:1,id,scope,tool,input:structuredClone(input),sourceFingerprint,sourceScope,...(artifact?{artifact:structuredClone(artifact)}:{})};
   // Fingerprint source content and caller parameters, not a regenerated path.
   const expected=fingerprint(draft);
   let created=false;
   const record=await acquire(p,()=>{
    sweepLocked(p);const previous=read(id);
    if(previous){assert.equal(previous.fingerprint,expected,'Delivery request ID conflict');return previous;}
    if(artifact){
     assert.ok(Buffer.isBuffer(bytes)&&sha(bytes)===artifact.sha256,'Delivery artifact content changed');
     const direct=artifact.direct===true;
     if(!direct){
      const budget=options.media?.temporaryMaxBytes??128*1024*1024;
      assert.ok(Number.isSafeInteger(budget)&&budget>0,'Invalid delivery temporary budget');
      const maxFiles=options.media?.temporaryMaxFiles??128;
      assert.ok(Number.isSafeInteger(maxFiles)&&maxFiles>0,'Invalid delivery temporary file count');
      assert.ok(readdirSync(p.temporary).length<maxFiles,'临时附件数量已达上限，尚未提交发送；原作品保留');
      assert.ok(temporaryBytes(p)+bytes.length<=budget,'临时附件空间不足，尚未提交发送；原作品保留');
      const dir=join(p.temporary,id);mkdirSync(dir,{mode:0o700});
      const target=join(dir,artifact.name);writeFileSync(target,bytes,{flag:'wx',mode:0o400});
      draft.artifact={...draft.artifact,path:target,temporary:true};draft.input.path=target;
     }else{
      assert.ok(within(realpathSync(options.cwd),realpathSync(artifact.path)),'Direct artifact must be in Workspace');
      assert.equal(sha(readFileSync(artifact.path)),artifact.sha256,'Direct artifact changed');
     }
    }
    Object.assign(draft,{fingerprint:expected,state:'prepared',host:hostname(),submitterPid:process.pid,
     createdAt:Date.now(),deadlineAt:Date.now()+125000,delivery:{connectBin:options.clawchat.delivery.connectBin,configPath:options.clawchat.delivery.configPath},
     route:structuredClone(route),paths:p,cwd:options.cwd,instanceId:options.instanceId,
     integrationExecutable:options.pluginUpdates?.connectorExecutable??'/usr/local/bin/clawchat-dsh'});
    writeState(file,draft);created=true;return draft;
   });
   if(created){
    if(run){const task=executeOfficialDelivery(file,{run}).catch(()=>{});active.set(file,task);task.finally(()=>active.delete(file));}
    else{
     const node=process.env.WHALENEST_NODE_EXECUTABLE??(process.versions.bun?'node':process.execPath);
     const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG','LC_ALL','NODE_OPTIONS','BUN_OPTIONS','WHALENEST_NODE_EXECUTABLE','WHALENEST_SOURCE_INSTANCE','CLAWNEST_INSTANCE_ID']
      .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
     const child=spawn(node,[fileURLToPath(new URL('./official-delivery-worker.mjs',import.meta.url)),file],
      {cwd:options.cwd,detached:true,stdio:'ignore',env});
     child.once('error',error=>{try{const current=read(id);if(current?.state==='prepared'){current.state='failed';current.error='发送执行方未启动：'+error.message;writeState(file,current);cleanupOfficialDelivery(options);}}catch{}});
     child.unref();
    }
   }
   if(!created&&!['prepared','running'].includes(record.state))return view(record);
   const until=Date.now()+waitMs;
   while(Date.now()<until){
    const current=read(id);
    if(!['prepared','running'].includes(current.state))return view(current);
    if(signal?.aborted)return view(current);
    await delay(20);
   }
   return view(read(id));
  },
 };
}

export async function executeOfficialDelivery(file,{run=exec}={}){
 let record=readState(file,null);assert.ok(record?.schema===1&&supported.has(record.tool),'Invalid delivery job');
 const p=record.paths;assert.equal(file,join(p.root,'jobs',record.id+'.json'));
 const admitted=await acquire(p,()=>{
  record=readState(file,null);if(record.state!=='prepared')return false;
  if(Date.now()>record.deadlineAt){record.state='failed';record.error='发送任务在提交前过期，未发送';writeState(file,record);removeTemporary(p,record);return false;}
  record.state='running';record.workerPid=process.pid;record.startedAt=Date.now();writeState(file,record);return true;
 });
 if(!admitted)return;
 try{
  const {connectBin,configPath}=record.delivery;
  const state=JSON.parse((await run(connectBin,['__clawnest-state','--config',configPath],
   {cwd:record.cwd,timeout:10000,maxBuffer:1024*1024,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath}})).stdout);
  assert.ok(state.ownerId===record.route.sender&&state.conversationId===record.route.conversation
   &&state.userId&&state.connected===true,'发送前账号、原私聊或连接状态已变化，未提交');
  if(existsSync(record.integrationExecutable))try{
   const status=JSON.parse((await run(record.integrationExecutable,['plugin','status'],{cwd:record.cwd,timeout:5000,maxBuffer:1024*1024})).stdout);
   if(status.running?.health?.identity===state.userId)record.corePid=status.running.pid;
  }catch{/* Missing optional process evidence keeps uncertain files pinned. */}
  if(record.artifact){
   assert.ok(!lstatSync(record.artifact.path).isSymbolicLink(),'附件路径已改变，未提交');
   assert.equal(sha(readFileSync(record.artifact.path)),record.artifact.sha256,'附件内容已改变，未提交');
  }
  record.submittedAt=Date.now();writeState(file,record);
  let response;
  try{response=JSON.parse((await run(connectBin,['tool','call',record.tool,'--agent',record.route.account,
   '--request-id',record.id,'--input-json',JSON.stringify(record.input),'--config',configPath],
   {cwd:record.cwd,timeout:125000,maxBuffer:1024*1024,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath}})).stdout);}
  catch(error){if(error.stdout)try{response=JSON.parse(String(error.stdout));}catch{}
   if(!response)throw error;}
  record.response=response;
  if(response.status==='succeeded'&&response.result?.sent===true&&typeof response.result.messageId==='string'&&response.result.messageId.trim()){
   record.state='confirmed';record.messageId=response.result.messageId;
  }else if(['failed','denied'].includes(response.status)){
   const error=String(response.error??'官方工具拒绝发送');
   record.state=response.status==='failed'&&/transport|socket|closed|disconnect|timeout|timed out|acknowledg|deadline|connection|epipe|econn|\beof\b|outcome.*unknown|网络|超时|断开/i.test(error)?'uncertain':'failed';
   record.error=error.slice(0,300);
  }
  else{record.state='uncertain';record.error='发送结果待确认，不自动重发';}
 }catch(error){
  record.state=record.submittedAt?'uncertain':'failed';
  if(error.code==='ENOENT'||/^unknown ClawChat tool:/.test(String(error.stderr??'').trim()))record.state='failed';
  record.error=record.submittedAt?'发送返回中断或结果待确认，不自动重发':String(error.message).slice(0,300);
 }finally{
  record.finishedAt=Date.now();writeState(file,record);
  try{await acquire(p,()=>sweepLocked(p));}catch{/* Next maintenance pass retries only cleanup. */}
 }
 return view(record);
}
