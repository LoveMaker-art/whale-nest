"""Bounded PCM pacing, independent of upstream HTTP chunk boundaries."""
import asyncio
import time


class PCMPacer:
    def __init__(self, config, clock=time.monotonic, sleep=asyncio.sleep):
        self.rate = config.tts_sample_rate * 2 * config.audio_realtime_factor
        self.burst = int(config.tts_sample_rate * 2 * config.playback_prebuffer_ms / 1000) // 2 * 2
        self.credit = self.burst
        self.clock, self.sleep = clock, sleep
        self.last = clock()

    async def wait(self, size):
        now = self.clock()
        self.credit = min(self.burst, self.credit + max(0, now - self.last) * self.rate)
        self.last = now
        delay = max(0, (size - self.credit) / self.rate)
        if delay:
            await self.sleep(delay)
            now = self.clock()
            self.credit += max(0, now - self.last) * self.rate
            self.last = now
        self.credit -= size
        # Even an upstream burst with immediate drain must yield to control/pongs.
        await self.sleep(0)
