import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProfile } from '../src/profile.mjs';

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: npm start -- /absolute/path/to/instance.json'); process.exit(1);
}
const config = JSON.parse(await readFile(resolve(configPath)));
if (!config.home || !config.dataDir) throw new Error('An isolated home and dataDir are required');
if (config.clawchat) throw new Error('ClawChat instances must be launched by the existing Core bridge; use prepare:connect instead of standalone start');
await prepareProfile(config.home, resolve(configPath));
const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'whalenest'], {
  cwd: root, env: { ...process.env, DSH_HOME: resolve(config.home), AURABOT_DATA_DIR: join(resolve(config.dataDir), 'aurabot') },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
