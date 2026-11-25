// Run only while the Core supervisor is stopped. Uses the actual home/profile.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {verifyLiveTools,verifyLiveModules} from './lib/live-tools.mjs';
import {readBridgeHistory} from '../src/bridge-history.mjs';
import {waitForSdkExit} from '../src/recovery.mjs';
import {routeKey, senderKey} from '../src/routing.mjs';
import {voiceModelOverlay,fastVoiceModel} from '../src/voice-model.mjs';
process.umask(0o077);
const [instancePath, bridgePath, outputPath, dialoguePath] = process.argv.slice(2);
const instance = JSON.parse(await readFile(instancePath));
const platform = JSON.parse(await readFile(instance.clawchat.delivery.configPath));
const route = instance.clawchat.route;
const database = new DatabaseSync(platform.stateDbPath, {readOnly:true});
let privateSessionId;
try {
  privateSessionId=database.prepare(`SELECT runtime_session_id AS id FROM runtime_sessions
    WHERE chat_id=? AND agent_id=? AND is_current=1 ORDER BY updated_at DESC LIMIT 1`).get(route.conversation,route.account)?.id;
} finally {database.close();}
const release = dirname(instance.clawchat.delivery.connectBin);
const { nativeModel, modelPatch } = await import(pathToFileURL(join(release, 'runtime/lib.mjs')));
const model = nativeModel();
await waitForSdkExit(instance, 0);
const overlay = outputPath + '.overlay.json';
await writeFile(overlay, JSON.stringify([...voiceModelOverlay({modelPatchFile:modelPatch}),{id:'sdk-jsonrpc-server',disabled:true},{ insert: [{ id: 'clawchat-connect-bridge', name: resolve(bridgePath),
  config: { home: instance.home, profile: 'sdk', build: 'whalenest-live-m1', maxFrameBytes: 16 * 1024 * 1024 } }] }]), { mode: 0o600 });
