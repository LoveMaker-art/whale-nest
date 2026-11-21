"""Owner-only synthetic traffic. No microphone, transcripts or audio retention."""
import asyncio
import base64
import json
import math
import struct
import time
from collections import deque

from .gateway import audit
from .upstream import VoiceError

MAGIC = b'VD33'
HEADER = struct.Struct('!4sIIdI')  # magic, run, sequence, UTC epoch ms, total bytes
SIZES = (1024, 4096, 16384, 65536)
MODES = ('down', 'up', 'combined')


def packet(run, seq, size, timestamp=None):
    return HEADER.pack(MAGIC, run, seq, time.time() * 1000 if timestamp is None else timestamp, size) + bytes(size - HEADER.size)


def stamp_packet(payload):
    return payload[:12] + struct.pack('!d', time.time() * 1000) + payload[20:]


class Stats:
    def __init__(self, run):
        self.run, self.count, self.bytes = run, 0, 0
        self.seen, self.high = set(), -1
        self.out_of_order = self.duplicates = 0
        self.last_arrival = self.last_sent = None
        self.max_gap = self.jitter = 0.

    def receive(self, payload, now=None):
        if len(payload) < HEADER.size:
            raise VoiceError('diagnostic_packet', 400)
        magic, run, seq, sent, size = HEADER.unpack_from(payload)
        if (magic != MAGIC or run != self.run or size != len(payload) or not math.isfinite(sent) or
            seq > 10000):
            raise VoiceError('diagnostic_packet', 400)
        now = time.monotonic() * 1000 if now is None else now
        if seq in self.seen:
            self.duplicates += 1
        elif seq < self.high:
            self.out_of_order += 1
        self.seen.add(seq)
        self.high = max(self.high, seq)
        if self.last_arrival is not None:
            gap = now - self.last_arrival
            self.max_gap = max(self.max_gap, gap)
            self.jitter += (abs(gap - (sent - self.last_sent)) - self.jitter) / 16
        self.last_arrival, self.last_sent = now, sent
        self.count += 1
        self.bytes += len(payload)

    def summary(self, expected=None):
        return dict(count=self.count, bytes=self.bytes, missing=max(0, (self.high + 1 if expected is None else expected) - len(self.seen)),
            out_of_order=self.out_of_order, duplicates=self.duplicates,
            max_gap_ms=round(self.max_gap, 3), jitter_ms=round(self.jitter, 3))


class SSEStream:
    def __init__(self, writer, config, session_id=''):
        self.writer, self.config = writer, config
        self.lock = asyncio.Lock()
        self.closed = False
        self.session_id, self.audio_bytes, self.last_audio_sent = session_id, 0, None

    async def write_event(self, data=None, index=None, event=None, comment=False, finish=False):
        async with self.lock:
            if self.closed or self.writer.is_closing() is True:
                raise ConnectionError('sse_closed')
            if callable(data):
                data = data()
            payload = b': heartbeat\n\n' if comment else (
                (f'id: {index}\n' if index is not None else '') +
                (f'event: {event}\n' if event else '') +
                'data: ' + json.dumps(data, separators=(',', ':')) + '\n\n').encode()
            started = time.monotonic()
            self.writer.write(f'{len(payload):x}\r\n'.encode() + payload + b'\r\n')
            if finish:
                self.writer.write(b'0\r\n\r\n')
                self.closed = True
            try:
                await asyncio.wait_for(self.writer.drain(), self.config.write_timeout)
            except (OSError, TimeoutError, RuntimeError):
                self.closed = True
                self.writer.close()
                raise
            if (isinstance(data, dict) and data.get('type') == 'audio' and
                type(data.get('samples')) is int):
                sent = time.monotonic()
                size = data['samples'] * 2
                self.audio_bytes += size
                transport = getattr(self.writer, 'transport', None)
                buffered = transport.get_write_buffer_size() if transport else 0
                audit('downstream_frame', self.session_id, transport='sse', seq=data.get('seq'),
                    event_index=index, frame_bytes=size, wire_bytes=len(payload), total_bytes=self.audio_bytes,
                    gap_ms=round((sent - self.last_audio_sent) * 1000, 3) if self.last_audio_sent is not None else None,
                    drain_wait_ms=round((sent - started) * 1000, 3),
                    buffered_bytes=buffered if type(buffered) is int else 0)
                self.last_audio_sent = sent

    async def send(self, data):
        await self.write_event(data)

    async def binary(self, payload):
        await self.send(lambda: dict(type='diagnostic_binary', data=base64.b64encode(stamp_packet(payload)).decode()))


