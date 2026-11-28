import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hash, resolveDeliveryTarget, routeKey, senderKey } from './routing.mjs';
import { readState, writeState } from './state.mjs';
import { clawchatTextDelivery } from './clawchat-text.mjs';
import {clawchatBindingState} from './clawchat-state.mjs';
import {platformOperations,readPlatformOperation} from './platform-operations.mjs';
import {startupStatus} from './startup-state.mjs';
import {commitBindingTransition,recoverBindingTransition} from './binding-transition.mjs';
import {inspectSourceCandidate,sourceCandidateFile,sourceIdentity} from './source-candidate.mjs';
export {readBoundClawChatAgentId} from './clawchat-state.mjs';

const exec = promisify(execFile);
const defaultAvatar = fileURLToPath(new URL('./assets/whalenest-avatar.png', import.meta.url));
const textTool = 'clawchat_mention_message';
const uploadTool = 'clawchat_upload_avatar_image';

// The platform enables this only on an unpaired, clean, preinstalled instance.
// Public Connect identity is authoritative. Credentials stay inside Connect.
export function prepareFirstBinding(options, configPath, {platformInstanceId=process.env.CLAWNEST_INSTANCE_ID}={}) {
  let clawchat = options.clawchat;
  if (clawchat?.firstBinding !== true) return null;
  Object.assign(options,recoverBindingTransition(configPath));
  clawchat=options.clawchat;
  const delivery = clawchat.delivery;
  assert.ok(isAbsolute(delivery.configPath) && isAbsolute(delivery.connectBin));
  if(!existsSync(delivery.configPath))throw Object.assign(
    Error('First binding awaits Connect configuration'),{code:'FIRST_BINDING_PENDING'});
  const platform = clawchatBindingState(delivery.configPath,clawchat.route?.account,{options});
  const {account} = platform;
  const path = join(options.dataDir, 'first-binding.json');
  const previous = readState(path, null);
  const current = platform.current();
  if(!current&&!previous&&!platformInstanceId&&existsSync(join(options.dataDir,'runtime.json')))return null;
  if(!current?.agent||!current.owner||!current.conversation)throw Object.assign(
    Error('First binding awaits verified Connect activation'),{code:'FIRST_BINDING_PENDING'});
  if(previous?.platformInstanceId){
    assert.ok(platformInstanceId,'Platform instance identity disappeared; initialization withheld');
    if(previous.platformInstanceId!==platformInstanceId&&previous.identity?.agent===current.agent)
      throw Object.assign(Error('New instance awaits its own Connect activation'),{code:'FIRST_BINDING_PENDING'});
  }
  const { owner, conversation, agent } = current;
  const route = { channel: 'clawchat', kind: 'private', account, sender: owner, conversation };
  const oldRoute=clawchat.route;
  const owners = options.owners ?? [];
  assert.ok(owners.filter(o => o.channel === 'clawchat').every(o => senderKey(o) === senderKey(route)),
    'Owner changed; personal data requires an explicit handover before initialization');
  const id = 'whalenest-first-binding-' + hash([options.instanceId, account, agent, owner, conversation]);
  const identity={account,agent,owner,conversation};
  const sameActor=previous?.identity
    ?['account','agent','owner'].every(key=>previous.identity[key]===identity[key])
    :previous?.id===id;
  const changed=!!oldRoute&&(routeKey(oldRoute)!==routeKey(route)||senderKey(oldRoute)!==senderKey(route));
  const foreign=!!(previous&&!sameActor)||(changed&&!sameActor);
  const next={...options,clawchat:{...clawchat,route},owners:[...owners.filter(o=>o.channel!=='clawchat'),route]};
  const record={...(sameActor?previous:{}),id:sameActor?previous.id:id,identity,
    ...(platformInstanceId?{platformInstanceId}:{}),
    greeting:sameActor?previous.greeting:{state:'delegated'},avatar:sameActor?previous.avatar:{state:'pending'}};
  if(['pending','writing'].includes(record.greeting.state))record.greeting={state:'delegated'};
  const changes=[[configPath,next],[path,record]];
  if(changed){
    const pointer=sourceCandidateFile(options);
    // Validate the complete selected source before re-registering its route.
    const candidate=existsSync(pointer)?inspectSourceCandidate(options):null;
    if(candidate){const selected=readState(pointer,null);changes.push([pointer,{...selected,identity:sourceIdentity(next)}]);}
    changes.push([join(options.dataDir,'binding-reload.json'),{schema:1,instanceId:options.instanceId,
      identity,state:'pending',coreEpoch:process.env.WHALENEST_CORE_EPOCH??null}]);
  }
  if(foreign){
    // These are local references, never cloud deletions. Retain their before
    // values in the recovery journal, and seed fresh actor-scoped operation IDs.
    const key=hash([options.instanceId,account,agent,owner,'stable-call']);
    changes.push([join(options.dataDir,'song-liveware.json'),null],[join(options.dataDir,'call-liveware.json'),null],
      [join(options.dataDir,'managed-liveware.json'),{schema:1,instanceId:options.instanceId,binding:account,owner,
        phase:'provisioning-stable-call',stableCall:{upstream:'http://127.0.0.1:'+(options.realtime?.port??8897),
          create:{requestId:'whalenest-stable-call-create-'+key,state:'unissued'},
          bind:{requestId:'whalenest-stable-call-bind-'+key,state:'unissued'}}}]);
    if(next.realtime){next.realtime={...next.realtime};delete next.realtime.publicOrigin;}
  }
  commitBindingTransition(options,configPath,identity,changes);
  Object.assign(options,next);
  return { path, ...identity, id:record.id };
}

