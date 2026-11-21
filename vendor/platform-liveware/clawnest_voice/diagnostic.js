/* Synthetic traffic metrics shared by the webview and local node tests. */
(function(root) {
  'use strict';
  function isPacket(buffer) {
    return buffer.byteLength >= 24 && new DataView(buffer).getUint32(0) === 0x56443333;
  }
  function packet(run, seq, size, sent = Date.now()) {
    const buffer = new ArrayBuffer(size), v = new DataView(buffer);
    v.setUint32(0, 0x56443333); v.setUint32(4, run); v.setUint32(8, seq);
    v.setFloat64(12, sent); v.setUint32(20, size);
    return buffer;
  }
  class Stats {
    constructor(run) {
      this.run = run; this.count = 0; this.bytes = 0; this.seen = new Set(); this.high = -1;
      this.out_of_order = 0; this.duplicates = 0; this.max_gap_ms = 0; this.jitter_ms = 0;
      this.lastArrival = null; this.lastSent = null;
    }
    receive(buffer, now = performance.now()) {
      const v = new DataView(buffer);
      if (!isPacket(buffer) || v.getUint32(4) !== this.run || v.getUint32(20) !== buffer.byteLength || !Number.isFinite(v.getFloat64(12))) throw Error('diagnostic_packet');
      const seq = v.getUint32(8), sent = v.getFloat64(12);
      if (seq > 10000 || this.count >= 10000) throw Error('diagnostic_limit');
      if (this.seen.has(seq)) this.duplicates++;
      else if (seq < this.high) this.out_of_order++;
      this.seen.add(seq); this.high = Math.max(this.high, seq);
      if (this.lastArrival !== null) {
        const gap = now - this.lastArrival;
        this.max_gap_ms = Math.max(this.max_gap_ms, gap);
        this.jitter_ms += (Math.abs(gap - (sent - this.lastSent)) - this.jitter_ms) / 16;
      }
      this.lastArrival = now; this.lastSent = sent; this.count++; this.bytes += buffer.byteLength;
    }
    summary(expected = this.high + 1) {
      return {run: this.run, count: this.count, bytes: this.bytes, missing: Math.max(0, expected - this.seen.size),
        out_of_order: this.out_of_order, duplicates: this.duplicates,
        max_gap_ms: +this.max_gap_ms.toFixed(3), jitter_ms: +this.jitter_ms.toFixed(3)};
    }
  }
  const api = {isPacket, packet, Stats};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceDiagnostic = api;
})(typeof window !== 'undefined' ? window : globalThis);