const child = spawn(process.execPath, ['/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '--profile', 'sdk', '--patch', modelPatch, '--patch', overlay], {
  cwd: instance.cwd, env: { ...model.env, DSH_HOME: instance.home,
    NODE_OPTIONS: '--max-old-space-size=384', CONNECT_DSH_BRIDGE_FD_OUT: '3', CONNECT_DSH_BRIDGE_FD_IN: '4' },
  stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'],
});
let log = '', sequence = 0, spawnError, hasClosed = false, interrupted = false, shutdown = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
child.on('error', error => { spawnError = error; });
child.once('close', () => { hasClosed = true; });
const frames = [];
child.stderr.on('data', b => log = (log + b).slice(-32000));
createInterface({ input: child.stdio[3] }).on('line', line => { try { frames.push(JSON.parse(line)); } catch {} });
async function wait(predicate, timeout = 25000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    assert.ok(!interrupted, 'Live probe interrupted');
    assert.ok(!spawnError, 'Actual DSH spawn failed: ' + spawnError?.code);
    const result = predicate(); if (result) return result;
    assert.ok(child.exitCode === null && child.signalCode === null, 'Actual DSH process exited');
    await delay(30);
  }
  throw new Error('Actual DSH readiness/request timeout');
}
async function rawRequest(method, params = {}) {
  const id = 'live-probe-' + ++sequence;
  child.stdio[4].write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
  const response = await wait(() => frames.find(f => f.type === 'response' && f.id === id));
  assert.ok(response.ok, 'Native bridge request failed: ' + (response.error?.code ?? method));
  return response.result;
}
const request=(method,params={})=>method==='history'?readBridgeHistory({request:rawRequest},params.sessionId):rawRequest(method,params);
const report = { at: new Date().toISOString(), environment: 'actual existing DSH_HOME/profile sdk', modelCalls: 0, platformMessagesSent: 0 };
try {
  await wait(() => frames.find(f => f.type === 'hello'));
  const models = await request('models');
  assert.ok(JSON.stringify(models).includes(model.provider) && JSON.stringify(models).includes(model.model), 'Existing provider/model must be available');
  if (instance.realtime?.enabled && voiceModelOverlay({modelPatchFile:modelPatch}).length) {
    const callModel = models.find(item => item.provider === fastVoiceModel.provider && item.id === fastVoiceModel.model);
    assert.ok(callModel?.reasoning?.efforts?.some(effort => effort.id === 'off'), 'Call model overlay must retain reasoning off');
    report.callModelOverlay = {provider:callModel.provider,model:callModel.id,reasoningEffort:'off'};
  }
  const legacyPath = instance.clawchat.legacySnapshotPath;
  const old = legacyPath ? JSON.parse(await readFile(legacyPath)) : null;
  const state = JSON.parse(await readFile(join(instance.dataDir, 'runtime.json')));
  const candidates = Object.entries(state.externalRoutes ?? {}).filter(([, value]) =>
    routeKey(value) === routeKey(route) && senderKey(value) === senderKey(route));
  const currentId = privateSessionId ?? candidates.at(-1)?.[0];
  const legacyId = old?.chatId === route.conversation && old.ownerId === route.sender
    ? old.state.latestSessionId ?? old.state.sessions[0] : null;
  const sessionId = currentId ?? legacyId;
  assert.ok(sessionId, 'Existing owner session required');
  const before = await request('history', { sessionId });
  const messageDigest = events => createHash('sha256').update(JSON.stringify(events.filter(e => ['user/message', 'assistant/message'].includes(e.type)))).digest('hex');
  const beforeHash = messageDigest(before.events);
  await request('resume', { sessionId, whalenestChatId: instance.clawchat.route.conversation });
  const status = await request('companionStatus', { sessionId });
  assert.equal(status.nativeQQHost,true,'Original Aurabot QQ host must be active');
  verifyLiveModules(status);
  assert.equal(status.tools.filter(name=>name==='companion_settings').length,1,'Missing or duplicated shared settings tool');
  for (const name of ['remember', 'recall_memory', 'bili_watch']) assert.ok(status.tools.includes(name), 'Missing tool: ' + name);
  for (const name of ['companion_persona', 'companion_memory']) assert.equal(status.tools.filter(t => t === name).length, 1, 'Missing or duplicated foundation tool: ' + name);
  if(instance.expressions?.enabled) {
    for(const name of ['companion_expression','companion_stickers'])assert.equal(status.tools.filter(t=>t===name).length,1,'Missing expression tool: '+name);
    assert.ok(status.expressions?.enabled&&Number.isInteger(status.expressions.stickerCount),'Expression library is not ready');
  }
  if(instance.clawchat.delivery.mediaEnabled)for(const name of ['send_media','media_status'])assert.ok(status.tools.includes(name),'Missing media tool: '+name);
  const profile=JSON.parse(await readFile(join(instance.home,'profiles/sdk/package.json')));
  const toolVerification=verifyLiveTools(status,profile,{activitiesEnabled:instance.activities?.enabled===true,speechEnabled:Boolean(instance.speech?.enabled&&instance.speech?.ttsModel),imagesEnabled:instance.image?.enabled===true,songsEnabled:instance.singing?.enabled===true});
  const after = await request('history', { sessionId });
  assert.equal(messageDigest(after.events), beforeHash, 'Existing messages must survive resume unchanged');
  Object.assign(report, { ok: true, originalSessionResumed: true, historyPreserved: true,
    historicalMessageEvents: before.events.filter(e => ['user/message', 'assistant/message'].includes(e.type)).length,
    modules: status.modules, nativeQQHost:status.nativeQQHost, memoryTools: true, biliWatch: true,...toolVerification,
    foundationTools: true, persona: status.persona, memoryMaintenance: status.memory, expressions:status.expressions,qqNative:status.qqNative,singing:status.singing,
    provider: model.provider, model: model.model, liveSessions: status.liveSessions,mediaTools:instance.clawchat.delivery.mediaEnabled===true });
  if (dialoguePath) {
    const prompts = JSON.parse(await readFile(dialoguePath));
    assert.ok(Array.isArray(prompts) && prompts.length >= 1 && prompts.length <= 3, 'Provide 1..3 labelled test prompts');
    delete report.modelCalls;
    report.dialogue = []; report.actualModelTurns = 0; report.inputOrigin = 'operator native bridge; not a ClawChat client upload';
    for (const item of prompts) {
      assert.ok(typeof item.id === 'string' && item.id.startsWith('whalenest-selftest-') && typeof item.text === 'string' && item.text.includes('运维自测'), 'Labelled operator test identity required');
      const history = await request('history', { sessionId });
      let user = history.events.find(event => event.type === 'user/message' && (event.data.message ?? event.data).source?.connectInputId === item.id);
      let reused = !!user;
      if (!user) {
        report.actualModelTurns++;
        await request('prompt', { sessionId, inputId: item.id, text: item.text });
        await wait(() => frames.find(frame => frame.type === 'event' && frame.sessionId === sessionId && frame.event.type === 'user/message'
          && (frame.event.data.message ?? frame.event.data).source?.connectInputId === item.id), 30000);
        user = frames.find(frame => frame.type === 'event' && frame.sessionId === sessionId && frame.event.type === 'user/message'
          && (frame.event.data.message ?? frame.event.data).source?.connectInputId === item.id).event;
        await wait(() => frames.find(frame => frame.type === 'event' && frame.sessionId === sessionId && frame.event.type === 'turn/end' && frame.event.seq > user.seq), 180000);
      }
      const saved = await request('history', { sessionId });
      const end = saved.events.find(event => event.type === 'turn/end' && event.seq > user.seq);
      assert.ok(end, 'Test turn is incomplete; held without resubmitting');
      const events = saved.events.filter(event => event.seq > user.seq && event.seq <= end.seq);
      const assistant = events.filter(event => event.type === 'assistant/message').map(event => event.data.message);
      const tools = assistant.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.name));
      const reply = assistant.filter(message => !message.content.some(block => block.type === 'tool-call')).at(-1)?.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      const entry = { inputId: item.id, prompt: item.text, reply: reply ?? '', tools, reason: end.data.reason.kind, reused, observedAssistantMessages: assistant.length };
      report.dialogue.push(entry); await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      assert.equal(entry.reason, 'completed', 'Real model turn failed'); assert.ok(entry.reply, 'Real model final reply missing');
      for (const required of item.requiredTools ?? []) assert.ok(tools.includes(required), 'Expected real tool was not used: ' + required);
      if (item.forbiddenTools) assert.ok(!tools.some(name => item.forbiddenTools.includes(name)), 'Follow-up unexpectedly reran a browse');
      assert.equal(messageDigest(saved.events.filter(event => event.seq <= (before.events.at(-1)?.seq ?? -1))), beforeHash, 'Pre-test messages changed');
    }
    report.companionAfter = (await request('companionStatus', { sessionId })).companion;
  }
  await request('shutdown'); shutdown = true;
} catch (error) {
  report.ok = false; report.error = error.message;
  throw error;
} finally {
  if (!shutdown && !hasClosed) { interrupted = false; try { await request('shutdown'); } catch {} }
  await writeFile(outputPath + '.private.log', log, { mode: 0o600 });
  await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  child.stdin.end();
  if (!hasClosed && child.exitCode === null && child.signalCode === null) {
    const timer = setTimeout(() => child.kill('SIGTERM'), 1500);
    const force = setTimeout(() => child.kill('SIGKILL'), 4500);
    await new Promise(r => child.once('close', r));
    clearTimeout(timer); clearTimeout(force);
  }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
console.log(JSON.stringify(report));
