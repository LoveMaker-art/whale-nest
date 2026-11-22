// T-0201: PCM edge continuity and sentence-preserving clause batching.
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
let running = false, connected = false, userMicMuted = false, reconnects = 0, reconnectTimer, heartbeat;
let preferHttps = false, socketUpgradeTimer;
// Page identity only binds a reconnect. The relay authenticates every new socket.
const connectionId = crypto.randomUUID();
let admittedSession = null, connectionDeadline, lastServerFrame = 0;
const MAX_RECONNECTS = 5;
let pendingTurn = null, activeTurn = null, busy = false, expectedAudio = null, scheduledUntil = 0, silenceUntil = 0;
let turnWaiting = false, lastPCMSegment = null;
let inputRate = 16000, sources = new Set(), startedSegments = new Set(), segmentTurns = new Map();
let pendingTimers = new Set(), playbackGain, ducked = false, playbackGuards = [];
const feedbackSources = new Map();
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
let startAttemptAt = 0;
let replyPrebufferMs = playbackSetting('prebuffer_ms', 600, 10000);
let firstMaxWaitMs = playbackSetting('prebuffer_max_wait_ms', Math.max(1200,replyPrebufferMs+500), 10000);
let replyRebufferMs = playbackSetting('rebuffer_ms', 600, 5000);
let rebufferMaxWaitMs = playbackSetting('rebuffer_max_wait_ms', 300, 10000);
let bufferPolicy = null, bufferStats = null, bufferSequence = 0;
$('prebuffer').value = String(replyPrebufferMs);
if (![0, 600, 1000, 1500, 2500].includes(replyPrebufferMs)) {
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
// Reveal text with speech by default. Keep explicit saved choices and diagnostic queries.
let textSyncEnabled = true, textSync = null, textSyncTurn = null, textSyncSequence = 0;
try {
  const query = new URLSearchParams(location.search).get('text_sync');
  if (['on', 'off'].includes(query)) textSyncEnabled = query === 'on';
  else textSyncEnabled = localStorage.getItem('clawchat.voice.text_immediate') !== '1';
} catch (_) {}
$('text-sync').value = textSyncEnabled ? 'audio' : 'text';
$('text-sync').onchange = () => {
  textSyncEnabled = $('text-sync').value === 'audio';
  try { localStorage.setItem('clawchat.voice.text_immediate', textSyncEnabled ? '0' : '1'); } catch (_) {}
  // Capture at turn acceptance. Never hide already visible text or change the
  // current turn's reveal policy when the setting is changed during playback.
};
function syncReply() {
  if (!textSync || textSyncTurn !== activeTurn) {
    textSync?.dispose(); textSyncTurn = activeTurn;
    const sequence = ++textSyncSequence, enabled = textSyncEnabled;
    textSync = new Voice.TextSync({enabled, now: () => performance.now(),
      later: (fn, ms) => setTimeout(fn, ms), cancel: timer => clearTimeout(timer),
      audio: () => ({time: context?.currentTime || 0, running: context?.state === 'running', pending: sources.size > 0 || (!!bufferPolicy && playbackQueue.length > 0)}),
      render: text => renderReplyPrefix(text),
      // Existing numeric timing schema: code=56, count=sentence units,
      // duration=p50 ms, rtt=max ms, reason=fallback units; no protocol change.
      metrics: values => recorder.add('timing', {code: 56, type: sequence, state: Number(enabled), ...values})});
  }
  return textSync;
}
let transportPreference = null;
try { const value = localStorage.getItem(TRANSPORT_KEY); if (['ws', 'sse'].includes(value)) transportPreference = value; } catch (_) {}
let streamLastId = 0, streamRetries = 0, streamReconnectTimer;
let paused = false, pausedAt = 0, pauseSeconds = 120, pauseTimer, healthTimer, recoveringMic = false, mediaEpoch = 0;
// Same-origin page/classic coordination. No persistent key; the service remains
// authoritative for session_busy across devices, contexts and older clients.
const pendingMicLeases = new Set();
let micLease = null, retiredSession = null, selfBusyRetry = false;
async function acquireMicLease() {
  if (!navigator.locks?.request) {
    if (location.pathname.endsWith('/classic') || location.pathname.endsWith('/classic.html')) throw Error('classic_unsupported');
    return null;
  }
  return new Promise((resolve, reject) => {
    let unlocked;
    const released = new Promise(done => { unlocked = done; });
    navigator.locks.request('clawchat.voice.microphone', {ifAvailable:true}, lock => {
      if (!lock) { reject(Error('session_busy')); return; }
      return new Promise(release => resolve(() => { release(); return released; }));
    }).then(unlocked, error => { unlocked(); reject(error); });
  });
}
function prepareMicLease(attempt) {
  const pending = acquireMicLease().then(async release => {
    if (micPrepare !== attempt) { await release?.(); return MIC_CANCELLED; }
    micLease = release; return release;
  });
  pendingMicLeases.add(pending);
  pending.then(() => pendingMicLeases.delete(pending), () => pendingMicLeases.delete(pending));
  return pending;
}

const MIC_PROMPT_MS = 90000, MIC_UNKNOWN_MS = 25000;
const MIC_PREPARE_MS = 8000, MIC_CANCELLED = Symbol('mic_cancelled');
let micPrepare = null, micPrepareSequence = 0, micRecovery = null;
let startupFallbackTimer;
// One capture owner, including requests that cannot be aborted by the browser API.
// A retired request must settle and stop its late tracks before another may run.
let micTeardown = null, lastHangupAt = -1;
const pendingMicRequests = new Set();
const micErrorCode = error => ({NotAllowedError:1, NotFoundError:2, NotReadableError:3,
  OverconstrainedError:4, AbortError:5, SecurityError:6, TypeError:7})[error?.name] || 8;
function micEvidence(attempt, error, retry, state) {
  const values = {state, reason:error ? micErrorCode(error) : 0, count:retry,
    duration:Math.max(0, performance.now() - attempt.started),
    rtt:lastHangupAt < 0 ? 0 : Math.round(performance.now() - lastHangupAt)};
  recorder.add('timing', {code:62, type:5, ...values});
  recorder.add('timing', {code:60, type:3, ...values});
}
// Capture waiting and transport/calibration each own a budget. Permission lookup
// is advisory and never awaited before gUM or the gesture-resumed AudioContext.
function armMicWatchdog(attempt, ms = MIC_PREPARE_MS) {
  if (micPrepare !== attempt) return;
  clearTimeout(attempt.timer);
  attempt.timer = setTimeout(() => micTimeout(attempt), Math.max(0, ms));
}
function permissionEvidence(attempt, reason) {
  startDiagnostic(6, micPermission, reason, performance.now() - attempt.captureStarted,
    {count:Number(!!attempt.sawPrompt)});
}
function updateMicPermission() {
  const attempt = micPrepare;
  if (!attempt?.capturePending) return;
  const previous = attempt.permission;
  attempt.permission = micPermission;
  attempt.sawPrompt ||= micPermission === 0;
  attempt.promptPending = micPermission === 0 || micPermission === -1;
  if (previous !== micPermission) permissionEvidence(attempt, 4);
  // Repeated query/change notifications must not keep extending a deadline.
  if (previous !== micPermission || !attempt.captureDeadline) {
    if (micPermission === 1 || micPermission === 2) {
      attempt.captureDeadline = performance.now() + MIC_PREPARE_MS;
    } else {
      attempt.captureDeadline = attempt.captureStarted + (micPermission === 0 ? MIC_PROMPT_MS : MIC_UNKNOWN_MS);
    }
    armMicWatchdog(attempt, attempt.captureDeadline - performance.now());
  }
  renderView();
}
function startMicCapture(attempt) {
  if (!attempt.capturePending) {
    attempt.capturePending = true; attempt.captureStarted = performance.now();
    attempt.captureDeadline = 0; updateMicPermission(); permissionEvidence(attempt, 0);
  }
}
function settleMicCapture(attempt, reason) {
  if (micPrepare !== attempt || !attempt.capturePending) return;
  permissionEvidence(attempt, reason);
  attempt.capturePending = attempt.promptPending = false;
  armMicWatchdog(attempt); renderView();
}
function requestMic(constraints, valid) {
  let requested;
  try { requested = navigator.mediaDevices.getUserMedia(constraints); }
  catch (error) { requested = Promise.reject(error); }
  const pending = Promise.resolve(requested).then(stream => {
    if (!valid()) { stopTracks(stream); return MIC_CANCELLED; }
    return stream;
  });
  pendingMicRequests.add(pending);
  pending.then(() => pendingMicRequests.delete(pending), () => pendingMicRequests.delete(pending));
  return pending;
}
function retryMicDelay(attempt, ms) {
  return prepareResult(attempt, new Promise(resolve => { attempt.retryTimer = setTimeout(resolve, ms); }));
}
async function prepareMicrophone(attempt) {
  // No artificial startup delay. Without Web Locks, initial gUM is in the click.
  // With locks, preserve cross-page admission before touching the microphone.
  // Reentry waits for close and unabortable retired gUM; never overlap them.
  if (micTeardown && await prepareResult(attempt, micTeardown) === MIC_CANCELLED) return MIC_CANCELLED;
  const delays = [150, 400, 900];
  for (let retry = 0; ; retry++) {
    if (micPrepare !== attempt) return MIC_CANCELLED;
    if (!attempt.resuming) micProgress(2); attempt.micStarted = performance.now(); startDiagnostic(4, micPermission, 0);
    try {
      // Fresh constraints on each try; a relaxed retry avoids stale device constraints.
      const audio = retry ? {echoCancellation:true} :
        {echoCancellation:true, noiseSuppression:true, autoGainControl:false, channelCount:1};
      startMicCapture(attempt);
      const stream = await prepareResult(attempt, requestMic({audio}, () => micPrepare === attempt), stopTracks);
      if (stream === MIC_CANCELLED) return stream;
      settleMicCapture(attempt, 1);
      attempt.stream = stream; micEvidence(attempt, null, retry, 1);
      startDiagnostic(4, micPermission, 1, performance.now() - attempt.micStarted);
      return stream;
    } catch (error) {
      if (micPrepare !== attempt) return MIC_CANCELLED;
      settleMicCapture(attempt, error.name === 'NotAllowedError' ? 2 : 3);
      micEvidence(attempt, error, retry, 0);
      startDiagnostic(4, micPermission, error.name === 'NotAllowedError' ? 2 : 3, performance.now() - attempt.micStarted);
      // No graph is connected until capture succeeds. Reuse the gesture-resumed
      // context during recovery; dispose every provisional stream before retry.
      stopTracks(attempt.stream); attempt.stream = null;
      if (![3,4,5].includes(micErrorCode(error)) || retry >= delays.length) {
        attempt.errorCode = micErrorCode(error); attempt.retryCount = retry; throw error;
      }
      if (await retryMicDelay(attempt, delays[retry]) === MIC_CANCELLED) return MIC_CANCELLED;
    }
  }
}
// code=59: state is the preparation stage; reason 0=progress, 1=ready,
// 2=timeout, 3=cancelled, 4=failed. All values are numeric, never exception text.
function micProgress(stage, reason = 0) {
  const attempt = micPrepare;
  if (!attempt) return;
  if (!reason && stage !== attempt.stage && (stage === 4 || stage === 6)) armMicWatchdog(attempt);
  attempt.stage = stage;
  recorder.add('timing', {code: 59, type: attempt.sequence, state: stage, reason,
    duration: Math.max(0, performance.now() - attempt.started),
    rate: VoiceRecorder.state(context?.state), count: vad?.calibratedMs || 0,
    ready: ws?.readyState ?? 3});
}
function stopMicPrepare(reason) {
  const attempt = micPrepare;
  if (!attempt) return;
  if (attempt.capturePending) permissionEvidence(attempt, reason === 2 ? 5 : 6);
  if (reason !== 1) { stopTracks(attempt.stream); attempt.stream = null; }
  micProgress(attempt.stage, reason);
  startResult(({1:1, 2:5, 3:6, 4:9})[reason] || 9);
  micPrepare = null; clearTimeout(attempt.timer); clearTimeout(attempt.inviteTimer); clearTimeout(attempt.retryTimer);
  clearTimeout(startupFallbackTimer); attempt.cancel();
}
function micTimeout(attempt) {
  if (micPrepare !== attempt) return;
  reportStartup(attempt.stage);
  const link = attempt.stage === 4 || attempt.stage === 5;
  const message = link ? t('语音连接超时，请重新拨打。') : attempt.stage === 6
    ? t('麦克风已开启，但声音校准超时。请重新拨打。') : t('麦克风准备超时，请重试。');
  const retry = link ? t('重新拨打') : t('重试开启麦克风');
  stopMicPrepare(2); pageFailure(9); finish(false);
  startLabel(retry);
  state('error', retry);
  const terminal = link ? 'voice_start_timeout' : attempt.stage === 6 ? 'mic_calibration_timeout' : 'mic_timeout';
  notice(message, 'retry', retry, terminal);
}
function reportStartup(stage) {
  const query = new URLSearchParams({stage:String(stage),socket:String(ws?.readyState ?? 3),mic:String(Number(!!mic))});
  fetch(basePath()+'startup-status?'+query,{credentials:'same-origin',cache:'no-store',keepalive:true}).catch(()=>{});
}
async function prepareResult(attempt, promise, release) {
  const guarded = Promise.resolve(promise).then(value => {
    if (micPrepare !== attempt) { release?.(value); return MIC_CANCELLED; }
    return value;
  }, error => { if (micPrepare !== attempt) return MIC_CANCELLED; throw error; });
  return Promise.race([guarded, attempt.cancelled]);
}
function releaseMedia(action) { try { action(); } catch (_) {} }
function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) { if (track.readyState !== 'ended') releaseMedia(() => track.stop()); } }
function socketSend(socket, data) {
  recorder.add('send', {buffered: socket.bufferedAmount || 0, ready: socket.readyState});
  socket.send(data);
}
function pageFailure(type = 0) { recorder.failure('error', {type}); }
$('copy-events').onclick = async () => {
  const text = JSON.stringify({build_id: BUILD_ID, protocol_version: PROTOCOL_VERSION, transport: downstreamTransport === 'sse' ? 1 : 2}) + '\n' + recorder.text(); $('event-records').textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    $('copy-events-status').textContent = t('已复制故障信息');
  } catch (_) {
    $('copy-events-status').textContent = t('可手动复制下方的故障信息');
  }
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
      if (f.type === 'sse_ready') {
        recorder.message(f.type); streamReady = true; reconnects = 0;
        clearTimeout(startupFallbackTimer);
        clearTimeout(connectionDeadline); micProgress(6); renderView(); return;
      }
      if (f.type === 'sse_heartbeat') return;
      if (f.type === 'diagnostic_binary') { recorder.message(f.type); diagnosticBinary(decode64(f.data)); return; }
      if (f.type === 'audio') { recorder.message(f.type); const pcm = decode64(f.pcm); countPCM(pcm); playPCM(pcm, f); return; }
      message({data: JSON.stringify(f)});
    } catch (error) {
      playbackFailure(error, 8); pageFailure(4);
      notice(t('声音连接暂时无法恢复。请结束对话后重新开启。'), 'end', t('结束并重新准备'));
      if (downstreamTransport === 'sse') send({type: 'cancel'});
      clearAudio();
    }
  };
  const reconnect = (clean = false) => {
    if (eventStream !== stream || !running) return;
    streamReady = false; stream.close();
    if (!clean) { renderView(); notice(t('声音连接中断，正在重连。'), 'dismiss', t('知道了')); }
    if (!clean && ++streamRetries > 10) {
      pageFailure(5); clearAudio(); send({type: 'cancel'});
      // A fresh admission also refreshes the SSE replay lane.
      ws?.close(); return;
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
// Step 2 and standard barge-in preserve the server's exact old config.
const MIC_STEPS = [1.5, 1.25, 1, .85, .7];
const MIC_LABELS = [t('低'), t('较低'), t('标准'), t('较高'), t('高')];
function enumSetting(key, values, fallback) {
  const valid = v => values.includes(v);
  const query = new URLSearchParams(location.search).get(key);
  if (valid(query)) return query;
  try { const saved = localStorage.getItem('clawchat.voice.' + key); if (valid(saved)) return saved; } catch (_) {}
  return fallback;
}
let legacySensitivity = '2';
try { legacySensitivity = ({low:'1',medium:'2',high:'3'})[localStorage.getItem('clawchat.voice.sensitivity')] || '2'; } catch (_) {}
let micSensitivity = Number(enumSetting('mic_sensitivity', ['0','1','2','3','4'], legacySensitivity));
let bargeInEnabled = enumSetting('barge_in', ['0','1'], '1') === '1';
let bargeSensitivity = enumSetting('barge_in_sensitivity', ['low','standard','high'], 'standard');
let vadSettingsPending = false, ignoredSpeech = false, halfDuplexMuted = false, settingsTurn = null;
let turnInterrupts = {confirmed:0, ignored:0};
function sensitivityMetrics(reason = 0) {
  recorder.add('timing', {code:61, type:micSensitivity, state:Number(bargeInEnabled),
    reason:['low','standard','high'].indexOf(bargeSensitivity), channels:reason,
    count:turnInterrupts.confirmed, buffered:turnInterrupts.ignored});
}
function vadConfig() {
  const config = {...baseVadConfig}, factor = MIC_STEPS[micSensitivity];
  for (const key of ['threshold','noise_multiplier']) {
    const old = config[key] ?? (key === 'threshold' ? .018 : 2.5);
    if (factor !== 1) config[key] = old * factor;
  }
  if (micSensitivity !== 2) config.hangover_ms = (config.hangover_ms ?? 650) + [100,50,0,-50,-100][micSensitivity];
  const barge = {low:[1.3,500,650],standard:[1,360,450],high:[.8,350,450]}[bargeSensitivity];
  if (bargeSensitivity !== 'standard') {
    config.playback_threshold = (config.playback_threshold ?? .065) * barge[0];
    config.playback_noise_multiplier = (config.playback_noise_multiplier ?? 3) * barge[0];
    config.playback_attack_ms = Math.max(350, (config.playback_attack_ms ?? 360) + barge[1] - 360);
    config.barge_confirm_ms = Math.max(barge[2], config.barge_confirm_ms ?? 450);
  }
  return config;
}
function configureVAD(preserveFloor = false) {
  const previous = vad;
  vad = new Voice.VAD(vadConfig());
  if (preserveFloor && previous) {
    vad.noiseFloor = Math.max(vad.config.noise_floor_min, Math.min(vad.config.noise_floor_max, previous.noiseFloor));
    vad.calibratedMs = Math.min(vad.config.calibration_ms, previous.calibratedMs);
  }
  vadSettingsPending = false;
  clientStats.sensitivity = micSensitivity;
}
let agentDisplayName = '';
function updateMicSettings() {
  $('sensitivity').value = String(micSensitivity);
  $('sensitivity-label').textContent = MIC_LABELS[micSensitivity];
  $('sensitivity').setAttribute?.('aria-valuetext', MIC_LABELS[micSensitivity]);
  $('barge-in').checked = bargeInEnabled;
  $('barge-sensitivity').value = bargeSensitivity;
  $('barge-sensitivity-row').hidden = !bargeInEnabled;
  $('barge-in-hint').textContent = (bargeInEnabled
    ? t('{agent}在说话时，你一开口，它就先停下来听你。')
    : t('{agent}会先把这句话说完，再听你说。')).replace('{agent}', () => agentDisplayName || t('对方'));
}
function saveMicSetting(key, value) {
  try { localStorage.setItem('clawchat.voice.' + key, String(value)); } catch (_) {}
  vadSettingsPending = true;
  if (vad && !vad.recording && !vad.attack) configureVAD(true);
  updateMicSettings(); sensitivityMetrics();
}
$('sensitivity').oninput = $('sensitivity').onchange = () => {
  micSensitivity = Math.max(0, Math.min(4, Number($('sensitivity').value) || 0));
  saveMicSetting('mic_sensitivity', micSensitivity);
};
$('barge-in').onchange = () => {
  bargeInEnabled = $('barge-in').checked;
  if (!bargeInEnabled && vad?.interruptCandidate && !vad.confirmed) { abortUpload(); vad.reset(); restoreReply(); }
  saveMicSetting('barge_in', Number(bargeInEnabled));
};
$('barge-sensitivity').onchange = () => {
  bargeSensitivity = ['low','standard','high'].includes($('barge-sensitivity').value) ? $('barge-sensitivity').value : 'standard';
  saveMicSetting('barge_in_sensitivity', bargeSensitivity);
};
updateMicSettings();
const labels = {paused: t('对话已暂停'), ready: t('准备好就开始'), connecting: t('正在连接'), calibrating: t('正在准备麦克风'), listening: t('正在听你说'),
  recording: t('听到了，继续说'), thinking: t('正在想'), speaking: t('正在说'), ended: t('对话已结束'), error: t('连接已暂停')};
// Presentation only. Control state, receipt epochs and TextSync remain authoritative.
const viewEnabled = typeof document.createTextNode === 'function';
let uiTerminal = '', uiInterrupted = false, uiStopped = false, uiPartial = false;
let uiSubmitWait = false;
const CONTROL_GUARD_MS = 600;
let controlStartedAt = -Infinity;
let uiTurn = null, uiCandidateSaid = null, uiHistory = [], uiNoticeAction = 'dismiss';
let uiLayoutKey = '', captionsEnabled = false;
let uiPrefix = '', uiReplyKey = '', uiFollow = true, uiHint = '', uiEndedHint = '';
const uiPlayback = new Map();
let uiDisplayTurn = null, uiDisplaySequence = 0, uiDisplayAt = 0;
function viewText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
function startLabel(text) {
  if (!viewEnabled) $('start').textContent = text; // Browser labels come from the current control action.
}
function actualPlayback() {
  if (!context || context.state !== 'running') return null;
  const time = context.currentTime;
  for (const [id, span] of uiPlayback) {
    if (span.epoch === receipt.epoch && span.ranges.some(r => sources.has(r.node) && time >= r.at && time < r.endAt)) return id;
  }
  return null;
}
function rawUiState() {
  if (uiTerminal) return uiTerminal;
  if (micPrepare) return 'preparing';
  const name = document.body.dataset.state;
  if (running && (paused || name === 'paused' || name === 'error')) return name === 'error' ? 'playback_failed' : 'paused';
  if (running && name === 'recording') return uiInterrupted ? 'interrupted' : 'user_speaking';
  if (actualPlayback() !== null) return 'speaking';
  if (running && (!connected || (downstreamTransport === 'sse' && !streamReady))) return 'reconnecting';
  if (running && bufferPolicy && !bufferPolicy.first && bufferPolicy.waitAt !== null && playbackQueue.length) return 'buffering';
  if (running && (busy || sources.size || playbackQueue.length)) return 'thinking';
  if (running) return 'listening';
  return name === 'ready' || !name ? 'idle' : name === 'error' ? 'mic_failed' : 'ended';
}
// Presentation hysteresis only: never delay playback, receipts, cancellation or
// reconnection. A busy turn without PCM is implicitly waiting for generation/TTS;
// tool activity alone must not override audio already queued or playing.
const UI_SILENCE_MS = 1500, UI_DWELL_MS = 600;
let uiSpeech = null;
function deriveUiState() {
  const raw = rawUiState(), now = performance.now();
  const replyState = ['thinking', 'speaking', 'buffering'].includes(raw);
  if (!running || !busy || !activeTurn || !replyState) {
    uiSpeech = null;
    return raw;
  }
  if (!uiSpeech || uiSpeech.turn !== activeTurn || uiSpeech.epoch !== receipt.epoch) {
    uiSpeech = {turn: activeTurn, epoch: receipt.epoch, spoken: false,
      state: 'thinking', since: now, quietSince: null};
  }
  const ui = uiSpeech;
  const firstSpeech = raw === 'speaking' && !ui.spoken;
  if (raw === 'speaking') ui.spoken = true;
  // Ignore expired nodes whose onended callback has not run yet. Future nodes
  // and the held prebuffer queue both count as pending audio.
  const pending = playbackQueue.length > 0 || [...uiPlayback.values()].some(span =>
    span.epoch === receipt.epoch && span.ranges.some(r => sources.has(r.node) && r.endAt > (context?.currentTime || 0)));
  if (raw === 'speaking' || pending) ui.quietSince = null;
  else if (ui.quietSince === null) ui.quietSince = now;
  const target = raw === 'speaking' ? 'speaking' : !ui.spoken ? 'thinking' :
    pending || now - ui.quietSince < UI_SILENCE_MS ? ui.state : 'thinking';
  if (target !== ui.state && (firstSpeech || now - ui.since >= UI_DWELL_MS)) {
    ui.state = target; ui.since = now;
  }
  return ui.state;
}
const uiCopy = {
  idle: [t('点击拨打'), t('点一下，开启麦克风。')], preparing: [t('正在准备麦克风'), t('请允许使用麦克风，先安静片刻。')],
  listening: [t('正在听你说'), t('直接说话，停顿后自动发送。')], user_speaking: [t('听到了，继续说'), t('停顿后会自动发送。')],
  interrupted: [t('听到了，继续说'), t('上一句已打断，停顿后自动发送。')], thinking: [t('正在想'), t('稍等一下，正在准备回复。')],
  speaking: [t('正在说'), t('随时开口打断。')], buffering: [t('正在等声音'), t('声音还在路上，稍等一下。')],
  reconnecting: [t('正在重新连接'), t('刚才这段录音不会重发。连接后请再说一次。')], paused: [t('对话已暂停'), t('返回页面后继续。')],
  ended: [t('对话已结束'), t('想聊时，再次开启麦克风。')], permission: [t('麦克风权限未开启'), t('允许使用麦克风后，再回来重试。')],
  mic_timeout: [t('麦克风准备超时'), t('保持页面在前台，确认权限后重试。')], mic_failed: [t('无法开启麦克风'), t('确认设备可用后重试。')],
  connection_failed: [t('连接未能恢复'), t('检查网络后重新连接。')], session_busy: [t('已有一段语音对话'), t('请先结束另一页，再回来连接。')],
  client_outdated: [t('页面版本过旧'), t('请完全关闭后重新打开。')], capacity: [t('当前会话已满'), t('请稍后重试。')],
  forbidden: [t('好友语音暂不可用'), t('请先添加好友，并请主人开启好友语音。')], quota_exceeded: [t('今天先聊到这里'), t('今天的语音时长已用完，明天再聊。')],
  preempted: [t('对话已结束'), t('主人开始了语音，本次对话已结束。')], playback_failed: [t('声音暂时无法继续'), t('请结束对话，再重新开启麦克风。')]
};
function renderReplyPrefix(text = uiPrefix) {
  if (!viewEnabled) { $('reply').textContent = text; $('reply').scrollIntoView({block:'nearest'}); return; }
  const previous = uiPrefix; uiPrefix = text;
  const id = !uiStopped && actualPlayback();
  const segment = id !== null && id !== false ? textSync?.segments.find(s => s.id === id && s.end <= text.length) : null;
  const key = text + '\0' + (segment ? segment.start + ':' + segment.end : '');
  if (key !== uiReplyKey) {
    uiReplyKey = key;
    const parts = [];
    if (segment) {
      parts.push(document.createTextNode(text.slice(0, segment.start)));
      const current = document.createElement('span'); current.className = 'current';
      current.textContent = text.slice(segment.start, segment.end); parts.push(current);
      parts.push(document.createTextNode(text.slice(segment.end)));
    } else parts.push(document.createTextNode(text));
    $('reply').replaceChildren(...parts);
    if (uiFollow && !$('settings-sheet').open) $('transcript').scrollTop = $('transcript').scrollHeight;
  }
  // Announce only newly visible sentence ranges; partial microphone captions stay silent.
  if (text.startsWith(previous) && text.length > previous.length) {
    const units = textSync?.segments.filter(s => s.end > previous.length && s.end <= text.length) || [];
    if (units.length || textSync?.forced || textSync?.done) {
      const fresh = document.createElement('span'); fresh.textContent = text.slice(previous.length);
      $('subtitle-live').replaceChildren(fresh);
    }
  }
}
let noticeTimer = null, noticeSeverity = 0, noticeShown = '';
function dismissNotice() {
  clearTimeout(noticeTimer); noticeTimer = null; noticeSeverity = 0; noticeShown = '';
  $('error').textContent = ''; $('error-action').hidden = true; renderView();
}
function shortNotice(text, terminal) {
  // CSS clamps the card; keep complete localized sentences in the accessible text.
  if (globalThis.VoiceI18n && VoiceI18n.locale !== 'zh-CN') return String(text);
  const fixed = {permission:t('麦克风权限未开启，请在系统或站点设置中允许。'),mic_timeout:t('麦克风准备超时，请重试。'),mic_failed:t('麦克风无法开启，请重试。'),
    session_busy:t('已有一段语音对话，请先结束。'),client_outdated:t('页面版本过旧，请关闭后重开。'),connection_failed:t('连接未恢复，点击绿色按钮重新拨打。'),
    quota_exceeded:t('今日语音时长已用完。'),capacity:t('当前会话已满，请稍后重试。'),forbidden:t('请先添加好友并开启好友语音。'),preempted:t('主人已开始聊天，本次对话结束。')};
  if (fixed[terminal]) {
    const diagnostic = String(text).match(/（诊断码 (\d+) \/ (\d+)）/);
    return fixed[terminal] + (diagnostic ? '（' + diagnostic[1] + '/' + diagnostic[2] + '）' : '');
  }
  if (/上一条回复仍在停止/.test(text)) return t('上一条回复仍在停止，请稍后重新说一遍。');
  const sentence = String(text).split(/[。！!；;]/)[0].replace(/\n/g,' ');
  return [...sentence].slice(0,28).join('') + '。';
}
function notice(text, action = 'dismiss', label = t('继续说话'), terminal = '', persistent = false) {
  const severity = terminal ? 3 : action === 'dismiss' && !persistent ? 1 : 2;
  if (viewEnabled && $('error').textContent && noticeSeverity > severity) return;
  const compact = shortNotice(text,terminal);
  if (viewEnabled && noticeShown === compact && noticeSeverity === severity && uiNoticeAction === action && $('notice-full').textContent === text) return;
  clearTimeout(noticeTimer); noticeSeverity = severity;
  $('error').textContent = compact; noticeShown = $('error').textContent;
  if (!viewEnabled) return;
  $('notice-full').textContent = text; $('notice-details').hidden = !text;
  uiNoticeAction = action; if (terminal) uiTerminal = terminal;
  $('error').setAttribute('role', severity > 1 ? 'alert' : 'status');
  $('error').setAttribute('aria-live', severity > 1 ? 'assertive' : 'polite');
  $('error-action').textContent = ({retry:t('重试'),end:t('结束'),outdated:t('设置'),dismiss:t('知道了')})[action] || t('知道了');
  $('error-action').hidden = !text;
  if (severity === 1) noticeTimer = setTimeout(dismissNotice,6000);
  renderView();
  if (uiFollow && !$('settings-sheet').open) $('transcript').scrollTop = $('transcript').scrollHeight;
}
function archiveGroup() {
  if (!viewEnabled) return;
  const said = uiCandidateSaid ?? $('said').textContent, reply = $('reply').textContent;
  if (uiTurn && (said || reply)) {
    uiHistory.push({id:uiTurn, said, reply, note:$('reply-note').textContent});
    renderHistory();
  }
  uiTurn = null; uiCandidateSaid = null; uiPrefix = ''; uiReplyKey = ''; uiStopped = false; uiPartial = false;
  $('said').textContent = ''; $('subtitle-live').replaceChildren();
}
function restoreCandidateView() {
  if (!viewEnabled) return;
  if (uiCandidateSaid !== null) $('said').textContent = uiCandidateSaid;
  uiCandidateSaid = null; uiPartial = false;
}
function renderHistory() {
  if (!viewEnabled) return;
  const host = $('history');
  // Keep existing nodes stable while the reader scrolls through earlier turns.
  if ([...host.children].some((node, i) => node.dataset.turn !== String(uiHistory[i]?.id))) host.replaceChildren();
  for (const group of uiHistory.slice(host.children.length)) {
    const item = document.createElement('div'); item.className = 'history-group'; item.dataset.turn = group.id;
    for (const [role, text] of [['user', group.said], ['assistant', group.reply]]) {
      if (!Voice.hasBody(text)) continue;
      const article = document.createElement('article'); article.className = 'message' + (role === 'user' ? ' user' : '');
      const speaker = document.createElement('p'); speaker.className = 'speaker'; speaker.textContent = role === 'user' ? t('你') : t('回复');
      const bubble = document.createElement('p'); bubble.className = 'bubble'; bubble.textContent = text;
      article.append(speaker, bubble); item.append(article);
    }
    if (group.note) { const note = document.createElement('p'); note.className = 'message-note'; note.textContent = group.note; item.append(note); }
    host.append(item);
  }
  host.hidden = !uiHistory.length;
}
function resetView() {
  if (!viewEnabled) return;
  clearTimeout(noticeTimer); noticeSeverity = 0; noticeShown = '';
  uiTerminal = ''; uiInterrupted = false; uiStopped = false; uiPartial = false; uiSubmitWait = false;
  archiveGroup(); // A new call keeps this page's previous conversations in memory.
  $('said').textContent = ''; $('reply').textContent = '';
  $('reply-note').textContent = ''; $('subtitle-live').replaceChildren(); $('error-action').hidden = true;
  $('time').textContent = '00:00'; $('time').removeAttribute?.('title'); $('quota').textContent = '';
}
// Presentation only: derive from existing session/transport state, never drive it.
function renderConnectionLamp(name, fatal) {
  const pending = micPrepare || (running && (!connected || (downstreamTransport === 'sse' && !streamReady)));
  const signal = fatal ? 'error' : pending ? 'pending' : running && connected ? 'connected' : 'idle';
  const label = fatal ? t('连接异常：') + (uiCopy[name]?.[0] || t('已断开'))
    : micPrepare ? t('正在准备麦克风') : pending ? (reconnects ? t('正在重新连接') : t('连接中'))
    : signal === 'connected' ? (name === 'paused' ? t('已连接，对话已暂停') : t('已连接'))
    : name === 'ended' ? t('已结束，尚未连接') : t('尚未连接');
  const lamp = $('connection-lamp');
  lamp.dataset.signal = signal; lamp.dataset.uiState = name;
  if (lamp.getAttribute('aria-label') !== label) lamp.setAttribute('aria-label', label);
  viewText('connection-status', label);
}
async function loadAgentProfile() {
  const avatar = $('agent-avatar');
  const fallback = new URL(basePath() + avatar.dataset.fallback, location.href).href;
  avatar.addEventListener('load', () => { avatar.hidden = false; }, {once:true});
  avatar.addEventListener('error', () => {
    if (avatar.src !== fallback) avatar.src = fallback;
  });
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(basePath() + 'profile', {credentials:'same-origin',cache:'no-store'});
      if (!response.ok) break;
      const profile = await response.json();
      if (profile.name && profile.name !== agentDisplayName) {
        agentDisplayName = profile.name;
        viewText('agent-name', agentDisplayName);
        viewText('mic-sensitivity-title', t('让{agent}更容易听到你').replace('{agent}', () => agentDisplayName));
        updateMicSettings();
      }
      if (profile.avatar) { avatar.src = profile.avatar; return; }
      if (!profile.pending) break;
    } catch (_) { break; }
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve,750));
  }
  avatar.src = fallback;
}
function showCaptionHistory(show) {
  $('call-history').hidden = !show;
  $('captions-view').setAttribute('aria-expanded', String(show));
  if (show) {
    const transcript = $('transcript');
    uiFollow = true;
    transcript.scrollTop = transcript.scrollHeight;
    $('captions-close').focus();
  }
}
function renderCaptions(name) {
  const said = $('said').textContent, reply = $('reply').textContent;
  const speaking = $('reply').querySelector('.current')?.textContent;
  const latest = speaking || reply.replace(/\s+/g,' ').match(/[^。！？!?]+[。！？!?]*\s*$/)?.[0]?.trim() || reply;
  const line = name === 'user_speaking' || name === 'interrupted' ? said : latest || said;
  const show = captionsEnabled && Boolean(running || micPrepare || said || reply || uiHistory.length);
  $('caption-current').hidden = !show || !line;
  $('captions-view').hidden = !show;
  viewText('caption-current', show ? line : '');
}
function renderView() {
  if (!viewEnabled) return;
  if ($('error').textContent && $('error').textContent !== noticeShown) { notice($('error').textContent); return; }
  if (!$('error').textContent && noticeShown) { clearTimeout(noticeTimer); noticeSeverity=0; noticeShown=''; }
  const name = deriveUiState(), copy = uiCopy[name] || uiCopy.ended;
  if (activeTurn && uiDisplayTurn !== activeTurn) { uiDisplayTurn = activeTurn; uiDisplaySequence++; }
  if (name !== document.body.dataset.uiState) {
    const state = {thinking:1, speaking:2, listening:3}[name];
    if (state) recorder.add('timing', {code:62, type:uiDisplaySequence, state,
      duration:Math.max(0, performance.now() - uiDisplayAt)});
    uiDisplayAt = performance.now();
  }
  document.body.dataset.animation = motionState(name);
  document.body.dataset.uiState = name; document.body.dataset.connected = String(connected);
  const fatal = !['idle','preparing','listening','user_speaking','interrupted','thinking','speaking','buffering','reconnecting','paused','ended'].includes(name);
  renderConnectionLamp(name, fatal);
  document.body.dataset.tone = fatal ? 'error' : ['paused','reconnecting','buffering'].includes(name) ? 'warning' : '';
  document.body.dataset.notice = String(!!$('error').textContent);
  viewText('status', userMicMuted && !fatal && ['listening','user_speaking'].includes(name) ? t('麦克风已静音') : micPrepare && micTeardown ? t('正在释放麦克风，请稍候') : fatal ? (running ? t('通话已暂停') : t('点击拨打')) : micPrepare?.promptPending ? t('请在弹窗里允许麦克风') : copy[0]);
  viewText('hint', micPrepare?.promptPending ? t('请在弹窗里允许麦克风') : name === 'paused' ? uiHint : name === 'ended' && uiEndedHint ? uiEndedHint : name === 'thinking' && uiSubmitWait ? uiHint : copy[1]);
  viewText('stage-note', name === 'speaking' && !bargeInEnabled ? t('已关闭打断：回复说完才会听你说') : name === 'speaking' ? (downstreamTransport === 'sse' && !streamReady ? t('连接正在恢复 · 随时开口打断') : t('随时开口打断')) : '');
  viewText('said-note', uiPartial ? t('正在听，文字可能调整') : '');
  viewText('reply-note', uiStopped && uiPrefix ? t('已停止 · 已收到的文字已补齐') : (textSync?.forced || textSync?.reveals.some(r => r.fallback)) && uiPrefix ? t('仅文字') : '');
  $('empty-state').hidden = !!($('said').textContent || $('reply').textContent || uiHistory.length || fatal);
  $('history').hidden = !uiHistory.length;
  $('said').parentElement.hidden = !$('said').textContent;
  $('reply').parentElement.hidden = !Voice.hasBody($('reply').textContent);
  if (!$('error').textContent) $('error-action').hidden = true;
  else if ($('error-action').hidden) { $('error-action').hidden = false; uiNoticeAction = 'dismiss'; $('error-action').textContent = t('知道了'); }
  const active = running || !!micPrepare;
  const mode = micPrepare ? 'cancel' : active ? 'end' : 'start';
  const actionLabel = mode === 'cancel' ? t('取消准备') : active ? t('挂断') : t('开始通话');
  $('start').dataset.mode = mode;
  viewText('call-action', mode === 'start' ? t('拨打') : actionLabel);
  const micButton = $('mic-toggle'), micLabel = userMicMuted ? t('取消静音') : t('静音');
  micButton.disabled = !running || !connected || Boolean(micPrepare) || paused;
  micButton.setAttribute('aria-pressed', String(userMicMuted));
  micButton.setAttribute('aria-label', micLabel);
  viewText('mic-toggle-label', micLabel);
  $('start').setAttribute('aria-label', actionLabel);
  $('start').setAttribute('aria-pressed', String(active));
  $('start').disabled = !active && ['client_outdated','quota_exceeded'].includes(name);
  renderReplyPrefix();
  renderCaptions(name);
  const layoutKey = [uiHistory.length, $('said').textContent, $('reply').textContent, $('reply-note').textContent].join('\0');
  if (layoutKey !== uiLayoutKey) {
    uiLayoutKey = layoutKey;
    if (uiFollow && !$('settings-sheet').open) $('transcript').scrollTop = $('transcript').scrollHeight;
  }
}
// Keep geometry in layout coordinates: visualViewport offsets include keyboard pan.
// CSS dvh/svh remains the fallback before JS and where visualViewport is absent.
function syncViewport() {
  const vv = window.visualViewport, root = document.documentElement;
  const height = vv?.height || window.innerHeight;
  const width = vv?.width || window.innerWidth;
  if (!root || !Number.isFinite(height) || !Number.isFinite(width)) return;
  root.style.setProperty('--viewport-height', Math.max(1, height) + 'px');
  root.style.setProperty('--viewport-top', Math.max(0, vv?.offsetTop || 0) + 'px');
  root.style.setProperty('--viewport-width', Math.max(1, width) + 'px');
  root.style.setProperty('--viewport-left', Math.max(0, vv?.offsetLeft || 0) + 'px');
}
function motionState(name) {
  if (['listening','user_speaking','interrupted'].includes(name)) return 'listening';
  if (name === 'thinking' || name === 'buffering') return 'thinking';
  return name === 'speaking' ? 'speaking' : 'idle';
}
function setupView() {
  if (!viewEnabled) return;
  $('mic-toggle').onclick = () => {
    userMicMuted = !userMicMuted;
    mic?.getAudioTracks().forEach(track => { track.enabled = !userMicMuted; });
    if (userMicMuted) {
      // Cancel only a partial capture. A submitted utterance can finish normally.
      if (liveUpload && !liveUpload.voicedMs) abortUpload();
      vad?.reset();
      micVisualLevel = 0;
      $('mic-level').value = 0;
      viewText('mic-level-state', t('麦克风已静音'));
    }
    renderView();
  };
  $('captions-toggle').onclick = () => {
    captionsEnabled = !captionsEnabled;
    $('captions-toggle').setAttribute('aria-pressed', String(captionsEnabled));
    if (!captionsEnabled) showCaptionHistory(false);
    renderView();
  };
  $('captions-view').onclick = () => showCaptionHistory(true);
  $('captions-close').onclick = () => {
    showCaptionHistory(false);
    $('captions-view').focus();
  };
  const sheet = $('settings-sheet'), app = $('app');
  syncViewport();
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', syncViewport);
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-backdrop'; backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true'); sheet.before(backdrop);
  let closeTimer = null, returnFocus = null;
  function restoreSheetFocus() {
    (returnFocus?.isConnected ? returnFocus : $('settings-open')).focus({preventScroll:true});
  }
  function finishClose() {
    clearTimeout(closeTimer); closeTimer = null;
    if (typeof sheet.close === 'function') sheet.close();
    else {sheet.removeAttribute('open'); app.inert = false; app.removeAttribute('aria-hidden');}
    sheet.classList.remove('settings-fallback','settings-closing');
    backdrop.hidden = true; backdrop.classList.remove('settings-closing');
    restoreSheetFocus();
  }
  function closeSheet(event) {
    event?.preventDefault(); event?.stopImmediatePropagation();
    if (!sheet.open || sheet.classList.contains('settings-closing')) return;
    sheet.classList.add('settings-closing'); backdrop.classList.add('settings-closing');
    // Keep the top layer and focus trap until the short exit fade completes.
    // Timer also completes closure when animations are suppressed/interrupted.
    closeTimer = setTimeout(finishClose, 160);
  }
  sheet.addEventListener('animationend', e => {
    if (e.target === sheet && sheet.classList.contains('settings-closing') &&
        ['settings-leave','settings-shade-out'].includes(e.animationName)) finishClose();
  });
  $('settings-open').onclick = () => {
    if (sheet.open) return;
    const active = document.activeElement;
    returnFocus = active && active !== document.body && active !== document.documentElement ? active : $('settings-open');
    syncViewport();
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else {sheet.setAttribute('open','');sheet.classList.add('settings-fallback');backdrop.hidden=false;app.inert=true;app.setAttribute('aria-hidden','true');}
    $('settings-close').focus({preventScroll:true});
  };
  $('settings-close').onclick = closeSheet;
  document.addEventListener('click', e => {
    if (!sheet.open) return;
    const r = sheet.getBoundingClientRect();
    const backdrop = e.target === sheet &&
      (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    const fallbackOutside = sheet.classList.contains('settings-fallback') &&
      !e.target.closest?.('#settings-open') && !sheet.contains(e.target);
    if (backdrop || fallbackOutside) closeSheet(e);
  }, {capture:true});
  sheet.addEventListener('cancel', closeSheet);
  sheet.addEventListener('keydown', e => {
    if (e.key === 'Escape') {closeSheet(e); return;}
    if (e.key !== 'Tab') return;
    const nodes = [...sheet.querySelectorAll('button,select,input,summary,a[href]')].filter(e => {
      if (e.disabled || !e.getClientRects().length) return false;
      // Closed details can still expose descendant rectangles in WebKit/Chromium.
      // Only their direct summary participates in sequential keyboard focus.
      for (let p = e.parentElement; p && p !== sheet; p = p.parentElement) {
        if (p.tagName === 'DETAILS' && !p.open && e !== p.firstElementChild) return false;
      }
      return true;
    });
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {e.preventDefault();last.focus();}
    if (!e.shiftKey && document.activeElement === last) {e.preventDefault();first.focus();}
  });
  sheet.addEventListener('close', () => {
    clearTimeout(closeTimer); closeTimer = null;
    sheet.classList.remove('settings-closing','settings-fallback');
    backdrop.hidden = true; backdrop.classList.remove('settings-closing');
    app.inert = false; app.removeAttribute('aria-hidden'); restoreSheetFocus();
  });
  $('debug-toggle').onchange = () => {$('debug-panel').hidden = !$('debug-toggle').checked;};
  $('buffer-values').textContent = `prebuffer_max_wait_ms=${firstMaxWaitMs}\nrebuffer_ms=${replyRebufferMs}\nrebuffer_max_wait_ms=${rebufferMaxWaitMs}`;
  $('transcript').addEventListener('scroll', () => {const e=$('transcript');uiFollow = e.scrollHeight - e.scrollTop - e.clientHeight < 32;});
  $('error-action').onclick = e => {
    e?.stopPropagation();
    const action = uiNoticeAction; dismissNotice();
    if (action === 'retry') begin();
    else if (action === 'end') finish(true);
    else if (action === 'outdated') { $('settings-open').click(); $('notice-details').open = true; }
  };
  $('notice-close').onclick = e => { e.stopPropagation(); dismissNotice(); };
  $('notice').onclick = e => { if (!e.target.closest('button')) dismissNotice(); };
  setInterval(() => { if (!document.hidden) renderView(); }, 80); renderView();
}

