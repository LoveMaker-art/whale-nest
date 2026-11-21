import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {comparePluginVersions, discoverPluginRelease, pluginId, updateTarget} from './plugin-release.mjs';
import {hash, resolveDeliveryTarget} from './routing.mjs';
import {readState, writeState} from './state.mjs';
import {createOneBotClient} from '../vendor/aurabot/src/onebot/client.js';
import {clawchatTextDelivery} from './clawchat-text.mjs';
import {deliverIntent} from './delivery.mjs';

const exec = promisify(execFile);
const terminal = new Set(['completed','rolled-back','failed']);

export function updateFiles(options) {
  const directory=join(resolve(options.dataDir),'plugin-updates');
  return {directory, request:join(directory,'request.json'), cache:join(directory,'check.json')};
}

export function updateProgress(options, id) {
  assert.match(id,/^[a-f0-9]{64}$/);
  return join(updateFiles(options).directory,id+'.json');
}

export const updateResultId=(id,phase)=>'whalenest-update-result-'+hash([id,phase]);

function lease(path) {
  // SQLite releases the writer lock even when the worker exits unexpectedly.
  const database=new DatabaseSync(path);
  try {database.exec('BEGIN IMMEDIATE');}
  catch (error) {
    database.close();
    if (error.errcode===5 || error.code==='SQLITE_BUSY') return null;
    throw error;
  }
  return ()=>database.close();
}

export function connectUpdateHost(options, {fetchImpl=fetch,run=exec}={}) {
  const {connectBin,configPath}=options.clawchat.delivery;
  assert.ok(isAbsolute(connectBin)&&isAbsolute(configPath));
  const lockPath=join(dirname(configPath),'plugins.lock.json'), route=options.clawchat.route;
  const installed=()=>readState(lockPath,null)?.plugins?.[pluginId];
  const state=async()=>JSON.parse((await run(connectBin,['__clawnest-state','--config',configPath],
    {timeout:8000,maxBuffer:1024*1024})).stdout);
  async function identity() {
    const s=await state();
    if (!s.available||!s.connected||s.ownerId!==route.sender||s.conversationId!==route.conversation) return null;
    const config=readState(configPath,null);
    const bindings=Object.entries(config?.agents??{}).filter(([,binding])=>binding.runtime?.pluginId===pluginId);
    assert.equal(bindings.length,1,'Installation must belong to a single Agent');
    assert.equal(bindings[0][0],route.account,'Unexpected Connect binding');
    return {idle:s.running===0&&s.queued===0, key:hash({route,binding:bindings[0][1],stateDbPath:config.stateDbPath})};
  }
  async function versions() {
    const dsh=options.pluginUpdates.dshExecutable??'/opt/dsh/node_modules/.bin/dsh';
    assert.ok(isAbsolute(dsh),'Expected the provisioned DSH executable');
    const [dshVersion,coreVersion]=await Promise.all([dsh,connectBin].map(file=>run(file,['--version'],{timeout:8000,maxBuffer:16384})));
    const version=out=>out.stdout.trim().split(/\s+/).at(-1).replace(/^v(?=\d)/,'');
    const runtime=readState(join(options.dataDir,'runtime.json'),null);
    assert.equal(runtime?.instanceId,options.instanceId);
    return {dsh:version(dshVersion),core:version(coreVersion),dataSchema:runtime.schema};
  }
  async function change(operation,body) {
    const response=await fetchImpl('http://127.0.0.1:47822/core/v1/plugins/'+pluginId+'/'+operation,{
      method:'POST', headers:{'Content-Type':'application/json','X-ClawChat-Connect-Core-Config-Path':configPath},
      body:JSON.stringify(body),signal:AbortSignal.timeout(60000),redirect:'error',
    });
    // An explicit Core failure may follow lock commit. The worker always
    // verifies selection before deciding between holding and rolling back.
    await response.body?.cancel();
    return response.ok;
  }
  return {installed,identity,versions,change};
}

