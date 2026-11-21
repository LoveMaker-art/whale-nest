"""Bounded streaming PCM edge treatment, with a constant gain per TTS request.

No pitch shifting, overlap, resampling, or per-frame automatic gain changes.
Text boundaries stay independent of HTTP byte chunks. Only low-energy edge
frames are removed; a safety margin protects quiet initial/final consonants.
"""
from array import array
import math
import re
import sys
import unicodedata


def decode(raw):
    x = array('h'); x.frombytes(raw)
    if sys.byteorder != 'little':
        x.byteswap()
    return x


def encode(x):
    a = array('h', x)
    if sys.byteorder != 'little':
        a.byteswap()
    return a.tobytes()


def energy(x):
    return math.sqrt(sum(v * v for v in x) / len(x)) if x else 0


class PCMContinuity:
    def __init__(self, rate, config):
        self.rate, self.config = rate, config
        self.frame = max(1, round(rate * .01))
        self.keep = round(rate * config.prosody_edge_ms / 1000)
        self.fade = round(rate * config.prosody_fade_ms / 1000)
        self.raw = bytearray()
        self.head, self.quiet, self.tail = [], [], []
        self.bootstrap = []
        self.gain = None
        self.started = False
        self.emitted = 0
        self.trimmed_head = self.trimmed_tail = 0

    def feed(self, raw):
        self.raw.extend(raw)
        output = []
        while len(self.raw) >= self.frame * 2:
            x = decode(bytes(self.raw[:self.frame * 2]))
            del self.raw[:self.frame * 2]
            output.extend(self._frame(x))
        return encode(output)

    def _frame(self, x):
        voiced = energy(x) >= self.config.prosody_silence_rms
        if not self.started:
            if not voiced:
                self.head.extend(x)
                removed = max(0, len(self.head) - self.keep)
                self.trimmed_head += removed
                if removed:
                    del self.head[:removed]
                return []
            self.started = True
            self.bootstrap.extend(self.head); self.head = []
        if self.gain is None:
            self.bootstrap.extend(x)
            # Fixed early-window gain; never chase phonemes later in the stream.
            if len(self.bootstrap) < self.keep + round(self.rate * .12):
                return []
            return self.release_initial_samples()
        return self._accept(x)

    def release_initial_samples(self):
        if self.gain is not None or not self.bootstrap:
            return []
        active = [v for v in self.bootstrap if abs(v) >= self.config.prosody_silence_rms]
        target = 32768 * 10 ** (self.config.prosody_target_dbfs / 20)
        bound = 10 ** (self.config.prosody_gain_db / 20)
        self.gain = max(1 / bound, min(bound, target / max(1, energy(active))))
        x, self.bootstrap = self.bootstrap, []
        output = []
        for at in range(0, len(x), self.frame):
            output.extend(self._accept(x[at:at + self.frame]))
        return output

    def release_initial(self):
        """Wall-clock fallback: release available speech without waiting for more."""
        return encode(self.release_initial_samples())

    def _accept(self, x):
        if energy(x) < self.config.prosody_silence_rms:
            self.quiet.extend(x)
            return []
        joined = self.tail + self.quiet + list(x)
        self.quiet = []
        # Preserve a tiny tail so the final fade never modifies already sent PCM.
        take = max(0, len(joined) - self.fade)
        out, self.tail = joined[:take], joined[take:]
        return self._scale(out)

    def _scale(self, x):
        output = []
        for v in x:
            gain = self.gain or 1
            if self.emitted < self.fade:
                gain *= self.emitted / max(1, self.fade)
            output.append(max(-31128, min(31128, round(v * gain))))
            self.emitted += 1
        return output

    def finish(self):
        if len(self.raw) % 2:
            raise ValueError('odd_pcm')
        output = []
        if self.raw:
            output.extend(self._frame(decode(bytes(self.raw)))); self.raw.clear()
        output.extend(self.release_initial_samples())
        if not self.started:
            # All-silent responses stay nonempty for the existing segment protocol.
            return encode(self.head)
        self.trimmed_tail = max(0, len(self.quiet) - self.keep)
        ending = self.tail + self.quiet[:self.keep]
        # Apply tail fade before gain/limiter. No fade at HTTP frame boundaries.
        for i in range(min(self.fade, len(ending))):
            at = len(ending) - 1 - i
            ending[at] = round(ending[at] * i / max(1, self.fade))
        output.extend(self._scale(ending))
        self.tail = self.quiet = []
        return encode(output)


