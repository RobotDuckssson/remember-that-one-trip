'use strict';
/* =========================================================================
   Remember That One Trip – kärna: läsa mapp, EXIF, stopp, färdsätt, karta
   ========================================================================= */
const $ = s => document.querySelector(s);
const META_FILE = 'remember-that-one-trip.json';
const IMG_RE = /\.(jpe?g|heic|heif|png|webp|tiff?)$/i;
const VID_RE = /\.(mp4|mov|m4v)$/i;
const SKIP_RE = /^(screenshot|screen shot|skärmbild)/i;
const STOP_RADIUS_KM = 1.5;     // bilder inom denna radie hör till samma stopp
const STOP_MAX_GAP_H = 6;       // längre paus än så = nytt stopp även på samma plats
const ROAD_FACTOR = 1.25;       // fågelväg -> ungefärlig körsträcka
const MODE = {
  car:    { icon: '🚗', label: 'Bil',       color: '#e4572e', factor: 1.25, flip: true },
  bus:    { icon: '🚌', label: 'Buss',      color: '#d18a00', factor: 1.25, flip: true },
  train:  { icon: '🚆', label: 'Tåg',       color: '#7b4fa0', factor: 1.2 },
  bike:   { icon: '🚲', label: 'Cykel',     color: '#4c9f38', factor: 1.3, flip: true },
  walk:   { icon: '🚶', label: 'Till fots', color: '#2a9d8f', factor: 1.3, flip: true },
  ferry:  { icon: '⛴️', label: 'Båt/färja', color: '#1d7fbf', factor: 1.1, flip: true },
  flight: { icon: '✈️', label: 'Flyg',      color: '#3d5a80', factor: 1 },
};
// linjestil per färdsätt (Leaflet dashArray / vikt)
const LINE = { car: [4, null], bus: [4, '10 4'], train: [4, '1 0'], bike: [3, '6 5'], walk: [3, '2 6'], ferry: [3, '4 8'], flight: [3, '8 8'] };

// Kartor utan API-nyckel (Esri). CARTO kräver nyckel sedan sept 2026, OSM blockerar lokala filer.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const T_ = n => ESRI + n + '/MapServer/tile/{z}/{y}/{x}';
const STREET = T_('World_Street_Map');
// Kartstilar: färdiga Esri-kartor + färgfilter (som Googles kartstilar). bg = bakgrund innan kartbitarna laddats.
const BASEMAPS = {
  street:    { name: 'Klassisk', layers: [STREET] },
  silver:    { name: 'Silver', layers: [T_('Canvas/World_Light_Gray_Base'), T_('Canvas/World_Light_Gray_Reference')], maxNative: 16 },
  retro:     { name: 'Retro', layers: [STREET], filter: 'sepia(0.65) saturate(0.8) hue-rotate(-10deg) contrast(0.92) brightness(1.03)', bg: '#efe2c6' },
  natgeo:    { name: 'National Geographic', layers: [T_('NatGeo_World_Map')], maxNative: 16, bg: '#d9e3e3' },
  pastel:    { name: 'Pastell', layers: [STREET], filter: 'saturate(0.55) brightness(1.1) contrast(0.85)', bg: '#eef0f2' },
  topo:      { name: 'Terräng', layers: [T_('World_Topo_Map')] },
  ocean:     { name: 'Hav', layers: [T_('Ocean/World_Ocean_Base')], maxNative: 16, bg: '#a9c6de' },
  mono:      { name: 'Svartvit', layers: [STREET], filter: 'grayscale(1) contrast(1.1)', bg: '#e6e6e6' },
  dark:      { name: 'Mörk', layers: [T_('Canvas/World_Dark_Gray_Base'), T_('Canvas/World_Dark_Gray_Reference')], maxNative: 16, bg: '#24272b', dark: true },
  night:     { name: 'Natt', layers: [STREET], filter: 'invert(0.92) hue-rotate(180deg) saturate(0.7) brightness(0.95)', bg: '#1d2733', dark: true },
  aubergine: { name: 'Aubergine', layers: [STREET], filter: 'invert(0.9) hue-rotate(215deg) saturate(1.3) brightness(0.85)', bg: '#2a1f3a', dark: true },
  sat:       { name: 'Satellit', layers: [T_('World_Imagery'), T_('Reference/World_Boundaries_and_Places')], bg: '#1b2a1f', dark: true },
};
const BASEMAP_ATTR = 'Kartdata &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, NGS, &copy; OpenStreetMap-bidragsgivare';
(() => { // CSS-filter per kartstil
  const css = Object.entries(BASEMAPS).filter(([, b]) => b.filter).map(([k, b]) => `.tl-${k}{filter:${b.filter}}`).join('\n');
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
})();
function basemapLayer(key) {
  const b = BASEMAPS[key] || BASEMAPS.street;
  return L.layerGroup(b.layers.map((u, i) => L.tileLayer(u, { maxZoom: 19, maxNativeZoom: b.maxNative || 18, className: 'tl-' + key, attribution: i ? '' : BASEMAP_ATTR })));
}
function currentBasemap() { return (S.meta && BASEMAPS[S.meta.basemap]) ? S.meta.basemap : 'street'; }

const S = {            // global state
  dir: null, canWrite: false, folderName: '', entries: [],
  photos: [], geo: [], stops: [], legs: [], meta: null, trip: null,
  map: null, layers: null, markers: [], thumbCache: new Map(), objUrls: new Map(),
};

