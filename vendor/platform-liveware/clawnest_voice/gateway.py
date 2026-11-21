"""Voice session orchestration. All state is owned by one asyncio event loop."""
import asyncio
import hashlib
import json
import logging
import math
import random
import time
from datetime import datetime, timezone
import unicodedata
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

from .quota import QuotaExceeded
from .upstream import VoiceError, request_context
from .downstream import PCMPacer
from .prosody import ProsodyBuffer, PCMContinuity, pause_samples

LOG = logging.getLogger('voice')
CLIENT_METRICS = frozenset(('noise_floor', 'enter_threshold', 'exit_threshold', 'vad_started',
    'ducked', 'confirmed', 'cancelled', 'underruns', 'sensitivity', 'mic_echoCancellation',
    'mic_noiseSuppression', 'mic_autoGainControl', 'ws_close_code', 'ws_close_reason', 'ws_close_reason_length', 'playback_error'))
CLOSE_REASONS = {'ended': 1, 'idle': 2, 'session_limit': 3, 'quota_exceeded': 4,
    'preempted': 5, 'disconnected': 6, 'shutdown': 7, 'reconnected': 8}


def audit(code, session='', turn='', **values):
    # Callers pass only IDs, numeric durations/timestamps, and enumerated error codes.
    LOG.info(json.dumps(dict(utc=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        code=code, session=session, turn=turn, **values), separators=(',', ':')))


from .spoken_text import has_body


class SentenceBuffer:
    def __init__(self, limit, minimum=1, first_minimum=None):
        self.text, self.limit = '', limit
        self.minimum = min(minimum, limit)
        self.first_minimum = min(first_minimum or minimum, limit)
        self.first = True
        self.pending_space = ''

    def feed(self, text, final=False):
        self.text += text
        parts = []
        while self.text:
            stop = next((i + 1 for i, c in enumerate(self.text[:self.limit])
                         if i + 1 >= (self.first_minimum if self.first else self.minimum) and c in '。！？!?；;\n，,'), None)
            if stop is None:
                stop = self.limit if len(self.text) >= self.limit else (len(self.text) if final else 0)
            if not stop:
                break
            part = self.text[:stop]
            if has_body(part):
                parts.append(self.pending_space + part)
                self.pending_space = ''
                self.first = False
            else:
                self.pending_space += part
            self.text = self.text[stop:]
        return parts


@dataclass
class Segment:
    id: str
    text: str
    samples: int = 0
    complete: bool = False
    played: bool = False


@dataclass
class Turn:
    client_id: str
    digest: str
    id: str = ''
    text: str = ''
    delivered: str = ''
    segments: list = field(default_factory=list)
    stamps: dict = field(default_factory=dict)
    task: object = None
    submit_task: object = None
    phone_stamps: dict = field(default_factory=dict)
    done: bool = False
    tts_done: bool = False
    stopped: bool = False
    finalized: bool = False
    ignored: bool = False
    queued_sentences: int = 0
    text_seq: int = 0
    receipt_lock: object = field(default_factory=asyncio.Lock)
    credit: object = field(default_factory=asyncio.Event)
    stt_stream: object = None


@dataclass
class PreparedSpeech:
    text: str
    index: int
    pcm: bytearray = field(default_factory=bytearray)
    changed: object = field(default_factory=asyncio.Event)
    complete: bool = False
    error: object = None
    winner: object = None
    worker: object = None
    hedge: object = None
    watchdog: object = None
    retrying: bool = False
    retried: bool = False  # any retry started: no hedge for the rest of this segment
    throttled: bool = False  # any attempt of this segment saw a 429
    initial_ready: bool = False


class Manager:
    def __init__(self, config, owner, stt, tts, plugin, quota, clock=time.time):
        self.config, self.owner, self.stt, self.tts = config, owner, stt, tts
        self.plugin, self.quota, self.clock = plugin, quota, clock
        self.sessions = OrderedDict()
        self.admission = asyncio.Lock()
        self.closing = set()

    async def open(self, user, emit, client=None, transport=None, connection_id=None, resume_session=None):
        async with self.admission:
            previous = next((s for s in self.sessions.values() if s.user == user), None)
            if previous:
                # The relay still authenticates the user. These IDs only bind a
                # reconnect to this page's prior admission; another tab cannot win.
                same_page = (connection_id and connection_id == previous.connection_id
                             and resume_session == previous.id)
                stale = (not previous.paused_until and
                         self.clock() - previous.last_client_frame >= self.config.connection_idle_seconds)
                if not same_page and not stale:
                    audit('session_busy', previous.id, status=409)
                    raise VoiceError('session_busy', 409)
                audit('session_reclaim', previous.id, reason='same_page' if same_page else 'heartbeat_expired')
                await previous.close('reconnected' if same_page else 'disconnected')
            owner = user == self.owner
            now = self.clock()
            if not owner and self.quota.remaining(user, now) <= 0:
                raise VoiceError('quota_exceeded', 429)
            if len(self.sessions) >= self.config.max_sessions:
                friends = [s for s in self.sessions.values() if not s.owner]
                if not owner or not friends:
                    raise VoiceError('capacity', 429)
                # Ordered insertion, newest friend first, matching the plugin contract.
                await friends[-1].close('preempted')
            session = Session(self, user, owner, emit)
            session.client = client or {}
            session.connection_id = connection_id
            if transport is not None:
                session.downstream_transport = transport
            self.sessions[session.id] = session
            try:
                session.meter(now)
                await session.status('started')
            except BaseException:
                self.sessions.pop(session.id, None)
                session.refund()
                raise
            audit('session_started', session.id, **session.client)
            return session

    async def sweep(self):
        for session in list(self.sessions.values()):
            now = self.clock()
            gap = now - session.last_client_frame
            if gap >= self.config.heartbeat_gap_seconds and now - session.last_watchdog >= self.config.heartbeat_log_interval:
                session.last_watchdog = now
                audit('heartbeat_gap', session.id, client_gap_seconds=round(gap, 3),
                    speech_idle_seconds=round(now - session.last_speech, 3))
            reason = None
            if session.upload and now - session.upload['started'] > self.config.max_utterance_seconds + 5:
                await session.abandon_upload()
                await session.error(VoiceError('upload_timeout', 408))
            if now - session.started >= session.limit:
                reason = 'session_limit'
            elif session.paused_until and now >= session.paused_until:
                reason = 'idle'
            elif not session.paused_until and session.idle_elapsed(now) >= self.config.idle_seconds:
                reason = 'idle'
            elif not session.paused_until and gap >= self.config.connection_idle_seconds:
                reason = 'disconnected'
            else:
                try:
                    session.meter(now)
                except QuotaExceeded:
                    reason = 'quota_exceeded'
            if reason:
                audit('idle_watchdog', session.id, reason=reason,
                    client_gap_seconds=round(gap, 3), speech_idle_seconds=round(now - session.last_speech, 3))
                await session.close(reason)
            elif now - session.last_status >= 1:
                await session.status('active')

    async def close(self):
        for session in list(self.sessions.values()):
            await session.close('shutdown')
        if self.closing:
            await asyncio.gather(*list(self.closing), return_exceptions=True)


