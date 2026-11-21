"""Cancellable HTTP and ASR WebSocket clients using the Python standard library."""
import asyncio
import contextvars
import io
import json
import logging
import random
import re
import time
from datetime import datetime, timezone
import ssl
import uuid
import wave
from contextlib import asynccontextmanager
from typing import Protocol, AsyncIterator
from urllib.parse import quote, urlsplit

from .config import STREAMING_ASR_PATH


request_context = contextvars.ContextVar('voice_audit_context', default=None)


def upstream_audit(code, **values):
    logging.getLogger('voice').info(json.dumps(dict(
        utc=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        code=code, **(request_context.get() or {}), **values), separators=(',', ':')))


class VoiceError(Exception):
    def __init__(self, code, status=502, message='', retry_after=None, retryable=False):
        self.code, self.status, self.message = code, status, message
        # Throttling/transient hints for bounded callers; never response bodies.
        self.retry_after, self.retryable = retry_after, retryable
        super().__init__(code)  # Never attach response bodies/URLs/credentials.


RETRYABLE_STATUS = (429, 502, 503, 504)


def parse_retry_after(value, default=1.0, cap=5.0):
    """Seconds from a Retry-After header: a plain non-negative decimal, else `default`; capped once."""
    text = str(value).strip() if value is not None else ''
    seconds = float(text) if re.fullmatch(r'[0-9]{1,6}(\.[0-9]{1,6})?', text) else default
    return min(seconds, cap)


class Response:
    def __init__(self, reader, status, headers, timeout):
        self.reader, self.status, self.headers, self.timeout = reader, status, headers, timeout

    async def chunks(self, maximum=64 * 1024 * 1024):
        total = 0
        chunked = self.headers.get('transfer-encoding', '').lower() == 'chunked'
        remaining = int(self.headers['content-length']) if 'content-length' in self.headers else None
        while remaining is None or remaining > 0:
            if chunked:
                line = await asyncio.wait_for(self.reader.readline(), self.timeout)
                try:
                    size = int(line.split(b';')[0], 16)
                except ValueError:
                    raise VoiceError('upstream_protocol') from None
                if size == 0:
                    for _ in range(64):
                        if await asyncio.wait_for(self.reader.readline(), self.timeout) in (b'\r\n', b''):
                            return
                    raise VoiceError('upstream_protocol')
                if size < 0 or size + total > maximum:
                    raise VoiceError('upstream_too_large')
                left = size
                while left:
                    # An HTTP chunk may contain a long-lived SSE stream. Deliver
                    # complete events as bytes arrive instead of waiting for 4 KiB.
                    part = await asyncio.wait_for(self.reader.read(min(left, 4096)), self.timeout)
                    if not part:
                        raise VoiceError('upstream_truncated')
                    left -= len(part)
                    total += len(part)
                    yield part
                if await asyncio.wait_for(self.reader.readexactly(2), self.timeout) != b'\r\n':
                    raise VoiceError('upstream_protocol')
            else:
                data = await asyncio.wait_for(self.reader.read(min(4096, remaining) if remaining is not None else 4096), self.timeout)
                if not data:
                    if remaining:
                        raise VoiceError('upstream_truncated')
                    return
                total += len(data)
                if total > maximum:
                    raise VoiceError('upstream_too_large')
                if remaining is not None:
                    remaining -= len(data)
                yield data

    async def json(self, maximum=65536):
        raw = bytearray()
        async for part in self.chunks(maximum):
            raw.extend(part)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise VoiceError('upstream_protocol') from None


class HTTP:
    def __init__(self, base, timeout=30):
        self.url = urlsplit(base)
        if (self.url.scheme not in ('http', 'https') or not self.url.hostname or
                self.url.username or self.url.password or self.url.query or self.url.fragment):
            raise VoiceError('invalid_upstream_url', 503)
        self.timeout = timeout

    @asynccontextmanager
    async def request(self, method, path, headers=None, body=None):
        writer = None
        try:
            tls = ssl.create_default_context() if self.url.scheme == 'https' else None
            reader, writer = await asyncio.wait_for(asyncio.open_connection(
                self.url.hostname, self.url.port or (443 if tls else 80), ssl=tls,
                limit=65536), self.timeout)
            data = b'' if body is None else body
            request_headers = {'Host': self.url.netloc, 'Connection': 'close',
                               'Content-Length': str(len(data)), **(headers or {})}
            if any('\r' in str(v) or '\n' in str(v) for v in request_headers.values()):
                raise VoiceError('invalid_upstream_configuration', 503)
            target = self.url.path.rstrip('/') + path
            request = f'{method} {target} HTTP/1.1\r\n' + ''.join(
                f'{k}: {v}\r\n' for k, v in request_headers.items()) + '\r\n'
            writer.write(request.encode('latin1') + data)
            await asyncio.wait_for(writer.drain(), self.timeout)
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), self.timeout)
            if len(raw) > 16384:
                raise VoiceError('upstream_protocol')
            lines = raw.decode('latin1').split('\r\n')
            status = int(lines[0].split()[1])
            response_headers = {}
            for line in lines[1:]:
                if line:
                    k, v = line.split(':', 1)
                    response_headers[k.lower()] = v.strip()
            yield Response(reader, status, response_headers, self.timeout)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError,
                asyncio.LimitOverrunError):
            raise VoiceError('upstream_unavailable', 503) from None
        finally:
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except (OSError, asyncio.CancelledError):
                    pass