/* ---------- helpers ---------- */
const toRad = d => d * Math.PI / 180;
function hav(aLat, aLon, bLat, bLon) {
  const R = 6371, dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
const fmtKm = km => km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1).replace('.', ',')} km` : `${Math.round(km).toLocaleString('sv-SE')} km`;
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24); return `${d} d ${h % 24} h`;
}
const fmtTime = t => new Date(t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = t => new Date(t).toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDate = t => new Date(t).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pretty = s => (s || 'Min resa').replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
async function pool(items, n, fn) {
  let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}
function timeFromName(name) {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/* ---------- video: tid, längd och GPS ur mp4/mov (©xyz + mvhd) ---------- */
async function parseVideo(file) {
  const out = { lat: null, lon: null, created: null, duration: null };
  const N = 4 << 20, parts = [file.slice(0, Math.min(1 << 20, file.size))];
  if (file.size > 1 << 20) parts.push(file.slice(Math.max(1 << 20, file.size - N)));
  for (const part of parts) {
    const buf = new Uint8Array(await part.arrayBuffer()), dv = new DataView(buf.buffer);
    for (let i = 0; i < buf.length - 40; i++) {
      if (buf[i] === 0xA9 && buf[i + 1] === 0x78 && buf[i + 2] === 0x79 && buf[i + 3] === 0x7A && out.lat == null) { // ©xyz
        const str = String.fromCharCode(...buf.subarray(i + 4, i + 48));
        const m = str.match(/([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
        if (m) { out.lat = +m[1]; out.lon = +m[2]; }
      }
      if (buf[i] === 0x6D && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64 && out.duration == null) { // mvhd
        try {
          const v = buf[i + 4];
          let created, ts, dur;
          if (v === 1) { created = Number(dv.getBigUint64(i + 8)); ts = dv.getUint32(i + 24); dur = Number(dv.getBigUint64(i + 28)); }
          else { created = dv.getUint32(i + 8); ts = dv.getUint32(i + 16); dur = dv.getUint32(i + 20); }
          if (ts) out.duration = dur / ts;
          if (created > 2082844800) out.created = (created - 2082844800) * 1000;
        } catch (e) { }
      }
    }
    if (out.lat != null && out.duration != null) break;
  }
  return out;
}

/* ---------- folder picking ---------- */
async function collectEntries(dir, prefix = '', out = [], depth = 0) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    if (h.kind === 'directory') { if (depth < 4) await collectEntries(h, prefix + name + '/', out, depth + 1); }
    else out.push({ path: prefix + name, name, handle: h });
  }
  return out;
}
async function pickFolder() {
  if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'rtot', mode: 'readwrite' }); }
    catch (e) { if (e.name !== 'AbortError') status(`Kunde inte öppna mappen: ${e.message}`); return; }
    S.dir = dir; S.canWrite = true; S.folderName = dir.name;
    status('Letar efter bilder…');
    S.entries = await collectEntries(dir);
    await loadTrip();
  } else {
    $('#dirInput').click();
  }
}
$('#dirInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  S.dir = null; S.canWrite = false;
  S.folderName = (files[0].webkitRelativePath || '').split('/')[0] || 'Resa';
  S.entries = files
    .filter(f => !f.webkitRelativePath.split('/').slice(1).some(seg => seg.startsWith('_') || seg.startsWith('.')))
    .map(f => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), name: f.name, file: f }));
  await loadTrip();
});
const getFile = async en => en.file || (en.file = await en.handle.getFile());
function status(msg, frac, n, total) {
  if (n != null) {
    $('#scanStatus').innerHTML = `<div class="scancard"><div class="spin"></div><div class="loadtitle serif">${esc(msg)}</div><div class="loadcount serif">${n}<span> / ${total}</span></div><div class="bar big"><i style="width:${(frac * 100).toFixed(1)}%"></i></div></div>`;
    return;
  }
  $('#scanStatus').innerHTML = esc(msg) + (frac != null ? `<div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>` : '');
}

/* ---------- metadata (trip json in folder) ---------- */
async function readMeta() {
  const en = S.entries.find(e => e.path === META_FILE);
  try {
    if (en) return JSON.parse(await (await getFile(en)).text());
    if (S.dir) { const h = await S.dir.getFileHandle(META_FILE); return JSON.parse(await (await h.getFile()).text()); }
  } catch (e) { /* none yet */ }
  try { const ls = localStorage.getItem('rtot:' + S.folderName); if (ls) return JSON.parse(ls); } catch (e) { }
  return null;
}
let metaSaveTimer = null;
function saveMeta(now = false) {
  clearTimeout(metaSaveTimer);
  const go = async () => {
    S.meta.updated = new Date().toISOString();
    const txt = JSON.stringify(S.meta, null, 2);
    try { localStorage.setItem('rtot:' + S.folderName, txt); } catch (e) { }
    if (S.canWrite && S.dir) {
      try {
        const h = await S.dir.getFileHandle(META_FILE, { create: true });
        const w = await h.createWritable(); await w.write(txt); await w.close();
      } catch (e) { console.warn('Kunde inte spara', e); }
    }
  };
  if (now) return go();
  metaSaveTimer = setTimeout(go, 800);
}

/* ---------- reading photos ---------- */
async function loadTrip() {
  const imgs = S.entries.filter(e => IMG_RE.test(e.name) && !SKIP_RE.test(e.name));
  const vids = S.entries.filter(e => VID_RE.test(e.name) && !SKIP_RE.test(e.name));
  if (!imgs.length) { status('Hittade inga bilder i mappen.'); return; }
  const photos = []; let done = 0;
  status('Läser plats och tid från bilderna', 0, 0, imgs.length);
  await pool(imgs, 8, async en => {
    try {
      const file = await getFile(en);
      let ex = null;
      try {
        ex = await exifr.parse(file, { translateValues: false, tiff: true, exif: true, gps: true, ifd1: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
          pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'Orientation', 'ExifImageWidth', 'ExifImageHeight'] });
      } catch (e) { }
      const d = ex && (ex.DateTimeOriginal || ex.CreateDate || ex.ModifyDate);
      let time = d instanceof Date && !isNaN(d) ? d.getTime() : (timeFromName(en.name) ?? file.lastModified);
      const lat = ex && typeof ex.latitude === 'number' && isFinite(ex.latitude) ? ex.latitude : null;
      const lon = ex && typeof ex.longitude === 'number' && isFinite(ex.longitude) ? ex.longitude : null;
      const ok = lat != null && lon != null && !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001);
      photos.push({ name: en.name, path: en.path, entry: en, time, orient: (ex && +ex.Orientation) || 1, lat: ok ? lat : null, lon: ok ? lon : null });
    } catch (e) { console.warn(en.path, e); }
    done++; if (done % 5 === 0 || done === imgs.length) status('Läser plats och tid från bilderna', done / imgs.length, done, imgs.length);
  });
  if (vids.length) status('Läser filmklippen', 1, vids.length, vids.length);
  await pool(vids, 3, async en => {
    try {
      const file = await getFile(en), v = await parseVideo(file);
      const time = timeFromName(en.name) ?? v.created ?? file.lastModified;
      photos.push({ kind: 'video', name: en.name, path: en.path, entry: en, time, duration: v.duration, vlat: v.lat, vlon: v.lon, lat: null, lon: null });
    } catch (e) { console.warn(en.path, e); }
  });
  photos.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  photos.forEach(p => p.kind = p.kind || 'photo');
  S.photos = photos;
  S.geo = photos.filter(p => p.lat != null);
  if (!S.geo.length) { status(`Ingen av de ${photos.length} bilderna har GPS-position. Slå på platstaggning i kameran.`); return; }
  S.meta = await readMeta();
  showApp();
  if (!S.meta) {
    S.meta = { version: 1, name: pretty(S.folderName), reason: '', start: null, places: {}, created: new Date().toISOString() };
    analyze(); render();
    openSetup(true);
  } else {
    S.meta.places = S.meta.places || {};
    analyze(); render(); geocodeAll(); routeAll();
  }
}

/* ---------- analysis: stops, legs, modes ---------- */
function guessMode(km, hours) {
  if (km < 1.5) return 'walk';
  if (hours != null && hours > 0) {
    const v = km / hours;
    if (km < 6 && v < 7) return 'walk';
    if (km > 150 && v > 180) return 'flight';
    if (km > 1000 && v > 60) return 'flight';
    return 'car';
  }
  return km > 700 ? 'flight' : 'car';
}
function buildLeg(from, to, hours, lid, fromStart, guessOverride) {
  const km = hav(from.lat, from.lon, to.lat, to.lon);
  const forced = S.meta && S.meta.modes && S.meta.modes[lid];
  const guessed = guessOverride || guessMode(km, hours);
  let mode = forced || guessed, route = null;
  if (forced) {
    if (ROUTERS[mode] && km >= 0.3) { route = getRoute(from, to, mode); if (route && route.none) route = null; }
  } else if (mode !== 'flight' && km >= 0.3) {
    route = getRoute(from, to, mode);
    // vägen hade tagit mycket längre tid än ni faktiskt behövde → ni flög nog
    if (route && mode === 'car' && km > 150 && hours > 0 && route.t && hours < route.t / 3600 * 0.55) { mode = 'flight'; route = null; }
    if (route && route.none) { if (km > 80) mode = 'flight'; route = null; }
  }
  const est = route ? route.d / 1000 : km * MODE[mode].factor;
  return { id: lid, from, to, km, hours, mode, guessed, forced: !!forced, est, route, roadKnown: !!route, fromStart };
}
function startPoint() {
  const st = S.meta && S.meta.start;
  if (st && st.lat != null) return st;
  const f = S.geo[0]; return { lat: f.lat, lon: f.lon, label: 'Där första bilden togs', auto: true };
}
function analyze() {
  const stops = []; let cur = null;
  for (const p of S.geo) {
    if (cur && hav(cur.lat, cur.lon, p.lat, p.lon) <= STOP_RADIUS_KM && p.time - cur.end < STOP_MAX_GAP_H * 3600e3) {
      cur.photos.push(p); cur.end = p.time;
      const n = cur.photos.length; cur.lat += (p.lat - cur.lat) / n; cur.lon += (p.lon - cur.lon) / n;
    } else {
      cur = { lat: p.lat, lon: p.lon, start: p.time, end: p.time, photos: [p], firstLat: p.lat, firstLon: p.lon };
      stops.push(cur);
    }
    p.stop = cur;
  }
  // bilder utan GPS: koppla till stoppet närmast i tid (inom 2 h)
  for (const p of S.photos) if (p.lat == null) {
    const gap = s => p.time < s.start ? s.start - p.time : p.time > s.end ? p.time - s.end : 0;
    let best = null, bd = (p.kind === 'video' ? 3 : 2) * 3600e3;
    for (const s of stops) { const d = gap(s); if (d < bd) { bd = d; best = s; } }
    if (p.vlat != null) { // filmklipp med GPS: närmaste stopp (inom 6 h) i avstånd
      let bk = Infinity;
      for (const s of stops) if (gap(s) < 6 * 3600e3) { const k = hav(s.lat, s.lon, p.vlat, p.vlon); if (k < bk) { bk = k; best = s; } }
    }
    p.stop = null;
    if (best) { best.photos.push(p); p.stop = best; }
  }
  stops.forEach(s => { s.photos.sort((a, b) => a.time - b.time); s.key = placeKey(s); });
  // egna tillagda punkter (platser man passerat utan bilder) – sorteras in i tidsordning
  ((S.meta && S.meta.extra) || []).forEach(e => stops.push({ lat: e.lat, lon: e.lon, start: e.t, end: e.t, photos: [], manual: true, id: e.id, label: e.label || '', key: 'm:' + e.id }));
  stops.sort((a, b) => a.start - b.start);
  stops.forEach((s, i) => { s.idx = i; });
  const start = startPoint();
  S.endPt = endPoint(); S.endLeg = null;
  const nodes = [start, ...stops]; if (S.endPt) nodes.push(S.endPt);
  const realStop = n => n && n.photos && !n.manual;
  // färdsätt för sträckor via tillagda punkter gissas från hela kedjan mellan riktiga stopp
  const chainGuess = j => {
    if (!nodes[j - 1].manual && !nodes[j].manual) return null;
    let a = j - 1; while (a > 0 && nodes[a].manual) a--;
    let b = j; while (b < nodes.length - 1 && nodes[b].manual) b++;
    let km = 0; for (let k = a + 1; k <= b; k++) km += hav(nodes[k - 1].lat, nodes[k - 1].lon, nodes[k].lat, nodes[k].lon);
    const hours = realStop(nodes[a]) && realStop(nodes[b]) ? (nodes[b].start - nodes[a].end) / 3600e3 : null;
    return guessMode(km, hours);
  };
  const legs = [];
  stops.forEach((s, i) => {
    const from = i === 0 ? start : stops[i - 1];
    const cg = chainGuess(i + 1);
    const hours = i === 0 || cg ? null : (s.start - stops[i - 1].end) / 3600e3;
    s.leg = buildLeg(from, s, hours, legId(i === 0 ? null : stops[i - 1], s), i === 0, cg);
    s.distFromStart = hav(start.lat, start.lon, s.lat, s.lon);
    legs.push(s.leg);
  });
  // sträcka till slutpunkten
  if (S.endPt && stops.length) {
    const last = stops[stops.length - 1];
    if (hav(last.lat, last.lon, S.endPt.lat, S.endPt.lon) >= 0.3) {
      S.endLeg = buildLeg(last, S.endPt, null, `${last.key}>end`, false, chainGuess(nodes.length - 1));
      S.endLeg.toEnd = true; legs.push(S.endLeg);
    }
  }
  S.stops = stops; S.legs = legs;
  // trip summary
  const lats = S.geo.map(p => p.lat).sort((a, b) => a - b), lons = S.geo.map(p => p.lon).sort((a, b) => a - b);
  const mid = { lat: lats[lats.length >> 1], lon: lons[lons.length >> 1] };
  const near = S.geo.filter(p => hav(p.lat, p.lon, mid.lat, mid.lon) < 20).length / S.geo.length;
  const byMode = {}; Object.keys(MODE).forEach(k => byMode[k] = 0);
  legs.forEach(l => { if (l.fromStart && l.km < 2) return; const fk = l.route && l.route.fk ? Math.min(l.route.fk, l.est) : 0; byMode[l.mode] += l.est - fk; byMode.ferry += fk; });
  const far = stops.reduce((a, b) => (b.distFromStart > a.distFromStart ? b : a), stops[0]);
  const t0 = S.photos[0].time, t1 = S.photos[S.photos.length - 1].time;
  const days = Math.round((new Date(t1).setHours(0, 0, 0, 0) - new Date(t0).setHours(0, 0, 0, 0)) / 864e5) + 1;
  S.trip = {
    start, t0, t1, days, byMode, far, mid,
    total: Object.values(byMode).reduce((a, b) => a + b, 0),
    type: near >= 0.85 ? 'stay' : 'tour',
    nPhotos: S.photos.filter(p => p.kind === 'photo').length, nVideos: S.photos.filter(p => p.kind === 'video').length, nGeo: S.geo.length,
  };
}
const legId = (a, b) => `${a ? a.key || placeKey(a) : 'start'}>${b.key || placeKey(b)}`;
const legByIdx = i => i === 'end' ? S.endLeg : S.stops[+i].leg;
const placeKey = s => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
const stopName = s => (S.meta.places[s.key] && S.meta.places[s.key].name) || (s.manual ? (s.label || 'Tillagd punkt') : `Stopp ${s.idx + 1}`);
const stopCountry = s => (S.meta.places[s.key] && S.meta.places[s.key].country) || '';

/* ---------- vägar (OSRM, OpenStreetMap-data, ingen nyckel; cachas i json) ---------- */
// Valhalla (FOSSGIS) först: den tar färjor som Rødby–Puttgarden och Helsingør–Helsingborg. OSRM som reserv.
const OSRM_CAR = ['osrm:https://router.project-osrm.org/route/v1/driving/', 'osrm:https://routing.openstreetmap.de/routed-car/route/v1/driving/'];
const ROUTERS = {
  car: ['valhalla:auto', ...OSRM_CAR], bus: ['valhalla:bus', ...OSRM_CAR],
  walk: ['valhalla:pedestrian', 'osrm:https://routing.openstreetmap.de/routed-foot/route/v1/foot/'],
  bike: ['valhalla:bicycle', 'osrm:https://routing.openstreetmap.de/routed-bike/route/v1/bike/', 'brouter:trekking'],
  train: ['brouter:rail'],                     // BRouter följer järnvägsspåren i OpenStreetMap
};
const ROUTE_VER = 'v2|';
const routeKey = (a, b, mode) => `${ROUTE_VER}${mode}:${a.lat.toFixed(4)},${a.lon.toFixed(4)}>${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;
function decodePoly(str, prec = 5) {
  let i = 0, lat = 0, lon = 0; const f = 10 ** prec, out = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, sh = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = r & 1 ? ~(r >> 1) : r >> 1; if (k) lon += d; else lat += d;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}
function encodePoly(pts, prec = 5) {
  const f = 10 ** prec; let pl = 0, pn = 0, s = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let o = ''; while (v >= 32) { o += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * f), b = Math.round(lo * f); s += enc(a - pl) + enc(b - pn); pl = a; pn = b; }
  return s;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ay, ax] = pts[a], [by, bx] = pts[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = pts[i]; let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const routeMem = new Map();
function getRoute(a, b, mode) {
  const k = routeKey(a, b, mode);
  if (routeMem.has(k)) return routeMem.get(k);
  const r = S.meta && S.meta.routes && S.meta.routes[k];
  if (!r) return null;
  const v = r.none ? { none: true } : { d: r.d, t: r.t, pts: decodePoly(r.g), ferry: r.f || [], fk: r.fk || 0 };
  routeMem.set(k, v); return v;
}
async function fetchRoute(a, b, mode) {
  for (const svc of ROUTERS[mode] || []) {
    const [kind, base] = [svc.slice(0, svc.indexOf(':')), svc.slice(svc.indexOf(':') + 1)];
    try {
      if (kind === 'valhalla') {
        const body = { locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }], costing: base, directions_options: { units: 'kilometers' }, costing_options: { [base]: { use_ferry: base === 'pedestrian' ? 0.5 : 1 } } };
        const r = await fetch(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(body))}`);
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.trip) { if (j && [170, 171, 442, 443].includes(j.error_code)) return { none: true }; continue; }
        const leg = j.trip.legs[0], shape = decodePoly(leg.shape, 6), km = j.trip.summary.length;
        // dela upp i väg/färja, förenkla varje del för sig
        const marks = new Array(shape.length).fill(0); let fk = 0;
        leg.maneuvers.forEach(m => { if (m.ferry) { fk += m.length || 0; for (let i = m.begin_shape_index; i <= m.end_shape_index && i < shape.length; i++) marks[i] = 1; } });
        const tol = Math.max(0.00003, km * 2e-6), out = [], ferry = [];
        let i = 0;
        while (i < shape.length) {
          let k = i; while (k + 1 < shape.length && marks[k + 1] === marks[i]) k++;
          const piece = simplify(shape.slice(i, Math.min(shape.length, k + 2)), tol);
          const startIdx = out.length ? out.length - 1 : 0;
          piece.forEach((p, n) => { if (!(out.length && n === 0)) out.push(p); });
          if (marks[i]) ferry.push([startIdx, out.length - 1]);
          i = k + 1;
        }
        return { d: Math.round(km * 1000), t: Math.round(j.trip.summary.time), g: encodePoly(out), f: ferry, fk: Math.round(fk * 10) / 10 };
      }
      if (kind === 'brouter') {
        const r = await fetch(`https://brouter.de/brouter?lonlats=${a.lon.toFixed(5)},${a.lat.toFixed(5)}|${b.lon.toFixed(5)},${b.lat.toFixed(5)}&profile=${base}&alternativeidx=0&format=geojson`);
        if (!r.ok) { if (r.status === 400 || r.status === 500) { const t = await r.text(); if (/not found|no route|target island|from-position/i.test(t)) return { none: true }; } continue; }
        const j = await r.json(), ft = j.features && j.features[0];
        if (!ft) continue;
        const d = +ft.properties['track-length'];
        let pts = ft.geometry.coordinates.map(c => [c[1], c[0]]);
        pts = simplify(pts, Math.max(0.00003, d / 1000 * 2e-6));
        return { d: Math.round(d), t: Math.round(+ft.properties['total-time'] || 0), g: encodePoly(pts) };
      }
      const r = await fetch(`${base}${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}?overview=full&geometries=polyline&steps=false`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.code === 'NoRoute') return { none: true };
      if (j.code !== 'Ok' || !j.routes || !j.routes.length) continue;
      const rt = j.routes[0], km = rt.distance / 1000;
      let pts = decodePoly(rt.geometry);
      pts = simplify(pts, Math.max(0.00003, km * 2e-6));
      return { d: Math.round(rt.distance), t: Math.round(rt.duration), g: encodePoly(pts) };
    } catch (e) { console.warn('route', svc, e); }
  }
  return null;
}
let routing = false;
async function routeAll() {
  if (routing) return; routing = true;
  S.meta.routes = S.meta.routes || {};
  for (const k of Object.keys(S.meta.routes)) if (!k.startsWith(ROUTE_VER)) delete S.meta.routes[k];
  const todo = S.legs.filter(l => ROUTERS[l.mode] && l.km >= 0.3 && !(l.fromStart && l.km < 2))
    .map(l => ({ l, k: routeKey(l.from, l.to, l.mode) })).filter(x => !S.meta.routes[x.k]);
  let n = 0, changed = false;
  LOAD.route = { n: 0, total: todo.length, cur: '' }; LOAD.dismissed = false; loadUpdate();
  for (const { l, k } of todo) {
    routeStatus(`Ritar vägar ${++n}/${todo.length}…`);
    LOAD.route.cur = `${MODE[l.mode].icon} ${legName(l.from)} → ${legName(l.to)}`; loadUpdate();
    const r = await fetchRoute(l.from, l.to, l.mode);
    LOAD.route.n = n; loadUpdate();
    if (r) { S.meta.routes[k] = r; changed = true; routeMem.delete(k); }
    if (n % 5 === 0 || n === todo.length) { analyze(); renderMap(true); }
    await sleep(window.__rtotDelay ?? 1100);
  }
  routeStatus('');
  routing = false; LOAD.route = { n: 0, total: 0, cur: '' }; loadUpdate();
  if (changed) { analyze(); render(true); saveMeta(); }
}
// stor räknare mitt på skärmen medan vägar och ortnamn hämtas första gången
const LOAD = { route: { n: 0, total: 0, cur: '' }, geo: { n: 0, total: 0 }, dismissed: false };
const legName = p => p.key ? stopName(p) : p === S.endPt ? 'Slut' : 'Start';
function loadUpdate() {
  const r = LOAD.route, g = LOAD.geo;
  const rLeft = Math.max(0, r.total - r.n), gLeft = Math.max(0, g.total - g.n);
  const busy = rLeft > 0 || gLeft > 0;
  const show = busy && !LOAD.dismissed && (r.total >= 3 || g.total >= 3);
  $('#loadOverlay').classList.toggle('on', show);
  if (!show) return;
  const main = r.total ? r : g;
  $('#loadTitle').textContent = r.total && rLeft ? 'Ritar upp vägarna' : 'Hämtar ortnamn';
  $('#loadCount').innerHTML = `${main.n}<span> / ${main.total}</span>`;
  $('#loadUnit').textContent = r.total ? (r.total === 1 ? 'sträcka' : 'sträckor') : 'platser';
  $('#loadBar').style.width = `${(main.total ? main.n / main.total : 0) * 100}%`;
  $('#loadCur').textContent = r.total && rLeft ? r.cur : '';
  $('#loadGeo').textContent = r.total && g.total ? `Ortnamn ${g.n} / ${g.total}` : '';
  const secs = Math.ceil(Math.max(rLeft, gLeft) * 1.25);
  $('#loadEta').textContent = secs > 60 ? `ca ${Math.round(secs / 60)} min kvar` : `ca ${Math.max(1, secs)} s kvar`;
}
function routeStatus(t) { const el = $('#routeStatus'); if (el) el.textContent = t; }

