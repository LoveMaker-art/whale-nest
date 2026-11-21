import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildConnectBridge(destination, { configPath, portable = false } = {}) {
  destination = resolve(destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const base = join(root, 'integration/clawchat/base');
  let text = await readFile(join(base, 'deepseek-harness-bridge.mjs'), 'utf8');
  const source = text;
  const manifest = JSON.parse(await readFile(join(root, 'integration/clawchat/SOURCE.json')));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(root, 'integration/clawchat', name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Compatible bridge source changed: ' + name);
  }
  const once = (before, after) => {
    assert.equal(text.split(before).length, 2, 'Bridge baseline changed: ' + before.slice(0, 80));
    text = text.replace(before, after);
  };
  once("import { installCompanion } from './whalenest-companion.mjs';", 'import { installAurabotBridge } from ' + JSON.stringify(portable ? './whalenest/src/connect-bridge.mjs' : pathToFileURL(join(root, 'src/connect-bridge.mjs')).href) + ';\nimport {historyPage} from '+JSON.stringify(portable?'./whalenest/src/bridge-history.mjs':pathToFileURL(join(root,'src/bridge-history.mjs')).href)+';');
  once('"sessionPersistence", "llm", "schedule"];', '"sessionPersistence", "llm", "tools", "systemPrompt", "permissionPresets", "agentDefaultModel", "attachments", "fileUploads", "fs", "remoteAccess", "sessionProjections", "sessionQuery", "typert", "typertGateway", "workspaceRegistry", "timer"];');
  once('  const handles = new Map();', '  const handles = new Map();\n  let companion;');
  once('requestedPreset, resume }) => {', 'requestedPreset, resume, route }) => {');
  once('        if (agentPresets) await agentPresets.mount(agentCtx, resolvedPreset);', '        if (agentPresets) await agentPresets.mount(agentCtx, resolvedPreset);\n        companion.mount(agentCtx, agent, route);');
  once('      resolvedPreset = (await agentPresets.resolve(requestedPreset)).id;',
    '      resolvedPreset = (await agentPresets.resolve(requestedPreset)).id;\n      if (resolvedPreset.startsWith("aurabot-")) throw bridgeError("unsupported", "QQ Agent Presets are reserved for the QQ Hub");');
  once('presets: (await presets.list()).map((preset) => ({',
    'presets: (await presets.list()).filter(preset => !preset.id.startsWith("aurabot-")).map((preset) => ({');
  for (const method of ['create', 'resume']) {
    once('    async ' + method + '(params) {\n      const sessionId = requestString(params, "sessionId");',
      '    async ' + method + '(params) {\n      const sessionId = requestString(params, "sessionId");\n      const route = companion.routeFor(params, sessionId);\n      await companion.evictBefore(sessionId);');
  }
  once('        resume: false,', '        resume: false,\n        route,');
  once('        resume: true,', '        resume: true,\n        route,');
  once('      const inputId = requestString(params, "inputId");\n      const text =',
    '      const inputId = requestString(params, "inputId");\n      const accepted = companion.acceptedInput(handle.agent, inputId);\n      if (accepted) return { inputId, messageId: accepted };\n      const text =');
  once('      const message = createUserMessage({\n        content: [\n          { type: "text", text },\n          ...imageRefs.map((attachment) => ({ type: "image", attachment })),\n        ],',
    '      const voiceSource = companion.voiceInputSource(handle.agent, inputId, params.whalenestSource);\n      const content = await companion.preparePrompt(String(handle.agent.id), inputId, text, [\n        { type: "text", text }, ...imageRefs.map(attachment => ({ type: "image", attachment })),\n      ]);\n      const message = createUserMessage({\n        content,');
  once('source: { kind: "user", connectInputId: inputId },',
    'source: { kind: "user", connectInputId: inputId, ...voiceSource },');
  once('  const companion = await installCompanion(ctx, {', '  companion = await installAurabotBridge(ctx, {');
  once('configPath: config.companionConfigPath,', 'configPath: config.aurabotConfigPath ?? ' +
    (portable ? 'new URL("./companion/aurabot-v1/instance.json", "file://" + (config.home.endsWith("/") ? config.home : config.home + "/"))' : configPath ? JSON.stringify(resolve(configPath)) : 'new URL("./instance.json", import.meta.url)') + ',');
  once("    try { await companion.record(request.method, params); }\n    catch (error) { console.error('[whalenest-companion] route registration failed:', error.code ?? error.name); }",
    '    await companion.record(request.method, params);');
  once('    async presets() {', '    async companionStatus(params) { return companion.inspect(params.sessionId); },\n\n    async presets() {');
  once('    async companionStatus(params) {', '    async companionExpression(params) { return companion.express(params); },\n    async cancelCompanionExpression(params) { return companion.cancelExpression(params); },\n    async companionStatus(params) {');
  once('    async companionStatus(params) {', '    async companionVoiceMode(params) { return companion.voiceMode(params); },\n    async companionVoiceSpeech(params) { return companion.voiceSpeech(params); },\n    async cancelCompanionVoiceSpeech(params) { return companion.cancelVoiceSpeech(params); },\n    async companionStatus(params) {');
  once('    async companionStatus(params) {', '    async companionVoicePlayback(params) { return companion.voicePlayback(params); },\n    async companionStatus(params) {');
  once('return { header: handle.agent.session.header, events: sessionEvents(handle.agent.session) };','return historyPage({ header: handle.agent.session.header, events: sessionEvents(handle.agent.session) }, params);');
  once('return { header: inspection.meta, events: [...inspection.events] };','return historyPage({ header: inspection.meta, events: [...inspection.events] }, params);');
  once('request?.method === "interactionResponse" || request?.method === "cancel"', 'request?.method === "interactionResponse" || request?.method === "cancel" || request?.method === "cancelCompanionExpression" || request?.method === "cancelCompanionVoiceSpeech"');
  once('    async archive(params) {\n', '    async archive(params) {\n      await companion.settled();\n');
  once('    async shutdown() {\n', '    async shutdown() {\n      await companion.dispose();\n');
  once('    companion.dispose();', '    await companion.dispose();');
  once('  markBridgeInstalled();', '  ctx.provide("sdkSessionActivation", { ready: true });\n  markBridgeInstalled();');
  await writeFile(join(destination, 'bridge.mjs'), text, { mode: 0o600 });
  for (const name of ['deepseek-harness-tool-policy.mjs', 'deepseek-harness-question-provider.mjs']) await copyFile(join(base, name), join(destination, name));
  const sha = value => createHash('sha256').update(value).digest('hex');
  await writeFile(join(destination, 'provenance.json'), JSON.stringify({ baseline: '0.1.0-beta.9-whalenest.3',
    sourceSha256: sha(source), bridgeSha256: sha(text), coreModule: 'src/connect-bridge.mjs' }, null, 2));
  return join(destination, 'bridge.mjs');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildConnectBridge(process.argv[2] ?? '.whale-nest/connect-build'));