export function firstBindingPorts(options, binding, signal, run = exec) {
  const delivery = options.clawchat.delivery;
  const route = resolveDeliveryTarget(options, {origin: options.clawchat.route});
  assert.ok(route.ok && route.route.account === binding.account && route.route.sender === binding.owner
    && route.route.conversation === binding.conversation);
  const platform = clawchatBindingState(delivery.configPath,binding.account,{options});
  const operations=platformOperations(options,{run:run===exec?undefined:run});
  const tool = async (name, id, input) => {
    signal?.throwIfAborted();
    platform.verify(binding);
    if(name==='clawchat_get_account_profile')return JSON.parse((await run(delivery.connectBin,['tool','call',name,'--agent',binding.account,'--request-id',id,'--input-json',JSON.stringify(input),'--config',delivery.configPath],{timeout:35000,maxBuffer:1024*1024,signal,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:delivery.configPath}})).stdout).result;
    const response=await operations.submit(name,id,input,{signal});
    if(response.status!=='succeeded')throw Object.assign(Error('初始化操作未成功'),{receipt:response});
    return response.result;
  };
  const sender = clawchatTextDelivery(options, route.route, (command, args, opts) => {
    signal?.throwIfAborted();
    platform.verify(binding);
    return run(command, args, { ...opts, signal });
  });
  return {
    ready:() => startupStatus(options).baseReady&&platform.ready(binding),
    receipt:(name,id)=>{const r=readPlatformOperation(options,name,id);return {...r,state:r.status};},
    send: (id, text) => sender.sendText({ id, text }),
    async readProfile() {
      const profile = await tool('clawchat_get_account_profile', binding.id + '-read-' + randomUUID(), {});
      assert.equal(profile?.id, binding.agent, 'Profile did not belong to the bound agent');
      assert.ok(profile.avatar_url == null || typeof profile.avatar_url === 'string', 'Avatar response is invalid');
      return profile.avatar_url?.trim() || '';
    },
    upload: (id, filePath) => tool(uploadTool, id, { filePath }),
    update: (id, avatar_url) => tool('clawchat_update_account_profile', id, { avatar_url }),
  };
}

const greetingDone = new Set(['delegated', 'confirmed', 'failed', 'unverified']);
const avatarDone = new Set(['confirmed', 'preserved', 'unconfigured', 'failed', 'unverified']);
const terminal = new Set(['failed', 'expired', 'indeterminate']);

