#!/usr/bin/env node
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
fs.mkdirSync(new URL('lib/', root), { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(new URL(`node_modules/pdfjs-dist/build/${file}`, root), new URL(`lib/${file}`, root));
}
// fflate's browser build: the side panel zips a developer recording with it (sidepanel/recording.js).
const fflate = JSON.parse(fs.readFileSync(new URL('node_modules/fflate/package.json', root), 'utf8'));
// Its licence notice goes with it: the store ZIP ships lib/, and MIT asks that a copy keep it.
const license = fs.readFileSync(new URL('node_modules/fflate/LICENSE', root), 'utf8').trim().split(/\r?\n/).map((line) => `//${line ? ` ${line}` : ''}`).join('\n');
const header = `// fflate ${fflate.version}, ${fflate.license} licence (https://github.com/101arrowz/fflate), vendored by scripts/vendor.mjs.\n//\n${license}\n`;
fs.writeFileSync(new URL('lib/fflate.mjs', root), header + fs.readFileSync(new URL('node_modules/fflate/esm/browser.js', root), 'utf8'));
console.log('Updated the vendored PDF.js and fflate files in lib/.');
