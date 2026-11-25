import {createServer} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {readState,writeState} from './state.mjs';
import {selectFastVoiceModel} from './voice-model.mjs';
import {defaultPlatformVoice} from './speech.mjs';

const callIdPattern = /^vs_[a-f0-9]{32}$/;
const clientIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const fault = (status,code) => Object.assign(new Error(code),{status,code});

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw fault(413,'request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export async function startPlatformVoiceBridge(options,{secret,withPrivateVoiceSession,listModels,readProfile,port=0}) {
  const route = options.clawchat.route;
  if (typeof withPrivateVoiceSession !== 'function') throw Error('Connect does not support voice in the current private Session');
  const ownerSession = {chatId:route.conversation,ownerId:route.sender};
  const turns = new Map();
  const closedCalls = new Set();
  let call, stopping = false;
  const profileAbort = new AbortController();
  let profile = {}, profileFlight, refreshProfileAt = 0;

  function currentProfile() {
    if (readProfile && !profileFlight && !stopping && Date.now() >= refreshProfileAt) {
      profileFlight = Promise.resolve().then(() => readProfile(profileAbort.signal)).then(result => {
        const name = typeof result?.nickname === 'string' ? result.nickname.trim().slice(0,80) : '';
        let avatar = '';
        try {
          const url = new URL(result?.avatar_url);
          if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) avatar = url.href;
        } catch {}
        profile = {name,avatar};
        refreshProfileAt = Date.now() + 60000;
      }).catch(() => {
        refreshProfileAt = Date.now() + 15000;
      }).finally(() => { profileFlight = null; });
    }
    return {...profile,pending:Boolean(profileFlight)};
  }

  function emit(turn,type,data={}) {
    const index = turn.events.length + 1;
    const row = `id: ${index}\nevent: ${type}\ndata: ${JSON.stringify({index,...data})}\n\n`;
    turn.events.push(row);
    for (const client of turn.clients) client.write(row);
  }

  function save(turn) {
    writeState(join(options.dataDir,'realtime/platform-turns',turn.id+'.json'),{
      callId:turn.callId,sessionId:turn.sessionId,heard:turn.heard,
      generated:turn.generated,played:turn.played,state:turn.state,timing:turn.timing,
    });
  }

  async function run(turn,current,previous) {
    const started=performance.now();
    const signal=turn.controller.signal;
    try {
      await withPrivateVoiceSession({...ownerSession,sessionRef:current.sessionRef},signal,async(session,direction)=>{
        const {workspace,model,reasoningEffort}=direction;
        const sessionId=await session.prepareVoice({workspace,model,reasoningEffort});
        if(sessionId!==current.sessionId)throw fault(409,'session_changed');
        signal.throwIfAborted();
        await session.voiceMode(true);
        try {
          if(previous)await session.voicePlayback({played:previous.played,interrupted:previous.state==='interrupted'});
          signal.throwIfAborted();
          const selected=selectFastVoiceModel(current.models,model??options.model);
          const input={workspace,model,reasoningEffort,...selected,
            turnId:'whalenest-call-'+turn.id,prompt:turn.heard,metadata:{whalenestSource:'realtime-call'},
            voiceSignal:signal, onAccepted:async()=>{
              turn.cancelSession=()=>session.cancel();
              if(signal.aborted)await turn.cancelSession();
            }};
          const spokenByMessage = new Map();
          emit(turn,'activity',{state:'responding'});
          for await (const item of session.prompt(input)) {
            if (signal.aborted) continue;
            if (item.source && item.source !== 'live') continue;
            if (item.kind === 'tool' && item.state === 'streaming') emit(turn,'activity',{state:'waiting'});
            if (item.kind !== 'assistant' || !['assistant','final'].includes(item.data?.outputKind)) continue;
            const key = item.id ?? 'reply';
            const prefix = spokenByMessage.get(key) ?? '';
            const text = item.text?.trim() ?? '';
            // Only release new visible text. A correction cannot rewrite audio heard already.
            if (!text.startsWith(prefix)) continue;
            const delta = text.slice(prefix.length);
            if (!delta.trim()) continue;
            const part = ((!prefix && turn.generated ? '\n' : '') + delta).slice(0,2000-turn.generated.length);
            if (!part.trim()) continue;
            spokenByMessage.set(key,text);
            if (!turn.generated) turn.timing.firstVisibleMs=Math.round(performance.now()-started);
            turn.generated += part;
            emit(turn,'delta',{text:part});
          }
        } finally {
          delete turn.cancelSession;
          await session.voiceMode(false);
        }
      });
      if (turn.state === 'stopping') return;
      if (!turn.generated) throw Error('No visible response');
      turn.timing.generationMs=Math.round(performance.now()-started);
      turn.state = 'generated';
      save(turn);
      emit(turn,'done',{text:turn.generated});
    } catch {
      if (turn.state !== 'stopping') {
        turn.state = 'failed';
        emit(turn,'error',{code:'dsh_turn_failed'});
      }
    } finally {
      for (const client of turn.clients) client.end();
      turn.clients.clear();
    }
  }

  async function prepareCall(id) {
    if (!callIdPattern.test(id)) throw fault(400,'invalid_call');
    if (stopping || closedCalls.has(id)) throw fault(409,'call_closed');
    if (call && call.id !== id) throw fault(409,'session_busy');
    if (!call) {
      call = {id, byClient:new Map(), preparing:new AbortController()};
      const current = call;
      current.sessionPromise=(async()=>{
        // Catalog lookup can start in parallel with preparing the original DSH thread.
        const models=Promise.resolve().then(()=>listModels?.()).catch(()=>[]);
        await withPrivateVoiceSession(ownerSession,current.preparing.signal,async(session,direction)=>{
          current.sessionRef=direction.sessionRef;
          current.sessionId=await session.prepareVoice(direction);
        });
        current.models=(await models)??[];
      })();
      current.sessionPromise.catch(()=>{if(call===current && !current.closing) call=undefined;});
    }
    const current = call;
    await current.sessionPromise;
    if (current.closing || stopping) throw fault(409,'call_closed');
    return current;
  }

  async function submit(input) {
    const received=performance.now();
    const {user_id:user,client_turn_id:clientId,call_id:id,text} = input;
    if (user !== route.sender) throw fault(403,'owner_only');
    if (!clientIdPattern.test(clientId) || typeof text !== 'string' || !text.trim() || text.length > 32000) {
      throw fault(400,'invalid_turn');
    }
    const current = await prepareCall(id);
    const existing = current.byClient.get(clientId);
    if (existing) {
      if (existing.heard !== text) throw fault(409,'turn_conflict');
      return {turn_id:existing.id};
    }
    if (current.byClient.size >= 40) throw fault(429,'turn_limit');
    const previous = current.latest;
    if (previous && ['running','generated','stopping'].includes(previous.state)) throw fault(409,'session_busy');
    if (current.closing || stopping) throw fault(409,'call_closed');
    const turn = {id:randomUUID(),callId:id,sessionId:current.sessionId,heard:text,generated:'',played:'',
      controller:new AbortController(),state:'running',events:[],clients:new Set(),
      timing:{sessionWaitMs:Math.round(performance.now()-received)}};
    turns.set(turn.id,turn);
    current.byClient.set(clientId,turn);
    current.latest = turn;
    turn.work = run(turn,current,previous);
    return {turn_id:turn.id};
  }

  async function cancel(turn,delivered) {
    if (turn.cancelTask) return turn.cancelTask;
    if (['played','interrupted'].includes(turn.state)) return;
    turn.state = 'stopping';
    turn.controller.abort();
    turn.cancelTask = (async()=>{
      try { await turn.cancelSession?.(); }
      finally { await turn.work; }
      turn.played = delivered;
      turn.state = 'interrupted';
      save(turn);
      emit(turn,'interrupted',{reason:'cancelled'});
    })();
    return turn.cancelTask;
  }

  async function closeCall(id) {
    if (closedCalls.size >= 128) closedCalls.delete(closedCalls.values().next().value);
    closedCalls.add(id);
    if (call?.id !== id) return;
    const current = call;
    current.closing ??= (async()=>{
      try {
        current.preparing.abort();
        await current.sessionPromise.catch(()=>{});
        if (current.latest) await cancel(current.latest,current.latest.played);
      } finally {
        for (const turn of current.byClient.values()) turns.delete(turn.id);
        if (call===current) call=undefined;
      }
    })();
    return current.closing;
  }

  function subscribed(req,res,turn) {
    const cursor = Number(req.headers['last-event-id'] ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > turn.events.length) throw fault(400,'invalid_cursor');
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
    res.flushHeaders();
    for (const row of turn.events.slice(cursor)) res.write(row);
    if (turn.state !== 'running') return res.end();
    turn.clients.add(res);
    const heartbeat = setInterval(()=>res.write(': heartbeat\n\n'),5000);
    res.on('close',()=>{clearInterval(heartbeat);turn.clients.delete(res);});
  }

  const server = createServer(async(req,res)=>{
    function json(status,value) {
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(value));
    }
    try {
      const supplied = Buffer.from(String(req.headers['x-voice-secret'] ?? ''));
      if (supplied.length !== secret.length || !timingSafeEqual(supplied,secret)) throw fault(403,'invalid_secret');
      const path = req.url;
      if (req.method === 'GET' && path === '/voice/v1/profile') return json(200,currentProfile());
      if (req.method === 'GET' && path === '/voice/v1/settings') {
        const voice = readState(join(options.dataDir,'aurabot/config.json'),null)?.voice?.platformVoice
          || options.speech.voice || defaultPlatformVoice;
        return json(200,{voice});
      }
      if (req.method === 'POST' && path === '/voice/v1/turns') return json(202,await submit(await readBody(req)));
      const preparing = /^\/voice\/v1\/calls\/(vs_[a-f0-9]{32})\/prepare$/.exec(path);
      if (preparing && req.method === 'POST') {
        await readBody(req);
        await prepareCall(preparing[1]);
        return json(200,{ready:true});
      }
      const closing = /^\/voice\/v1\/calls\/(vs_[a-f0-9]{32})\/close$/.exec(path);
      if (closing && req.method === 'POST') {
        await readBody(req);
        await closeCall(closing[1]);
        return json(200,{closed:true});
      }
      const match = /^\/voice\/v1\/turns\/([a-f0-9-]{36})\/(events|delivery|cancel)$/.exec(path);
      const turn = match && turns.get(match[1]);
      if (!turn) throw fault(404,'turn_not_found');
      const action = match[2];
      if (action === 'events' && req.method === 'GET') return subscribed(req,res,turn);
      if (req.method !== 'POST') throw fault(405,'method_not_allowed');
      const body = await readBody(req);
      const played = body.delivered_text;
      if (typeof played !== 'string' || played.length > 2000 || !played.startsWith(turn.played)) throw fault(400,'invalid_playback');
      if (action === 'cancel') {
        await cancel(turn,played);
      } else {
        if (!['generated','played'].includes(turn.state) && (body.final === true || turn.state !== 'running')) {
          throw fault(409,'turn_not_generated');
        }
        turn.played = played;
        if (body.final === true) turn.state = 'played';
        save(turn);
      }
      return json(200,{chat_final_sent:false});
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return json(error.status ?? (error instanceof SyntaxError ? 400 : 503),{error:{code:error.code ?? 'dsh_voice_failed'}});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {port:server.address().port,async close(){
    stopping = true;
    profileAbort.abort();
    try { if (call) await closeCall(call.id); }
    finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  }};
}
