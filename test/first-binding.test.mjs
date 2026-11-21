import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeState } from '../src/state.mjs';
import { createFirstBinding, firstBindingPorts, prepareFirstBinding } from '../src/first-binding.mjs';
import { bridgeDirectory, bootBridge } from './bridge-helper.mjs';

function parse(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
const avatarUrl = 'https://cdn.example.test/default.png';

async function fresh(t, closeBridge) {
  const fixture = await bridgeDirectory();
  const { options } = fixture;
  options.clawchat.firstBinding = true;
  options.owners = [];
  delete options.clawchat.route;
  const dbPath = join(fixture.root, 'connect.sqlite');
  writeState(options.clawchat.delivery.configPath, { defaultAgent: 'agent', agents: { agent: {} }, stateDbPath: dbPath });
  writeState(fixture.configPath, options);
  const db = new DatabaseSync(dbPath);
  t.after(async () => {
    try { await closeBridge?.(); }
    finally {
      db.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE activations(platform, local_agent_id, access_token, user_id, owner_user_id, conversation_id, activated_at);
    CREATE TABLE installation_owner(id, owner_user_id);
    CREATE TABLE runtime_statuses(agent_id, updated_at, runtime_availability, websocket_connected);
    CREATE TABLE tool_requests(binding_id, tool_name, request_id, state, result_json);
    INSERT INTO installation_owner VALUES(1, 'alice');
    INSERT INTO activations VALUES('clawchat-connect', 'agent', 'not-a-real-token', 'bot-user', 'alice', 'dm-alice', 100);
    INSERT INTO runtime_statuses VALUES('agent', 101, NULL, 0);`);
  return { ...fixture, db, dbPath, open: () => prepareFirstBinding(options, fixture.configPath) };
}

test('first provisioning uses the Connect identity and the live handshake; credentials are neither copied nor used in the greeting request', async t => {
  const f = await fresh(t);
  const binding = f.open();
  assert.deepEqual(f.options.clawchat.route, { channel: 'clawchat', kind: 'private', account: 'agent', sender: 'alice', conversation: 'dm-alice' });
  assert.equal(parse(f.configPath).owners[0].sender, 'alice');
  assert.doesNotMatch(readFileSync(binding.path, 'utf8'), /not-a-real-token|dm-alice/);
  const receipts = [{ id: 'bot-user', avatar_url: '' }, { url: avatarUrl }, { avatar_url: avatarUrl }];
  const calls = [];
  const ports = firstBindingPorts(f.options, binding, undefined, async (_cmd, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ result: receipts.shift() }) };
  });
  assert.equal(ports.ready(), false);
  f.db.exec('UPDATE runtime_statuses SET websocket_connected = 1, updated_at = 90');
  assert.equal(ports.ready(), false);
  f.db.exec('UPDATE runtime_statuses SET updated_at = 101');
  assert.equal(ports.ready(), true);
  assert.equal(await ports.readProfile(), '');
  await ports.upload('upload', '/local/avatar.png');
  await ports.update('patch', avatarUrl);
  assert.equal(calls[2][6], 'patch');
  assert.deepEqual(JSON.parse(calls[2].at(-3)), { avatar_url: avatarUrl });
  f.db.exec("UPDATE activations SET conversation_id = 'someone-else'");
  assert.throws(() => ports.ready(), /identity changed/);
  assert.throws(() => f.open(), /differs/);
});

test('a clean template without verified activation and an upgrade with old data cannot enroll', async t => {
  const f = await fresh(t);
  f.db.exec('DELETE FROM activations');
  assert.throws(() => f.open(), /awaits verified/);
  assert.ok(!existsSync(join(f.options.dataDir, 'first-binding.json')));
  writeState(join(f.options.dataDir, 'runtime.json'), {});
  assert.equal(f.open(), null);
  assert.ok(!existsSync(join(f.options.dataDir, 'first-binding.json')));
});

test('lost greeting acknowledgement reconciles one request on restart and a pre-existing avatar stays untouched', async t => {
  const f = await fresh(t);
  const binding = f.open();
  let count = 0, receipt;
  const ports = {
    ready: () => true,
    async send() { count++; throw Error('lost acknowledgement'); },
    receipt: () => receipt,
    readProfile: async () => 'https://cdn.example.test/owner.png',
    upload: () => assert.fail('Existing avatar must not be uploaded'),
    update: () => assert.fail('Existing avatar must not be patched'),
  };
  const say = () => ({ fallback: '备用开场', render: async () => '一条开场白' });
  const a = createFirstBinding(binding, ports, say);
  await Promise.all([a.tick(), a.tick()]);
  assert.equal(count, 1);
  assert.equal(parse(binding.path).greeting.state, 'sending');
  assert.equal(parse(binding.path).avatar.state, 'preserved');
  await a.close();
  receipt = { state: 'succeeded', result: { messageId: 'msg-confirmed' } };
  const restarted = createFirstBinding(binding, ports, () => assert.fail('Do not regenerate a greeting'));
  await restarted.tick();
  assert.equal(count, 1);
  assert.equal(parse(binding.path).greeting.messageId, 'msg-confirmed');
  assert.equal(createFirstBinding(binding, ports, say), null);
});

test('greeting survives unavailable avatar upload and an interrupted model uses its persisted fallback', async t => {
  const f = await fresh(t);
  const binding = f.open();
  let state = parse(binding.path);
  state.greeting = { state: 'writing', fallback: '我是大肥鱼，来聊会儿吧。' };
  writeState(binding.path, state);
  const first = createFirstBinding(binding, {
    ready: () => true,
    send: async (_id, text) => {
      assert.equal(text, state.greeting.fallback);
      return { messageId: 'msg-fallback' };
    },
    readProfile: async () => '',
    upload: async () => { throw Error('upload unavailable'); },
    receipt: () => ({ state: 'failed' }),
  }, () => assert.fail('A restart must not request another completion'));
  await first.tick();
  await first.tick();
  state = parse(binding.path);
  assert.equal(state.greeting.messageId, 'msg-fallback');
  assert.equal(state.avatar.state, 'unverified');
});

test('native DSH sends the first-use fallback and applies the avatar under QQ memory pressure, with no duplicate on restart', { timeout: 50000 }, async t => {
  let bridge;
  const f = await fresh(t, () => bridge?.close());
  f.db.exec('UPDATE runtime_statuses SET websocket_connected = 1');
  const gatewayHome = join(f.root, 'gateway');
  f.options.qq = { enabled: false, gateway: { type: 'snowluma', loginQrFile: join(gatewayHome, 'login/qr.json') } };
  writeState(join(gatewayHome, 'managed-status.json'), { ready: true, deferBackground: true, at: Date.now() });
  const tools = join(f.root, 'first-binding-tools.jsonl'), profile = join(f.root, 'profile-avatar');
  const fake = '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const a = process.argv.slice(2), name = a[2], id = a[a.indexOf('--request-id')+1];
const input = JSON.parse(a[a.indexOf('--input-json')+1]);
const [dbPath, tools, profile, url] = FILES;
const db = new DatabaseSync(dbPath, { timeout: 1500 });
let result;
if (name === 'clawchat_mention_message') result = {messageId:'real-path-fixture-message'};
else if (name === 'clawchat_get_account_profile') result = {id:'bot-user',avatar_url:fs.existsSync(profile)?fs.readFileSync(profile,'utf8'):''};
else if (name === 'clawchat_upload_avatar_image') {
  if (!fs.readFileSync(input.filePath).subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) process.exit(2);
  result = {url};
} else if (name === 'clawchat_update_account_profile') {
  fs.writeFileSync(profile, input.avatar_url); result = {avatar_url:input.avatar_url};
} else process.exit(3);
db.prepare("INSERT INTO tool_requests VALUES('agent',?,?,'succeeded',?)").run(name,id,JSON.stringify(result));
db.close();
fs.appendFileSync(tools,JSON.stringify({ name, input })+'\n');
console.log(JSON.stringify({result}));
`.replace('FILES', JSON.stringify([f.dbPath, tools, profile, avatarUrl]));
  await writeFile(f.options.clawchat.delivery.connectBin, fake, { mode: 0o700 });
  bridge = await bootBridge(f);
  const file = join(f.options.dataDir, 'first-binding.json');
  await bridge.wait(() => {
    const state = parse(file);
    return state.avatar.state === 'confirmed' && state.greeting.state === 'confirmed';
  }, 16000);
  const delivered = (await readFile(tools, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(delivered.filter(x => x.name === 'clawchat_mention_message').length, 1);
  const greeting = delivered.find(x => x.name === 'clawchat_mention_message').input;
  assert.equal(greeting.chatId, 'dm-alice');
  assert.equal(greeting.text, '嗨，我是大肥鱼。你来啦，想先聊点什么？');
  assert.equal(parse(file).greeting.state, 'confirmed');
  assert.ok(!(await bridge.request('companionStatus', {})).companion.settings.contactEnabled);
  await bridge.close();
  f.db.exec("UPDATE activations SET access_token = 'rotated-fixture-token'");
  // The fixture writes its preinstalled configuration on each boot, as a cloud
  // provisioning race might. The durable first binding must still reconcile it.
  bridge = await bootBridge(f);
  await bridge.request('create', {sessionId:'first-real-chat',whalenestChatId:'dm-alice',cwd:f.root,model:f.options.model});
  await bridge.turn('first-real-chat','first-user-message','你好呀');
  assert.equal((await readFile(tools, 'utf8')).trim().split('\n').length, delivered.length);
});
