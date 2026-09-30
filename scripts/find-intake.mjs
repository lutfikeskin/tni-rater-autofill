#!/usr/bin/env node
// Finds which intake PDFs a usage log refers to. Logs identify intakes only by a SHA-256
// fingerprint of the PDF file, so this hashes every PDF under a folder and matches them.
//
//   node scripts/find-intake.mjs <folder with intake PDFs> <usage-log.json | intakeId>...
//
// Runs entirely on this computer; prints file paths, which may contain client names.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [folder, ...targets] = process.argv.slice(2);
if (!folder || !targets.length) {
  console.error('usage: node scripts/find-intake.mjs <folder> <usage-log.json | intakeId>...');
  process.exit(1);
}

const wanted = new Map(); // intakeId -> number of sessions seen
for (const t of targets) {
  if (/^[0-9a-f]{64}$/i.test(t)) { wanted.set(t.toLowerCase(), wanted.get(t) ?? 0); continue; }
  const log = JSON.parse(fs.readFileSync(t, 'utf8'));
  for (const e of log.events ?? []) if (e.type === 'intake_loaded') wanted.set(e.intakeId, (wanted.get(e.intakeId) ?? 0) + 1);
}

function* pdfs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* pdfs(p);
    else if (/\.pdf$/i.test(entry.name)) yield p;
  }
}

const found = new Map();
for (const file of pdfs(folder)) {
  const id = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (wanted.has(id)) found.set(id, [...(found.get(id) ?? []), file]);
}

for (const [id, sessions] of wanted) {
  const files = found.get(id);
  console.log(`${id.slice(0, 12)}…  ${sessions} session(s)  ${files ? files.join('\n                            ') : '(not found in this folder)'}`);
}
