'use strict';
/* =========================================================================
   Filmen: karta som följer resan + bildmontage per stopp, spelas in direkt
   från en canvas (MediaRecorder) tillsammans med musiken.
   ========================================================================= */
const FW = 1280, FH = 720;           // logisk ritstorlek; allt ritas i dessa koordinater
let SC = 1.5;                          // skala till utdata: 1 = 720p, 1.5 = 1080p, 3 = 4K
const RES = { 720: 1, 1080: 1.5, 2160: 3 };
const tileZoom = z => clamp(Math.floor(z + 0.6), 1, 18);   // välj kartbitar som ritas i ~0,66–1,3× (skarpt)
const wx = lon => (lon + 180) / 360;
const wy = lat => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const easeOut = t => 1 - (1 - t) ** 3;
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const SERIF = 'Georgia,"Times New Roman",serif';
const SANS = '"Segoe UI",system-ui,Roboto,sans-serif';

/* ---------- kartbitar ---------- */
class TileCache {
  constructor(templates, filter = '') { this.t = templates; this.filter = filter; this.m = new Map(); }
  url(l, z, x, y) { return this.t[l].replace('{z}', z).replace('{x}', x).replace('{y}', y); }
  get(l, z, x, y) { const e = this.m.get(`${l}/${z}/${x}/${y}`); return e && e.ok ? e.img : null; }
  load(l, z, x, y) {
    const k = `${l}/${z}/${x}/${y}`; let e = this.m.get(k); if (e) return e.p;
    const img = new Image(); img.crossOrigin = 'anonymous';
    e = { img, ok: false };
    e.p = new Promise(res => {
      const to = setTimeout(() => res(false), 12000);
      img.onload = () => {
        clearTimeout(to);
        if (this.filter) { try { const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), g = c.getContext('2d'); g.filter = this.filter; g.drawImage(img, 0, 0); e.img = c; } catch (er) { } }
        e.ok = true; res(true);
      };
      img.onerror = () => { clearTimeout(to); res(false); };
    });
    img.src = this.url(l, z, x, y); this.m.set(k, e); return e.p;
  }
  // kartbitar som en logisk kamera behöver vid aktuell utdataskala
  neededL(cam) { return this.needed({ ...cam, z: cam.z + Math.log2(SC) }, FW * SC, FH * SC); }
  needed(cam, W = FW, H = FH) {
    const zi = tileZoom(cam.z), n = 2 ** zi, ts = 256 * 2 ** (cam.z - zi);
    const cx = cam.x * n, cy = cam.y * n, out = [];
    for (let ty = Math.floor(cy - H / 2 / ts); ty <= Math.floor(cy + H / 2 / ts); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(cx - W / 2 / ts); tx <= Math.floor(cx + W / 2 / ts); tx++) out.push([zi, ((tx % n) + n) % n, ty, tx]);
    }
    return out;
  }
}
function drawMap(ctx, tiles, camL) {
  // ritas i utdatapixlar (inte uppskalat) så att kartan blir skarp i 1080p/4K
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingQuality = 'high';
  const W = FW * SC, H = FH * SC, cam = { ...camL, z: camL.z + Math.log2(SC) };
  ctx.fillStyle = tiles.bg || '#ebe6dc'; ctx.fillRect(0, 0, W, H);
  const zi = tileZoom(cam.z), n = 2 ** zi, ts = 256 * 2 ** (cam.z - zi);
  const cx = cam.x * n, cy = cam.y * n, need = tiles.needed(cam, W, H);
  for (let l = 0; l < tiles.t.length; l++) for (const [z, x, y, rawX] of need) {
    const dx = (rawX - cx) * ts + W / 2, dy = (y - cy) * ts + H / 2;
    let img = tiles.get(l, z, x, y);
    if (img) { ctx.drawImage(img, dx, dy, ts + 0.6, ts + 0.6); continue; }
    tiles.load(l, z, x, y);
    for (let k = 1; k <= 5 && z - k >= 0; k++) {           // reserv: förstora en grövre bit
      const px = x >> k, py = y >> k, p = tiles.get(l, z - k, px, py);
      if (p) { const sub = 256 / 2 ** k; ctx.drawImage(p, (x - (px << k)) * sub, (y - (py << k)) * sub, sub, sub, dx, dy, ts + 0.6, ts + 0.6); break; }
    }
  }
  ctx.restore();
}

function camFit(pts, pad = 120, W = FW, H = FH, zMax = 14, zMin = 2) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  pts.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
  const sx = Math.max(x1 - x0, 1e-9), sy = Math.max(y1 - y0, 1e-9);
  const z = Math.log2(Math.min((W - 2 * pad) / (sx * 256), (H - 2 * pad) / (sy * 256)));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: clamp(z, zMin, zMax) };
}
const camLerp = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });
const toScreen = (cam, p, W = FW, H = FH) => { const s = 256 * 2 ** cam.z; return [(p.x - cam.x) * s + W / 2, (p.y - cam.y) * s + H / 2]; };
function legPath(a, b, mode) {
  if (mode !== 'flight') return [a, b];
  return arcPoints([a.x, a.y], [b.x, b.y], 0.2, 48).map(([x, y]) => ({ x, y }));
}
const filmPath = f => f.subs.flatMap((u, k) => k ? u.pts.slice(1) : u.pts);
function partialPath(pts, t) {
  if (t >= 1) return pts;
  const len = []; let tot = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); len.push(d); tot += d; }
  let target = tot * t; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (target <= len[i - 1]) { const f = len[i - 1] ? target / len[i - 1] : 0; out.push({ x: lerp(pts[i - 1].x, pts[i].x, f), y: lerp(pts[i - 1].y, pts[i].y, f), m: pts[i].m }); return out; }
    target -= len[i - 1]; out.push(pts[i]);
  }
  return out;
}
function strokePath(ctx, cam, pts, mode, alpha = 1, W = FW, H = FH, scale = 1) {
  if (pts.length < 2) return;
  const color = MODE[mode] ? MODE[mode].color : '#1f2a36';
  const pass = (w, c, dash) => {
    ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = toScreen(cam, p, W, H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.setLineDash(dash || []); ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
  };
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (mode === 'flight') { pass(7 * scale, 'rgba(255,255,255,.85)'); pass(3.5 * scale, color, [12 * scale, 9 * scale]); }
  else if (mode === 'walk') { pass(6 * scale, 'rgba(255,255,255,.85)'); pass(3.5 * scale, color, [1, 7 * scale]); }
  else if (mode === 'bike') { pass(7 * scale, 'rgba(255,255,255,.85)'); pass(4 * scale, color, [8 * scale, 6 * scale]); }
  else if (mode === 'ferry') { pass(7 * scale, 'rgba(255,255,255,.85)'); pass(4 * scale, color, [5 * scale, 9 * scale]); }
  else if (mode === 'train') { pass(9 * scale, 'rgba(255,255,255,.9)'); pass(5.5 * scale, color); ctx.lineCap = 'butt'; pass(3 * scale, '#fff', [3 * scale, 10 * scale]); }
  else if (mode === 'bus') { pass(9 * scale, 'rgba(255,255,255,.9)'); pass(5 * scale, color, [14 * scale, 5 * scale]); }
  else { pass(9 * scale, 'rgba(255,255,255,.9)'); pass(5 * scale, color); }
  ctx.restore();
}
function dot(ctx, x, y, r, fill, ring = '#fff', rw = 3) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = rw; ctx.strokeStyle = ring; ctx.stroke();
}
function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = t;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines && line && !lines.includes(line)) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, ' …');
  return lines;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function pill(ctx, text, x, y, { font = `600 22px ${SANS}`, bg = 'rgba(20,26,34,.78)', fg = '#fff', padX = 16, h = 42, align = 'left' } = {}) {
  ctx.font = font; const w = ctx.measureText(text).width + padX * 2;
  const X = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  roundRect(ctx, X, y, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, X + padX, y + h / 2 + 1); ctx.textBaseline = 'alphabetic';
  return w;
}