function state(name, hint = '') {
  if (viewEnabled && name !== document.body.dataset.state && noticeShown) { $('error').textContent=''; clearTimeout(noticeTimer); noticeSeverity=0; noticeShown=''; }
  document.body.dataset.state = name; uiHint = hint; if (name === 'ended') uiEndedHint = hint;
  if (viewEnabled) renderView();
  else { $('status').textContent = labels[name] || name; $('hint').textContent = hint; }
}
function send(data) { if (connected && ws && ws.readyState === WebSocket.OPEN) socketSend(ws, JSON.stringify(data)); }
function formatTime(n) { n = Math.max(0, Math.floor(n)); return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }
function report(list) {
  for (const item of list) send({type: 'played', source: 'audio_ended', client_turn_id: segmentTurns.get(item.segment_id), segment_id: item.segment_id, samples: item.samples});
}
function clearAudio() {
  uiSpeech = null;
  turnWaiting = false; lastPCMSegment = null;
  uiStopped = true; uiPlayback.clear();
  textSync?.interrupt();
  bufferMetrics(true); bufferPolicy?.dispose(); bufferPolicy = null; bufferStats = null;
  playbackQueue = []; queuedMs = 0; rebuffering = true; lastPlaybackEdge = null; sealedSegments.clear();
  receipt.cancel(); // Invalidate callbacks before calling stop (which fires onended).
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  for (const node of sources) { try { node.stop(); node.disconnect(); } catch (_) {} }
  sources.clear(); playbackGuards = []; ducked = false; replyGain(1); startedSegments.clear(); segmentTurns.clear(); segmentRates.clear(); scheduledUntil = 0;
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
  // Streaming partials can replace the current caption before either kind of
  // upload is accepted. Preserve the previous turn's user text for its archive.
  if (viewEnabled) uiCandidateSaid = $('said').textContent;
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
      notice(t('上传较慢，请稍后再说。')); if (vad) vad.reset(); } }
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
  else { clearAudio(); archiveGroup(); uiTurn = u.id; serverDebug = {}; activeTurn = u.id; busy = true;
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
  const boundary = meta.segment_id !== lastPCMSegment && sealedSegments.has(lastPCMSegment);
  if (boundary && scheduledUntil < context.currentTime) {
    // The previous segment is complete. A tool/model pause has no missing PCM;
    // resume at the render clock without adding the starvation buffer again.
    scheduledUntil = context.currentTime + .035;
    rebuffering = false;
  } else if (!rebuffering && scheduledUntil < context.currentTime) {
    rebuffering = true; clientStats.underruns++; recorder.add('underrun', {count: clientStats.underruns}); debugStats(true);
  }
  bufferPolicy?.receive(meta.segment_id, rebuffering);
  lastPCMSegment = meta.segment_id;
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
  const span = uiPlayback.get(meta.segment_id);
  uiPlayback.set(meta.segment_id, {epoch, ranges:[...(span?.ranges.filter(r => sources.has(r.node)) || []), {node, at, endAt, energy: playbackEnergy(output)}]});
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
  sources.add(node); node.start(at);
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
    sources.delete(node); node.disconnect(); edge.disconnect();
    if (epoch !== receipt.epoch) return;
    textSync?.tick(); bufferMetrics(!sources.size && !playbackQueue.length && !!bufferPolicy?.done);
    // A suspended context or interrupted source never earns unplayed samples.
    try {
      if (context.currentTime + .005 >= endAt) report(receipt.ended(meta.segment_id, meta.samples, epoch));
    } catch (error) {
      playbackFailure(error); pageFailure(3);
      notice(t('声音暂时无法继续。请结束对话，再重新开启麦克风。'), 'end', t('结束并重新准备'));
      if (ws) ws.close();
    }
    if (!sources.size && !busy) state('listening', t('继续说，或点结束对话'));
  };
}
const segmentRates = new Map();
function sttServiceError(frame) {
  return frame.code === 'stt_failed' && (frame.status >= 500 || [401,403,429].includes(frame.status));
}
function showError(frame) {
  if (frame.hint_code === 'client_outdated') {
    // Preserve the service's stale-page instruction and close without retry/PCM.
    $('error').textContent = t(frame.message); finish(false);
    notice(t(frame.message), 'outdated', t('查看打开方式'), 'client_outdated'); return;
  }
  const common = {preempted: t('主人开始了语音，本次对话已结束。'), quota_exceeded: t('今天的语音时长已用完，明天再聊。'),
    capacity: t('当前语音会话已满，请稍后重试。'), session_busy: t('已有一段语音对话，请先结束另一页。'),
    forbidden: t('请先添加好友，并请主人开启好友语音。'),
    previous_turn_busy_timeout: t('上一条回复仍在停止，本次语音未能提交。请稍后重新说一遍。'),
    tts_rate_limited: t('语音服务现在比较忙，请稍等几秒再说一次。'), stt_rate_limited: t('语音识别现在比较忙，请稍等几秒再说一次。'),
    stt_failed: t('这句话没听清，请靠近麦克风再说一次。'), stt_empty_or_too_long: t('这句话没听清，请靠近麦克风再说一次。'),
    plugin_first_delta_timeout: t('回复等待有点久，请重新说一次。'), plugin_error: t('回复暂时没能完成，请重新说一次。'),
    events_disconnected: t('回复暂时没能完成，请重新说一次。'),
    tts_failed: $('reply').textContent || textSync?.text ? t('回复的声音生成失败，文字已保留。请再说一次。') : t('回复的声音生成失败，请再说一次。'),
    session_limit: t('本次语音已到时长上限，可以再开一段。'),
    cancel_unconfirmed: t('播放已停止，服务暂未确认取消；请稍等再说。')};
  const fatal = ['capacity','quota_exceeded','preempted','session_busy'].includes(frame.code) || (frame.status === 403 && frame.code === 'forbidden');
  const text = sttServiceError(frame) ? t('语音识别暂时不可用，这句话未能识别，请稍后重新说一次。') : common[frame.code] || t('语音服务暂时不可用，请稍后重试。');
  if (fatal) finish(false);
  else { busy = false; activeTurn = null; clearAudio(); state('listening', t('请再说一次')); }
  const action = frame.code === 'quota_exceeded' ? 'dismiss' : fatal ? 'retry' : 'dismiss';
  const label = ({session_busy:t('我已结束，重新连接'), forbidden:t('我已确认，重试'), capacity:t('重试连接'), preempted:t('再次聊天'),
    previous_turn_busy_timeout:t('知道了'), cancel_unconfirmed:t('知道了'), quota_exceeded:t('知道了')})[frame.code] || t('继续说话');
  notice(text, action, label, fatal ? frame.code : '', sttServiceError(frame));
}

