'use strict';
/* =========================================================================
   Resemusik – genereras i webbläsaren (WebAudio), unik per resa via seed.
   Inga upphovsrättsproblem, ingen nedladdning.
   ========================================================================= */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const midiHz = m => 440 * 2 ** ((m - 69) / 12);

class TravelMusic {
  constructor(ctx, out, { style = 'roadtrip', seed = 'trip', duration = 120 } = {}) {
    this.ctx = ctx; this.style = style; this.dur = duration;
    const rnd = this.rnd = mulberry32(hashStr(seed));
    this.bpm = style === 'calm' ? 82 + Math.floor(rnd() * 8) : 104 + Math.floor(rnd() * 10);
    this.beat = 60 / this.bpm; this.bar = this.beat * 4;
    this.root = [50, 52, 53, 55, 57][Math.floor(rnd() * 5)]; // D3..A3
    const progs = style === 'calm'
      ? [[[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M']], [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], [[0, 'M'], [4, 'm'], [5, 'M'], [7, 'M']]]
      : [[[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']]];
    this.prog = progs[Math.floor(rnd() * progs.length)];
    this.scale = [0, 2, 4, 7, 9]; // pentatonic dur
    // mix chain
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3;
    this.master.connect(comp); comp.connect(out);
    this.bus = ctx.createGain(); this.bus.connect(this.master);
    // eko för plock/melodi
    this.delay = ctx.createDelay(2); this.delay.delayTime.value = this.beat * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.32; const wet = ctx.createGain(); wet.gain.value = 0.22;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2800;
    this.delay.connect(dlp); dlp.connect(fb); fb.connect(this.delay); dlp.connect(wet); wet.connect(this.bus);
    this.sendFx = ctx.createGain(); this.sendFx.connect(this.delay);
    // brus för trummor
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
    this.nBars = Math.ceil(duration / this.bar) + 1;
    this.melody = this.makeMelody();
  }
  makeMelody() {
    // 8-takters motiv (åttondelsrutnät), upprepas med variation
    const r = this.rnd, cells = [];
    let deg = 2 + Math.floor(r() * 3);
    for (let b = 0; b < 4; b++) {
      const bar = [];
      for (let s = 0; s < 8; s++) {
        const play = s === 0 || (s % 2 === 0 ? r() < 0.7 : r() < 0.28);
        if (play) { deg = Math.max(0, Math.min(9, deg + [-2, -1, -1, 0, 1, 1, 2][Math.floor(r() * 7)])); bar.push([s, deg, s % 2 ? 1 : (r() < 0.3 ? 3 : 2)]); }
      }
      cells.push(bar);
    }
    return cells;
  }
  degToMidi(deg) { const o = Math.floor(deg / 5); return this.root + 24 + this.scale[deg % 5] + 12 * o; }
  start(t0) {
    this.t0 = t0; const g = this.master.gain, end = t0 + this.dur;
    g.setValueAtTime(0, t0); g.linearRampToValueAtTime(0.85, t0 + 1.2);
    g.setValueAtTime(0.85, Math.max(t0 + 1.3, end - 3.5)); g.linearRampToValueAtTime(0, end);
    this.nextBar = 0;
    this.timer = setInterval(() => this.pump(), 200); this.pump();
  }
  stop() { clearInterval(this.timer); try { this.master.gain.cancelScheduledValues(0); this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); } catch (e) { } }
  pump() {
    while (this.nextBar < this.nBars && this.t0 + this.nextBar * this.bar < this.ctx.currentTime + 2.5) { this.scheduleBar(this.nextBar); this.nextBar++; }
    if (this.nextBar >= this.nBars) clearInterval(this.timer);
  }
  env(gainNode, t, a, peak, dec, sus = 0, rel = 0.05, len = 0) {
    const g = gainNode.gain; g.setValueAtTime(0.0001, t); g.linearRampToValueAtTime(peak, t + a);
    if (len) { g.setTargetAtTime(sus * peak + 0.0001, t + a, dec / 3); g.setTargetAtTime(0.0001, t + len, rel / 3); }
    else g.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }
  tone(type, freq, t, dur, vol, { a = 0.005, dec = 0.3, dest = this.bus, fx = 0, detune = 0, sustain = false, filter = 0 } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    let node = o;
    if (filter) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter; f.Q.value = 0.5; o.connect(f); node = f; }
    node.connect(g); g.connect(dest); if (fx) { const s = c.createGain(); s.gain.value = fx; g.connect(s); s.connect(this.sendFx); }
    if (sustain) this.env(g, t, a, vol, dec, 0.7, 0.4, dur); else this.env(g, t, a, vol, dec);
    o.start(t); o.stop(t + (sustain ? dur + 0.6 : a + dec + 0.05));
  }
  noiseHit(t, { vol = 0.2, dec = 0.05, type = 'highpass', freq = 7000, q = 0.7 } = {}) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f); f.connect(g); g.connect(this.bus); this.env(g, t, 0.002, vol, dec);
    s.start(t, Math.random() * 0.5); s.stop(t + dec + 0.05);
  }
  kick(t, vol = 0.9) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(g); g.connect(this.bus); this.env(g, t, 0.002, vol, 0.32); o.start(t); o.stop(t + 0.4);
  }
  scheduleBar(b) {
    const t = this.t0 + b * this.bar, B = this.beat, calm = this.style === 'calm';
    const last = this.nBars - 1, [deg, q] = this.prog[b % 4];
    const third = q === 'm' ? 3 : 4, rootM = this.root + deg;
    const chord = [0, third, 7].map(x => rootM + x);
    const section = Math.floor(b / 8);
    const intro = b < 2, outro = b >= last - 1;
    // pad
    chord.forEach((m, i) => {
      [-7, 7].forEach(dt => this.tone(calm ? 'triangle' : 'sawtooth', midiHz(m + 12), t, this.bar - 0.05, calm ? 0.035 : 0.018, { a: 0.5, dec: 1.2, sustain: true, detune: dt, filter: calm ? 1400 : 1100 }));
    });
    // bas
    if (!intro || calm) {
      const bm = midiHz(rootM - 12 + (rootM - 12 < 38 ? 12 : 0));
      const pat = calm ? [[0, 1.8]] : [[0, 0.7], [1.5, 0.4], [2, 0.7], [3.5, 0.3]];
      pat.forEach(([pos, len]) => this.tone('triangle', bm, t + pos * B, len * B, calm ? 0.22 : 0.28, { a: 0.01, dec: len * B, filter: 600 }));
    }
    // arpeggio (plock)
    const arp = [0, 1, 2, 1, 0, 1, 2, 3].map(i => i === 3 ? chord[0] + 12 : chord[i]);
    const step = calm ? 2 : 1;
    for (let s = 0; s < 8; s += step) {
      if (outro && s > 3) break;
      this.tone('triangle', midiHz(arp[s] + 24), t + s * B / 2, 0.3, calm ? 0.06 : 0.05, { a: 0.003, dec: calm ? 0.6 : 0.28, fx: 0.6 });
      if (!calm) this.tone('sine', midiHz(arp[s] + 36), t + s * B / 2, 0.2, 0.012, { a: 0.003, dec: 0.15 });
    }
    // trummor
    if (!calm && b >= 2 && !outro) {
      const fill = b % 8 === 7;
      [0, 2].forEach(p => this.kick(t + p * B));
      if (b % 2 === 1) this.kick(t + 2.5 * B, 0.6);
      [1, 3].forEach(p => this.noiseHit(t + p * B, { vol: 0.22, dec: 0.16, type: 'bandpass', freq: 1800, q: 0.8 }));
      for (let s = 0; s < 8; s++) this.noiseHit(t + s * B / 2, { vol: s % 2 ? 0.05 : 0.09, dec: s === 7 && fill ? 0.12 : 0.04 });
      if (fill) [3.5, 3.75].forEach(p => this.noiseHit(t + p * B, { vol: 0.16, dec: 0.1, type: 'bandpass', freq: 1500 }));
    }
    if (calm && b >= 4 && !outro && b % 2 === 0) this.noiseHit(t, { vol: 0.03, dec: 1.2, freq: 5000 }); // mjukt "shimmer"
    // melodi – andra halvan av varje 8-taktsblock efter introt
    if (b >= 4 && !outro && (b % 8 >= 4 || section % 2 === 1)) {
      const cell = this.melody[b % 4];
      cell.forEach(([s, d, len], i) => {
        let dd = d; if (section % 2 === 1 && i === cell.length - 1) dd = Math.max(0, d - 1);
        // dra mot ackordtoner på taktslag 1
        let m = this.degToMidi(dd);
        if (s === 0) { const best = [...chord.map(x => x + 24), ...chord.map(x => x + 36)].reduce((a, c) => Math.abs(c - m) < Math.abs(a - m) ? c : a); m = best; }
        const st = t + s * B / 2;
        this.tone(calm ? 'sine' : 'square', midiHz(m), st, len * B / 2, calm ? 0.09 : 0.035, { a: 0.01, dec: len * B / 2 + 0.15, fx: 0.5, filter: calm ? 0 : 2200 });
        if (!calm) this.tone('sine', midiHz(m), st, len * B / 2, 0.06, { a: 0.01, dec: len * B / 2 + 0.15 });
      });
    }
  }
}
