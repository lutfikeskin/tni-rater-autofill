#!/usr/bin/env node
// Pulls TNI's deals from Bitrix24 for the quoting history warehouse: stages, stage history and a
// SHA-256 of each intake file on a deal, never a name, contact or note (scripts/lib/bitrix.mjs,
// docs/quoting-history-database.md, Sales). Read-only: only list, get and fields methods are sent.
//
//   npm run bitrix                       # server-data/bitrix/deals.json, the changes since the last pull
//   node scripts/bitrix-pull.mjs [--since 2026-10-01] [--category 0] [--out server-data/bitrix/deals.json]
//
// The webhook URL is a credential: RATER_BITRIX_WEBHOOK, or ~/.config/tni-rater/bitrix-webhook
// (chmod 600). It is never printed. Then run npm run warehouse.

import { bitrixClient, emptyState, pullBitrix, readBitrixState, webhookUrl, writeBitrixState, WEBHOOK_FILE } from './lib/bitrix.mjs';

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
const out = opt('out') ?? 'server-data/bitrix/deals.json';
const sinceOpt = opt('since');
const since = sinceOpt ? new Date(sinceOpt).toISOString() : null;
const category = Number(opt('category') ?? 0);
if (!Number.isInteger(category) || category < 0) fail('--category is a pipeline id: 0 is General.');

const base = webhookUrl();
if (!base) fail(`No Bitrix webhook: set RATER_BITRIX_WEBHOOK or put its URL in ${WEBHOOK_FILE}.`);

const old = readBitrixState(out);
// Another pipeline is another pull: its own file.
if (old && old.category !== category) fail(`${out} holds pipeline ${old.category}; pass --out for pipeline ${category}.`);
const state = old ?? emptyState(category);
try {
  const r = await pullBitrix(bitrixClient(base), state, { since, log: (m) => console.log(m) });
  writeBitrixState(out, state);
  console.log(`${r.moves} stage moves. ${Object.keys(state.deals).length} deals kept in ${out}. Now npm run warehouse.`);
} catch (err) {
  fail(`Bitrix pull failed, ${out} left as it was: ${err instanceof Error ? err.message : err}`);
}
