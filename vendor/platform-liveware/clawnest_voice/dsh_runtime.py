"""Start the platform gateway under the DSH plugin lifecycle."""
import asyncio
import json
import logging
import os
import signal
import sys
from dataclasses import replace
from pathlib import Path

from .config import Config
from .gateway import Manager
from .quota import QuotaStore
from .serve import Server
from .upstream import Hub, Plugin, VoiceError


class DshVoiceManager(Manager):
    async def profile(self):
        try:
            async with self.plugin.http.request('GET', '/voice/v1/profile', self.plugin.headers()) as response:
                if response.status == 200:
                    return await response.json()
        except (VoiceError, OSError, TimeoutError):
            pass
        return {}

    async def prepare(self, session_id):
        try:
            await self.plugin.prepare_call(session_id)
        except (VoiceError, OSError, TimeoutError):
            # The first utterance can still prepare through the same bridge.
            logging.getLogger('voice').warning('voice_session_prepare_unavailable')

    async def open(self, *args, **kwargs):
        # Admission pins the companion's current voice for the whole call.
        if not self.sessions:
            async with self.plugin.http.request('GET', '/voice/v1/settings', self.plugin.headers()) as response:
                if response.status != 200:
                    raise VoiceError('voice_settings_unavailable', 503)
                settings = await response.json()
            config = replace(self.config, tts_voice=settings['voice'])
            config.validate()
            self.tts = Hub(self.hub_base, self.stt.key, config)
        session = await super().open(*args, **kwargs)
        session.dsh_prepare = asyncio.create_task(self.prepare(session.id))
        return session

    async def close(self):
        preparing = [session.dsh_prepare for session in self.sessions.values()]
        await super().close()
        if preparing:
            await asyncio.gather(*preparing, return_exceptions=True)


async def main(settings):
    config = Config(port=settings['port'] or 8897, stt_model=settings['asr_model'],
                    tts_model=settings['tts_model'], tts_voice=settings['voice'],
                    tts_sample_rate=settings['sample_rate'], tts_mode='http',
                    max_sessions=1, diagnostic_enabled=False)
    config.validate()
    path = Path(settings['data_dir'])
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    quota = QuotaStore(path / 'quota.sqlite3', config.friend_daily_seconds)
    os.chmod(path / 'quota.sqlite3', 0o600)
    hub = Hub(settings['base'], settings['key'], config)
    plugin = Plugin(settings['bridge'], lambda: settings['secret'],
                    config.request_timeout, config.plugin_events_gap_seconds)
    manager = DshVoiceManager(config, settings['owner'], hub, hub, plugin, quota)
    manager.hub_base = settings['base']
    server = Server(manager, public_origin=settings['public_origin'],
                    default_avatar=Path(settings['default_avatar']).read_bytes())
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    try:
        port = await server.start(settings['port'])
        if settings['port'] and port != config.port:
            raise RuntimeError('Configured voice gateway port is already in use')
        print(json.dumps({'ready': True, 'port': port}), flush=True)
        await stop.wait()
    finally:
        await server.close()
        quota.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.WARNING)
    if sys.version_info < (3, 11):
        sys.exit('ClawNest Voice requires Python 3.11 or later')
    asyncio.run(main(json.load(sys.stdin)))
