/* Original dependency-free voice primitives. Node + browser, no DOM required. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Voice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const hasBody = text => typeof text === 'string' && /[^\s\p{Cc}\p{Cf}]/u.test(text);
  class VAD {
    constructor(config = {}) {
      this.config = Object.assign({threshold: .018, playback_threshold: .065,
        attack_ms: 260, playback_attack_ms: 360, hangover_ms: 650, min_speech_ms: 400,
        preroll_ms: 180, noise_floor_min: .002, noise_floor_max: .06, noise_ema_ms: 2000,
        noise_multiplier: 2.5, playback_noise_multiplier: 3, exit_ratio: .65,
        calibration_ms: 400, min_voiced_ratio: .55, barge_confirm_ms: 450,
        candidate_release_ms: 150, playback_guard_ms: 400, duck_gain: .25, duck_ramp_ms: 150,
        sensitivity_low: 1.3, sensitivity_medium: 1, sensitivity_high: .8,
        max_utterance_seconds: 30}, config);
      this.noiseFloor = this.config.noise_floor_min; this.calibratedMs = 0;
      this.reset();
    }
    reset() {
      // Preserve the learned floor between utterances and candidate rejections.
      this.recording = false; this.attack = 0; this.silence = 0;
      this.speech = 0; this.duration = 0; this.span = 0; this.streak = 0;
      this.confirmed = false; this.interruptCandidate = false;
      this.waitingCandidate = false;
      this.frames = []; this.pre = []; this.preMs = 0;
    }
    push(samples, rate, playing = false, suppressed = false, waiting = false, replyPending = playing) {
      // Echo protection follows audible output; cancellation also applies to a silent pending reply.
      const interrupting = playing || replyPending;
      const c = this.config;
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / (samples.length || 1));
      const ms = samples.length / rate * 1000;
      const clamp = x => Math.max(c.noise_floor_min, Math.min(c.noise_floor_max, x));
      const calibrating = this.calibratedMs < c.calibration_ms;
      if (!suppressed && !playing && !this.recording && (calibrating || !this.attack)) {
        const boundary = Math.max(c.threshold, this.noiseFloor * c.noise_multiplier);
        if (calibrating || rms < boundary) {
          this.noiseFloor = clamp(this.calibratedMs === 0 && calibrating ? rms :
            this.noiseFloor + (rms - this.noiseFloor) * (1 - Math.exp(-ms / c.noise_ema_ms)));
        }
        this.calibratedMs += ms;
      }
      const toolWait = waiting || this.waitingCandidate;
      const enter = Math.max(playing ? (toolWait ? Math.max(.085, c.playback_threshold * 1.3) : c.playback_threshold) : c.threshold,
        this.noiseFloor * (playing ? c.playback_noise_multiplier : c.noise_multiplier));
      const exit = enter * c.exit_ratio;
      const result = {rms, noise_floor: this.noiseFloor, enter_threshold: enter, exit_threshold: exit,
        started: false, confirmed: false, cancelled: false, ended: false, audio: null, capture: []};
      if (suppressed || calibrating) {
        // AEC/start transients cannot seed preroll or an interruption candidate.
        if (!this.confirmed) { result.cancelled = this.recording; this.reset(); }
        return result;
      }
      const high = rms >= enter, voiced = rms >= (this.recording ? exit : enter);
      if (!this.recording) {
        this.pre.push({data: new Float32Array(samples), ms}); this.preMs += ms;
        const attackMs = playing ? Math.max(350, c.playback_attack_ms) : c.attack_ms;
        const keep = c.preroll_ms + attackMs;
        while (this.pre.length > 1 && this.preMs - this.pre[0].ms >= keep) this.preMs -= this.pre.shift().ms;
        this.attack = high ? this.attack + ms : 0;
        if (this.attack < attackMs) return result;
        this.recording = true; this.interruptCandidate = interrupting;
        this.waitingCandidate = interrupting && waiting;
        this.frames = this.pre.map(x => x.data); this.duration = this.preMs;
        this.speech = this.span = this.streak = this.attack;
        this.pre = []; this.preMs = 0; result.started = true;
        result.capture = this.frames.slice();
      } else {
        this.frames.push(new Float32Array(samples)); this.duration += ms;
        result.capture = [this.frames[this.frames.length - 1]];
        if (voiced) this.speech += ms;
        this.span += ms;
        this.streak = high ? this.streak + ms : 0;
      }
      this.silence = voiced ? 0 : this.silence + ms;
      if (this.interruptCandidate && !this.confirmed && this.streak >= Math.max(toolWait ? 900 : 450, c.barge_confirm_ms)) {
        this.confirmed = result.confirmed = true;
      }
      const candidateFaded = this.interruptCandidate && !this.confirmed && this.silence >= c.candidate_release_ms;
      result.cancelled = candidateFaded;
      if (candidateFaded || this.silence >= c.hangover_ms || this.duration >= c.max_utterance_seconds * 1000) {
        result.ended = true;
        result.voice_ms = this.speech;
        result.voiced_ratio = this.speech / Math.max(this.speech, this.span - this.silence);
        if ((!this.waitingCandidate || this.confirmed) &&
            this.speech >= c.min_speech_ms && result.voiced_ratio >= c.min_voiced_ratio) {
          const length = this.frames.reduce((n, x) => n + x.length, 0);
          const max = Math.floor(rate * c.max_utterance_seconds);
          const audio = new Float32Array(Math.min(length, max));
          let offset = 0;
          for (const f of this.frames) {
            if (offset >= audio.length) break;
            const part = f.subarray(0, audio.length - offset); audio.set(part, offset); offset += part.length;
          }
          result.audio = audio;
        }
        this.reset();
      }
      return result;
    }
  }

  function pcm16(samples) {
    const out = new ArrayBuffer(samples.length * 2), view = new DataView(out);
    samples.forEach((x, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, x)) * (x < 0 ? 32768 : 32767)), true));
    return out;
  }

  function resample(samples, from, to) {
    if (from === to) return new Float32Array(samples);
    const out = new Float32Array(Math.floor(samples.length * to / from));
    for (let i = 0; i < out.length; i++) {
      const pos = i * from / to, at = Math.floor(pos), next = Math.min(at + 1, samples.length - 1);
      out[i] = samples[at] * (1 - (pos - at)) + samples[next] * (pos - at);
    }
    return out;
  }

  class PCMStream {
    constructor(from, to) { this.from = from; this.to = to; this.base = 0; this.next = 0; this.count = 0; this.tail = new Float32Array(); }
    push(samples, final = false) {
      const data = new Float32Array(this.tail.length + samples.length);
      data.set(this.tail); data.set(samples, this.tail.length);
      const end = this.base + data.length, out = [];
      while (this.count < Math.floor(end * this.to / this.from) && (final || this.next < end - 1)) {
        const pos = this.next - this.base, at = Math.floor(pos), f = pos - at;
        out.push(data[at] * (1 - f) + data[Math.min(at + 1, data.length - 1)] * f);
        this.next = ++this.count * this.from / this.to;
      }
      const keep = Math.min(data.length, Math.max(0, Math.floor(this.next) - this.base));
      this.tail = data.slice(keep); this.base += keep;
      return new Uint8Array(pcm16(new Float32Array(out)));
    }
  }

  // At most 128 KiB in JS plus 16 KiB queued in the socket. Never queue an
  // entire long utterance in WebSocket.send; abort rather than grow on slow links.
  class UploadQueue {
    constructor(socket, {send, end, fail, now = () => performance.now(), high = 16384, limit = 131072} = {}) {
      Object.assign(this, {socket, send, end, fail, now, high, limit});
      this.queue = []; this.bytes = 0; this.finished = false; this.closed = false;
      this.lastFrame = null; this.started = now(); this.tail = new Uint8Array();
    }
    push(bytes) {
      if (this.closed) return;
      const data = new Uint8Array(this.tail.length + bytes.length);
      data.set(this.tail); data.set(bytes, this.tail.length);
      let i = 0;
      for (; i + 4096 <= data.length; i += 4096) {
        this.queue.push(data.slice(i, i + 4096)); this.bytes += 4096;
      }
      this.tail = data.slice(i);
      if (this.bytes + this.tail.length > this.limit) return this.abort(true);
      this.pump();
    }
    pump() {
      if (this.closed) return;
      if (this.socket.readyState !== 1 || this.now() - this.started > 35000) return this.abort(true);
      while (this.queue.length && this.socket.bufferedAmount + this.queue[0].length <= this.high) {
        const frame = this.queue.shift(); this.bytes -= frame.length;
        this.send(frame.buffer); this.lastFrame = this.now();
      }
      if (this.finished && !this.queue.length) {
        this.closed = true; this.end(this.lastFrame ?? this.now());
      }
    }
    finish() {
      if (this.tail.length) { this.queue.push(this.tail); this.bytes += this.tail.length; this.tail = new Uint8Array(); }
      this.finished = true; this.pump();
    }
    abort(notify = false) { this.closed = true; this.queue = []; this.bytes = 0; this.tail = new Uint8Array(); if (notify) this.fail(); }
  }

  class Receipts {
    constructor() { this.epoch = 0; this.segments = new Map(); this.order = []; }
    start(id, text) {
      if (this.segments.has(id)) throw Error('duplicate_segment');
      this.segments.set(id, {id, text, received: 0, played: 0, total: null, reported: false, seq: 0});
      this.order.push(id);
    }
    received(id, samples, seq) {
      const s = this.segments.get(id);
      if (!s || s.seq !== seq || samples <= 0 || s.total !== null) throw Error('audio_order');
      s.received += samples; s.seq++;
      return this.epoch;
    }
    ended(id, samples, epoch) {
      if (epoch !== this.epoch) return [];
      const s = this.segments.get(id);
      if (!s || samples < 0 || s.played + samples > s.received) throw Error('playback_accounting');
      s.played += samples;
      return this.ready();
    }
    seal(id, total) {
      const s = this.segments.get(id);
      if (!s || s.received !== total) throw Error('truncated_segment');
      s.total = total;
      return this.ready();
    }
    ready() {
      const ready = [];
      for (const id of this.order) {
        const s = this.segments.get(id);
        if (s.reported) continue;
        if (s.total === null || s.played !== s.total) break;
        s.reported = true;
        ready.push({segment_id: id, samples: s.total, text: s.text});
      }
      return ready;
    }
    cancel() {
      // onended also fires when stop() is called; those callbacks must not count.
      this.epoch++; this.segments.clear(); this.order = [];
    }
  }
  // Policy only: the page owns AudioBuffers and receipt epochs. No media is retained here.
  class Prebuffer {
    constructor({ms = 1500, maxWait = 2500, rebuffer = 600, rebufferMaxWait = 300,
      now, later, cancel, flush}) {
      Object.assign(this, {ms, maxWait, rebuffer, rebufferMaxWait, now, later, cancel, flush});
      this.first = true; this.firstPCM = null; this.waitAt = null; this.done = false;
      this.segments = new Set(); this.reason = 0; this.rebuffers = 0; this.rebufferTime = 0;
    }
    receive(segment, dry) {
      if (this.firstPCM === null) this.firstPCM = this.now();
      this.segments.add(segment);
      if (this.waitAt === null && (this.first || dry)) {
        this.waitAt = this.now();
        if (!this.first && !this.done && this.rebuffer) this.rebuffers++;
        const wait = this.first ? this.maxWait : this.rebufferMaxWait;
        this.timer = this.later(() => { this.timer = null; this.flush(); }, wait);
      }
    }
    release(queued) {
      if (this.waitAt === null) return true;
      const threshold = this.first ? this.ms : this.rebuffer;
      const limit = this.first ? this.maxWait : this.rebufferMaxWait;
      // Numeric reasons: buffered=1, next_segment=2, done=3, timeout=4.
      const reason = this.done ? 3 : queued + .001 >= threshold ? 1 :
        this.first && this.segments.size > 1 ? 2 : this.now() - this.waitAt >= limit ? 4 : 0;
      if (!reason) return false;
      if (this.first) this.reason = reason;
      else if (threshold) this.rebufferTime += this.now() - this.waitAt;
      this.first = false; this.waitAt = null; this.cancel(this.timer); this.timer = null;
      return true;
    }
    finish() { this.done = true; this.flush(); }
    dispose() { this.cancel(this.timer); this.timer = null; }
  }
  // Subtitles are the only text source. Segment text supplies ordered offsets,
  // never a second copy to append. All reply content is kept in RAM only.
  class TextSync {
    constructor({now, audio, render, metrics, later = setTimeout, cancel = clearTimeout, enabled = true}) {
      Object.assign(this, {now, audio, render, metrics, later, cancel, enabled});
      this.text = ''; this.arrivals = []; this.segments = []; this.visible = 0;
      this.mapped = 0; this.allowed = 0; this.waiting = now(); this.reveals = [];
      this.forced = false; this.done = false; this.textSeq = 0;
    }
    subtitle(text, sequence) {
      if (!hasBody(text)) return;
      // SSE replay and a transport handover can repeat a subtitle. Old servers
      // omit sequence; their existing ordered transport remains supported.
      if (sequence !== undefined) {
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw Error('text_order');
        if (sequence <= this.textSeq) return;
        if (sequence !== this.textSeq + 1) throw Error('text_order');
        this.textSeq = sequence;
      }
      this.dirty = true;
      this.arrivals.push({start: this.text.length, end: this.text.length + text.length, at: this.now()});
      if (this.visible === this.text.length) this.waiting = this.now();
      this.text += text; this.tick();
    }
    segment(id, text) {
      if (!hasBody(text)) return;
      if (this.segments.some(s => s.id === id)) return;
      this.dirty = true;
      this.segments.push({id, start: this.mapped, end: this.mapped + text.length, at: null, measured: false});
      this.mapped += text.length; this.tick();
    }
    schedule(id, at) {
      const s = this.segments.find(s => s.id === id);
      if (s && s.at === null) s.at = at;
      this.tick();
    }
    setEnabled(value) { this.enabled = value; this.dirty = true; this.tick(); }
    finish() { this.done = true; this.dirty = true; this.tick(); }
    interrupt() { this.forced = true; this.dirty = true; this.tick(); }
    dispose() { this.cancel(this.timer); }
    stats() {
      const units = [...this.segments];
      // TTS never emits a boundary for a failed/unprepared suffix. Treat that
      // suffix as one provisional unit; replace it with real boundaries later.
      if (this.text.length > this.mapped) units.push({start: this.mapped, end: this.text.length});
      const values = []; let fallbacks = 0;
      for (const s of units) {
        const arrival = this.arrivals.find(a => a.end > s.start);
        const reveal = this.reveals.find(r => r.end > s.start);
        if (!arrival || !reveal) continue;
        values.push(Math.max(0, reveal.at - arrival.at));
        if (reveal.fallback) fallbacks++;
      }
      values.sort((a, b) => a - b);
      return {count: units.length, duration: values.length ? values[Math.ceil(values.length / 2) - 1] : 0,
        rtt: values.length ? values[values.length - 1] : 0, reason: fallbacks};
    }
    tick() {
      this.cancel(this.timer); this.timer = null;
      const now = this.now(), audio = this.audio();
      // Poll the audio clock: wall timers alone run early when a context suspends.
      for (const s of this.segments) {
        if (s.at !== null && audio.running && audio.time >= s.at) this.allowed = Math.max(this.allowed, s.end);
      }
      if (audio.pending && audio.running) this.waiting = now;
      const fallback = this.forced || (this.done && !audio.pending) || now - this.waiting >= 3000;
      const end = !this.enabled || fallback ? this.text.length : Math.min(this.allowed, this.text.length);
      if (end > this.visible) {
        this.dirty = true;
        const from = this.visible;
        this.visible = end; this.render(this.text.slice(0, end));
        this.reveals.push({start: from, end, at: now, fallback: this.enabled && fallback && end > this.allowed});
      }
      if (this.dirty) {
        this.dirty = false;
        const stats = {...this.stats(), clean: Number(this.done || this.forced)}, key = JSON.stringify({...stats, enabled: this.enabled});
        if (key !== this.lastStats) { this.lastStats = key; this.metrics(stats); }
      }
      if (!this.forced && this.visible < this.text.length) {
        this.timer = this.later(() => this.tick(), 25);
      }
    }
  }
  return {VAD, Receipts, PCMStream, UploadQueue, TextSync, Prebuffer, resample, pcm16, hasBody};
});