class Session:
    def __init__(self, manager, user, owner, emit):
        self.manager, self.config, self.user, self.owner, self.emit = manager, manager.config, user, owner, emit
        self.id = 'vs_' + uuid.uuid4().hex
        self.started = self.last_speech = self.paid_until = manager.clock()
        self.last_reply_finished = 0
        self.last_status = 0
        self.paused_until = 0
        self.limit = self.config.owner_session_seconds if owner else self.config.friend_session_seconds
        self.closed = False
        self.connection_id = None
        self.downstream_transport = self.config.downstream_transport
        self.close_task = None
        self.turn = None
        self.history = OrderedDict()
        self.upload = None
        self.pending = None
        self.client_metrics = {}
        self.last_client_debug = float("-inf")
        self.last_client_frame = manager.clock()
        self.last_watchdog = float('-inf')
        self.control_counts = {}
        self.tts = manager.tts.open_tts_session() if hasattr(manager.tts, 'open_tts_session') else manager.tts
        # TTS pacing is per session (it mitigates, but cannot enforce, the account-wide provider limit):
        # one request start per interval, hedging paused while throttled.
        # clock/sleep/jitter are injectable so tests never wait.
        self.tts_clock, self.tts_sleep, self.tts_jitter = time.monotonic, asyncio.sleep, random.random
        self.tts_gate = asyncio.Lock()
        self.tts_last_start = float('-inf')
        self.tts_throttled_until = float('-inf')

    def client_frame(self):
        now = self.manager.clock()
        gap = now - self.last_client_frame
        self.last_client_frame = now
        return round(gap, 3)

    def refund(self):
        if not self.owner:
            now = self.manager.clock()
            if self.paid_until > now:
                self.manager.quota.refund(self.user, now, self.paid_until)
            self.paid_until = now

    def meter(self, now):
        if self.owner or now < self.paid_until:
            return
        end = min(now + self.config.meter_interval, self.started + self.limit)
        remaining = self.manager.quota.remaining(self.user, now)
        if remaining <= 1e-7:
            raise QuotaExceeded
        end = min(end, now + remaining)
        # Charge any delayed sweep gap as well (loop stalls do not give free time).
        self.manager.quota.reserve(self.user, self.paid_until, end)
        self.paid_until = end

    async def status(self, state):
        now = self.manager.clock()
        self.last_status = now
        unused_today = max(0, min(self.paid_until, (int(now // 86400) + 1) * 86400) - now)
        remaining = None if self.owner else self.manager.quota.remaining(self.user, now) + unused_today
        await self.emit({'type': 'session', 'state': state, 'session_id': self.id,
            'role': 'owner' if self.owner else 'friend_candidate',
            'elapsed_seconds': max(0, now - self.started), 'session_limit_seconds': self.limit,
            'daily_remaining_seconds': remaining, 'idle_remaining_seconds': max(0, self.config.idle_seconds - self.idle_elapsed(now)),
            'vad': self.config.vad, 'max_utterance_seconds': self.config.max_utterance_seconds,
            'input_sample_rate': self.config.input_sample_rate,
            'playback_prebuffer_ms': self.config.playback_prebuffer_ms,
            'playback_fade_ms': self.config.playback_fade_ms,
            'diagnostic_enabled': self.owner and self.config.diagnostic_enabled,
            'downstream_transport': self.downstream_transport,
            'upload_mode': self.config.upload_mode,
            'background_pause_seconds': self.config.background_pause_seconds})

    async def error(self, error, turn=None):
        await self.emit({'type': 'error', 'code': error.code, 'status': error.status,
            'message': error.message, 'client_turn_id': turn.client_id if turn else None})
        audit(error.code, self.id, turn.id if turn else '')

    def active(self, turn):
        return not self.closed and (self.turn is turn or self.pending is turn) and not turn.stopped

    def idle_elapsed(self, now):
        # An admitted turn has its own hard deadline, including playback receipts.
        # Ping/debug traffic still cannot renew idle, quota, or session limits.
        if any(t and not t.stopped and not t.finalized for t in (self.turn, self.pending)):
            return 0
        return now - max(self.last_speech, self.last_reply_finished)

    async def control(self, data, frame_gap=None):
        if self.closed:
            raise VoiceError('session_ended', 409)
        if not isinstance(data, dict):
            raise VoiceError('invalid_control', 400)
        kind = data.get('type')
        # Neither arbitrary type/source strings nor client text enter the audit.
        known = ('utterance_start', 'utterance_end', 'utterance_abort', 'cancel', 'barge_in', 'played',
            'audio_started', 'client_debug', 'end_session', 'ping', 'pause', 'resume')
        event = kind if kind in known else 'unknown'
        self.control_counts[event] = self.control_counts.get(event, 0) + 1
        claimed = data.get('source')
        claimed = claimed if claimed in ('audio_ended', 'vad_confirmed', 'heartbeat', 'user_end', 'pagehide', 'background', 'smoke') else 'unspecified'
        audit('control', self.id, self.turn.id if self.turn else '', control=event,
            source='client_json', count=self.control_counts[event],
            client_source=claimed, client_gap_seconds=self.client_frame() if frame_gap is None else frame_gap)
        if kind == 'pause':
            if not self.paused_until:
                self.paused_until = self.manager.clock() + self.config.background_pause_seconds
            await self.abandon_upload()
            await self.stop_turn('background')
            return
        if kind == 'resume':
            if self.paused_until:
                if self.manager.clock() >= self.paused_until:
                    await self.close('idle')
                    return
                self.paused_until = 0
                self.last_speech = self.manager.clock()
            return
        if self.paused_until and kind in ('utterance_start', 'utterance_end'):
            raise VoiceError('session_paused', 409)
        if kind == 'utterance_start':
            if self.upload is not None or self.pending is not None:
                raise VoiceError('upload_busy', 409)
            client_id = data.get('client_turn_id')
            if not isinstance(client_id, str) or not 1 <= len(client_id) <= 128 or not all(c.isalnum() or c in '-_' for c in client_id):
                raise VoiceError('invalid_client_turn_id', 400)
            if data.get('upload_mode', 'batch') not in ('stream', 'batch'):
                raise VoiceError('invalid_upload_mode', 400)
            encoding, rate = data.get('encoding', 'pcm_s16le'), data.get('sample_rate', self.config.input_sample_rate)
            if encoding not in ('pcm_s16le', 'webm_opus') or type(rate) is not int or rate != self.config.input_sample_rate:
                raise VoiceError('unsupported_audio', 400)
            if self.turn and not self.turn.finalized and not self.turn.stopped and client_id != self.turn.client_id and data.get('candidate') is not True:
                raise VoiceError('turn_busy', 409)
            self.upload = dict(id=client_id, encoding=encoding, rate=rate, audio=bytearray(), frames=0,
                started=self.manager.clock(), candidate=data.get('candidate') is True,
                mode=data.get('upload_mode', 'batch'))
            upload = self.upload
            if (self.config.stt_mode == 'stream' and upload['mode'] == 'stream'
                    and client_id not in self.history and hasattr(self.manager.stt, 'open_stream')):
                async def partial(text):
                    if self.closed:
                        return
                    streaming_turn = next((t for t in (self.turn, self.pending) if t and
                        t.client_id == client_id and self.active(t) and
                        t.stt_stream is upload.get('stream')), None)
                    if self.upload is upload or streaming_turn is not None:
                        await self.emit({'type': 'transcript_partial', 'client_turn_id': client_id, 'text': text})
                upload['stream'] = self.manager.stt.open_stream(encoding, rate, partial)
            self.last_speech = self.manager.clock()
        elif kind == 'utterance_abort':
            if self.upload and data.get('client_turn_id') == self.upload['id']:
                audit('upload_abandoned', self.id, bytes=len(self.upload['audio']), frames=self.upload['frames'])
                await self.abandon_upload()
        elif kind == 'utterance_end':
            upload = self.upload
            if not upload or data.get('client_turn_id') != upload['id']:
                raise VoiceError('invalid_utterance', 400)
            self.upload = None
            handed_off = False
            try:
                if self.manager.clock() - upload['started'] > self.config.max_utterance_seconds + 5:
                    raise VoiceError('audio_too_large', 413)
                audio = bytes(upload['audio'])
                upload['audio'].clear()
                voiced = data.get('voiced_ms')
                voiced = voiced if type(voiced) in (int, float) and math.isfinite(voiced) and 0 <= voiced <= self.config.max_utterance_seconds * 1000 else None
                audit('upload', self.id, client_turn_id=upload['id'], bytes=len(audio), frames=upload['frames'],
                    upload_ms=round((self.manager.clock() - upload['started']) * 1000, 3), upload_mode=upload['mode'],
                    audio_ms=round(len(audio) * 1000 / (2 * upload['rate']), 3) if upload['encoding'] == 'pcm_s16le' else None,
                    voiced_ms=voiced, voiced_source='client_vad' if voiced is not None else 'unavailable')
                if upload['mode'] == 'stream' and (voiced is None or voiced < self.config.vad['min_speech_ms'] or data.get('accepted') is not True):
                    await self.emit({'type': 'info', 'code': 'speech_ignored', 'client_turn_id': upload['id']})
                    return
                if not audio or (upload['encoding'] == 'pcm_s16le' and
                    (len(audio) % 2 or len(audio) / (2 * upload['rate']) > self.config.max_utterance_seconds)):
                    raise VoiceError('invalid_audio', 400)
                self.last_speech = self.manager.clock()
                digest = hashlib.sha256(audio + upload['encoding'].encode()).hexdigest()
                old = self.history.get(upload['id'])
                if old:
                    if old.digest != digest:
                        raise VoiceError('idempotency_conflict', 409)
                    if old.ignored:
                        await self.emit({'type': 'info', 'code': 'speech_ignored', 'client_turn_id': old.client_id, 'reused': True})
                        return
                    await self.emit({'type': 'turn', 'client_turn_id': old.client_id, 'turn_id': old.id,
                        'reused': True, 'state': 'finished' if old.finalized or old.stopped else 'running'})
                    return
                if len(self.history) >= 128:
                    # Never evict an idempotency record within a session.
                    raise VoiceError('turn_history_full', 429)
                turn = Turn(upload['id'], digest, stamps={'utterance_end': self.manager.clock() * 1000})
                turn.stt_stream = upload.get('stream')
                turn.phone_stamps = self.phone_stamps(data)
                if upload['candidate'] and self.turn and not self.turn.stopped and not self.turn.finalized:
                    self.pending = turn
                else:
                    self.turn = turn
                self.history[turn.client_id] = turn
                turn.task = asyncio.create_task(self.run(turn, audio, upload['encoding'], upload['rate']))
                handed_off = True
            finally:
                if not handed_off and upload.get('stream'):
                    await upload['stream'].close()
        elif kind in ('cancel', 'barge_in'):
            if kind == 'barge_in' and data.get('source') == 'vad_confirmed' and (
                    not self.turn or 'first_audio_played' not in self.turn.stamps):
                # Before playback a candidate may still be noise. Its final
                # transcription decides whether to replace the current turn.
                return
            if self.upload and not (kind == 'barge_in' and data.get('preserve_upload') == self.upload['id']):
                audit('upload_abandoned', self.id, bytes=len(self.upload['audio']), frames=self.upload['frames'])
            # Confirmed barge-in cancels output while retaining its live upload.
            if kind != 'barge_in' or not self.upload or data.get('preserve_upload') != self.upload['id']:
                await self.abandon_upload()
            self.last_speech = self.manager.clock()
            await self.stop_turn('cancelled')
        elif kind == 'played':
            try:
                await self.played(data)
            except VoiceError:
                await self.stop_turn('delivery_failed')
                raise
        elif kind == 'audio_started':
            turn = self.turn
            if turn and self.active(turn) and data.get('client_turn_id') == turn.client_id and any(s.id == data.get('segment_id') and s.samples for s in turn.segments):
                if 'first_audio_played' not in turn.stamps:
                    turn.stamps['first_audio_played'] = self.manager.clock() * 1000
                    for key, value in self.phone_stamps(data).items():
                        turn.phone_stamps.setdefault(key, value)
                    await self.debug(turn)
        elif kind == 'client_debug':
            metrics = data.get('metrics')
            if isinstance(metrics, dict):
                self.client_metrics.update({k: v for k, v in metrics.items() if k in CLIENT_METRICS and
                    type(v) in (int, float) and -1 <= v <= 1e9 and math.isfinite(v)})
                now = self.manager.clock()
                if now - self.last_client_debug >= 1:
                    self.last_client_debug = now
                    await self.emit({'type': 'debug', 'metrics': dict(self.client_metrics)})
                    audit('client_debug', self.id, **self.client_metrics)
        elif kind == 'end_session':
            await self.close('ended')
        elif kind == 'ping':
            await self.emit({'type': 'pong'})
        else:
            raise VoiceError('invalid_control', 400)

    async def abandon_upload(self):
        upload, self.upload = self.upload, None
        if upload and upload.get('stream'):
            await upload['stream'].close()

    async def binary(self, data, frames=1):
        self.client_frame()
        if self.closed or self.upload is None:
            raise VoiceError('unexpected_audio', 400)
        cap = self.config.max_audio_bytes
        if self.upload['encoding'] == 'pcm_s16le':
            cap = min(cap, int(self.config.max_utterance_seconds * self.upload['rate'] * 2))
        if len(data) + len(self.upload['audio']) > cap or self.manager.clock() - self.upload['started'] > self.config.max_utterance_seconds + 5:
            audit('upload_rejected', self.id, bytes=len(self.upload['audio']) + len(data),
                frames=self.upload['frames'] + frames, reason='audio_too_large')
            await self.abandon_upload()
            raise VoiceError('audio_too_large', 413)
        self.upload['audio'].extend(data)
        self.upload['frames'] += frames
        if self.upload.get('stream'):
            self.upload['stream'].feed(data)

    @staticmethod
    def phone_stamps(data):
        return {k: v for k, v in (data.get('phone_timestamps_ms') if isinstance(data.get('phone_timestamps_ms'), dict) else {}).items()
                if k in ('t_vad_start', 't_vad_end', 't_last_frame_sent', 't_first_audio_played')
                and type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1e12}

    async def debug(self, turn):
        stamps = dict(turn.stamps)
        origin = stamps['utterance_end']
        durations = {}
        if 'submit_wait_finished' in stamps:
            durations['plugin_submit_wait'] = round(stamps['submit_wait_finished'] - stamps['submit_wait_started'], 3)
        await self.emit({'type': 'debug', 'client_turn_id': turn.client_id,
            'timestamps_ms': stamps, 'elapsed_ms': {k: round(v - origin, 3) for k, v in stamps.items()},
            'durations_ms': durations, 'phone_timestamps_ms': turn.phone_stamps, 'metrics': dict(self.client_metrics)})
        audit('latency', self.id, turn.id, **{k: round(v - origin, 3) for k, v in stamps.items()},
            **durations, **self.client_metrics)

    async def submit(self, turn, text):
        # Shield each HTTP attempt only: accepted responses must remain recoverable
        # by cancel_remote, but cancellation must never leave a retry loop running.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.plugin_submit_retry_seconds
        delay, notice = .15, None
        attempts = 0

        async def stopping_notice():
            await asyncio.sleep(1.5)
            if self.active(turn):
                await self.emit({'type': 'submit_wait', 'client_turn_id': turn.client_id,
                    'state': 'stopping_previous_reply', 'message': '仍在停止上一条回复，请稍候。'})

        def exhausted():
            return VoiceError('previous_turn_busy_timeout', 409,
                '上一条回复仍在停止，本次语音未能提交。请稍后重新说一遍。')

        try:
            while self.active(turn):
                if notice is not None and loop.time() >= deadline:
                    raise exhausted()
                attempts += 1
                attempt_started = loop.time()
                turn.submit_task = asyncio.create_task(self.manager.plugin.submit(self.user, text, turn.client_id, self.id))
                try:
                    if notice is None:
                        result = await asyncio.shield(turn.submit_task)
                    else:
                    # Bound retry response waits too, retaining the HTTP task for
                    # accepted-turn recovery if the cap expires mid-request.
                        result = await asyncio.wait_for(asyncio.shield(turn.submit_task), deadline - loop.time())
                    audit('plugin_submit', self.id, result['turn_id'], status='accepted', attempt=attempts,
                        retries=attempts - 1, duration_ms=round((loop.time() - attempt_started) * 1000, 3))
                    return result
                except TimeoutError:
                    audit('plugin_submit', self.id, status='timeout', attempt=attempts, retries=attempts - 1)
                    raise exhausted() from None
                except VoiceError as exc:
                    audit('plugin_submit', self.id, status=exc.status, error=exc.code, attempt=attempts,
                        retries=attempts - 1, duration_ms=round((loop.time() - attempt_started) * 1000, 3))
                    if exc.status != 409 or exc.code != 'session_busy':
                        raise
                    # A definite rejection created no remote turn. During backoff
                    # there is consequently no submit task to recover or cancel.
                    turn.submit_task = None
                    if notice is None:
                        turn.stamps['submit_wait_started'] = self.manager.clock() * 1000
                        notice = asyncio.create_task(stopping_notice())
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise exhausted()
                    await asyncio.sleep(min(delay * random.uniform(.8, 1.2), remaining))
                    delay = min(delay * 1.6, 1)
            raise asyncio.CancelledError
        finally:
            if notice is not None:
                notice.cancel()
                await asyncio.gather(notice, return_exceptions=True)
                turn.stamps['submit_wait_finished'] = self.manager.clock() * 1000

    async def run(self, turn, audio, encoding, rate):
        context_token = request_context.set(dict(session=self.id, client_turn_id=turn.client_id))
        producer = consumer = None
        try:
            async with asyncio.timeout(self.config.turn_timeout):
                text = (await turn.stt_stream.finish(audio, encoding, rate) if turn.stt_stream
                        else await self.manager.stt.transcribe(audio, encoding, rate))
                audio = None
                turn.stamps['stt_done'] = self.manager.clock() * 1000
                normalized = ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())
                remainder = normalized
                for filler in sorted(self.config.stt_fillers, key=len, reverse=True):
                    token = ''.join(c for c in unicodedata.normalize('NFKC', filler).casefold() if c.isalnum())
                    if token:
                        remainder = remainder.replace(token, '')
                if len(normalized) < self.config.stt_min_chars or not remainder:
                    turn.ignored = turn.finalized = True
                    if self.pending is turn:
                        self.pending = None
                    await self.emit({'type': 'info', 'code': 'speech_ignored', 'client_turn_id': turn.client_id})
                    audit('speech_ignored', self.id, chars=len(normalized))
                    return
                if self.pending is turn:
                    # STT validation precedes any cancellation of the currently playing reply.
                    await self._stop_turn(self.turn, 'barge_in')
                    if not self.active(turn):
                        return
                    self.pending = None
                    self.turn = turn
                await self.emit({'type': 'transcript', 'client_turn_id': turn.client_id, 'text': text})
                result = await self.submit(turn, text)
                turn.id = result['turn_id']
                turn.stamps['turn_submitted'] = self.manager.clock() * 1000
                await self.emit({'type': 'turn', 'client_turn_id': turn.client_id, 'turn_id': turn.id, 'reused': result.get('reused', False)})
                # Text ingestion must never wait for audio credit. Each queued
                # sentence contains at least one body character, so max_text_chars
                # bounds this RAM-only queue (plus the terminal sentinel).
                # PCM storage, TTS requests and playback credit keep their limits.
                queue = asyncio.Queue(self.config.max_text_chars + 1)
                producer = asyncio.create_task(self.produce(turn, queue))
                consumer = asyncio.create_task(self.synthesize(turn, queue))
                try:
                    await asyncio.gather(producer, consumer)
                except Exception as exc:
                    if (not producer.done() and consumer.done() and
                            not consumer.cancelled() and consumer.exception() is exc):
                        # Failed synthesis must not discard still-streaming prose.
                        # The consumer has cleaned up its TTS workers. Existing
                        # queued audio/played receipts remain authoritative while
                        # text drains within the same bounded turn deadline.
                        await producer
                    raise
                turn.tts_done = True
                await self.emit({'type': 'tts_done', 'client_turn_id': turn.client_id})
                await self.finish_if_played(turn)
                # Keep a bounded playback deadline after generation, matching plugin's 120s.
                while self.active(turn) and not turn.finalized:
                    turn.credit.clear()
                    await turn.credit.wait()
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            await self.fail(turn, VoiceError('turn_timeout', 504))
        except VoiceError as exc:
            await self.fail(turn, exc)
        except Exception as exc:
            audit('turn_exception', self.id, turn.id, exception=type(exc).__name__)
            await self.fail(turn, VoiceError('gateway_error', 502))
        finally:
            if turn.stt_stream:
                await turn.stt_stream.close()
                turn.stt_stream = None
            audio = None
            # gather may already have cancelled its children. A second cancel
            # would interrupt a consumer joining its prefetched stream cleanup.
            for task in (producer, consumer):
                if task and not task.done() and not task.cancelling():
                    task.cancel()
            await asyncio.gather(*(t for t in (producer, consumer) if t), return_exceptions=True)
            # Also recover an accepted submit whose response arrived during barge-in.
            if turn.stopped:
                await self.cancel_remote(turn)
            try:
                await self.debug(turn)
            except (OSError, VoiceError, TimeoutError, RuntimeError):
                pass
            finally:
                request_context.reset(context_token)

    async def produce(self, turn, queue):
        splitter = (SentenceBuffer(self.config.sentence_chars, self.config.sentence_min_chars,
                    min(self.config.sentence_min_chars, self.config.sentence_first_min_chars))
                    if self.config.prosody_strategy == 'legacy' else
                    ProsodyBuffer(self.config.sentence_chars, self.config.sentence_min_chars,
                        self.config.sentence_first_min_chars, self.config.prosody_later_chars))
        boundary_timer = None
        def flush_boundary():
            if self.active(turn) and not turn.done:
                for sentence in splitter.feed('', final=True):
                    audit('sentence_ready', self.id, turn.id, segment=turn.queued_sentences, chars=len(sentence))
                    turn.queued_sentences += 1
                    queue.put_nowait(sentence)
        events = self.manager.plugin.events(turn.id).__aiter__()
        deadline = asyncio.get_running_loop().time() + self.config.plugin_first_delta_seconds
        try:
            while True:
                try:
                    if 'first_delta' not in turn.stamps and 'host_activity' not in turn.stamps:
                        async with asyncio.timeout_at(deadline):
                            kind, data = await anext(events)
                    else:
                        kind, data = await anext(events)
                except StopAsyncIteration:
                    break
                except TimeoutError:
                    raise VoiceError('plugin_first_delta_timeout', 504) from None
                if not self.active(turn):
                    return
                if boundary_timer:
                    boundary_timer.cancel()
                await self.consume_event(turn, queue, splitter, kind, data)
                if isinstance(splitter, ProsodyBuffer) and splitter.can_flush():
                    # One-token lookahead preserves closing quotes/ellipsis, with
                    # a 150ms cap when a completed first phrase stalls the model.
                    boundary_timer = asyncio.get_running_loop().call_later(.15, flush_boundary)
                if turn.done:
                    return
        finally:
            if boundary_timer:
                boundary_timer.cancel()
            await events.aclose()
        raise VoiceError('events_disconnected')

    async def consume_event(self, turn, queue, splitter, kind, data):
        # Text is emitted before sentence/TTS work, independently of playback.

        if not self.active(turn):
            return
        if kind == 'delta':
            text = data.get('text')
            if text is None or isinstance(text, str) and not has_body(text):
                return
            if not isinstance(text, str) or len(turn.text) + len(text) > self.config.max_text_chars:
                raise VoiceError('invalid_delta')
            if text:
                audit('plugin_delta', self.id, turn.id, chars=len(text), total_chars=len(turn.text) + len(text),
                    accepted_ms=round(self.manager.clock() * 1000 - turn.stamps['turn_submitted'], 3))
                if 'first_delta' not in turn.stamps:
                    turn.stamps['first_delta'] = self.manager.clock() * 1000
                    audit('plugin_progress', self.id, turn.id, phase='first_delta',
                        accepted_ms=round(turn.stamps['first_delta'] - turn.stamps['turn_submitted'], 3))
                turn.text += text
                turn.text_seq += 1
                await self.emit({'type': 'subtitle', 'client_turn_id': turn.client_id,
                    'turn_id': turn.id, 'text_seq': turn.text_seq,
                    'segment_index': turn.queued_sentences, 'text': text})
                audit('text_sent', self.id, turn.id, text_seq=turn.text_seq,
                    chars=len(text), accepted_ms=round(self.manager.clock() * 1000 - turn.stamps['turn_submitted'], 3))
                for sentence in splitter.feed(text):
                    audit('sentence_ready', self.id, turn.id, segment=turn.queued_sentences, chars=len(sentence))
                    turn.queued_sentences += 1
                    await queue.put(sentence)
        elif kind == 'activity' and data.get('state') in ('waiting', 'responding'):
            # Native pre-tool display flush is an iteration boundary, not EOF.
            # Release short commentary now; keep queue/TTS/turn alive for its tail.
            state = data['state']
            turn.stamps.setdefault('host_activity', self.manager.clock() * 1000)
            audit('turn_activity', self.id, turn.id, state=state)
            if state == 'waiting':
                for sentence in splitter.feed('', final=True):
                    audit('sentence_ready', self.id, turn.id, segment=turn.queued_sentences, chars=len(sentence))
                    turn.queued_sentences += 1
                    await queue.put(sentence)
            await self.emit({'type': 'turn_activity', 'client_turn_id': turn.client_id, 'state': state})
        elif kind == 'done':
            if data.get('text') != turn.text:
                raise VoiceError('text_mismatch')
            turn.done = True
            audit('plugin_progress', self.id, turn.id, phase='done',
                accepted_ms=round(self.manager.clock() * 1000 - turn.stamps['turn_submitted'], 3))
            for sentence in splitter.feed('', final=True):
                audit('sentence_ready', self.id, turn.id, segment=turn.queued_sentences, chars=len(sentence), final=True)
                turn.queued_sentences += 1
                await queue.put(sentence)
            await self.emit({'type': 'generation_done', 'client_turn_id': turn.client_id})
            await queue.put(None)
            return
        elif kind in ('interrupted', 'error'):
            reason = data.get('reason') if kind == 'interrupted' else 'plugin_error'
            if reason not in ('preempted', 'cancelled', 'disconnected', 'timeout', 'shutdown', 'host_cancelled'):
                reason = 'plugin_error'
            raise VoiceError(reason, 409 if kind == 'interrupted' else 502)

    async def pace_tts_start(self):
        """Hold each TTS request start at least tts_min_start_interval_ms after the previous one."""
        interval = self.config.tts_min_start_interval_ms / 1000
        async with self.tts_gate:  # FIFO: starts leave in admission order
            wait = self.tts_last_start + interval - self.tts_clock()
            if wait > 0:
                await self.tts_sleep(wait)
            self.tts_last_start = self.tts_clock()

    async def wait_stall(self, event):
        """Wait for progress; TimeoutError after tts_stall_seconds without it (injectable clock)."""
        waiter = asyncio.create_task(event.wait())
        timer = asyncio.create_task(self.tts_sleep(self.config.tts_stall_seconds))
        try:
            done, _ = await asyncio.wait({waiter, timer}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (waiter, timer):
                if not task.done():
                    task.cancel()
            await asyncio.gather(waiter, timer, return_exceptions=True)
        if waiter not in done:
            raise TimeoutError

    async def speech_with_retry(self, turn, state, attempt):
        """Retry a throttled/transient request for this segment, only before its first audio byte."""
        config, now, tries = self.config, self.tts_clock, 0
        began = now()  # one clock for the whole budget; it includes request durations
        while True:
            tries += 1
            if tries > 1:
                await self.pace_tts_start()
                # The retried request really starts now: re-arm the consumer's stall timer here,
                # so pace-gate time is not charged against the new request.
                state.changed.set()
            inner, audio, failure = self.tts.speech(state.text), False, None
            try:
                async for chunk in inner:
                    audio = audio or bool(chunk)
                    yield chunk
                return
            except VoiceError as exc:
                if exc.status == 429:
                    state.throttled = True
                    self.tts_throttled_until = now() + config.tts_throttle_hedge_pause_seconds
                if audio or not self.active(turn):
                    raise  # never replay after audio; a stopped turn just stops
                if attempt != 0:
                    # Hedges do not retry, but their throttle must surface consistently.
                    if exc.status == 429:
                        raise VoiceError('tts_rate_limited', 429) from None
                    raise
                if not exc.retryable:
                    raise
                # Each wait is at most half of tts_stall_seconds, and the wait and the retried
                # request's start both signal progress, so the stall timer cannot fire on a
                # legitimate retry; a request that really hangs is still reported as tts_stalled.
                half = max(.1, config.tts_stall_seconds / 2)
                wait = min(min(exc.retry_after if exc.retry_after is not None else 1.0,
                               config.tts_retry_after_cap_seconds) +
                           self.tts_jitter() * .25 * 2 ** (tries - 1), half)
                if tries >= config.tts_retry_attempts or now() - began + wait > config.tts_retry_total_seconds:
                    audit('tts_request', self.id, turn.id, segment=state.index, phase='retry_exhausted',
                          tries=tries, status=exc.status)
                    if state.throttled:
                        raise VoiceError('tts_rate_limited', 429) from None
                    raise
                failure = exc
            finally:
                close = getattr(inner, 'aclose', None)
                if close:
                    await close()
            audit('tts_request', self.id, turn.id, segment=state.index, phase='retry', tries=tries,
                  status=failure.status, wait_ms=round(wait * 1000, 3))
            state.retried = state.retrying = True
            state.changed.set()
            try:
                await self.tts_sleep(wait)
            finally:
                state.retrying = False

    async def prepare_speech(self, turn, state, slots, attempt=0, hedge_slot=None):
        """Bound requests independently of stored audio; expose each PCM frame."""
        started = previous = time.monotonic()
        chunks = total = 0
        max_gap = 0
        stream = None
        initial_release = None
        processor = PCMContinuity(self.config.tts_sample_rate, self.config) if self.config.prosody_smoothing else None
        await slots.acquire()
        try:
            await self.pace_tts_start()
            started = previous = time.monotonic()
            audit('tts_request', self.id, turn.id, segment=state.index,
                  chars=len(state.text), phase='start', attempt=attempt)
            if attempt == 0 and self.config.tts_mode != 'ws':
                async def watch():
                    await self.tts_sleep(self.config.tts_straggler_seconds)
                    # No extra request while this session is throttled, or once this segment retried.
                    suppressed = False
                    while (self.active(turn) and state.winner is None and state.error is None and
                           (state.retried or self.tts_clock() < self.tts_throttled_until)):
                        if not suppressed:
                            audit('tts_straggler', self.id, turn.id, segment=state.index, policy='hedge_suppressed')
                            suppressed = True
                        await self.tts_sleep(max(self.tts_throttled_until - self.tts_clock(), .25))
                    if self.active(turn) and state.winner is None and state.error is None:
                        audit('tts_straggler', self.id, turn.id, segment=state.index, policy='prefetch_hedge')
                        state.hedge = asyncio.create_task(self.prepare_speech(turn, state, hedge_slot, 1))
                state.watchdog = asyncio.create_task(watch())
            stream = self.speech_with_retry(turn, state, attempt)
            async for chunk in stream:
                if not self.active(turn):
                    raise asyncio.CancelledError
                if state.winner is not None and state.winner != attempt:
                    return
                if not chunk:
                    continue
                now = time.monotonic()
                max_gap = max(max_gap, now - previous); previous = now
                if not chunks:
                    state.winner = attempt
                    other = state.worker if attempt == 1 else state.hedge
                    if other and not other.done() and not other.cancelling():
                        other.cancel()
                    if state.watchdog and not state.watchdog.done():
                        state.watchdog.cancel()
                    turn.stamps.setdefault('first_tts_audio', self.manager.clock() * 1000)
                    audit('tts_request', self.id, turn.id, segment=state.index,
                          phase='first_byte', attempt=attempt,
                          duration_ms=round((now - started) * 1000, 3))
                    if processor:
                        async def release_initial():
                            # A slow second provider frame cannot hold first speech
                            # indefinitely just to estimate a normalizing gain.
                            await asyncio.sleep(.2)
                            state.pcm.extend(processor.release_initial())
                            state.initial_ready = True
                            state.changed.set()
                        initial_release = asyncio.create_task(release_initial())
                if total + len(chunk) > self.config.max_segment_seconds * self.config.tts_sample_rate * 2:
                    raise VoiceError('tts_too_large')
                state.pcm.extend(processor.feed(chunk) if processor else chunk); chunks += 1; total += len(chunk)
                state.changed.set()
            if state.winner is not None and state.winner != attempt:
                return
            if not total or total % 2:
                raise VoiceError('tts_invalid_pcm')
            if processor:
                if initial_release:
                    initial_release.cancel()
                    await asyncio.gather(initial_release, return_exceptions=True)
                state.pcm.extend(processor.finish())
                remaining = max(0, int(self.config.max_segment_seconds * self.config.tts_sample_rate * 2) - len(state.pcm)) // 2
                state.pcm.extend(b'\0\0' * min(remaining, pause_samples(state.text, self.config.tts_sample_rate, self.config)))
                audit('prosody_edges', self.id, turn.id, segment=state.index,
                      trimmed_head_samples=processor.trimmed_head, trimmed_tail_samples=processor.trimmed_tail,
                      gain=round(processor.gain or 1, 4))
            state.complete = True
            elapsed = time.monotonic() - started
            audit('tts_request', self.id, turn.id, segment=state.index, phase='complete',
                  attempt=attempt, bytes=total, chunks=chunks, duration_ms=round(elapsed * 1000, 3),
                  x_realtime=round(total / (2 * self.config.tts_sample_rate) / max(elapsed, .000001), 4),
                  max_gap_ms=round(max_gap * 1000, 3))
        except asyncio.CancelledError:
            audit('tts_request', self.id, turn.id, segment=state.index, phase='cancelled', attempt=attempt, bytes=total)
            raise
        except Exception as exc:
            # A failed hedge must not discard a still viable original request.
            if state.winner == attempt or (attempt == 0 and state.hedge is None):
                state.error = exc
            elif ((attempt == 0 and state.hedge and state.hedge.done()) or
                  (attempt == 1 and state.worker.done())):
                state.error = exc
            audit('tts_request', self.id, turn.id, segment=state.index, phase='error', attempt=attempt,
                  error=exc.code if isinstance(exc, VoiceError) else 'tts_failed')
        finally:
            if initial_release:
                initial_release.cancel()
            try:
                if stream is not None:
                    await stream.aclose()
            finally:
                try:
                    if attempt == 0 and state.watchdog:
                        state.watchdog.cancel()
                        await asyncio.gather(state.watchdog, return_exceptions=True)
                finally:
                    slots.release()
                    state.changed.set()

    async def synthesize(self, turn, queue):
        # Audio storage and HTTP concurrency have separate bounds. Completed
        # later phrases free request permits immediately, even behind a slow head.
        storage = asyncio.Semaphore(max(2, self.config.tts_ws_pool * 2) if self.config.tts_mode == 'ws' else self.config.tts_prepared)
        requests = asyncio.Semaphore(self.config.tts_ws_pool if self.config.tts_mode == 'ws' else self.config.tts_prefetch)
        hedge_slot = asyncio.Semaphore(1)  # at most one additional HTTP request
        ready, states, cleanup = asyncio.Queue(), [], set()
        fully_emitted = False

        def reaped(task):
            cleanup.discard(task)
            if not task.cancelled():
                task.exception()  # retrieve any losing-stream cleanup error

        async def prefetch():
            index = 0
            while self.active(turn):
                await storage.acquire()
                sentence = await queue.get()
                if sentence is None:
                    storage.release(); ready.put_nowait(None); return
                if not has_body(sentence):
                    storage.release()
                    continue
                item = PreparedSpeech(sentence, index)
                states.append(item)
                item.worker = asyncio.create_task(self.prepare_speech(turn, item, requests, hedge_slot=hedge_slot))
                ready.put_nowait(item); index += 1

        feeder = asyncio.create_task(prefetch())
        pacer = PCMPacer(self.config)
        try:
            while True:
                item = await ready.get()
                if item is None:
                    fully_emitted = True
                    return
                while sum(not s.played for s in turn.segments) >= self.config.pending_segments:
                    turn.credit.clear(); await turn.credit.wait()
                segment, seq, offset = None, 0, 0
                while True:
                    item.changed.clear()
                    if item.error:
                        raise item.error
                    if not self.active(turn):
                        return
                    available = len(item.pcm) - offset
                    take = min(self.config.audio_frame_bytes, available - available % 2)
                    # Coalesce partial upstream chunks, but never wait for EOF.
                    if take and (take == self.config.audio_frame_bytes or item.complete or (segment is None and item.initial_ready)):
                        if segment is None:
                            segment = Segment(f'{turn.client_id}_{len(turn.segments)}', item.text)
                            turn.segments.append(segment)
                            await self.emit({'type': 'segment_start', 'client_turn_id': turn.client_id,
                                'segment_id': segment.id, 'text': item.text, 'sample_rate': self.config.tts_sample_rate})
                        audio = bytes(item.pcm[offset:offset + take]); offset += take
                        started = time.monotonic(); await pacer.wait(take)
                        if not self.active(turn):
                            return
                        segment.samples += take // 2
                        await self.emit({'type': 'audio', 'client_turn_id': turn.client_id,
                            'segment_id': segment.id, 'seq': seq, 'samples': take // 2}, audio)
                        turn.stamps.setdefault('first_audio_sent', self.manager.clock() * 1000)
                        audit('downstream_pacing', self.id, turn.id, segment=item.index,
                            transport=self.downstream_transport, seq=seq, frame_bytes=take,
                            pace_wait_ms=round((time.monotonic() - started) * 1000, 3),
                            rate_bytes_per_second=pacer.rate, initial_credit_bytes=pacer.burst)
                        seq += 1
                        continue
                    if item.complete:
                        segment.complete = True
                        await self.emit({'type': 'segment_end', 'client_turn_id': turn.client_id,
                            'segment_id': segment.id, 'samples': segment.samples, 'chunks': seq})
                        break
                    # Each request's watchdog starts at HTTP admission, including
                    # prefetched phrases. Playback order never delays hedging.
                    try:
                        await self.wait_stall(item.changed)
                    except TimeoutError:
                        # Cannot skip spoken text and claim a contiguous delivered
                        # prefix. Fail visibly; no false completion receipt.
                        raise VoiceError('tts_stalled', 504) from None
                # Audio order does not depend on a losing HTTP connection's
                # shutdown. Retain bounded cleanup tasks and join on turn exit.
                for attempt, task in ((None, item.watchdog), (0, item.worker), (1, item.hedge)):
                    if task:
                        if attempt != item.winner and not task.done() and not task.cancelling():
                            task.cancel()
                        if task.done():
                            if not task.cancelled(): task.exception()
                        else:
                            cleanup.add(task); task.add_done_callback(reaped)
                item.pcm.clear(); states.remove(item); storage.release()
        finally:
            feeder.cancel()
            # Stop all watchdogs before collecting attempts: no new request can
            # appear after this snapshot, even during yielding HTTP cleanup.
            await asyncio.gather(feeder, return_exceptions=True)
            watches = [s.watchdog for s in states if s.watchdog]
            for task in watches:
                if not task.done(): task.cancel()
            await asyncio.gather(*watches, return_exceptions=True)
            attempts = list({*cleanup, *(task for s in states for task in (s.worker, s.hedge) if task)})
            for task in attempts:
                if not fully_emitted and not task.done() and not task.cancelling(): task.cancel()
            await asyncio.gather(*attempts, return_exceptions=True)

    async def delivery_result(self, result, turn):
        await self.emit({'type': 'delivery_status', 'client_turn_id': turn.client_id,
            'chat_final_sent': result.get('chat_final_sent', False),
            'chat_final_error': bool(result.get('chat_final_error'))})

    async def played(self, data):
        turn = self.turn
        if not turn or not self.active(turn) or data.get('client_turn_id') != turn.client_id:
            return  # Late receipts cannot mutate a cancelled/replaced turn.
        async with turn.receipt_lock:
            segment = next((s for s in turn.segments if s.id == data.get('segment_id')), None)
            if segment and segment.played:
                return
            expected = next((s for s in turn.segments if not s.played), None)
            if not segment or segment is not expected or not segment.complete or type(data.get('samples')) is not int or data['samples'] != segment.samples:
                raise VoiceError('invalid_receipt', 400)
            segment.played = True
            turn.delivered += segment.text
            turn.stamps.setdefault('first_audio_played', self.manager.clock() * 1000)
            # Derived from server-issued segments, never client supplied text.
            result = await self.manager.plugin.delivery(turn.id, turn.delivered, False)
            await self.delivery_result(result, turn)
            turn.credit.set()
            await self.finish_if_played(turn, locked=True)
            await self.debug(turn)

    async def finish_if_played(self, turn, locked=False):
        if not locked:
            async with turn.receipt_lock:
                return await self.finish_if_played(turn, locked=True)
        if self.active(turn) and turn.done and turn.tts_done and not turn.finalized and all(s.played for s in turn.segments):
            # Mark before I/O: ACK failure is visible and is never blindly retried.
            turn.finalized = True
            self.last_reply_finished = self.manager.clock()
            result = await self.manager.plugin.delivery(turn.id, turn.delivered, True)
            await self.delivery_result(result, turn)
            await self.emit({'type': 'turn_complete', 'client_turn_id': turn.client_id})
            turn.credit.set()

    async def cancel_remote(self, turn):
        uncertain = False
        try:
            if not turn.id and turn.submit_task:
                result = await asyncio.shield(turn.submit_task)
                turn.id = result['turn_id']
            if turn.id and not turn.finalized:
                async with turn.receipt_lock:
                    result = await self.manager.plugin.cancel(turn.id, turn.delivered)
                    try:
                        await self.delivery_result(result, turn)
                    except (OSError, TimeoutError, RuntimeError):
                        pass  # A dead browser cannot undo a successful remote cancel.
        except VoiceError as exc:
            # A definite 4xx submit rejection never created a remote turn.
            uncertain = bool(turn.id) or exc.status not in (400, 401, 403, 409, 413, 429)
        except (OSError, KeyError, TimeoutError, RuntimeError):
            uncertain = True
        if uncertain:
            try:
                await self.error(VoiceError('cancel_unconfirmed', 503), turn)
            except (OSError, TimeoutError, RuntimeError):
                audit('cancel_unconfirmed', self.id, turn.id)

    async def fail(self, turn, error):
        turn.stopped = True
        turn.credit.set()
        if self.pending is turn:
            self.pending = None
        try:
            # The page matches errors to its active/candidate turn. A preceding
            # clear forgets that ID and silently discards the following error.
            # Error handling already stops audio; retain clear for other clients.
            await self.error(error, turn)
            await self.emit({'type': 'clear', 'client_turn_id': turn.client_id, 'reason': error.code})
        except (OSError, TimeoutError, RuntimeError):
            audit('turn_notification_failed', self.id, turn.id, error=error.code)

    async def stop_turn(self, reason):
        if self.pending:
            pending, self.pending = self.pending, None
            await self._stop_turn(pending, reason)
        await self._stop_turn(self.turn, reason)

    async def _stop_turn(self, turn, reason):
        if not turn or turn.finalized:
            return
        was_stopped = turn.stopped
        turn.stopped = True
        turn.credit.set()
        # Cancel before emitting clear can yield to the playback credit waiter.
        # Otherwise it can enter finally naturally, then a late cancel aborts
        # that cleanup before cancel_remote reaches the plugin.
        if turn.task and not turn.task.done() and not was_stopped:
            turn.task.cancel()
        if not was_stopped:
            try:
                await self.emit({'type': 'clear', 'client_turn_id': turn.client_id, 'reason': reason})
            except (OSError, TimeoutError, RuntimeError):
                pass
        if turn.task and not turn.task.done():
            # Do not cancel a second time while its finally block cancels the plugin.
            await asyncio.gather(turn.task, return_exceptions=True)
        # A task canceled before its first scheduling never enters run's finally.
        if turn.stt_stream:
            await turn.stt_stream.close()
            turn.stt_stream = None

    async def close(self, reason):
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close(reason))
            self.manager.closing.add(self.close_task)
            self.close_task.add_done_callback(self.manager.closing.discard)
        # Socket/admission cancellation must not interrupt accepted-turn cleanup.
        await asyncio.shield(self.close_task)

    async def _close(self, reason):
        if self.closed:
            return
        self.closed = True
        if self.upload:
            audit('upload_abandoned', self.id, bytes=len(self.upload['audio']), frames=self.upload['frames'])
        await self.abandon_upload()
        self.manager.sessions.pop(self.id, None)
        self.refund()
        try:
            await self.stop_turn(reason)
            await self.emit({'type': 'session_end', 'reason': reason})
        except (OSError, VoiceError, TimeoutError, RuntimeError):
            pass
        try:
            await self.manager.plugin.close_call(self.id)
        except (OSError, VoiceError, TimeoutError, RuntimeError):
            audit('dsh_call_close_unconfirmed', self.id)
        if self.tts is not self.manager.tts and hasattr(self.tts, 'close'):
            await self.tts.close()
        audit(reason, self.id, duration_seconds=round(self.manager.clock() - self.started, 3),
            client_gap_seconds=round(self.manager.clock() - self.last_client_frame, 3),
            controls=dict(self.control_counts), **self.client_metrics)
