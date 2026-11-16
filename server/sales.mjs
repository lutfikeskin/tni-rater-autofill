// The maintainer's sales page (GET /dashboard/sales on the usage server, server/index.mjs): which
// quoted clients bought. The server doesn't work it out. `npm run push-sales` (scripts/sales-push.mjs)
// sends rows the quoting history warehouse already computed (v_quote_sales: a quote joined to the
// Bitrix deal holding its intake PDF, docs/quoting-history-database.md, Sales) with the admin
// token, and the server keeps the last push (DATA_DIR/sales/latest.json) and draws it. So the
// page is as fresh as the last push, and the Bitrix webhook never reaches the server.
//
// A push is refused whole unless every row is in its exact shape: no field but those below, no
// name, contact or note (the warehouse has none). The page sits behind the dashboard's password.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_SALES_ROWS = 20000;
export const MAX_SALES_BYTES = 4 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/**
 * One quote and the deal holding its intake PDF (deal null: none found), as the warehouse says.
 * @typedef {{quote: string, startedAt: string, agent: string|null, deal: number|null, stage: string|null, open: boolean|null, clientBefore: boolean, soldAt: string|null, daysToSale: number|null, sold60: boolean|null}} SalesRow
 * @typedef {{builtAt: string, pulledAt: string, since: string, receivedAt: string, rows: SalesRow[]}} SalesPush
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const isIso = (/** @type {unknown} */ v) => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
const isoOrNull = (/** @type {unknown} */ v) => v === null || isIso(v);
const boolOrNull = (/** @type {unknown} */ v) => v === null || typeof v === 'boolean';
const intIn = (/** @type {unknown} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= lo && /** @type {number} */ (v) <= hi;
// As the server's own agent shape (COMMON_SHAPES.agent in index.mjs).
const AGENT = /^[\p{L}\p{N} .'-]{1,12}$/u;

/** @type {Record<keyof SalesRow, (v: unknown) => boolean>} */
const ROW = {
  quote: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  startedAt: isIso,
  agent: (v) => v === null || (typeof v === 'string' && AGENT.test(v)),
  deal: (v) => v === null || intIn(v, 1, 2 ** 31 - 1),
  stage: (v) => v === null || (typeof v === 'string' && v.length <= 80 && !/[\u0000-\u001f]/.test(v)),
  open: boolOrNull,
  clientBefore: (v) => typeof v === 'boolean',
  soldAt: isoOrNull,
  daysToSale: (v) => v === null || intIn(v, 0, 3650),
  sold60: boolOrNull,
};

/**
 * A push as the server keeps it, or why it is refused. Every row must have exactly ROW's fields.
 * @param {any} body
 * @param {string} receivedAt
 * @returns {{push: SalesPush, error?: undefined} | {error: string, push?: undefined}}
 */
export function salesPushFrom(body, receivedAt) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body is not an object' };
  for (const k of ['builtAt', 'pulledAt', 'since']) if (!isIso(body[k])) return { error: `${k} must be an ISO time` };
  if (!Array.isArray(body.rows)) return { error: 'rows must be an array' };
  if (body.rows.length > MAX_SALES_ROWS) return { error: `at most ${MAX_SALES_ROWS} rows` };
  const keys = Object.keys(ROW).sort().join();
  for (const [i, r] of body.rows.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join() !== keys) return { error: `row ${i}: needs exactly ${Object.keys(ROW).join(', ')}` };
    for (const [k, ok] of Object.entries(ROW)) if (!ok(r[k])) return { error: `row ${i}: ${k} out of shape` };
  }
  return { push: { builtAt: body.builtAt, pulledAt: body.pulledAt, since: body.since, receivedAt, rows: body.rows } };
}

const salesFile = (/** @type {string} */ dataDir) => path.join(dataDir, 'sales', 'latest.json');

/** Kept beside the old push and swapped in whole. @param {string} dataDir @param {SalesPush} push */
export function storeSales(dataDir, push) {
  const file = salesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(push));
  fs.renameSync(`${file}.tmp`, file);
}

