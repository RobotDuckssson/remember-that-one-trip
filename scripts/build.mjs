// Builds the single-file app (index.html) by inlining the source files and the
// two third-party libraries (Leaflet, exifr) into src/index.template.html.
// Usage: npm install && npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgDir = name => dirname(require.resolve(`${name}/package.json`));
const read = p => readFileSync(p, 'utf8');

const leafletDir = pkgDir('leaflet');
const exifrDir = pkgDir('exifr');
const exifrVersion = JSON.parse(read(join(exifrDir, 'package.json'))).version;

const parts = {
  '/*LEAFLET_CSS*/': read(join(leafletDir, 'dist/leaflet.css')),
  '/*LEAFLET_JS*/': read(join(leafletDir, 'dist/leaflet.js')),
  '/*EXIFR_JS*/': `/*! exifr ${exifrVersion} | (c) Mike Kovařík | MIT License | https://github.com/MikeKovarik/exifr */\n` + read(join(exifrDir, 'dist/full.umd.js')),
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
