import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {hash,resolveDeliveryTarget} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {livewareCommands} from './liveware-command.mjs';
import {requireCurrentInstanceBinding} from './instance-binding.mjs';
import {retryUnexecutedLivewareOperation} from './liveware-operation.mjs';

export const managedLivewareCapability = {
  id:'whalenest-liveware',type:'managed-web-app',interfaceVersion:'1',
  configurationSchema:{type:'object',additionalProperties:false,properties:{}},
  displayName:'鲸栖通话',description:'鲸栖私有实时通话入口',
  nativeRuntimeCapabilityIds:['deepseek-harness'],compatibleRuntimes:[],
};

export function livewarePublication(app) {
  assert.ok(app && typeof app.appId === 'string' && app.appId && typeof app.name === 'string');
  const url = new URL(app.publicUrl ?? app.url);
  assert.ok(url.protocol === 'https:' && /^app-[a-z0-9-]+\.apps\.clawling\.io$/.test(url.hostname)
    && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash,
  'Liveware publication needs an exact private platform URL');
  assert.equal(app.appId,url.hostname.split('.')[0],'Liveware app identity does not match its URL');
  return {appId:app.appId,name:app.name,url:url.href};
}

export function requireLivewareOwner(options, bindingId = options.clawchat?.route?.account) {
  requireCurrentInstanceBinding(options);
  const route = options.clawchat?.route;
  assert.ok(route && route.account === bindingId && resolveDeliveryTarget(options,{origin:route}).ok,
    'Liveware needs the verified private binding');
  return route;
}

export const managedLivewarePath = options => join(options.dataDir,'managed-liveware.json');

export function livewareCallPort(options) {
  let port = options.realtime?.port ?? 8897;
  if (port === 0) {
    const gateway = readState(join(options.dataDir,'realtime/server.json'),null);
    assert.ok(gateway?.state === 'ready' && Number.isInteger(gateway.pid) && gateway.pid > 0,
      'Call gateway has not published its allocated port');
    process.kill(gateway.pid,0);
    port = gateway.port;
  }
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535,'Stable call gateway port is not configured');
  return port;
}

export function readManagedLiveware(options) {
  const route = requireLivewareOwner(options);
  const state = readState(managedLivewarePath(options),null);
  if (state) assert.ok(state.schema === 1 && state.instanceId === options.instanceId
    && state.binding === route.account && state.owner === route.sender,
    'Managed Liveware belongs to another owner');
  if (state?.legacy) livewarePublication(state.legacy);
  if (state?.publication) {
    livewarePublication(state.publication);
    assert.equal(state.publication.name,managedLivewareCapability.displayName + ' · ' + route.account,
      'Managed Liveware publication name does not match this binding');
  }
  if (state?.stableCall) {
    const progress = state.stableCall;
    assert.ok(typeof progress.upstream === 'string');
    for (const operation of [progress.create,progress.bind]) assert.ok(operation
      && typeof operation.requestId === 'string' && operation.requestId
      && ['unissued','pending','succeeded'].includes(operation.state),'Stable call operation record is invalid');
    if (progress.app) livewarePublication(progress.app);
    if (progress.publication) livewarePublication(progress.publication);
  }
  return state;
}

function save(options, patch) {
  const route = requireLivewareOwner(options), previous = readManagedLiveware(options);
  const next = {schema:1,instanceId:options.instanceId,binding:route.account,owner:route.sender,...previous,...patch};
  if (JSON.stringify(previous) !== JSON.stringify(next)) writeState(managedLivewarePath(options),next);
  return next;
}

function launcherRows(value) {
  const rows = Array.isArray(value) ? value : value?.apps ?? value?.liveware;
  assert.ok(Array.isArray(rows),'Connect returned an unrecognized launcher list');
  return rows.map(row => ({...row,appId:row.appId ?? row.app_id ?? row.liveware_id ?? row.external_id ?? row.id}));
}