/* ---------- urval & planering ---------- */
const TEMPO = { fast: 1.0, normal: 1.6, slow: 2.4 };
function filmCfg() {
  S.meta.film = S.meta.film || {};
  const f = S.meta.film;
  f.tempo = f.tempo || 'normal'; f.clip = f.clip || 5; f.len = f.len || 120; f.res = f.res || 1080;
  return f;
}
const sessionBad = new Set();              // bilder/klipp som inte gick att läsa (t.ex. HEIC/HEVC som datorn saknar stöd för)
function groupStops() {
  const groups = [];
  for (const s of S.stops) {
    const prev = groups[groups.length - 1];
    if (prev && !s.manual && !prev.members[0].manual && hav(prev.members[0].lat, prev.members[0].lon, s.lat, s.lon) < 3 && s.start - prev.end < 4 * 3600e3) { prev.members.push(s); prev.end = s.end; continue; }
    groups.push({ members: [s], start: s.start, end: s.end });
  }
  groups.forEach(g => { g.photos = g.members.flatMap(m => m.photos).sort((a, b) => a.time - b.time); });
  return groups;
}
// Automatiskt urval: lagom många stopp och bilder för vald längd
function autoSelect(target) {
  const groups = groupStops();
  groups.forEach(g => {
    const pics = g.photos.filter(p => p.kind === 'photo' && !sessionBad.has(p.path));
    g.cand = dedupe(pics, 15000);
    g.vids = g.photos.filter(p => p.kind === 'video' && !p.unplayable && !sessionBad.has(p.path));
    g.score = g.cand.length + g.vids.length * 3 + Math.min(6, (g.end - g.start) / 3600e3 * 2);
  });
  const N = clamp(Math.round((target - 11) / 6), 3, 60);
  const keep = [...groups].filter(g => g.cand.length || g.vids.length).sort((a, b) => b.score - a.score).slice(0, N);
  const pd = TEMPO[filmCfg().tempo], clip = filmCfg().clip;
  keep.forEach(g => { g.k = Math.min(g.cand.length, Math.max(1, Math.round(1 + Math.log2(g.photos.length)))); g.v = Math.min(1, g.vids.length); if (g.v && g.k > 2) g.k--; });
  const est = () => 11 + keep.reduce((a, g) => a + 2 + g.k * pd + g.v * clip + 0.45, 0);
  while (est() > target) { const g = keep.reduce((a, b) => (b.k + b.v > a.k + a.v ? b : a)); if (g.k > 1) g.k--; else if (g.v && g.cand.length) { g.v = 0; } else break; }
  for (let guard = 0; guard < 500 && est() < target * 0.97; guard++) {
    const c = keep.filter(g => g.k < g.cand.length && g.k < 9); if (!c.length) break;
    c.reduce((a, b) => (b.cand.length / b.k > a.cand.length / a.k ? b : a)).k++;
  }
  const sel = [];
  keep.forEach(g => { pickEven(g.cand, g.k).forEach(p => sel.push(p.path)); g.vids.slice(0, g.v).forEach(p => sel.push(p.path)); });
  return sel;
}
// en sträcka kan bestå av flera delar (t.ex. bil – färja – bil); varje punkt får sitt färdsätt i .m
function subsFromLeg(l) {
  const a = { x: wx(l.from.lon), y: wy(l.from.lat) }, b = { x: wx(l.to.lon), y: wy(l.to.lat) };
  if (!l.route) return [{ pts: legPath(a, b, l.mode).map(p => ({ ...p, m: l.mode })), mode: l.mode, km: l.km, est: l.est }];
  const all = l.route.pts.map(([la, lo]) => ({ x: wx(lo), y: wy(la), m: l.mode }));
  const cuts = []; let last = 0;
  (l.route.ferry || []).forEach(([s0, s1]) => { if (s0 > last) cuts.push([last, s0, l.mode]); cuts.push([s0, s1, 'ferry']); last = s1; });
  if (last < all.length - 1 || !cuts.length) cuts.push([last, all.length - 1, l.mode]);
  return cuts.map(([s0, s1, m]) => ({ pts: all.slice(s0, s1 + 1).map(p => ({ ...p, m })), mode: m, km: l.km, est: l.est }));
}
function strokeRuns(ctx, cam, pts, fallback, alpha = 1) {
  let i = 0;
  while (i < pts.length - 1) {
    const m = pts[i + 1].m || fallback; let k = i + 1;
    while (k + 1 < pts.length && (pts[k + 1].m || fallback) === m) k++;
    strokePath(ctx, cam, pts.slice(i, k + 1), m, alpha); i = k;
  }
}
function buildFilmStops(selPaths) {
  const sel = new Set(selPaths), start = S.trip.start;
  const groups = groupStops();
  const out = [];
  groups.forEach(g => {
    const items = g.photos.filter(p => sel.has(p.path) && !sessionBad.has(p.path) && !(p.kind === 'video' && p.unplayable));
    if (items.length) { g.items = items; out.push(g); }
  });
  out.forEach((f, i) => {
    const main = f.members.reduce((a, b) => b.photos.length > a.photos.length ? b : a);
    const first = f.members[0];
    f.name = stopName(main); f.country = stopCountry(main);
    f.lat = first.lat; f.lon = first.lon;
    f.distFromStart = hav(start.lat, start.lon, f.lat, f.lon);
    f.p = { x: wx(f.lon), y: wy(f.lat) };
    const prevLast = i === 0 ? -1 : out[i - 1].members[out[i - 1].members.length - 1].idx;
    f.subs = []; f.est = 0; f.km = 0;
    const byMode = {}; Object.keys(MODE).forEach(k => byMode[k] = 0);
    for (let k = prevLast + 1; k <= first.idx; k++) {
      const l = S.stops[k].leg;
      if (l.fromStart && l.km < 2) continue;
      f.subs.push(...subsFromLeg(l)); f.est += l.est; f.km += l.km; byMode[l.mode] += l.est;
    }
    f.inner = f.members.slice(1).flatMap(m => subsFromLeg(m.leg));
    f.viaPts = S.stops.slice(prevLast + 1, first.idx).map(s => ({ x: wx(s.lon), y: wy(s.lat) }));
    const prevStop = i === 0 ? start : S.stops[prevLast];
    f.from = { x: wx(prevStop.lon), y: wy(prevStop.lat) };
    if (!f.subs.length && f.km === 0 && i > 0) f.subs.push({ pts: [{ ...f.from, m: 'walk' }, { ...f.p, m: 'walk' }], mode: 'walk', km: 0, est: 0 });
    // innehåller sträckan ett flyg styr det tempot och kameran
    f.mode = byMode.flight > 0 ? 'flight' : Object.entries(byMode).sort((a, b) => b[1] - a[1])[0][0];
  });
  return out;
}
function planFilm(fs) {
  const cfg = filmCfg(), pd = TEMPO[cfg.tempo] || 1.6, clipMax = +cfg.clip || 5;
  const TITLE = 4.5, OUTRO = 6.5, FADE = 0.45;
  let total = TITLE + OUTRO;
  fs.forEach((f, i) => {
    f.travel = (i === 0 && f.est < 2) || !f.subs.length ? 0 : f.mode === 'flight' ? clamp(3.4 + 1.0 * Math.log10(1 + f.est), 4.0, 6.5) : clamp(1.1 + 0.5 * Math.log10(1 + f.est), 1.1, 3.0);
    let t = 0;
    f.shots = f.items.map(p => {
      let dur = pd, start = 0;
      if (p.kind === 'video') {
        const D = p.duration || clipMax;
        dur = Math.min(clipMax, D);
        start = D > dur + 1.5 ? 1 : 0;
      }
      const sh = { p, dur, start, t0: t }; t += dur; return sh;
    });
    f.montage = t + FADE;
    total += f.travel + f.montage;
  });
  return { pd, TITLE, OUTRO, FADE, total };
}
const fmtMMSS = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/* ---------- filmmotor ---------- */
class FilmMaker {
  constructor(canvas) {
    SC = RES[filmCfg().res] || 1.5;
    canvas.width = Math.round(FW * SC); canvas.height = Math.round(FH * SC);
    this.cv = canvas; this.ctx = canvas.getContext('2d'); const bm = BASEMAPS[currentBasemap()]; this.tiles = new TileCache(bm.layers, bm.filter || ''); this.tiles.bg = bm.bg;
    this.blobs = new Map(); this.bmps = new Map(); this.vids = new Map();
  }
  prepareTimeline() {
    const fs = this.fs = buildFilmStops(filmCfg().sel || []);
    if (!fs.length) return 0;
    const plan = this.plan = planFilm(fs);
    const T = S.trip, st = T.start;
    this.startP = { x: wx(st.lon), y: wy(st.lat) };
    this.allSubs = S.legs.filter(l => !(l.fromStart && l.km < 2)).flatMap(subsFromLeg);
    this.endP = S.endPt ? { x: wx(S.endPt.lon), y: wy(S.endPt.lat) } : null;
    const pts = S.geo.map(p => ({ x: wx(p.lon), y: wy(p.lat) }));
    const ov = camFit(pts, 90), withStart = camFit([...pts, this.startP, ...(S.endPt ? [{ x: wx(S.endPt.lon), y: wy(S.endPt.lat) }] : [])], 90);
    this.overview = (Math.abs(withStart.z - ov.z) < 2.2) ? withStart : ov;
    this.core = this.overview;
    if (T.type === 'stay') {
      const core = S.geo.filter(p => hav(p.lat, p.lon, T.mid.lat, T.mid.lon) < 20).map(p => ({ x: wx(p.lon), y: wy(p.lat) }));
      if (core.length) this.core = camFit(core, 110, FW, FH, 14);
    }
    const seg = [];
    let t = 0, prevCam = { ...this.core, z: this.core.z - 0.25 };
    seg.push({ type: 'title', t0: 0, dur: plan.TITLE, cam: prevCam }); t += plan.TITLE;
    fs.forEach((f, i) => {
      const next = fs[i + 1];
      const path = filmPath(f);
      const legCam = camFit(path.length ? [...path, f.p] : [f.from, f.p], 140, FW, FH, 13);
      const zIn = f.mode === 'flight' ? 11 : legCam.z + 1.4;
      const zOut = !next ? 99 : next.mode === 'flight' ? 11 : camFit([f.p, next.p], 150, FW, FH, 13).z + 1.4;
      const zArr = clamp(Math.min(zIn, zOut), 4, 13.5);
      const arrCam = { x: f.p.x, y: f.p.y, z: zArr };
      if (f.travel > 0) { seg.push({ type: 'travel', t0: t, dur: f.travel, f, i, path, camA: prevCam, camMid: legCam, camB: arrCam }); t += f.travel; }
      seg.push({ type: 'montage', t0: t, dur: f.montage, f, i, cam: arrCam }); t += f.montage;
      prevCam = arrCam;
    });
    // sista biten: från sista valda stoppet till slutpunkten
    if (S.endPt && fs.length) {
      const lastIdx = fs[fs.length - 1].members[fs[fs.length - 1].members.length - 1].idx;
      const legs = [...S.stops.slice(lastIdx + 1).map(x => x.leg), ...(S.endLeg ? [S.endLeg] : [])];
      if (legs.length) {
        const byMode = {}; let est = 0; legs.forEach(l => { byMode[l.mode] = (byMode[l.mode] || 0) + l.est; est += l.est; });
        const ef = {
          isEnd: true, subs: legs.flatMap(subsFromLeg), inner: [], viaPts: S.stops.slice(lastIdx + 1).map(x => ({ x: wx(x.lon), y: wy(x.lat) })),
          p: this.endP, from: fs[fs.length - 1].p, start: S.stops[S.stops.length - 1].end, est,
          mode: byMode.flight > 0 ? 'flight' : Object.entries(byMode).sort((a, b) => b[1] - a[1])[0][0],
          name: S.endPt.same ? (T.start.auto || !T.start.label ? 'Tillbaka till start' : `Hem till ${T.start.label}`) : (S.endPt.label || 'Slutpunkten'),
        };
        const path = filmPath(ef);
        const legCam = camFit(path, 140, FW, FH, 13);
        const dur = ef.mode === 'flight' ? clamp(3.4 + 1.0 * Math.log10(1 + est), 4.0, 6.5) : clamp(1.3 + 0.5 * Math.log10(1 + est), 1.3, 3.2);
        const arrCam = { x: ef.p.x, y: ef.p.y, z: clamp(legCam.z + 1, 4, 12) };
        seg.push({ type: 'travel', t0: t, dur, f: ef, i: fs.length, path, camA: prevCam, camMid: legCam, camB: arrCam }); t += dur;
        prevCam = arrCam;
      }
    }
    seg.push({ type: 'outro', t0: t, dur: plan.OUTRO, cam: this.overview, camA: prevCam }); t += plan.OUTRO;
    this.seg = seg; this.total = t;
    return t;
  }
  camAt(s, u) {
    if (s.type === 'travel') {
      const [a, b] = s.f.mode === 'flight' ? [0.3, 0.7] : [0.25, 0.78];   // flyg: lugnare ut- och inzoomning
      if (u < a) return camLerp(s.camA, s.camMid, ease(u / a));
      if (u < b) return s.camMid;
      return camLerp(s.camMid, s.camB, ease((u - b) / (1 - b)));
    }
    if (s.type === 'outro') return camLerp(s.camA, s.cam, ease(clamp(u / 0.35, 0, 1)));
    return s.cam;
  }
  async prefetchTiles(onProgress) {
    const want = new Map();
    for (const s of this.seg) {
      const n = Math.max(2, Math.ceil(s.dur / 0.25));
      for (let k = 0; k <= n; k++) for (const [z, x, y] of this.tiles.neededL(this.camAt(s, k / n))) for (let l = 0; l < this.tiles.t.length; l++) want.set(`${l}/${z}/${x}/${y}`, [l, z, x, y]);
    }
    const list = [...want.values()]; let done = 0, ok = 0;
    await pool(list, 12, async ([l, z, x, y]) => { if (await this.tiles.load(l, z, x, y)) ok++; done++; if (done % 4 === 0 || done === list.length) onProgress(done / list.length, done, list.length); });
    return { total: list.length, ok };
  }
  // returnerar antal som inte gick att läsa
  async prepareMedia(onProgress) {
    const shots = this.fs.flatMap(f => f.shots); let done = 0, bad = 0;
    await pool(shots, 3, async sh => {
      const key = this.key(sh);
      if (!this.blobs.has(key)) {
        const b = sh.p.kind === 'video' ? await composeVideoPoster(sh.p, sh.start) : await composePhoto(sh.p);
        if (b) this.blobs.set(key, b); else { sessionBad.add(sh.p.path); bad++; }
      }
      done++; onProgress(done / shots.length, done, shots.length);
    });
    return bad;
  }
  key(sh) { return sh.p.path; }
  ensureMedia(i) {
    for (let k = i; k <= i + 2 && k < this.fs.length; k++) for (const sh of this.fs[k].shots) {
      const key = this.key(sh);
      if (!this.bmps.has(key) && this.blobs.get(key)) {
        const e = { bmp: null }; this.bmps.set(key, e);
        e.p = createImageBitmap(this.blobs.get(key)).then(b => e.bmp = b).catch(() => { });
      }
      if (sh.p.kind === 'video' && !this.vids.has(key)) {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
        const e = { v, started: false };
        e.ready = fullUrl(sh.p).then(u => { const w = once(v, 'loadeddata', 20000); v.src = u; return w; }).then(() => { v.currentTime = sh.start; return once(v, 'seeked', 10000); }).catch(() => { });
        this.vids.set(key, e);
      }
    }
    for (let k = 0; k < i - 1; k++) for (const sh of this.fs[k].shots) {
      const key = this.key(sh), e = this.bmps.get(key);
      if (e && e.bmp) { e.bmp.close(); this.bmps.delete(key); }
      const ve = this.vids.get(key); if (ve) { ve.v.pause(); ve.v.removeAttribute('src'); ve.v.load(); this.vids.delete(key); }
    }
  }
  segAt(t) { return this.seg.find(x => t >= x.t0 && t < x.t0 + x.dur) || this.seg[this.seg.length - 1]; }
  // Filmexport: vänta in allt som rutan vid tiden t behöver (foton, kartbitar, rätt bild i filmklippen)
  async prepareAt(t) {
    t = clamp(t, 0, this.total - 1e-3);
    const s = this.segAt(t), u = clamp((t - s.t0) / s.dur, 0, 1), lt = t - s.t0;
    if (s.i != null && s.i !== this.lastI) { this.ensureMedia(s.i); this.lastI = s.i; }
    const waits = [];
    if (s.i != null) for (const k of [s.i - 1, s.i]) if (this.fs[k]) for (const sh of this.fs[k].shots) { const e = this.bmps.get(this.key(sh)); if (e && e.p && !e.bmp) waits.push(e.p); }
    for (const [z, x, y] of this.tiles.neededL(this.camAt(s, u))) for (let l = 0; l < this.tiles.t.length; l++) if (!this.tiles.get(l, z, x, y)) waits.push(this.tiles.load(l, z, x, y));
    if (waits.length) await Promise.all(waits);
    if (s.type === 'montage') {
      const shots = s.f.shots, tt = Math.max(0, lt - this.plan.FADE * 0.5);
      let j = 0; while (j < shots.length - 1 && tt >= shots[j + 1].t0) j++;
      for (let k = Math.max(0, j - 1); k <= j; k++) {
        const sh = shots[k], local = tt - sh.t0;
        if (sh.p.kind !== 'video' || local < 0) continue;
        const e = this.vids.get(this.key(sh)); if (!e) continue;
        await e.ready;
        const target = sh.start + clamp(local, 0, sh.dur - 0.02);
        if (Math.abs(e.v.currentTime - target) > 0.004 && e.v.readyState >= 1) {
          const w = once(e.v, 'seeked', 10000).catch(() => { }); e.v.currentTime = target; await w;
        }
      }
    }
  }
  cleanup() { for (const e of this.vids.values()) { e.v.pause(); e.v.removeAttribute('src'); e.v.load(); } this.vids.clear(); for (const e of this.bmps.values()) if (e.bmp) e.bmp.close(); this.bmps.clear(); }
  bmp(sh) { const e = this.bmps.get(this.key(sh)); return e && e.bmp; }
  lastShot(i) { const f = this.fs[i]; return f && f.shots.length ? this.bmp(f.shots[f.shots.length - 1]) : null; }

