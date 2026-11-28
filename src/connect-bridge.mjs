import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import { persistedEvents, terminalTurns } from './native-replay.mjs';
import { createCompanion } from './companion.mjs';
import { routeKey, senderKey } from './routing.mjs';
import { createUserMessage } from './native-dsh.mjs';
import {clawchatTextDelivery} from './clawchat-text.mjs';
import {createFirstBinding, firstBindingPorts, prepareFirstBinding} from './first-binding.mjs';
import {isVoiceInput} from './voice-history.mjs';
import {refreshFirstGreeting} from './greeting.mjs';
import {startupStatus} from './startup-state.mjs';
import {observeBindingRuntime,requestBindingReload} from './binding-reload.mjs';

export async function installAurabotBridge(ctx, { handles, activate, ready, configPath, transport, qqRequestReload }) {
  configPath = configPath instanceof URL ? fileURLToPath(configPath) : resolve(configPath);
  const options = JSON.parse(readFileSync(configPath, 'utf8'));
  const firstBinding = prepareFirstBinding(options, configPath);
  observeBindingRuntime(options,firstBinding);
  const route = options.clawchat?.route;
  assert.ok(route?.channel === 'clawchat' && route.kind === 'private', 'Verified ClawChat private route required');
  assert.ok(options.owners.some(o => senderKey(o) === senderKey(route)), 'ClawChat owner association required');
  const dataDirectory = join(resolve(options.dataDir), 'aurabot');
  assert.ok(!process.env.AURABOT_DATA_DIR || resolve(process.env.AURABOT_DATA_DIR) === dataDirectory, 'Another Aurabot data directory is already selected');
  process.env.AURABOT_DATA_DIR = dataDirectory;
  let notificationQueued;
  const core = await createCompanion(ctx, options, { configPath, qqRequestReload, notificationQueued:()=>notificationQueued?.(),externalOwner: true, async dispatchBackground(job){
    await ready;
    assert.ok(!job.route||same(job.route),'ClawChat dispatcher cannot accept another platform target');
    const sessionId=[...handles.keys()].reverse().find(id=>core.externalRoute(id))??core.externalSessions().at(-1);
    if(!sessionId)return false;
    if(!handles.has(sessionId))await activate(sessionId);
    const agent=handles.get(sessionId)?.agent;
    if(!agent||core.voiceActive(sessionId)||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)return false;
    const message=createUserMessage({content:[{type:'text',text:core.backgroundPrompt(job)}],source:{kind:'schedule',taskId:job.id}});
    core.acceptBackground(job.id,String(agent.id),String(message.id));agent.followup(message);return true;
  } });
  try {
    if (options.clawchat.legacySnapshotPath) {
      core.bootstrapExternal(JSON.parse(readFileSync(options.clawchat.legacySnapshotPath, 'utf8')), route);
    }
  } catch (error) { await core.dispose(); throw error; }
  let closed = false, tail = Promise.resolve();
  const voiceFlights=new Map();
  const voiceTurns=new Map();
  const enqueue = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const send = transport ?? clawchatTextDelivery(options,route);
  async function drain() {
    if (closed) return;
    for (const intent of core.outbox()) {
      if (closed) return;
      const qqOwner=intent.route?.channel==='qq'&&intent.route.kind==='private'&&intent.route.conversation===intent.route.sender&&options.owners.some(o=>senderKey(o)===senderKey(intent.route));
      if (intent.state === 'pending' && (same(intent.route)||qqOwner)) {
        const gate=core.backgroundDelivery(intent);
        if(gate==='suppressed'){core.suppressDelivery(intent.id);continue;}
        if(gate)continue;
        const latest=await core.prepareNotice(intent.id);
        if(closed)return;
        if(!latest)continue;
        const rechecked=core.backgroundDelivery(latest);
        if(rechecked==='suppressed'){core.suppressDelivery(intent.id);continue;}
        if(rechecked)continue;
        await core.deliver(intent.id,{async sendText(current){
          const blocked=core.backgroundDelivery(current,{begin:true});
          if(blocked)throw Object.assign(new Error('Background delivery deferred: '+blocked),{definitelyNotSent:true});
          let result;
          if(qqOwner){
            const ack=await core.native.hub.sendSegments('private:'+current.route.sender,[{type:'text',data:{text:current.text}}],'伙伴主动通知',{retries:0,throwOnError:true});
            if(!ack)throw Object.assign(Error('QQ did not submit this message'),{definitelyNotSent:true});
            assert.ok(ack.message_id!==undefined&&!String(ack.message_id).startsWith('sim-'),'Missing real QQ acknowledgement');result={messageId:String(ack.message_id)};
          }else result=await send.sendText(current);
          core.backgroundDelivery(current,{confirmed:true});return result;
        }});
      }
    }
  }
  core.flushNotifications=()=>enqueue(drain);
  notificationQueued=()=>{void enqueue(drain).catch(()=>{});};
  const allowed = id => core.externalRoute(id);
  const same = value => routeKey(value) === routeKey(route) && senderKey(value) === senderKey(route);
  function routeFor(params, sessionId) {
    if (params.whalenestChatId !== undefined) assert.equal(params.whalenestChatId, route.conversation, 'Unverified ClawChat conversation');
    else assert.ok(allowed(sessionId), 'Cold activation has no verified route');
    const previous = allowed(sessionId);
    assert.ok(!previous || same(previous), 'Session route mismatch');
    return structuredClone(route);
  }
  const offSchedule = ctx.on('schedule/resolve-agent', async sessionId => {
    const existing = allowed(String(sessionId));
    assert.ok(existing && same(existing), 'Scheduled session has no trusted route');
    await ready;
    await voiceTurns.get(String(sessionId))?.settled.promise;
    if (!handles.has(String(sessionId))) await activate(String(sessionId));
    const agent = handles.get(String(sessionId))?.agent;
    assert.ok(agent, 'Native owner did not activate the scheduled session');
    return agent;
  }, true);
  async function reconcileSession(sessionId) {
    if (!same(allowed(sessionId))) return;
    await core.memoryAdapter.refresh();
    const events = await persistedEvents(ctx.sessionPersistence, sessionId);
    const cursor = core.replayCursor(sessionId);
    // An imported legacy journal predates our durability boundary. Baseline it
    // once; keep its explicit confirmed/uncertain outbox receipts unchanged.
    if (cursor === undefined) {
      core.checkpointExternal(sessionId, events.at(-1)?.seq ?? -1);
      return;
    }
    assert.ok(cursor <= (events.at(-1)?.seq ?? -1), 'Native journal is older than the replay checkpoint');
    for (const turn of terminalTurns(events, cursor)) {
      core.completeBackgroundTurn(turn.ids,turn.text,turn.completed);
      if (turn.eligible) await core.queueExternalDelivery(sessionId, turn.ids, turn.text, turn.seq);
      else core.checkpointExternal(sessionId, turn.seq);
    }
  }
  // Baseline imported routes before the native scheduler is allowed to activate.
  try {
    for (const id of core.externalSessions()) if (core.replayCursor(id) === undefined) await reconcileSession(id);
  } catch (error) { offSchedule(); await core.dispose(); throw error; }
  async function reconcile() {
    for (const id of core.externalSessions()) await reconcileSession(id);
    await drain();
  }
  const offEvents = ctx.on('session/event', (session, event) => {
    const id = String(session.id);
    if (!allowed(id) || event.type !== 'turn/end') return;
    void enqueue(async () => {
      assert.ok(await ctx.sessions.flush(session), 'Scheduled output must be durable');
      await reconcileSession(id);
      await drain();
      await core.qqConnection?.afterTurn(id);
      await core.tickPluginUpdates({notices:false});
    }).catch(() => { console.error('[whalenest-connect] scheduled delivery requires reconciliation'); });
  });
  let cycleFlight;
  const cycle=()=>{
    if(closed||cycleFlight)return cycleFlight;
    cycleFlight=(async()=>{await enqueue(reconcile);if(!closed)await core.tickPluginUpdates();if(!closed)await core.tickBiliInbox();if(!closed)await enqueue(drain);if(!closed)await core.tickBackground();if(!closed)await enqueue(drain);})().finally(()=>{cycleFlight=null;});return cycleFlight;
  };
  const retry = setInterval(() => { void cycle()?.catch(() => {}); }, 30000);
  retry.unref();
  void ready.then(cycle).catch(() => {
    console.error('[whalenest-connect] startup reconciliation failed; pending delivery retained');
  });
  const welcomeAbort = new AbortController();
  const welcome = firstBinding && createFirstBinding(firstBinding, firstBindingPorts(options, firstBinding, welcomeAbort.signal),
    () => core.firstGreeting(() => !welcomeAbort.signal.aborted));
  let welcomeTimer;
  async function tickWelcome() {
    if (closed) return;
    let delay = 3000, pending=true;
    try {
      pending=(await refreshFirstGreeting(options,welcome)).pending;
      if(startupStatus(options).avatarSettled&&!startupStatus(options).avatarReady)delay=30000;
    } catch {
      delay = 15000;
    }
    if (!closed && pending) { welcomeTimer = setTimeout(tickWelcome, delay); welcomeTimer.unref(); }
  }
  if (firstBinding) void ready.then(tickWelcome).catch(() => {});
  if(firstBinding)void ready.then(()=>requestBindingReload(options,configPath)).catch(()=>{});
  const dispose = async () => {
    if (closed) return;
    closed = true; clearInterval(retry); offSchedule(); offEvents();
    clearTimeout(welcomeTimer); welcomeAbort.abort();
    await welcome?.close();
    for(const v of voiceFlights.values())v.controller.abort();
    await Promise.allSettled([...voiceFlights.values()].map(v=>v.promise));
    core.abortBiliInbox();
    await cycleFlight?.catch(()=>{});await tail; await core.dispose();
  };
  ctx.effect(() => dispose);
  // Exported only inside this trusted Cordis host, never to the model or network.
  ctx.provide('whaleNest', core);
  return {
    async voiceMode({sessionId,enabled}) {
      assert.ok(options.realtime?.enabled&&same(allowed(sessionId)),'Unverified voice Session');
      assert.equal(typeof enabled,'boolean');
      const agent=handles.get(sessionId)?.agent;
      assert.ok(agent,'Voice Session is not active');
      const voice=voiceTurns.get(sessionId);
      if(enabled) {
        assert.ok(!voice&&agent.status==='idle'&&!agent.inbox.nextTurn.length&&!agent.inbox.nextStep.length,'Voice Session is busy');
        core.setVoiceSession(sessionId,true);
        voiceTurns.set(sessionId,{model:agent.model?.current?.(),settled:Promise.withResolvers()});
      } else if(voice) {
        try {
          const current=agent.model?.current?.();
          if(voice.model&&JSON.stringify(voice.model)!==JSON.stringify(current))agent.model.select(voice.model);
          await ctx.sessions.flush(agent.session);
        } finally {
          core.setVoiceSession(sessionId,false);
          voiceTurns.delete(sessionId);
          voice.settled.resolve();
        }
      }
      return {enabled};
    },
    voiceInputSource(agent,inputId,source) {
      if(!isVoiceInput(inputId)&&source===undefined)return {};
      assert.ok(source==='realtime-call'&&isVoiceInput(inputId)&&core.voiceActive(String(agent.id)),'Unverified voice input');
      return {whalenestOrigin:'realtime-call'};
    },
    voicePlayback({sessionId,playback}){assert.ok(options.realtime?.enabled&&same(allowed(sessionId)),'Unverified voice Session');core.setVoicePlayback(sessionId,playback);return {recorded:true};},
    async voiceSpeech({sessionId,text,requestId}){
      assert.ok(options.realtime?.enabled&&same(allowed(sessionId)),'Unverified voice Session');
      assert.ok(typeof requestId==='string'&&/^whalenest-call-tts-[a-zA-Z0-9-]{1,180}$/.test(requestId),'Invalid voice request');
      assert.ok(!voiceFlights.has(sessionId),'Voice synthesis is already running');
      const controller=new AbortController(),promise=core.speech.synthesize(text,requestId,{signal:controller.signal});voiceFlights.set(sessionId,{controller,promise});
      try{return await promise;}finally{voiceFlights.delete(sessionId);}
    },
    async cancelVoiceSpeech({sessionId}){assert.ok(same(allowed(sessionId)),'Unverified voice Session');const v=voiceFlights.get(sessionId);if(v){v.controller.abort();await v.promise.catch(()=>{});}return {drained:true};},
    inspect(id) {
      const agent = handles.get(id)?.agent;
      return { ...core.status(), trustedSessions: core.externalSessions().length,
        ...(agent ? { sessionId: String(agent.id), model: agent.model?.current?.(),
          tools: ctx.tools.definitions(agent).map(t => t.name) } : {}) };
    },
    async express({sessionId,inputId,allowVoice=true,afterReply=false}) {
      assert.ok(same(allowed(sessionId)),'Expression session has no trusted owner route');
      const agent=handles.get(sessionId)?.agent;assert.ok(agent,'Expression session is not active');
      assert.equal(agent.status,'idle','Expression requires a completed native turn');
      return core.expressions.reply(agent,inputId,{allowVoice,afterReply});
    },
    cancelExpression({sessionId,inputId}) { assert.ok(same(allowed(sessionId)),'Unverified expression session');return core.expressions.cancel(sessionId,inputId); },
    routeFor,
    mount(scope, agent, authenticatedRoute) { core.mountExternal(scope, agent, authenticatedRoute); },
    async evictBefore(id) {
      if (handles.has(id)) return;
      await tail;
      while (handles.size >= (options.maxLiveSessions ?? 1)) {
        const [oldId, handle] = handles.entries().next().value;
        assert.equal(handle.agent.status, 'idle', 'Previous session is active; retry after it becomes idle');
        await ctx.sessions.flush(handle.agent.session);
        await handle.dispose(); handles.delete(oldId);
      }
    },
    acceptedInput(agent, inputId) {
      for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
        if (message.source?.connectInputId === inputId) return String(message.id);
      }
      for (let n = agent.session.seq; n >= 0; n--) {
        const event = agent.session.eventAt(n);
        if (event?.type === 'user/message' && event.data.source?.connectInputId === inputId) return String(event.data.id);
      }
    },
    preparePrompt: (id, inputId, text, content) => core.prepareExternal(id, { inputId, text, content }),
    async record(method, params) {
      if (!['create', 'resume'].includes(method)) return;
      routeFor(params, params.sessionId);
      const agent = handles.get(params.sessionId)?.agent;
      assert.ok(agent, 'Session owner did not publish the handle');
      ctx.permissionPresets.set(agent.session, 'danger-full-access');
      await ctx.sessions.flush(agent.session);
    },
    settled: () => tail,
    dispose,
  };
}