const selection = entry => ({version:entry.version,integrity:entry.integrity});
function isRelease(entry, release) {
  return entry?.version===release.version && entry.target===updateTarget &&
    entry.source?.type==='github' && entry.source.repository===release.repository && entry.source.release===release.tag &&
    (entry.source.apiBase===undefined||entry.source.apiBase==='https://api.github.com');
}

function resultText(job, progress) {
  if (progress.phase==='completed') return '鲸栖已经更新到 '+job.release.version+'，原私聊可以继续使用。';
  if (progress.phase==='rolled-back') return '这次更新未能启用，已经切回 '+progress.version+'。可以继续在这里聊天。';
  if (progress.phase==='failed') return '这次更新没有安装成功。你可以说「查看更新进度」确认目前的版本。';
  return '这次更新的结果还在核对。你可以说「查看更新进度」。';
}

function liveResultDelivery(loadOptions, request) {
  return {async sendText(intent) {
    const options=loadOptions(), route=request.route;
    const unavailable=()=>Object.assign(new Error('Original private chat is unavailable'),{definitelyNotSent:true});
    if (options.instanceId!==request.instanceId || !resolveDeliveryTarget(options,{origin:route}).ok) throw unavailable();
    if (route.channel==='clawchat') {
      if (!await connectUpdateHost(options).identity()) throw unavailable();
      return clawchatTextDelivery(options,route).sendText(intent);
    }
    const gateway=options.qq?.gateway?.onebot;
    if (!options.qq?.enabled||!gateway?.httpUrl) throw unavailable();
    const url=new URL(gateway.httpUrl);
    if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.search || url.hash) throw unavailable();
    const token=key=>gateway[key+'File']?readFileSync(resolve(gateway[key+'File']),'utf8').trim():gateway[key];
    const client=createOneBotClient({endpoint:()=>({httpUrl:url.href,httpToken:token('httpToken')||token('token')}),retryDelays:[]});
    const query=(action,args)=>client.call(action,args,{timeoutMs:6000,retries:0});
    let identity, state;
    try{identity=await query('get_login_info');state=await query('get_status');}catch{throw unavailable();}
    if (String(identity?.user_id)!==route.account || state?.online!==true) throw unavailable();
    const recipient=Number(route.sender);
    if (!Number.isSafeInteger(recipient)||recipient<=0) throw unavailable();
    const ack=await query('send_private_msg',{user_id:recipient,message:[{type:'text',data:{text:intent.text}}]});
    assert.ok(ack?.message_id!==undefined,'QQ acknowledgement is missing');
    return {messageId:String(ack.message_id)};
  }};
}

