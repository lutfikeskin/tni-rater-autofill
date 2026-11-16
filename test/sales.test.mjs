import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { renderSales, salesPushFrom, summarizeSales } from '../server/sales.mjs';
import { toSalesPush } from '../scripts/lib/sales-push.mjs';

const ADMIN = 'admin-token-0123456789';
const DASH = 'dashboard-secret-0123456789';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rater-sales-'));
/** @param {Record<string, any>} over */
const row = (over = {}) => ({ quote: 'q1', startedAt: '2026-11-04T15:00:00.000Z', agent: 'JC', deal: 1, stage: 'Sold policy', open: false, clientBefore: false, soldAt: '2026-11-06T09:00:00.000Z', daysToSale: 2, sold60: true, ...over });
/** @param {object[]} rows */
const body = (rows) => ({ builtAt: '2026-11-16T20:00:00.000Z', pulledAt: '2026-11-16T19:00:00.000Z', since: '2026-11-03T00:00:00.000Z', rows });

/** @param {Parameters<typeof createServer>[0]} opts @param {(base: string) => Promise<void>} fn */
async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = server.address();
  const log = console.log;
  console.log = () => {};
  try { await fn(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`); } finally { console.log = log; await new Promise((r) => server.close(() => r(undefined))); }
}

test('salesPushFrom keeps a push only in its exact shapes, and refuses it whole otherwise', () => {
  assert.equal(salesPushFrom(body([row()]), '2026-11-16T21:00:00.000Z').push?.rows.length, 1);
  const refused = [
    [row({ name: 'Client Trucking LLC' }), /needs exactly/],
    [row({ phone: undefined }), /needs exactly/],
    [{ ...row(), agent: 'x'.repeat(13) }, /agent out of shape/],
    [row({ deal: 0 }), /deal out of shape/],
    [row({ soldAt: '2026-11-06' }), /soldAt out of shape/],
    [row({ stage: 'a\nb' }), /stage out of shape/],
    [row({ clientBefore: null }), /clientBefore out of shape/],
    [row({ quote: '../../etc' }), /quote out of shape/],
  ];
  for (const [r, why] of refused) assert.match(String(salesPushFrom(body([row({ quote: 'ok' }), r]), 'x').error), why);
  assert.match(String(salesPushFrom({ ...body([]), pulledAt: 'yesterday' }, 'x').error), /pulledAt/);
});

test('summarizeSales counts deals, keeps sold, not sold and not known apart, and existing clients aside', () => {
  const s = summarizeSales(/** @type {any} */ ({ ...body([
    row({ quote: 'a1', deal: 1 }), row({ quote: 'a2', deal: 1, startedAt: '2026-11-05T10:00:00.000Z' }), // one client, two quotes
    row({ quote: 'b', deal: 2, agent: 'AA', stage: 'Not interested for now', open: true, soldAt: null, daysToSale: null, sold60: null }),
    row({ quote: 'c', deal: 3, agent: 'AA', startedAt: '2026-08-01T10:00:00.000Z', stage: 'Rejected', soldAt: null, daysToSale: null, sold60: false }),
    row({ quote: 'd', deal: 4, clientBefore: true, soldAt: null, daysToSale: null, sold60: null, stage: 'Renewal', open: true }),
    row({ quote: 'e', deal: null, stage: null, open: null, soldAt: null, daysToSale: null, sold60: null }),
  ]), receivedAt: '2026-11-16T21:00:00.000Z' }));
  assert.equal(s.quotes, 6);
  assert.equal(s.matched, 5);
  assert.deepEqual(s.totals, { deals: 4, quotes: 5, sold: 1, notSold: 1, unknown: 2, clientBefore: 1, medianDays: 2 });
  assert.deepEqual(s.agents.map((a) => [a.key, a.deals, a.unmatched]), [['AA', 2, 0], ['JC', 2, 1]]);
  assert.deepEqual(s.stages.find((x) => x.key === 'Not interested for now'), { key: 'Not interested for now', deals: 1, open: true });
  assert.deepEqual(s.recent.map((r) => r.quotes), [2]);
});

test('renderSales escapes what it draws and says when there is nothing yet', () => {
  assert.match(renderSales(null), /No sales pushed yet/);
  const html = renderSales(summarizeSales(/** @type {any} */ ({ ...body([row({ agent: "O'B", stage: '<script>x</script>' })]), receivedAt: '2026-11-16T21:00:00.000Z' })), { now: Date.parse('2026-11-17T00:00:00Z') });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /O&#39;B/);
  assert.match(html, /Not known yet/);
});

test('the server takes a push with the admin token only, and shows it behind the dashboard password', async () => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  try {
    await withServer({ dataDir, token: 'upload-token', adminToken: ADMIN, dashboardToken: DASH }, async (base) => {
      const put = (/** @type {string} */ auth, /** @type {unknown} */ b) => fetch(`${base}/v1/sales`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(b) });
      assert.equal((await put('upload-token', body([row()]))).status, 401, 'the upload token is public: never');
      assert.equal((await put(DASH, body([row()]))).status, 401, 'the dashboard password reads, never writes');
      assert.equal((await put(ADMIN, body([row({ email: 'a@b.c' })]))).status, 400);
      assert.equal(fs.existsSync(path.join(dataDir, 'sales', 'latest.json')), false, 'a refused push stores nothing');
      const ok = await put(ADMIN, body([row()]));
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { rows: 1 });

      assert.equal((await fetch(`${base}/dashboard/sales`)).status, 401);
      assert.equal((await fetch(`${base}/dashboard/sales`, { headers: { authorization: `Bearer ${ADMIN}` } })).status, 401, 'the admin token is not the page password');
      const page = await fetch(`${base}/dashboard/sales`, { headers: { authorization: `Bearer ${DASH}` } });
      assert.equal(page.status, 200);
      assert.match(String(page.headers.get('content-security-policy')), /default-src 'none'/);
      assert.match(await page.text(), /Sold after the quote/);
      const usage = await (await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${DASH}` } })).text();
      assert.match(usage, /href="\/dashboard\/sales"/, 'the usage page links to it');
    });
    await withServer({ dataDir, adminToken: ADMIN }, async (base) => {
      assert.equal((await fetch(`${base}/dashboard/sales`, { headers: { authorization: `Bearer ${DASH}` } })).status, 404, 'off with the dashboard');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('toSalesPush turns the warehouse rows into the server\'s shapes', () => {
  const push = toSalesPush([
    { session: 's1', started_at: '2026-11-04 18:00:00+03', agent: 'JC', deal_id: 7, stage_name: 'Sold policy', stage_semantics: 'success', client_before: false, sold_at: '2026-11-06 12:00:00+03', days_to_sale: '2', sold_within_60_days: true },
    { session: 's2', started_at: '2026-11-05 10:00:00+03', agent: null, deal_id: null, stage_name: null, stage_semantics: null, client_before: null, sold_at: null, days_to_sale: null, sold_within_60_days: null },
  ], { builtAt: '2026-11-16 20:00:00+03', pulledAt: '2026-11-16 19:00:00+03', since: '2026-11-03' });
  assert.ok(salesPushFrom(push, 'x').push, String(salesPushFrom(push, 'x').error));
  assert.deepEqual(push.rows[0], { quote: 's1', startedAt: '2026-11-04T15:00:00.000Z', agent: 'JC', deal: 7, stage: 'Sold policy', open: false, clientBefore: false, soldAt: '2026-11-06T09:00:00.000Z', daysToSale: 2, sold60: true });
  assert.deepEqual(push.rows[1], { quote: 's2', startedAt: '2026-11-05T07:00:00.000Z', agent: null, deal: null, stage: null, open: null, clientBefore: false, soldAt: null, daysToSale: null, sold60: null });
});