function message(event) {
  try {
    lastServerFrame = performance.now();
    if (event.data instanceof ArrayBuffer) {
      recorder.message('binary');
      if (VoiceDiagnostic.isPacket(event.data)) { diagnosticBinary(event.data); return; }
      countPCM(event.data);
      const meta = expectedAudio; expectedAudio = null;
      if (!meta) throw Error('unexpected_audio');
      playPCM(event.data, meta); return;
    }
    const f = JSON.parse(event.data);
    if (f.type === 'error' && f.code === 'session_busy' && running) {
      // Admission can outlive a socket. Keep the microphone and retry with bounds.
      const socket = ws;
      clearTimeout(connectionDeadline);
      socket.onclose = null; ws = null;
      releaseMedia(() => socket.close()); closeStream(); connected = false;
      retryConnection(t('旧连接正在释放，正在重连'));
      return;
    }
    recorder.message(f.type);
    if (diagnosticControl(f)) return;
    if (f.type === 'session') {
      retiredSession = null; selfBusyRetry = false;
      admittedSession = f.session_id;
      connected = true; $('connection').textContent = t('已连接');
      $('time').textContent = formatTime(f.elapsed_seconds);
      $('time').title = t('通话时长') + ' / ' + formatTime(f.session_limit_seconds);
      $('quota').textContent = f.daily_remaining_seconds === null ? t('主人会话') : t('今日剩余 ') + formatTime(f.daily_remaining_seconds);
      inputRate = f.input_sample_rate;
      isOwner = f.role === 'owner'; diagnosticAllowed = isOwner && f.diagnostic_enabled === true;
      $('diagnostic').hidden = !diagnosticAllowed; diagnosticButtons();
      if (f.state === 'started') {
        recorder.start(f.role === 'owner'); $('event-panel').hidden = f.role !== 'owner';
        downstreamTransport = f.downstream_transport || 'sse';
        if (downstreamTransport !== 'sse') { clearTimeout(connectionDeadline); reconnects = 0; }
        uploadMode = f.upload_mode || 'batch';
        if (diagnosticAllowed && transportPreference && transportPreference !== downstreamTransport) {
          send({type: 'downstream_transport', transport: transportPreference, diagnostic: 1});
          downstreamTransport = transportPreference;
        }
        $('downstream-setting').value = downstreamTransport;
        $('transport-status').textContent = downstreamTransport.toUpperCase();
        pauseSeconds = f.background_pause_seconds || 120;
      }
      prebufferMs = f.playback_prebuffer_ms ?? 350; playbackFadeMs = f.playback_fade_ms ?? 3;
      if (f.state === 'started') {
        if (downstreamTransport === 'sse' || diagnosticAllowed && downstreamTransport === 'ws') openStream(f.session_id);
        clearTimeout(startupFallbackTimer);
        if (micPrepare && isOwner && downstreamTransport === 'sse') {
          startupFallbackTimer = setTimeout(() => {
            if (micPrepare?.stage === 5 && connected && !streamReady) {
              send({type:'downstream_transport',transport:'ws',fallback:1});
            }
          },2500);
        }
        uploadDiagnosticSummaries();
        baseVadConfig = {...f.vad, max_utterance_seconds: f.max_utterance_seconds}; configureVAD(); sensitivityMetrics();
        micProgress(downstreamTransport === 'sse' && !streamReady ? 5 : 6);
        state('calibrating', t('先安静片刻，准备好后就可以说话'));
      }
    } else if (f.type === 'downstream_transport') {
      downstreamTransport = f.transport;
      $('transport-status').textContent = downstreamTransport.toUpperCase();
      if (f.transport === 'sse') openStream(streamSession);
      else if (micPrepare) {
        closeStream(); clearTimeout(connectionDeadline); reconnects=0;
        micProgress(6); dismissNotice();
        if (f.fallback === true) reportStartup(7);
      }
    } else if (f.type === 'error') {
      if (diagCurrent && (f.code.startsWith('diagnostic_') || f.code === 'forbidden')) { finishDiagnostic(null, 0, f.code); return; }
      if (f.client_turn_id && f.client_turn_id === pendingTurn) { pendingTurn = null; restoreCandidateView(); restoreReply();
        const text = sttServiceError(f) ? t('语音识别暂时不可用，这句话未能识别，请稍后重新说一次。') : ({previous_turn_busy_timeout:t('上一条回复仍在停止，本次语音未能提交。请稍后重新说一遍。'),cancel_unconfirmed:t('播放已停止，服务暂未确认取消；请稍等再说。'),plugin_first_delta_timeout:t('回复等待有点久，请重新说一次。'),plugin_error:t('回复暂时没能完成，请重新说一次。'),events_disconnected:t('回复暂时没能完成，请重新说一次。')})[f.code] || t('这句话没听清，请再说一次。');
        notice(text, 'dismiss', ['previous_turn_busy_timeout','cancel_unconfirmed'].includes(f.code) ? t('知道了') : t('继续说话'), '', sttServiceError(f)); }
      else if (!f.client_turn_id || f.client_turn_id === activeTurn) showError(f);
    } else if (f.type === 'info' && f.code === 'speech_ignored') {
      if (f.client_turn_id === pendingTurn) { pendingTurn = null; restoreCandidateView(); restoreReply(); }
      else if (f.client_turn_id === activeTurn) { activeTurn = null; busy = false; state('listening', t('没有听清有效语音，请再说一次')); notice(t('这句话没听清，请靠近麦克风再说一次。')); }
    }
    else if (f.type === 'session_end') {
      const hints = {idle: t('一段时间没有说话，已自动结束。'), ended: t('想聊时，再次开启麦克风。'), preempted: t('主人开始了语音，本次对话已结束。'), quota_exceeded: t('今日语音时长已用完。'), session_limit: t('本次语音已到时长上限。')};
      if (['disconnected','shutdown'].includes(f.reason) && running) {
        ws?.close(); return;
      }
      recordClose(1000, f.reason); finish(false); state('ended', hints[f.reason] || t('请重新开启麦克风'));
      if (['idle','session_limit'].includes(f.reason)) notice(f.reason === 'idle' ? t('空闲超时，点击绿色按钮重新拨打。') : t('会话已达上限，点击绿色按钮重新拨打。'), 'retry', t('重新拨打'));
      if (['quota_exceeded','preempted'].includes(f.reason)) notice(hints[f.reason], f.reason === 'quota_exceeded' ? 'dismiss' : 'retry', f.reason === 'quota_exceeded' ? t('知道了') : t('再次聊天'), f.reason);
    } else if (f.type === 'clear') {
      if (f.client_turn_id === pendingTurn) { pendingTurn = null; restoreCandidateView(); restoreReply(); }
      else if (f.client_turn_id === activeTurn) { clearAudio(); busy = false; activeTurn = null; state('listening', t('可以继续说话')); }
    } else if (f.type === 'transcript_partial' && f.client_turn_id &&
        (f.client_turn_id === liveUpload?.id || f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      // Captions never confirm a candidate, cancel playback or submit an agent turn.
      uiPartial = true; $('said').textContent = f.text; renderView();
      if (uiFollow && !$('settings-sheet').open) $('transcript').scrollTop = $('transcript').scrollHeight;
    } else if (f.type === 'transcript' && (f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      if (f.client_turn_id === pendingTurn) {
        clientStats.confirmed++; clearAudio(); archiveGroup(); uiTurn = pendingTurn; serverDebug = {}; activeTurn = pendingTurn; pendingTurn = null; busy = true;
        $('reply').textContent = ''; $('reply').classList.remove('empty'); debugStats(true);
      }
      uiPartial = false; $('said').textContent = f.text; renderView();
      if (uiFollow && !$('settings-sheet').open) $('transcript').scrollTop = $('transcript').scrollHeight;
    }
      else if (f.type === 'submit_wait' && f.client_turn_id === activeTurn) { uiSubmitWait = true; state('thinking', t('仍在停止上一条回复，请稍候。')); }
      else if (f.type === 'turn' && f.client_turn_id === activeTurn) { uiSubmitWait = false; syncReply(); state('thinking', t('正在准备回复')); }
    else if (f.type === 'turn_activity' && f.client_turn_id === activeTurn && ['waiting','responding'].includes(f.state)) {
      turnWaiting = f.state === 'waiting';
      if (turnWaiting && busy) state('thinking', t('正在查询，稍候继续回复'));
    }
    else if (f.type === 'subtitle' && f.client_turn_id === activeTurn) {
      if (!Voice.hasBody(f.text)) return;
      syncReply().subtitle(f.text, f.text_seq);
      renderView();
    }
    else if (f.type === 'segment_start' && f.client_turn_id === activeTurn) {
      if (!Voice.hasBody(f.text)) return;
      receipt.start(f.segment_id, f.text); segmentTurns.set(f.segment_id, f.client_turn_id); segmentRates.set(f.segment_id, f.sample_rate);
      syncReply().segment(f.segment_id, f.text);
    } else if (f.type === 'audio') expectedAudio = f; // Always consume its following binary, even after local cancellation.
    else if (f.type === 'segment_end' && f.client_turn_id === activeTurn) { sealedSegments.add(f.segment_id); report(receipt.seal(f.segment_id, f.samples)); flushPlayback(); }
    else if (f.type === 'tts_done' && f.client_turn_id === activeTurn) { if (bufferPolicy) bufferPolicy.finish(); else flushPlayback(true); textSync?.finish(); bufferMetrics(); }
    else if (f.type === 'turn_complete' && f.client_turn_id === activeTurn) { if (bufferPolicy) bufferPolicy.finish(); else flushPlayback(true); textSync?.finish(); bufferMetrics(true); phoneTurns.delete(f.client_turn_id); busy = false; state('listening', t('继续说，或点结束对话')); }
    else if (f.type === 'delivery_status' && f.chat_final_error) notice(t('声音已播放，但聊天记录写入未确认。请到聊天中查看。'));
    else if (f.type === 'debug' && (!f.client_turn_id || f.client_turn_id === activeTurn || f.client_turn_id === pendingTurn)) {
      serverDebug = {...serverDebug, ...(f.elapsed_ms || {}), ...(f.phone_timestamps_ms || {}), ...(f.metrics || {})}; debugStats();
    }
  } catch (error) {
    playbackFailure(error); pageFailure(3);
    debugStats(true);
    notice(t('语音数据中断，正在重新连接。'));
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
function retryConnection(text = t('连接中断，正在重连；这段录音不会重发')) {
  if (!running || paused) return;
  clearTimeout(reconnectTimer); clearTimeout(connectionDeadline);
  if (reconnects >= MAX_RECONNECTS) {
    finish(false); state('error', t('重连未成功，请重新拨打'));
    notice(t('重新连接未成功。检查网络后，点击绿色按钮重新拨打。'), 'retry', t('重新拨打'), 'connection_failed'); return;
  }
  state('connecting', text);
  notice(text, 'dismiss', t('知道了'));
  const delay = Math.pow(2, reconnects++) * 1000;
  if (micPrepare?.stage === 4 && text.startsWith(t('旧连接'))) {
    const attempt = micPrepare;
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(() => micTimeout(attempt), delay + 8500);
  }
  reconnectTimer = setTimeout(connect, delay);
}
function connect() {
  if (!running || paused) return;
  connected = false; state('connecting', reconnects ? t('正在重新连接') : t('正在建立语音连接'));
  if (reconnects) notice(t('连接中断，正在重连。'), 'dismiss', t('知道了'));
  const base = location.pathname.replace(/[^/]*$/, '');
  const canUseHttps = typeof globalThis.DshHttpVoiceSocket === 'function';
  const usingHttps = preferHttps && canUseHttps;
  ws = usingHttps ? new DshHttpVoiceSocket(base) : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws');
  const socket = ws;
  let opened = false;
  function switchToHttps() {
    if (usingHttps || !canUseHttps || opened || ws !== socket || !running || paused) return false;
    preferHttps = true;
    clearTimeout(socketUpgradeTimer); clearTimeout(connectionDeadline);
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    releaseMedia(()=>socket.close());
    if (micPrepare) armMicWatchdog(micPrepare);
    connect();
    return true;
  }
  clearTimeout(socketUpgradeTimer);
  if (!usingHttps && canUseHttps) socketUpgradeTimer = setTimeout(switchToHttps,2000);
  ws.binaryType = 'arraybuffer';
  clearTimeout(connectionDeadline);
  connectionDeadline = setTimeout(() => {
    if (ws !== socket || !running || (connected && (downstreamTransport !== 'sse' || streamReady))) return;
    socket.onclose = null; ws = null;
    connected = false;
    releaseMedia(() => socket.close()); closeStream();
    retryConnection(t('连接响应超时，正在重连'));
  }, 8000);
  ws.onopen = () => { opened = true; clearTimeout(socketUpgradeTimer); recorder.add('ws_open', {ready: socket.readyState}); if (ws === socket) socketSend(socket, JSON.stringify({type: 'start', build_id: BUILD_ID, protocol_version: PROTOCOL_VERSION,
      connection_id: connectionId, resume_session: admittedSession,
      capabilities: CAPABILITIES, downstream_transport: transportPreference || 'sse', diagnostic_ws: Number(transportPreference === 'ws')})); };
  ws.onmessage = event => { if (ws === socket) message(event); };
  ws.onerror = () => { if (switchToHttps()) return; recorder.add('ws_error', {ready: socket.readyState}); failureSnapshot(0, socket); recorder.upload(); if (ws === socket) notice(t('网络异常，请检查网络。')); };
  ws.onclose = event => {
    if (switchToHttps()) return;
    recorder.add('ws_close', {code: event?.code || 1006, reason: VoiceRecorder.reason(event?.reason),
      reason_length: event?.reason?.length || 0, clean: Number(!!event?.wasClean), ready: socket.readyState});
    failureSnapshot(event?.code || 1006, socket); recorder.upload();
    if (ws !== socket) return;
    clearTimeout(connectionDeadline);
    recordClose(event?.code || 1006, event?.reason || '');
    connected = false; diagnosticButtons();
    finishDiagnostic(null, event?.code || 1006, event?.reason || ''); closeStream();
    restoreCandidateView(); abortUpload(false); phoneTurns.clear();
    expectedAudio = null; pendingTurn = null;
    connected = false; busy = false; activeTurn = null; clearAudio(); if (vad) vad.reset(); $('connection').textContent = t('连接已断开');
    if (!running || paused) return;
    retryConnection();
  };
}
async function begin() {
  if (running || micPrepare || uiTerminal === 'client_outdated' || uiTerminal === 'quota_exceeded') return;
  startAttemptAt = performance.now(); startResult(0);
  selfBusyRetry = !!retiredSession;
  resetView();
  const attempt = micPrepare = {sequence: ++micPrepareSequence, stage: 1, started: performance.now()};
  attempt.cancelled = new Promise(resolve => { attempt.cancel = () => resolve(MIC_CANCELLED); });
  armMicWatchdog(attempt);
  queryMicPermission();
  controlStartedAt = performance.now();
  $('start').disabled = false; $('error').textContent = '';
  state('calibrating', t('正在开启麦克风，请保持页面在前台'));
  // A cancelled permission dialog can outlive its call; keep its successor
  // waiting under the permission budget while teardown owns the single flight.
  if (pendingMicRequests.size) startMicCapture(attempt);
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Error('unsupported');
    // Each context has its own clock. Never carry a suppression deadline across it.
    silenceUntil = 0; lastDebugAt = -1; lastSettings = '';
    context = new (window.AudioContext || window.webkitAudioContext)(); micProgress(1);
    startDiagnostic(2, VoiceRecorder.state(context.state));
    attempt.resuming = true;
    const resumed = prepareResult(attempt, diagnosticResume(context));
    const audioContext = context;
    const leaseStart = micTeardown ? micTeardown.then(() =>
      micPrepare === attempt ? prepareMicLease(attempt) : MIC_CANCELLED) : prepareMicLease(attempt);
    const leasePromise = prepareResult(attempt, leaseStart, release => { if (typeof release === 'function') release(); });
    leasePromise.catch(() => {});
    // Attach disposal immediately, including when resume/lease fails first.
    const capture = navigator.locks?.request ? leasePromise.then(lease =>
      lease === MIC_CANCELLED || micPrepare !== attempt ? MIC_CANCELLED : prepareMicrophone(attempt)) : prepareMicrophone(attempt);
    capture.catch(() => {});
    if (await resumed === MIC_CANCELLED || micPrepare !== attempt) return;
    attempt.resuming = false; micProgress(2);
    if (context.state !== 'running') throw Error('autoplay_blocked');
    recorder.add('context', {state: VoiceRecorder.state(context.state)});
    context.onstatechange = () => {
      recorder.add('context', {state: VoiceRecorder.state(audioContext.state)});
      if (context === audioContext) resumeAudio();
    };
    const lease = await leasePromise;
    if (lease === MIC_CANCELLED || micPrepare !== attempt) return;
    micLease = lease;
    const stream = await capture;
    if (stream === MIC_CANCELLED) return;
    if (micPrepare !== attempt) { stopTracks(stream); return; }
    attempt.promptPending = false;
    mic = stream;
    // Permission UI can suspend audio after the first resume. Never admit that graph.
    if (context.state !== 'running') {
      if (await prepareResult(attempt, diagnosticResume(context)) === MIC_CANCELLED) return;
      if (context.state !== 'running') throw Error('autoplay_blocked');
    }
    micProgress(3);
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
      if (userMicMuted || paused || !connected || !vad || pendingTurn || diagMatrix || (downstreamTransport === 'sse' && !streamReady) || context.currentTime < silenceUntil) return;
      const now = context.currentTime;
      playbackGuards = playbackGuards.filter(g => g.until > now);
      let suppressed = playbackGuards.some(g => now >= g.at && now < g.until);
      const calibrating = vad.calibratedMs < vad.config.calibration_ms;
      if (vadSettingsPending && !vad.recording && !vad.attack) configureVAD(true);
      if (settingsTurn !== activeTurn) {
        sensitivityMetrics(1); settingsTurn = activeTurn;
        turnInterrupts = {confirmed:0, ignored:0}; ignoredSpeech = false;
      }
      const playing = actualPlayback() !== null;
      const replyPending = busy || sources.size > 0 || playbackQueue.length > 0;
      const ignoreInput = !bargeInEnabled && replyPending;
      if (halfDuplexMuted && !replyPending) {
        // The start-of-playback guard must not consume the next utterance after
        // a short final segment. No assistant samples survived in the preroll.
        vad.reset(); playbackGuards = []; suppressed = false;
      }
      halfDuplexMuted = ignoreInput;
      const result = vad.push(e.inputBuffer.getChannelData(0), context.sampleRate, playing, suppressed || ignoreInput, turnWaiting, replyPending);
      micVisualLevel = Math.min(1, Math.max(0, (result.rms - result.noise_floor) / Math.max(.035, result.enter_threshold * 3)));
      micVisualAt = performance.now();
      if (viewEnabled) {
        $('mic-level').value = micVisualLevel;
        $('mic-level-state').textContent = result.rms >= result.enter_threshold ? t('已超过讲话阈值') : t('未超过讲话阈值');
      }
      if (ignoreInput) {
        // Never seed preroll, upload, duck or cancel from assistant playback.
        vad.reset();
        const high = !suppressed && result.rms >= result.enter_threshold;
        if (high && !ignoredSpeech) { turnInterrupts.ignored++; sensitivityMetrics(2); }
        ignoredSpeech = high; return;
      }
      ignoredSpeech = false;
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
        if (!turnWaiting) state('recording', t('停顿后会自动发送')); debugStats(true);
      }
      if (uploadMode === 'stream' && liveUpload) {
        for (const frame of result.capture) liveUpload?.queue.push(liveUpload.converter.push(frame));
      }
      if (result.confirmed && bargeInEnabled && playing) { turnInterrupts.confirmed++; sensitivityMetrics(3); clientStats.confirmed++; stopReply(); uiInterrupted = true; state('recording', t('停顿后会自动发送')); debugStats(true); }
      if (result.cancelled && !result.audio) { abortUpload(); restoreReply(); }
      if (result.ended) {
        uiInterrupted = false;
        phoneMark(captureStamps, 't_vad_end');
        if (result.audio) {
          if (uploadMode === 'stream') completeUpload(liveUpload, result.voice_ms);
          else upload(result.audio, context.sampleRate, result.voice_ms, captureStamps);
        }
        else { abortUpload(); if (ducked) restoreReply();
        else if (!busy) state('listening', t('请靠近麦克风说话')); }
      }
      if (vadSettingsPending && !vad.recording && !vad.attack) configureVAD(true);
      debugStats();
      } catch (_) { abortUpload(); vad?.reset(); pageFailure(6); state('error', t('录音处理异常，请重新开启麦克风')); notice(t('声音暂时无法继续。请结束对话，再重新开启麦克风。'), 'end', t('结束并重新准备')); }
    };
      // A prior local close may still be releasing its server admission slot.
      if (retiredSession) {
        await prepareResult(attempt, retiredSession);
        if (micPrepare !== attempt) return;
      }
      micProgress(4); connect();
    uploadTimer = setInterval(() => liveUpload?.queue.pump(), 20);
    healthTimer = setInterval(() => { if (running) {
      sampleTrack();
      if (!paused) {
        resumeAudio();
        if (connected && performance.now() - lastServerFrame > 45000) ws?.close();
        if (mic?.getAudioTracks?.()[0]?.readyState === 'ended') recoverMic();
      }
    } }, 1000);
    heartbeat = setInterval(() => send({type: 'ping', source: 'heartbeat'}), 15000);
  } catch (error) {
    if (micPrepare !== attempt) return; // A retired rejection cannot end a newer session.
    stopMicPrepare(4); pageFailure(8);
    finish(false); const micErrorText = (error.name === 'NotAllowedError' ? t('麦克风权限未开启，请在系统或站点设置中允许后重试。') : t('无法开启麦克风，请在支持录音的 ClawNest 页面重试。')) + (attempt.errorCode ? t('（诊断码 ') + attempt.errorCode + ' / ' + (attempt.retryCount || 0) + '）' : '');
    $('error').textContent = micErrorText;
    state('error', t('开启麦克风后才能对话'));
    if (error.message === 'session_busy') notice(t('已有一段语音对话，请先结束另一页。'), 'retry', t('我已结束，重新连接'), 'session_busy');
    else notice(micErrorText, 'retry', t('重试开启麦克风'), error.name === 'NotAllowedError' ? 'permission' : 'mic_failed');
  }
}
function finish(notify = true, controlSource = 'user_end') {
  sensitivityMetrics(1); settingsTurn = null; ignoredSpeech = halfDuplexMuted = false; turnInterrupts = {confirmed:0, ignored:0};
  if (viewEnabled) { $('mic-level').value = 0; $('mic-level-state').textContent = t('开始聊天后可查看音量'); }
  const provisionalStream = micPrepare?.stream;
  stopMicPrepare(3); micVisualLevel = 0; micRecovery = null; recoveringMic = false; resumingContext = null;
  abortUpload(); phoneTurns.clear(); clearInterval(uploadTimer);
  running = false; userMicMuted = false; mediaEpoch++; paused = false; clearTimeout(pauseTimer); clearInterval(healthTimer); clearTimeout(reconnectTimer); clearTimeout(connectionDeadline); clearTimeout(socketUpgradeTimer); clearInterval(heartbeat);
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
    if (socket.readyState !== 3) {
      const previousClose = socket.onclose;
      retiredSession = new Promise(resolve => {
        const timer = setTimeout(resolve, 500);
        socket.onclose = event => { clearTimeout(timer); previousClose?.(event); resolve(); };
      });
    }
    releaseMedia(() => socket.close());
  }
  expectedAudio = null;
  if (processor) { processor.onaudioprocess = null; releaseMedia(() => processor.disconnect()); processor = null; }
  if (source) { releaseMedia(() => source.disconnect()); source = null; }
  if (mute) { releaseMedia(() => mute.disconnect()); mute = null; }
  if (playbackGain) { releaseMedia(() => playbackGain.disconnect()); playbackGain = null; }
  stopTracks(provisionalStream); stopTracks(mic); mic = null; lastHangupAt = performance.now();
  const leaseReleased = micLease?.(); micLease = null;
  const waits = [...pendingMicRequests, ...pendingMicLeases];
  if (leaseReleased) waits.push(leaseReleased);
  if (micTeardown) waits.push(micTeardown);
  if (context) {
    const audioContext = context; context = null; audioContext.onstatechange = null;
    try { waits.push(Promise.resolve(audioContext.close())); } catch (_) {}
  }
  if (waits.length) {
    const teardown = micTeardown = Promise.allSettled(waits);
    teardown.then(() => { if (micTeardown === teardown) micTeardown = null; });
  }
  textSync?.dispose(); textSync = null; textSyncTurn = null;
  if (vad) vad.reset(); vad = null; segmentRates.clear();
  silenceUntil = 0; lastDebugAt = -1; lastSettings = ''; reconnects = 0; captureStamps = {}; baseVadConfig = {};
  turnReceived = {bytes: 0, frames: 0}; playbackError = 0;
  diagnosticButtons();
  $('start').disabled = false; startLabel(t('开始聊天')); $('connection').textContent = t('已结束');
  state('ended', t('想聊时，再次开启麦克风'));
  renderHistory(); renderView();
  return micTeardown || Promise.resolve();
}
// Keep begin synchronous up to context.resume(): the click must carry the user gesture.
$('start').onclick = () => {
  if (running || micPrepare) {
    if (performance.now() - controlStartedAt < CONTROL_GUARD_MS) return;
    finish(true);
  } else return begin();
};
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
    const stream = await requestMic({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1}},
      () => running && !paused && epoch === mediaEpoch && micRecovery === recovery);
    if (stream === MIC_CANCELLED) return;
    if (!running || paused || epoch !== mediaEpoch || micRecovery !== recovery) { stopTracks(stream); return; }
    source?.disconnect(); stopTracks(mic);
    mic = stream;
    mic.getAudioTracks().forEach(track => { track.enabled = !userMicMuted; });
    watchTrack(mic.getAudioTracks()[0]); sampleTrack();
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
  paused = false; clearTimeout(pauseTimer); mic?.getTracks().forEach(t => { t.enabled = !userMicMuted; });
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