function appRows(value) {
  const rows = Array.isArray(value) ? value : value?.apps;
  assert.ok(Array.isArray(rows),'Connect returned an unrecognized Liveware app list');
  return rows;
}

function stableCallUnknown(progress) {
  const phase = progress.create?.state !== 'succeeded' ? 'stable-call-create' : 'stable-call-bind';
  const operation = phase === 'stable-call-create' ? progress.create : progress.bind;
  return {ok:false,migrated:true,status:'unknown',phase,requestId:operation?.requestId,
    ...(progress.app ? {appId:progress.app.appId} : {})};
}

function requireUnissuedStableOperation(operation, progress) {
  if (operation.state === 'unissued') return;
  const error = Object.assign(Error('Stable Liveware command has an unconfirmed result; write withheld'),stableCallUnknown(progress));
  throw error;
}

async function reconcileStableOperation(options,commands,progress,kind){
  const operation=progress[kind];
  if(operation.state!=='pending'||!commands.readReceipt)return progress;
  const receipt=await commands.readReceipt(kind==='create'?'liveware_app_create':'liveware_tunnel_bind',operation.requestId);
  assert.equal(receipt.requestId,operation.requestId,'Stable call receipt belongs to another request');
  const retry=retryUnexecutedLivewareOperation(operation,receipt);
  if(retry){progress={...progress,[kind]:retry};save(options,{stableCall:progress});return progress;}
  if(receipt.status!=='succeeded')return progress;
  const result=receipt.result;
  if(kind==='create')progress={...progress,app:livewarePublication(result),create:{...operation,state:'succeeded'}};
  else{
    const app=livewarePublication(progress.app);
    assert.equal(result.appId,app.appId);assert.equal(result.registeredInClawChat,true);
    const publication=livewarePublication({...app,publicUrl:result.publicUrl});
    assert.equal(publication.url,app.url);
    progress={...progress,publication,bind:{...operation,state:'succeeded'}};
  }
  save(options,{stableCall:progress});return progress;
}

function completeStableCall(options, progress) {
  assert.equal(progress.create?.state,'succeeded');
  assert.equal(progress.bind?.state,'succeeded');
  const app = livewarePublication(progress.app), publication = livewarePublication(progress.publication);
  assert.equal(app.appId,publication.appId);
  assert.equal(app.url,publication.url);
  const route = requireLivewareOwner(options);
  writeState(join(options.dataDir,'call-liveware.json'),{
    binding:route.account,owner:route.sender,appId:publication.appId,url:publication.url,stable:true,
  });
  save(options,{legacy:publication});
  return publication;
}