def smooth_pcm(raw, rate, config):
    processor = PCMContinuity(rate, config)
    return processor.feed(raw) + processor.finish()


def pause_samples(text, rate, config):
    # Values describe total acoustic pause, including the retained edge margins.
    clean = text.rstrip().rstrip('”’」』\"\'）)')
    pause = config.prosody_sentence_pause_ms if clean.endswith(('。', '！', '？', '!', '?', '…', '.')) else config.prosody_comma_pause_ms
    return max(0, round(rate * (pause - 2 * config.prosody_edge_ms) / 1000))


class ProsodyBuffer:
    """Keep the first legacy unit fast, then coalesce clauses within a sentence.

    Never merge natural sentences: HTTP PCM has no exact sentence timestamps.
    Thus receipts remain exact at every sentence end, even after interruption.
    """
    CLOSERS = '”’」』\"\'）)】]'

    def __init__(self, limit=100, minimum=12, first_minimum=6, later_limit=100):
        self.text = ''
        self.limit, self.minimum = limit, minimum
        self.first_minimum, self.later_limit = first_minimum, later_limit
        self.first = True
        self.pending = ''

    def can_flush(self):
        clean = self.text.rstrip().rstrip(self.CLOSERS)
        if clean and self._protected(clean, len(clean) - 1):
            return False
        if clean.endswith(('。', '！', '？', '!', '?', '…')) and any(
                self.text.count(a) > self.text.count(b) for a, b in (('“', '”'), ('「', '」'), ('『', '』'))):
            return False
        return bool(clean and clean[-1] in '。！？!?，,；;…' and
                    (clean[-1] not in '，,；;' or self.first and len(clean) >= self.first_minimum))

    @staticmethod
    def _protected(text, i):
        # Do not cut inside URLs, decimals, numbered list markers or abbreviations.
        prefix = text[:i + 1].split()[-1] if text[:i + 1].split() else ''
        if re.match(r'(?:https?://|www\.)', prefix, re.I):
            return True
        if text[i] == '.':
            before, after = text[:i], text[i + 1:]
            if after and after[0].isdigit() and before and before[-1].isdigit():
                return True
            if re.search(r'(?:\b(?:Mr|Mrs|Ms|Dr|Prof|etc|vs|e\.g|i\.e)|\b[A-Za-z]|(?:^|\n)\s*\d+)$', before, re.I):
                return True
        return False

    def feed(self, delta, final=False):
        self.text += delta
        output = []
        while self.text:
            limit = self.limit if self.first else self.later_limit
            stop = 0
            waiting_boundary = False
            for i, c in enumerate(self.text[:limit]):
                hard = c in '。！？!?\n'
                soft = self.first and c in '，,；;'
                english = c == '.' and not self._protected(self.text, i)
                ellipsis = c == '…'
                if not (hard or soft or english or ellipsis) or self._protected(self.text, i):
                    continue
                if soft and i + 1 < self.first_minimum:
                    continue
                # Need one lookahead to consume punctuation runs and closing quotes.
                j = i + 1
                while j < len(self.text) and self.text[j] in self.CLOSERS + '。！？!?….' :
                    j += 1
                if c == '\n':
                    stop = j
                    break
                if j == len(self.text) and not final:
                    waiting_boundary = True
                    break
                stop = j
                break
            if waiting_boundary:
                break
            if not stop and len(self.text) >= limit:
                # Prefer whitespace or comma near the cap; hard cap bounds memory
                # even for one enormous URL/token without a legal boundary.
                candidates = [i + 1 for i, c in enumerate(self.text[:limit]) if c.isspace() or c in '，,；;']
                reserve = (len(self.text) == limit and not final or
                           len(self.text) > limit and self.text[limit] in self.CLOSERS + '。！？!?….')
                cap = limit - 1 if reserve else limit
                stop = next((i for i in reversed(candidates) if limit // 2 <= i <= cap), cap)
            if not stop and final:
                stop = len(self.text)
            if not stop:
                break
            part, self.text = self.text[:stop], self.text[stop:]
            # Closing punctuation arriving in a later delta stays attached to the
            # next text unit, never becomes an empty spoken request on its own.
            if any(not c.isspace() and unicodedata.category(c)[0] not in 'PCZ' for c in part):
                output.append(self.pending + part); self.pending = ''; self.first = False
            else:
                self.pending += part
        return output