// Numeric-only startup evidence. Permission -1=unavailable,0=prompt,1=granted,2=denied.
let micPermission = -1;
function startDiagnostic(type, state = 0, reason = 0, duration = 0, values = {}) {
  recorder.add('timing', {code:62, type, state, reason, duration:Math.max(0,duration), ...values});
}
function uaFamily() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua) && /; wv\)|Version\/4\.0.*Chrome/i.test(ua)) return 3;
  if (/(iPhone|iPad|iPod)/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) return 4;
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 1;
  return /Safari\//i.test(ua) ? 2 : 5;
}
function loadDiagnostics() {
  const activation = navigator.userActivation;
  const policy = document.permissionsPolicy || document.featurePolicy;
  const allowed = name => { try { return policy?.allowsFeature ? Number(policy.allowsFeature(name)) : -1; } catch (_) { return -1; } };
  let framed = -1; try { framed = Number(window.top !== window); } catch (_) { framed = 1; }
  startDiagnostic(0, uaFamily(), framed, 0, {
    rate:activation ? Number(activation.isActive) : -1, channels:activation ? Number(activation.hasBeenActive) : -1,
    hidden:Number(!!document.hidden), ready:({visible:0,hidden:1,prerender:2})[document.visibilityState] ?? -1,
    count:allowed('autoplay'), buffered:allowed('microphone')});
  queryMicPermission();
}
let permissionStatus = null, permissionListener = null, permissionQuerySequence = 0;
function queryMicPermission() {
  const sequence = ++permissionQuerySequence;
  const unknown = () => {
    if (sequence !== permissionQuerySequence) return;
    micPermission = -1; startDiagnostic(1, -1); updateMicPermission();
  };
  try {
    if (!navigator.permissions?.query) { unknown(); return; }
    Promise.resolve(navigator.permissions.query({name:'microphone'})).then(status => {
      if (sequence !== permissionQuerySequence) return;
      permissionStatus?.removeEventListener?.('change', permissionListener);
      const update = () => {
        micPermission = ({prompt:0,granted:1,denied:2})[status.state] ?? -1;
        startDiagnostic(1,micPermission); updateMicPermission();
      };
      permissionStatus = status; permissionListener = update;
      update(); status.addEventListener?.('change', update);
    }).catch(unknown);
  } catch (_) { unknown(); }
}