async function provisionStableCall(options, commands, signal) {
  const route = requireLivewareOwner(options), key = hash([options.instanceId,route.account,route.sender,'stable-call']);
  assert.ok(options.instanceId,'A stable call App needs the instance identity');
  const port = livewareCallPort(options);
  let state = readManagedLiveware(options), progress = state?.stableCall;
  if (!progress) {
    progress = {upstream:'http://127.0.0.1:' + port,
      // dev.18 could leave this phase before persisting the returned App.
      // Treat that historical marker as dispatched, never replay its create.
      create:{requestId:'whalenest-stable-call-create-' + key,
        state:state?.phase === 'provisioning-stable-call' ? 'pending' : 'unissued'},
      bind:{requestId:'whalenest-stable-call-bind-' + key,state:'unissued'}};
    state = save(options,{phase:'provisioning-stable-call',stableCall:progress});
  }
  assert.equal(progress.upstream,'http://127.0.0.1:' + port,'Stable call gateway changed during provisioning');
  // A reservation has no usable URL. Both current and historical code see an
  // existing publication record and cannot create a second call App while a
  // lost create/bind receipt is being resolved.
  const callPath = join(options.dataDir,'call-liveware.json');
  if (!readState(callPath,null)) writeState(callPath,{
    binding:route.account,owner:route.sender,provisioning:true,requestId:progress.create.requestId,
  });
  if (progress.create.state !== 'succeeded') {
    progress=await reconcileStableOperation(options,commands,progress,'create');
  }
  if (progress.create.state !== 'succeeded') {
    requireUnissuedStableOperation(progress.create,progress);
    progress = {...progress,create:{...progress.create,state:'pending'}};
    save(options,{stableCall:progress});
    const app = livewarePublication(await commands.createApp('鲸栖通话',{
      requestId:progress.create.requestId,signal,
    }));
    progress = {...progress,app,create:{...progress.create,state:'succeeded'}};
    save(options,{stableCall:progress});
  }
  if (progress.bind.state !== 'succeeded') {
    progress=await reconcileStableOperation(options,commands,progress,'bind');
  }
  if (progress.bind.state !== 'succeeded') {
    requireUnissuedStableOperation(progress.bind,progress);
    const app = livewarePublication(progress.app);
    progress = {...progress,bind:{...progress.bind,state:'pending'}};
    save(options,{stableCall:progress});
    const receipt = await commands.bindTunnel(app.appId,progress.upstream,{requestId:progress.bind.requestId,signal});
    assert.equal(receipt.appId,app.appId,'Stable call tunnel belongs to another App');
    assert.equal(receipt.registeredInClawChat,true,'Stable call tunnel registration was not confirmed');
    const publication = livewarePublication({...app,publicUrl:receipt.publicUrl});
    assert.equal(publication.url,app.url,'Stable call URL changed while its tunnel was bound');
    progress = {...progress,publication,bind:{...progress.bind,state:'succeeded'}};
    save(options,{stableCall:progress});
  }
  return completeStableCall(options,progress);
}

/** Remove only the historical launcher. Its App, tunnel, URL, business files,
 * and the existing call gateway are retained, so old chat cards keep working.
 * This is a recoverable background job, independent of provider acquisition. */
export async function prepareLegacyLivewareMigration(options, {commands = livewareCommands(options),signal} = {}) {
  const route = requireLivewareOwner(options);
  let state = readManagedLiveware(options);
  let legacy = state?.legacy;
  if (!legacy) {
    const call = readState(join(options.dataDir,'call-liveware.json'),null);
    if (call) assert.ok(call.binding === route.account && call.owner === route.sender,
      'Existing call publication belongs to another owner');
    let rawUrl = call?.url ?? options.realtime?.publicOrigin;
    // Even a fresh instance keeps a separate, stable call App for chat cards.
    // Official online plugin replacement may retire/recreate the managed App;
    // its launcher URL must never become our durable product card URL.
    if (!rawUrl || state?.stableCall) {
      legacy = await provisionStableCall(options,commands,signal);
      rawUrl = legacy.url;
      state = readManagedLiveware(options);
    }
    if (rawUrl && !legacy) {
      const url = new URL(rawUrl);
      const candidate = livewarePublication({appId:call?.appId ?? url.hostname.split('.')[0],name:'鲸栖通话',url});
      if (state?.publication?.appId !== candidate.appId) {
        const song = readState(join(options.dataDir,'song-liveware.json'),null);
        assert.notEqual(song?.appId,candidate.appId,'The song App cannot be migrated as a call App');
        const inspected = livewarePublication(await commands.inspectApp(candidate.appId,{signal}));
        assert.equal(inspected.url,candidate.url,'Existing call URL changed during migration');
        if (inspected.name !== managedLivewareCapability.displayName + ' · ' + route.account) legacy = inspected;
      }
    }
    state = save(options,{...(legacy ? {legacy} : {}),phase:legacy?'legacy-prepared':'ready'});
  }
  if (!legacy) return state;
  // Re-read the public registration list even after a recorded success. This
  // also recovers a prior rollback that restored the historical launcher.
  const launchers = launcherRows(await commands.listLaunchers({signal}));
  if (launchers.some(app => app.appId === legacy.appId)) {
    const operation = state.retireOperation?.state === 'pending' ? state.retireOperation : {
      requestId:'whalenest-liveware-retire-' + hash([route.account,route.sender,legacy.appId,randomUUID()]),state:'pending',
    };
    state = save(options,{phase:'retiring-legacy-launcher',retireOperation:operation});
    await commands.unregisterLauncher(legacy.appId,{
      requestId:operation.requestId,signal,
    });
    state = save(options,{retireOperation:{...operation,state:'succeeded'}});
    const remaining = launcherRows(await commands.listLaunchers({signal}));
    assert.ok(!remaining.some(app => app.appId === legacy.appId),'Historical call launcher is still registered');
  }
  return save(options,{phase:state.publication?'managed':'legacy-launcher-retired'});
}

