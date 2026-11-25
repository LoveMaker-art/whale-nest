/* melody.js — the page's half of "哼一段 / 画一段".

   The transcription here is the JS twin of tools/hum2abc.py: the same steps, the same
   constants under the same names, the same rounding (half up), the same ABC writer. Two
   runtimes, one algorithm; tests/melody_test.mjs runs this file over the recordings
   tests/hum_vectors.py makes and demands byte-identical ABC. When you change a constant,
   change it in both files or that test is the thing that tells you.

   Why the page transcribes itself instead of uploading the audio: the tunnel is slow and
   strips POST bodies (docs/handoff.md §3), a 15-second hum is 50–500 KB while its score is
   under 2 KB — and hearing your own tune drawn as you hum it is the whole point.

   Browser-only extras live at the bottom: Recorder (mic + metronome), player, piano-roll
   drawing, and the doodle → events mapping. None of them is needed by the node test. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Melody = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ── constants: identical to tools/hum2abc.py ─────────────────────────────────────
  const SR = 16000, W = 512, HOP = 160, TAU_MIN = 16, TAU_MAX = 267;
  const YIN_THRESHOLD = 0.15, VOICED_CMND = 0.35, GATE_REL = 0.08, MEDIAN_K = 5;
  const PITCH_SPLIT = 0.65, SPLIT_FRAMES = 3, DIP_RATIO = 0.5, ATTACK_RATIO = 1.6, MIN_NOTE_S = 0.06;
  const UNITS_PER_BAR = 16, BEATS_PER_BAR = 4, PHRASE_GAP_UNITS = 3, PHRASE_MAX_UNITS = 32;
  const TIDY_GRID = 2;                              // 整理：节奏落到八分音符（2 个 1/16 单位）
  const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11], SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
  const TARGET_MEDIAN = { auto: 72, female: 76, male: 69 };
  const DURATIONS = [16, 12, 8, 6, 4, 3, 2, 1];
  const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const MAJOR_KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const MINOR_KEYS = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
  const KEY_SHARPS = {};
  ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"].forEach((k, i) => KEY_SHARPS[k] = i - 7);
  ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"].forEach((k, i) => KEY_SHARPS[k] = i - 7);
  const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const HEADER = ["X:1", "T:", "M:4/4", "L:1/" + UNITS_PER_BAR, "Q:1/4={bpm}",
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."', "K:{key}"];

  const rnd = x => Math.floor(x + 0.5);
  const mod1 = x => ((x % 1) + 1) % 1;
  const numsort = a => a.slice().sort((x, y) => x - y);
  const median = a => { const s = numsort(a); return s[Math.floor(s.length / 2)]; };

  // ── 2. pitch track ───────────────────────────────────────────────────────────────
  function percentile95(a) {                        // numpy's default (linear) percentile
    const s = numsort(Array.from(a));
    if (!s.length) return 0;
    const pos = 0.95 * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /* One YIN frame (2*W samples starting at `off`): {tau (float, -1 when unvoiced), cmnd} */
  function yinFrame(pcm, off) {
    const d = new Float64Array(TAU_MAX + 1);
    for (let tau = 1; tau <= TAU_MAX; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const x = pcm[off + j] - pcm[off + j + tau]; s += x * x; }
      d[tau] = s;
    }
    const cmnd = new Float64Array(TAU_MAX + 1);
    cmnd[0] = 1;
    let cum = 0;
    for (let tau = 1; tau <= TAU_MAX; tau++) { cum += d[tau]; cmnd[tau] = d[tau] * tau / Math.max(cum, 1e-12); }
    let best = -1, tau = TAU_MIN;
    while (tau <= TAU_MAX) {
      if (cmnd[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= TAU_MAX && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau; break;
      }
      tau++;
    }
    if (best < 0) { best = TAU_MIN; for (let t = TAU_MIN + 1; t <= TAU_MAX; t++) if (cmnd[t] < cmnd[best]) best = t; }
    let t = best;
    if (best > TAU_MIN && best < TAU_MAX) {
      const y0 = cmnd[best - 1], y1 = cmnd[best], y2 = cmnd[best + 1], den = y0 - 2 * y1 + y2;
      if (den > 0) t += Math.max(-1, Math.min(1, (y0 - y2) / (2 * den)));
    }
    return { tau: t, cmnd: cmnd[best] };
  }

  function track(input) {
    let n0 = input.length, mean = 0;
    for (let i = 0; i < n0; i++) mean += input[i];
    mean = n0 ? mean / n0 : 0;
    const pcm = new Float64Array(n0);
    let peak = 0;
    for (let i = 0; i < n0; i++) { pcm[i] = input[i] - mean; peak = Math.max(peak, Math.abs(pcm[i])); }
    if (peak > 0) for (let i = 0; i < n0; i++) pcm[i] *= 0.9 / peak;
    const n = n0 < 2 * W ? 0 : 1 + Math.floor((n0 - 2 * W) / HOP);
    const times = new Float64Array(n), midi = new Float64Array(n).fill(NaN), rms = new Float64Array(n);
    const voiced = new Uint8Array(n), raw = [];
    for (let i = 0; i < n; i++) {
      const off = i * HOP;
      times[i] = (off + W) / SR;
      let e = 0;
      for (let j = 0; j < 2 * W; j++) e += pcm[off + j] * pcm[off + j];
      rms[i] = Math.sqrt(e / (2 * W));
      raw.push(yinFrame(pcm, off));
    }
    const gate = Math.max(1e-4, GATE_REL * percentile95(rms));
    for (let i = 0; i < n; i++) {
      if (raw[i].cmnd < VOICED_CMND && rms[i] >= gate) {
        midi[i] = 69 + 12 * Math.log2(SR / raw[i].tau / 440);
        voiced[i] = 1;
      }
    }
    const out = Float64Array.from(midi), h = Math.floor(MEDIAN_K / 2);
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      const vals = [];
      for (let j = Math.max(0, i - h); j < Math.min(n, i + h + 1); j++) if (voiced[j]) vals.push(midi[j]);
      if (vals.length >= 3) out[i] = median(vals);
    }
    return { times, midi: out, rms, voiced };
  }

  // ── 3. notes ─────────────────────────────────────────────────────────────────────
  function closeNote(cur, times, midi) {
    const fr = cur.frames;
    return { on: times[fr[0]], off: times[fr[fr.length - 1]] + HOP / SR, midi: rnd(median(fr.map(f => midi[f]))) };
  }

  function segment(times, midi, rms, voiced) {
    const n = times.length, notes = [];
    let i = 0;
    while (i < n) {
      if (!voiced[i]) { i++; continue; }
      let j = i;
      while (j < n) {
        if (voiced[j]) j++;
        else if (j + 1 < n && voiced[j + 1]) j++;
        else if (j + 2 < n && voiced[j + 2]) j += 2;
        else break;
      }
      let cur = null, pend = 0;
      for (let k = i; k < j; k++) {
        if (!voiced[k]) continue;
        const m = midi[k];
        if (cur === null) { cur = { frames: [k], peak: rms[k], floor: rms[k], dip: false }; pend = 0; continue; }
        const med = median(cur.frames.slice(-7).map(f => midi[f]));
        if (Math.abs(m - med) > PITCH_SPLIT) pend++; else pend = 0;
        let attack = false;
        if (rms[k] < DIP_RATIO * cur.peak) { cur.dip = true; cur.floor = Math.min(cur.floor, rms[k]); }
        else if (cur.dip && rms[k] > ATTACK_RATIO * cur.floor) attack = true;
        if (pend >= SPLIT_FRAMES) {
          const moved = SPLIT_FRAMES > 1 ? cur.frames.slice(-(SPLIT_FRAMES - 1)) : [];
          cur.frames = cur.frames.slice(0, cur.frames.length - moved.length);
          if (cur.frames.length) notes.push(closeNote(cur, times, midi));
          cur = { frames: moved.concat([k]), peak: Math.max(...moved.map(f => rms[f]), rms[k]), floor: rms[k], dip: false };
          pend = 0;
        } else if (attack) {
          notes.push(closeNote(cur, times, midi));
          cur = { frames: [k], peak: rms[k], floor: rms[k], dip: false };
          pend = 0;
        } else {
          cur.frames.push(k);
          if (rms[k] > cur.peak && !cur.dip) cur.peak = rms[k];
          if (cur.dip) cur.floor = Math.min(cur.floor, rms[k]);
        }
      }
      if (cur !== null && cur.frames.length) notes.push(closeNote(cur, times, midi));
      i = j;
    }
    return notes.filter(x => x.off - x.on >= MIN_NOTE_S);
  }

  // ── 4. tempo ─────────────────────────────────────────────────────────────────────
  function estimateBpm(notes) {
    const onsets = notes.map(x => x.on);
    if (onsets.length < 4) return { bpm: 96, err: 0.5 };
    const origin = onsets[0];
    let best = 96, bestErr = 1.0;
    for (let bpm = 50; bpm <= 180; bpm++) {
      const g = 60 / bpm / 2;
      let err = 0;
      for (const on of onsets) { const frac = mod1((on - origin) / g); err += Math.min(frac, 1 - frac); }
      err /= onsets.length;
      const score = err + 0.06 * Math.abs(Math.log2(bpm / 96));
      if (score < bestErr) { best = bpm; bestErr = score; }
    }
    return { bpm: best, err: bestErr };
  }

  // ── 5. quantize ──────────────────────────────────────────────────────────────────
  function quantize(notes, bpm, origin) {
    const grid = 60 / bpm / (UNITS_PER_BAR / BEATS_PER_BAR);
    const res = numsort(notes.map(x => mod1((x.on - origin) / grid + 0.5) - 0.5));
    if (res.length) origin += res[Math.floor(res.length / 2)] * grid;
    const ev = notes.map(x => {
      const on = Math.max(0, rnd((x.on - origin) / grid)), off = rnd((x.off - origin) / grid);
      return [on, Math.max(1, off - on), x.midi, x.off - x.on];
    });
    ev.sort((a, b) => (a[0] - b[0]) || (b[3] - a[3]));
    const out = [];
    for (const e of ev) {
      if (out.length && e[0] === out[out.length - 1][0]) continue;
      if (out.length && e[0] < out[out.length - 1][0] + out[out.length - 1][1])
        out[out.length - 1][1] = Math.max(1, e[0] - out[out.length - 1][0]);
      out.push(e);
    }
    return { events: out.map(e => [e[0], e[1], e[2]]), origin };
  }

  /* ── 整理（PM 2026-09-21：用户给的是变量，不是谱）──
     人哼的不准也不齐；模型却逐音兑现谱上写的一切。所以在谱写出来之前先整理成「能唱的调」：
     节奏落到八分音符网格（哼唱里的十六分多半是抖，不是意图）、离中位一个八度以上的音折回来、
     不在调上的音吸到相邻的调内音（顺着旋律走向）。轮廓是他的，细节交给规矩。两端同一套。 */
  function tidyRhythm(events) {
    const ev = events.map(([on, dur, m]) => {
      const on2 = rnd(on / TIDY_GRID) * TIDY_GRID;
      let off2 = rnd((on + dur) / TIDY_GRID) * TIDY_GRID;
      if (off2 <= on2) off2 = on2 + TIDY_GRID;
      return [on2, off2 - on2, m, dur];
    });
    ev.sort((a, b) => (a[0] - b[0]) || (b[3] - a[3]));
    const out = [];
    for (const e of ev) {
      if (out.length && e[0] === out[out.length - 1][0]) continue;
      if (out.length && e[0] < out[out.length - 1][0] + out[out.length - 1][1])
        out[out.length - 1][1] = e[0] - out[out.length - 1][0];
      out.push(e);
    }
    return out.map(e => [e[0], e[1], e[2]]);
  }

  function scaleOf(key) {
    const minor = key.endsWith("m");
    const tonic = { C: 0, "C#": 1, Db: 1, D: 2, Eb: 3, "D#": 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, Ab: 8, "G#": 8, A: 9, Bb: 10, "A#": 10, B: 11, Cb: 11 }[minor ? key.slice(0, -1) : key];
    return (minor ? SCALE_MINOR : SCALE_MAJOR).map(d => (d + tonic) % 12);
  }

  /* 八度滑脱折回：和前一个（已折）音差超过一个八度的按八度折回，不越过它 —— 走向不翻 */
  function foldOctaves(events) {
    const out = [];
    let prev = null;
    for (const [on, dur, m0] of events) {
      let m = m0;
      if (prev !== null) { while (m - prev > 12) m -= 12; while (prev - m > 12) m += 12; }
      out.push([on, dur, m]); prev = m;
    }
    return out;
  }
  const step = (a, b) => b > a ? 1 : b < a ? -1 : 0;
  const scaleStep = (scale, frm, dir) => { let p = frm + dir; while (!scale.includes(((p % 12) + 12) % 12)) p += dir; return p; };

  /* 走向先按折过的原线定（原来相等的两个音仍然相等），不在调上的音顺着走向移一个半音，
     再对着真正写下的前一个音核一遍 —— 一步都不翻。和 hum2abc.tidy_pitch 逐音相同。 */
  function tidyPitch(events, key) {
    if (!events.length) return events;
    const scale = scaleOf(key), folded = foldOctaves(events), out = [];
    for (let i = 0; i < folded.length; i++) {
      const [on, dur] = folded[i];
      let m = folded[i][2];
      const d = i ? step(folded[i - 1][2], m) : 1;
      if (!scale.includes(((m % 12) + 12) % 12)) { const dd = d || 1; m = scale.includes((((m + dd) % 12) + 12) % 12) ? m + dd : m - dd; }
      if (out.length) {
        const prev = out[out.length - 1][2];
        if (d === 0) m = prev;
        else if (d > 0 && m <= prev) m = scaleStep(scale, prev, 1);
        else if (d < 0 && m >= prev) m = scaleStep(scale, prev, -1);
      }
      out.push([on, dur, m]);
    }
    return out;
  }

  /* ── songlike：神似但好听优先（PM 2026-09-21）── 不成调的哼唱也该变成一首好听、而且像它的歌。
     像它的：每一步的走向（升 / 降 / 平）、乐句、节奏骨架。让步的：音程（压到五度以内、方向不变）、
     句尾（落到和弦音）、结尾（主音或五音，拖长）、不在调上的音。一趟走完，每个音在规则下挑离原来最近的。
     和 hum2abc.py 的 songlike() 逐音相同。 */
  const MAX_LEAP = 7, STABLE_MAJOR = [0, 4, 7], STABLE_MINOR = [0, 3, 7], FINAL = [0, 7], PHRASE_END_MIN = 4, FINAL_MIN = 8;
  const TONIC_PC = { C: 0, "C#": 1, Db: 1, D: 2, Eb: 3, "D#": 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, Ab: 8, "G#": 8, A: 9, Bb: 10, "A#": 10, B: 11, Cb: 11 };
  const pcOf = p => ((p % 12) + 12) % 12;
  const closest = (cands, m) => cands.reduce((b, p) => (b === null || Math.abs(p - m) < Math.abs(b - m) || (Math.abs(p - m) === Math.abs(b - m) && p < b)) ? p : b, null);

  function songlike(events, key) {
    if (events.length < 2) return events.map(e => e.slice());
    const minor = key.endsWith("m"), scale = scaleOf(key), tonic = TONIC_PC[minor ? key.slice(0, -1) : key];
    const stable = (minor ? STABLE_MINOR : STABLE_MAJOR).map(d => (d + tonic) % 12), fin = FINAL.map(d => (d + tonic) % 12);
    // 句尾 = 真换气的地方（后面有休止），不是为了好唱而切开的连唱
    const ends = new Set();
    for (let i = 1; i < events.length; i++) { const a = events[i - 1]; if (events[i][0] - (a[0] + a[1]) >= PHRASE_GAP_UNITS) ends.add(a[0] + a[1]); }
    const lastEnd = events[events.length - 1][0] + events[events.length - 1][1];
    const out = [];
    let prev = null;
    for (let i = 0; i < events.length; i++) {
      const [on, dur, m] = events[i], isEnd = ends.has(on + dur), isFinal = on + dur === lastEnd;
      const pcs = isFinal ? fin : isEnd ? stable : scale;
      let nu;
      if (prev === null) {
        const cands = []; for (let p = m - 12; p <= m + 12; p++) if (pcs.includes(pcOf(p))) cands.push(p);
        nu = closest(cands, m);
      } else {
        const pm = events[i - 1][2], want = m === pm ? 0 : m > pm ? 1 : -1;
        if (want === 0) {
          nu = prev;
          if ((isEnd || isFinal) && !pcs.includes(pcOf(prev))) {
            const cands = []; for (let p = prev - 2; p <= prev + 2; p++) if (pcs.includes(pcOf(p))) cands.push(p);
            nu = cands.length ? closest(cands, prev) : prev;
          }
        } else {
          const lo = want > 0 ? prev + 1 : prev - MAX_LEAP, hi = want > 0 ? prev + MAX_LEAP : prev - 1;
          let cands = []; for (let p = lo; p <= hi; p++) if (pcs.includes(pcOf(p))) cands.push(p);
          if (!cands.length) { for (let p = lo; p <= hi; p++) if (scale.includes(pcOf(p))) cands.push(p); }
          nu = cands.length ? closest(cands, m) : m;
        }
      }
      let nd = dur;
      if (isFinal) nd = Math.max(dur, FINAL_MIN);
      else if (isEnd) {
        const nxt = i + 1 < events.length ? events[i + 1][0] : null;
        nd = Math.max(dur, PHRASE_END_MIN);
        if (nxt !== null && on + nd > nxt) nd = Math.max(dur, nxt - on);
      }
      out.push([on, nd, nu]);
      prev = nu;
    }
    return out;
  }

  function shiftOctaves(events, target) {
    if (!events.length) return { events, shift: 0 };
    const weighted = [];
    for (const [, dur, m] of events) for (let i = 0; i < dur; i++) weighted.push(m);
    const med = median(weighted);
    const shift = 12 * rnd((target - med) / 12);
    return { events: events.map(([on, dur, m]) => [on, dur, m + shift]), shift };
  }

  // ── 6. key, phrases, sections, ABC ───────────────────────────────────────────────
  function corr(a, b) {
    const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    da = Math.sqrt(da); db = Math.sqrt(db);
    return da > 0 && db > 0 ? num / (da * db) : 0;
  }

  function estimateKey(events) {
    const hist = new Array(12).fill(0);
    for (const [, dur, m] of events) hist[((m % 12) + 12) % 12] += dur;
    if (!hist.some(x => x)) return "C";
    let best = "C", bestR = -2;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const [prof, names] of [[PROFILE_MAJOR, MAJOR_KEYS], [PROFILE_MINOR, MINOR_KEYS]]) {
        const r = corr(hist, hist.map((_, i) => prof[((i - tonic) % 12 + 12) % 12]));
        if (r > bestR + 1e-9) { best = names[tonic]; bestR = r; }
      }
    }
    return best;
  }

  function splitLong(g) {
    const span = g[g.length - 1][0] + g[g.length - 1][1] - g[0][0];
    if (span <= PHRASE_MAX_UNITS || g.length < 2) return [g];
    let best = -1, bestGap = 0;
    for (let i = 1; i < g.length; i++) {
      const gap = g[i][0] - (g[i - 1][0] + g[i - 1][1]);
      if (gap > bestGap) { best = i; bestGap = gap; }
    }
    if (best < 0) {
      const mid = g[0][0] + span / 2;
      let bestCost = Infinity;
      for (let i = 1; i < g.length; i++) {
        const cost = Math.abs(g[i][0] - mid) + (g[i][0] % UNITS_PER_BAR === 0 ? 0 : 4);
        if (cost < bestCost) { bestCost = cost; best = i; }
      }
    }
    return splitLong(g.slice(0, best)).concat(splitLong(g.slice(best)));
  }

  function phrasesOf(events) {
    const groups = [];
    let cur = [];
    for (const e of events) {
      if (cur.length && e[0] - (cur[cur.length - 1][0] + cur[cur.length - 1][1]) >= PHRASE_GAP_UNITS) { groups.push(cur); cur = []; }
      cur.push(e);
    }
    if (cur.length) groups.push(cur);
    const out = [];
    for (const g of groups) out.push(...splitLong(g));
    return out.map(g => ({ notes: g.length,
      bars: [Math.floor(g[0][0] / UNITS_PER_BAR) + 1, Math.floor((g[g.length - 1][0] + g[g.length - 1][1] - 1) / UNITS_PER_BAR) + 1],
      from: g[0][0], to: g[g.length - 1][0] + g[g.length - 1][1] }));
  }

  function layOut(events, layout) {
    if (!events.length) return { events: [], sections: [] };
    const last = events[events.length - 1], total = last[0] + last[1];
    const bars = Math.ceil(total / UNITS_PER_BAR);
    if (layout === "auto") layout = bars < 8 ? "twice" : "once";
    if (layout === "twice") {
      const block = bars * UNITS_PER_BAR;
      return { events: events.concat(events.map(([on, dur, m]) => [on + block, dur, m])),
               sections: [{ tag: "verse", bars: [1, bars] }, { tag: "chorus", bars: [bars + 1, 2 * bars] }] };
    }
    const ph = phrasesOf(events);
    if (ph.length < 2) return { events, sections: [{ tag: "verse", bars: [1, bars] }] };
    const mid = total / 2;
    let cut = 1, bestD = Infinity;
    for (let i = 1; i < ph.length; i++) { const d = Math.abs(ph[i].from - mid); if (d < bestD) { bestD = d; cut = i; } }
    const firstBar = Math.floor(ph[cut].from / UNITS_PER_BAR) + 1;
    if (firstBar <= 1 || firstBar > bars) return { events, sections: [{ tag: "verse", bars: [1, bars] }] };
    return { events, sections: [{ tag: "verse", bars: [1, firstBar - 1] }, { tag: "chorus", bars: [firstBar, bars] }] };
  }

  function signature(key) {
    const sharps = KEY_SHARPS[key], sig = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
    for (const L of (sharps > 0 ? "FCGDAEB" : "BEADGCF").slice(0, Math.abs(sharps))) sig[L] = sharps > 0 ? 1 : -1;
    return sig;
  }

  function spell(midi, key) {
    const sig = signature(key), pc = ((midi % 12) + 12) % 12, sharps = KEY_SHARPS[key];
    for (const L of "CDEFGAB") if (((NATURAL[L] + sig[L]) % 12 + 12) % 12 === pc)
      return [L, sig[L], Math.floor((midi - sig[L] - 60 - NATURAL[L]) / 12)];
    for (const L of "CDEFGAB") if (NATURAL[L] % 12 === pc) return [L, 0, Math.floor((midi - 60 - NATURAL[L]) / 12)];
    const acc = sharps >= 0 ? 1 : -1;
    for (const L of "CDEFGAB") if (((NATURAL[L] + acc) % 12 + 12) % 12 === pc)
      return [L, acc, Math.floor((midi - acc - 60 - NATURAL[L]) / 12)];
  }

  function pieces(units) {
    const out = [];
    for (const d of DURATIONS) while (units >= d) { out.push(d); units -= d; }
    return out;
  }

  function eventsToAbc(events, bpm, key, sections) {
    if (!events.length) throw new Error("no events");
    const bars = sections[sections.length - 1].bars[1], sig = signature(key);
    const perBar = Array.from({ length: bars }, () => []);
    for (const [on, dur, m] of events) {
      const end = on + dur;
      let pos = on;
      while (pos < end) {
        const b = Math.floor(pos / UNITS_PER_BAR), room = Math.min(end, (b + 1) * UNITS_PER_BAR) - pos;
        perBar[b].push([pos - b * UNITS_PER_BAR, room, m, pos + room < end]);
        pos += room;
      }
    }
    const barText = [];
    for (let b = 0; b < bars; b++) {
      const local = {};
      let cursor = 0;
      const toks = [];
      for (const [start, units, m, tieAfter] of perBar[b]) {
        if (start > cursor) { for (const d of pieces(start - cursor)) toks.push("z" + (d > 1 ? d : "")); cursor = start; }
        const [L, alt, octv] = spell(m, key);
        const have = L in local ? local[L] : sig[L];
        let acc = "";
        if (alt !== have) { acc = { "-2": "__", "-1": "_", "0": "=", "1": "^", "2": "^^" }[String(alt)]; local[L] = alt; }
        const name = octv >= 1 ? L.toLowerCase() : L;
        const marks = octv >= 1 ? "'".repeat(octv - 1) : ",".repeat(-octv);
        const pcs = pieces(units);
        pcs.forEach((d, i) => {
          const tie = (i < pcs.length - 1 || tieAfter) ? "-" : "";
          toks.push((i === 0 ? acc : "") + name + marks + (d > 1 ? d : "") + tie);
        });
        cursor += units;
      }
      if (cursor < UNITS_PER_BAR) for (const d of pieces(UNITS_PER_BAR - cursor)) toks.push("z" + (d > 1 ? d : ""));
      barText.push(toks.length ? toks.join("") : "Z");
    }
    const lines = HEADER.map(h => h.replace("{bpm}", bpm).replace("{key}", key));
    for (const sec of sections) {
      lines.push("% " + sec.tag);
      const [first, last] = sec.bars;
      for (let g0 = first - 1; g0 < last; g0 += 4) {
        const chunk = barText.slice(g0, Math.min(last, g0 + 4));
        lines.push("V: Vocal", chunk.join("|") + "|", "V: Ins", "Z" + (chunk.length > 1 ? chunk.length : "") + "|");
      }
    }
    return lines.join("\n") + "\n";
  }

  /* pcm: mono samples at 16 kHz. opts: {bpm, origin, layout, voice}. Same result shape as
     hum2abc.transcribe(): {ok, abc, events, hummed_events, sections, bpm, bpm_source, key,
     bars, seconds, quality} or {ok:false, reason}. */
  function transcribe(pcm, opts) {
    opts = opts || {};
    const { times, midi, rms, voiced } = track(pcm);
    const n = times.length;
    let maxRms = 0;
    for (let i = 0; i < n; i++) maxRms = Math.max(maxRms, rms[i]);
    if (n === 0 || maxRms < 1e-3) return { ok: false, reason: "silent" };
    const notes = segment(times, midi, rms, voiced);
    let vsum = 0;
    for (let i = 0; i < n; i++) vsum += voiced[i];
    const voicedRatio = n ? vsum / n : 0;
    if (notes.length < 3 || voicedRatio < 0.15) return { ok: false, reason: "unclear", notes: notes.length };
    let bpm = opts.bpm, bpmSource = "given", tempoErr = null;
    if (bpm == null) { const e = estimateBpm(notes); bpm = e.bpm; tempoErr = e.err; bpmSource = "estimated"; }
    let origin = opts.origin == null ? notes[0].on : opts.origin;
    const q = quantize(notes, bpm, origin);
    let events = q.events; origin = q.origin;
    const fidelity = opts.fidelity || (opts.tidy === false ? "faithful" : "songlike");
    const tidy = fidelity !== "faithful";
    if (tidy) events = tidyRhythm(events);
    if (!events.length || events[events.length - 1][0] + events[events.length - 1][1] < UNITS_PER_BAR)
      return { ok: false, reason: "too_short", notes: notes.length };
    const sh = shiftOctaves(events, TARGET_MEDIAN[opts.voice || "auto"] || 72);
    events = sh.events;
    const key = estimateKey(events);
    if (tidy) events = tidyPitch(events, key);
    if (fidelity === "songlike") events = songlike(events, key);
    const laid = layOut(events, opts.layout || "auto");
    for (const sec of laid.sections) {
      const lo = (sec.bars[0] - 1) * UNITS_PER_BAR, hi = sec.bars[1] * UNITS_PER_BAR;
      sec.phrases = phrasesOf(laid.events.filter(e => e[0] >= lo && e[0] < hi)).map(p => ({ notes: p.notes, bars: p.bars }));
    }
    const abc = eventsToAbc(laid.events, bpm, key, laid.sections);
    const pitches = events.map(e => e[2]);
    const bars = laid.sections[laid.sections.length - 1].bars[1];
    return { ok: true, abc, events: laid.events, hummed_events: events, sections: laid.sections, bpm, bpm_source: bpmSource,
      key, bars, seconds: Math.round(bars * BEATS_PER_BAR * 60 / bpm * 10) / 10,
      quality: { notes: events.length, voiced_ratio: Math.round(voicedRatio * 1000) / 1000,
        tempo_error: tempoErr === null ? null : Math.round(tempoErr * 1000) / 1000,
        octave_shift: sh.shift, range: [Math.min(...pitches), Math.max(...pitches)], origin_s: Math.round(origin * 1000) / 1000,
        tidy, fidelity } };
  }

  /* Events straight from a drawing (no audio): the doodle path. Same tail as transcribe(). */
  function fromEvents(events, opts) {
    opts = opts || {};
    if (!events.length) return { ok: false, reason: "too_short", notes: 0 };
    const bpm = opts.bpm || 96, key = opts.key || estimateKey(events);
    const laid = layOut(events, opts.layout || "auto");
    for (const sec of laid.sections) {
      const lo = (sec.bars[0] - 1) * UNITS_PER_BAR, hi = sec.bars[1] * UNITS_PER_BAR;
      sec.phrases = phrasesOf(laid.events.filter(e => e[0] >= lo && e[0] < hi)).map(p => ({ notes: p.notes, bars: p.bars }));
    }
    const bars = laid.sections[laid.sections.length - 1].bars[1];
    return { ok: true, abc: eventsToAbc(laid.events, bpm, key, laid.sections), events: laid.events, hummed_events: events,
      sections: laid.sections, bpm, bpm_source: "given", key, bars, seconds: Math.round(bars * BEATS_PER_BAR * 60 / bpm * 10) / 10,
      quality: { notes: events.length } };
  }

  // ── the doodle: strokes on a grid → events ───────────────────────────────────────
  /* rows top→bottom, C major over two octaves, centred on the model's written register */
  const DRAW_ROWS = [84, 83, 81, 79, 77, 76, 74, 72, 71, 69, 67, 65, 64, 62, 60];
  const DRAW_COLS_PER_BAR = 8;                      // an eighth-note grid: coarse enough to draw
  /* strokes: [[{x,y}, ...], ...] with x,y in 0..1 (x = time across `bars`, y = 0 at the top).
     A stroke is one breath: the columns it crosses become notes, consecutive equal pitches
     merge, a lifted pen ends the note even on the same pitch. Later strokes overwrite. */
  function strokesToEvents(strokes, bars) {
    const cols = bars * DRAW_COLS_PER_BAR, unitsPerCol = UNITS_PER_BAR / DRAW_COLS_PER_BAR;
    const pitch = new Array(cols).fill(null), owner = new Array(cols).fill(-1);
    strokes.forEach((pts, si) => {
      if (!pts.length) return;
      const xs = pts.map(p => p.x);
      let c0 = Math.floor(Math.min(...xs) * cols), c1 = Math.floor(Math.max(...xs) * cols);
      c0 = Math.max(0, Math.min(cols - 1, c0)); c1 = Math.max(0, Math.min(cols - 1, c1));
      for (let c = c0; c <= c1; c++) {
        const xc = (c + 0.5) / cols;
        let y = null;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          if ((a.x <= xc && xc <= b.x) || (b.x <= xc && xc <= a.x)) {
            y = b.x === a.x ? b.y : a.y + (b.y - a.y) * (xc - a.x) / (b.x - a.x); break;
          }
        }
        if (y === null) { let best = Infinity; for (const p of pts) { const d = Math.abs(p.x - xc); if (d < best) { best = d; y = p.y; } } }
        const row = Math.max(0, Math.min(DRAW_ROWS.length - 1, Math.floor(y * DRAW_ROWS.length)));
        pitch[c] = DRAW_ROWS[row]; owner[c] = si;
      }
    });
    const events = [];
    for (let c = 0; c < cols; c++) {
      if (pitch[c] === null) continue;
      const last = events[events.length - 1];
      if (last && last[2] === pitch[c] && last._owner === owner[c] && last[0] + last[1] === c * unitsPerCol) last[1] += unitsPerCol;
      else { const e = [c * unitsPerCol, unitsPerCol, pitch[c]]; e._owner = owner[c]; events.push(e); }
    }
    return events.map(e => [e[0], e[1], e[2]]);
  }

  // ── browser-only: recorder with a metronome, player, piano roll ──────────────────
  const hasAudio = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);

  function click(ctx, at, accent) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at + 0.06);
  }

  async function resampleTo16k(samples, sr) {
    if (sr === SR) return Float64Array.from(samples);
    const len = Math.ceil(samples.length * SR / sr);
    if (typeof OfflineAudioContext !== "undefined") {
      try {
        const off = new OfflineAudioContext(1, len, SR), buf = off.createBuffer(1, samples.length, sr);
        buf.copyToChannel(Float32Array.from(samples), 0);
        const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0);
        const out = await off.startRendering();
        return Float64Array.from(out.getChannelData(0));
      } catch (e) { /* fall through to the linear resampler */ }
    }
    const out = new Float64Array(len), ratio = sr / SR;
    for (let i = 0; i < len; i++) {
      const p = i * ratio, k = Math.floor(p), f = p - k;
      out[i] = (samples[k] || 0) * (1 - f) + (samples[k + 1] || 0) * f;
    }
    return out;
  }

  /* Recorder: the mic, nothing else. No click, no count-in (PM 2026-09-21: a beat to hum to
     turns "give her a variable" into "do you know music?"). Tap → it records; tap again or
     `maxSeconds` → it stops. onFrame(midiOrNull, seconds, rms) ~12×/s feeds the live wave and
     pitch trace; the tempo is estimated afterwards from the onsets. stop() resolves to
     {pcm (16 kHz), seconds, ctx}. */
  class Recorder {
    constructor() { this.ctx = null; this.stream = null; this.chunks = []; this.timers = []; this.stopped = null; this.count = 0; this.sr = SR; }
    async start(o) {
      if (!hasAudio || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no_audio");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = o.ctx || new AC();               // the page shares one context between recording and playback
      if (this.ctx.state === "suspended") await this.ctx.resume();
      const ctx = this.ctx, sr = ctx.sampleRate;
      this.sr = sr; this.chunks = []; this.count = 0;
      const src = ctx.createMediaStreamSource(this.stream), proc = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain(); sink.gain.value = 0;
      proc.onaudioprocess = e => {
        if (this.stopped) return;
        const inb = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(inb)); this.count += inb.length;
        if (o.onFrame) {
          let e2 = 0;
          for (let i = 0; i < inb.length; i++) e2 += inb[i] * inb[i];
          const rms = Math.sqrt(e2 / inb.length);
          // a cheap live pitch: decimate this chunk to ~16 kHz and run one YIN frame on it
          const step = Math.max(1, Math.round(sr / SR)), dec = new Float64Array(Math.floor(inb.length / step));
          for (let i = 0; i < dec.length; i++) dec[i] = inb[i * step];
          let m = null;
          if (dec.length >= 2 * W) {
            const r = yinFrame(dec, 0);
            if (r.cmnd < VOICED_CMND && rms > 0.01) m = 69 + 12 * Math.log2(SR / r.tau / 440);
          }
          o.onFrame(m, this.count / sr, rms);
        }
      };
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      this.proc = proc; this.src = src; this.sink = sink;
      const max = o.maxSeconds || 20;
      this.timers.push(setTimeout(() => { if (!this.stopped) this.stop().then(r => o.onEnd && o.onEnd(r)); }, max * 1000));
      return this;
    }
    seconds() { return this.count / this.sr; }
    async stop() {
      if (this.stopped) return this.stopped;
      this.timers.forEach(clearTimeout); this.timers = [];
      const all = new Float32Array(this.count);
      let at = 0;
      for (const c of this.chunks) { all.set(c, at); at += c.length; }
      const ctx = this.ctx;
      this.stopped = (async () => {
        try { this.proc.disconnect(); this.src.disconnect(); this.sink.disconnect(); } catch (e) { /* already gone */ }
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        const pcm = await resampleTo16k(all, this.sr);
        return { pcm, seconds: pcm.length / SR, ctx };
      })();
      return this.stopped;
    }
  }

  /* The live picture while recording: a waveform (one bar per frame, height from rms) with the
     pitch drawn over it as dots -- the feedback that "it hears you" (PM 2026-09-21), from the
     very first frame, before any note exists. live: [[seconds, midiOrNull, rms], ...]; the time
     axis is 0..`seconds` (the recording ceiling) so the picture grows left to right. */
  function drawWave(canvas, o) {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const cw = canvas.clientWidth || canvas.width, ch = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    const c = o.colors || {}, live = o.live || [], span = Math.max(1, o.seconds || 20);
    let maxRms = 0.02;
    for (const f of live) maxRms = Math.max(maxRms, f[2] || 0);
    const xOf = t => t / span * cw, mid = ch / 2;
    g.lineWidth = 1;
    for (let s = 5; s < span; s += 5) {                      // a faint tick every five seconds
      const x = Math.round(xOf(s)) + 0.5;
      g.strokeStyle = c.grid || "rgba(128,128,128,.14)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
    }
    g.fillStyle = c.wave || "rgba(128,128,128,.45)";
    const barW = Math.max(1.5, cw / span / 12 - 1);
    for (const [t, , rms] of live) {
      const h = Math.max(2, (rms || 0) / maxRms * ch * 0.82);
      g.fillRect(xOf(t) - barW / 2, mid - h / 2, barW, h);
    }
    const ps = live.map(f => f[1]).filter(p => p != null);
    if (ps.length) {
      let lo = Math.min(...ps) - 2, hi = Math.max(...ps) + 2;
      if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
      g.fillStyle = c.note || "#e8663c";
      for (const [t, p] of live) {
        if (p == null) continue;
        const y = ch - (p - lo) / (hi - lo) * ch;
        g.beginPath(); g.arc(xOf(t), y, 2.2, 0, Math.PI * 2); g.fill();
      }
    }
    if (live.length) {
      const x = Math.round(xOf(live[live.length - 1][0])) + 0.5;
      g.strokeStyle = c.cursor || "rgba(128,128,128,.9)"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
    }
  }

  /* Play quantized events with a soft synth; returns {stop}. onStep(unit) drives a cursor. */
  function play(ctx, events, bpm, o) {
    o = o || {};
    const grid = 60 / bpm / (UNITS_PER_BAR / BEATS_PER_BAR), t0 = ctx.currentTime + 0.05, nodes = [], timers = [];
    const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    for (const [on, dur, m] of events) {
      const at = t0 + on * grid, end = at + dur * grid - 0.02;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = "triangle"; osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.7, at + 0.012);
      g.gain.setValueAtTime(0.7, Math.max(at + 0.012, end - 0.04)); g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g); g.connect(master); osc.start(at); osc.stop(end + 0.01);
      nodes.push(osc, g);
    }
    if (o.click) {
      const last = events[events.length - 1], beats = Math.ceil((last[0] + last[1]) / (UNITS_PER_BAR / BEATS_PER_BAR));
      for (let b = 0; b < beats; b++) click(ctx, t0 + b * (60 / bpm), b % BEATS_PER_BAR === 0);
    }
    const last = events[events.length - 1], endUnit = last[0] + last[1];
    if (o.onStep) {
      const tick = () => {
        const u = (ctx.currentTime - t0) / grid;
        if (u >= endUnit) { o.onStep(null); return; }
        o.onStep(u); timers.push(setTimeout(tick, 40));
      };
      tick();
    }
    if (o.onEnd) timers.push(setTimeout(o.onEnd, (endUnit * grid + 0.1) * 1000));
    return { stop() { timers.forEach(clearTimeout); nodes.forEach(n => { try { n.disconnect(); } catch (e) { /* */ } }); try { master.disconnect(); } catch (e) { /* */ } } };
  }

  /* Piano roll on a canvas. o: {events, bars, cursor (unit|null), live: [[unitX, midi]],
     colors: {grid, bar, note, live, cursor}, rows: [lo, hi] midi range}. Devicepixel-aware. */
  function drawRoll(canvas, o) {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const cw = canvas.clientWidth || canvas.width, ch = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    const c = o.colors || {}, bars = Math.max(1, o.bars || 1), total = bars * UNITS_PER_BAR;
    const ev = o.events || [], live = o.live || [];
    let lo = 60, hi = 84;
    if (o.rows) { lo = o.rows[0]; hi = o.rows[1]; }
    else if (ev.length || live.length) {
      const ps = ev.map(e => e[2]).concat(live.map(l => l[1])).filter(p => p != null);
      if (ps.length) { lo = Math.min(...ps) - 2; hi = Math.max(...ps) + 2; if (hi - lo < 12) { const m = (hi + lo) / 2; lo = Math.floor(m - 6); hi = lo + 12; } }
    }
    const rowH = ch / (hi - lo + 1), colW = cw / total;
    const yOf = p => ch - (p - lo + 1) * rowH;
    g.lineWidth = 1;
    for (let b = 0; b <= bars; b++) {                       // bar lines + beat lines
      const x = Math.round(b * UNITS_PER_BAR * colW) + 0.5;
      g.strokeStyle = c.bar || "rgba(128,128,128,.35)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
      if (b < bars) for (let q = 1; q < BEATS_PER_BAR; q++) {
        const xq = Math.round((b * UNITS_PER_BAR + q * UNITS_PER_BAR / BEATS_PER_BAR) * colW) + 0.5;
        g.strokeStyle = c.grid || "rgba(128,128,128,.14)"; g.beginPath(); g.moveTo(xq, 0); g.lineTo(xq, ch); g.stroke();
      }
    }
    for (let p = lo; p <= hi; p++) if (p % 12 === 0) {      // a faint line on every C
      const y = Math.round(yOf(p) + rowH) + 0.5;
      g.strokeStyle = c.grid || "rgba(128,128,128,.14)"; g.beginPath(); g.moveTo(0, y); g.lineTo(cw, y); g.stroke();
    }
    if (live.length) {                                       // the trace while humming
      g.strokeStyle = c.live || "rgba(128,128,128,.6)"; g.lineWidth = 2; g.lineCap = "round"; g.beginPath();
      let pen = false;
      for (const [u, p] of live) {
        if (p == null) { pen = false; continue; }
        const x = u * colW, y = yOf(p) + rowH / 2;
        if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = c.note || "#e8663c";
    for (const [on, dur, p] of ev) {
      const x = on * colW + 1, w = Math.max(2, dur * colW - 2), y = yOf(p) + 1, h = Math.max(2, rowH - 2), r = Math.min(4, h / 2);
      g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
    }
    if (o.cursor != null) {
      const x = Math.round(o.cursor * colW) + 0.5;
      g.strokeStyle = c.cursor || "rgba(128,128,128,.9)"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
    }
    return { lo, hi, rowH, colW };
  }

  return { SR, W, HOP, UNITS_PER_BAR, BEATS_PER_BAR, DRAW_ROWS, DRAW_COLS_PER_BAR, TIDY_GRID,
    track, segment, estimateBpm, quantize, tidyRhythm, foldOctaves, tidyPitch, songlike, scaleOf, shiftOctaves, estimateKey, phrasesOf, layOut,
    eventsToAbc, spell, transcribe, fromEvents, strokesToEvents, resampleTo16k, Recorder, play, drawRoll, drawWave, click,
    hasAudio: !!hasAudio };
});