class ReplayLane:
    """Session-scoped bounded journal; HTTP connections are disposable readers."""
    MAX_BYTES = 4 * 1024 * 1024
    MAX_EVENTS = 2048

    def __init__(self, config, session_id=''):
        self.config, self.closed = config, False
        self.session_id = session_id
        self.events, self.bytes, self.index = deque(), 0, 0
        self.stream = None
        self.lock = asyncio.Lock()

    def validate_cursor(self, cursor):
        oldest = self.events[0][0] if self.events else self.index + 1
        if cursor < oldest - 1 or cursor > self.index or cursor < 0:
            raise VoiceError('downstream_replay_expired', 409)

    async def attach(self, stream, cursor):
        async with self.lock:
            self.validate_cursor(cursor)
            if self.stream and not self.stream.closed:
                raise VoiceError('sse_already_connected', 409)
            self.stream = stream
            audit('sse_attach', self.session_id, last_event_id=cursor, latest_event_id=self.index)
            await stream.send(dict(type='sse_ready'))
            for index, data, _ in self.events:
                if index > cursor:
                    await stream.write_event(data, index=index)

    async def send(self, data):
        async with self.lock:
            if self.closed:
                raise ConnectionError('sse_closed')
            if callable(data):
                data = data()
            size = len(json.dumps(data, separators=(',', ':')).encode())
            self.index += 1
            self.events.append((self.index, data, size)); self.bytes += size
            while self.bytes > self.MAX_BYTES or len(self.events) > self.MAX_EVENTS:
                self.bytes -= self.events.popleft()[2]
            stream = self.stream
            if stream and not stream.closed:
                try:
                    await stream.write_event(data, index=self.index)
                except (OSError, TimeoutError, RuntimeError) as exc:
                    # Keep the journal for Last-Event-ID replay after ambiguous writes.
                    audit('sse_transport_failed', self.session_id, event_index=self.index, exception=type(exc).__name__)
                    self.stream = None

    async def binary(self, payload):
        await self.send(lambda: dict(type='diagnostic_binary', data=base64.b64encode(stamp_packet(payload)).decode()))

    async def rotate(self, stream):
        async with self.lock:
            if self.stream is stream and not stream.closed:
                audit('sse_rotate', self.session_id, last_event_id=self.index)
                await stream.write_event(dict(last_event_id=self.index), event='reconnect', finish=True)
                self.stream = None

    def close(self):
        self.closed = True
        if self.stream:
            self.stream.closed = True
            self.stream.writer.close()
        self.events.clear(); self.bytes = 0