/** The last push, or null. @param {string} dataDir @returns {SalesPush|null} */
export function readSales(dataDir) {
  const file = salesFile(dataDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const median = (/** @type {number[]} */ xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * What the page shows. A deal is the unit: one client often has several quotes. A deal's outcome is
 * its first quote's: sold after it (when, how soon), already a client before it, or still unknown.
 * @param {SalesPush} push
 */
export function summarizeSales(push) {
  const quotes = new Set(push.rows.map((r) => r.quote));
  const matched = new Set(push.rows.filter((r) => r.deal !== null).map((r) => r.quote));
  /** @type {Map<number, {deal: number, agent: string|null, firstQuote: string, quotes: Set<string>, stage: string|null, open: boolean|null, clientBefore: boolean, soldAt: string|null, daysToSale: number|null, sold60: boolean|null}>} */
  const deals = new Map();
  for (const r of [...push.rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (r.deal === null) continue;
    const d = deals.get(r.deal);
    if (!d) deals.set(r.deal, { deal: r.deal, agent: r.agent, firstQuote: r.startedAt, quotes: new Set([r.quote]), stage: r.stage, open: r.open, clientBefore: r.clientBefore, soldAt: r.soldAt, daysToSale: r.daysToSale, sold60: r.sold60 });
    else d.quotes.add(r.quote);
  }
  const list = [...deals.values()];
  /** @param {typeof list} ds */
  const tally = (ds) => ({
    deals: ds.length,
    quotes: ds.reduce((n, d) => n + d.quotes.size, 0),
    sold: ds.filter((d) => d.soldAt).length,
    notSold: ds.filter((d) => !d.soldAt && d.sold60 === false).length,
    unknown: ds.filter((d) => !d.soldAt && d.sold60 === null).length,
    clientBefore: ds.filter((d) => d.clientBefore).length,
    medianDays: median(ds.flatMap((d) => (d.daysToSale === null ? [] : [d.daysToSale]))),
  });
  /** @param {(d: typeof list[number]) => string} keyOf */
  const by = (keyOf) => {
    /** @type {Map<string, typeof list>} */
    const g = new Map();
    for (const d of list) g.set(keyOf(d), [...(g.get(keyOf(d)) ?? []), d]);
    return [...g].map(([key, ds]) => ({ key, ...tally(ds) }));
  };
  const unmatchedByAgent = new Map();
  for (const r of push.rows) if (!matched.has(r.quote)) unmatchedByAgent.set(r.agent ?? '?', (unmatchedByAgent.get(r.agent ?? '?') ?? new Set()).add(r.quote));
  const weekOf = (/** @type {string} */ iso) => {
    const t = new Date(Date.parse(iso));
    const monday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - ((t.getUTCDay() + 6) % 7) * DAY);
    return monday.toISOString().slice(0, 10);
  };
  return {
    builtAt: push.builtAt, pulledAt: push.pulledAt, since: push.since, receivedAt: push.receivedAt,
    quotes: quotes.size, matched: matched.size,
    totals: tally(list),
    agents: by((d) => d.agent ?? '?').map((a) => ({ ...a, unmatched: unmatchedByAgent.get(a.key)?.size ?? 0 })).sort((a, b) => b.deals - a.deals || a.key.localeCompare(b.key)),
    weeks: by((d) => weekOf(d.firstQuote)).sort((a, b) => a.key.localeCompare(b.key)),
    stages: by((d) => d.stage ?? '(no stage)').map((s) => ({ key: s.key, deals: s.deals, open: list.find((d) => (d.stage ?? '(no stage)') === s.key)?.open ?? null })).sort((a, b) => b.deals - a.deals),
    recent: list.filter((d) => d.soldAt).sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt))).slice(0, 30)
      .map((d) => ({ agent: d.agent, firstQuote: d.firstQuote, soldAt: d.soldAt, daysToSale: d.daysToSale, quotes: d.quotes.size })),
  };
}

