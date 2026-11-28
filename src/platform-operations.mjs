import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {readState,writeState} from './state.mjs';
const execute=promisify(execFile),digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const Lock=process.versions.bun?(await import('bun:sqlite')).Database:(await import('node:sqlite')).DatabaseSync;
const tools=new Set(['clawchat_create_moment','clawchat_delete_moment','clawchat_upload_avatar_image','clawchat_update_account_profile','clawchat_register_app','clawchat_unregister_app']);
const verbs={liveware_app_create:['liveware','app','create'],liveware_tunnel_bind:['liveware','tunnel','bind']};
export const isPendingReceipt=r=>['prepared','pending','running'].includes(r?.status);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
export function classifyPlatformReceipt(response){
 if(response?.status==='failed'&&/transport|socket|closed|disconnect|timeout|timed out|acknowledg|deadline|connection|epipe|econn|\beof\b|outcome.*unknown|网络|超时|断开/i.test(String(response.error??'')))return {...response,status:'indeterminate'};
 return response;
}
function paths(options){const scope=digest([options.instanceId,options.clawchat.route]);return {scope,root:join(options.dataDir,'platform-operations',scope)};}
function lock(root,fn){mkdirSync(root,{recursive:true,mode:0o700});const db=new Lock(join(root,'writer.sqlite'));try{db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');const value=fn();db.exec('COMMIT');return value;}finally{db.close();}}
const fileFor=(options,name,id)=>join(paths(options).root,digest([name,id])+'.json');
export function readPlatformOperation(options,name,id){
 const file=fileFor(options,name,id),r=readState(file,null);if(!r)return {requestId:id,status:'not_found'};
 assert.equal(r.scope,paths(options).scope);assert.equal(r.name,name);assert.equal(r.id,id);
 if(r.status==='prepared'&&r.hostname===hostname()&&r.submitterPid&&!alive(r.submitterPid)&&Date.now()-r.createdAt>5000){return lock(paths(options).root,()=>{const current=readState(file,null);if(current.status==='prepared'){current.status='failed';current.error='提交进程在操作执行前退出，未发送';writeState(file,current);}return view(current);});}
 if(r.status==='running'&&r.hostname===hostname()&&!alive(r.workerPid)){
  const current=lock(paths(options).root,()=>{const latest=readState(file,null);if(latest.status==='running'&&!alive(latest.workerPid)){latest.status='indeterminate';latest.error='执行进程已退出，原结果未知，未重新提交';latest.finishedAt=Date.now();writeState(file,latest);}return latest;});return view(current);
 }
 return view(r);
}
function view(r){return {requestId:r.id,status:r.status,...(r.result!==undefined?{result:r.result}:{}),...(r.actorId?{actorId:r.actorId}:{}),...(r.error?{error:r.error}:{}),...(r.status==='expired'&&r.error==='request expired before execution'?{unexecuted:true}:{}),pending:isPendingReceipt(r)};}
export function platformOperations(options,{run}={}){
 const p=paths(options);
 return {inspect:(name,id)=>readPlatformOperation(options,name,id),async submit(name,id,input,{signal,waitMs=125000}={}){
  assert.ok(tools.has(name)||verbs[name],'Unsupported platform write');assert.ok(typeof id==='string'&&id.length>0&&id.length<512);
  signal?.throwIfAborted();const file=fileFor(options,name,id),fingerprint=digest(input);let created=false;
  lock(p.root,()=>{const old=readState(file,null);if(old){assert.equal(old.fingerprint,fingerprint,'Platform operation parameters changed');return;}
   const route=options.clawchat.route;
   const runtime={instanceId:options.instanceId,dataDir:options.dataDir,cwd:options.cwd,owners:options.owners,clawchat:{route,delivery:options.clawchat.delivery}};
   writeState(file,{schema:1,scope:p.scope,id,name,input,fingerprint,status:'prepared',options:runtime,submitterPid:process.pid,hostname:hostname(),createdAt:Date.now()});created=true;
  });
  if(created){
   if(run)void executePlatformOperation(file,{run});
   else{const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG','LC_ALL','NODE_OPTIONS','BUN_OPTIONS','WHALENEST_NODE_EXECUTABLE','WHALENEST_SOURCE_INSTANCE','CLAWNEST_INSTANCE_ID'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    const child=spawn(process.env.WHALENEST_NODE_EXECUTABLE??(process.versions.bun?'node':process.execPath),[fileURLToPath(new URL('./platform-operation-worker.mjs',import.meta.url)),file],{cwd:options.cwd,env,stdio:'ignore',detached:true});
    child.once('error',error=>lock(p.root,()=>{const r=readState(file,null);if(r.status==='prepared'){writeState(file,{...r,status:'failed',error:'执行进程未启动：'+error.message,finishedAt:Date.now()});}}));child.unref();
   }
  }
  const until=Date.now()+waitMs;
  while(Date.now()<until){const r=readPlatformOperation(options,name,id);if(!isPendingReceipt(r)||signal?.aborted)return r;await delay(25);}
  return readPlatformOperation(options,name,id);
 }};
}
export async function executePlatformOperation(file,{run=execute}={}){
 let r=readState(file,null);assert.equal(file,fileFor(r.options,r.name,r.id));const root=paths(r.options).root;
 const admitted=lock(root,()=>{r=readState(file,null);if(r.status!=='prepared')return false;r={...r,status:'running',hostname:hostname(),workerPid:process.pid,startedAt:Date.now()};writeState(file,r);return true;});if(!admitted)return;
 const {connectBin,configPath}=r.options.clawchat.delivery,route=r.options.clawchat.route;
 try{
  const state=JSON.parse((await run(connectBin,['__clawnest-state','--config',configPath],{cwd:r.options.cwd,timeout:12000,maxBuffer:1024*1024,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath}})).stdout);
  assert.ok(state.connected===true&&state.ownerId===route.sender&&state.conversationId===route.conversation,'原账号或私聊已变化，未提交操作');
  r.actorId=state.userId;
  // The official command authenticates and authorizes the exact bound account.
  let args;
  if(verbs[r.name])args=[...verbs[r.name],...Object.entries(r.input).flatMap(([k,v])=>['--'+k,String(v)])];
  else args=['tool','call',r.name,'--input-json',JSON.stringify(r.input)];
  r.submittedAt=Date.now();writeState(file,r);
  let response;
  try{response=JSON.parse((await run(connectBin,[...args,'--agent',route.account,'--config',configPath,'--request-id',r.id],{cwd:r.options.cwd,timeout:125000,maxBuffer:2*1024*1024,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath}})).stdout);}
  catch(error){if(!error.stdout)throw error;response=JSON.parse(String(error.stdout));}
  assert.equal(response.requestId??r.id,r.id,'Platform returned a different operation');
  response=classifyPlatformReceipt(response);assert.ok(['succeeded','failed','denied','expired','indeterminate','pending','running'].includes(response.status));
  r.status=response.status;r.result=response.result;r.error=response.error;
  if(isPendingReceipt(response)){r.status='indeterminate';r.error='官方尚未返回终态，原请求未重新提交';}
 }catch(error){r.status=r.submittedAt?'indeterminate':'failed';r.error='未能取得原执行结果：'+String(error.message).slice(0,300);}
 r.finishedAt=Date.now();writeState(file,r);return view(r);
}

export function pendingPlatformOperations(options){
 const root=paths(options).root;if(!existsSync(root))return [];
 return readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>readState(join(root,f),null)).filter(Boolean).map(r=>readPlatformOperation(options,r.name,r.id)).filter(isPendingReceipt);
}
