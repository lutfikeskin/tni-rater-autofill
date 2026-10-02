#!/usr/bin/env node
// Uploads usage-log files to the central server (moving a local server's history over, or an
// agent's exported log). Already-stored events are skipped by id, so it can be re-run safely.
//
//   node scripts/logs-push.mjs server-data/events [more files or folders...]

import fs from 'node:fs';
import path from 'node:path';
import { serverUrl, uploadToken } from './lib/central.mjs';

const files = process.argv.slice(2).flatMap((p) => (fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json')).map((f) => path.join(p, f)) : [p]));
if (!files.length) { console.error('Usage: node scripts/logs-push.mjs <events folder or files>'); process.exit(1); }

const events = files.flatMap((f) => {
  const text = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.json')) { const j = JSON.parse(text); return Array.isArray(j) ? j : j.events ?? []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
});
const total = { accepted: 0, duplicates: 0, rejected: 0 };
for (let i = 0; i < events.length; i += 1000) {
  const batch = events.slice(i, i + 1000).map(({ receivedAt, ...e }) => e);
  const res = await fetch(`${serverUrl()}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${uploadToken()}` },
    body: JSON.stringify({ events: batch }),
  });
  if (!res.ok) { console.error(`batch ${i / 1000 + 1}: ${res.status} ${await res.text()}`); process.exit(1); }
  const r = await res.json();
  total.accepted += r.accepted; total.duplicates += r.duplicates; total.rejected += r.rejected.length;
}
console.log(`${events.length} events -> ${serverUrl()}: ${total.accepted} stored, ${total.duplicates} already there, ${total.rejected} refused`);
