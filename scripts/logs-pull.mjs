#!/usr/bin/env node
// Downloads the agents' usage log from the central server into server-data/events/ (one file per
// day received, like the server keeps them), so npm run review / learn / layouts read it.
//
//   npm run pull                    # everything
//   npm run pull -- --since 2026-10-01
//   npm run pull -- --out some/folder

import fs from 'node:fs';
import path from 'node:path';
import { serverUrl, adminToken } from './lib/central.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const since = opt('since') ?? '0000-00-00';
const out = path.resolve(opt('out') ?? 'server-data');
const token = adminToken();
if (!token) { console.error('No admin token: set RATER_ADMIN_TOKEN or put it in ~/.config/tni-rater/admin-token.'); process.exit(1); }

const res = await fetch(`${serverUrl()}/v1/export?since=${since}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`${serverUrl()} answered ${res.status}: ${await res.text()}`); process.exit(1); }
const lines = (await res.text()).split('\n').filter(Boolean);

// Re-split by day received, replacing local files for the days downloaded.
const byDay = new Map();
for (const line of lines) {
  let day = '0000-00-00';
  try { day = String(JSON.parse(line).receivedAt ?? '').slice(0, 10) || day; } catch { continue; }
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(line);
}
const dir = path.join(out, 'events');
fs.mkdirSync(dir, { recursive: true });
for (const [day, rows] of byDay) fs.writeFileSync(path.join(dir, `${day}.jsonl`), `${rows.join('\n')}\n`);
console.log(`${lines.length} events from ${serverUrl()} (${byDay.size} days) -> ${path.relative(process.cwd(), dir) || dir}`);