  /* ----- rita ----- */
  frame(t) {
    const ctx = this.ctx; t = clamp(t, 0, this.total - 1e-3);
    let s = this.seg.find(x => t >= x.t0 && t < x.t0 + x.dur) || this.seg[this.seg.length - 1];
    const u = clamp((t - s.t0) / s.dur, 0, 1), lt = t - s.t0;
    if (s.i != null && s.i !== this.lastI) { this.ensureMedia(s.i); this.lastI = s.i; }
    if (s !== this.lastSeg) { if (this.lastSeg && this.lastSeg.type === 'montage') this.pauseVideos(this.lastSeg.f); this.lastSeg = s; }
    ctx.setTransform(SC, 0, 0, SC, 0, 0); ctx.imageSmoothingQuality = 'high';
    ctx.save();
    if (s.type === 'title') this.drawTitle(u, lt, s);
    else if (s.type === 'travel') this.drawTravel(u, lt, s);
    else if (s.type === 'montage') this.drawMontage(u, lt, s);
    else this.drawOutro(u, lt, s);
    ctx.restore();
  }
  pauseVideos(f) { for (const sh of f.shots) { const e = this.vids.get(this.key(sh)); if (e) e.v.pause(); } }
  drawRoute(cam, uptoIdx, partial = null, alpha = 1, all = false) {
    const ctx = this.ctx;
    if (all) this.allSubs.forEach(u => strokePath(ctx, cam, u.pts, u.mode, alpha));
    else for (let i = 0; i < uptoIdx && i < this.fs.length; i++) { const f = this.fs[i]; [...f.subs, ...f.inner].forEach(u => { if (u.mode !== 'flight') strokePath(ctx, cam, u.pts, u.mode, alpha); }); }
    if (partial) strokeRuns(ctx, cam, partial.pts, partial.mode, alpha);
    const [hx, hy] = toScreen(cam, this.startP); dot(ctx, hx, hy, 9, '#1f2a36');
    if (this.endP && all) this.flag(cam, this.endP);
    const n = all ? this.fs.length : Math.min(uptoIdx, this.fs.length);
    for (let i = 0; i < n; i++) { for (const v of this.fs[i].viaPts) { const [x, y] = toScreen(cam, v); dot(ctx, x, y, 3.5, '#1f2a36', '#fff', 1.5); } const [x, y] = toScreen(cam, this.fs[i].p); dot(ctx, x, y, 7, '#fff', '#1f2a36', 3); }
  }
  flag(cam, p) {
    const ctx = this.ctx, [x, y] = toScreen(cam, p);
    ctx.save(); dot(ctx, x, y, 7, '#e4572e'); ctx.font = `30px ${EMOJI_FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('🏁', x - 4, y - 2); ctx.restore();
  }
  dayLabel(time) {
    const d = Math.round((new Date(time).setHours(0, 0, 0, 0) - new Date(S.trip.t0).setHours(0, 0, 0, 0)) / 864e5) + 1;
    return `Dag ${d} · ${new Date(time).toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  }
  drawTitle(u, lt, s) {
    const ctx = this.ctx, m = S.meta, T = S.trip;
    drawMap(ctx, this.tiles, s.cam);
    this.drawRoute(s.cam, 0, null, 0.35, true);
    const g = ctx.createLinearGradient(0, 0, FW, 0); g.addColorStop(0, 'rgba(14,19,25,.86)'); g.addColorStop(0.75, 'rgba(14,19,25,.55)'); g.addColorStop(1, 'rgba(14,19,25,.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, FW, FH);
    const a = (d) => clamp((lt - d) / 0.7, 0, 1);
    const fadeOut = clamp((s.dur - lt) / 0.5, 0, 1);
    ctx.fillStyle = '#e4572e'; ctx.globalAlpha = a(0.1) * fadeOut; ctx.font = `600 22px ${SANS}`;
    ctx.fillText('REMEMBER THAT ONE TRIP', 96, 230 - 10 * (1 - a(0.1)));
    ctx.globalAlpha = a(0.35) * fadeOut; ctx.fillStyle = '#fff'; ctx.font = `700 76px ${SERIF}`;
    const tl = wrapText(ctx, m.name, 1000, 2); tl.forEach((l, i) => ctx.fillText(l, 92, 312 + i * 82 - 14 * (1 - a(0.35))));
    let y = 312 + (tl.length - 1) * 82 + 56;
    const dates = dayKey(T.t0) === dayKey(T.t1) ? fmtDate(T.t0) : `${new Date(T.t0).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' })} – ${fmtDate(T.t1)}`;
    ctx.globalAlpha = a(0.7) * fadeOut; ctx.font = `500 26px ${SANS}`; ctx.fillStyle = '#d9dde2';
    ctx.fillText(`${dates} · ${T.days} ${T.days === 1 ? 'dag' : 'dagar'}`, 96, y); y += 48;
    if (m.reason) {
      ctx.globalAlpha = a(1.1) * fadeOut; ctx.font = `italic 28px ${SERIF}`; ctx.fillStyle = '#f3efe6';
      wrapText(ctx, m.reason, 900, 3).forEach((l, i) => ctx.fillText(l, 96, y + i * 40));
    }
  }
  drawTravel(u, lt, s) {
    const ctx = this.ctx, f = s.f, cam = this.camAt(s, u);
    drawMap(ctx, this.tiles, cam);
    const pts = s.path;
    const pu = f.mode === 'flight' ? ease(clamp((u - 0.18) / 0.62, 0, 1)) : ease(clamp((u - 0.12) / 0.7, 0, 1));
    const part = partialPath(pts, pu);
    strokeRuns(ctx, cam, pts, f.mode, 0.22);
    this.drawRoute(cam, s.i, { pts: part, mode: f.mode });
    f.viaPts.forEach(v => { const [vx, vy] = toScreen(cam, v); dot(ctx, vx, vy, 3.5, '#1f2a36', '#fff', 1.5); });
    // fordonet följer vägen
    const head = part[part.length - 1], [x, y] = toScreen(cam, head);
    if (pu > 0 && pu < 1) {
      const back = partialPath(pts, Math.max(0, pu - 0.02)), prevP = back[back.length - 1];
      const [px, py] = toScreen(cam, prevP);
      ctx.save(); ctx.translate(x, y);
      ctx.font = `40px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 8;
      const hm = MODE[head.m] ? head.m : f.mode;   // byter t.ex. till ⛴️ på färjan
      if (hm === 'flight') ctx.rotate(Math.atan2(y - py, x - px) + Math.PI / 4);
      else if (MODE[hm].flip && x > px + 0.5) ctx.scale(-1, 1);   // ikonen tittar åt färdriktningen
      ctx.fillText(MODE[hm].icon, 0, 0); ctx.restore();
    }
    const [tx, ty] = toScreen(cam, f.p);
    const pulse = 10 + 4 * Math.sin(lt * 6);
    ctx.beginPath(); ctx.arc(tx, ty, pulse + 8, 0, Math.PI * 2); ctx.fillStyle = 'rgba(228,87,46,.22)'; ctx.fill();
    if (f.isEnd) this.flag(cam, f.p); else dot(ctx, tx, ty, 10, '#e4572e');
    pill(ctx, this.dayLabel(f.start), 40, 36, { font: `600 22px ${SANS}` });
    const roadKnown = f.subs.every(u => u.mode === 'flight' || u.pts.length > 2 || u.km < 0.3);
    const km = roadKnown || f.mode === 'flight' ? fmtKm(f.est) : `ca ${fmtKm(f.est)}`;
    ctx.globalAlpha = clamp(u / 0.15, 0, 1);
    pill(ctx, `${MODE[f.mode].icon}  ${km}  →  ${f.name}`, 40, FH - 92, { font: `600 28px ${SANS}`, h: 54, padX: 22 });
    ctx.globalAlpha = 1;
    const last = this.lastShot(s.i - 1);
    if (last && lt < 0.45) { ctx.globalAlpha = 1 - easeOut(lt / 0.45); this.drawPhoto(last, 1); ctx.globalAlpha = 1; }
  }
  drawPhoto(bmp, v, dir = 0) {
    const ctx = this.ctx;
    const z = dir % 2 ? 1.1 - 0.07 * v : 1.03 + 0.07 * v;   // bilden är redan 10 % större än rutan
    const dx = (dir % 3 - 1) * 18 * (v - 0.5), dy = ((dir + 1) % 3 - 1) * 10 * (v - 0.5);
    const w = FW * z, h = FH * z;
    ctx.drawImage(bmp, (FW - w) / 2 + dx, (FH - h) / 2 + dy, w, h);
  }
  drawVideo(sh, local) {
    const ctx = this.ctx, e = this.vids.get(this.key(sh)), bg = this.bmp(sh);
    if (bg) ctx.drawImage(bg, 0, 0, FW, FH);
    if (!e) return;
    const v = e.v;
    if (!this.offline) {
      if (!e.started && local >= -0.05) { e.started = true; try { v.currentTime = sh.start; } catch (er) { } v.play().catch(() => { }); }
      if (local > sh.dur + 0.4 && !v.paused) v.pause();
    }
    if (v.readyState >= 2 && v.videoWidth) {
      const vw = v.videoWidth, vh = v.videoHeight, ar = vw / vh;
      let w, h;
      if (ar >= 1.2) { const s = Math.max(FW / vw, FH / vh); w = vw * s; h = vh * s; }
      else { const s = Math.min(FW * 0.9 / vw, FH * 0.94 / vh); w = vw * s; h = vh * s; }
      ctx.drawImage(v, (FW - w) / 2, (FH - h) / 2, w, h);
    }
  }
  drawMontage(u, lt, s) {
    const ctx = this.ctx, f = s.f, F = this.plan.FADE;
    const shots = f.shots;
    const tt = Math.max(0, lt - F * 0.5);
    let j = 0; while (j < shots.length - 1 && tt >= shots[j + 1].t0) j++;
    if (lt < F + 0.05 || !this.bmp(shots[0])) { drawMap(ctx, this.tiles, s.cam); this.drawRoute(s.cam, s.i + 1); }
    const xf = 0.35;
    for (let k = Math.max(0, j - 1); k <= j; k++) {
      const sh = shots[k], local = tt - sh.t0;
      if (local < 0) continue;
      const alpha = k === 0 ? clamp(lt / F, 0, 1) : clamp(local / xf, 0, 1);
      ctx.globalAlpha = easeOut(alpha);
      if (sh.p.kind === 'video') this.drawVideo(sh, local);
      else { const b = this.bmp(sh); if (b) this.drawPhoto(b, clamp(local / (sh.dur + xf), 0, 1), (f.photos.length + k) % 4); }
    }
    // starta nästa klipp i tid (förladdning)
    const nx = shots[j + 1]; if (!this.offline && nx && nx.p.kind === 'video' && tt > nx.t0 - 0.3) { const e = this.vids.get(this.key(nx)); if (e && !e.started) { e.started = true; e.v.play().catch(() => { }); } }
    ctx.globalAlpha = 1;
    const ca = clamp((lt - 0.25) / 0.5, 0, 1);
    const g = ctx.createLinearGradient(0, FH - 260, 0, FH); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.72)');
    ctx.globalAlpha = ca; ctx.fillStyle = g; ctx.fillRect(0, FH - 260, FW, 260);
    ctx.fillStyle = '#fff'; ctx.font = `700 54px ${SERIF}`; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12;
    const name = wrapText(ctx, f.name, FW - 420, 1)[0];
    ctx.fillText(name, 56 + 16 * (1 - ca), FH - 92);
    ctx.font = `500 24px ${SANS}`; ctx.fillStyle = '#e6e2da';
    const sub = [this.dayLabel(f.start), f.country, f.distFromStart >= 1 ? `${fmtKm(f.distFromStart)} från start` : 'vid start'].filter(Boolean).join('  ·  ');
    ctx.fillText(sub, 58 + 16 * (1 - ca), FH - 50);
    ctx.shadowBlur = 0;
    this.drawInset(s.i, ca);
    ctx.globalAlpha = 1;
  }
  // hörnkartan visar bara den del av resan man är i just nu (delas upp vid flygningar)
  regionOf(i) {
    if (!this.regions) {
      let r = 0; this.regions = this.fs.map((f, k) => { if (k > 0 && f.subs.some(u => u.mode === 'flight')) r++; return r; });
      this.startRegion = this.fs.length && this.fs[0].subs.some(u => u.mode === 'flight') ? -1 : 0;
      this.insetCams = {};
    }
    return this.regions[i];
  }
  insetCam(reg, W, H) {
    if (this.insetCams[reg]) return this.insetCams[reg];
    const pts = [];
    this.fs.forEach((f, k) => { if (this.regions[k] !== reg) return; pts.push(f.p); [...f.subs, ...f.inner].forEach(u => { if (u.mode !== 'flight') pts.push(...u.pts); }); });
    if (reg === this.startRegion) pts.push(this.startP);
    return this.insetCams[reg] = camFit(pts, 18, W, H, 12, 0);
  }
  drawInset(i, alpha) {
    const ctx = this.ctx, W = 230, H = 150, X = FW - W - 32, Y = 28;
    const reg = this.regionOf(i), cam = this.insetCam(reg, W, H);
    ctx.save(); ctx.globalAlpha = alpha * 0.92;
    roundRect(ctx, X, Y, W, H, 14); ctx.fillStyle = 'rgba(14,19,25,.62)'; ctx.fill(); ctx.clip();
    ctx.translate(X, Y);
    for (let k = 0; k < this.fs.length; k++) {
      if (this.regions[k] !== reg) continue;
      for (const u of [...this.fs[k].subs, ...this.fs[k].inner]) {
        if (u.mode === 'flight' || u.pts.length < 2) continue;
        ctx.beginPath(); u.pts.forEach((p, n) => { const [x, y] = toScreen(cam, p, W, H); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.setLineDash(u.mode === 'ferry' ? [5, 4] : []); ctx.lineWidth = k <= i ? 2.5 : 1.5;
        ctx.strokeStyle = k <= i ? '#ff8a5c' : 'rgba(255,255,255,.28)'; ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    if (reg === this.startRegion) { const [hx, hy] = toScreen(cam, this.startP, W, H); dot(ctx, hx, hy, 4, '#fff', '#fff', 1); }
    this.fs.forEach((f, k) => { if (this.regions[k] === reg && k !== i) { const [x, y] = toScreen(cam, f.p, W, H); dot(ctx, x, y, 2.5, k < i ? '#ff8a5c' : 'rgba(255,255,255,.5)', 'transparent', 0); } });
    const [cx, cy] = toScreen(cam, this.fs[i].p, W, H); dot(ctx, cx, cy, 6, '#e4572e', '#fff', 2);
    ctx.restore();
  }
  drawOutro(u, lt, s) {
    const ctx = this.ctx, T = S.trip, cam = this.camAt(s, u);
    drawMap(ctx, this.tiles, cam);
    this.drawRoute(cam, 0, null, 1, true);
    const a = clamp((lt - 0.6) / 0.8, 0, 1);
    const g = ctx.createLinearGradient(0, 0, FW * 0.7, 0); g.addColorStop(0, 'rgba(14,19,25,.88)'); g.addColorStop(1, 'rgba(14,19,25,0)');
    ctx.globalAlpha = a; ctx.fillStyle = g; ctx.fillRect(0, 0, FW, FH);
    ctx.fillStyle = '#fff'; ctx.font = `700 60px ${SERIF}`;
    wrapText(ctx, S.meta.name, 640, 2).forEach((l, k) => ctx.fillText(l, 80, 190 + k * 66));
    const lines = [
      [`${fmtKm(T.total)}`, 'rest totalt'],
      [`${S.stops.length}`, 'stopp'],
      [`${T.days}`, T.days === 1 ? 'dag' : 'dagar'],
      [`${T.nPhotos}`, T.nVideos ? `bilder · ${T.nVideos} klipp` : 'bilder'],
    ];
    let y = 330;
    lines.forEach(([big, small], k) => {
      ctx.globalAlpha = clamp((lt - 1.0 - k * 0.25) / 0.5, 0, 1);
      ctx.font = `700 40px ${SERIF}`; ctx.fillStyle = '#fff'; ctx.fillText(big, 80, y);
      const w = ctx.measureText(big).width; ctx.font = `500 24px ${SANS}`; ctx.fillStyle = '#c9ced4'; ctx.fillText(small, 92 + w, y); y += 54;
    });
    ctx.globalAlpha = clamp((lt - 2.2) / 0.6, 0, 1);
    ctx.font = `500 22px ${SANS}`; ctx.fillStyle = '#ff8a5c';
    if (T.far.distFromStart > 2) ctx.fillText(`Längst bort: ${stopName(T.far)} – ${fmtKm(T.far.distFromStart)} från start`, 80, y + 14);
    const modes = Object.entries(T.byMode).filter(([, v]) => v > 0.5).map(([k, v]) => `${MODE[k].icon} ${fmtKm(v)}`).join('    ');
    ctx.fillStyle = '#d9dde2'; ctx.fillText(modes, 80, y + 52);
    const fo = clamp((lt - (s.dur - 1.3)) / 1.3, 0, 1);
    if (fo > 0) { ctx.globalAlpha = fo; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FW, FH); }
    ctx.globalAlpha = 1;
  }
}

const compSize = () => [Math.round(FW * SC * 1.1), Math.round(FH * SC * 1.1)];   // +10 % så att zoomeffekten inte förstorar upp
function composeFrom(src, sw, sh) {
  const [CW, CH] = compSize(), k = CW / FW;
  const c = new OffscreenCanvas(CW, CH), g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  const ar = sw / sh;
  const cover = () => { const s = Math.max(CW / sw, CH / sh); g.drawImage(src, (CW - sw * s) / 2, (CH - sh * s) / 2, sw * s, sh * s); };
  if (ar >= 1.2) cover();
  else {
    g.filter = `blur(${Math.round(30 * k)}px) brightness(.62) saturate(1.2)`; cover(); g.filter = 'none';
    const s = Math.min(CW * 0.9 / sw, CH * 0.94 / sh), w = sw * s, h = sh * s;
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 40 * k;
    g.drawImage(src, (CW - w) / 2, (CH - h) / 2, w, h);
  }
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}
async function loadOriented(file) {
  const url = URL.createObjectURL(file), img = new Image();
  try { img.src = url; await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  // behåll full upplösning upp till vad filmen behöver (aldrig uppskalning)
  const [CW, CH] = compSize(), s = Math.min(1, Math.max(CW / img.naturalWidth, CH / img.naturalHeight) * 1.05);
  const c = new OffscreenCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function composePhoto(p) {
  try { const c = await loadOriented(await getFile(p.entry)); return await composeFrom(c, c.width, c.height); }
  catch (e) { return null; }
}
async function composeVideoPoster(p, start) {
  try {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = await fullUrl(p); await once(v, 'loadeddata', 15000);
    if (isFinite(v.duration)) p.duration = v.duration;
    v.currentTime = start || 0.01; await once(v, 'seeked', 15000);
    const b = await composeFrom(v, v.videoWidth, v.videoHeight);
    v.removeAttribute('src'); v.load();
    return b;
  } catch (e) { p.unplayable = true; return null; }
}

/* ---------- export: bild för bild till MP4 (WebCodecs + mp4-muxer) ----------
   Oberoende av om fönstret syns, och ger en vanlig MP4 med fast bildfrekvens. */
const FPS = 30;
const yieldTask = (() => { const ch = new MessageChannel(), q = []; ch.port1.onmessage = () => q.shift()(); return () => new Promise(r => { q.push(r); ch.port2.postMessage(0); }); })();
async function pickVideoConfig() {
  if (!window.VideoEncoder || !window.VideoFrame) return null;
  const W = Math.round(FW * SC), H = Math.round(FH * SC), big = SC > 1.5;
  const codecs = big ? ['avc1.640033', 'avc1.4d0033', 'avc1.640034'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f'];
  const bitrate = SC >= 3 ? 40_000_000 : SC >= 1.5 ? 14_000_000 : 7_000_000;
  for (const codec of codecs) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality' };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (e) { }
  }
  return null;
}
async function pickAudioConfig() {
  if (!window.AudioEncoder || !window.AudioData) return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, mux }; } catch (e) { }
  }
  return null;
}
// Musiken skapas i bitar om 30 s (med 4 s förspel så att toner och eko hänger med över skarvarna).
// Då blir det aldrig ett jättejobb, minnet räcker även för långa filmer och vi kan visa förlopp.
async function renderMusic(total, music, onProgress = () => { }) {
  if (music === 'none') return null;
  const sr = 48000, len = Math.ceil(sr * total), out = [new Float32Array(len), new Float32Array(len)];
  if (music === 'own' && FILM.ownMusic) {
    onProgress(0, 0, 1);
    const buf = await new OfflineAudioContext(2, 1, sr).decodeAudioData(await FILM.ownMusic.arrayBuffer());
    for (let c = 0; c < 2; c++) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), n = src.length;
      for (let o = 0; o < len; o += n) out[c].set(src.subarray(0, Math.min(n, len - o)), o);
    }
    onProgress(1, 1, 1);
  } else {
    const style = music === 'own' ? 'roadtrip' : music, seed = S.meta.name + S.folderName, PRE = 4;
    const pc = new OfflineAudioContext(2, 1, sr), probe = new TravelMusic(pc, pc.destination, { style, seed, duration: total });
    const bar = probe.bar, nBars = probe.nBars;
    // rendera ett tidsfönster [ws, we) och lägg det på plats 'dst' i utdata
    const renderWin = async (ws, we, dst = ws) => {
      if (FILM.cancel) throw new Error('Avbruten');
      const pre = Math.min(PRE, ws);
      const oc = new OfflineAudioContext(2, Math.ceil(sr * (we - ws + pre)) + 1, sr);
      new TravelMusic(oc, oc.destination, { style, seed, duration: total }).startWindow(ws - pre, we);
      const r = await oc.startRendering();
      const from = Math.round(pre * sr), at = Math.round(dst * sr), n = Math.min(len - at, Math.round((we - ws) * sr));
      for (let c = 0; c < 2; c++) out[c].set(r.getChannelData(c).subarray(from, from + n), at);
      return r;
    };
    // efter introt upprepas låten exakt var 16:e takt -> rendera början, en slinga och slutet, och kopiera slingan däremellan
    const H = 20, C = 16, cycleEnd = H + C;
    const copies = nBars > cycleEnd + C + 4 ? Math.floor((nBars - 4 - cycleEnd) / C) : 0;
    const plan = [];
    if (copies > 0) {
      plan.push([0, H * bar]);
      plan.push([H * bar, cycleEnd * bar, 'cycle']);
      plan.push([(cycleEnd + copies * C) * bar, total]);
    } else plan.push([0, total]);
    // dela upp i bitar om högst 30 s
    const jobs = [];
    for (const [ws, we, tag] of plan) { if (tag) { jobs.push([ws, we, tag]); continue; } for (let t = ws; t < we - 1e-6; t += 30) jobs.push([t, Math.min(we, t + 30)]); }
    for (let k = 0; k < jobs.length; k++) {
      const [ws, we, tag] = jobs[k];
      await renderWin(ws, we);
      if (tag === 'cycle') {
        // kopiera slingan framåt
        const a0 = Math.round(ws * sr), n = Math.round((we - ws) * sr);
        for (let m = 1; m <= copies; m++) {
          const at = Math.round((ws + m * C * bar) * sr), cnt = Math.min(n, len - at);
          if (cnt <= 0) break;
          for (let c = 0; c < 2; c++) out[c].copyWithin(at, a0, a0 + cnt);
        }
      }
      onProgress((k + 1) / jobs.length, k + 1, jobs.length);
      await yieldTask();
    }
  }
  // tona in 1,2 s och ut 3,5 s
  const fin = Math.round(1.2 * sr), fout = Math.round(Math.min(3.5, total / 3) * sr);
  for (let c = 0; c < 2; c++) {
    const d = out[c];
    for (let i = 0; i < fin && i < len; i++) d[i] *= i / fin;
    for (let i = 0; i < fout; i++) d[len - 1 - i] *= i / fout;
  }
  return { sampleRate: sr, length: len, getChannelData: c => out[c] };
}
async function exportFilm(mk, total, music, vcfg, acfg, onProgress, onMusic, out) {
  const audio = acfg ? await renderMusic(total, music, onMusic) : null;
  // skriv direkt till filen i resmappen när det går – då behöver inte hela filmen få plats i minnet
  const muxer = new Mp4Muxer.Muxer({
    target: out ? new Mp4Muxer.FileSystemWritableFileStreamTarget(out.stream) : new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: Math.round(FW * SC), height: Math.round(FH * SC), frameRate: FPS },
    audio: audio ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined,
    fastStart: out ? false : 'in-memory', firstTimestampBehavior: 'offset',
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => encErr = e });
  venc.configure(vcfg);
  mk.offline = true;
  const N = Math.ceil(total * FPS), cv = mk.cv;
  for (let i = 0; i < N; i++) {
    if (FILM.cancel) throw new Error('Avbruten');
    if (encErr) throw encErr;
    const t = i / FPS;
    await mk.prepareAt(t);
    mk.frame(t);
    const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => venc.addEventListener('dequeue', r, { once: true }));
    if (i % 6 === 0) { onProgress(i / N, i, N); await yieldTask(); }
  }
  await venc.flush(); venc.close();
  if (audio) {
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => encErr = e });
    aenc.configure(acfg.cfg);
    const sr = audio.sampleRate, len = Math.min(audio.length, Math.ceil(total * sr)), ch0 = audio.getChannelData(0), ch1 = audio.getChannelData(1), step = 4800;
    for (let off = 0; off < len; off += step) {
      const n = Math.min(step, len - off), data = new Float32Array(n * 2);
      data.set(ch0.subarray(off, off + n), 0); data.set(ch1.subarray(off, off + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(off / sr * 1e6), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 20) await new Promise(r => aenc.addEventListener('dequeue', r, { once: true }));
    }
    await aenc.flush(); aenc.close();
    if (encErr) throw encErr;
  }
  muxer.finalize();
  if (out) { await out.stream.close(); out.closed = true; return await out.handle.getFile(); }
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

/* ---------- filmdialog: steg 1 urval, steg 2 musik & inspelning ---------- */
const FILM = { blob: null, ext: 'webm', running: false, ownMusic: null, stopFn: null };
// stor förloppsruta över filmrutan medan filmen skapas
const FP_STEPS = ['Bilder och klipp', 'Kartbilder', 'Musik', 'Filmen'];
function fpShow(step, { big = '', of = '', unit = '', sub = '', eta = '', frac = null } = {}) {
  const el = $('#filmProg'); el.classList.add('on');
  $('#fpSteps').innerHTML = FP_STEPS.map((t, k) => `<li class="${k < step ? 'done' : k === step ? 'cur' : ''}"><span>${k < step ? '✓' : k + 1}</span>${t}</li>`).join('');
  $('#fpTitle').textContent = ['Förbereder bilder och klipp', 'Hämtar kartbilder', 'Skapar musiken', 'Skapar filmen'][step];
  $('#fpBig').innerHTML = big === '' ? '<div class="spin"></div>' : `${big}${of !== '' ? `<span> / ${of}</span>` : ''}`;
  $('#fpUnit').textContent = unit; $('#fpSub').textContent = sub; $('#fpEta').textContent = eta;
  $('#fpBar').style.width = frac == null ? '0' : `${(frac * 100).toFixed(1)}%`;
  if (frac != null) $('#filmBar').style.width = `${(frac * 100).toFixed(1)}%`;
}
function fpHide() { $('#filmProg').classList.remove('on'); }
function etaText(t0, f) {
  const el = (performance.now() - t0) / 1000; if (f < 0.03 || el < 2) return 'beräknar tid kvar…';
  const left = el / f - el; return left > 90 ? `ca ${Math.round(left / 60)} min kvar` : `ca ${Math.max(1, Math.round(left))} s kvar`;
}
function filmStatus(msg, frac) { $('#filmStatus').textContent = msg; if (frac != null) $('#filmBar').style.width = `${(frac * 100).toFixed(1)}%`; }
function filmStep(n) {
  $('#filmPick').style.display = n === 1 ? '' : 'none';
  $('#filmRec').style.display = n === 2 ? '' : 'none';
  $('#filmSetup').style.display = n === 2 ? '' : 'none';
  $('#filmDone').style.display = 'none'; $('#filmVideo').style.display = 'none'; $('#filmCanvas').style.display = n === 2 ? '' : 'none';
}
function openFilm() {
  const cfg = filmCfg();
  if (!cfg.sel) { cfg.sel = autoSelect(cfg.len); saveMeta(); }
  $('#film').classList.add('on');
  $('#filmTempo').value = cfg.tempo; $('#filmClip').value = String(cfg.clip); $('#autoLen').value = String(cfg.len);
  filmStep(1); renderPicker();
}
let pickSaveT = null;
function pickChanged() {
  clearTimeout(pickSaveT); pickSaveT = setTimeout(() => saveMeta(), 600);
  updatePickSummary();
}
function updatePickSummary() {
  const fs = buildFilmStops(filmCfg().sel);
  if (!fs.length) { $('#pickSum').textContent = 'Inget valt – välj minst en bild.'; $('#pickNext').disabled = true; return; }
  const plan = planFilm(fs), shots = fs.flatMap(f => f.shots);
  const v = shots.filter(s => s.p.kind === 'video').length;
  $('#pickSum').textContent = `${fs.length} ${fs.length === 1 ? 'plats' : 'platser'} · ${shots.length - v} bilder${v ? ` · ${v} klipp` : ''} · film ca ${fmtMMSS(plan.total)}`;
  $('#pickNext').disabled = false;
}
function renderPicker() {
  const cfg = filmCfg(), sel = new Set(cfg.sel);
  const list = $('#pickList'); list.innerHTML = '';
  let lastDay = null;
  S.stops.forEach(s => {
    if (s.manual || !s.photos.length) return;
    const dk = dayKey(s.start);
    if (dk !== lastDay) { list.insertAdjacentHTML('beforeend', `<div class="pday">${fmtDay(s.start)}</div>`); lastDay = dk; }
    const box = document.createElement('div'); box.className = 'pstop';
    box.innerHTML = `<div class="phead"><span class="num">${s.idx + 1}</span><b>${esc(stopName(s))}</b>
      <span class="muted">${fmtTime(s.start)} · ${countTxt(s)}</span><span class="pcount"></span>
      <span class="sp"></span><button class="ghost mini" data-a="all">Alla</button><button class="ghost mini" data-a="none">Inga</button></div><div class="pgrid"></div>`;
    const grid = box.querySelector('.pgrid'), cnt = box.querySelector('.pcount');
    const cells = [];
    const refresh = () => {
      let n = 0; cells.forEach(({ el, p }) => { const on = sel.has(p.path); el.classList.toggle('on', on); el.querySelector('.ord').textContent = on ? ++n : ''; });
      cnt.textContent = n ? `${n} med i filmen` : 'passeras bara';
      box.classList.toggle('skip', !n);
    };
    s.photos.forEach(p => {
      const el = document.createElement('div'); el.className = 'pcell' + (p.kind === 'video' ? ' vid' : '');
      el.innerHTML = `<img alt=""><span class="ord"></span><span class="zoom" title="Visa större">⤢</span>`;
      lazyThumb(el.querySelector('img'), p);
      el.onclick = e => {
        if (e.target.classList.contains('zoom')) { openLightbox(p); return; }
        if (sel.has(p.path)) sel.delete(p.path); else sel.add(p.path);
        cfg.sel = S.photos.filter(q => sel.has(q.path)).map(q => q.path); refresh(); pickChanged();
      };
      cells.push({ el, p }); grid.appendChild(el);
    });
    box.querySelector('[data-a=all]').onclick = () => { s.photos.forEach(p => sel.add(p.path)); cfg.sel = S.photos.filter(q => sel.has(q.path)).map(q => q.path); refresh(); pickChanged(); };
    box.querySelector('[data-a=none]').onclick = () => { s.photos.forEach(p => sel.delete(p.path)); cfg.sel = S.photos.filter(q => sel.has(q.path)).map(q => q.path); refresh(); pickChanged(); };
    refresh();
    list.appendChild(box);
  });
  updatePickSummary();
}
$('#autoBtn').onclick = () => { const cfg = filmCfg(); cfg.len = +$('#autoLen').value; cfg.sel = autoSelect(cfg.len); renderPicker(); pickChanged(); };
$('#filmTempo').onchange = () => { filmCfg().tempo = $('#filmTempo').value; pickChanged(); };
$('#filmClip').onchange = () => { filmCfg().clip = +$('#filmClip').value; pickChanged(); };
$('#pickNext').onclick = () => {
  filmStep(2);
  $('#filmMusic').value = filmCfg().music && filmCfg().music !== 'own' ? filmCfg().music : (S.trip.type === 'stay' ? 'calm' : 'roadtrip');
  $('#filmRes').value = String(filmCfg().res);
  const mk = new FilmMaker($('#filmCanvas'));
  const dur = mk.prepareTimeline();
  FILM.preview = mk;
  filmStatus(`${mk.fs.length} platser · ${mk.fs.reduce((a, f) => a + f.shots.length, 0)} bilder/klipp · ${fmtMMSS(dur)}. Välj musik och tryck på Spela in.`, 0);
  drawPoster(mk);
};
$('#filmBack').onclick = () => { filmStep(1); };
$('#fpCancel').onclick = () => { FILM.cancel = true; };
$('#filmRes').onchange = () => { filmCfg().res = +$('#filmRes').value; saveMeta(); $('#pickNext').onclick(); };
async function drawPoster(mk) {
  mk.tiles.neededL(mk.seg[0].cam).forEach(([z, x, y]) => mk.tiles.t.forEach((_, l) => mk.tiles.load(l, z, x, y)));
  for (let k = 0; k < 12 && FILM.preview === mk && !FILM.running; k++) { mk.frame(2.2); await sleep(250); }
}
$('#filmBtn').onclick = openFilm;
$('#filmMusic').onchange = () => { const v = $('#filmMusic').value; if (v === 'own') $('#musicFile').click(); else { filmCfg().music = v; saveMeta(); } };
$('#musicFile').onchange = e => {
  FILM.ownMusic = e.target.files[0] || null;
  if (FILM.ownMusic) { const o = $('#filmMusic').querySelector('option[value=own]'); o.textContent = `Musik: ${FILM.ownMusic.name}`; }
  else $('#filmMusic').value = 'roadtrip';
};
$('#filmClose').onclick = () => { FILM.cancel = true; if (FILM.stopFn) FILM.stopFn(true); $('#film').classList.remove('on'); $('#filmVideo').pause(); };
$('#filmAgain').onclick = openFilm;
$('#filmReplay').onclick = () => { const v = $('#filmVideo'); v.currentTime = 0; v.play(); };
$('#filmDownload').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(FILM.blob); a.download = filmFileName(); a.click();
};
$('#filmSave').onclick = async () => {
  try {
    const h = await S.dir.getFileHandle(filmFileName(), { create: true });
    const w = await h.createWritable(); await w.write(FILM.blob); await w.close();
    filmStatus(`Sparad i resmappen som ${filmFileName()} ✔`);
  } catch (e) { filmStatus(`Kunde inte spara (${e.message}). Använd Ladda ner istället.`); }
};
const filmFileName = () => `${(S.meta.name || 'resa').toLowerCase().replace(/[^a-z0-9åäöéü]+/gi, '-').replace(/^-|-$/g, '')}-film.${FILM.ext}`;

function filmFinished(total, bad) {
  const v = $('#filmVideo'); v.src = URL.createObjectURL(FILM.blob);
  $('#filmCanvas').style.display = 'none'; v.style.display = '';
  $('#filmDone').style.display = ''; $('#filmSave').style.display = S.canWrite && !FILM.saved ? '' : 'none';
  filmStatus(`Klar! ${fmtMMSS(total)}, ${(FILM.blob.size / 1e6).toFixed(1)} MB (${FILM.ext}).${FILM.saved ? ` Sparad i resmappen som ${filmFileName()}.` : ''}${bad ? ` ${bad} bild/klipp kunde inte läsas och hoppades över.` : ''}`, 1);
}
$('#filmGo').onclick = async () => {
  if (FILM.running) return;
  FILM.running = true; FILM.cancel = false; FILM.saved = false; FILM.out = null;
  $('#filmSetup').style.display = 'none';
  const mk = new FilmMaker($('#filmCanvas')); FILM.preview = null;
  const music = $('#filmMusic').value;
  try {
    mk.prepareTimeline();
    $('#filmStatus').textContent = '';
    const tm = performance.now();
    fpShow(0, { big: 0, of: mk.fs.reduce((a, f) => a + f.shots.length, 0), unit: 'bilder och klipp', frac: 0, sub: 'Läser bilderna i full upplösning' });
    const bad = await mk.prepareMedia((f, n, N) => fpShow(0, { big: n, of: N, unit: 'bilder och klipp', frac: f, sub: 'Läser bilderna i full upplösning', eta: etaText(tm, f) }));
    if (FILM.cancel) throw new Error('Avbruten');
    const total = mk.prepareTimeline();           // om något inte gick att läsa
    if (!total) throw new Error('Inga bilder kunde läsas');
    const tt = performance.now();
    fpShow(1, { big: 0, of: '…', unit: 'kartbitar', frac: 0, sub: 'Hämtas från nätet en gång per film' });
    const tr = await mk.prefetchTiles((f, n, N) => fpShow(1, { big: n, of: N, unit: 'kartbitar', frac: f, sub: 'Hämtas från nätet en gång per film', eta: etaText(tt, f) }));
    if (FILM.cancel) throw new Error('Avbruten');
    const tileWarn = tr.ok < tr.total * 0.5 ? 'Kartbilderna gick inte att hämta (offline?) – filmen görs ändå. ' : '';
    const vcfg = await pickVideoConfig(), acfg = await pickAudioConfig();
    if (vcfg && window.Mp4Muxer) {
      // bild för bild – fungerar även om fönstret är dolt
      const musicSub = music === 'none' ? 'Ingen musik vald' : music === 'own' ? 'Läser in din ljudfil' : 'Komponeras för just den här resan';
      fpShow(2, { sub: musicSub });
      FILM.ext = 'mp4';
      FILM.out = null;
      if (S.canWrite && S.dir) {
        try { const handle = await S.dir.getFileHandle(filmFileName(), { create: true }); FILM.out = { handle, stream: await handle.createWritable() }; }
        catch (e) { console.warn('kan inte skriva direkt', e); FILM.out = null; }
      }
      let t0 = 0, tmus = performance.now();
      FILM.blob = await exportFilm(mk, total, music, vcfg, acfg, (f, i, n) => {
        if (!t0) t0 = performance.now();
        fpShow(3, { big: Math.round(f * 100) + '<span>%</span>', unit: `bild ${i} av ${n}`, frac: f, eta: etaText(t0, f), sub: tileWarn + (FILM.out ? 'Sparas direkt i resmappen. ' : '') + 'Du kan använda datorn under tiden.' });
      }, (f, k, n) => fpShow(2, { big: k, of: n, unit: n === 1 ? 'del' : 'delar', frac: f, sub: musicSub, eta: etaText(tmus, f) }), FILM.out);
      fpHide();
      FILM.saved = !!FILM.out;
      FILM.ext = 'mp4'; mk.cleanup();
      filmFinished(total, bad);
      return;
    }
    // reserv: realtidsinspelning (äldre webbläsare)
    fpHide();
    await recordRealtime(mk, total, music, bad);
  } catch (e) {
    console.error(e);
    fpHide();
    if (FILM.out && !FILM.out.closed) { try { await FILM.out.stream.abort(); } catch (er) { } }
    if (FILM.cancel) filmStatus('Avbruten.'); else filmStatus(`Något gick fel: ${e.message}`);
    $('#filmSetup').style.display = ''; mk.cleanup();
  } finally { FILM.running = false; }
};
async function recordRealtime(mk, total, music, bad) {
  const ac = new (window.AudioContext || window.webkitAudioContext)(); await ac.resume();
  mk.ensureMedia(0);
  await sleep(400);
  const out = ac.createGain(); out.connect(ac.destination);
  const msd = ac.createMediaStreamDestination(); out.connect(msd);
  let synth = null, src = null;
  const t0 = ac.currentTime + 0.6;
  if (music === 'own' && FILM.ownMusic) {
    const buf = await ac.decodeAudioData(await FILM.ownMusic.arrayBuffer());
    src = ac.createBufferSource(); src.buffer = buf; src.loop = buf.duration < total;
    const g = ac.createGain(); src.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + 1);
    g.gain.setValueAtTime(1, t0 + total - 3.5); g.gain.linearRampToValueAtTime(0, t0 + total);
  } else if (music !== 'none') {
    synth = new TravelMusic(ac, out, { style: music === 'own' ? 'roadtrip' : music, seed: S.meta.name + S.folderName, duration: total });
  }
  const vs = $('#filmCanvas').captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...msd.stream.getAudioTracks()]);
  const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  FILM.ext = mime && mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => rec.onstop = r);
  mk.frame(0);
  await sleep(100);
  rec.start(1000);
  if (synth) synth.start(t0); if (src) src.start(t0);
  let cancelled = false, raf, watchdog;
  await new Promise(resolve => {
    const done = c => { cancelled = !!c; cancelAnimationFrame(raf); clearInterval(watchdog); resolve(); };
    FILM.stopFn = done;
    // vakt: avsluta även om fönstret döljs och ritandet stannar
    watchdog = setInterval(() => { if (ac.currentTime - t0 >= total + 0.2) done(false); }, 500);
    const loop = () => {
      const t = ac.currentTime - t0;
      if (t >= total + 0.2) { done(false); return; }
      mk.frame(Math.max(0, t));
      $('#filmBar').style.width = `${clamp(t / total, 0, 1) * 100}%`;
      $('#filmStatus').textContent = `Spelar in… ${Math.max(0, Math.floor(t))} / ${Math.round(total)} s  (håll fönstret synligt – din webbläsare saknar stöd för snabbexport)`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  });
  FILM.stopFn = null;
  rec.stop(); await stopped;
  if (synth) synth.stop(); if (src) try { src.stop(); } catch (e) { }
  ac.close(); mk.cleanup();
  if (cancelled) return;
  FILM.blob = new Blob(chunks, { type: mime || 'video/webm' });
  filmFinished(total, bad);
}
