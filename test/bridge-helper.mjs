import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareProfile } from '../src/profile.mjs';
import { buildConnectBridge } from '../scripts/build-connect.mjs';
import { fixtureDirectory, owners } from './host-helper.mjs';

export async function bridgeDirectory() {
  const directory = await fixtureDirectory();
  directory.options.clawchat = {
    route: { ...owners[0], kind: 'private', conversation: 'dm-alice' },
    delivery: { connectBin: join(directory.root, 'fake-clawchat'), configPath: join(directory.root, 'fake-config.json') },
  };
  await writeFile(directory.configPath, JSON.stringify(directory.options));
  const script = '#!' + process.execPath + '\n' +
    'import{appendFileSync}from"node:fs";const a=process.argv.slice(2);' +
    'appendFileSync(' + JSON.stringify(join(directory.root, 'delivered.jsonl')) + ',JSON.stringify({id:a[a.indexOf("--request-id")+1],input:JSON.parse(a[a.indexOf("--input-json")+1])})+"\\n");' +
    'console.log(JSON.stringify({status:"succeeded",result:{sent:true,messageId:"fixture-ack-"+a[a.indexOf("--request-id")+1]}}));';
  // Node's extensionless executable is CommonJS outside the project; use require.
  await writeFile(directory.options.clawchat.delivery.connectBin, script.replace('import{appendFileSync}from"node:fs";', 'const{appendFileSync}=require("node:fs");'), { mode: 0o700 });
  return directory;
}
export async function bootBridge(directory) {
  const { root, options, configPath } = directory;
  const entry = directory.entryOverride ?? await buildConnectBridge(join(root, 'bridge'));
  await mkdir(join(root, 'bridge'), {recursive:true});
  await prepareProfile(options.home, configPath, { fixture: true, bridgeEntry: entry, externalOverlay: true });
  await mkdir(options.dataDir, { recursive: true });
  const control = join(root, 'control.json');
  await rm(control, { force: true }); await rm(control + '.result', { force: true });
  await writeFile(join(root, 'bridge/instance.json'), JSON.stringify(options));
  const overlay = join(root, 'bridge-overlay.json');
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'clawchat-connect-bridge', name: entry,
    config: { build: 'real-core-overlay', home: options.home, profile: 'whalenest', maxFrameBytes: 16 * 1024 * 1024 } }] }]));
  const childEnv = { ...process.env, ...directory.nativeModelEnv, DSH_HOME: options.home, CONNECT_DSH_BRIDGE_FD_OUT: '3',
    CONNECT_DSH_BRIDGE_FD_IN: '4', WHALENEST_TRACE: join(root, 'trace.jsonl'), WHALENEST_CONTROL_FILE: control };
  delete childEnv.AURABOT_DATA_DIR;
  if(directory.biliFixture)childEnv.WHALENEST_BILI_FIXTURE='1';
  if(directory.biliInboxFixture)childEnv.WHALENEST_BILI_INBOX_FIXTURE=directory.biliInboxFixture;
  const child = spawn(process.execPath, [process.env.WHALENEST_NATIVE_DSH ?? resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'whalenest',
    ...(directory.nativeModelPatch ? ['--patch', directory.nativeModelPatch] : []), '--patch', overlay], {
    cwd: root, env: childEnv, stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const frames = [], listeners = new Set(), interactionListeners = new Set();
  let logs = '', count = 0;
  child.stderr.on('data', b => logs = (logs + b).slice(-16000));
  createInterface({ input: child.stdio[3] }).on('line', line => {
    const frame = JSON.parse(line); frames.push(frame);
    if (frame.type === 'event') for (const listener of listeners) listener(frame);
    if (frame.type === 'interaction') for (const listener of interactionListeners) listener(frame);
  });
  async function wait(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await predicate();
      if (result) return result;
      if ((child.exitCode !== null || child.signalCode !== null)) throw new Error('Bridge exited: ' + child.exitCode + '\n' + logs);
      await delay(25);
    }
    throw new Error('Bridge timeout\n' + logs);
  }
  try { await wait(() => frames.find(f => f.type === 'hello')); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  async function request(method, params = {}) {
    const id = 'request-' + ++count;
    child.stdio[4].write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
    const frame = await wait(() => frames.find(f => f.type === 'response' && f.id === id));
    if (!frame.ok) throw Object.assign(new Error(frame.error.message),{code:frame.error.code});
    return frame.result;
  }
  return { frames, request, wait, child, hello: frames.find(f => f.type === 'hello'),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onInteraction(listener) { interactionListeners.add(listener); return () => interactionListeners.delete(listener); }, async control(method, params = {}) {
    const id = 'control-' + ++count;
    await writeFile(control, JSON.stringify({ id, method, params }));
    const response = await wait(async () => {
      try { const r = JSON.parse(await readFile(control + '.result')); return r.id === id ? r : null; } catch { return null; }
    });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }, async turn(sessionId, inputId, text) {
    const result = await request('prompt', { sessionId, inputId, text });
    await wait(() => {
      const message = frames.find(f => f.type === 'event' && f.sessionId === sessionId && f.event.type === 'user/message'
        && f.event.data.source?.connectInputId === inputId);
      if (!message) return;
      return frames.find(f => f.type === 'event' && f.sessionId === sessionId && f.event.type === 'turn/end' && f.event.seq > message.event.seq);
    });
    return result;
  }, async close() {
    if ((child.exitCode !== null || child.signalCode !== null)) return;
    try { await request('shutdown'); } finally {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await new Promise(r => (child.exitCode !== null || child.signalCode !== null) ? r() : child.once('close', r));
      clearTimeout(timer);
    }
  } };
}
