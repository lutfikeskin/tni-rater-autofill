#!/usr/bin/env node
// Sends the warehouse's sales rows to the usage server's sales page (GET /dashboard/sales,
// server/sales.mjs): each quote since --since (test runs left out) with the Bitrix deal holding
// its intake PDF and whether it sold after the quote, as v_quote_sales says. The server only draws
// them, so the page is as fresh as this push. Run after npm run bitrix and npm run warehouse.
//
//   npm run push-sales                        # server-data/warehouse.duckdb -> the central server
//   node scripts/sales-push.mjs [--warehouse file.duckdb] [--since 2026-11-03] [--server URL]
//
// Needs the admin token (RATER_ADMIN_TOKEN or ~/.config/tni-rater/admin-token). Sends initials,
// times, deal ids and stage names only: the warehouse holds no client name or contact.

import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { adminToken, serverUrl } from './lib/central.mjs';
import { salesRowsSql, toSalesPush } from './lib/sales-push.mjs';

const args = process.argv.slice(2);
/** @param {string} msg @returns {never} */
const fail = (msg) => { console.error(msg); process.exit(1); };
/** @param {string} name */
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
  return args[i + 1];
};
const file = opt('warehouse') ?? 'server-data/warehouse.duckdb';
// Agents' quotes began on 2026-11-03; earlier ones were the maintainer's pilot.
const since = opt('since') ?? '2026-11-03';
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) fail('--since is a day: YYYY-MM-DD.');
const base = (opt('server') ?? serverUrl()).replace(/\/$/, '');
if (!fs.existsSync(file)) fail(`No warehouse at ${file}: run npm run warehouse first.`);
const token = adminToken();
if (!token) fail('No admin token: set RATER_ADMIN_TOKEN or put it in ~/.config/tni-rater/admin-token.');

const instance = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
const db = await instance.connect();
let push;
try {
  const info = (await db.runAndReadAll('SELECT max(built_at) AS built_at, max(bitrix_pulled_at) AS pulled_at FROM build_info')).getRowObjectsJson()[0];
  if (!info?.pulled_at) fail(`${file} has no Bitrix pull: run npm run bitrix, then npm run warehouse.`);
  const rows = (await db.runAndReadAll(salesRowsSql(since))).getRowObjectsJson();
  push = toSalesPush(rows, { builtAt: String(info.built_at), pulledAt: String(info.pulled_at), since });
} finally {
  db.closeSync();
  instance.closeSync();
}

const res = await fetch(`${base}/v1/sales`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(push) });
const body = await res.json().catch(() => ({}));
if (!res.ok) fail(`${base} answered ${res.status}: ${body.error ?? 'no reason given'}`);
console.log(`${body.rows} quotes sent to ${base}/dashboard/sales (Bitrix pulled ${push.pulledAt.slice(0, 16).replace('T', ' ')} UTC).`);