/** Discover the exact official publication without reading its private state
 * or modifying its managed App. A fresh public read avoids cached list results. */
export async function discoverManagedLiveware(options, {commands = livewareCommands(options),signal} = {}) {
  const route = requireLivewareOwner(options);
  const name = managedLivewareCapability.displayName + ' · ' + route.account;
  const matches = appRows(await commands.listApps({signal})).filter(app => app.name === name);
  assert.ok(matches.length <= 1,'Multiple official Managed Liveware Apps match this binding');
  if (!matches.length) return null;
  const publication = livewarePublication(matches[0]);
  // Only the official publisher's exact account-bound name is selected. It is
  // allowed to receive a new App identity on an official online replacement;
  // the separate stable App keeps every product chat card usable.
  const state = save(options,{publication,phase:'managed'});
  return state;
}

/** Recovery before a managed launcher has been activated. Never deletes an
 * App or tunnel. Root rollback must stop/disable Exposure before restoring the
 * legacy launcher so the two visible-entry invariant is preserved. */
export async function restoreLegacyLivewareLauncher(options, {commands = livewareCommands(options),signal,
  exposureStopped = false} = {}) {
  assert.equal(exposureStopped,true,'Stop official Exposure before restoring the legacy launcher');
  const state = readManagedLiveware(options);
  if (!state?.legacy) return {restored:false};
  const route = requireLivewareOwner(options), legacy = livewarePublication(state.legacy);
  const launchers = launcherRows(await commands.listLaunchers({signal}));
  assert.ok(!state.publication || !launchers.some(app => app.appId === state.publication.appId),
    'Managed launcher must be retired before restoring the historical launcher');
  if (!launchers.some(app => app.appId === legacy.appId)) {
    const operation = state.restoreOperation?.state === 'pending' ? state.restoreOperation : {
      requestId:'whalenest-liveware-restore-' + hash([route.account,route.sender,legacy.appId,randomUUID()]),state:'pending',
    };
    save(options,{restoreOperation:operation});
    await commands.registerLauncher(legacy,{requestId:operation.requestId,signal});
    save(options,{restoreOperation:{...operation,state:'succeeded'}});
  }
  save(options,{phase:'legacy-restored'});
  return {restored:true,appId:legacy.appId};
}

/** Called after root has restored the previous Core/plugin combination and
 * stopped its new Managed Web App contribution. Uses only public commands;
 * no App/tunnel/data deletion and no private state mutation. Unknown writes
 * are settled by fresh public observations, never by issuing another write. */