class Diagnostic:
    def __init__(self, session, ws, streams):
        self.session, self.ws, self.streams = session, ws, streams
        self.task = None
        self.run = None
        self.options = None
        self.up = None
        self.last_finished = float('-inf')
        self.started = 0
        self.end = asyncio.Event()
        self.final_sent = None
        self.retired = set()

    async def start(self, data):
        config = self.session.config
        if not self.session.owner or not config.diagnostic_enabled:
            raise VoiceError('forbidden', 403)
        if (self.task and not self.task.done()) or time.monotonic() - self.last_finished < 1:
            raise VoiceError('diagnostic_busy', 409)
        run, size = data.get('run'), data.get('frame_bytes', 4096)
        seconds, rate = data.get('seconds', 10), data.get('rate', 44100)
        mode, profile, transport = data.get('mode', 'down'), data.get('profile', 'steady'), data.get('transport', 'ws')
        if (type(run) is not int or not 0 < run < 2 ** 32 or type(size) is not int or size not in SIZES or
            type(seconds) not in (int, float) or not 1 <= seconds <= config.diagnostic_max_seconds or
            type(rate) is not int or not 1024 <= rate <= config.diagnostic_max_rate or
            mode not in MODES or profile not in ('steady', 'burst') or transport not in ('ws', 'sse')):
            raise VoiceError('diagnostic_options', 400)
        if transport == 'sse' and (self.session.id not in self.streams or self.streams[self.session.id].closed):
            raise VoiceError('diagnostic_sse_required', 409)
        await self.session.stop_turn('diagnostic')
        self.session.upload = None
        self.session.last_speech = self.session.manager.clock()
        if run in self.retired:
            raise VoiceError('diagnostic_run_reused', 409)
        self.end = asyncio.Event()
        self.final_sent = None
        self.run, self.up = run, Stats(run)
        self.options = dict(run=run, frame_bytes=size, seconds=seconds, rate=rate, mode=mode, profile=profile, transport=transport)
        self.started = time.monotonic()
        await self.ws.send(dict(type='diagnostic_started', **self.options))
        self.task = asyncio.create_task(self.execute())

    async def execute(self):
        opt, sent_count, sent_bytes, outcome = self.options, 0, 0, 'complete'
        sending = False
        deadline = self.started + opt['seconds']
        audit('diagnostic_start', self.session.id, **opt)
        try:
            async with asyncio.timeout(max(0, deadline - time.monotonic())):
                if opt['mode'] == 'up':
                    await asyncio.sleep(max(0, deadline - time.monotonic()))
                else:
                    send = self.ws.send_binary if opt['transport'] == 'ws' else self.streams[self.session.id].binary
                    # Each burst has exactly 200 KiB, spread over 100 ms. Pause
                    # for the rest of a cycle so its average matches steady rate.
                    while time.monotonic() < deadline:
                        if opt['profile'] == 'steady':
                            target = self.started + sent_bytes / opt['rate']
                            size = min(opt['frame_bytes'], int(opt['seconds'] * opt['rate']) - sent_bytes)
                        else:
                            cycle, within = divmod(sent_bytes, 204800)
                            target = self.started + cycle * (204800 / opt['rate']) + within / 204800 * .1
                            size = min(opt['frame_bytes'], 204800 - within)
                        if size <= HEADER.size or target >= deadline:
                            await asyncio.sleep(max(0, deadline - time.monotonic()))
                            break
                        await asyncio.sleep(max(0, target - time.monotonic()))
                        # Stamp at actual send, not scheduled time: metrics separate
                        # relay jitter from intentional steady/burst timing.
                        sending = True
                        await send(packet(opt['run'], sent_count, size))
                        sending = False
                        sent_count += 1
                        sent_bytes += size
        except TimeoutError:
            outcome = 'send_timeout' if sending else 'complete'
        except asyncio.CancelledError:
            outcome = 'cancelled'
            raise
        except (OSError, RuntimeError, VoiceError) as exc:
            outcome = type(exc).__name__
            audit('diagnostic_send_failed', self.session.id, run=opt['run'], exception=outcome,
                close_code=self.ws.close_code)
        finally:
            tail_cancelled = False
            if opt['mode'] != 'down' and outcome == 'complete':
                try:
                    await asyncio.wait_for(self.end.wait(), self.session.config.diagnostic_drain_seconds)
                except TimeoutError:
                    outcome = 'upstream_end_timeout'
                except asyncio.CancelledError:
                    outcome, tail_cancelled = 'cancelled', True
            self.retired.add(opt['run'])
            if len(self.retired) > 128:
                self.retired.pop()
            self.last_finished = time.monotonic()
            summary = dict(type='diagnostic_done', **opt, sent_count=sent_count, sent_bytes=sent_bytes,
                upstream=dict(self.up.summary(self.final_sent if opt['mode'] != 'down' else 0),
                    final_sent_count=self.final_sent, end_received=self.end.is_set()), outcome=outcome)
            audit('diagnostic_server_summary', self.session.id, **summary)
            try:
                await self.ws.send(summary)
            except (OSError, RuntimeError, TimeoutError):
                pass
            if tail_cancelled:
                raise asyncio.CancelledError

    def end_upload(self, data):
        count = data.get('sent_count')
        if (not self.session.owner or data.get('run') != self.run or not self.options or self.options['mode'] == 'down' or
            type(count) is not int or not 0 <= count <= math.ceil(self.options['seconds'] * 2) or
            (self.final_sent is not None and self.final_sent != count) or self.up.high >= count):
            raise VoiceError('diagnostic_end', 400)
        self.final_sent = count
        self.end.set()

    def binary(self, payload):
        if len(payload) < HEADER.size:
            raise VoiceError('diagnostic_packet', 400)
        run = HEADER.unpack_from(payload)[1]
        if run != self.run:
            if run in self.retired:
                return  # Run-routed tail must never become microphone input.
            raise VoiceError('diagnostic_run_unknown', 400)
        if (not self.session.owner or not self.task or self.task.done() or self.end.is_set() or
            self.options['mode'] == 'down' or len(payload) != 16384 or
            time.monotonic() - self.started > self.options['seconds'] + self.session.config.diagnostic_drain_seconds or
            self.up.bytes + len(payload) > 32768 * self.options['seconds'] + 16384):
            raise VoiceError('diagnostic_upload_limit', 400)
        if self.up.bytes + len(payload) > 32768 * (time.monotonic() - self.started) + 32768:
            raise VoiceError('diagnostic_upload_rate', 429)
        self.up.receive(payload)

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


def validate_summary(data):
    """Bounded numeric-only client telemetry; server never trusts it for admission."""
    fields = ('run', 'count', 'bytes', 'missing', 'out_of_order', 'duplicates', 'max_gap_ms',
        'jitter_ms', 'close_code', 'close_reason_length', 'transport_sse', 'interrupted')
    if not isinstance(data, dict) or set(data) - set(fields) or 'run' not in data:
        raise VoiceError('diagnostic_summary', 400)
    for key, value in data.items():
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 2 ** 40:
            raise VoiceError('diagnostic_summary', 400)
    return data
