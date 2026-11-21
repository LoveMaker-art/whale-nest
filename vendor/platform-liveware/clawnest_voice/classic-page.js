/* Webview shell. PCM and transcript stay in memory; no storage/network beyond this origin. */
'use strict';
const t = globalThis.VoiceI18n?.t || (text => text);
const $ = id => document.getElementById(id);
const BUILD_HEX = $('build-id').textContent.trim();
const BUILD_ID = parseInt(BUILD_HEX, 16) || 0, PROTOCOL_VERSION = 2;
const TRANSPORT_KEY = 'clawchat.voice.downstream.' + BUILD_HEX;
const CAPABILITIES = {sse_downstream: Number(typeof EventSource !== 'undefined'),
  stream_upload: Number(typeof Voice.UploadQueue === 'function'), recorder: 1};
let turnReceived = {bytes: 0, frames: 0}, playbackError = 0;
function failureSnapshot(closeCode = 0, socket = ws) {
  recorder.captureFailure({build_id: BUILD_ID, protocol_version: PROTOCOL_VERSION,
    transport: downstreamTransport === 'sse' ? 1 : 2, close_code: closeCode,
    ready: socket?.readyState ?? 3, bytes: turnReceived.bytes, frames: turnReceived.frames,
    playback_error: playbackError, context: VoiceRecorder.state(context?.state)});
}
function countPCM(buffer) { turnReceived.bytes += buffer.byteLength; turnReceived.frames++; }
function playbackFailure(error, fallback = 7) {
  playbackError = ({unexpected_audio: 1, invalid_pcm: 2, missing_sample_rate: 3,
    audio_order: 4, duplicate_segment: 5, invalid_receipt: 6})[error?.message] || fallback;
  clientStats.playback_error = playbackError; failureSnapshot();
}
let ws, context, mic, processor, source, mute, vad, receipt = new Voice.Receipts();
let running = false, connected = false, reconnects = 0, reconnectTimer, heartbeat;
let pendingTurn = null, activeTurn = null, busy = false, expectedAudio = null, scheduledUntil = 0, silenceUntil = 0;
let inputRate = 16000, sources = new Set(), startedSegments = new Set(), segmentTurns = new Map();
let pendingTimers = new Set(), playbackGain, ducked = false, playbackGuards = [];
const feedbackSources = new Map();
const playbackWindows = new Map();
let clientStats = {vad_started: 0, ducked: 0, confirmed: 0, cancelled: 0, underruns: 0};
let serverDebug = {}, lastDebugAt = -1;
let playbackQueue = [], queuedMs = 0, prebufferMs = 350, playbackFadeMs = 3, rebuffering = true;
let lastPlaybackEdge = null;
const sealedSegments = new Set();
let eventStream = null, streamReady = false, streamSession = '', downstreamTransport = 'sse';
let isOwner = false, diagnosticAllowed = false, diagMatrix = false, diagStop = false, diagCurrent = null;
const diagSummaries = new Map();
function basePath() { return location.pathname.replace(/[^/]*$/, ''); }
let recorderStorage;
try { recorderStorage = localStorage; } catch (_) {}
const recorder = new VoiceRecorder.Recorder({storage: recorderStorage,
  fetcher: typeof fetch === 'function' ? (...args) => fetch(...args) : undefined,
  beacon: navigator.sendBeacon ? (...args) => navigator.sendBeacon(...args) : undefined,
  url: basePath() + 'phone-events'});