export async function executePluginUpdate(options, id, {host,discover=discoverPluginRelease,wait=delay,delivery}={}) {
  const files=updateFiles(options), request=readState(files.request,null);
  if (request?.id!==id || request.instanceId!==options.instanceId) return;
  assert.ok(resolveDeliveryTarget(options,{origin:request.route}).ok,'Update requester is no longer the verified owner');
  const file=updateProgress(options,id);
  mkdirSync(files.directory,{recursive:true,mode:0o700});
  const unlock=lease(join(files.directory,'worker.sqlite'));
  if (!unlock) return;
  let progress;
  try {progress=readState(file,{phase:'queued'});}
  catch (error) {unlock();throw error;}
  const save=fields=>{progress={...progress,...fields,updatedAt:Date.now()};writeState(file,progress);};
  const release=request.release;
  const observe=async expected=>{
    for (let attempt=0; attempt<12; attempt++) {
      try {
        const current=host.installed(), identity=await host.identity();
        if (current?.status==='active' && expected(current) && identity?.key===progress.identity) return true;
      } catch { /* A short transition may leave Core temporarily unavailable. */ }
      if (attempt<11) await wait(1000);
    }
    return false;
  };
  try {
    if (terminal.has(progress.phase)) return progress;
    host??=connectUpdateHost(options);
    if (progress.phase==='uncertain') {
      const selected=host.installed(), identity=await host.identity();
      if (identity?.key===progress.identity && selected?.status==='active' && isRelease(selected,release)) {
        save({phase:'completed',version:release.version});
      } else if (progress.reason==='rollback-unconfirmed' && identity?.key===progress.identity && selected?.status==='active'
        && selected.version===progress.previous.version && selected.integrity===progress.previous.integrity) {
        save({phase:'rolled-back',version:selected.version});
      } else save({});
      return progress;
    }
    if (progress.phase==='queued') {
      const current=host.installed(), identity=await host.identity();
      if (!identity?.idle) return progress;
      assert.ok(current?.status==='active' && current.target===updateTarget);
      assert.ok(comparePluginVersions(release.version,current.version)>0);
      assert.match(current.integrity ?? '',/^sha256-[A-Za-z0-9+/]{43}=$/);
      assert.ok(current.source?.type==='local' || current.source?.type==='github' && current.source.repository===release.repository);
      if(current.source.type==='github')assert.ok(current.source.apiBase===undefined||current.source.apiBase==='https://api.github.com');
      assert.equal(options.pluginUpdates.repository,release.repository);
      assert.deepEqual(await discover(options.pluginUpdates,current.version,{tag:release.tag}),release);
      assert.deepEqual(await host.versions(),release.compatibility,'Incompatible runtime versions');
      // Repeat the live checks after the network read. Core drains in-flight
      // turns if a message arrives between admission and the switch.
      const checked=await host.identity();
      if (!checked?.idle || checked.key!==identity.key) return progress;
      assert.deepEqual(selection(host.installed()),selection(current),'Selected version changed during update preparation');
      save({phase:'switching',previous:selection(current),identity:identity.key});
      try {
        const accepted=await host.change(current.source.type==='local'?'replace':'update',{source:'github:'+release.repository+'@'+release.tag});
        save({ack:accepted?'accepted':'rejected'});
      } catch {
        save({ack:'unknown'});
      }
    }
    if (progress.phase==='switching') {
      if (await observe(entry=>isRelease(entry,release))) {
        save({phase:'completed',version:release.version});
        return progress;
      }
      const selected=host.installed(), previous=progress.previous;
      if (selected?.version===previous?.version && selected?.integrity===previous?.integrity && selected.status==='active') {
        save(progress.ack==='rejected'
          ? {phase:'failed',reason:'switch-rejected',version:selected.version}
          : {phase:'uncertain',reason:'switch-unconfirmed',version:selected.version});
        return progress;
      }
      // Select only the recorded rollback point. A different operator's
      // selected version must never be displaced by this job.
      const retained=selected?.retainedVersions?.some(entry=>entry.version===previous?.version&&entry.integrity===previous?.integrity);
      if (!isRelease(selected,release) || !retained) {
        save({phase:'uncertain',reason:'rollback-point-unconfirmed'});
        return progress;
      }
      save({phase:'rolling-back'});
      try {await host.change('select',previous);} catch { /* Reconcile even if the acknowledgement is lost. */ }
    }
    if (progress.phase==='rolling-back') {
      const prior=progress.previous;
      const restored=await observe(entry=>entry.version===prior.version && entry.integrity===prior.integrity);
      save(restored ? {phase:'rolled-back',version:prior.version,reason:'target-unhealthy'}
        : {phase:'uncertain',reason:'rollback-unconfirmed'});
    }
  } catch {
    save(progress.phase==='queued' ? {phase:'failed',reason:'preflight'}
      : {phase:'uncertain',reason:'reconciliation'});
  } finally {
    try {
      if (delivery&&(terminal.has(progress.phase)||progress.phase==='uncertain')) {
        const key=updateResultId(id,progress.phase);
        const notices=progress.notices??{};
        notices[key]??={id:key,route:request.route,text:resultText(request,progress),state:'pending'};
        await deliverIntent({outbox:notices},key,delivery,()=>save({notices}));
      }
    } catch { /* The durable receipt determines whether a repeat is allowed. */ }
    finally {unlock();}
  }
  return progress;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, , configPath, id]=process.argv;
  const load=()=>readState(resolve(configPath),null);
  const options=load(), request=readState(updateFiles(options).request,null);
  if(request?.id===id)await executePluginUpdate(options,id,{delivery:liveResultDelivery(load,request)});
}
