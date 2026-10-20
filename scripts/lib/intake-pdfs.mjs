// Intake PDFs on this computer, found by the fingerprint the extension logs (SHA-256 of the file's
// bytes) and read with the extension's own reader. PDFs stay where they are: nothing is copied.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../../src/intake.js';

function* pdfs(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules') yield* pdfs(full, depth + 1);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) yield full;
  }
}

// fingerprint -> the PDF's fields, for the fingerprints in `wanted` found in `folders`.
export async function readIntakes(folders, wanted) {
  const raws = new Map();
  for (const folder of folders) {
    for (const file of pdfs(folder)) {
      const bytes = fs.readFileSync(file);
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!wanted.has(id) || raws.has(id)) continue;
      try { raws.set(id, await readIntakeFields(pdfjs, new Uint8Array(bytes))); } catch { /* not a readable intake */ }
    }
  }
  return raws;
}
