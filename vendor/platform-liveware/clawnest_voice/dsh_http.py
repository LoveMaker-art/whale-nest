"""HTTPS relay transport for the existing Voice Session protocol."""
import asyncio
import base64
import binascii
import hashlib
import json
import logging
import re
from collections import deque

from .client_protocol import client_metadata, compatible
from .upstream import VoiceError

POLL_FRAME_LIMIT = 16


async def read_message(reader, headers):
    limit = 32768
    try:
        async with asyncio.timeout(6):
            if headers.get('transfer-encoding', '').lower() == 'chunked':
                body = bytearray()
                while True:
                    line = await reader.readuntil(b'\r\n')
                    size = int(line.split(b';', 1)[0].strip(), 16)
                    if not size:
                        break
                    if size < 0 or len(body) + size > limit:
                        raise VoiceError('body_too_large', 413)
                    body.extend(await reader.readexactly(size))
                    if await reader.readexactly(2) != b'\r\n':
                        raise ValueError
            else:
                size = int(headers.get('content-length', '0'))
                if not 0 < size <= limit:
                    raise VoiceError('invalid_body_length', 400)
                body = await reader.readexactly(size)
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError
            return result, hashlib.sha256(body).digest()
    except (ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        raise VoiceError('invalid_body', 400) from None


class HttpCall:
    def __init__(self, request_id):
        self.request_id = request_id
        self.session = None
        self.frames = deque()
        self.sequence = 0
        self.ack = 0
        self.written = 0
        self.last_write = None
        self.changed = asyncio.Event()
        self.writer = asyncio.Lock()

    async def emit(self, frame, audio=None):
        if len(self.frames) >= 128:
            raise VoiceError('downstream_slow', 502)
        if audio is not None:
            frame = {**frame, 'pcm': base64.b64encode(audio).decode('ascii')}
        self.sequence += 1
        self.frames.append((self.sequence, frame))
        self.changed.set()
        if frame.get('type') == 'turn_complete':
            logging.getLogger('voice').warning('voice_http phase=played')
        elif frame.get('type') == 'session_end':
            logging.getLogger('voice').warning('voice_http phase=ended reason=%s', frame['reason'])

    async def poll(self, cursor):
        if cursor < self.ack or cursor > self.sequence:
            raise VoiceError('invalid_event_id', 409)
        self.ack = cursor
        while self.frames and self.frames[0][0] <= cursor:
            self.frames.popleft()
        if not self.frames and not self.session.closed:
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), 0.45)
            except TimeoutError:
                pass
        # Drain enough queued PCM to sustain playback over a slower relay.
        # Each audio frame is capped at the gateway's 4 KiB PCM size.
        next_frames = list(self.frames)[:POLL_FRAME_LIMIT]
        return {'after': next_frames[-1][0] if next_frames else cursor,
                'frames': [data for _, data in next_frames], 'closed': self.session.closed}

    async def write(self, body, signature):
        number = body.get('sequence')
        frames = body.get('frames')
        if type(number) is not int or not isinstance(frames, list) or not 1 <= len(frames) <= 12:
            raise VoiceError('invalid_control', 400)
        async with self.writer:
            if number == self.written and signature == self.last_write:
                return {'written': number}
            if number != self.written + 1 or self.session.closed:
                raise VoiceError('invalid_control_sequence', 409)
            payloads = []
            for entry in frames:
                if not isinstance(entry, dict):
                    raise VoiceError('invalid_control', 400)
                if 'pcm' in entry:
                    try:
                        payload = base64.b64decode(entry['pcm'], validate=True)
                    except (TypeError, ValueError, binascii.Error):
                        raise VoiceError('invalid_audio', 400) from None
                    if not 0 < len(payload) <= 4096:
                        raise VoiceError('invalid_audio', 400)
                else:
                    payload = entry
                payloads.append(payload)
            # Mark before applying individual controls so an unclear receipt
            # cannot replay a submitted utterance or a playback acknowledgement.
            self.written, self.last_write = number, signature
            try:
                for payload in payloads:
                    if isinstance(payload, bytes):
                        await self.session.binary(payload)
                    else:
                        await self.session.control(payload)
            except VoiceError as exc:
                await self.session.error(exc)
            return {'written': number}


class HttpVoiceTransport:
    def __init__(self, manager, build_id):
        self.manager = manager
        self.build_id = build_id
        self.call = None
        self.admission = asyncio.Lock()

    async def request(self, method, path, query, reader, headers, user):
        if path == '/voice-http/start' and method == 'POST':
            body, _ = await read_message(reader, headers)
            start_id = body.get('request_id')
            tab = body.get('connection_id')
            resume = body.get('resume_session')
            if not isinstance(start_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', start_id):
                raise VoiceError('invalid_connection_id', 400)
            if not isinstance(tab, str) or not re.fullmatch(r'[0-9a-f-]{36}', tab):
                raise VoiceError('invalid_connection_id', 400)
            if resume is not None and (not isinstance(resume, str) or not re.fullmatch(r'vs_[0-9a-f]{32}', resume)):
                raise VoiceError('invalid_resume_session', 400)
            client = client_metadata(body)
            if not compatible(client, self.build_id):
                raise VoiceError('client_outdated', 409)
            async with self.admission:
                if self.call and self.call.request_id == start_id and not self.call.session.closed:
                    return {'session': self.call.session.id}
                call = HttpCall(start_id)
                call.session = await self.manager.open(user, call.emit, client=client,
                    transport='https', connection_id=tab, resume_session=resume)
                self.call = call
                logging.getLogger('voice').warning('voice_http phase=connected')
                return {'session': call.session.id}
        match = re.fullmatch(r'/voice-http/(vs_[0-9a-f]{32})/(poll|frames|end)', path)
        call = self.call
        if not match or not call or match[1] != call.session.id or call.session.user != user:
            raise VoiceError('session_ended', 404)
        if match[2] == 'poll' and method == 'GET':
            cursor = query.get('after', [''])[0]
            if not re.fullmatch(r'[0-9]{1,12}', cursor):
                raise VoiceError('invalid_event_id', 400)
            return await call.poll(int(cursor))
        if match[2] == 'frames' and method == 'POST':
            return await call.write(*(await read_message(reader, headers)))
        if match[2] == 'end' and method == 'POST':
            async with call.writer:
                await call.session.close('ended')
            return {'closed': True}
        raise VoiceError('method_not_allowed', 405)
