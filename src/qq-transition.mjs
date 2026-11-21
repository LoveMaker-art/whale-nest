import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {hostname} from 'node:os';
import {createMemoryStorage} from '../vendor/aurabot/src/features/memory-store.js';
import {readState, writeState} from './state.mjs';
import {hash, senderKey, routeKey} from './routing.mjs';

export const qqManagementFile = options => join(resolve(options.dataDir), 'qq-connection.json');
const fingerprint = owners => hash(owners.map(senderKey).sort());
const qq = value => /^\d{5,12}$/.test(String(value ?? ''));

function assertStopped(options) {
  const lease = join(options.dataDir, 'runtime.lock');
  if (!existsSync(lease)) return;
  const owner = readState(lease, null);
  assert.ok(owner && owner.hostname === hostname() && Number.isSafeInteger(owner.pid), '无法核对旧QQ运行实例的写入锁');
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') { unlinkSync(lease); return; } throw error; }
  throw new Error('旧DSH仍持有运行数据，暂不能应用QQ账号变更');
}

/** Transform identity metadata, never message text or native DSH Sessions. */
export function migrateQQMemory(raw, from, to, operationId) {
  from = String(from); to = String(to);
  const marker = raw.whalenestQQTransitions?.[operationId];
  if (marker) { assert.equal(marker.from, from); assert.equal(marker.to, to); return raw; }
  const output = structuredClone(raw);
  if (from !== to) {
    for (const collection of ['items', 'gists']) for (const item of output[collection] ?? []) {
      assert.ok(String(item.about ?? '') !== to, '目标QQ已有独立记忆，需先核对归属，未自动合并');
      if (String(item.about ?? '') === from) item.about = to;
      if (String(item.speaker ?? '') === from) item.speaker = to;
      if (item.chatId === 'private:' + from) item.chatId = 'private:' + to;
    }
    const rename = (values, oldKey, newKey) => {
      if (!values || !Object.hasOwn(values, oldKey)) return;
      assert.ok(!Object.hasOwn(values, newKey), '目标QQ已有独立人物资料，未自动覆盖');
      values[newKey] = values[oldKey]; delete values[oldKey];
    };
    for (const field of ['profiles', 'dirtyProfiles', 'shortTerm']) {
      const values = output[field];
      assert.ok(!values || !Object.hasOwn(values, to), '目标QQ已有独立人物资料，未自动合并');
      rename(values, from, to);
    }
    for (const field of ['insights','insightNames','styles']) rename(output[field], 'qq:'+from, 'qq:'+to);
    rename(output.chats, 'private:'+from, 'private:'+to);
    for (const relation of output.relations ?? []) {
      for (const key of ['subjQq','objQq']) if (relation[key] === from) relation[key] = to;
      if (relation.chatId === 'private:'+from) relation.chatId = 'private:'+to;
    }
    for (const progress of Object.values(output.processed ?? {})) rename(progress?.chats, 'private:'+from, 'private:'+to);
    // These are extraction checkpoints, not native conversation identifiers.
    for (const field of ['processed', 'consolidated', 'chatProcessed']) {
      const values = output[field]; if (!values || Array.isArray(values) || typeof values !== 'object') continue;
      for (const key of Object.keys(values)) {
        const next = key === 'private:' + from ? 'private:' + to
          : key.startsWith('private:' + from + ':') ? 'private:' + to + key.slice(('private:' + from).length) : key;
        if (next !== key) { assert.ok(!Object.hasOwn(values, next), '记忆整理进度发生身份冲突'); values[next] = values[key]; delete values[key]; }
      }
    }
  }
  output.whalenestQQTransitions ??= {};
  output.whalenestQQTransitions[operationId] = {from, to};
  return output;
}

/** Applied only on a new SDK boot after Connect has drained the previous one.
 * The existing owner guards remain active; this is their explicit migration. */
