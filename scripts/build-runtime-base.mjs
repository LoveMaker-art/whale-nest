import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));

export async function buildRuntimeBase(destination,{portable=false}={}) {
  await mkdir(destination,{recursive:true});
  const manifest=JSON.parse(await readFile(join(root,'integration/clawchat/SOURCE.json')));
  let source=await readFile(join(root,'integration/clawchat/base/linux-x64.mjs'),'utf8');
  const {createHash}=await import('node:crypto');
  assert.equal(createHash('sha256').update(source).digest('hex'),manifest.files['base/linux-x64.mjs']);
  const replace=(before,after,count=1)=>{assert.equal(source.split(before).length,count+1,'Runtime baseline changed');source=source.split(before).join(after);};
  for(const [client,count]of [['harness.client',2],['this.client',1],['client',1]])
    replace(client+'.request("history", { sessionId: runtimeThreadId })','readBridgeHistory('+client+', runtimeThreadId)',count);
  replace('return projectDshHistory(runtimeThreadId, history.events);','return projectDshHistory(runtimeThreadId, visibleChatEvents(history.events));');
  replace('const identities = history.events.flatMap((event) => {','const identities = visibleChatEvents(history.events).flatMap((event) => {');
  replace('      case "request/context":','      case "request/context":\n      case "model/selection":\n      case "compaction/summary":\n      case "compaction/prune":');
  replace('        await this.client.request("prompt", {','        input.voiceSignal?.throwIfAborted();\n        await this.client.request("prompt", {');
  replace('          text: input.prompt,','          text: input.prompt,\n          ...(input.metadata?.whalenestSource === "realtime-call" ? { whalenestSource: "realtime-call" } : {}),');
  replace('    start: async (context) => await adapter.start(binding, runtimeStartContext(context)),',`    start: async (context) => {
      const session = await adapter.start(binding, runtimeStartContext(context));
      return { prompt: input => session.prompt(input), cancel: () => session.cancel(), close: () => session.close(),
        prepareVoice: input => session.ensureThread(input),
        voiceMode: enabled => session.client.request("companionVoiceMode", { sessionId: session.runtimeThreadId, enabled }),
        voicePlayback: playback => session.client.request("companionVoicePlayback", { sessionId: session.runtimeThreadId, playback }),
        voiceSpeech: params => session.client.request("companionVoiceSpeech", { sessionId: session.runtimeThreadId, ...params }, 60000),
        cancelVoiceSpeech: () => session.client.request("cancelCompanionVoiceSpeech", { sessionId: session.runtimeThreadId }),
        expressReply: params => session.client.request("companionExpression", { sessionId: session.runtimeThreadId, ...params }, 60000),
        cancelExpression: params => session.client.request("cancelCompanionExpression", { sessionId: session.runtimeThreadId, ...params }) };
    },`);
  const history=portable?'./whalenest/src/bridge-history.mjs':pathToFileURL(join(root,'src/bridge-history.mjs')).href;
  const voiceHistory=portable?'./whalenest/src/voice-history.mjs':pathToFileURL(join(root,'src/voice-history.mjs')).href;
  const file=join(resolve(destination),'linux-x64-base.mjs');
  await writeFile(file,'import {readBridgeHistory} from '+JSON.stringify(history)+';\nimport {visibleChatEvents} from '+JSON.stringify(voiceHistory)+';\n'+source,{mode:0o600});
  return file;
}
