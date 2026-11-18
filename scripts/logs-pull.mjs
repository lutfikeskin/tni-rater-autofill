#!/usr/bin/env node
// Downloads the agents' usage log from the central server into server-data/events/ (one file per
// day received, like the server keeps them), so npm run review / learn / layouts read it.
// Whole-or-nothing: a non-JSON line or a day with fewer events than the local file already holds
// stops the pull (exit 1) before anything is written, unless --allow-shrink is passed.
//
//   npm run pull                    # everything
//   npm run pull -- --since 2026-10-01
//   npm run pull -- --out some/folder
//   npm run pull -- --allow-shrink

import path from 'node:path';
import { serverUrl, adminToken } from './lib/central.mjs';
import { parseExport, writeDays } from './lib/logs-pull.mjs';

const args = process.argv.slice(2);
/** @param {string} name */
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const since = opt('since') ?? '0000-00-00';
const out = path.resolve(opt('out') ?? 'server-data');
const allowShrink = args.includes('--allow-shrink');
const token = adminToken();
if (!token) { console.error('No admin token: set RATER_ADMIN_TOKEN or put it in ~/.config/tni-rater/admin-token.'); process.exit(1); }

const res = await fetch(`${serverUrl()}/v1/export?since=${since}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`${serverUrl()} answered ${res.status}: ${await res.text()}`); process.exit(1); }
const text = await res.text();

const dir = path.join(out, 'events');
let result;
try {
  result = parseExport(text);
  writeDays(dir, result.byDay, { allowShrink });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
console.log(`${result.events} events from ${serverUrl()} (${result.byDay.size} days) -> ${path.relative(process.cwd(), dir) || dir}`);