export function applyQQTransition(options, configPath) {
  const file = qqManagementFile(options), management = readState(file, null), job = management?.transition;
  if (!job || !['queued', 'applying', 'data-applied'].includes(job.state)) return null;
  assert.ok(configPath && resolve(configPath) === resolve(job.configPath), 'QQ配置入口与待应用任务不匹配');
  assert.equal(job.instanceId, options.instanceId, 'QQ任务属于其他实例');
  assert.equal(senderKey(job.actor), senderKey(options.clawchat.route), 'QQ任务主人身份不匹配');
  assert.equal(routeKey(job.actor), routeKey(options.clawchat.route), 'QQ任务会话不匹配');
  assertStopped(options);
  assert.ok(['link','unlink','connect','disconnect'].includes(job.action), '未知QQ身份迁移操作');
  const root = resolve(options.dataDir), configFile = join(root, 'aurabot/config.json');
  const runtimeFile = join(root, 'runtime.json'), cfg = readState(configFile, null);
  assert.ok(cfg, '原QQ宿主配置尚未初始化');
  if (job.state === 'data-applied') {
    const saved = readState(configPath, null);
    assert.equal(fingerprint(saved.owners), job.afterFingerprint, 'QQ配置应用后又被外部更改');
    for (const key of Object.keys(options)) delete options[key];
    Object.assign(options, saved);
    return job;
  }
  const beforePath = join(root, 'qq-transitions', job.id, 'before.json');
  let before = readState(beforePath, null);
  if (!before) {
    assert.equal(fingerprint(options.owners), job.beforeFingerprint, '主人关联在QQ操作后已改变');
    assert.equal(String(cfg.ownerQQ), job.previousOwnerId, '原主人记忆归属已改变');
    const storage = createMemoryStorage({directory: () => join(root, 'aurabot')});
    try {
      assert.equal(storage.status().backend, 'sqlite', 'QQ身份迁移需要原SQLite存储正常可写');
      before = {options: structuredClone(options), config: cfg,
        runtime: readState(runtimeFile, null), memory: storage.load(),
        qqSessions: readState(join(root, 'aurabot/sessions.json'), {chats: {}})};
      // Validate conflicts before writing any live identity.
      migrateQQMemory(before.memory, job.previousOwnerId, job.ownerQQ ?? job.previousOwnerId, job.id);
      writeState(beforePath, before);
    } finally { storage.close(); }
  }
  job.state = 'applying'; writeState(file, management);
  const next = structuredClone(before.options), from = job.previousOwnerId;
  const linking = job.action === 'link' || job.action === 'connect';
  const to = job.action === 'link' ? String(job.ownerQQ) : from;
  assert.ok(/^\d+$/.test(to), '主人内部标识无效');
  if (linking) assert.ok(qq(job.botQQ) && qq(job.ownerQQ) && job.botQQ !== job.ownerQQ, '机器人QQ和主人QQ无效');
  if (job.action === 'link' || job.action === 'unlink') next.owners = next.owners.filter(owner => owner.channel !== 'qq');
  if (job.action === 'link') next.owners.push({channel: 'qq', account: job.botQQ, sender: job.ownerQQ});
  next.qq = {...next.qq, enabled: linking, nativeModules: next.qq?.nativeModules ?? true};
  const config = {...before.config, enabled: false, ownerQQ: to};
  if (linking) {
    config.botQQ = job.botQQ; config.gateway = 'onebot'; config.dryRun = false;
    config.snowluma = {...config.snowluma, ...job.onebot, autoStart: false, autoAttach: false};
  }
  const storage = createMemoryStorage({directory: () => join(root, 'aurabot')});
  try {
    const raw = storage.load();
    storage.save(migrateQQMemory(raw, from, to, job.id));
    assert.equal(storage.status().backend, 'sqlite', 'QQ记忆迁移未提交到原SQLite');
  } finally { storage.close(); }
  if (from !== to) {
    const chatlog = join(root, 'aurabot/chatlog');
    if (existsSync(chatlog)) for (const name of readdirSync(chatlog).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))) {
      const path = join(chatlog, name), text = readFileSync(path, 'utf8');
      const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line)); let changed = false;
      for (const row of rows) {
        if (row.chatId === 'private:' + from) { row.chatId = 'private:' + to; changed = true; }
        if (String(row.who) === from) { row.who = to; changed = true; }
        if (String(row.uid) === from) { row.uid = to; changed = true; }
      }
      if (changed) {
        const saved = join(root, 'qq-transitions', job.id, 'chatlog', name + '.json');
        if (!existsSync(saved)) { mkdirSync(join(root, 'qq-transitions', job.id, 'chatlog'), {recursive: true, mode: 0o700}); writeState(saved, {text}); }
        // Reuse the atomic JSON writer for metadata; the original JSONL format
        // is written by the companion only after this stopped-writer boundary.
        writeFileSync(path + '.qq-transition', rows.map(row => JSON.stringify(row)).join('\n') + '\n', {mode: 0o600});
        renameSync(path + '.qq-transition', path);
      }
    }
  }
  const runtime = readState(runtimeFile, before.runtime);
  if (runtime) {
    assert.ok([job.beforeFingerprint, fingerprint(next.owners)].includes(runtime.ownersFingerprint), '运行身份在迁移期间发生冲突');
    runtime.ownersFingerprint = fingerprint(next.owners); runtime.sharedMemoryOwnerId = to;
    for (const intent of Object.values(runtime.outbox ?? {})) if (intent.route?.channel === 'qq' && intent.state === 'pending') {
      intent.state = 'suppressed'; intent.reason = 'qq-association-changed';
    }
    writeState(runtimeFile, runtime);
  }
  if (job.action === 'link' && (before.config.botQQ !== job.botQQ || from !== to)) {
    const map = readState(join(root, 'aurabot/sessions.json'), {chats: {}});
    const retired=join(root, 'qq-transitions', job.id, 'retired-qq-sessions.json');
    if (!existsSync(retired)) writeState(retired, map);
    writeState(join(root, 'aurabot/sessions.json'), {...map, chats: {}});
  }
  writeState(configFile, config); writeState(configPath, next);
  job.state = 'data-applied'; job.afterFingerprint = fingerprint(next.owners); job.enableQQ = linking;
  writeState(file, management);
  for (const key of Object.keys(options)) delete options[key];
  Object.assign(options, next);
  return job;
}