export async function rollbackManagedLiveware(options, {commands = livewareCommands(options),signal,
  exposureStopped = false} = {}) {
  assert.equal(exposureStopped,true,'Stop the new Exposure contribution before restoring its launcher');
  let state = readManagedLiveware(options);
  if (!state?.legacy && state?.phase === 'provisioning-stable-call' && !state.stableCall) {
    const route = requireLivewareOwner(options), key = hash([options.instanceId,route.account,route.sender,'stable-call']);
    return {ok:false,migrated:true,status:'unknown',phase:'stable-call-create',
      requestId:'whalenest-stable-call-create-' + key};
  }
  if (!state?.legacy && state?.stableCall) {
    const progress = state.stableCall;
    if (progress.create?.state !== 'succeeded' || progress.bind?.state !== 'succeeded') {
      // An exact App returned by our successful create may be inspected, but
      // a public URL/launcher alone cannot prove the interrupted bind used our
      // upstream. Do not advertise a working rollback or replay either write.
      if (progress.app) {
        const owned = livewarePublication(progress.app);
        const inspected = livewarePublication(await commands.inspectApp(owned.appId,{signal}));
        assert.equal(inspected.url,owned.url,'Pending stable call App changed before rollback');
      }
      return stableCallUnknown(progress);
    }
    completeStableCall(options,progress);
    state = readManagedLiveware(options);
  }
  if (!state?.legacy) return {ok:true,migrated:false};
  const legacy = livewarePublication(state.legacy);
  const inspected = livewarePublication(await commands.inspectApp(legacy.appId,{signal}));
  assert.equal(inspected.url,legacy.url,'Historical call App changed before rollback');
  const route = requireLivewareOwner(options);
  const managedName = managedLivewareCapability.displayName + ' · ' + route.account;
  const matches = appRows(await commands.listApps({signal})).filter(app=>app.name===managedName);
  assert.ok(matches.length<=1,'Managed Liveware identity is ambiguous during rollback');
  const managed = new Map();
  if (state.publication) managed.set(state.publication.appId,livewarePublication(state.publication));
  if (matches[0]) {
    const app = livewarePublication(matches[0]);managed.set(app.appId,app);
    state = save(options,{publication:app});
  }
  assert.ok(!managed.has(legacy.appId),'Rollback cannot retire its stable call App');
  const unknown = (phase,operation,error) => {
    save(options,{phase:'rollback-unknown'});
    return {ok:false,migrated:true,status:error?.receipt?.status ?? 'unknown',phase,requestId:operation.requestId};
  };
  for (const app of managed.values()) {
    const launchers = launcherRows(await commands.listLaunchers({signal}));
    const operations = {...state.rollbackRetireOperations};
    let operation = operations[app.appId];
    if (!launchers.some(row=>row.appId===app.appId)) {
      if (operation?.state==='pending') {
        operations[app.appId]={...operation,state:'succeeded'};
        state=save(options,{rollbackRetireOperations:operations});
      }
      continue;
    }
    if (operation?.state==='pending') return unknown('unregister-managed-launcher',operation);
    operation={requestId:'whalenest-liveware-rollback-retire-'+randomUUID(),state:'pending'};
    operations[app.appId]=operation;
    state=save(options,{phase:'rollback-retiring-managed',rollbackRetireOperations:operations});
    try { await commands.unregisterLauncher(app.appId,{requestId:operation.requestId,signal}); }
    catch(error) { return unknown('unregister-managed-launcher',operation,error); }
    const remaining = launcherRows(await commands.listLaunchers({signal}));
    if (remaining.some(row=>row.appId===app.appId)) return unknown('unregister-managed-launcher',operation);
    operations[app.appId]={...operation,state:'succeeded'};
    state=save(options,{rollbackRetireOperations:operations});
  }
  const launchers = launcherRows(await commands.listLaunchers({signal}));
  let operation=state.rollbackRestoreOperation;
  if (!launchers.some(app=>app.appId===legacy.appId)) {
    if (operation?.state==='pending') return unknown('register-stable-launcher',operation);
    operation={requestId:'whalenest-liveware-rollback-restore-'+randomUUID(),state:'pending'};
    state=save(options,{phase:'rollback-restoring-stable',rollbackRestoreOperation:operation});
    try { await commands.registerLauncher(legacy,{requestId:operation.requestId,signal}); }
    catch(error) { return unknown('register-stable-launcher',operation,error); }
    const restored = launcherRows(await commands.listLaunchers({signal}));
    if (!restored.some(app=>app.appId===legacy.appId)) return unknown('register-stable-launcher',operation);
  }
  save(options,{phase:'legacy-restored',...(operation?{rollbackRestoreOperation:{...operation,state:'succeeded'}}:{})});
  return {ok:true,migrated:true,restored:true,appId:legacy.appId,managedAppIds:[...managed.keys()]};
}