class Transcriber(Protocol):
    """Whole-utterance STT boundary; optional streams are scoped to one capture."""
    async def transcribe(self, audio: bytes, encoding: str, sample_rate: int) -> str: ...


class Synthesizer(Protocol):
    def speech(self, text: str) -> AsyncIterator[bytes]: ...


class Hub:
    def __init__(self, base, key, config):
        # Hermes provider URLs may already end with /v1.
        self.http = HTTP(base.rstrip('/').removesuffix('/v1'), config.request_timeout)
        stream_base = config.streaming_base_url(base)
        self.stream_http = HTTP(stream_base, config.request_timeout) if stream_base else self.http
        self.key, self.config = key, config
        self.sleep, self.random = asyncio.sleep, random.random  # injectable for tests

    def open_tts_session(self):
        return TTSWebSocketPool(self) if self.config.tts_mode == 'ws' else self

    async def transcribe(self, audio, encoding, sample_rate):
        started, status, outcome = time.monotonic(), None, 'cancelled'
        if encoding == 'pcm_s16le':
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                wav.writeframes(audio)
            audio, filename, content_type = buf.getvalue(), 'utterance.wav', 'audio/wav'
        elif encoding == 'webm_opus':
            filename, content_type = 'utterance.webm', 'audio/webm'
        else:
            raise VoiceError('unsupported_audio', 400)
        boundary = 'voice-' + uuid.uuid4().hex
        body = bytearray()
        for key, value in [('model', self.config.stt_model), ('language', 'zh')]:
            body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode())
        body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n').encode())
        body.extend(audio)
        body.extend(f'\r\n--{boundary}--\r\n'.encode())
        body = bytes(body)
        began, attempt, throttled = time.monotonic(), 0, False
        while True:
            attempt += 1
            try:
                return await self._transcribe_once(body, boundary, attempt)
            except VoiceError as exc:
                throttled = throttled or exc.status == 429
                if not exc.retryable or attempt >= self.config.stt_retry_attempts:
                    if exc.retryable and throttled:
                        raise VoiceError('stt_rate_limited', 429) from None
                    raise
                # Whole-upload retry: waits are short because the user is waiting on the transcript.
                wait = min(exc.retry_after if exc.retry_after is not None else .4 * attempt, 1.5)
                wait += self.random() * .2
                if time.monotonic() - began + wait > self.config.stt_retry_total_seconds:
                    if throttled:
                        raise VoiceError('stt_rate_limited', 429) from None
                    raise
                upstream_audit('stt_http', phase='retry', attempt=attempt, status=exc.status,
                               wait_ms=round(wait * 1000, 3))
                await self.sleep(wait)

    async def _transcribe_once(self, body, boundary, attempt):
        started, status, outcome = time.monotonic(), None, 'cancelled'
        try:
            async with self.http.request('POST', '/v1/audio/transcriptions',
                {'Authorization': 'Bearer ' + self.key,
                 'Content-Type': 'multipart/form-data; boundary=' + boundary}, body) as response:
                status = response.status
                if response.status != 200:
                    raise VoiceError('stt_failed', response.status,
                        retry_after=(parse_retry_after(response.headers.get('retry-after'), .5, 1.5)
                                     if response.status in RETRYABLE_STATUS and 'retry-after' in response.headers else None),
                        retryable=response.status in RETRYABLE_STATUS)
                text = (await response.json()).get('text')
                if not isinstance(text, str) or len(text) > self.config.max_text_chars:
                    raise VoiceError('stt_empty_or_too_long', 422)
                outcome = 'ok'
                return text
        except VoiceError as exc:
            outcome = exc.code
            if exc.code.startswith('stt_'):
                raise
            # Transport failure (refused/reset/timeout) from HTTP.request: transient.
            raise VoiceError('stt_failed', exc.status, retryable=exc.code == 'upstream_unavailable') from None
        finally:
            upstream_audit('stt_http', status=status, outcome=outcome, attempt=attempt,
                duration_ms=round((time.monotonic() - started) * 1000, 3))

    async def speech(self, text):
        body = json.dumps({'model': self.config.tts_model, 'voice': self.config.tts_voice,
            'input': text, 'response_format': 'pcm', 'stream_format': 'audio',
            'sample_rate': self.config.tts_sample_rate,
            'extra': {'qwen': {'sample_rate': self.config.tts_sample_rate}}}, ensure_ascii=False).encode()
        try:
            async with self.http.request('POST', '/v1/audio/speech',
                {'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}, body) as response:
                if response.status != 200 or 'audio/' not in response.headers.get('content-type', ''):
                    if response.status in RETRYABLE_STATUS:
                        raise VoiceError('tts_failed', response.status, retryable=True,
                            retry_after=parse_retry_after(response.headers.get('retry-after'),
                                1.0, self.config.tts_retry_after_cap_seconds))
                    raise VoiceError('tts_failed', response.status if response.status != 200 else 502)
                async for chunk in response.chunks(int(self.config.max_segment_seconds * self.config.tts_sample_rate * 2)):
                    yield chunk
        except VoiceError as exc:
            if exc.code == 'tts_failed':
                raise
            # Connection refused/reset/timeout before a response is transient.
            raise VoiceError('tts_failed', exc.status, retryable=exc.code == 'upstream_unavailable') from None


class Plugin:
    def __init__(self, port, secret_source, timeout=30, events_gap=20, endpoint_file=None):
        self._http = HTTP(f'http://127.0.0.1:{port}', timeout)
        self.endpoint_file = endpoint_file
        self.timeout = timeout
        self.secret_source = secret_source
        self.events_gap = events_gap

    @property
    def http(self):
        if self.endpoint_file is None:
            return self._http
        from .ports import endpoint_port
        try:
            port = endpoint_port(self.endpoint_file)
        except (OSError, ValueError, IndexError):
            raise VoiceError('plugin_unavailable', 503) from None
        return HTTP(f'http://127.0.0.1:{port}', self.timeout)

    def headers(self):
        return {'X-Voice-Secret': self.secret_source(), 'Content-Type': 'application/json'}

    async def post(self, path, payload):
        started, status = time.monotonic(), None
        action = 'submit' if path == '/turns' else 'cancel' if path.endswith('/cancel') else 'delivery' if path.endswith('/delivery') else 'unknown'
        try:
            async with self.http.request('POST', '/voice/v1' + path, self.headers(),
                json.dumps(payload, ensure_ascii=False).encode()) as response:
                status = response.status
                data = await response.json()
                if not 200 <= response.status < 300:
                    error = data.get('error', {})
                    code = error.get('code', 'plugin_error')
                    # Contract error codes are identifiers; only plugin's 403 message is surfaced.
                    if not isinstance(code, str) or not code.replace('_', '').isalnum() or len(code) > 80:
                        code = 'plugin_error'
                    message = error.get('message', '') if response.status == 403 else ''
                    raise VoiceError(code, response.status, str(message)[:240])
                return data
        finally:
            upstream_audit('plugin_http', action=action, status=status,
                duration_ms=round((time.monotonic() - started) * 1000, 3))

    async def submit(self, user, text, client_turn_id, call_id):
        return await self.post('/turns', dict(user_id=user, text=text,
            client_turn_id=client_turn_id, call_id=call_id, lang='zh-CN'))

    async def close_call(self, call_id):
        return await self.post('/calls/' + quote(call_id, safe='') + '/close', {})

    async def prepare_call(self, call_id):
        return await self.post('/calls/' + quote(call_id, safe='') + '/prepare', {})

    async def cancel(self, turn_id, delivered):
        return await self.post('/turns/' + quote(turn_id, safe='') + '/cancel', {'delivered_text': delivered})

    async def delivery(self, turn_id, delivered, final):
        return await self.post('/turns/' + quote(turn_id, safe='') + '/delivery',
                               dict(delivered_text=delivered, final=final))

    async def events(self, turn_id):
        cursor, retries = 0, 0
        while True:
            try:
                headers = {**self.headers(), 'Last-Event-ID': str(cursor)}
                async with self.http.request('GET', '/voice/v1/turns/' + quote(turn_id, safe='') + '/events', headers) as response:
                    if response.status != 200:
                        raise VoiceError('events_failed', response.status)
                    response.timeout = self.events_gap
                    pending, fields = bytearray(), {}
                    async for chunk in response.chunks(4 * 1024 * 1024):
                        pending.extend(chunk)
                        if len(pending) > 65536:
                            raise VoiceError('events_too_large')
                        while b'\n' in pending:
                            line, _, pending = pending.partition(b'\n')
                            line = line.rstrip(b'\r').decode('utf-8')
                            if not line:
                                if 'data' not in fields:
                                    fields = {}
                                    continue
                                index = int(fields.get('id', '0'))
                                if index <= cursor:
                                    fields = {}
                                    continue
                                if index != cursor + 1:
                                    raise VoiceError('event_gap')
                                data = json.loads(fields['data'])
                                if not isinstance(data, dict) or (data.get('index', index) != index):
                                    raise VoiceError('event_index_mismatch', 400)
                                kind = fields.get('event', 'message')
                                cursor = index
                                fields = {}
                                yield kind, data
                                if kind in ('done', 'interrupted', 'error'):
                                    return
                            elif not line.startswith(':'):
                                key, _, value = line.partition(':')
                                fields[key] = value.lstrip(' ') if key != 'data' else fields.get(key, '') + value.lstrip(' ')
                raise VoiceError('events_disconnected')
            except (VoiceError, UnicodeError, ValueError, OSError, TimeoutError, asyncio.IncompleteReadError) as exc:
                if isinstance(exc, VoiceError) and exc.status in (400, 401, 403, 404, 409):
                    raise
                if retries >= 3:
                    raise VoiceError('events_disconnected') from None
                retries += 1
                upstream_audit('plugin_events_resume', event_index=cursor, attempt=retries)
                await asyncio.sleep(min(.1 * retries, .3))
                # A bounded reconnect replays events only, never re-submits a turn.


class ASRWebSocket:
    """Small RFC 6455 client for the server-to-server ASR hop; no credentials in URLs.

    Data messages are bounded to 64 KiB. Client frames are masked, server frames
    must be unmasked; control frames may interrupt fragmented text messages.
    """
    message_limit = 65536

    def __init__(self, reader, writer, timeout):
        self.reader, self.writer, self.timeout = reader, writer, timeout
        self.lock = asyncio.Lock()
        self.closed = False

    @classmethod
    async def connect(cls, http, key, model, path=STREAMING_ASR_PATH):
        import base64
        import hashlib
        import os
        writer = None
        try:
            url = http.url
            tls = ssl.create_default_context() if url.scheme == 'https' else None
            reader, writer = await asyncio.wait_for(asyncio.open_connection(
                url.hostname, url.port or (443 if tls else 80), ssl=tls,
                limit=16384), http.timeout)
            writer.transport.set_write_buffer_limits(high=8192, low=4096)
            nonce = base64.b64encode(os.urandom(16)).decode()
            path = url.path.rstrip('/') + path + '?model=' + quote(model, safe='')
            headers = {'Host': url.netloc, 'Upgrade': 'websocket', 'Connection': 'Upgrade',
                'Sec-WebSocket-Key': nonce, 'Sec-WebSocket-Version': '13',
                'Authorization': 'Bearer ' + key}
            if any('\r' in v or '\n' in v for v in headers.values()):
                raise VoiceError('invalid_upstream_configuration', 503)
            request = f'GET {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n'
            writer.write(request.encode('latin1'))
            await asyncio.wait_for(writer.drain(), http.timeout)
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), http.timeout)
            if len(raw) > 16384:
                raise VoiceError('stt_stream_protocol')
            lines = raw.decode('latin1').split('\r\n')
            status = int(lines[0].split()[1])
            if status != 101:
                raise VoiceError('stt_stream_refused', status)
            response = dict((k.lower(), v.strip()) for k, v in
                (line.split(':', 1) for line in lines[1:] if line))
            accept = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if (response.get('sec-websocket-accept') != accept or
                    response.get('upgrade', '').lower() != 'websocket' or
                    'upgrade' not in [token.strip().lower() for token in response.get('connection', '').split(',')] or
                    'sec-websocket-extensions' in response):
                raise VoiceError('stt_stream_protocol')
            return cls(reader, writer, http.timeout)
        except BaseException:
            if writer:
                writer.close()
            raise

    async def send(self, opcode, data=b''):
        import os
        import struct
        if self.closed or len(data) > self.message_limit:
            raise VoiceError('stt_stream_closed')
        mask = os.urandom(4)
        size = len(data)
        if size < 126:
            header = bytes([0x80 | opcode, 0x80 | size])
        elif size <= 65535:
            header = bytes([0x80 | opcode, 0xfe]) + struct.pack('!H', size)
        else:
            header = bytes([0x80 | opcode, 0xff]) + struct.pack('!Q', size)
        frame = header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        async with self.lock:
            self.writer.write(frame)
            await asyncio.wait_for(self.writer.drain(), min(self.timeout, 5))

    async def json(self, value):
        await self.send(1, json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode())

    async def receive(self):
        import struct
        fragment, opcode = bytearray(), None
        while True:
            first, second = await self.reader.readexactly(2)
            final, kind, size = bool(first & 128), first & 15, second & 127
            marker = size
            if first & 0x70 or second & 128:
                raise VoiceError('stt_stream_protocol')
            if size == 126:
                size = struct.unpack('!H', await self.reader.readexactly(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', await self.reader.readexactly(8))[0]
            if (size > self.message_limit or (kind >= 8 and (size > 125 or not final)) or
                    (marker == 126 and size < 126) or (marker == 127 and size < 65536)):
                raise VoiceError('stt_stream_protocol')
            data = await self.reader.readexactly(size)
            if kind == 8:
                raise VoiceError('stt_stream_closed')
            if kind == 9:
                await self.send(10, data)
                continue
            if kind == 10:
                continue
            if kind in (1, 2):
                if opcode is not None:
                    raise VoiceError('stt_stream_protocol')
                opcode = kind
            elif kind != 0 or opcode is None:
                raise VoiceError('stt_stream_protocol')
            fragment.extend(data)
            if len(fragment) > self.message_limit:
                raise VoiceError('stt_stream_protocol')
            if final:
                if opcode == 2 and getattr(self, 'binary_audio', False):
                    return bytes(fragment)
                if opcode != 1:
                    raise VoiceError('stt_stream_protocol')
                event = json.loads(fragment)
                if not isinstance(event, dict):
                    raise VoiceError('stt_stream_protocol')
                return event

    async def close(self):
        if self.closed:
            return
        try:
            await asyncio.wait_for(self.send(8, b'\x03\xe8'), .2)
        except (OSError, TimeoutError, VoiceError):
            pass
        self.closed = True
        self.writer.close()
        try:
            await asyncio.wait_for(self.writer.wait_closed(), 1)
        except (OSError, TimeoutError):
            self.writer.transport.abort()


class StreamingTranscriber:
    """STT interface with an optional speech-time session and one batch fallback.

    The normal transcribe method remains batch for legacy upload_mode=batch.
    Only a qualified utterance_end can request a final or invoke fallback.
    """
    upstream_model = 'qwen-audio-3.0-asr-flash-streaming'

    def __init__(self, hub):
        self.hub, self.config = hub, hub.config

    async def transcribe(self, audio, encoding, sample_rate):
        return await self.hub.transcribe(audio, encoding, sample_rate)

    def open_stream(self, encoding, sample_rate, partial):
        if encoding != 'pcm_s16le' or sample_rate != 16000:
            return None  # Unsupported capture formats retain the batch path.
        return StreamingUtterance(self, partial)


class StreamingUtterance:
    def __init__(self, transcriber, partial):
        self.transcriber, self.config, self.partial = transcriber, transcriber.config, partial
        self.queue = asyncio.Queue(8)  # Bounded setup/write buffering; PCM stays in gateway RAM for fallback.
        self.task_id = str(uuid.uuid4())
        self.socket = None
        self.failed = self.finishing = self.closed = False
        self.task = asyncio.create_task(self._run())

    def feed(self, data):
        if self.closed or self.failed or self.finishing:
            return
        try:
            # Split transport-sized uploads too; never put a whole utterance on the WS queue.
            for offset in range(0, len(data), 4096):
                self.queue.put_nowait(bytes(data[offset:offset + 4096]))
        except asyncio.QueueFull:
            self.failed = True
            self.task.cancel()  # Keep capturing for the single batch fallback.

    async def _sender(self):
        while True:
            audio = await self.queue.get()
            if audio is None:
                await self.socket.json({'header': {'action': 'finish-task', 'task_id': self.task_id,
                    'streaming': 'duplex'}, 'payload': {'input': {}}})
                return
            await self.socket.send(2, audio)

    def _event(self, event):
        header = event.get('header', {})
        if not isinstance(header, dict) or header.get('task_id') != self.task_id:
            raise VoiceError('stt_stream_protocol')
        kind = header.get('event')
        if kind == 'task-failed':
            raise VoiceError('stt_stream_failed')
        return kind

    async def _run(self):
        sender = None
        sentences, committed = {}, set()
        try:
            async with asyncio.timeout(min(45, self.config.max_utterance_seconds + 10)):
                async with asyncio.timeout(min(5, self.config.request_timeout)):
                    self.socket = await ASRWebSocket.connect(self.transcriber.hub.stream_http,
                        self.transcriber.hub.key, self.config.stt_stream_model)
                    await self.socket.json({'header': {'action': 'run-task', 'task_id': self.task_id,
                        'streaming': 'duplex'}, 'payload': {'task_group': 'audio', 'task': 'asr',
                        'function': 'recognition', 'model': self.transcriber.upstream_model,
                        'parameters': {'format': 'pcm', 'sample_rate': 16000}, 'input': {}}})
                    if self._event(await self.socket.receive()) != 'task-started':
                        raise VoiceError('stt_stream_protocol')
                sender = asyncio.create_task(self._sender())
                while True:
                    receive = asyncio.create_task(self.socket.receive())
                    try:
                        # A failed writer must trigger fallback even if the provider
                        # continues sending partials. A finished writer may still wait for final.
                        waiting = {receive} | ({sender} if not sender.done() else set())
                        done, _ = await asyncio.wait(waiting, timeout=min(10, self.config.request_timeout),
                                                     return_when=asyncio.FIRST_COMPLETED)
                        if not done:
                            raise VoiceError('stt_stream_timeout', 504)
                        if sender in done:
                            sender.result()
                        if receive not in done:
                            event = await asyncio.wait_for(receive, min(10, self.config.request_timeout))
                        else:
                            event = receive.result()
                    finally:
                        if not receive.done():
                            receive.cancel()
                        await asyncio.gather(receive, return_exceptions=True)
                    if sender.done():
                        sender.result()
                    kind = self._event(event)
                    if kind == 'task-finished':
                        if not self.finishing:
                            raise VoiceError('stt_stream_protocol')
                        await asyncio.wait_for(asyncio.shield(sender), min(1, self.config.request_timeout))
                        # Never promote a partial to a final result.
                        text = ''.join(sentences[i] for i in sorted(committed))
                        if not text.strip() or set(sentences) != committed:
                            raise VoiceError('stt_stream_empty')
                        return text
                    if kind != 'result-generated':
                        raise VoiceError('stt_stream_protocol')
                    sentence = event.get('payload', {}).get('output', {}).get('sentence', {})
                    if sentence.get('heartbeat') is True:
                        continue
                    seq, text = sentence.get('sentence_id'), sentence.get('text')
                    if type(seq) is not int or not 1 <= seq <= 1024 or not isinstance(text, str):
                        raise VoiceError('stt_stream_protocol')
                    if seq in committed:
                        if text != sentences[seq]:
                            raise VoiceError('stt_stream_protocol')
                        continue
                    sentences[seq] = text
                    if sentence.get('sentence_end') is True:
                        committed.add(seq)
                    caption = ''.join(sentences[i] for i in sorted(sentences))
                    if len(caption) > self.config.max_text_chars:
                        raise VoiceError('stt_stream_too_long')
                    await asyncio.wait_for(self.partial(caption), min(1, self.config.write_timeout))
        except asyncio.CancelledError:
            raise
        except Exception:
            # No server bodies, transcript text, URLs or credentials in exceptions/logs.
            self.failed = True
            return None
        finally:
            if sender and not sender.done():
                sender.cancel()
            if sender:
                await asyncio.gather(sender, return_exceptions=True)
            if self.socket:
                await self.socket.close()
            while not self.queue.empty():
                self.queue.get_nowait()

    async def finish(self, audio, encoding, sample_rate):
        if self.closed:
            raise asyncio.CancelledError
        self.finishing = True
        text = None
        try:
            if not self.failed:
                try:
                    self.queue.put_nowait(None)
                    # Absolute deadline from utterance_end: partials cannot renew it.
                    text = await asyncio.wait_for(asyncio.shield(self.task), min(3, self.config.request_timeout))
                except (asyncio.QueueFull, TimeoutError):
                    self.failed = True
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling() or not self.failed:
                        raise
            if text and not self.failed:
                return text
            await self.close()
            upstream_audit('stt_stream_fallback', reason='stream_unavailable')
            return await self.transcriber.hub.transcribe(audio, encoding, sample_rate)
        finally:
            await self.close()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if not self.task.done():
            self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        self.partial = None
        while not self.queue.empty():
            self.queue.get_nowait()


class TTSConnection(ASRWebSocket):
    binary_audio = True
    message_limit = 128 * 1024


class TTSWebSocket:
    """Session-owned synthesizer: one reader, one active task, bounded handoff.

    Explicit pre-audio failure can fall back once to HTTP. An accepted task
    whose outcome is unknown is never replayed. Future sentences use HTTP.
    """
    def __init__(self, hub, pool=None):
        self.pool = pool
        self.hub, self.config = hub, hub.config
        base = self.config.tts_websocket_base_url(hub.http.url.geturl())
        self.http = HTTP(base, self.config.request_timeout) if base else hub.http
        self.socket = self.reader_task = self.events = None
        self.lock = asyncio.Lock()
        self.active = None
        self.fallback = self.closed = False
        self.last_finished = 0
        self.dials = self.tasks = self.connection_tasks = 0

    @property
    def fallback(self):
        return self.pool.fallback if self.pool else self._fallback

    @fallback.setter
    def fallback(self, value):
        if self.pool:
            self.pool.fallback = value
        else:
            self._fallback = value

    async def _discard(self):
        socket, reader = self.socket, self.reader_task
        self.socket = self.reader_task = None
        if reader and reader is not asyncio.current_task():
            reader.cancel()
        if socket:
            await socket.close()
        if reader and reader is not asyncio.current_task():
            await asyncio.gather(reader, return_exceptions=True)

    async def _read(self, socket, events):
        try:
            while True:
                # The timer is application idle, pings do not extend it.
                value = await asyncio.wait_for(socket.receive(), self.config.tts_ws_idle_s)
                if self.active is None:
                    raise VoiceError('tts_ws_stale_audio')
                if not isinstance(value, bytes):
                    if value.get('header', {}).get('task_id') != self.active:
                        raise VoiceError('tts_ws_task_mismatch')
                events.put_nowait(value)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            upstream_audit('tts_ws_reader_end', reason=(exc.code if isinstance(exc, VoiceError)
                else 'queue_full' if isinstance(exc, asyncio.QueueFull)
                else 'idle_timeout' if isinstance(exc, TimeoutError) else 'transport'),
                queued=events.qsize(), active=bool(self.active))
            # A full queue is a protocol/backpressure failure, never unbounded RAM.
            await socket.close()
            if events.full():
                while not events.empty():
                    events.get_nowait()
            events.put_nowait(VoiceError('tts_ws_disconnected'))

    async def _connect(self):
        if self.socket and (self.socket.closed or self.reader_task.done() or
                time.monotonic() - self.last_finished >= self.config.tts_ws_idle_s):
            await self._discard()
        if self.socket is None:
            self.socket = await TTSConnection.connect(self.http, self.hub.key,
                self.config.tts_model, '/v1/ali/audio/speech/stream')
            self.events = asyncio.Queue(8)
            self.reader_task = asyncio.create_task(self._read(self.socket, self.events))
            self.dials += 1
            self.connection_tasks = 0
            upstream_audit('tts_ws_connect', dials=self.dials)

    async def _next(self):
        try:
            value = await asyncio.wait_for(self.events.get(), self.config.tts_stall_seconds)
        except TimeoutError:
            upstream_audit('tts_ws_task_stalled', task_id=self.active, queued=self.events.qsize(),
                           reader_done=self.reader_task.done() if self.reader_task else True)
            raise
        if isinstance(value, Exception):
            raise value
        return value

    async def _send(self, action, payload):
        await self.socket.json({'header': {'action': action, 'task_id': self.active,
            'streaming': 'duplex'}, 'payload': payload})

    async def _cancel(self):
        if not self.socket or not self.active:
            return
        try:
            async with asyncio.timeout(self.config.tts_ws_cancel_s):
                await self._send('finish-task', {'input': {'directive': 'cancel'}})
                while True:
                    value = await self._next()
                    if isinstance(value, bytes):
                        continue  # Discard old generation audio through terminal acknowledgement.
                    event = value.get('header', {}).get('event')
                    upstream_audit('tts_ws_cancel_event', event=event)
                    if event == 'task-finished':
                        self.active = None
                        self.last_finished = time.monotonic()
                        return
                    if event == 'task-failed':
                        break
        except Exception as exc:
            upstream_audit('tts_ws_cancel_discard', reason='timeout' if isinstance(exc, TimeoutError) else 'transport')
        await self._discard()
        self.active = None

    async def speech(self, text):
        async with self.lock:
            if self.closed:
                raise VoiceError('tts_ws_closed')
            audio = accepted = terminal = explicit_failure = False
            began, first_audio_ms = time.monotonic(), None
            if not self.fallback:
                try:
                    await self._connect()
                    self.active = str(uuid.uuid4())
                    accepted = True  # Set before writing: drain failure is ambiguous.
                    await self._send('run-task', {'task_group': 'audio', 'task': 'tts',
                        'function': 'SpeechSynthesizer', 'model': self.config.tts_model,
                        'parameters': {'format': 'pcm', 'sample_rate': self.config.tts_sample_rate,
                                       'voice': self.config.tts_voice}, 'input': {}})
                    value = await self._next()
                    event = value.get('header', {}).get('event') if isinstance(value, dict) else None
                    if event == 'task-failed':
                        explicit_failure = True
                        raise VoiceError('tts_ws_task_failed')
                    if event != 'task-started':
                        raise VoiceError('tts_ws_protocol')
                    # Local gateway sentences are bounded, preserve the native 20k limit.
                    if not text or len(text) > 20000:
                        raise VoiceError('tts_ws_text_limit')
                    await self._send('continue-task', {'input': {'text': text}})
                    await self._send('finish-task', {'input': {}})
                    total = 0
                    while True:
                        value = await self._next()
                        if isinstance(value, bytes):
                            total += len(value)
                            if total > self.config.max_segment_seconds * self.config.tts_sample_rate * 2:
                                raise VoiceError('tts_too_large')
                            if value:
                                if not audio:
                                    first_audio_ms = round((time.monotonic() - began) * 1000, 3)
                                audio = True
                                yield value
                            continue
                        event = value.get('header', {}).get('event')
                        if event == 'task-failed':
                            explicit_failure = True
                            raise VoiceError('tts_ws_task_failed')
                        if event == 'task-finished':
                            terminal = True
                            if not audio:
                                explicit_failure = True
                                raise VoiceError('tts_ws_empty')
                            self.tasks += 1
                            self.connection_tasks += 1
                            upstream_audit('tts_ws_task', tasks=self.tasks, dials=self.dials,
                                           bytes=total, reused=self.connection_tasks > 1,
                                           first_audio_ms=first_audio_ms,
                                           duration_ms=round((time.monotonic() - began) * 1000, 3))
                            return
                except (asyncio.CancelledError, GeneratorExit):
                    if self.active and not terminal:
                        await self._cancel()
                    raise
                except Exception as exc:
                    self.fallback = True
                    await self._discard()
                    upstream_audit('tts_ws_fallback',
                                   reason=exc.code.replace('stt_stream', 'tts_ws') if isinstance(exc, VoiceError) else 'tts_ws_transport',
                                   before_audio=not audio,
                                   replay=not audio and (not accepted or explicit_failure))
                    if audio or (accepted and not explicit_failure):
                        raise VoiceError('tts_failed') from None
                finally:
                    self.active = None
                    self.last_finished = time.monotonic()
            async for chunk in self.hub.speech(text):
                yield chunk

    async def close(self):
        self.closed = True
        if self.events is not None and self.active is not None:
            while not self.events.empty():
                self.events.get_nowait()
            self.events.put_nowait(VoiceError('tts_ws_closed'))
        await self._discard()
        self.active = None


class TTSWebSocketPool:
    """Session pool. Each lazy connection keeps one task and its own PCM reader.

    Semaphore admission is FIFO; completed PCM is ordered by PreparedSpeech in
    the gateway. A transport failure switches future tasks across the session
    to HTTP, while accepted tasks on other connections keep their own outcomes.
    """
    def __init__(self, hub):
        self.fallback = self.closed = False
        self.connections = [TTSWebSocket(hub, self) for _ in range(hub.config.tts_ws_pool)]
        self.free = list(self.connections)
        self.slots = asyncio.Semaphore(len(self.connections))

    @property
    def dials(self):
        return sum(c.dials for c in self.connections)

    @property
    def tasks(self):
        return sum(c.tasks for c in self.connections)

    async def speech(self, text):
        async with self.slots:
            if self.closed:
                raise VoiceError('tts_ws_closed')
            connection = self.free.pop(0)
            stream = connection.speech(text)
            try:
                async for chunk in stream:
                    yield chunk
            finally:
                try:
                    await stream.aclose()
                finally:
                    self.free.insert(0, connection)

    async def close(self):
        self.closed = True
        await asyncio.gather(*(c.close() for c in self.connections))
