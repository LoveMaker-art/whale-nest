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
export {readBoundClawChatAgentId} from './clawchat-state.mjs';

const exec = promisify(execFile);
const defaultAvatar = fileURLToPath(new URL('./assets/whalenest-avatar.png', import.meta.url));
const textTool = 'clawchat_mention_message';
const uploadTool = 'clawchat_upload_avatar_image';

// The platform enables this only on an unpaired, clean, preinstalled instance.
// The Connect database is authoritative for identity. Never read out credentials.
export function prepareFirstBinding(options, configPath) {
  const clawchat = options.clawchat;
  if (clawchat?.firstBinding !== true) return null;
  const delivery = clawchat.delivery;
  assert.ok(isAbsolute(delivery.configPath) && isAbsolute(delivery.connectBin));
  const platform = clawchatBindingState(delivery.configPath);
  const {account} = platform;
  const path = join(options.dataDir, 'first-binding.json');
  const previous = readState(path, null);
  // A rollout onto an already running or migrated instance never enrolls it.
  if (!previous && (existsSync(join(options.dataDir, 'runtime.json')) || clawchat.legacySnapshotPath)) return null;

  const current = platform.current();
  assert.ok(current?.agent && current.owner && current.conversation, 'First binding awaits verified Connect activation');
  const { owner, conversation, agent } = current;
  const route = { channel: 'clawchat', kind: 'private', account, sender: owner, conversation };
  if (clawchat.route) {
    assert.ok(routeKey(clawchat.route) === routeKey(route) && senderKey(clawchat.route) === senderKey(route),
      'First binding differs from the provisioned ClawChat route');
  }
  const owners = options.owners ?? [];
  assert.ok(owners.filter(o => o.channel === 'clawchat').every(o => senderKey(o) === senderKey(route)));
  const id = 'whalenest-first-binding-' + hash([options.instanceId, account, agent, owner, conversation]);
  assert.ok(!previous || previous.id === id, 'First-binding state belongs to a different ClawChat identity');
  if (!previous) writeState(path, { id, greeting: { state: 'pending' }, avatar: { state: 'pending' } });
  if (!clawchat.route || !owners.some(o => senderKey(o) === senderKey(route))) {
    clawchat.route = route;
    options.owners = [...owners.filter(o => o.channel !== 'clawchat'), route];
    writeState(configPath, options);
  }
  return { path, dbPath: platform.dbPath, account, agent, owner, conversation, id };
}

export function firstBindingPorts(options, binding, signal, run = exec) {
  const delivery = options.clawchat.delivery;
  const route = resolveDeliveryTarget(options, {origin: options.clawchat.route});
  assert.ok(route.ok && route.route.account === binding.account && route.route.sender === binding.owner
    && route.route.conversation === binding.conversation);
  const platform = clawchatBindingState(delivery.configPath, binding.account);
  assert.equal(platform.dbPath, binding.dbPath, 'Connect state database changed during first binding');
  const tool = async (name, id, input) => {
    signal?.throwIfAborted();
    platform.verify(binding);
    const response = await run(delivery.connectBin, ['tool', 'call', name, '--agent', binding.account,
      '--request-id', id, '--input-json', JSON.stringify(input), '--config', delivery.configPath],
    { timeout: 15000, maxBuffer: 1024 * 1024, signal });
    return JSON.parse(response.stdout).result;
  };
  const sender = clawchatTextDelivery(options, route.route, (command, args, opts) => {
    signal?.throwIfAborted();
    platform.verify(binding);
    return run(command, args, { ...opts, signal });
  });
  return {
    ready:() => platform.ready(binding),
    receipt:(name, id) => platform.receipt(binding, name, id),
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

const greetingDone = new Set(['confirmed', 'failed', 'unverified']);
const avatarDone = new Set(['confirmed', 'preserved', 'unconfigured', 'failed', 'unverified']);
const terminal = new Set(['failed', 'expired', 'indeterminate']);

export function createFirstBinding(binding, ports, say, { avatarPath = defaultAvatar } = {}) {
  const state = readState(binding.path, null);
  assert.equal(state?.id, binding.id, 'First-binding record changed');
  const save = () => writeState(binding.path, state);
  const done = () => greetingDone.has(state.greeting.state) && avatarDone.has(state.avatar.state);
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
    if (current.state === 'writing') commit('greeting', { state: 'pending', text: current.fallback });
    if (!current.text) {
      const { fallback, render } = say();
      commit('greeting', { state: 'writing', fallback });
      const text = await render();
      check();
      commit('greeting', { state: 'pending', text: text || fallback });
    }
    check();
    commit('greeting', { state: 'sending' });
    try {
      confirmGreeting(await ports.send(greetingId, current.text));
    } catch {
      // Wait for the original Core receipt. A timeout cannot start a second send.
    }
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
    if (avatarDone.has(current.state)) return;
    if (!existsSync(avatarPath)) return commit('avatar', { state: 'unconfigured' });
    const existing = await ports.readProfile();
    check();
    if (existing) return commit('avatar', { state: existing === current.url ? 'confirmed' : 'preserved' });
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