/* ---------- reverse geocoding (OpenStreetMap Nominatim, 1 req/s, cachas i json) ---------- */
let geocoding = false;
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1&accept-language=sv`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(r.status);
  const j = await r.json(); const a = j.address || {};
  const town = a.city || a.town || a.village || a.municipality || a.hamlet || a.county || a.state;
  const sub = a.suburb || a.city_district || a.neighbourhood || a.quarter;
  const poi = j.name && j.category && ['tourism', 'historic', 'leisure', 'natural', 'amenity', 'place', 'aeroway'].includes(j.category) && j.name !== town ? j.name : null;
  let name = town || j.name || 'Okänd plats';
  if (poi) name = `${poi}, ${town || ''}`.replace(/, $/, '');
  else if (sub && town && sub !== town && (a.city)) name = `${sub}, ${town}`;
  return { name, town: town || name, country: a.country || '', cc: (a.country_code || '').toUpperCase() };
}
async function geocodeAll() {
  if (geocoding) return; geocoding = true;
  const todo = S.stops.filter(s => !S.meta.places[s.key]);
  const st = S.meta.start;
  let changed = false;
  LOAD.geo = { n: 0, total: todo.length }; loadUpdate();
  for (const s of todo) {
    if (!S.meta.places[s.key]) {
      try { S.meta.places[s.key] = await reverseGeocode(s.lat, s.lon); changed = true; updateStopNames(); }
      catch (e) { console.warn('geocode', e); await sleep(1500); }
      await sleep(window.__rtotDelay ?? 1100);
    }
    LOAD.geo.n++; loadUpdate();
  }
  if (st && st.lat != null && !st.label) {
    try { const g = await reverseGeocode(st.lat, st.lon); st.label = g.town + (g.country ? ', ' + g.country : ''); changed = true; } catch (e) { }
  }
  geocoding = false; LOAD.geo = { n: 0, total: 0 }; loadUpdate();
  if (changed) { saveMeta(); renderSide(); }
}
function updateStopNames() {
  S.stops.forEach(s => {
    const el = document.querySelector(`.stop[data-i="${s.idx}"] .name`);
    if (el) el.textContent = stopName(s);
  });
  const far = $('#farName'); if (far) far.textContent = stopName(S.trip.far);
}

/* ---------- thumbnails ---------- */
async function thumbUrl(p) {
  if (S.thumbCache.has(p)) return S.thumbCache.get(p);
  const pr = (async () => {
    if (p.kind === 'video') return videoThumb(p);
    const file = await getFile(p.entry);
    try {
      const buf = await exifr.thumbnail(file);
      if (buf) {
        const blob = new Blob([buf], { type: 'image/jpeg' });
        if (![3, 6, 8].includes(p.orient)) return URL.createObjectURL(blob);
        const bmp = await createImageBitmap(blob);
        const rot = p.orient === 6 ? 90 : p.orient === 8 ? -90 : 180, side = rot !== 180;
        const c = document.createElement('canvas'); c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
        const g = c.getContext('2d'); g.translate(c.width / 2, c.height / 2); g.rotate(rot * Math.PI / 180); g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2); bmp.close();
        return await new Promise(r => c.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.85));
      }
    } catch (e) { }
    try {
      const bmp = await createImageBitmap(file, { resizeWidth: 160, resizeQuality: 'medium' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
      return await new Promise(r => c.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.8));
    } catch (e) { return ''; }
  })();
  S.thumbCache.set(p, pr); return pr;
}
function once(el, ev, ms = 8000) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); el.addEventListener('error', () => { clearTimeout(t); rej(new Error('video error')); }, { once: true }); }); }
async function videoThumb(p) {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  try {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = await fullUrl(p); await once(v, 'loadeddata');
    if (isFinite(v.duration)) p.duration = v.duration;
    p.vw = v.videoWidth; p.vh = v.videoHeight;
    v.currentTime = Math.min(1, (v.duration || 2) / 2); await once(v, 'seeked');
    const s = 200 / Math.max(v.videoWidth, v.videoHeight); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    g.drawImage(v, 0, 0, c.width, c.height); v.removeAttribute('src'); v.load();
  } catch (e) { p.unplayable = true; c.width = 200; c.height = 150; g.fillStyle = '#333'; g.fillRect(0, 0, 200, 150); }
  // ▶-märke + längd
  const cx = c.width / 2, cy = c.height / 2;
  g.fillStyle = 'rgba(0,0,0,.45)'; g.beginPath(); g.arc(cx, cy, 22, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx - 7, cy - 11); g.lineTo(cx + 12, cy); g.lineTo(cx - 7, cy + 11); g.fill();
  if (p.duration) { const t = `${Math.round(p.duration)} s`; g.font = '600 15px system-ui,sans-serif'; const w = g.measureText(t).width + 10; g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(c.width - w - 4, c.height - 24, w, 20); g.fillStyle = '#fff'; g.fillText(t, c.width - w + 1, c.height - 9); }
  if (p.unplayable) { g.fillStyle = '#fff'; g.font = '600 13px system-ui'; g.fillText('kan ej spelas', 8, 18); }
  return await new Promise(r => c.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.85));
}
async function fullUrl(p) {
  if (!S.objUrls.has(p)) S.objUrls.set(p, URL.createObjectURL(await getFile(p.entry)));
  return S.objUrls.get(p);
}
const thumbQueue = [];
let thumbRunning = 0;
function lazyThumb(img, p) {
  thumbQueue.push([img, p]); pumpThumbs();
}
function pumpThumbs() {
  while (thumbRunning < 6 && thumbQueue.length) {
    const [img, p] = thumbQueue.shift(); thumbRunning++;
    thumbUrl(p).then(u => { if (u) img.src = u; }).finally(() => { thumbRunning--; pumpThumbs(); });
  }
}
async function openLightbox(p) {
  const lv = $('#lbVid');
  if (p.kind === 'video') {
    $('#lbImg').style.display = 'none'; lv.style.display = ''; lv.src = await fullUrl(p); lv.play().catch(() => { });
    $('#lbCap').textContent = `${p.name} · ${fmtDay(p.time)} ${fmtTime(p.time)}${p.stop ? ' · ' + stopName(p.stop) : ''}`;
    $('#lightbox').classList.add('on'); return;
  }
  lv.pause(); lv.style.display = 'none'; $('#lbImg').style.display = '';
  $('#lbImg').src = await thumbUrl(p);
  $('#lbCap').textContent = `${p.name} · ${fmtDay(p.time)} ${fmtTime(p.time)}${p.stop ? ' · ' + stopName(p.stop) : ''}`;
  $('#lightbox').classList.add('on');
  $('#lbImg').src = await fullUrl(p);
}
$('#lightbox').onclick = e => { if (e.target.id === 'lbVid') return; $('#lightbox').classList.remove('on'); $('#lbVid').pause(); };

/* ---------- UI ---------- */
function showApp() {
  $('#welcome').style.display = 'none';
  $('#app').classList.add('on');
  if (!S.map) {
    S.map = L.map('map', { zoomControl: true, worldCopyJump: true });
    S.map.on('click', e => { if (S.pick) addExtra(e.latlng.lat, e.latlng.lng, ''); });
    addStyleControl();
  }
  setTimeout(() => S.map.invalidateSize(), 50);
}
function applyBasemap() {
  const key = currentBasemap();
  if (S.baseKey === key && S.baseLayer) return;
  if (S.baseLayer) S.map.removeLayer(S.baseLayer);
  S.baseLayer = basemapLayer(key).addTo(S.map); S.baseKey = key;
  S.baseLayer.eachLayer(l => l.bringToBack && l.bringToBack());
  $('#map').style.background = BASEMAPS[key].bg || '#e9e4d8';
  $('#map').classList.toggle('darkmap', !!BASEMAPS[key].dark);
  document.querySelectorAll('.swatch').forEach(el => el.classList.toggle('on', el.dataset.k === key));
}
function setBasemap(key) { S.meta.basemap = key; saveMeta(); applyBasemap(); }
// stilväljare med förhandsvisning (en kartbit över Skandinavien i varje stil)
function addStyleControl() {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const d = L.DomUtil.create('div', 'stylectl');
      const tile = u => u.replace('{z}', 5).replace('{y}', 9).replace('{x}', 17);
      d.innerHTML = `<button class="stylebtn" title="Byt kartstil">🎨 Kartstil</button><div class="stylepanel">${Object.entries(BASEMAPS).map(([k, b]) =>
        `<div class="swatch" data-k="${k}"><div class="sw tl-${k}" style="background:${b.bg || '#e9e4d8'}">${b.layers.map(u => `<img src="${tile(u)}" alt="" loading="lazy">`).join('')}</div><span>${b.name}</span></div>`).join('')}</div>`;
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      d.querySelector('.stylebtn').onclick = () => d.classList.toggle('open');
      d.querySelectorAll('.swatch').forEach(el => el.onclick = () => setBasemap(el.dataset.k));
      return d;
    }
  });
  new Ctl().addTo(S.map);
}
function render(keepView) {
  applyBasemap();
  renderSide(); renderMap(keepView);
}

function renderSide() {
  const T = S.trip, m = S.meta;
  const dates = dayKey(T.t0) === dayKey(T.t1) ? fmtDate(T.t0) :
    `${new Date(T.t0).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} – ${fmtDate(T.t1)}`;
  const typeTxt = T.type === 'stay' ? `🏨 Mest på ett ställe` : `🗺️ Rundresa · ${S.stops.length} stopp`;
  const startTxt = T.start.label || 'Vald startpunkt';
  let h = `<div class="trip-head">
    <h2>${esc(m.name)}</h2>
    <div class="dates">${dates} · ${T.days} ${T.days === 1 ? 'dag' : 'dagar'}</div>
    ${m.reason ? `<p class="reason">${esc(m.reason)}</p>` : ''}
    <span class="tag">${typeTxt}</span> <span class="tag">🏠 Start: ${esc(startTxt)}</span>${S.endPt ? ` <span class="tag">🏁 Slut: ${esc(S.endPt.same ? 'samma som start' : S.endPt.label || 'vald punkt')}</span>` : ''}
  </div>
  <div class="stats">
    <div class="stat"><b>${fmtKm(T.total)}</b><span>rest totalt${S.legs.some(l => l.mode !== 'flight' && l.km > 2 && !l.route) ? ' (uppskattat)' : ' (längs vägarna)'}</span></div>
    <div class="stat"><b>${fmtKm(T.far.distFromStart)}</b><span>längst bort från start – <span id="farName">${esc(stopName(T.far))}</span></span></div>
    <div class="stat"><b>${S.stops.filter(s => !s.manual).length}</b><span>platser där ni stannade${S.stops.some(s => s.manual) ? ` (+${S.stops.filter(s => s.manual).length} tillagda)` : ''}</span></div>
    <div class="stat"><b>${T.nPhotos}</b><span>bilder${T.nVideos ? ` + ${T.nVideos} filmklipp` : ''}</span></div>
  </div>
  <div class="modes">${Object.entries(T.byMode).filter(([, v]) => v > 0.5).map(([k, v]) =>
    `<span class="mode-chip" style="background:${MODE[k].color}">${MODE[k].icon} ${MODE[k].label} ${fmtKm(v)}</span>`).join('')}</div>
  <div class="timeline">`;
  let lastDay = null;
  S.stops.forEach((s, i) => {
    const dk = dayKey(s.start);
    if (dk !== lastDay) { h += `<div class="day">${fmtDay(s.start)}</div>`; lastDay = dk; }
    const l = s.leg;
    const addBtn = `<button class="addpt" data-at="${i}" title="Lägg till en plats ni passerade här">＋ punkt</button>`;
    if (l.fromStart && l.km < 2) h += `<div class="leg">${addBtn}</div>`;
    else {
      const what = l.fromStart ? 'från start' : '';
      const tw = { car: 'körtid', bus: 'körtid', bike: 'cykeltid', walk: 'gångtid' }[l.mode];
      const drive = l.route && l.route.t && tw ? ` · ${fmtDur(l.route.t * 1000)} ${tw}` : '';
      const fy = l.route && l.route.fk ? ` · ⛴️ inkl. färja ${fmtKm(l.route.fk)}` : '';
      h += `<div class="leg">${modeSelect(l, i)}<span><b>${l.route || l.mode === 'flight' ? '' : 'ca '}${fmtKm(l.est)}</b> ${what}${drive}${fy}${l.hours != null ? ` · ${fmtDur(l.hours * 3600e3)} senare` : ''}</span>${addBtn}</div>`;
    }
    if (s.manual) {
      h += `<div class="stop manual" data-i="${i}"><div class="top"><div class="num">${i + 1}</div>
        <div style="flex:1"><div class="name">${esc(stopName(s))}</div><div class="meta">Tillagd punkt · ${fmtKm(s.distFromStart)} från start · dra den på kartan för att flytta</div></div>
        <button class="ghost mini delpt" data-id="${s.id}" title="Ta bort punkten">✕</button></div></div>`;
      return;
    }
    const range = s.end - s.start > 120000 ? `${fmtTime(s.start)}–${fmtTime(s.end)}` : fmtTime(s.start);
    h += `<div class="stop" data-i="${i}">
      <div class="top"><div class="num">${i + 1}</div>
        <div><div class="name">${esc(stopName(s))}</div>
        <div class="meta">${range} · ${countTxt(s)} · ${fmtKm(s.distFromStart)} från start</div></div></div>
      <div class="thumbs"></div></div>`;
  });
  if (S.endPt) {
    const l = S.endLeg;
    if (l) {
      const tw = { car: 'körtid', bus: 'körtid', bike: 'cykeltid', walk: 'gångtid' }[l.mode];
      h += `<div class="leg">${modeSelect(l, 'end')}<span><b>${l.route || l.mode === 'flight' ? '' : 'ca '}${fmtKm(l.est)}</b> till slutpunkten${l.route && l.route.t && tw ? ` · ${fmtDur(l.route.t * 1000)} ${tw}` : ''}${l.route && l.route.fk ? ` · ⛴️ inkl. färja ${fmtKm(l.route.fk)}` : ''}</span><button class="addpt" data-at="end" title="Lägg till en plats ni passerade här">＋ punkt</button></div>`;
    } else if (S.stops.length) h += `<div class="leg"><button class="addpt" data-at="end">＋ punkt</button></div>`;
    h += `<div class="stop endcard"><div class="top"><div class="num" style="background:#fff;color:var(--ink);border:2px solid #e4572e">🏁</div>
      <div><div class="name">Slut: ${esc(S.endPt.same ? (T.start.auto || !T.start.label ? 'tillbaka till start' : 'hemma i ' + T.start.label) : (S.endPt.label || 'Vald punkt'))}</div>
      <div class="meta">${S.endPt.same ? 'Tillbaka där resan började' : `${fmtKm(hav(T.start.lat, T.start.lon, S.endPt.lat, S.endPt.lon))} från start`}</div></div></div></div>`;
  }
  h += `</div>`;
  $('#side').innerHTML = h;
  document.querySelectorAll('select.legmode').forEach(sel => { sel.onclick = e => e.stopPropagation(); sel.onchange = () => setLegMode(sel.dataset.i, sel.value); });
  document.querySelectorAll('button.addpt').forEach(b => b.onclick = e => { e.stopPropagation(); startPick(b.dataset.at); });
  document.querySelectorAll('button.delpt').forEach(b => b.onclick = e => { e.stopPropagation(); removeExtra(b.dataset.id); });
  document.querySelectorAll('.stop.manual').forEach(el => el.onclick = () => focusStop(+el.dataset.i));
  document.querySelectorAll('.stop[data-i]:not(.manual)').forEach(el => {
    const s = S.stops[+el.dataset.i];
    const box = el.querySelector('.thumbs');
    const show = pickEven(dedupe(s.photos), 6);
    show.forEach(p => { const im = document.createElement('img'); im.alt = ''; box.appendChild(im); lazyThumb(im, p); });
    if (s.photos.length > show.length) box.insertAdjacentHTML('beforeend', `<div class="more">+${s.photos.length - show.length}</div>`);
    el.onclick = () => focusStop(s.idx);
  });
}
function modeSelect(l, i) {
  const opts = Object.entries(MODE).map(([k, m]) => `<option value="${k}"${k === l.mode ? ' selected' : ''}>${m.icon} ${m.label}${!l.forced && k === l.guessed ? ' (gissat)' : ''}</option>`).join('');
  return `<select class="legmode${l.forced ? ' forced' : ''}" data-i="${i}" title="Byt färdsätt för den här sträckan">${opts}${l.forced ? `<option value="auto">↺ Låt appen gissa</option>` : ''}</select>`;
}
function setLegMode(i, mode) {
  const l = legByIdx(i);
  S.meta.modes = S.meta.modes || {};
  if (mode === 'auto') delete S.meta.modes[l.id]; else S.meta.modes[l.id] = mode;
  saveMeta(); analyze(); render(true); routeAll();
}
function countTxt(s) {
  const v = s.photos.filter(p => p.kind === 'video').length, b = s.photos.length - v;
  return `${b} ${b === 1 ? 'bild' : 'bilder'}${v ? ` · ${v} ${v === 1 ? 'klipp' : 'klipp'}` : ''}`;
}
function dedupe(photos, minGapMs = 5000) {
  const out = []; for (const p of photos) if (!out.length || p.time - out[out.length - 1].time >= minGapMs) out.push(p);
  return out.length ? out : photos.slice(0, 1);
}
function pickEven(arr, k) {
  if (arr.length <= k) return arr.slice();
  const out = []; for (let i = 0; i < k; i++) out.push(arr[Math.round(i * (arr.length - 1) / (k - 1 || 1))]);
  return [...new Set(out)];
}

function arcPoints(a, b, bend = 0.18, n = 40) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const cx = mx - dy * bend, cy = my + dx * bend, pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]); }
  return pts;
}
function renderMap(keepView) {
  const map = S.map;
  if (S.layers) S.layers.remove();
  S.layers = L.layerGroup().addTo(map); S.markers = [];
  const T = S.trip;
  // fotospår (tunn linje mellan alla bilder) – visar rörelsen inne på varje plats
  L.polyline(S.geo.map(p => [p.lat, p.lon]), { color: '#1f2a36', weight: 1.5, opacity: .25 }).addTo(S.layers);
  // sträckor mellan stopp
  const drawLeg = (l, idx, fromName, toName) => {
    if (!l || l.km < 0.05) return;
    const a = [l.from.lat, l.from.lon], b = [l.to.lat, l.to.lon];
    const st = MODE[l.mode], [w, dash] = LINE[l.mode];
    const pts = l.route ? l.route.pts : l.mode === 'flight' ? arcPoints(a, b) : [a, b];
    const grp = L.featureGroup().addTo(S.layers);
    L.polyline(pts, { color: '#fff', weight: w + 4, opacity: .8 }).addTo(grp);
    L.polyline(pts, { color: st.color, weight: w, opacity: .95, dashArray: dash, lineCap: dash ? 'butt' : 'round', lineJoin: 'round' }).addTo(grp);
    if (l.mode === 'train') L.polyline(pts, { color: '#fff', weight: w - 1.5, dashArray: '3 9', lineCap: 'butt' }).addTo(grp);
    if (l.route && l.route.ferry) l.route.ferry.forEach(([s0, s1]) => {
      const fp = pts.slice(s0, s1 + 1);
      L.polyline(fp, { color: '#fff', weight: w + 4, opacity: 1 }).addTo(grp);
      L.polyline(fp, { color: MODE.ferry.color, weight: w, dashArray: LINE.ferry[1], lineCap: 'butt' }).addTo(grp);
    });
    grp.bindPopup(() => {
      const d = document.createElement('div'); d.className = 'pop';
      d.innerHTML = `<h3>${esc(fromName())} → ${esc(toName())}</h3><div class="muted small">${l.route ? '' : 'ca '}${fmtKm(l.est)}${l.route ? '' : ' (fågelväg)'}${l.hours != null ? ' · ' + fmtDur(l.hours * 3600e3) + ' mellan bilderna' : ''}${l.route && l.route.fk ? ' · ⛴️ inkl. färja ' + fmtKm(l.route.fk) : ''}</div><div style="margin-top:8px">Färdsätt: ${modeSelect(l, idx)}</div><div style="margin-top:8px"><button class="ghost mini">＋ Lägg till punkt på sträckan</button></div>`;
      const sel = d.querySelector('select'); sel.onchange = () => { S.map.closePopup(); setLegMode(idx, sel.value); };
      d.querySelector('button').onclick = () => { S.map.closePopup(); startPick(String(idx)); };
      return d;
    });
  };
  S.stops.forEach(s => drawLeg(s.leg, s.idx, () => s.idx === 0 ? 'Start' : stopName(S.stops[s.idx - 1]), () => stopName(s)));
  drawLeg(S.endLeg, 'end', () => stopName(S.stops[S.stops.length - 1]), () => 'Slut');
  if (S.endPt && !S.endPt.same) L.marker([S.endPt.lat, S.endPt.lon], { icon: L.divIcon({ className: '', html: '<div class="pin end">🏁</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: -100 })
    .bindTooltip(`Slut: ${esc(S.endPt.label || '')}`).addTo(S.layers);
  // start
  const home = L.marker([T.start.lat, T.start.lon], { icon: L.divIcon({ className: '', html: '<div class="pin home">🏠</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: -100 })
    .bindTooltip(`Start${S.endPt && S.endPt.same ? ' och slut' : ''}: ${esc(T.start.label || '')}`).addTo(S.layers);
  // stopp
  const maxN = Math.max(1, ...S.stops.map(s => s.photos.length));
  S.stops.forEach(s => {
    if (s.manual) {
      const mk = L.marker([s.lat, s.lon], { draggable: true, icon: L.divIcon({ className: '', html: `<div class="pin manual">${s.idx + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(S.layers);
      mk.on('dragend', e => { const ll = e.target.getLatLng(); moveExtra(s.id, ll.lat, ll.lng); });
      mk.bindPopup(() => {
        const d = document.createElement('div'); d.className = 'pop';
        d.innerHTML = `<h3>${s.idx + 1}. ${esc(stopName(s))}</h3><div class="muted small">Tillagd punkt – dra för att flytta</div><div style="margin-top:8px"><button class="ghost mini">Ta bort punkten</button></div>`;
        d.querySelector('button').onclick = () => { S.map.closePopup(); removeExtra(s.id); };
        return d;
      });
      mk.on('click', () => highlight(s.idx));
      S.markers.push(mk); return;
    }
    const big = s.photos.length >= Math.max(8, maxN * 0.35);
    const mk = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="pin${big ? ' big' : ''}">${s.idx + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }) })
      .addTo(S.layers);
    mk.bindPopup(() => popupFor(s), { maxWidth: 340 });
    mk.on('click', () => highlight(s.idx));
    S.markers.push(mk);
  });
  if (!keepView) fitAll(true);
}
function fitAll(core = false) {
  const T = S.trip;
  let geo = S.geo;
  // stannade man mest på ett ställe: zooma in på det området först (utflykter/hemresa syns med "Visa hela resan")
  if (core && T.type === 'stay') geo = S.geo.filter(p => hav(p.lat, p.lon, T.mid.lat, T.mid.lon) < 20);
  const pts = geo.map(p => [p.lat, p.lon]);
  // ta med startpunkten om den inte ligger orimligt långt bort jämfört med resans yta
  const b = L.latLngBounds(pts);
  const span = hav(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  if (!core && hav(T.start.lat, T.start.lon, b.getCenter().lat, b.getCenter().lng) < Math.max(30, span * 3)) b.extend([T.start.lat, T.start.lon]);
  if (!core && S.endPt && hav(S.endPt.lat, S.endPt.lon, b.getCenter().lat, b.getCenter().lng) < Math.max(30, span * 3)) b.extend([S.endPt.lat, S.endPt.lon]);
  S.map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
}
function popupFor(s) {
  const div = document.createElement('div'); div.className = 'pop';
  const range = `${fmtDay(s.start)} ${fmtTime(s.start)}${s.end - s.start > 120000 ? '–' + fmtTime(s.end) : ''}`;
  div.innerHTML = `<h3>${s.idx + 1}. ${esc(stopName(s))}</h3><div class="muted small">${range}<br>${countTxt(s)} · ${fmtKm(s.distFromStart)} från start${stopCountry(s) ? ' · ' + esc(stopCountry(s)) : ''}</div><div class="grid"></div>`;
  const g = div.querySelector('.grid');
  s.photos.slice(0, 48).forEach(p => { const im = document.createElement('img'); im.onclick = () => openLightbox(p); g.appendChild(im); lazyThumb(im, p); });
  return div;
}
function highlight(i) {
  document.querySelectorAll('.stop.sel').forEach(e => e.classList.remove('sel'));
  const el = document.querySelector(`.stop[data-i="${i}"]`);
  if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
function focusStop(i) {
  const s = S.stops[i];
  S.map.flyTo([s.lat, s.lon], Math.max(S.map.getZoom(), 13), { duration: 0.8 });
  setTimeout(() => S.markers[i].openPopup(), 850);
  highlight(i);
}
$('#fitBtn').onclick = () => fitAll();
$('#newBtn').onclick = () => location.reload();
$('#pickBtn').onclick = pickFolder;
$('#editBtn').onclick = () => openSetup(false);

/* ---------- egna punkter mellan platser ---------- */
function pickTime(at) {
  const st = S.stops;
  if (at === 'end') { const last = st[st.length - 1]; let nxt = last.end + 7200e3; return (last.end + nxt) / 2; }
  const i = +at, next = st[i].start, prev = i > 0 ? st[i - 1].end : next - 7200e3;
  return (prev + next) / 2;
}
function pickLabel(at) {
  const st = S.stops;
  const a = at === 'end' ? stopName(st[st.length - 1]) : (+at === 0 ? 'start' : stopName(st[+at - 1]));
  const b = at === 'end' ? 'slutpunkten' : stopName(st[+at]);
  return `${a} → ${b}`;
}
function startPick(at) {
  S.pick = { at, t: pickTime(at) };
  $('#pickBanner').classList.add('on'); $('#pickWhat').textContent = pickLabel(at);
  $('#map').classList.add('picking'); $('#pickSearch').value = ''; $('#pickHits').innerHTML = '';
  // zooma till sträckan
  const st = S.stops, i = at === 'end' ? st.length : +at;
  const a = i === 0 ? S.trip.start : st[i - 1], b = at === 'end' ? (S.endPt || st[st.length - 1]) : st[i];
  S.map.fitBounds(L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon]]).pad(0.3), { maxZoom: 12 });
}
function stopPick() { S.pick = null; $('#pickBanner').classList.remove('on'); $('#map').classList.remove('picking'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.pick) stopPick(); });
function addExtra(lat, lon, label) {
  if (!S.pick) return;
  S.meta.extra = S.meta.extra || [];
  S.meta.extra.push({ id: Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), lat, lon, t: S.pick.t, label });
  stopPick(); saveMeta(); analyze(); render(true); geocodeAll(); routeAll();
}
function moveExtra(id, lat, lon) {
  const e = (S.meta.extra || []).find(x => x.id === id); if (!e) return;
  e.lat = lat; e.lon = lon; e.label = ''; delete S.meta.places['m:' + id];
  saveMeta(); analyze(); render(true); geocodeAll(); routeAll();
}
function removeExtra(id) {
  S.meta.extra = (S.meta.extra || []).filter(x => x.id !== id);
  delete S.meta.places['m:' + id];
  for (const k of Object.keys(S.meta.modes || {})) if (k.includes('m:' + id)) delete S.meta.modes[k];
  saveMeta(); analyze(); render(true); routeAll();
}
async function pickSearch() {
  const q = $('#pickSearch').value.trim(); if (!q) return;
  $('#pickHits').innerHTML = '<div class="muted">Söker…</div>';
  try {
    const c = S.map.getCenter();
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=sv&q=${encodeURIComponent(q)}`);
    const hits = await r.json();
    hits.sort((x, y) => hav(c.lat, c.lng, +x.lat, +x.lon) - hav(c.lat, c.lng, +y.lat, +y.lon));
    $('#pickHits').innerHTML = hits.length ? '' : '<div class="muted">Hittade inget – klicka på kartan istället.</div>';
    hits.forEach(hh => {
      const d = document.createElement('div'); d.textContent = hh.display_name;
      d.onclick = () => addExtra(+hh.lat, +hh.lon, hh.display_name.split(',')[0].trim());
      $('#pickHits').appendChild(d);
    });
  } catch (e) { $('#pickHits').innerHTML = '<div class="muted">Sökningen fungerade inte – klicka på kartan istället.</div>'; }
}
$('#pickSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pickSearch(); } });
$('#pickCancel').onclick = stopPick;
$('#loadSkip').onclick = () => { LOAD.dismissed = true; loadUpdate(); };

/* ---------- setup dialog: namn, anledning, start- och slutpunkt ---------- */
let startMap = null, startMarker = null, endMarker = null, pendingStart = null, pendingEnd = null, setTarget = 'start';
const pinIcon = (cls, txt) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
function openSetup(first) {
  const m = S.meta, T = S.trip;
  $('#setupTitle').textContent = first ? 'Berätta om resan' : 'Redigera resan';
  $('#setupInfo').textContent = `${S.folderName}: ${S.photos.length} bilder, ${S.geo.length} med position · ${fmtDate(T.t0)} – ${fmtDate(T.t1)}`;
  $('#setupCancel').style.display = first ? 'none' : '';
  $('#fName').value = m.name || '';
  $('#fReason').value = m.reason || '';
  $('#fStartHits').innerHTML = ''; $('#fStartSearch').value = '';
  pendingStart = m.start && m.start.lat != null ? { ...m.start } : null;
  pendingEnd = m.end ? { ...m.end } : null;
  setSetupTarget('start');
  $('#setup').classList.add('on');
  setTimeout(() => {
    if (!startMap) {
      startMap = L.map('startMap', { attributionControl: false });
      basemapLayer('street').addTo(startMap);
      L.polyline(S.geo.map(p => [p.lat, p.lon]), { color: '#e4572e', weight: 2, opacity: .7 }).addTo(startMap);
      startMap.on('click', e => setPoint(setTarget, { lat: e.latlng.lat, lon: e.latlng.lng, label: '' }, true));
    }
    startMap.invalidateSize();
    drawSetupMarkers();
    const p = pendingStart || startPoint();
    const b = L.latLngBounds(S.geo.map(q => [q.lat, q.lon])).extend([p.lat, p.lon]);
    const e = resolveEnd(pendingEnd, pendingStart); if (e) b.extend([e.lat, e.lon]);
    startMap.fitBounds(b, { padding: [20, 20], maxZoom: 12 });
  }, 30);
}
function setSetupTarget(t) {
  setTarget = t;
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#quickStart').style.display = t === 'start' ? '' : 'none';
  $('#quickEnd').style.display = t === 'end' ? '' : 'none';
  $('#fStartSearch').placeholder = t === 'start' ? 'Sök startplats (t.ex. Helsingborg) – eller klicka på kartan' : 'Sök slutplats – eller klicka på kartan';
  $('#fStartHits').innerHTML = '';
}
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setSetupTarget(b.dataset.t));
// slutpunkt: null = ingen, {same:true} = samma som start, {last:true} = sista bilden, annars plats
function resolveEnd(end, start) {
  if (!end) return null;
  if (end.same) { const s = start && start.lat != null ? start : startPoint(); return { lat: s.lat, lon: s.lon, label: s.label || 'Start', same: true }; }
  if (end.last) { const l = S.geo[S.geo.length - 1]; return { lat: l.lat, lon: l.lon, label: 'Där sista bilden togs' }; }
  return end.lat != null ? end : null;
}
function endPoint() { return resolveEnd(S.meta && S.meta.end, S.meta && S.meta.start); }
function drawSetupMarkers() {
  const p = pendingStart || startPoint();
  if (!startMarker) startMarker = L.marker([p.lat, p.lon], { draggable: true, icon: pinIcon('home', '🏠'), zIndexOffset: 100 }).addTo(startMap)
    .on('dragend', e => { const ll = e.target.getLatLng(); setPoint('start', { lat: ll.lat, lon: ll.lng, label: '' }, true); });
  startMarker.setLatLng([p.lat, p.lon]);
  const e = resolveEnd(pendingEnd, pendingStart);
  if (e) {
    if (!endMarker) endMarker = L.marker([e.lat, e.lon], { draggable: true, icon: pinIcon('end', '🏁') })
      .on('dragend', ev => { const ll = ev.target.getLatLng(); setPoint('end', { lat: ll.lat, lon: ll.lng, label: '' }, true); });
    endMarker.setLatLng([e.lat, e.lon]); if (!startMap.hasLayer(endMarker)) endMarker.addTo(startMap);
  } else if (endMarker && startMap.hasLayer(endMarker)) startMap.removeLayer(endMarker);
  const d = hav(p.lat, p.lon, S.geo[0].lat, S.geo[0].lon);
  $('#fStartLabel').textContent = `🏠 Start: ${pendingStart ? (pendingStart.label || 'Vald punkt') : 'Där första bilden togs'} · ${fmtKm(d)} till första bilden`;
  const last = S.geo[S.geo.length - 1];
  $('#fEndLabel').textContent = e ? `🏁 Slut: ${e.same ? 'Samma som start' : (e.label || 'Vald punkt')} · ${fmtKm(hav(last.lat, last.lon, e.lat, e.lon))} från sista bilden` : '🏁 Slut: ingen slutpunkt (resan slutar vid sista bilden)';
}
async function setPoint(which, pt, lookup) {
  if (which === 'start') pendingStart = pt; else pendingEnd = pt;
  drawSetupMarkers();
  if (pt && pt.lat != null && lookup && !pt.label) {
    try { const g = await reverseGeocode(pt.lat, pt.lon); pt.label = g.town + (g.country ? ', ' + g.country : ''); drawSetupMarkers(); } catch (e) { }
  }
}
$('#quickStart').onclick = e => { if (e.target.dataset.q === 'first') setPoint('start', null); };
$('#quickEnd').onclick = e => { const q = e.target.dataset.q; if (!q) return; setPoint('end', q === 'none' ? null : q === 'same' ? { same: true } : { last: true }); };
async function searchStart() {
  const q = $('#fStartSearch').value.trim(); if (!q) return;
  $('#fStartHits').innerHTML = '<div class="muted">Söker…</div>';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=sv&q=${encodeURIComponent(q)}`);
    const hits = await r.json();
    $('#fStartHits').innerHTML = hits.length ? '' : '<div class="muted">Hittade inget – klicka på kartan istället.</div>';
    hits.forEach(hh => {
      const d = document.createElement('div'); d.textContent = hh.display_name;
      d.onclick = () => {
        const label = hh.display_name.split(',').slice(0, 1).concat(hh.display_name.split(',').slice(-1)).map(x => x.trim()).join(', ');
        setPoint(setTarget, { lat: +hh.lat, lon: +hh.lon, label });
        startMap.setView([+hh.lat, +hh.lon], 9); $('#fStartHits').innerHTML = '';
      };
      $('#fStartHits').appendChild(d);
    });
  } catch (e) { $('#fStartHits').innerHTML = '<div class="muted">Sökningen fungerade inte (ingen internetanslutning?). Klicka på kartan istället.</div>'; }
}
$('#fStartSearchBtn').onclick = searchStart;
$('#fStartSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchStart(); } });
$('#setupCancel').onclick = () => $('#setup').classList.remove('on');
$('#setupSave').onclick = async () => {
  S.meta.name = $('#fName').value.trim() || pretty(S.folderName);
  S.meta.reason = $('#fReason').value.trim();
  S.meta.start = pendingStart ? { lat: pendingStart.lat, lon: pendingStart.lon, label: pendingStart.label || '' } : null;
  S.meta.end = !pendingEnd ? null : pendingEnd.same ? { same: true } : pendingEnd.last ? { last: true } : { lat: pendingEnd.lat, lon: pendingEnd.lon, label: pendingEnd.label || '' };
  $('#setup').classList.remove('on');
  await saveMeta(true);
  analyze(); render(); geocodeAll(); routeAll();
};
