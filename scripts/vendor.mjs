#!/usr/bin/env node
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
fs.mkdirSync(new URL('lib/', root), { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(new URL(`node_modules/pdfjs-dist/build/${file}`, root), new URL(`lib/${file}`, root));
}
console.log('Updated the two vendored PDF.js files in lib/.');