/** Recover only an unfinished, stopped-writer transition. Reverse identity
 * metadata on the current database, preserving later facts and receipts. */
export function recoverQQTransition(options, configPath) {
  const file=qqManagementFile(options), state=readState(file,null), job=state?.transition;
  assert.ok(job && ['queued','applying','data-applied'].includes(job.state), '没有可恢复的QQ变更');
  assert.equal(resolve(job.configPath),resolve(configPath),'恢复入口与QQ任务不匹配');
  assert.equal(job.instanceId,options.instanceId,'恢复任务属于其他实例');
  assert.equal(senderKey(job.actor),senderKey(options.clawchat.route),'恢复任务主人不匹配');
  assert.equal(routeKey(job.actor),routeKey(options.clawchat.route),'恢复任务会话不匹配');
  assertStopped(options);
  const root=resolve(options.dataDir), before=readState(join(root,'qq-transitions',job.id,'before.json'),null);
  if (before) {
    const from=String(job.previousOwnerId), to=String(job.ownerQQ??from);
    const storage=createMemoryStorage({directory:()=>join(root,'aurabot')});
    try {
      const raw=storage.load();
      if (raw.whalenestQQTransitions?.[job.id]) {
        const restored=migrateQQMemory(raw,to,from,job.id+':recovery');
        delete restored.whalenestQQTransitions[job.id];
        delete restored.whalenestQQTransitions[job.id+':recovery'];
        storage.save(restored);
        assert.equal(storage.status().backend,'sqlite','QQ恢复未提交原SQLite');
      }
    } finally {storage.close();}
    const directory=join(root,'qq-transitions',job.id,'chatlog');
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      const backup=readState(join(directory,name),null), target=join(root,'aurabot/chatlog',name.slice(0,-5));
      // No SDK has been allowed to write between apply and this recovery.
      writeFileSync(target,backup.text,{mode:0o600});
    }
    const runtimeFile=join(root,'runtime.json'), runtime=readState(runtimeFile,null);
    if (runtime) {
      runtime.ownersFingerprint=fingerprint(before.options.owners); runtime.sharedMemoryOwnerId=from;
      writeState(runtimeFile,runtime);
    }
    const sessionsFile=join(root,'aurabot/sessions.json'), sessions=readState(sessionsFile,{chats:{}});
    if (!Object.keys(sessions.chats).length) writeState(sessionsFile,before.qqSessions);
    writeState(join(root,'aurabot/config.json'),{...before.config,enabled:false});
    const restored={...before.options,qq:{...before.options.qq,enabled:false}};
    writeState(configPath,restored);
    for (const key of Object.keys(options)) delete options[key];
    Object.assign(options,restored);
  }
  job.state='failed'; job.reloadState='recovered'; writeState(file,state);
}

export function finishQQTransition(options, native) {
  const file = qqManagementFile(options), state = readState(file, null), job = state?.transition;
  if (job?.state !== 'data-applied') return;
  if (job.enableQQ) {
    const config = native.getConfig();
    assert.ok(options.owners.some(owner => owner.channel === 'qq' && owner.account === config.botQQ && owner.sender === config.ownerQQ), 'QQ启动前未取得关联身份');
    native.setConfig({...config, enabled: true}); native.onebot.start();
  }
  state.binding = options.owners.find(owner => owner.channel === 'qq') ?? null;
  job.state = 'confirmed'; job.reloadState='applied';job.completedAt = new Date().toISOString();
  writeState(file, state);
}
