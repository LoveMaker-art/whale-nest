#!/usr/bin/env python3
"""Loopback-only Liveware HTTP + WebSocket service; stdlib only."""
import argparse
import asyncio
import errno
import base64
import hashlib
import json
import logging
import os
import struct
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = 'liveware'

from .client_protocol import client_metadata, compatible, PROTOCOL_VERSION, RELOAD_HINT
from .config import Config, ConfigError
from .gateway import CLOSE_REASONS, Manager, audit
from .quota import QuotaStore, QuotaExceeded
from .upstream import Hub, Plugin, VoiceError, StreamingTranscriber
from .diagnostic import Diagnostic, MAGIC, SSEStream, ReplayLane, validate_summary, stamp_packet
from .dsh_http import HttpVoiceTransport

HERE = Path(__file__).resolve().parent
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def frame(opcode, data=b''):
    size = len(data)
    head = bytes([0x80 | opcode])
    if size < 126:
        head += bytes([size])
    elif size < 65536:
        head += bytes([126]) + struct.pack('!H', size)
    else:
        head += bytes([127]) + struct.pack('!Q', size)
    return head + data


class WebSocket:
    def __init__(self, reader, writer, config):
        self.reader, self.writer, self.config = reader, writer, config
        self.lock = asyncio.Lock()
        self.closing = self.close_sent = False
        self.header_count = 0
        self.connection_id = 'wc_' + uuid.uuid4().hex
        self.downstream_transport = config.downstream_transport
        self.fragment, self.opcode = bytearray(), None
        self.close_code, self.close_reason, self.close_reason_length = 1006, 0, 0
        self.initiator, self.session = 'unknown', None
        self.frame_counts = {}
        self.frame_gap = None
        self.message_frames = self.received_message_frames = 0
        self.streams = None
        self.large_frame_allowance = 0
        self.audio_bytes = 0
        self.last_audio_sent = None
        transport = getattr(writer, 'transport', None)
        if transport:
            transport.set_write_buffer_limits(high=config.write_high_water, low=config.write_high_water // 2)

    def buffered(self):
        transport = getattr(self.writer, 'transport', None)
        size = transport.get_write_buffer_size() if transport else 0
        return size if type(size) is int else 0

    def write(self, payload, extra=0, close=False):
        # Writes on this event loop are atomic until the next await. Control frames
        # bypass the AUDIO lock/drain, with a hard cap on their reserved buffer.
        if (self.closing and not close) or self.writer.is_closing() is True:
            raise ConnectionError('websocket_closed')
        buffered = self.buffered()
        if buffered <= self.config.write_high_water:
            self.large_frame_allowance = 0
        self.large_frame_allowance = max(self.large_frame_allowance, extra)
        if buffered + len(payload) > self.config.write_high_water + self.config.control_reserve_bytes + self.large_frame_allowance:
            self.writer.transport.abort()
            raise ConnectionError('control_backlog')
        self.writer.write(payload)

    @staticmethod
    def valid_close(code):
        return code in (1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014) or 3000 <= code <= 4999

    def close_frame(self, code=1000, reason=b''):
        # No await between setting the latch and the one permitted close write.
        self.closing = True
        lane = self.streams.get(self.session.id) if self.streams is not None and self.session else None
        if isinstance(lane, ReplayLane):
            lane.close()
        if self.close_sent:
            return
        self.close_sent = True
        code = code if self.valid_close(code) else 1000
        self.close_code = code
        self.write(frame(8, struct.pack('!H', code) + reason), close=True)

    def protocol_error(self, cause, code=1002):
        self.initiator = 'server'
        audit('ws_protocol_error', self.session.id if self.session else '', cause=cause, close_code=code, ws_id=self.connection_id)
        self.close_frame(code)
        raise VoiceError(cause, 400)

    def send_failure(self, exc, audio=False):
        audit('send_failed', self.session.id if self.session else '', exception=type(exc).__name__,
            close_code=self.close_code, audio=audio, buffered_bytes=self.buffered())

    async def send(self, data, audio=None):
        try:
            await self._send(data, audio)
        except (OSError, TimeoutError, RuntimeError) as exc:
            self.send_failure(exc, audio is not None)
            if audio is not None or (self.downstream_transport == 'sse' and data.get('type') in ('segment_start', 'segment_end', 'tts_done')):
                if not self.closing and not isinstance(exc, TimeoutError) and self.downstream_transport == 'ws':
                    self.writer.transport.abort()
                raise VoiceError('downstream_slow' if isinstance(exc, TimeoutError) else 'downstream_failed', 502) from exc
            raise

    async def drain(self, report=True):
        try:
            await asyncio.wait_for(self.writer.drain(), self.config.write_timeout)
        except (OSError, TimeoutError, RuntimeError) as exc:
            if report:
                self.send_failure(exc)
            raise

    async def _send(self, data, audio=None):
        if self.closing:
            raise ConnectionError('websocket_closed')
        metadata = frame(1, json.dumps(data, ensure_ascii=False).encode())
        if self.downstream_transport == 'sse' and (audio is not None or data.get('type') in ('segment_start', 'segment_end', 'tts_done')):
            stream = self.streams.get(self.session.id) if self.streams is not None and self.session else None
            if stream is None or stream.closed:
                raise VoiceError('downstream_sse_unavailable', 502)
            if audio is not None and len(audio) > self.config.audio_frame_bytes:
                raise VoiceError('audio_frame_too_large')
            await stream.send(dict(data, pcm=base64.b64encode(audio).decode()) if audio is not None else data)
            return
        if audio is not None:
            if len(audio) > self.config.audio_frame_bytes:
                raise VoiceError('audio_frame_too_large')
            await asyncio.sleep(0)  # Ready controls run before the next audio frame.
            async with self.lock:
                started = time.monotonic()
                await self.drain(report=False)
                before_write = time.monotonic()
                self.write(metadata + frame(2, audio))  # No control can split the pair.
                await self.drain(report=False)
                sent = time.monotonic()
                self.audio_bytes += len(audio)
                audit('downstream_frame', self.session.id if self.session else '',
                    transport='ws', seq=data.get('seq'), frame_bytes=len(audio), total_bytes=self.audio_bytes,
                    gap_ms=round((sent - self.last_audio_sent) * 1000, 3) if self.last_audio_sent is not None else None,
                    drain_wait_ms=round(((before_write - started) + (sent - before_write)) * 1000, 3),
                    buffered_bytes=self.buffered())
                self.last_audio_sent = sent
            return
        self.write(metadata)
        if data.get('type') == 'session_end':
            if self.initiator == 'unknown':
                self.initiator = 'server'
            reason = data.get('reason', '')
            self.close_code, self.close_reason = 1000, CLOSE_REASONS.get(reason, 0)
            payload = reason.encode('ascii') if reason in CLOSE_REASONS else b''
            self.close_reason_length = len(payload)
            self.close_frame(1000, payload)
            try:
                await self.drain(report=False)
            finally:
                self.writer.close()
        else:
            await asyncio.sleep(0)

    async def send_binary(self, payload):
        """Diagnostic only: deliberately allows the requested large WS messages."""
        if len(payload) > 65536:
            raise VoiceError('diagnostic_frame_too_large', 400)
        await asyncio.sleep(0)
        async with self.lock:
            try:
                await self.drain(report=False)
                self.write(frame(2, stamp_packet(payload)), extra=65546)
                await self.drain(report=False)
            except (OSError, TimeoutError, RuntimeError) as exc:
                self.send_failure(exc, True)
                raise

    async def receive(self):
        while not self.closing:
            a, b = await self.reader.readexactly(2)
            opcode, size = a & 15, b & 127
            marker = size
            if size == 126:
                size = struct.unpack('!H', await self.reader.readexactly(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', await self.reader.readexactly(8))[0]
            self.header_count += 1
            if self.header_count <= 3:
                audit('ws_frame_header', self.session.id if self.session else '', ws_id=self.connection_id, index=self.header_count,
                    opcode=opcode, rsv=(a >> 4) & 7, fin=bool(a & 128), length=size)
            if a & 0x70:
                self.protocol_error('rsv_without_extension')
            if not b & 0x80 or opcode not in (0, 1, 2, 8, 9, 10):
                self.protocol_error('unmasked_or_invalid_opcode')
            if opcode >= 8 and not a & 128:
                self.protocol_error('fragmented_control')
            if opcode >= 8 and size > 125:
                self.protocol_error('control_too_large')
            if (marker == 126 and size < 126) or (marker == 127 and (size < 65536 or size >= 2 ** 63)):
                self.protocol_error('invalid_length_encoding')
            if size > self.config.max_audio_bytes or (opcode < 8 and len(self.fragment) + size > self.config.max_audio_bytes):
                self.protocol_error('message_too_large', 1009)
            mask = await self.reader.readexactly(4)
            data = await self.reader.readexactly(size)
            data = bytes(v ^ mask[i % 4] for i, v in enumerate(data))
            self.frame_counts[opcode] = self.frame_counts.get(opcode, 0) + 1
            if self.session:
                gap = self.session.client_frame()
                self.frame_gap = gap
            if opcode >= 8:
                audit('control', self.session.id if self.session else '', control={8: 'close', 9: 'ping', 10: 'pong'}[opcode],
                    source='client_ws', count=self.frame_counts[opcode], client_gap_seconds=self.frame_gap)
            if opcode == 8:
                self.initiator = 'client'
                self.closing = True
                if len(data) == 1:
                    self.protocol_error('invalid_close_length')
                code = struct.unpack('!H', data[:2])[0] if data else 1000
                try:
                    reason = data[2:].decode('utf-8') if data else ''
                except UnicodeError:
                    self.protocol_error('invalid_close_utf8', 1007)
                self.close_reason, self.close_reason_length = CLOSE_REASONS.get(reason, 0), len(data[2:])
                if not self.valid_close(code):
                    audit('ws_invalid_peer_close', self.session.id if self.session else '', peer_code=code)
                    code, data = 1000, b''
                self.close_frame(code, data[2:])
                return None
            if opcode == 9:
                self.write(frame(10, data))
                continue
            if opcode == 10:
                continue
            if opcode == 0:
                if self.opcode is None:
                    self.protocol_error('invalid_fragment_sequence')
            else:
                if self.opcode is not None:
                    self.protocol_error('invalid_fragment_sequence')
                self.opcode = opcode
                self.message_frames = 0
            self.message_frames += 1
            self.fragment.extend(data)
            if self.opcode == 1 and len(self.fragment) > 8192:
                self.protocol_error('text_too_large', 1009)
            if a & 0x80:
                if self.opcode == 1:
                    try:
                        self.fragment.decode('utf-8')
                    except UnicodeError:
                        self.protocol_error('invalid_utf8', 1007)
                message = self.opcode, bytes(self.fragment)
                self.received_message_frames = self.message_frames
                self.fragment.clear()
                self.opcode = None
                return message


class Server:
    def __init__(self, manager, fake_user=None, public_origin=None, default_avatar=None):
        self.fake_user = fake_user
        self.public_origin = public_origin
        self.default_avatar = default_avatar
        self.last_websocket = (0, 'none')
        self.manager, self.config = manager, manager.config
        self.clients = set()
        self.server = None
        self.janitor = None
        self.connections = 0
        self.streams = {}
        self.monotonic = time.monotonic
        # Reconnect summary receipts are owner-bound, bounded and expire in RAM.
        self.diagnostic_runs = {}
        self.failure_snapshots_seen = {}
        # Freeze one coherent asset set per process, including the HTML template.
        self.assets = {name: (HERE / name).read_bytes() for name in
            ('page.html', 'page.css', 'i18n.js', 'voice.js', 'page.js', 'dsh-http.js', 'diagnostic.js', 'recorder.js', 'classic.html', 'classic-page.js')}
        digest = hashlib.sha256()
        for name, body in sorted(self.assets.items()):
            digest.update(name.encode() + b'\0' + body + b'\0')
        if self.default_avatar is not None:
            digest.update(b'default-avatar.png\0' + self.default_avatar)
        self.build_id = digest.hexdigest()[:12]
        self.http_voice = HttpVoiceTransport(manager, self.build_id)
        for name in ('page.html', 'classic.html'):
            self.assets[name] = self.assets[name].replace(b'__VOICE_BUILD_ID__', self.build_id.encode())

    async def start(self, port=None):
        preferred = self.config.port if port is None else port
        try:
            self.server = await asyncio.start_server(self.handle, '127.0.0.1', preferred, limit=16384)
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise
            self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0, limit=16384)
        self.janitor = asyncio.create_task(self.sweep())
        return self.server.sockets[0].getsockname()[1]

    async def sweep(self):
        while True:
            await asyncio.sleep(min(1, self.config.meter_interval))
            try:
                await self.manager.sweep()
            except (OSError, VoiceError, TimeoutError, RuntimeError) as exc:
                audit('session_write_failed', exception=type(exc).__name__)

    async def close(self):
        if self.janitor:
            self.janitor.cancel()
            await asyncio.gather(self.janitor, return_exceptions=True)
        await self.manager.close()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for writer in list(self.clients):
            writer.close()

    async def response(self, writer, status, body, content_type='application/json', cache_control='no-store', etag=None):
        reasons = {200: 'OK', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests'}
        writer.write((f'HTTP/1.1 {status} {reasons.get(status, "Error")}\r\n'
            f'Content-Type: {content_type}\r\n'
            + (f'Content-Length: {len(body)}\r\n' if status != 304 else '')
            + f'Cache-Control: {cache_control}\r\n'
            + (f'ETag: {etag}\r\n' if etag else '') + 'X-Content-Type-Options: nosniff\r\n'
            "Referrer-Policy: no-referrer\r\nPermissions-Policy: microphone=(self)\r\n"
            "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' https:; media-src 'self' blob:; object-src 'none'; base-uri 'self'\r\n"
            'Connection: close\r\n\r\n').encode() + body)
        await asyncio.wait_for(writer.drain(), self.config.write_timeout)

    def record_summary(self, user, data):
        if user != self.manager.owner or not self.config.diagnostic_enabled:
            raise VoiceError('forbidden', 403)
        summary = validate_summary(data)
        record = self.diagnostic_runs.get(summary['run'])
        if not record or record[0] != user or time.monotonic() - record[1] > 600:
            raise VoiceError('diagnostic_run_unknown', 400)
        if not record[2]:
            record[2] = True
            audit('diagnostic_client_summary', **summary)

    def record_failure_snapshots(self, data):
        scalar_fields = {'snapshot_id', 'utc', 'build_id', 'protocol_version', 'transport', 'close_code',
            'ready', 'bytes', 'frames', 'playback_error', 'context'}
        if (set(data) != {'version', 'snapshots'} or type(data['version']) is not int or
            not isinstance(data['snapshots'], list) or not 1 <= len(data['snapshots']) <= 4):
            raise VoiceError('invalid_phone_events', 400)
        for snapshot in data['snapshots']:
            if (not isinstance(snapshot, dict) or set(snapshot) != scalar_fields | {'events'} or
                any(type(snapshot[k]) is not int or not 0 <= snapshot[k] < 2 ** 53 for k in scalar_fields) or
                snapshot['transport'] not in (1, 2) or snapshot['ready'] > 3 or snapshot['context'] > 4 or
                snapshot['playback_error'] > 8 or snapshot['close_code'] > 4999 or
                not isinstance(snapshot['events'], list) or len(snapshot['events']) > 20):
                raise VoiceError('invalid_phone_events', 400)
            self.validate_phone_events(dict(version=1, events=snapshot['events']))
        for snapshot in data['snapshots']:
            key = (snapshot['build_id'], snapshot['snapshot_id'])
            if key not in self.failure_snapshots_seen:
                audit('client_failure_snapshot', snapshot_utc=snapshot['utc'], **{k: v for k, v in snapshot.items() if k != 'utc'})
                self.failure_snapshots_seen[key] = None
                if len(self.failure_snapshots_seen) > 256:
                    self.failure_snapshots_seen.pop(next(iter(self.failure_snapshots_seen)))

    def record_phone_events(self, data):
        if isinstance(data, dict) and data.get('version') == 2:
            self.record_failure_snapshots(data)
            return
        self.validate_phone_events(data)
        audit('phone_events', version=1, events=data['events'])

    @staticmethod
    def validate_phone_events(data):
        # Independent server validation: never trust client-side redaction.
        fields = {'utc', 'ms', 'event', 'code', 'reason', 'reason_length', 'clean', 'ready', 'type',
            'count', 'buffered', 'state', 'rate', 'channels', 'echo', 'noise', 'agc', 'muted',
            'hidden', 'duration', 'downlink', 'rtt', 'save', 'online', 'samples', 't_vad_start', 't_vad_end', 't_last_frame_sent', 't_first_audio_played'}
        if (not isinstance(data, dict) or set(data) != {'version', 'events'} or data['version'] != 1 or
            not isinstance(data['events'], list) or len(data['events']) > 300):
            raise VoiceError('invalid_phone_events', 400)
        for entry in data['events']:
            if (not isinstance(entry, dict) or set(entry) - fields or not {'utc', 'ms', 'event'} <= set(entry) or
                any(type(v) not in (int, float) or not -1 <= v <= 2 ** 53 for v in entry.values()) or
                type(entry['event']) is not int or not 1 <= entry['event'] <= 23):
                raise VoiceError('invalid_phone_events', 400)

    SSE_ROTATE_SECONDS = 95
    SSE_HEARTBEAT_SECONDS = 15

    async def stream_wait(self, eof, seconds):
        await asyncio.wait([eof], timeout=seconds)

    async def event_stream(self, reader, writer, user, target, headers=None):
        query = parse_qs(urlsplit(target).query)
        session_id = query.get('session_id', [''])[0]
        active = self.manager.sessions.get(session_id)
        if not active or active.user != user:
            raise VoiceError('forbidden', 403)
        if active.downstream_transport != 'sse' and not active.owner:
            raise VoiceError('forbidden', 403)
        try:
            cursor = int((headers or {}).get('last-event-id', query.get('after', ['0'])[0]))
        except ValueError:
            raise VoiceError('invalid_event_id', 400) from None
        lane = self.streams.setdefault(session_id, ReplayLane(self.config, session_id))
        lane.validate_cursor(cursor)
        if lane.stream and not lane.stream.closed:
            raise VoiceError('sse_already_connected', 409)
        stream = SSEStream(writer, self.config, session_id)
        writer.transport.set_write_buffer_limits(high=self.config.write_high_water, low=self.config.write_high_water // 2)
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n'
            b'Cache-Control: no-store\r\nX-Accel-Buffering: no\r\nTransfer-Encoding: chunked\r\n\r\n')
        eof = asyncio.create_task(reader.read(1))
        started = self.monotonic()
        heartbeat = started + self.SSE_HEARTBEAT_SECONDS
        try:
            # The hard deadline also bounds replay and a blocked drain.
            async with asyncio.timeout(self.SSE_ROTATE_SECONDS + 4):
                await lane.attach(stream, cursor)
                while not active.closed and not eof.done():
                    now = self.monotonic()
                    if now - started >= self.SSE_ROTATE_SECONDS:
                        await lane.rotate(stream)
                        return
                    await self.stream_wait(eof, max(0, min(heartbeat, started + self.SSE_ROTATE_SECONDS) - now))
                    if not eof.done() and self.monotonic() >= heartbeat:
                        await stream.write_event(comment=True)
                        heartbeat = self.monotonic() + self.SSE_HEARTBEAT_SECONDS
        finally:
            stream.closed = True
            if lane.stream is stream:
                lane.stream = None
            eof.cancel()
            await asyncio.gather(eof, return_exceptions=True)

    async def handle(self, reader, writer):
        session, ws, diagnostic = None, None, None
        is_websocket = False
        self.clients.add(writer)
        self.connections += 1
        try:
            if self.connections > max(16, self.config.max_sessions * 4):
                await self.response(writer, 429, b'{"error":{"code":"capacity"}}')
                return
            peer = writer.get_extra_info('peername')
            if not peer or peer[0] != '127.0.0.1':
                raise VoiceError('forbidden', 403)
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
            if len(raw) > 16384:
                raise VoiceError('headers_too_large', 400)
            lines = raw.decode('latin1').split('\r\n')
            method, target, version = lines[0].split()
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                key, value = line.split(':', 1)
                key = key.lower()
                if key in headers:
                    raise VoiceError('duplicate_header', 400)
                headers[key] = value.strip()
            path = urlsplit(target).path
            is_websocket = path == '/ws'
            if is_websocket:
                self.last_websocket = (self.monotonic(), 'request')
            if method not in ('GET', 'POST'):
                raise VoiceError('method_not_allowed', 400)
            if method == 'GET' and path == '/healthz':
                await self.response(writer, 200, b'{"ready":true,"kind":"whalenest-realtime-call"}')
                return
            if headers.get('x-clawchat-user-id') != self.manager.owner:
                raise VoiceError('forbidden', 403)
            if method == 'GET' and path in ('/', '/page.html', '/app.html', '/voice.js', '/i18n.js', '/page.js', '/dsh-http.js', '/diagnostic.js', '/recorder.js', '/page.css', '/classic', '/classic.html', '/classic-page.js'):
                filename = 'classic.html' if path in ('/classic', '/classic.html') else path[1:] if path.endswith(('.js', '.css')) else 'page.html'
                kind = 'application/javascript; charset=utf-8' if filename.endswith('.js') else 'text/css; charset=utf-8' if filename.endswith('.css') else 'text/html; charset=utf-8'
                body = self.assets[filename]
                etag = '"' + hashlib.sha256(body).hexdigest() + '"' if filename.endswith(('.js', '.css')) else None
                cached = etag and any(tag.strip() in (etag, 'W/' + etag, '*')
                    for tag in headers.get('if-none-match', '').split(','))
                await self.response(writer, 304 if cached else 200, b'' if cached else body, kind,
                    cache_control='no-cache' if etag else 'no-store', etag=etag)
                return
            user = headers.get('x-clawchat-user-id', '').strip() or self.fake_user
            if not user or len(user) > 128 or not all(c.isalnum() or c in '_-' for c in user):
                raise VoiceError('unauthorized', 401)
            # Same-origin check also covers the SSE and summary routes.
            origin = headers.get('origin')
            if origin:
                parsed = urlsplit(origin)
                allowed = {headers.get('host'), headers.get('x-forwarded-host')}
                if origin != self.public_origin and (parsed.scheme not in ('http', 'https') or parsed.netloc not in allowed):
                    raise VoiceError('origin_forbidden', 403)
            if method == 'GET' and path == '/profile' and self.default_avatar is not None:
                await self.response(writer, 200, json.dumps(await self.manager.profile()).encode())
                return
            if method == 'GET' and path == '/default-avatar.png' and self.default_avatar is not None:
                await self.response(writer, 200, self.default_avatar, 'image/png')
                return
            if path.startswith('/voice-http/'):
                data = await self.http_voice.request(method, path, parse_qs(urlsplit(target).query), reader, headers, user)
                await self.response(writer, 200, json.dumps(data, separators=(',', ':')).encode())
                return
            if method == 'GET' and path == '/startup-status':
                query = parse_qs(urlsplit(target).query)
                stage, socket, microphone = (query.get(key, [''])[0] for key in ('stage', 'socket', 'mic'))
                if stage not in '1234567' or len(stage) != 1 or socket not in ('0', '1', '2', '3') or microphone not in ('0', '1'):
                    raise VoiceError('invalid_startup_status', 400)
                at, phase = self.last_websocket
                if self.monotonic() - at > 15:
                    phase = 'none'
                logging.getLogger('voice').warning('voice_startup stage=%s socket=%s mic=%s gateway=%s', stage, socket, microphone, phase)
                await self.response(writer, 200, b'{"ok":true}')
                return
            if method == 'POST':
                if path not in ('/diagnostic-summary', '/phone-events'):
                    raise VoiceError('not_found', 404)
                if user != self.manager.owner or (path == '/diagnostic-summary' and not self.config.diagnostic_enabled):
                    raise VoiceError('forbidden', 403)
                length = int(headers.get('content-length', '0'))
                if not 0 < length <= (65536 if path == '/phone-events' else 2048) or 'transfer-encoding' in headers:
                    raise VoiceError('summary_too_large', 400)
                data = json.loads(await asyncio.wait_for(reader.readexactly(length), 3))
                if path == '/phone-events':
                    self.record_phone_events(data)
                else:
                    self.record_summary(user, data)
                await self.response(writer, 200, b'{"ok":true}')
                return
            if path == '/downstream':
                await self.event_stream(reader, writer, user, target, headers)
                return
            if path == '/health':
                await self.response(writer, 200, json.dumps(dict(version='voice-liveware/v1', status='local_gateway_only', build_id=self.build_id, protocol_version=PROTOCOL_VERSION)).encode())
                return
            if path != '/ws':
                raise VoiceError('not_found', 404)
            # Identity is trusted ONLY from the relay header; body/query IDs are ignored.
            key = headers.get('sec-websocket-key', '')
            try:
                valid_key = len(base64.b64decode(key, validate=True)) == 16
            except ValueError:
                valid_key = False
            if (not valid_key or headers.get('sec-websocket-version') != '13' or
                headers.get('upgrade', '').lower() != 'websocket' or
                'upgrade' not in headers.get('connection', '').lower()):
                raise VoiceError('websocket_handshake', 400)
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                f'Sec-WebSocket-Accept: {accept}\r\nCache-Control: no-store\r\n\r\n').encode())
            await writer.drain()
            self.last_websocket = (self.monotonic(), 'upgraded')
            ws = WebSocket(reader, writer, self.config)
            ua = headers.get('user-agent', '').lower()
            family = 'firefox' if 'firefox' in ua else 'chromium' if any(x in ua for x in ('chrome', 'chromium', 'crios')) else 'safari' if 'safari' in ua else 'other'
            extensions = headers.get('sec-websocket-extensions', '')
            audit('ws_handshake', ws_id=ws.connection_id, origin_present=bool(origin), ua_family=family,
                requested_extensions='permessage-deflate' if 'permessage-deflate' in extensions.lower() else 'other' if extensions else 'none',
                negotiated_extensions='none')
            ws.streams = self.streams
            # Handshake alone cannot reserve a session indefinitely.
            first = await asyncio.wait_for(ws.receive(), 10)
            start = json.loads(first[1]) if first and first[0] == 1 else None
            if not isinstance(start, dict) or start.get('type') != 'start':
                raise VoiceError('start_required', 400)
            client = client_metadata(start)
            if not compatible(client, self.build_id):
                audit('client_outdated', **client)
                # Backup pages render message only for forbidden/403, then stop reconnecting.
                await ws.send(dict(type='error', code='forbidden', status=403,
                    hint_code='client_outdated', message=RELOAD_HINT))
                ws.initiator = 'server'
                ws.close_frame(1000)
                await ws.drain()
                return
            diagnostic_ws = (user == self.manager.owner and self.config.diagnostic_enabled and
                start.get('diagnostic_ws') == 1 and start.get('downstream_transport') == 'ws')
            ws.downstream_transport = 'ws' if diagnostic_ws else self.config.downstream_transport_phone
            connection_id = start.get('connection_id')
            resume_session = start.get('resume_session')
            if connection_id is not None and (not isinstance(connection_id, str) or
                    not 20 <= len(connection_id) <= 80 or
                    not all(c.isalnum() or c in '-_' for c in connection_id)):
                raise VoiceError('invalid_connection_id', 400)
            if resume_session is not None and (not isinstance(resume_session, str) or len(resume_session) > 80):
                raise VoiceError('invalid_resume_session', 400)
            session = await self.manager.open(user, ws.send, client=client, transport=ws.downstream_transport,
                connection_id=connection_id, resume_session=resume_session)
            ws.session = session
            diagnostic = Diagnostic(session, ws, self.streams)
            audit('ws_connect', session.id, role='owner' if session.owner else 'friend_candidate',
                source='relay_header', ws_id=ws.connection_id, **client)
            audit('control', session.id, control='start', source='client_json', count=1)
            while not session.closed:
                message = await ws.receive()
                if message is None:
                    break
                try:
                    if message[0] == 1:
                          control = json.loads(message[1])
                          if not isinstance(control, dict):
                              raise VoiceError('invalid_control', 400)
                          kind = control.get('type')
                          if kind == 'downstream_transport':
                              startup_fallback = (control.get('fallback') == 1 and control.get('transport') == 'ws'
                                  and session.turn is None and session.pending is None)
                              if (not session.owner or control.get('transport') not in ('ws', 'sse') or
                                    (control.get('transport') == 'ws' and not startup_fallback
                                     and (not self.config.diagnostic_enabled or control.get('diagnostic') != 1))):
                                  raise VoiceError('forbidden', 403)
                              if session.turn and not session.turn.stopped and not session.turn.finalized:
                                  raise VoiceError('turn_busy', 409)
                              ws.downstream_transport = session.downstream_transport = control['transport']
                              await ws.send(dict(type='downstream_transport', transport=ws.downstream_transport, fallback=startup_fallback))
                              continue
                          if kind == 'diagnostic_start':
                              await diagnostic.start(control)
                              self.diagnostic_runs = {k: v for k, v in self.diagnostic_runs.items() if time.monotonic() - v[1] < 600}
                              if len(self.diagnostic_runs) >= 128:
                                  self.diagnostic_runs.pop(next(iter(self.diagnostic_runs)))
                              self.diagnostic_runs[diagnostic.run] = [user, time.monotonic(), False]
                              continue
                          if kind == 'diagnostic_end':
                              diagnostic.end_upload(control)
                              continue
                          if kind == 'diagnostic_stop':
                              await diagnostic.close()
                              continue
                          if kind == 'diagnostic_summary':
                              self.record_summary(user, control.get('summary'))
                              await ws.send(dict(type='diagnostic_summary_ack', run=control['summary']['run']))
                              continue
                          if kind == 'utterance_start' and diagnostic.task and not diagnostic.task.done():
                              raise VoiceError('diagnostic_busy', 409)
                          if isinstance(control, dict) and control.get('type') == 'end_session':
                              ws.initiator = 'client_control'
                          await session.control(control, ws.frame_gap)
                    elif message[0] == 2:
                          if message[1].startswith(MAGIC):
                              diagnostic.binary(message[1])
                          else:
                              await session.binary(message[1], ws.received_message_frames)
                except (ValueError, UnicodeError):
                    await session.error(VoiceError('invalid_json', 400))
                except VoiceError as exc:
                    await session.error(exc)
        except (VoiceError, QuotaExceeded) as exc:
            error = exc if isinstance(exc, VoiceError) else VoiceError('quota_exceeded', 429)
            if is_websocket and ws is None:
                self.last_websocket = (self.monotonic(), error.code)
            data = {'type': 'error', 'code': error.code, 'status': error.status, 'message': error.message}
            try:
                if ws:
                    await ws.send(data)
                else:
                    await self.response(writer, error.status, json.dumps({'error': data}).encode())
            except (OSError, TimeoutError, RuntimeError):
                pass
        except (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError, UnicodeError, AttributeError) as exc:
            audit('connection_error', session.id if session else '', exception=type(exc).__name__)
        except Exception as exc:
            audit('connection_error', session.id if session else '', exception=type(exc).__name__)
        finally:
            if diagnostic:
                await diagnostic.close()
            if ws:
                audit('ws_close', session.id if session else '', close_code=ws.close_code,
                    close_reason=ws.close_reason, close_reason_length=ws.close_reason_length,
                    initiator=ws.initiator, frames=ws.frame_counts, ws_id=ws.connection_id)
            if session:
                await session.close('disconnected')
                stream = self.streams.get(session.id)
                if stream:
                    if isinstance(stream, ReplayLane):
                        stream.close()
                    else:
                        stream.closed = True
                        stream.writer.close()
                    self.streams.pop(session.id, None)
            self.connections -= 1
            self.clients.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


async def main_async(args):
    config = Config.load(args.config)
    endpoint = None
    if args.fakes:
        from .fakes import FakeStack
        stack = FakeStack(config)
        await stack.start()
        manager = stack.manager
    else:
        stack = None
        owner, base, key, plugin_port, data_dir = config.runtime()
        config.plugin_secret()  # fail closed before listening
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(data_dir, 0o700)
        quota = QuotaStore(data_dir / 'quota.sqlite3', config.friend_daily_seconds)
        os.chmod(data_dir / 'quota.sqlite3', 0o600)
        hub = Hub(base, key, config)
        from .ports import GatewayEndpoint
        from .binding import LivewareBinding
        home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))).resolve()
        manager = Manager(config, owner, StreamingTranscriber(hub) if config.stt_mode == 'stream' else hub,
            hub, Plugin(plugin_port, config.plugin_secret, config.request_timeout,
                config.plugin_events_gap_seconds, endpoint_file=home / 'clawchat-voice/plugin-port.json'), quota)
        endpoint = GatewayEndpoint(home / 'clawchat-voice/gateway-port.json')
    server = Server(manager, args.fake_user if args.fakes else None)
    try:
        port = await server.start(args.port)
        if endpoint is not None:
            endpoint.publish(port)
            await asyncio.to_thread(LivewareBinding(home).sync, port)
        audit('listening', port=port, fakes=args.fakes)
        await asyncio.Future()
    finally:
        await server.close()
        if endpoint is not None:
            endpoint.close()
        if stack:
            await stack.close()
        else:
            manager.quota.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(HERE / 'config.json'))
    parser.add_argument('--port', type=int)
    parser.add_argument('--fake-user', choices=['fake-owner', 'fake-friend'], default='fake-owner', help='Only used with --fakes; fixed loopback demo identity')
    parser.add_argument('--fakes', action='store_true', help='In-memory fake Hub/plugin; no credentials or external I/O')
    args = parser.parse_args()
    logging.Formatter.converter = time.gmtime
    logging.basicConfig(level=logging.INFO, format='%(asctime)s.%(msecs)03dZ %(levelname)s %(message)s',
        datefmt='%Y-%m-%dT%H:%M:%S')
    try:
        asyncio.run(main_async(args))
    except (ConfigError, VoiceError) as exc:
        audit('startup_failed', error=str(exc) if isinstance(exc, ConfigError) else exc.code,
            exception=type(exc).__name__)
        return 2
    except (OSError, RuntimeError) as exc:
        audit('startup_failed', error='gateway_startup_failed', exception=type(exc).__name__, errno=getattr(exc, 'errno', None))
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