export function createFirstBinding(binding, ports, say, { avatarPath = defaultAvatar } = {}) {
  const state = readState(binding.path, null);
  assert.equal(state?.id, binding.id, 'First-binding record changed');
  const save = () => writeState(binding.path, state);
  const done = () => greetingDone.has(state.greeting.state) && ['confirmed','preserved'].includes(state.avatar.state);
  if (done()) return null;
  const halt = Object.assign(new Error('First binding cancelled'), { code: 'FIRST_BINDING_CANCELLED' });
  const check = () => { if (closed) throw halt; };
  const greetingId = binding.id + '-greeting', uploadId = binding.id + '-avatar-upload';
  const avatarId = binding.id + '-avatar-set';
  let closed = false, running;

  function commit(section, patch) {
    Object.assign(state[section], patch);
    save();
  }

  function confirmGreeting(result) {
    if (typeof result?.messageId === 'string' && result.messageId) {
      commit('greeting', { state: 'confirmed', messageId: result.messageId });
    } else commit('greeting', { state: 'unverified' });
  }

  async function greet() {
    const current = state.greeting;
    if (greetingDone.has(current.state)) return;
    if (current.state === 'sending') {
      const receipt = ports.receipt(textTool, greetingId);
      if (receipt?.state === 'succeeded') confirmGreeting(receipt.result);
      else if (!receipt || terminal.has(receipt.state)) commit('greeting', { state: 'unverified' });
      return;
    }
    // The official runtime owns first greeting generation and delivery. Old
    // dispatched requests above may only be observed, never sent a second time.
    commit('greeting',{state:'delegated'});
  }

  function saveUpload(result) {
    let url;
    try {
      url = new URL(result?.url);
      assert.ok(url.protocol === 'https:' && !url.username && !url.password);
    } catch { return commit('avatar', { state: 'failed' }); }
    commit('avatar', { state: 'uploaded', url: url.href });
  }

  async function setAvatar() {
    const current = state.avatar;
    if (['confirmed','preserved'].includes(current.state)) return;
    if (!existsSync(avatarPath)) return commit('avatar', { state: 'unconfigured' });
    const existing = await ports.readProfile();
    check();
    if (existing) return commit('avatar', { state: existing === current.url ? 'confirmed' : 'preserved' });
    if(['failed','unverified','unconfigured'].includes(current.state)){
      // Observe delayed profile/upload results only; never repeat an unknown write.
      if(!current.url){const receipt=ports.receipt(uploadTool,uploadId);if(receipt?.state==='succeeded')saveUpload(receipt.result);}
      return;
    }
    if (current.state === 'uploading') {
      const receipt = ports.receipt(uploadTool, uploadId);
      if (receipt?.state === 'succeeded') saveUpload(receipt.result);
      else if (!receipt || terminal.has(receipt.state)) commit('avatar', { state: 'unverified' });
      return;
    }
    if (current.state === 'pending') {
      commit('avatar', { state: 'uploading' });
      saveUpload(await ports.upload(uploadId, avatarPath));
      return; // Read the current profile again before any patch.
    }
    if (current.state === 'setting') {
      const receipt = ports.receipt('clawchat_update_account_profile', avatarId);
      if (!receipt || terminal.has(receipt.state) || receipt.state === 'succeeded') {
        commit('avatar', { state: 'unverified' });
      }
      return;
    }
    if (current.state === 'uploaded') {
      commit('avatar', { state: 'setting' });
      await ports.update(avatarId, current.url);
      if (!closed) {
        const verified = await ports.readProfile();
        if (verified) commit('avatar', { state: verified === current.url ? 'confirmed' : 'preserved' });
      }
    }
  }

  return {
    done,
    tick() {
      if (closed || done()) return;
      if (!running && ports.ready()) {
        running = Promise.allSettled([greet(), setAvatar()]).finally(() => { running = null; });
      }
      return running;
    },
    async close() { closed = true; await running; },
  };
}