// Query wins over storage, including when storage is unavailable. Changes apply next reply.
function playbackSetting(key, fallback, max) {
  const query = new URLSearchParams(location.search).get(key);
  const valid = value => value !== null && /^\d+$/.test(value) && Number(value) <= max;
  if (valid(query)) return Number(query);
  try { const saved = localStorage.getItem('clawchat.voice.' + key); if (valid(saved)) return Number(saved); } catch (_) {}
  return fallback;
}
// T-0069: owner phone checks accept 1500 ms; preserve query and saved-setting priority.
let replyPrebufferMs = playbackSetting('prebuffer_ms', 1500, 10000);
let firstMaxWaitMs = playbackSetting('prebuffer_max_wait_ms', 2500, 10000);
let replyRebufferMs = playbackSetting('rebuffer_ms', 600, 5000);
let rebufferMaxWaitMs = playbackSetting('rebuffer_max_wait_ms', 300, 10000);
let bufferPolicy = null, bufferStats = null, bufferSequence = 0;
$('prebuffer').value = String(replyPrebufferMs);
if (![0, 1000, 1500, 2500].includes(replyPrebufferMs)) {
  const option = document.createElement('option'); option.value = String(replyPrebufferMs);
  option.textContent = replyPrebufferMs + ' ms'; $('prebuffer').appendChild(option); $('prebuffer').value = option.value;
}
$('prebuffer').onchange = () => {
  replyPrebufferMs = Number($('prebuffer').value);
  try { localStorage.setItem('clawchat.voice.prebuffer_ms', String(replyPrebufferMs)); } catch (_) {}
};
function initBufferPolicy() {
  if (bufferStats) return;
  bufferStats = {sequence: ++bufferSequence, firstPCM: performance.now(), hold: 0,
    gaps100: 0, gaps500: 0, maxGap: 0, underruns: clientStats.underruns, ms: replyPrebufferMs};
  if (replyPrebufferMs) bufferPolicy = new Voice.Prebuffer({ms: replyPrebufferMs,
    maxWait: firstMaxWaitMs, rebuffer: replyRebufferMs, rebufferMaxWait: rebufferMaxWaitMs,
    now: () => performance.now(), later: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id),
    flush: () => flushPlayback()});
}
function bufferMetrics(clean = false) {
  if (!bufferStats) return;
  bufferStats.clean = bufferStats.clean || clean;
  const values = {code: 57, type: bufferStats.sequence, state: Number(bufferStats.ms > 0),
    channels: bufferStats.ms, duration: bufferStats.hold, reason: bufferPolicy?.reason || 0,
    count: bufferStats.gaps100, buffered: bufferStats.gaps500, rtt: bufferStats.maxGap,
    samples: bufferPolicy?.rebuffers || 0, save: (bufferPolicy?.rebufferTime || 0) + (bufferPolicy && !bufferPolicy.first && bufferPolicy.rebuffer && bufferPolicy.waitAt !== null ? performance.now() - bufferPolicy.waitAt : 0),
    rate: clientStats.underruns - bufferStats.underruns, clean: Number(!!bufferStats.clean)};
  const key = JSON.stringify(values);
  if (key !== bufferStats.lastMetrics) {bufferStats.lastMetrics = key; recorder.add('timing', values);}
}
let textSyncEnabled = true, textSync = null, textSyncTurn = null, textSyncSequence = 0;
try {
  const query = new URLSearchParams(location.search).get('text_sync');
  const saved = ['on', 'off'].includes(query) ? query : localStorage.getItem('clawchat.voice.text_sync');
  textSyncEnabled = saved !== 'off';
} catch (_) {}
$('text-sync').value = textSyncEnabled ? 'on' : 'off';
$('text-sync').onchange = () => {
  textSyncEnabled = $('text-sync').value !== 'off';
  try { localStorage.setItem('clawchat.voice.text_sync', textSyncEnabled ? 'on' : 'off'); } catch (_) {}
  textSync?.setEnabled(textSyncEnabled);
};
function syncReply() {
  if (!textSync || textSyncTurn !== activeTurn) {
    textSync?.dispose(); textSyncTurn = activeTurn;
    const sequence = ++textSyncSequence;
    textSync = new Voice.TextSync({enabled: textSyncEnabled, now: () => performance.now(),
      later: (fn, ms) => setTimeout(fn, ms), cancel: timer => clearTimeout(timer),
      audio: () => ({time: context?.currentTime || 0, running: context?.state === 'running', pending: sources.size > 0 || (!!bufferPolicy && playbackQueue.length > 0)}),
      render: text => { $('reply').textContent = text; $('reply').scrollIntoView({block: 'nearest'}); },
      // Existing numeric timing schema: code=56, count=sentence units,
      // duration=p50 ms, rtt=max ms, reason=fallback units; no protocol change.
      metrics: values => recorder.add('timing', {code: 56, type: sequence, state: Number(textSyncEnabled), ...values})});
  }
  return textSync;
}
let transportPreference = null;
try { const value = localStorage.getItem(TRANSPORT_KEY); if (['ws', 'sse'].includes(value)) transportPreference = value; } catch (_) {}
let streamLastId = 0, streamRetries = 0, streamReconnectTimer;
let paused = false, pausedAt = 0, pauseSeconds = 120, pauseTimer, healthTimer, recoveringMic = false, mediaEpoch = 0;
// Same-origin page/classic coordination. No persistent key; the service remains
// authoritative for session_busy across devices, contexts and older clients.
let micLease = null;
async function acquireMicLease() {
  if (!navigator.locks?.request) {
    if (location.pathname.endsWith('/classic') || location.pathname.endsWith('/classic.html')) throw Error('classic_unsupported');
    return null;
  }
  return new Promise((resolve, reject) => {
    navigator.locks.request('clawchat.voice.microphone', {ifAvailable:true}, lock => {
      if (!lock) { reject(Error('session_busy')); return; }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

const MIC_PREPARE_MS = 8000, MIC_CANCELLED = Symbol('mic_cancelled');
let micPrepare = null, micPrepareSequence = 0, micRecovery = null;
// code=59: state is the preparation stage; reason 0=progress, 1=ready,
// 2=timeout, 3=cancelled, 4=failed. All values are numeric, never exception text.
function micProgress(stage, reason = 0) {
  const attempt = micPrepare;
  if (!attempt) return;
  attempt.stage = stage;
  recorder.add('timing', {code: 59, type: attempt.sequence, state: stage, reason,
    duration: Math.max(0, performance.now() - attempt.started),
    rate: VoiceRecorder.state(context?.state), count: vad?.calibratedMs || 0,
    ready: ws?.readyState ?? 3});
}
function stopMicPrepare(reason) {
  const attempt = micPrepare;
  if (!attempt) return;
  micProgress(attempt.stage, reason);
  micPrepare = null; clearTimeout(attempt.timer); attempt.cancel();
}
function micTimeout(attempt) {
  if (micPrepare !== attempt) return;
  stopMicPrepare(2); pageFailure(9); finish(false);
  $('error').textContent = t('麦克风准备超时，已停止本次连接。请保持页面在前台，确认麦克风权限后点“重试开启麦克风”。');
  $('start').textContent = t('重试开启麦克风');
  state('error', t('点“重试开启麦克风”重新连接'));
}
async function prepareResult(attempt, promise, release) {
  const guarded = Promise.resolve(promise).then(value => {
    if (micPrepare !== attempt) { release?.(value); return MIC_CANCELLED; }
    return value;
  }, error => { if (micPrepare !== attempt) return MIC_CANCELLED; throw error; });
  return Promise.race([guarded, attempt.cancelled]);
}
function releaseMedia(action) { try { action(); } catch (_) {} }
function stopTracks(stream) { for (const track of stream?.getTracks() || []) releaseMedia(() => track.stop()); }
function socketSend(socket, data) {
  recorder.add('send', {buffered: socket.bufferedAmount || 0, ready: socket.readyState});
  socket.send(data);
}
function pageFailure(type = 0) { recorder.failure('error', {type}); }
$('copy-events').onclick = async () => {
  const text = JSON.stringify({build_id: BUILD_ID, protocol_version: PROTOCOL_VERSION, transport: downstreamTransport === 'sse' ? 1 : 2}) + '\n' + recorder.text(); $('event-records').textContent = text;
  try { await navigator.clipboard?.writeText(text); } catch (_) {}
};
$('downstream-setting').onchange = () => {
  if (!isOwner) return;
  transportPreference = $('downstream-setting').value === 'sse' ? 'sse' : 'ws';
  try { localStorage.setItem(TRANSPORT_KEY, transportPreference); } catch (_) {}
  abortUpload(); vad?.reset(); send({type: 'cancel'}); clearAudio(); busy = false; activeTurn = pendingTurn = null;
  send({type: 'downstream_transport', transport: transportPreference, diagnostic: 1});
};
function decode64(value) {
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}
function closeStream(reset = true) {
  clearTimeout(streamReconnectTimer);
  if (reset) { streamLastId = 0; streamRetries = 0; }
  if (eventStream) { eventStream.close(); eventStream = null; }
  streamReady = false; streamSession = '';
}
function openStream(sessionId, resume = false) {
  if (!resume && eventStream && streamSession === sessionId) return;
  closeStream(!resume); streamSession = sessionId;
  if (typeof EventSource === 'undefined') return;
  const stream = eventStream = new EventSource(basePath() + 'downstream?session_id=' + encodeURIComponent(sessionId) + '&after=' + streamLastId);
  stream.onmessage = event => {
    if (eventStream !== stream) return;
    try {
      const id = Number(event.lastEventId || 0);
      if (id && id <= streamLastId) return;
      if (id && id !== streamLastId + 1) throw Error('sse_gap');
      const f = JSON.parse(event.data);
      if (id) streamLastId = id;
      streamRetries = 0;
      if (f.type === 'sse_ready') { recorder.message(f.type); streamReady = true; micProgress(6); return; }
      if (f.type === 'sse_heartbeat') return;
      if (f.type === 'diagnostic_binary') { recorder.message(f.type); diagnosticBinary(decode64(f.data)); return; }
      if (f.type === 'audio') { recorder.message(f.type); const pcm = decode64(f.pcm); countPCM(pcm); playPCM(pcm, f); return; }
      message({data: JSON.stringify(f)});
    } catch (error) {
      playbackFailure(error, 8); pageFailure(4);
      $('error').textContent = t('下行数据中断，请重试。');
      if (downstreamTransport === 'sse') send({type: 'cancel'});
      clearAudio();
    }
  };
  const reconnect = (clean = false) => {
    if (eventStream !== stream || !running) return;
    streamReady = false; stream.close();
    if (!clean && ++streamRetries > 10) {
      pageFailure(5); clearAudio(); send({type: 'cancel'});
      $('error').textContent = t('SSE 下行无法恢复，请重新开始对话。'); return;
    }
    // Keep playback/receipts intact; replay IDs discard ambiguous duplicate writes.
    streamReconnectTimer = setTimeout(() => openStream(sessionId, true), clean ? 0 : Math.min(1000, streamRetries * 100));
  };
  stream.addEventListener?.('reconnect', () => reconnect(true));
  stream.onerror = () => reconnect(false);

}
function diagnosticButtons() {
  for (const mode of ['down', 'up', 'combined']) $('diag-' + mode).disabled = !diagnosticAllowed || !connected || diagMatrix;
  $('diag-stop').disabled = !diagMatrix;
}
function uploadDiagnosticSummaries() {
  for (const summary of diagSummaries.values()) send({type: 'diagnostic_summary', summary});
}
function diagnosticBinary(buffer) {
  if (!diagCurrent) return;
  const v = new DataView(buffer);
  if (v.getUint32(4) !== diagCurrent.options.run) return; // Drain late retired run packets.
  diagCurrent.stats.receive(buffer, performance.now());
  if (diagCurrent.done && diagCurrent.stats.count >= diagCurrent.done.sent_count) finishDiagnostic(diagCurrent.done);
}
function finishDiagnostic(done, closeCode = 0, closeReason = '') {
  const current = diagCurrent;
  if (!current) return;
  if (done && done.run !== current.options.run) return;
  diagCurrent = null; clearTimeout(current.timer); clearTimeout(current.tailTimer); clearInterval(current.upTimer);
  const summary = {...current.stats.summary(done?.sent_count), close_code: closeCode,
    close_reason_length: closeReason.length, transport_sse: Number(current.options.transport === 'sse'), interrupted: Number(!done || done.outcome !== 'complete')};
  diagSummaries.set(summary.run, summary);
  while (diagSummaries.size > 128) diagSummaries.delete(diagSummaries.keys().next().value);
  if (connected) uploadDiagnosticSummaries();
  else if (typeof fetch !== 'undefined') {
    fetch(basePath() + 'diagnostic-summary', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(summary)})
      .then(r => { if (r.ok) diagSummaries.delete(summary.run); }).catch(() => {});
  }
  const opt = current.options, up = done?.upstream;
  const values = [current.utc.slice(11, 19) + '\n' + {down: t('下行'), up: t('上行'), combined: t('双向')}[opt.mode],
    opt.transport.toUpperCase() + ' / ' + opt.frame_bytes / 1024 + ' / ' + (opt.profile === 'burst' ? t('突发') : t('稳态')),
    summary.count + ' / ' + (summary.bytes / 1024).toFixed(1),
    summary.missing + ' / ' + summary.out_of_order + ' / ' + summary.duplicates,
    summary.max_gap_ms + ' / ' + summary.jitter_ms,
    up ? up.count + ' / ' + (up.bytes / 1024).toFixed(1) + t(' / 缺 ') + (up.missing || 0) : t('未知'),
    (done?.outcome || t('中断')) + (closeCode || closeReason ? ' / ' + closeCode + ' ' + closeReason : '')];
  const row = document.createElement('tr');
  for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); }
  $('diag-results').appendChild(row);
  while ($('diag-results').children.length > 128) $('diag-results').firstChild.remove();
  if (!done || done.outcome !== 'complete') diagStop = true;
  current.resolve();
}
async function diagnosticMatrix(mode) {
  if (!connected || !diagnosticAllowed || diagMatrix) return;
  diagMatrix = true; diagStop = false; diagnosticButtons();
  abortUpload(); vad?.reset(); send({type: 'cancel'}); clearAudio(); busy = false; activeTurn = pendingTurn = null; if (vad) vad.reset();
  const selectedSize = $('diag-size').value || 'all', selectedProfile = $('diag-profile').value || 'both', selectedTransport = $('diag-transport').value || 'both';
  const sizes = mode === 'up' ? [16384] : selectedSize === 'all' ? [1024, 4096, 16384, 65536] : [Number(selectedSize)];
  const profiles = mode === 'up' ? ['steady'] : selectedProfile === 'both' ? ['steady', 'burst'] : [selectedProfile];
  const transports = mode === 'up' ? ['ws'] : selectedTransport === 'both' ? ['ws', 'sse'] : [selectedTransport];
  try {
    for (const transport of transports) for (const size of sizes) for (const profile of profiles) {
      if (diagStop || !connected) return;
      if (transport === 'sse' && !streamReady) { $('diag-status').textContent = t('SSE 尚未连接，请稍后重试。'); return; }
      const options = {type: 'diagnostic_start', run: crypto.getRandomValues(new Uint32Array(1))[0] || 1, mode,
        frame_bytes: size, profile, transport, seconds: 10, rate: 44100};
      $('diag-status').textContent = transport.toUpperCase() + ' / ' + size / 1024 + ' KB / ' + profile + t('：测试中（10 秒）');
      await new Promise(resolve => {
        diagCurrent = {options, resolve, stats: new VoiceDiagnostic.Stats(options.run), utc: new Date().toISOString(), upSeq: 0};
        diagCurrent.timer = setTimeout(() => finishDiagnostic(null, 0, t('等待测试结果超时')), 14000);
        send(options);
      });
      if (!diagStop) await new Promise(resolve => setTimeout(resolve, 1100));
    }
  } finally {
    diagMatrix = false; diagnosticButtons(); if (vad) vad.reset();
    if (!diagStop) $('diag-status').textContent = t('测试完成。结果已上传；可截图对照。');
    else $('diag-status').textContent = t('测试已停止。已保留结果；连接恢复后会补传摘要。');
  }
}
function diagnosticControl(f) {
  if (f.type === 'diagnostic_summary_ack') { diagSummaries.delete(f.run); return true; }
  if (f.type === 'diagnostic_started') {
    const current = diagCurrent;
    if (!current || f.run !== current.options.run || f.mode === 'down') return true;
    const started = performance.now();
    const tick = () => {
      if (diagCurrent !== current || !connected) return;
      const elapsed = performance.now() - started;
      if (elapsed >= 10000 || current.upSeq >= 20) {
        clearInterval(current.upTimer);
        if (!current.upEnded) { current.upEnded = true; send({type: 'diagnostic_end', run: f.run, sent_count: current.upSeq}); }
        return;
      }
      // One 16 KiB message every 500 ms, never catch up in a background burst.
      if (elapsed + 1 < current.upSeq * 500 || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 32768) return;
      socketSend(ws, VoiceDiagnostic.packet(f.run, current.upSeq, 16384));
      current.upSeq++;
    };
    current.upTimer = setInterval(tick, 50); tick(); return true;
  }
  if (f.type === 'diagnostic_done') {
    const current = diagCurrent;
    if (current && f.run === current.options.run) {
      current.done = f; clearInterval(current.upTimer);
      if (current.stats.count >= f.sent_count || f.transport === 'ws') finishDiagnostic(f);
      else current.tailTimer = setTimeout(() => finishDiagnostic(f), 3000);
    }
    return true;
  }
  return false;
}
for (const mode of ['down', 'up', 'combined']) $('diag-' + mode).onclick = () => diagnosticMatrix(mode);
$('diag-stop').onclick = () => { diagStop = true; send({type: 'diagnostic_stop'}); finishDiagnostic(null, 0, t('手动停止')); };
function debugStats(force = false) {
  $('debug').textContent = Object.entries({...serverDebug, ...clientStats}).map(([k, v]) => k + ': ' + v).join('\n');
  if (connected && context && (force || context.currentTime - lastDebugAt >= 1)) {
    lastDebugAt = context.currentTime;
    send({type: 'client_debug', metrics: clientStats});
    console.info('voice_debug', {...clientStats});
  }
}
function replyGain(value) {
  if (!playbackGain || !context) return;
  const gain = playbackGain.gain, now = context.currentTime;
  if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
  else { gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); }
  gain.linearRampToValueAtTime(value, now + (vad?.config.duck_ramp_ms || 150) / 1000);
}
function restoreReply() {
  if (ducked) { ducked = false; replyGain(1); clientStats.cancelled++; debugStats(true); }
  state(sources.size ? 'speaking' : busy ? 'thinking' : 'listening', t('继续说，或点结束对话'));
}
let baseVadConfig = {};
let sensitivity = 'medium';
try { const saved = localStorage.getItem('clawchat.voice.sensitivity'); if (['low', 'medium', 'high'].includes(saved)) sensitivity = saved; } catch (_) {}
$('sensitivity').value = sensitivity;
function configureVAD(preserveFloor = false) {
  const previous = vad;
  const factor = baseVadConfig['sensitivity_' + sensitivity] ?? ({low: 1.3, medium: 1, high: .8}[sensitivity]);
  const config = {...baseVadConfig};
  for (const key of ['threshold', 'playback_threshold', 'noise_multiplier', 'playback_noise_multiplier']) if (config[key] !== undefined) config[key] *= factor;
  vad = new Voice.VAD(config);
  if (preserveFloor && previous) {
    vad.noiseFloor = Math.max(vad.config.noise_floor_min, Math.min(vad.config.noise_floor_max, previous.noiseFloor));
    vad.calibratedMs = Math.min(vad.config.calibration_ms, previous.calibratedMs);
  }
  clientStats.sensitivity = {low: 0, medium: 1, high: 2}[sensitivity];
}
$('sensitivity').onchange = () => {
  sensitivity = ['low', 'medium', 'high'].includes($('sensitivity').value) ? $('sensitivity').value : 'medium';
  try { localStorage.setItem('clawchat.voice.sensitivity', sensitivity); } catch (_) {}
  abortUpload(); restoreReply(); configureVAD(true); debugStats(true);
};
const labels = {paused: t('对话已暂停'), ready: t('准备好就开始'), connecting: t('正在连接'), calibrating: t('正在准备麦克风'), listening: t('正在听你说'),
  recording: t('听到了，继续说'), thinking: t('正在想'), speaking: t('正在说'), ended: t('对话已结束'), error: t('连接已暂停')};
function state(name, hint = '') { document.body.dataset.state = name; $('status').textContent = labels[name] || name; $('hint').textContent = hint; }
function send(data) { if (connected && ws && ws.readyState === WebSocket.OPEN) socketSend(ws, JSON.stringify(data)); }
function formatTime(n) { n = Math.max(0, Math.floor(n)); return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }
function report(list) {
  for (const item of list) send({type: 'played', source: 'audio_ended', client_turn_id: segmentTurns.get(item.segment_id), segment_id: item.segment_id, samples: item.samples});
}
function clearAudio() {
  textSync?.interrupt();
  bufferMetrics(true); bufferPolicy?.dispose(); bufferPolicy = null; bufferStats = null;
  playbackQueue = []; queuedMs = 0; rebuffering = true; lastPlaybackEdge = null; sealedSegments.clear();
  receipt.cancel(); // Invalidate callbacks before calling stop (which fires onended).
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  for (const node of sources) { try { node.stop(); node.disconnect(); } catch (_) {} }
  sources.clear(); playbackWindows.clear(); playbackGuards = []; ducked = false; replyGain(1); startedSegments.clear(); segmentTurns.clear(); segmentRates.clear(); scheduledUntil = 0;
}
let uploadMode = 'batch', liveUpload = null, uploadTimer = null;
const phoneTurns = new Map();
let captureStamps = {};
function phoneMark(stamps, key) {
  stamps[key] = performance.now(); recorder.add('timing', stamps);
}
function abortUpload(notify = true) {
  if (!liveUpload) return;
  const u = liveUpload; liveUpload = null; u.queue.abort(); phoneTurns.delete(u.id);
  if (notify) send({type: 'utterance_abort', client_turn_id: u.id});
}
function stopReply() {
  if (busy || sources.size || playbackQueue.length) {
    clearAudio(); send({type: 'barge_in', source: 'vad_confirmed', preserve_upload: liveUpload?.id}); busy = false; activeTurn = null;
    if (!textSyncEnabled) { $('reply').textContent = t('（已打断）'); $('reply').classList.add('empty'); }
  }
}
function feedback() {
  // Called in the same microphone callback as utterance end: no server dependency.
  if (!context || context.state !== 'running') return;
  silenceUntil = context.currentTime + .14;
  const osc = context.createOscillator(), gain = context.createGain();
  osc.frequency.value = 660; gain.gain.setValueAtTime(.035, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .075);
  osc.connect(gain).connect(context.destination); osc.start(); osc.stop(context.currentTime + .08);
  feedbackSources.set(osc, gain);
  osc.onended = () => { feedbackSources.delete(osc); osc.disconnect(); gain.disconnect(); };
}
function openUpload(rate, mode, stamps) {
  if (!connected || pendingTurn || liveUpload) return null;
  turnReceived = {bytes: 0, frames: 0}; playbackError = 0;
  const socket = ws, id = crypto.randomUUID().replace(/-/g, '');
  const candidate = busy || sources.size > 0;
  const u = {id, candidate, stamps, converter: new Voice.PCMStream(rate, inputRate)};
  u.queue = new Voice.UploadQueue(socket, {
    limit: mode === 'batch' ? 1048576 : 131072, now: () => performance.now(),
    send: data => socketSend(socket, data),
    end: at => {
      stamps.t_last_frame_sent = at; recorder.add('timing', stamps);
      if (liveUpload !== u || ws !== socket || !connected) return;
      send({type: 'utterance_end', client_turn_id: id, voiced_ms: u.voicedMs,
        accepted: true, phone_timestamps_ms: stamps});
      liveUpload = null;
    },
    fail: () => { if (liveUpload === u) { abortUpload(); pendingTurn = null;
      $('error').textContent = t('上传较慢，这段录音已丢弃，请稍后再说。'); if (vad) vad.reset(); } }
  });
  liveUpload = u; phoneTurns.set(id, stamps);
  send({type: 'utterance_start', client_turn_id: id, candidate, encoding: 'pcm_s16le',
    sample_rate: inputRate, upload_mode: mode});
  return u;
}
function completeUpload(u, voicedMs) {
  if (!u || liveUpload !== u) return;
  u.voicedMs = voicedMs;
  if (busy) pendingTurn = u.id;
  else { clearAudio(); serverDebug = {}; activeTurn = u.id; busy = true;
    $('reply').textContent = ''; $('reply').classList.remove('empty'); }
  $('error').textContent = ''; state('thinking', t('听到提示音了，稍等一下')); feedback();
  u.queue.push(u.converter.push(new Float32Array(), true)); u.queue.finish();
}
function upload(samples, rate, voicedMs, stamps) {
  if (!connected || diagMatrix || (downstreamTransport === 'sse' && !streamReady)) return;
  const u = openUpload(rate, 'batch', stamps);
  if (!u) return;
  u.queue.push(u.converter.push(samples)); completeUpload(u, voicedMs);
}
function playPCM(buffer, meta) {
  if (!context || meta.client_turn_id !== activeTurn) return;
  if (buffer.byteLength !== meta.samples * 2) throw Error('invalid_pcm');
  const epoch = receipt.received(meta.segment_id, meta.samples, meta.seq);
  const pcm = new DataView(buffer);
  // Rate comes from the matching segment_start; no codec/Hub access in the page.
  const rate = segmentRates.get(meta.segment_id);
  if (!rate) throw Error('missing_sample_rate');
  const output = context.createBuffer(1, meta.samples, rate);
  const channel = output.getChannelData(0);
  for (let i = 0; i < meta.samples; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
  initBufferPolicy();
  // Remaining audio, however short, is continuous. Rebuffer only after dry;
  // a 5 ms look-ahead here turned on-time frames into a 600 ms buffer wait.
  if (!rebuffering && scheduledUntil < context.currentTime) {
    rebuffering = true; clientStats.underruns++; recorder.add('underrun', {count: clientStats.underruns}); debugStats(true);
  }
  bufferPolicy?.receive(meta.segment_id, rebuffering);
  playbackQueue.push({output, meta, epoch}); queuedMs += output.duration * 1000;
  flushPlayback();
}
function flushPlayback(force = false) {
  if (!playbackQueue.length || !context) return;
  // Legacy EOF release is retained only when the new prebuffer policy is off.
  // The new policy always has a wall timeout, including with one server playback credit.
  const eof = playbackQueue.some(item => sealedSegments.has(item.meta.segment_id));
  if (bufferPolicy) {
    if (!bufferPolicy.release(queuedMs)) return;
  } else if (rebuffering && queuedMs + .001 < prebufferMs && !force && !eof) return;
  let at = rebuffering ? context.currentTime + .035 : scheduledUntil;
  if (bufferStats && scheduledUntil > 0) {
    const gap = Math.max(0, Math.round((at - scheduledUntil) * 1e6) / 1000);
    if (gap > 100) bufferStats.gaps100++;
    if (gap > 500) bufferStats.gaps500++;
    bufferStats.maxGap = Math.max(bufferStats.maxGap, gap);
  }
  rebuffering = false;
  for (const item of playbackQueue) {
    schedulePCM(item, at); at += item.output.duration;
  }
  playbackQueue = []; queuedMs = 0; scheduledUntil = at;
}
function schedulePCM({output, meta, epoch}, at) {
  const node = context.createBufferSource(); node.buffer = output;
  const edge = context.createGain(); node.connect(edge).connect(playbackGain);
  const endAt = at + output.duration;
  const fade = Math.min(playbackFadeMs / 1000, output.duration / 2);
  const previous = lastPlaybackEdge;
  const contiguous = previous && Math.abs(previous.endAt - at) < .000001 &&
    context.currentTime < previous.endAt - previous.fade;
  if (contiguous) {
    // Remove the tentative tail fade before it starts: adjacent PCM remains continuous.
    previous.edge.gain.cancelScheduledValues(previous.endAt - previous.fade);
    previous.edge.gain.setValueAtTime(1, previous.endAt - previous.fade);
    edge.gain.setValueAtTime(1, at);
  } else {
    edge.gain.setValueAtTime(0, at); edge.gain.linearRampToValueAtTime(1, at + fade);
  }
  edge.gain.setValueAtTime(1, endAt - fade); edge.gain.linearRampToValueAtTime(0, endAt);
  lastPlaybackEdge = {edge, endAt, fade};
  sources.add(node); playbackWindows.set(node, {at, endAt}); node.start(at);
  if (bufferStats && !bufferStats.scheduled) {
    const stats = bufferStats; stats.scheduled = true;
    // Poll the AudioContext clock so a suspended context cannot report an early start.
    const mark = () => {
      if (epoch !== receipt.epoch || stats !== bufferStats) return;
      if (context.state === 'running' && context.currentTime >= at) {
        stats.hold = performance.now() - stats.firstPCM; bufferMetrics();
      } else {
        const timer = setTimeout(() => { pendingTimers.delete(timer); mark(); }, 10);
        pendingTimers.add(timer);
      }
    };
    const timer = setTimeout(() => { pendingTimers.delete(timer); mark(); }, Math.max(0, (at - context.currentTime) * 1000));
    pendingTimers.add(timer);
  }
  if (!startedSegments.has(meta.segment_id)) {
    syncReply().schedule(meta.segment_id, at);
    startedSegments.add(meta.segment_id);
    playbackGuards.push({at, until: at + (vad?.config.playback_guard_ms || 400) / 1000});
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (epoch === receipt.epoch && context.state === 'running' && sources.has(node)) {
        const stamps = phoneTurns.get(meta.client_turn_id) || {};
        if (stamps.t_first_audio_played === undefined) phoneMark(stamps, 't_first_audio_played');
        recorder.add('play_start', {samples: meta.samples, ...stamps});
        send({type: 'audio_started', client_turn_id: meta.client_turn_id, segment_id: meta.segment_id, phone_timestamps_ms: stamps});
        state('speaking', t('随时开口打断'));
      }
    }, Math.max(0, (at - context.currentTime) * 1000));
    pendingTimers.add(timer);
  }
  node.onended = () => {
    recorder.add('play_end', {samples: meta.samples});
    sources.delete(node); playbackWindows.delete(node); node.disconnect(); edge.disconnect();
    if (epoch !== receipt.epoch) return;
    textSync?.tick(); bufferMetrics(!sources.size && !playbackQueue.length && !!bufferPolicy?.done);
    // A suspended context or interrupted source never earns unplayed samples.
    try {
      if (context.currentTime + .005 >= endAt) report(receipt.ended(meta.segment_id, meta.samples, epoch));
    } catch (error) {
      playbackFailure(error); pageFailure(3);
      $('error').textContent = t('语音播放中断，请重新开始对话。');
      if (ws) ws.close();
    }
    if (!sources.size && !busy) state('listening', t('继续说，或点结束对话'));
  };
}
const segmentRates = new Map();
function showError(frame) {
  if (frame.hint_code === 'client_outdated') { $('error').textContent = t(frame.message); finish(false); return; }
  const common = {preempted: t('主人开始了语音，本次对话已结束。'), quota_exceeded: t('今天的语音时长已用完，明天再聊。'),
    capacity: t('当前语音会话已满，请稍后重试。'), session_busy: t('你已有一段语音对话，请先结束另一页。'),
      previous_turn_busy_timeout: t('上一条回复仍在停止，本次语音未能提交。请稍后重新说一遍。'),
    tts_rate_limited: t('语音服务现在比较忙，请稍等几秒再说一次。'), stt_rate_limited: t('语音识别现在比较忙，请稍等几秒再说一次。'),
    stt_failed: t('这句话没听清，请再说一次。'), stt_empty_or_too_long: t('没有听清有效语音，请再说一次。'),
    plugin_first_delta_timeout: t('回复等待超时，请重新说一次。'), plugin_error: t('回复生成失败，请重新说一次。'),
    events_disconnected: t('回复连接中断，请重新说一次。'),
    tts_failed: t('语音播放生成失败，请再试一次。'), session_limit: t('本次语音已达到时长上限。'),
    cancel_unconfirmed: t('播放已停止，服务暂未确认取消；请稍等再说。')};
  $('error').textContent = frame.status === 403 && frame.code === 'forbidden' ? t('好友暂不可用：') + t('请确认已添加好友，且主人已开启好友语音。') : (common[frame.code] || t('语音服务暂不可用（') + frame.code + t('），请重试。'));
  if (['capacity', 'quota_exceeded', 'preempted', 'session_busy'].includes(frame.code) || (frame.status === 403 && frame.code === 'forbidden')) finish(false);
  else { busy = false; activeTurn = null; clearAudio(); state('listening', t('请再说一次')); }
}
function message(event) {
  try {
    if (event.data instanceof ArrayBuffer) {
      recorder.message('binary');
      if (VoiceDiagnostic.isPacket(event.data)) { diagnosticBinary(event.data); return; }
      countPCM(event.data);
      const meta = expectedAudio; expectedAudio = null;
      if (!meta) throw Error('unexpected_audio');
      playPCM(event.data, meta); return;
    }
    const f = JSON.parse(event.data);
    recorder.message(f.type);
    if (diagnosticControl(f)) return;
    if (f.type === 'session') {
      connected = true; reconnects = 0; $('connection').textContent = t('已连接');
      $('time').textContent = t('本次 ') + formatTime(f.elapsed_seconds) + ' / ' + formatTime(f.session_limit_seconds);
      $('quota').textContent = f.daily_remaining_seconds === null ? t('主人会话') : t('今日剩余 ') + formatTime(f.daily_remaining_seconds);
      inputRate = f.input_sample_rate;
      isOwner = f.role === 'owner'; diagnosticAllowed = isOwner && f.diagnostic_enabled === true;
      $('diagnostic').hidden = !isOwner; diagnosticButtons();
      if (f.state === 'started') {
        recorder.start(f.role === 'owner'); $('event-panel').hidden = f.role !== 'owner';
        downstreamTransport = f.downstream_transport || 'sse';
        uploadMode = f.upload_mode || 'batch';
        if (isOwner && transportPreference && transportPreference !== downstreamTransport) {
          send({type: 'downstream_transport', transport: transportPreference, diagnostic: 1});
          downstreamTransport = transportPreference;
        }
        $('downstream-setting').value = downstreamTransport;
        $('transport-status').textContent = downstreamTransport.toUpperCase();
        pauseSeconds = f.background_pause_seconds || 120;
      }
      prebufferMs = f.playback_prebuffer_ms ?? 350; playbackFadeMs = f.playback_fade_ms ?? 3;
      if (f.state === 'started') {
        if (isOwner || downstreamTransport === 'sse') openStream(f.session_id);
        uploadDiagnosticSummaries();
        baseVadConfig = {...f.vad, max_utterance_seconds: f.max_utterance_seconds}; configureVAD();
        micProgress(downstreamTransport === 'sse' && !streamReady ? 5 : 6);
        state('calibrating', t('先安静片刻，准备好后就可以说话'));
      }
    } else if (f.type === 'downstream_transport') {
      downstreamTransport = f.transport;
      $('transport-status').textContent = downstreamTransport.toUpperCase();
      if (f.transport === 'sse') openStream(streamSession);
    } else if (f.type === 'error') {
      if (diagCurrent && (f.code.startsWith('diagnostic_') || f.code === 'forbidden')) { finishDiagnostic(null, 0, f.code); return; }
      if (f.client_turn_id && f.client_turn_id === pendingTurn) { pendingTurn = null; restoreReply(); $('error').textContent = t('这句话没听清，请再说一次。'); }
      else if (!f.client_turn_id || f.client_turn_id === activeTurn) showError(f);
    } else if (f.type === 'info' && f.code === 'speech_ignored') {
      if (f.client_turn_id === pendingTurn) { pendingTurn = null; restoreReply(); }
      else if (f.client_turn_id === activeTurn) { activeTurn = null; busy = false; state('listening', t('没有听清有效语音，请再说一次')); }
    }
    else if (f.type === 'session_end') {
      const hints = {idle: t('一段时间没有说话，已自动结束。'), ended: t('想聊时，再次开启麦克风。'), preempted: t('主人开始了语音，本次对话已结束。'), quota_exceeded: t('今日语音时长已用完。'), session_limit: t('本次语音已到时长上限。')};
      recordClose(1000, f.reason); finish(false); state('ended', hints[f.reason] || t('请重新开启麦克风'));
    } else if (f.type === 'clear') {
      if (f.client_turn_id === pendingTurn) { pendingTurn = null; restoreReply(); }
      else if (f.client_turn_id === activeTurn) { clearAudio(); busy = false; activeTurn = null; if (!textSyncEnabled) $('reply').textContent = t('（回复已停止）'); state('listening', t('可以继续说话')); }
    } else if (f.type === 'transcript_partial' && f.client_turn_id &&
        (f.client_turn_id === liveUpload?.id || f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      // Captions never confirm a candidate, cancel playback or submit an agent turn.
      $('said').textContent = f.text;
    } else if (f.type === 'transcript' && (f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      if (f.client_turn_id === pendingTurn) {
        clientStats.confirmed++; clearAudio(); serverDebug = {}; activeTurn = pendingTurn; pendingTurn = null; busy = true;
        $('reply').textContent = ''; $('reply').classList.remove('empty'); debugStats(true);
      }
      $('said').textContent = f.text;
    }
      else if (f.type === 'submit_wait' && f.client_turn_id === activeTurn) state('thinking', t('仍在停止上一条回复，请稍候。'));
      else if (f.type === 'turn' && f.client_turn_id === activeTurn) state('thinking', t('正在准备回复'));
    else if (f.type === 'subtitle' && f.client_turn_id === activeTurn) {
      syncReply().subtitle(f.text);
    }
    else if (f.type === 'segment_start' && f.client_turn_id === activeTurn) {
      receipt.start(f.segment_id, f.text); segmentTurns.set(f.segment_id, f.client_turn_id); segmentRates.set(f.segment_id, f.sample_rate);
      syncReply().segment(f.segment_id, f.text);
    } else if (f.type === 'audio') expectedAudio = f; // Always consume its following binary, even after local cancellation.
    else if (f.type === 'segment_end' && f.client_turn_id === activeTurn) { sealedSegments.add(f.segment_id); report(receipt.seal(f.segment_id, f.samples)); flushPlayback(); }
    else if (f.type === 'tts_done' && f.client_turn_id === activeTurn) { if (bufferPolicy) bufferPolicy.finish(); else flushPlayback(true); textSync?.finish(); bufferMetrics(); }
    else if (f.type === 'turn_complete' && f.client_turn_id === activeTurn) { if (bufferPolicy) bufferPolicy.finish(); else flushPlayback(true); textSync?.finish(); bufferMetrics(true); phoneTurns.delete(f.client_turn_id); busy = false; state('listening', t('继续说，或点结束对话')); }
    else if (f.type === 'delivery_status' && f.chat_final_error) $('error').textContent = t('声音已播放，但聊天记录写入未确认。');
    else if (f.type === 'debug' && (!f.client_turn_id || f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      serverDebug = {...serverDebug, ...(f.elapsed_ms || {}), ...(f.phone_timestamps_ms || {}), ...(f.metrics || {})}; debugStats();
    }
  } catch (error) {
    playbackFailure(error); pageFailure(3);
    debugStats(true);
    $('error').textContent = t('语音数据中断，正在重新连接。');
    if (ws) ws.close();
  }
}
function recordClose(code, reason) {
  const reasons = {ended: 1, idle: 2, session_limit: 3, quota_exceeded: 4, preempted: 5, disconnected: 6, shutdown: 7};
  clientStats.ws_close_code = code;
  clientStats.ws_close_reason = reasons[reason] || 0;
  clientStats.ws_close_reason_length = reason.length;
  debugStats(true);
}
function connect() {
  if (!running || paused) return;
  connected = false; state('connecting', t('正在建立语音连接'));
  const base = location.pathname.replace(/[^/]*$/, '');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws');
  const socket = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { recorder.add('ws_open', {ready: socket.readyState}); if (ws === socket) socketSend(socket, JSON.stringify({type: 'start', build_id: BUILD_ID, protocol_version: PROTOCOL_VERSION,
      capabilities: CAPABILITIES, downstream_transport: transportPreference || 'sse', diagnostic_ws: Number(transportPreference === 'ws')})); };
  ws.onmessage = event => { if (ws === socket) message(event); };
  ws.onerror = () => { recorder.add('ws_error', {ready: socket.readyState}); failureSnapshot(0, socket); recorder.upload(); if (ws === socket) $('error').textContent = t('网络连接异常，请检查网络。'); };
  ws.onclose = event => {
    recorder.add('ws_close', {code: event?.code || 1006, reason: VoiceRecorder.reason(event?.reason),
      reason_length: event?.reason?.length || 0, clean: Number(!!event?.wasClean), ready: socket.readyState});
    failureSnapshot(event?.code || 1006, socket); recorder.upload();
    if (ws !== socket) return;
    recordClose(event?.code || 1006, event?.reason || '');
    connected = false; diagnosticButtons();
    finishDiagnostic(null, event?.code || 1006, event?.reason || ''); closeStream();
    abortUpload(false); phoneTurns.clear();
    expectedAudio = null; pendingTurn = null;
    connected = false; busy = false; activeTurn = null; clearAudio(); if (vad) vad.reset(); $('connection').textContent = t('连接已断开');
    if (!running || paused) return;
    if (reconnects >= 3) { finish(false); state('error', t('重连未成功，请再次开启麦克风')); return; }
    state('connecting', t('网络已断开，正在重连；这段录音不会重发'));
    reconnectTimer = setTimeout(connect, Math.pow(2, reconnects++) * 1000);
  };
}
async function begin() {
  if (running || micPrepare) return;
  const attempt = micPrepare = {sequence: ++micPrepareSequence, stage: 1, started: performance.now()};
  attempt.cancelled = new Promise(resolve => { attempt.cancel = () => resolve(MIC_CANCELLED); });
  attempt.timer = setTimeout(() => micTimeout(attempt), MIC_PREPARE_MS);
  $('start').disabled = true; $('end').disabled = false; $('error').textContent = '';
  state('calibrating', t('正在开启麦克风，请保持页面在前台'));
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Error('unsupported');
    // Each context has its own clock. Never carry a suppression deadline across it.
    silenceUntil = 0; lastDebugAt = -1; lastSettings = '';
    context = new (window.AudioContext || window.webkitAudioContext)(); micProgress(1);
    if (await prepareResult(attempt, context.resume()) === MIC_CANCELLED || micPrepare !== attempt) return;
    recorder.add('context', {state: VoiceRecorder.state(context.state)});
    const audioContext = context;
    context.onstatechange = () => {
      recorder.add('context', {state: VoiceRecorder.state(audioContext.state)});
      if (context === audioContext) resumeAudio();
    };
    const lease = await prepareResult(attempt, acquireMicLease(), release => release?.());
    if (lease === MIC_CANCELLED || micPrepare !== attempt) return;
    micLease = lease;
    micProgress(2);
    const stream = await prepareResult(attempt, navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1}}), stopTracks);
    if (stream === MIC_CANCELLED) return;
    if (micPrepare !== attempt) { stopTracks(stream); return; }
    mic = stream; micProgress(3);
    const track = mic.getAudioTracks?.()[0] || mic.getTracks()[0];
    watchTrack(track); sampleTrack();
    const settings = track?.getSettings?.() || {};
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) clientStats['mic_' + key] = typeof settings[key] === 'boolean' ? Number(settings[key]) : -1;
    playbackGain = context.createGain(); playbackGain.gain.value = 1; playbackGain.connect(context.destination);
    running = true; paused = false; mediaEpoch++; source = context.createMediaStreamSource(mic);
    // ScriptProcessor keeps the page dependency-free and works in older webviews.
    processor = context.createScriptProcessor(2048, 1, 1); mute = context.createGain(); mute.gain.value = 0;
    source.connect(processor); processor.connect(mute).connect(context.destination);
    processor.onaudioprocess = e => {
      try {
      if (paused || !connected || !vad || pendingTurn || diagMatrix || (downstreamTransport === 'sse' && !streamReady) || context.currentTime < silenceUntil) return;
      const now = context.currentTime;
      playbackGuards = playbackGuards.filter(g => g.until > now);
      const suppressed = playbackGuards.some(g => now >= g.at && now < g.until);
      const calibrating = vad.calibratedMs < vad.config.calibration_ms;
      const playing = [...playbackWindows].some(([node, range]) => sources.has(node) && now >= range.at && now < range.endAt);
      const replyPending = busy || sources.size > 0 || playbackQueue.length > 0;
      const result = vad.push(e.inputBuffer.getChannelData(0), context.sampleRate, playing, suppressed, false, replyPending);
      if (calibrating && vad.calibratedMs >= vad.config.calibration_ms && !busy) {
        micProgress(7); stopMicPrepare(1);
        state('listening', t('直接说话，停顿后自动发送'));
      }
      for (const key of ['noise_floor', 'enter_threshold', 'exit_threshold']) clientStats[key] = Number(result[key].toFixed(5));
      if (result.started) {
        captureStamps = {}; phoneMark(captureStamps, 't_vad_start');
        if (uploadMode === 'stream') openUpload(context.sampleRate, 'stream', captureStamps);
        clientStats.vad_started++;
        if (busy || sources.size) { ducked = true; replyGain(vad.config.duck_gain); clientStats.ducked++; }
        state('recording', t('停顿后会自动发送')); debugStats(true);
      }
      if (uploadMode === 'stream' && liveUpload) {
        for (const frame of result.capture) liveUpload?.queue.push(liveUpload.converter.push(frame));
      }
      if (result.confirmed && playing) { clientStats.confirmed++; stopReply(); state('recording', t('停顿后会自动发送')); debugStats(true); }
      if (result.cancelled && !result.audio) { abortUpload(); restoreReply(); }
      if (result.ended) {
        phoneMark(captureStamps, 't_vad_end');
        if (result.audio) {
          if (uploadMode === 'stream') completeUpload(liveUpload, result.voice_ms);
          else upload(result.audio, context.sampleRate, result.voice_ms, captureStamps);
        }
        else { abortUpload(); if (ducked) restoreReply();
        else if (!busy) state('listening', t('请靠近麦克风说话')); }
      }
      debugStats();
      } catch (_) { abortUpload(); vad?.reset(); pageFailure(6); state('error', t('录音处理异常，请重新开启麦克风')); }
    };
    $('end').disabled = false; micProgress(4); connect();
    uploadTimer = setInterval(() => liveUpload?.queue.pump(), 20);
    healthTimer = setInterval(() => { if (running) { sampleTrack(); if (!paused) { resumeAudio(); if (mic?.getAudioTracks?.()[0]?.readyState === 'ended') recoverMic(); } } }, 1000);
    heartbeat = setInterval(() => send({type: 'ping', source: 'heartbeat'}), 15000);
  } catch (error) {
    if (micPrepare !== attempt) return; // A retired rejection cannot end a newer session.
    stopMicPrepare(4); pageFailure(8);
    finish(false); $('error').textContent = error.name === 'NotAllowedError' ? t('麦克风权限未开启，请在系统设置中允许后重试。') : t('无法开启麦克风，请在支持录音的 ClawNest 页面重试。');
    if (error.message === 'session_busy') $('error').textContent = t('已有一段语音对话，请先结束另一页。');
    if (error.message === 'classic_unsupported') $('error').textContent = t('此浏览器不支持经典页面的麦克风隔离，请返回语音聊天页面。');
    state('error', t('开启麦克风后才能对话'));
  }
}
function finish(notify = true, controlSource = 'user_end') {
  stopMicPrepare(3); micRecovery = null; recoveringMic = false; resumingContext = null;
  abortUpload(); phoneTurns.clear(); clearInterval(uploadTimer);
  running = false; mediaEpoch++; paused = false; clearTimeout(pauseTimer); clearInterval(healthTimer); clearTimeout(reconnectTimer); clearInterval(heartbeat);
  if (notify) send({type: 'end_session', source: controlSource});
  diagStop = true; finishDiagnostic(null, 1000, controlSource); closeStream();
  connected = false; clearAudio(); activeTurn = null; pendingTurn = null; busy = false;
  for (const [osc, gain] of feedbackSources) {
    osc.onended = null; releaseMedia(() => osc.stop());
    releaseMedia(() => osc.disconnect()); releaseMedia(() => gain.disconnect());
  }
  feedbackSources.clear();
  if (ws) {
    const socket = ws; ws = null; socket.onopen = socket.onmessage = null;
    releaseMedia(() => socket.close());
  }
  expectedAudio = null;
  if (processor) { processor.onaudioprocess = null; releaseMedia(() => processor.disconnect()); processor = null; }
  if (source) { releaseMedia(() => source.disconnect()); source = null; }
  if (mute) { releaseMedia(() => mute.disconnect()); mute = null; }
  if (playbackGain) { releaseMedia(() => playbackGain.disconnect()); playbackGain = null; }
  stopTracks(mic); mic = null;
  micLease?.(); micLease = null;
  if (context) {
    const audioContext = context; context = null; audioContext.onstatechange = null;
    releaseMedia(() => { Promise.resolve(audioContext.close()).catch(() => {}); });
  }
  textSync?.dispose(); textSync = null; textSyncTurn = null;
  if (vad) vad.reset(); vad = null; segmentRates.clear();
  silenceUntil = 0; lastDebugAt = -1; lastSettings = ''; reconnects = 0; captureStamps = {}; baseVadConfig = {};
  turnReceived = {bytes: 0, frames: 0}; playbackError = 0;
  diagnosticButtons();
  $('start').disabled = false; $('start').textContent = t('再次开启麦克风'); $('end').disabled = true; $('connection').textContent = t('已结束');
  state('ended', t('想聊时，再次开启麦克风'));
}
$('start').onclick = begin; $('end').onclick = () => finish(true);
let lastSettings = '', resumingContext = null;
function sampleTrack() {
  const settings = mic?.getAudioTracks?.()[0]?.getSettings?.() || {};
  const numeric = {rate: settings.sampleRate, channels: settings.channelCount,
    echo: typeof settings.echoCancellation === 'boolean' ? Number(settings.echoCancellation) : -1,
    noise: typeof settings.noiseSuppression === 'boolean' ? Number(settings.noiseSuppression) : -1,
    agc: typeof settings.autoGainControl === 'boolean' ? Number(settings.autoGainControl) : -1};
  const key = JSON.stringify(numeric);
  if (key !== lastSettings) { lastSettings = key; recorder.add('settings', numeric); }
}
function watchTrack(track) {
  if (!track) return;
  for (const [event, kind] of [['mute', 'track_mute'], ['unmute', 'track_unmute'], ['ended', 'track_ended']]) {
    track.addEventListener?.(event, () => {
      if (!mic?.getTracks().includes(track)) return;
      recorder.add(kind, {state: VoiceRecorder.state(track.readyState), muted: Number(!!track.muted)});
      if (event === 'ended' && running && !paused) recoverMic();
      if (event === 'mute' && running) state('paused', t('麦克风暂时不可用，正在等待恢复'));
      if (event === 'unmute' && running && !paused) state('listening', t('麦克风已恢复'));
    });
  }
}
async function resumeAudio() {
  if (!running || paused || !context || resumingContext === context || !['suspended', 'interrupted'].includes(context.state)) return;
  const audioContext = resumingContext = context;
  try { await audioContext.resume(); }
  catch (error) {
    if (running && context === audioContext) { playbackFailure(error); state('paused', t('声音已暂停，点页面恢复')); }
  }
  finally { if (resumingContext === audioContext) resumingContext = null; }
}
async function recoverMic() {
  if (!running || paused || recoveringMic || !context) return;
  recoveringMic = true; const epoch = mediaEpoch, recovery = micRecovery = {};
  state('paused', t('正在恢复麦克风'));
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1}});
    if (!running || paused || epoch !== mediaEpoch || micRecovery !== recovery) { stopTracks(stream); return; }
    source?.disconnect(); stopTracks(mic);
    mic = stream; watchTrack(mic.getAudioTracks()[0]); sampleTrack();
    abortUpload(); source = context.createMediaStreamSource(mic); source.connect(processor); vad?.reset();
    state('listening', t('麦克风已恢复，可以继续说话'));
  } catch (_) { if (running && epoch === mediaEpoch && micRecovery === recovery) { pageFailure(7); state('paused', t('麦克风未恢复，请点结束后重新开启')); } }
  finally { if (micRecovery === recovery) { micRecovery = null; recoveringMic = false; } }
}
function pausePage(kind) {
  recorder.add(kind, {hidden: Number(!!document.hidden)});
  if (micPrepare) { finish(true, 'background'); return; }
  if (!running || paused) return;
  paused = true; pausedAt = Date.now();
  abortUpload();
  send({type: 'pause'}); clearAudio(); busy = false; activeTurn = pendingTurn = null;
  vad?.reset(); mic?.getTracks().forEach(t => { t.enabled = false; });
  context?.suspend?.().catch(() => {});
  state('paused', t('已在后台暂停，返回页面后恢复'));
  pauseTimer = setTimeout(() => { if (paused) finish(true, 'background'); }, pauseSeconds * 1000);
}
async function resumePage() {
  recorder.add('resume');
  if (!running) return;
  if (paused && Date.now() - pausedAt >= pauseSeconds * 1000) { finish(true, 'background'); return; }
  paused = false; clearTimeout(pauseTimer); mic?.getTracks().forEach(t => { t.enabled = true; });
  const epoch = mediaEpoch;
  send({type: 'resume'}); await resumeAudio();
  if (!running || paused || epoch !== mediaEpoch) return;
  if (mic?.getAudioTracks?.()[0]?.readyState === 'ended') await recoverMic();
  if (!running || paused || epoch !== mediaEpoch) return;
  if (!connected) connect(); else state('listening', t('已恢复，可以继续说话'));
}
window.addEventListener('pagehide', () => pausePage('pagehide'));
window.addEventListener('pageshow', () => { if (paused) resumePage(); });
document.addEventListener('visibilitychange', () => { recorder.add('visibility', {hidden: Number(!!document.hidden)}); if (document.hidden) pausePage('visibility'); else resumePage(); });
document.addEventListener('freeze', () => pausePage('freeze'));
document.addEventListener('resume', resumePage);
window.addEventListener('pointerdown', () => resumeAudio());
window.addEventListener('error', () => pageFailure(1));
window.addEventListener('unhandledrejection', () => pageFailure(2));
for (const kind of ['online', 'offline']) window.addEventListener(kind, () => recorder.add(kind, {online: Number(!!navigator.onLine)}));
function recordConnection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return;
  recorder.add('connection', {type: ['slow-2g', '2g', '3g', '4g'].indexOf(c.effectiveType) + 1,
    state: ['bluetooth', 'cellular', 'ethernet', 'none', 'wifi', 'wimax', 'other', 'unknown'].indexOf(c.type) + 1,
    downlink: c.downlink, rtt: c.rtt, save: Number(!!c.saveData)});
}
(navigator.connection || navigator.mozConnection || navigator.webkitConnection)?.addEventListener?.('change', recordConnection);
recordConnection();
try {
  if (typeof PerformanceObserver !== 'undefined') new PerformanceObserver(list => {
    for (const entry of list.getEntries()) recorder.add('longtask', {duration: entry.duration});
  }).observe({type: 'longtask', buffered: true});
} catch (_) {}
