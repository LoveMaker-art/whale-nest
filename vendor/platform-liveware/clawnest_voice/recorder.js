/* Numeric-only phone telemetry. Never accept exception messages or media data. */
(function (root) {
  'use strict';
  const kinds = ['ws_open', 'ws_error', 'ws_close', 'message', 'send', 'context', 'track_mute',
    'track_unmute', 'track_ended', 'settings', 'visibility', 'pagehide', 'freeze', 'resume',
    'online', 'offline', 'connection', 'play_start', 'underrun', 'play_end', 'error', 'longtask', 'timing'];
  const fields = ['code', 'reason', 'reason_length', 'clean', 'ready', 'type', 'count', 'buffered',
    'state', 'rate', 'channels', 'echo', 'noise', 'agc', 'muted', 'hidden', 'duration', 'downlink',
    'rtt', 'save', 'online', 'samples', 't_vad_start', 't_vad_end', 't_last_frame_sent', 't_first_audio_played'];
  const storageKey = 'clawchat.voice.events.pending';
  const failureKey = 'clawchat.voice.failures.v2';
  const failureFields = ['snapshot_id', 'utc', 'build_id', 'protocol_version', 'transport', 'close_code',
    'ready', 'bytes', 'frames', 'playback_error', 'context'];
  function cleanFailure(value) {
    if (!value || !failureFields.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0) ||
        !Array.isArray(value.events)) return null;
    const clean = Object.fromEntries(failureFields.map(k => [k, value[k]]));
    clean.events = value.events.slice(-20).flatMap(e => {
      if (!e || !Number.isInteger(e.event) || e.event < 1 || e.event > kinds.length ||
          !Number.isFinite(e.utc) || !Number.isFinite(e.ms)) return [];
      const event = {utc: e.utc, ms: e.ms, event: e.event};
      for (const k of fields) if (typeof e[k] === 'number' && Number.isFinite(e[k]) && e[k] >= -1 && e[k] <= 1e12) event[k] = e[k];
      return [event];
    });
    return clean;
  }
  const state = value => ({running: 1, suspended: 2, interrupted: 3, closed: 4, live: 5, ended: 6})[value] || 0;
  const reason = value => ({ended: 1, idle: 2, session_limit: 3, quota_exceeded: 4, preempted: 5, disconnected: 6, shutdown: 7})[value] || 0;
  const messageType = value => ['session', 'error', 'info', 'session_end', 'clear', 'transcript', 'turn', 'subtitle',
    'segment_start', 'audio', 'segment_end', 'tts_done', 'turn_complete', 'debug', 'pong', 'binary',
    'sse_ready', 'diagnostic_binary', 'diagnostic_started', 'diagnostic_done', 'diagnostic_summary_ack', 'downstream_transport'].indexOf(value) + 1;
  class Recorder {
    constructor({now = () => Date.now(), perf = () => performance.now(), storage, fetcher, beacon, url = 'phone-events', limit = 300} = {}) {
      Object.assign(this, {now, perf, storage, fetcher, beacon, url, limit});
      this.events = []; this.owner = false; this.counts = new Map();
      this.failures = []; this.failureSeq = 0;
      try {
        const stored = JSON.parse(this.storage?.getItem(failureKey) || '[]');
        if (Array.isArray(stored)) this.failures = stored.map(cleanFailure).filter(Boolean).slice(-4);
      } catch (_) {}
    }
    add(kind, data = {}) {
      const type = kinds.indexOf(kind) + 1;
      if (!type) return;
      const entry = {utc: this.now(), ms: this.perf(), event: type};
      for (const key of fields) {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1e12) entry[key] = value;
      }
      this.events.push(entry);
      if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    }
    message(type) {
      const id = messageType(type), count = (this.counts.get(id) || 0) + 1;
      this.counts.set(id, count); this.add('message', {type: id, count});
    }
    snapshot() { return {version: 1, events: this.events.map(e => ({...e}))}; }
    save(value) { try { this.storage?.setItem(storageKey, JSON.stringify(value)); } catch (_) {} }
    async upload(value) {
      if (!value) value = this.snapshot();
      // Persisted storage can be edited independently of this module.
      value = {version: 1, events: (Array.isArray(value.events) ? value.events : []).slice(-this.limit).flatMap(e => {
        if (!e || !Number.isInteger(e.event) || e.event < 1 || e.event > kinds.length ||
            !Number.isFinite(e.utc) || !Number.isFinite(e.ms)) return [];
        const clean = {utc: e.utc, ms: e.ms, event: e.event};
        for (const key of fields) if (typeof e[key] === 'number' && Number.isFinite(e[key]) && e[key] >= -1 && e[key] <= 1e12) clean[key] = e[key];
        return [clean];
      })};
      this.save(value);
      if (!this.owner) return false;
      const body = JSON.stringify(value);
      try {
        if (this.fetcher) {
          const response = await this.fetcher(this.url, {method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'}, body, keepalive: true});
          if (response.ok) {
            try { if (this.storage?.getItem(storageKey) === body) this.storage.removeItem(storageKey); } catch (_) {}
            return true;
          }
        }
      } catch (_) {}
      try { this.beacon?.(this.url, body); } catch (_) {}
      // Beacon has no acknowledgement: retain the snapshot for the next session.
      return false;
    }
    saveFailures() {
      try {
        if (this.failures.length) this.storage?.setItem(failureKey, JSON.stringify(this.failures));
        else this.storage?.removeItem(failureKey);
      } catch (_) {}
    }
    captureFailure(data) {
      const snapshot = cleanFailure({...data, snapshot_id: this.now() * 1000 + this.failureSeq++ % 1000,
        utc: this.now(), events: this.events.slice(-20)});
      if (!snapshot) return false;
      this.failures.push(snapshot); this.failures = this.failures.slice(-4); this.saveFailures();
      return this.uploadFailures();
    }
    async uploadFailures() {
      if (!this.owner || !this.failures.length) return false;
      const pending = this.failures.slice(), body = JSON.stringify({version: 2, snapshots: pending});
      try {
        const response = await this.fetcher?.(this.url, {method: 'POST', credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'}, body, keepalive: true});
        if (response?.ok) {
          const ids = new Set(pending.map(s => s.snapshot_id));
          this.failures = this.failures.filter(s => !ids.has(s.snapshot_id)); this.saveFailures(); return true;
        }
      } catch (_) {}
      try { this.beacon?.(this.url, body); } catch (_) {}
      return false;
    }
    async start(owner) {
      this.owner = owner;
      if (!owner) return;
      try {
        const stored = JSON.parse(this.storage?.getItem(failureKey) || '[]');
        if (Array.isArray(stored)) this.failures = [...stored, ...this.failures].map(cleanFailure).filter(Boolean)
          .filter((s, i, all) => all.findIndex(v => v.snapshot_id === s.snapshot_id) === i).slice(-4);
      } catch (_) {}
      await this.uploadFailures();
      let pending;
      try { pending = JSON.parse(this.storage?.getItem(storageKey) || 'null'); } catch (_) {}
      if (pending && pending.version === 1 && Array.isArray(pending.events)) await this.upload(pending);
    }
    failure(kind, data) { this.add(kind, data); return this.upload(); }
    text() { return this.events.map(e => new Date(e.utc).toISOString() + ' ' + JSON.stringify(e)).join('\n') + '\n' + JSON.stringify({failures: this.failures}); }
  }
  const api = {Recorder, kinds, fields, state, reason, messageType};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceRecorder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
