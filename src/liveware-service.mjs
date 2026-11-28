import {deferStartupComponent} from './startup-state.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {publishFirstLiveware} from './first-liveware.mjs';
import {resolveDeliveryTarget,routeKey,senderKey} from './routing.mjs';
import {inspectSourceCandidate,selectedSourceRuntime} from './source-candidate.mjs';
import {ownRoot,installedPluginAsync} from './platform-client.mjs';
import {requireCurrentInstanceBinding} from './instance-binding.mjs';

export async function serveLiveware(kind, configPath, signal, interval = 2000, isCurrent = () => true) {
  assert.ok(kind === 'call' || kind === 'song', 'Expected call or song');
  const read = () => JSON.parse(readFileSync(configPath, 'utf8'));
  const enabled = options => kind === 'call' ? options.realtime?.enabled : options.singing?.playback?.enabled;
  let options = read(), route = options.clawchat?.route;
  const bound=()=>{try{requireCurrentInstanceBinding(options);return !!route;}catch(error){
    if(error.code==='FIRST_BINDING_PENDING')return false;throw error;
  }};
  while ((await isCurrent())!==false && enabled(options) && !bound()) {
    await delay(interval, undefined, {signal});
    options = read();
    route = options.clawchat?.route;
  }
  if ((await isCurrent())===false || !enabled(options)) return;
  assert.ok(resolveDeliveryTarget(options, {origin:route}).ok, 'Liveware requires a verified private binding');
  let server;
  if (kind === 'call') {
    if(options.realtime.sessionEnabled===false){
      const {startPausedCall}=await import('./paused-call.mjs');
      server=await startPausedCall(options);
    }else{
      const {startPlatformVoiceLiveware,voiceSessionPort} = await import('./platform-voice-liveware.mjs');
      server = await startPlatformVoiceLiveware(options, {bridgePort:voiceSessionPort(options)});
    }
  } else {
    const {startSongPlayback} = await import('./song-playback.mjs');
    server = await startSongPlayback(options);
  }

  const service = new AbortController();
  const stop = AbortSignal.any([signal, service.signal]);
  server.stopped?.then(() => service.abort(Error('Call gateway exited')));
  try {
    while (!stop.aborted) {
      const selection=await isCurrent();if(selection===false)return;
      // A restarting platform is unknown, not a different selected plugin.
      // Keep the authenticated local page and pause publication until recovery.
      if(selection===null){await delay(interval,undefined,{signal:stop});continue;}
      const current = read(), currentRoute = current.clawchat?.route;
      requireCurrentInstanceBinding(current);
      if (!enabled(current)) return;
      assert.ok(currentRoute && routeKey(route) === routeKey(currentRoute)
        && senderKey(route) === senderKey(currentRoute), 'Liveware binding changed');
      try { await publishFirstLiveware(current, kind, server.port, stop); }
      catch (error) { if (!stop.aborted) {deferStartupComponent(current,'song-liveware');console.error('[whalenest-liveware] publication will retry', error.name);} }
      await delay(interval, undefined, {signal:stop});
    }
    if (service.signal.aborted && !signal.aborted) throw service.signal.reason;
  } finally { await server.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => controller.abort());
  try {
    const [, , kind, configPath] = process.argv;
    const options = JSON.parse(readFileSync(configPath, 'utf8'));
    const installed=()=>installedPluginAsync(options);
    // Core acquires this page before opening its management endpoint. Locate
    // our own code locally; verify the live selection before publication.
    const entry = selectedSourceRuntime(options);
    assert.ok(entry?.status === 'active' && isAbsolute(entry.activeArtifact));
    const candidate=inspectSourceCandidate(options,entry);
    const source = candidate?join(candidate.root,'src/liveware-service.mjs'):join(ownRoot(options,entry),'src/liveware-service.mjs');
    const {serveLiveware:run} = await import(pathToFileURL(source));
    await run(kind, configPath, controller.signal, 2000, async () => {
      let current;try{current=await installed();}catch{return null;}
      return current?.status === 'active' && current.activeArtifact === entry.activeArtifact
        && inspectSourceCandidate(options,current,{verify:false})?.manifestSha256===candidate?.manifestSha256;
    });
  }
  catch (error) {
    if (!controller.signal.aborted) {
      console.error('[whalenest-liveware] service stopped', error.message);
      process.exitCode=1;
    }
  }
}
