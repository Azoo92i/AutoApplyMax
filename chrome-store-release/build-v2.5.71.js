#!/usr/bin/env node
/**
 * Build AutoApplyMax-v<version>.zip for Chrome Web Store upload.
 * Uses adm-zip (writes forward-slash paths — Chrome rejects backslashes).
 * Ships ONLY runtime files: no docs, no old zips, no build scripts.
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const root = __dirname;
process.chdir(root);

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const out = `AutoApplyMax-v${manifest.version}.zip`;

const runtimeFiles = [
  'manifest.json',
  'background.js',
  'content-marker.js',
  'content-simple.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'popup-improvements.js',
];
const runtimeDirs = ['core', 'adapters', 'icons'];

console.log(`Building ${out} (version ${manifest.version})...`);

if (fs.existsSync(out)) fs.unlinkSync(out);

const zip = new AdmZip();
for (const f of runtimeFiles) {
  if (!fs.existsSync(f)) { console.warn(`  SKIP missing: ${f}`); continue; }
  zip.addLocalFile(f);
}
for (const d of runtimeDirs) {
  if (!fs.existsSync(d)) { console.warn(`  SKIP missing dir: ${d}`); continue; }
  zip.addLocalFolder(d, d);
}
zip.writeZip(out);

const sizeKb = Math.round(fs.statSync(out).size / 1024);
const entries = zip.getEntries();
console.log(`\u2713 ${out} ready \u2014 ${sizeKb} KB, ${entries.length} entries`);
console.log('  First 5 entries (verify forward-slash paths):');
entries.slice(0, 5).forEach(e => console.log('   ', e.entryName));
