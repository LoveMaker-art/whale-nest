import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const upstream = args.includes('--upstream'), reuse = args.includes('--reuse');
if (args.some(a => a.startsWith('--') && !['--upstream', '--reuse'].includes(a))) throw new Error('Unknown test option');
const requested = args.filter(a => !a.startsWith('--'));
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const available = upstream
  ? readdirSync('vendor/aurabot/test', { recursive: true }).filter(f => f.endsWith('.test.js')).map(f => join('vendor/aurabot/test', f))
  : readdirSync('test').filter(f => f.endsWith('.test.mjs')).map(f => join('test', f));
if (upstream && requested.length) throw new Error('Select either upstream or project test files');
const files = requested.length ? [...new Set(requested)].sort() : available.sort();
for (const file of files) if (!available.includes(file)) throw new Error('Unknown test file: ' + file);
const selected = requested.length > 0;
const reportDir = '.whale-nest/verification';
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const options = { ...process.env, TMPDIR: realpathSync(tmpdir()), NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? '') + ' --max-old-space-size=384').trim() };
const report = { schema: 2, selectedFiles: files, platform: process.platform, node: process.version, concurrency: 1, upstream, files: files.length,
  startedAt: new Date().toISOString(), modelTransport: upstream ? 'upstream fixtures' : 'fixture; native DSH and real storage',
  maxCgroupBytes: 0, maxEffectiveBytes: 0, resourceStopped: false };
const livewareTests = ['realtime-call.test.mjs', 'realtime-native.test.mjs'].map(file => join('test', file));
if (files.some(file => livewareTests.includes(file))) {
  const automatic = ['python3', 'python3.11', 'python3.12', 'python3.13', 'python3.14'];
  const candidates = options.WHALENEST_TEST_PYTHON ? [options.WHALENEST_TEST_PYTHON] : automatic;
  const probe = 'import json, sqlite3, sys; print(json.dumps([sys.executable, sys.version.split()[0]])); sys.exit(int(sys.version_info < (3, 11)))';
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-B', '-c', probe], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) continue;
    const [executable, version] = JSON.parse(result.stdout);
    options.WHALENEST_TEST_PYTHON = executable;
    report.python = { executable, version };
    break;
  }
  if (!report.python) throw new Error('Liveware tests require Python 3.11 or newer with sqlite3. Set WHALENEST_TEST_PYTHON to its executable.');
  console.log('Liveware test interpreter: Python ' + report.python.version);
}
const digest = createHash('sha256');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter(entry =>
    !['node_modules', '__pycache__', '.git', '.DS_Store'].includes(entry.name) && !entry.name.startsWith('._')
  ).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : [file];
  });
}
const sources = ['src', 'test', 'scripts', 'integration', 'vendor', 'deploy'].flatMap(sourceFiles);
sources.push('package.json', 'package-lock.json', 'upstream.lock.json',
  JSON.parse(readFileSync('upstream.lock.json', 'utf8')).personaReference.localFile);
for (const file of [...new Set(sources)].sort()) {
  digest.update(file + '\0'); digest.update(readFileSync(file)); digest.update('\0');
}
report.sourceSha256 = digest.digest('hex');
const reportName = upstream ? 'upstream-latest.json' : !selected ? 'core-latest.json'
  : files.length === 1 && files[0] === 'test/live-update.test.mjs' ? 'deployment-latest.json'
  : 'selected-' + createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12) + '.json';
const reportFile = join(reportDir, reportName);
if (reuse) {
  let previous; try { previous = JSON.parse(readFileSync(reportFile, 'utf8')); } catch {}
  if (previous?.schema === 2 && previous.code === 0 && !previous.resourceStopped
    && previous.platform === report.platform && previous.node === report.node
    && previous.python?.executable === report.python?.executable && previous.python?.version === report.python?.version
    && previous.sourceSha256 === report.sourceSha256
    && JSON.stringify(previous.selectedFiles) === JSON.stringify(files)) {
    console.log('Reused passing verification: ' + reportFile + ' (' + previous.finishedAt + ')');
    process.exit(0);
  }
}
function counters() {
  try {
    const result = Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').trim().split('\n').map(line => line.split(' ')));
    return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Number(v)]));
  } catch { return null; }
}
report.memoryEventsBefore = counters();
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.sort()], {
  cwd: root, env: options, stdio: 'inherit', detached: process.platform !== 'win32',
});
let pressureSamples = 0;
const stop = signal => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch {} };
const monitor = setInterval(() => {
  try {
    const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const limit = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
    const stats = Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').trim().split('\n').map(l => l.split(' ')));
    const effective = current - Number(stats.inactive_file ?? 0);
    report.maxCgroupBytes = Math.max(current, report.maxCgroupBytes);
    report.maxEffectiveBytes = Math.max(effective, report.maxEffectiveBytes);
    pressureSamples = Number.isFinite(limit) && effective > limit * 0.85 ? pressureSamples + 1 : 0;
    if (pressureSamples >= 3 && !report.resourceStopped) {
      report.resourceStopped = true;
      console.error('Stopping test process group: sustained memory pressure.');
      stop('SIGTERM');
    }
  } catch {}
}, 500);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
child.once('error', error => { report.error = error.message; });
child.once('close', (code, signal) => {
  clearInterval(monitor);
  Object.assign(report, { code, signal, finishedAt: new Date().toISOString(), memoryEventsAfter: counters() });
  const file = reportFile;
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('Verification report: ' + file);
  process.exitCode = report.resourceStopped ? 2 : (code ?? 1);
});