function diagnosticResume(audioContext) {
  const started = performance.now(); startDiagnostic(3,VoiceRecorder.state(audioContext.state),0);
  try {
    return Promise.resolve(audioContext.resume()).then(value => {
      startDiagnostic(3,VoiceRecorder.state(audioContext.state),1,performance.now()-started); return value;
    }, error => { startDiagnostic(3,VoiceRecorder.state(audioContext.state),2,performance.now()-started); throw error; });
  } catch (error) { startDiagnostic(3,VoiceRecorder.state(audioContext.state),2,performance.now()-started); throw error; }
}
// code60 retains the numeric startup outcome schema; type=2 is an explicit user start.
function startResult(result, reason = Number(result !== 0)) {
  recorder.add('timing', {code:60, type:2, state:result, reason,
    duration:Math.max(0, performance.now() - startAttemptAt)});
}

// Read-only sound envelope. Capture reuses VAD RMS; output uses 40 ms RMS
// bins from the existing PCM, sampled against the scheduled AudioContext clock.
let micVisualLevel = 0, micVisualAt = -Infinity, motionLevel = 0;
let motionFrame = 0, motionLast = 0, motionWindow = 0, motionElapsed = 0, motionFrames = 0;
let motionSimple = false, motionReduced = false, motionPaintAt = 0;
function playbackEnergy(output) {
  const pcm = output.getChannelData(0), step = Math.max(1, Math.round(output.sampleRate * .04));
  const energy = new Float32Array(Math.ceil(pcm.length / step));
  for (let i = 0; i < pcm.length; i += step) {
    let sum = 0; const end = Math.min(pcm.length, i + step);
    for (let j = i; j < end; j++) sum += pcm[j] * pcm[j];
    energy[Math.floor(i / step)] = Math.min(1, Math.sqrt(sum / (end - i)) * 5);
  }
  return energy;
}
function playbackVisualLevel() {
  if (!context || context.state !== 'running') return 0;
  const time = context.currentTime;
  for (const span of uiPlayback.values()) {
    if (span.epoch !== receipt.epoch) continue;
    for (const r of span.ranges) if (sources.has(r.node) && time >= r.at && time < r.endAt) {
      return r.energy?.[Math.min(r.energy.length - 1, Math.floor((time - r.at) / .04))] || 0;
    }
  }
  return 0;
}
function motionBudget(delta) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  motionWindow += delta; motionElapsed += delta; motionFrames++;
  if (motionWindow >= 2000) {
    if (motionElapsed / motionFrames > 24) {
      motionSimple = true; document.body.dataset.motion = motionReduced ? 'reduced' : 'simple';
    }
    motionWindow = motionElapsed = motionFrames = 0;
  }
}
function animateMotion(now) {
  motionFrame = 0;
  if (document.hidden) return;
  if (motionLast && !motionReduced) motionBudget(now - motionLast);
  const delta = motionLast ? Math.min(100, now - motionLast) : 16; motionLast = now;
  const name = document.body.dataset.uiState;
  const listening = ['listening','user_speaking','interrupted'].includes(name);
  const target = name === 'speaking' ? playbackVisualLevel() : listening && now - micVisualAt < 250 ? micVisualLevel : 0;
  motionLevel += (target - motionLevel) * (1 - Math.exp(-delta / (target > motionLevel ? 60 : 240)));
  if (now - motionPaintAt < (motionReduced ? 80 : motionSimple ? 33 : 0)) { motionFrame = requestAnimationFrame(animateMotion); return; }
  motionPaintAt = now;
  // Only local style writes; no geometry reads, transcript edits or audio nodes.
  const level = (.23 + motionLevel * .77).toFixed(2);
  const wave = $('call-wave');
  if (wave.style.getPropertyValue('--call-volume') !== level) wave.style.setProperty('--call-volume', level);
  motionFrame = requestAnimationFrame(animateMotion);
}
function syncMotion() {
  cancelAnimationFrame(motionFrame); motionFrame = 0; motionLast = 0;
  motionWindow = motionElapsed = motionFrames = 0;
  document.body.dataset.motion = motionReduced ? 'reduced' : motionSimple ? 'simple' : 'full';
  document.body.dataset.motionPaused = String(!!document.hidden);
  if (!document.hidden) motionFrame = requestAnimationFrame(animateMotion);
}
function setupMotion() {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  motionReduced = media.matches;
  media.addEventListener?.('change', e => {motionReduced = e.matches; syncMotion();});
  document.addEventListener('visibilitychange', syncMotion);
  window.addEventListener('pagehide', () => {cancelAnimationFrame(motionFrame); motionFrame = 0;});
  window.addEventListener('pageshow', syncMotion);
  syncMotion();
}

setupView();
if (viewEnabled) { loadDiagnostics(); setupMotion(); void loadAgentProfile(); }
