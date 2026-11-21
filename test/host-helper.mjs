import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { prepareProfile } from '../src/profile.mjs';

export const owners = [{ channel: 'clawchat', account: 'agent', sender: 'alice' },
  { channel: 'qq', account: 'bot', sender: '12345' }];
export const input = (id, text, route = {}) => ({ id, text,
  route: { ...owners[0], kind: 'private', conversation: 'dm-alice', ...route } });

export async function fixtureDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'whalenest-m1-'));
  const options = { instanceId: 'fixture', owners, home: join(root, 'home'), dataDir: join(root, 'data'),
    cwd: root, model: { provider: 'fixture', model: 'fixture', maxTokens: 512 },
    clawchat:{route:{...owners[0],kind:'private',conversation:'dm-alice'}} };
  const configPath = join(root, 'instance.json');
  await writeFile(configPath, JSON.stringify(options));
  return { root, options, configPath };
}

export async function boot(directory) {
  const { root, options, configPath } = directory;
  await prepareProfile(options.home, configPath, { fixture: true });
  await mkdir(options.dataDir, { recursive: true });
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'whalenest'], {
    cwd: root, env: { ...process.env, DSH_HOME: options.home,
      AURABOT_DATA_DIR: join(options.dataDir, 'aurabot'), WHALENEST_TRACE: join(root, 'trace.jsonl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  const pending = new Map();
  const frames = [];
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-14000); });
  createInterface({ input: child.stdout }).on('line', line => {
    let frame;
    try { frame = JSON.parse(line); } catch { logs += line + '\n'; return; }
    frames.push(frame);
    if (pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
  });
  const waitReady = new Promise((resolveReady, reject) => {
    const timer = setInterval(() => {
      if (frames.some(f => f.type === 'ready')) { clearInterval(timer); clearTimeout(timeout); resolveReady(); }
    }, 20);
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Host boot timeout\n' + logs)); }, 20000);
    child.once('exit', code => { clearInterval(timer); clearTimeout(timeout); reject(new Error(`Host exited ${code}\n${logs}`)); });
  });
  try { await waitReady; } catch (error) { child.kill('SIGKILL'); throw error; }
  let counter = 0;
  async function request(method, extra = {}) {
    const id = ++counter;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Request ${method} timeout\n${logs}`)); }, 15000);
      pending.set(id, frame => { clearTimeout(timeout); frame.ok ? resolveRequest(frame.result) : reject(new Error(frame.error + '\n' + logs)); });
      child.stdin.write(JSON.stringify({ id, method, ...extra }) + '\n');
    });
  }
  return { request, logs: () => logs, async close() {
    if (child.exitCode !== null) return;
    try { await request('shutdown'); } finally {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await new Promise(r => child.exitCode !== null ? r() : child.once('close', r)); clearTimeout(timeout);
    }
  } };
}
