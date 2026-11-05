// Builds the single-file app (index.html) by inlining the source files and the
// third-party libraries (Leaflet, exifr, mp4-muxer) into src/index.template.html.
// Usage: npm install && npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = name => join(root, 'node_modules', name);
const read = p => readFileSync(p, 'utf8');

const leafletDir = pkgDir('leaflet');
const exifrDir = pkgDir('exifr');
const exifrVersion = JSON.parse(read(join(exifrDir, 'package.json'))).version;
const muxDir = pkgDir('mp4-muxer');
const muxVersion = JSON.parse(read(join(muxDir, 'package.json'))).version;

const parts = {
  '/*LEAFLET_CSS*/': read(join(leafletDir, 'dist/leaflet.css')),
  '/*LEAFLET_JS*/': read(join(leafletDir, 'dist/leaflet.js')),
  '/*EXIFR_JS*/': `/*! exifr ${exifrVersion} | (c) Mike Kovařík | MIT License | https://github.com/MikeKovarik/exifr */\n` + read(join(exifrDir, 'dist/full.umd.js')),
  '/*MP4MUXER_JS*/': `/*! mp4-muxer ${muxVersion} | (c) Vanilagy | MIT License | https://github.com/Vanilagy/mp4-muxer */\n` + read(join(muxDir, 'build/mp4-muxer.js')),
  '/*APP_JS*/': ['app.js', 'music.js', 'film.js'].map(f => read(join(root, 'src', f))).join('\n'),
};

let html = read(join(root, 'src/index.template.html'));
for (const [marker, content] of Object.entries(parts)) {
  if (!html.includes(marker)) throw new Error(`Marker ${marker} missing in template`);
  html = html.split(marker).join(content.replace(/<\/script/gi, '<\\/script'));
}
html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- Remember That One Trip – built file, do not edit. Edit src/ and run `npm run build`. Third-party licenses: see THIRD_PARTY_NOTICES.md -->');
writeFileSync(join(root, 'index.html'), html);
console.log(`Built index.html (${(html.length / 1024).toFixed(0)} KB)`);