const esc = (/** @type {unknown} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (/** @type {number|null} */ n) => (n === null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const day = (/** @type {string|null} */ iso) => (iso ? new Date(Date.parse(iso)).toISOString().slice(0, 10) : '—');
const exact = (/** @type {string} */ iso) => `${new Date(Date.parse(iso)).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const badge = (/** @type {string|null} */ agent) => `<span class="who">${esc(agent ?? '?')}</span>`;

// The same look as the usage page (server/dashboard.mjs STYLE), with an outcome bar.
const STYLE = `
:root{color-scheme:light;--bg:#f4f4f2;--card:#fcfcfb;--fg:#0b0b0b;--fg2:#52514e;--muted:#6f6d67;--line:#e4e3df;--accent:#2a78d6;--track:#eceae6;--good:#1f7a3d;--good-bg:#e3f3e8;--bad:#c42f2e;--unk:#b9b6ae}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#121211;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--muted:#9a988f;--line:#2e2d2b;--accent:#3987e5;--track:#262624;--good:#6fd28f;--good-bg:#173323;--bad:#f08a89;--unk:#55534e}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--muted:#9a988f;--line:#2e2d2b;--accent:#3987e5;--track:#262624;--good:#6fd28f;--good-bg:#173323;--bad:#f08a89;--unk:#55534e}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto}
a{color:var(--accent)}
.muted{color:var(--muted)}.small{font-size:12px}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:16px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}.sub{margin:2px 0 0;color:var(--fg2)}
.pill{display:inline-block;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);text-decoration:none;color:var(--fg2);white-space:nowrap}
.pill:hover{background:var(--track)}
.note{margin:0 0 16px;color:var(--fg2)}
section{margin-top:28px}h2{font-size:16px;margin:0 0 2px}.lead{margin:0 0 10px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile .label{font-weight:600;color:var(--fg2)}.tile .value{font-size:32px;font-weight:650;line-height:1.15;margin:4px 0 2px}
.tile .help{margin:0;color:var(--muted);font-size:12.5px}
.tile.good{background:var(--good-bg);border-color:transparent}.tile.good .label,.tile.good .value{color:var(--good)}
.split{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--track);min-width:120px}
.split span{display:block;height:100%}.split .s{background:var(--good)}.split .n{background:var(--bad)}.split .u{background:var(--unk)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
th{font-weight:600;color:var(--muted);font-size:12px;white-space:nowrap}
.r{text-align:right;font-variant-numeric:tabular-nums}.w{min-width:160px}
.who{display:inline-grid;place-items:center;min-width:34px;height:26px;padding:0 7px;border-radius:999px;background:var(--track);font-weight:650;font-size:12px;letter-spacing:.03em}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:var(--track);color:var(--fg2)}
.empty{margin:0;padding:18px;text-align:center;color:var(--muted)}
footer{margin-top:36px;color:var(--muted);font-size:12px}
`;

/** @param {{sold: number, notSold: number, unknown: number, deals: number}} t */
const split = (t) => {
  const pc = (/** @type {number} */ n) => (t.deals ? (n / t.deals) * 100 : 0);
  return `<span class="split" title="${esc(`${t.sold} sold, ${t.notSold} not sold after 60 days, ${t.unknown} not known yet`)}"><span class="s" style="width:${pc(t.sold)}%"></span><span class="n" style="width:${pc(t.notSold)}%"></span><span class="u" style="width:${pc(t.unknown)}%"></span></span>`;
};

/**
 * The page for the last push, or a page saying there is none yet.
 * @param {ReturnType<typeof summarizeSales>|null} s
 * @param {{now?: number}} [opts]
 */
export function renderSales(s, { now = Date.now() } = {}) {
  const head = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Rater sales</title><style>${STYLE}</style></head><body><main>`;
  const top = (/** @type {string} */ sub) => `<header><div><h1>Rater Autofill · sales</h1><p class="sub">${sub}</p></div><a class="pill" href="/dashboard">Back to live usage</a></header>`;
  if (!s) {
    return `${head}${top('No sales pushed yet.')}<div class="card"><p class="empty">Run <code>npm run bitrix</code>, <code>npm run warehouse</code> and <code>npm run push-sales</code> on the maintainer's computer.</p></div></main></body></html>`;
  }
  const t = s.totals;
  const age = Math.round((now - Date.parse(s.pulledAt)) / DAY);
  const tile = (/** @type {string} */ label, /** @type {number|null} */ value, /** @type {string} */ help, cls = '') => `<div class="tile${cls ? ` ${cls}` : ''}"><div class="label">${label}</div><div class="value">${fmt(value)}</div><p class="help">${help}</p></div>`;
  const legend = '<div class="legend"><span><i style="background:var(--good)"></i>sold after the quote</span><span><i style="background:var(--bad)"></i>not sold, 60 days passed</span><span><i style="background:var(--unk)"></i>not known yet</span></div>';
  /** @param {ReturnType<typeof summarizeSales>['agents']} rows @param {string} first @param {(k: string) => string} name @param {boolean} [unmatched] */
  const table = (rows, first, name, unmatched = false) => (rows.length ? `<div class="scroll"><table><thead><tr><th>${first}</th><th class="r">Deals</th><th class="r">Quotes</th><th class="w">Outcome</th><th class="r">Sold</th><th class="r">Not sold</th><th class="r">Not known yet</th><th class="r">Already clients</th><th class="r">Median days to sale</th>${unmatched ? '<th class="r">Quotes with no deal</th>' : ''}</tr></thead><tbody>
${rows.map((r) => `<tr><td>${name(r.key)}</td><td class="r">${fmt(r.deals)}</td><td class="r">${fmt(r.quotes)}</td><td class="w">${split(r)}</td><td class="r">${fmt(r.sold)}</td><td class="r">${fmt(r.notSold)}</td><td class="r">${fmt(r.unknown)}</td><td class="r">${fmt(r.clientBefore)}</td><td class="r">${fmt(r.medianDays)}</td>${unmatched ? `<td class="r">${fmt(/** @type {any} */ (r).unmatched)}</td>` : ''}</tr>`).join('\n')}
</tbody></table></div>` : '<p class="empty">None.</p>');

  return `${head}
${top(`Bitrix pulled ${esc(exact(s.pulledAt))}${age >= 2 ? ` (${age} days ago)` : ''} · pushed ${esc(exact(s.receivedAt))} · quotes since ${esc(day(s.since))}`)}
<p class="note">A quoted client bought when the Bitrix deal holding the quote's intake PDF moved to a sold stage <b>after</b> the quote. A deal already sold before the quote is an existing client (a renewal or a re-quote), counted apart. Until 60 days pass without a sale, a deal is <b>not known yet</b>, not lost. Counts are deals: one client often has several quotes. Test runs are left out. The page is as fresh as the last push, not live.</p>

<section aria-label="Totals"><div class="tiles">
${tile('Quotes matched to a deal', s.matched, `of ${fmt(s.quotes)} quotes (${s.quotes ? Math.round((s.matched / s.quotes) * 100) : 0}%): their intake PDF is on a Bitrix deal.`)}
${tile('Deals quoted', t.deals, `${fmt(t.quotes)} quotes on them.`)}
${tile('Sold after the quote', t.sold, `Median ${fmt(t.medianDays)} days from the first quote to the sale.`, 'good')}
${tile('Not sold, 60 days passed', t.notSold, 'No move to a sold stage within 60 days of the quote.')}
${tile('Not known yet', t.unknown, 'Quoted less than 60 days before the pull, not sold so far.')}
${tile('Already clients', t.clientBefore, 'The deal was sold before this quote: renewals and existing clients.')}
</div><div class="card" style="margin-top:12px">${split(t)}${legend}</div></section>

<section><h2>Agents</h2><p class="lead">Deals by the initials on their first quote. "Quotes with no deal": their intake PDF is on no deal (changed before it was attached, or not in Bitrix).</p>
<div class="card">${table(s.agents, 'Agent', (k) => badge(k), true)}</div></section>

<section><h2>By week of the first quote</h2><p class="lead">Weeks start on Monday. Recent weeks are mostly not known yet.</p>
<div class="card">${table(s.weeks, 'Week of', (k) => esc(k))}</div></section>

<section><h2>Where the deals are now</h2><p class="lead">Each quoted deal's stage in Bitrix today. An open stage, Not interested for now included, is not a loss.</p>
<div class="card"><div class="scroll"><table><thead><tr><th>Stage</th><th class="r">Deals</th><th></th></tr></thead><tbody>
${s.stages.map((x) => `<tr><td>${esc(x.key)}</td><td class="r">${fmt(x.deals)}</td><td>${x.open ? '<span class="tag">open</span>' : ''}</td></tr>`).join('\n')}
</tbody></table></div></div></section>

<section><h2>Recent sales</h2><p class="lead">Deals that moved to a sold stage after their quote, newest first.</p>
<div class="card">${s.recent.length ? `<div class="scroll"><table><thead><tr><th>Sold</th><th>Agent</th><th>First quote</th><th class="r">Days to sale</th><th class="r">Quotes</th></tr></thead><tbody>
${s.recent.map((r) => `<tr><td>${esc(day(r.soldAt))}</td><td>${badge(r.agent)}</td><td>${esc(day(r.firstQuote))}</td><td class="r">${fmt(r.daysToSale)}</td><td class="r">${fmt(r.quotes)}</td></tr>`).join('\n')}
</tbody></table></div>` : '<p class="empty">No sales after a quote yet.</p>'}</div></section>

<footer>Private page for the maintainer. Built ${esc(exact(s.builtAt))} from the quoting history warehouse: deal ids, stages and dates, no client names or contacts.</footer>
</main></body></html>`;
}
