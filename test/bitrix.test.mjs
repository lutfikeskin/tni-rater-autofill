import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { bitrixClient, bitrixRows, emptyState, intakeFields, itemFieldName, pullBitrix } from '../scripts/lib/bitrix.mjs';
import { warehouseRows, writeWarehouse } from '../scripts/lib/warehouse.mjs';

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const BASE = 'https://tni.example.bitrix24.com/rest/1/secret/';

test('itemFieldName and intakeFields find the deal fields that hold intakes', () => {
  assert.equal(itemFieldName('UF_CRM_1743591562344'), 'ufCrm_1743591562344');
  assert.equal(itemFieldName('UF_CRM_MY_INTAKE_FILE'), 'ufCrmMyIntakeFile');
  assert.deepEqual(intakeFields({
    UF_CRM_1: { type: 'file', formLabel: 'Intakes Submitted file' },
    UF_CRM_2: { type: 'file', listLabel: 'Signed AOR' },
    UF_CRM_3: { type: 'string', formLabel: 'Intake notes' },
  }), ['UF_CRM_1']);
});

/**
 * A Bitrix that answers the methods a pull sends, and records them.
 * @param {{deals: any[], history: any[], files: Record<string, string>}} data
 */
function fakeBitrix(data) {
  /** @type {string[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetcher = async (input, init) => {
    const url = String(input);
    const json = (/** @type {any} */ body) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/file/')) {
      sent.push('download');
      const body = data.files[url.split('/file/')[1]];
      return body === undefined ? new Response('gone', { status: 404 }) : new Response(body);
    }
    const method = url.slice(BASE.length).replace(/\.json$/, '');
    sent.push(method);
    const params = JSON.parse(String(init?.body ?? '{}'));
    if (method === 'crm.deal.fields') return json({ result: { UF_CRM_1743591562344: { type: 'file', formLabel: 'Intakes Submitted file' }, UF_CRM_9: { type: 'file', formLabel: 'Signed AOR' } } });
    if (method === 'crm.status.list') return json({ result: [{ STATUS_ID: 'WON', NAME: 'Sold policy', EXTRA: { SEMANTICS: 'success' } }, { STATUS_ID: '5', NAME: 'Waiting for customer decision', EXTRA: { SEMANTICS: 'process' } }] });
    if (method === 'crm.item.list') {
      // Two pages, as Bitrix sends 50 at a time.
      const page = params.start ? data.deals.slice(1) : data.deals.slice(0, 1);
      return json({ result: { items: page }, ...(params.start ? {} : { next: 1 }) });
    }
    if (method === 'crm.stagehistory.list') return json({ result: { items: data.history.filter((h) => params.filter.OWNER_ID.includes(h.OWNER_ID)) } });
    return json({ error: 'METHOD_NOT_FOUND' });
  };
  return { sent, fetcher };
}

test('pullBitrix keeps stages, history and intake hashes, never downloads a hashed file twice, and only reads', async () => {
  const deals = [
    { id: 11, stageId: 'WON', categoryId: 0, createdTime: '2026-11-01T10:00:00+03:00', updatedTime: '2026-11-06T10:00:00+03:00', closed: 'Y', title: 'Client Trucking LLC', ufCrm_1743591562344: { id: 501, urlMachine: '/file/501' } },
    { id: 12, stageId: '5', categoryId: 0, createdTime: '2026-11-02T10:00:00+03:00', updatedTime: '2026-11-02T10:00:00+03:00', closed: 'N', ufCrm_1743591562344: { id: 502, urlMachine: '/file/missing' } },
  ];
  const history = [{ ID: 1, OWNER_ID: 11, STAGE_ID: '5', CREATED_TIME: '2026-11-01T10:00:00+03:00' }, { ID: 2, OWNER_ID: 11, STAGE_ID: 'WON', CREATED_TIME: '2026-11-06T10:00:00+03:00' }];
  const bx = fakeBitrix({ deals, history, files: { 501: 'intake pdf' } });
  const state = emptyState();
  const r = await pullBitrix(bitrixClient(BASE, bx.fetcher), state, { now: new Date('2026-11-16T00:00:00Z') });
  assert.deepEqual(r, { deals: 2, files: 2, hashed: 1, failed: 1, moves: 2 });
  assert.deepEqual(state.intakeFields, ['UF_CRM_1743591562344']);
  assert.deepEqual(state.deals['11'].intakes, [{ fileId: 501, sha: sha('intake pdf') }]);
  assert.deepEqual(state.deals['12'].intakes, [{ fileId: 502, sha: null }], 'a file that failed is kept without a hash');
  assert.equal(state.deals['11'].closed, true);
  assert.ok(!JSON.stringify(state).includes('Client Trucking'), 'no deal title or other client text is kept');
  assert.ok(bx.sent.every((m) => m === 'download' || /\.(fields|list|get)$/.test(m)), bx.sent.join());

  // The next pull: the hashed file isn't downloaded again; the failed one is tried again.
  const again = fakeBitrix({ deals, history, files: { 501: 'intake pdf', missing: 'late pdf' } });
  const r2 = await pullBitrix(bitrixClient(BASE, again.fetcher), state, { now: new Date('2026-11-17T00:00:00Z') });
  assert.equal(r2.hashed, 1);
  assert.equal(again.sent.filter((m) => m === 'download').length, 1);
  assert.deepEqual(state.deals['12'].intakes, [{ fileId: 502, sha: sha('late pdf') }]);

  // A deal not changed since, whose file still has no hash, is listed again by id.
  state.deals['12'].intakes = [{ fileId: 502, sha: null }];
  const quiet = fakeBitrix({ deals: [], history, files: { missing: 'late pdf' } });
  const listedById = deals.slice(1);
  const byId = /** @type {typeof fetch} */ (async (input, init) => {
    const params = JSON.parse(String(init?.body ?? '{}'));
    if (String(input).endsWith('crm.item.list.json') && params.filter['@id']) {
      assert.deepEqual(params.filter['@id'], [12]);
      return new Response(JSON.stringify({ result: { items: listedById } }));
    }
    return quiet.fetcher(input, init);
  });
  const r3 = await pullBitrix(bitrixClient(BASE, byId), state, { now: new Date('2026-11-18T00:00:00Z') });
  assert.equal(r3.hashed, 1);
  assert.deepEqual(state.deals['12'].intakes, [{ fileId: 502, sha: sha('late pdf') }]);
});

test('bitrixClient refuses a method that could change Bitrix, and its errors never carry the webhook', async () => {
  const bx = bitrixClient(BASE, async () => new Response(JSON.stringify({ error: 'INVALID_CREDENTIALS', error_description: 'bad' }), { status: 401 }));
  await assert.rejects(bx.call('crm.deal.update'), /not a read method/);
  await assert.rejects(bx.call('crm.deal.list'), (err) => err instanceof Error && !err.message.includes('secret') && /crm\.deal\.list: HTTP 401/.test(err.message));
});

test('the warehouse joins quotes to deals by intake PDF and says whether they sold after the quote', async () => {
  const pdf = (/** @type {string} */ name) => sha(`pdf ${name}`);
  const ev = (/** @type {string} */ session, /** @type {string} */ t, extra = {}) => [
    { id: `${session}-l`, type: 'intake_loaded', session, intakeId: pdf(session), t, agent: 'JC', install: 'i1', ...extra },
    { id: `${session}-p`, type: 'page_view', session, intakeId: pdf(session), t, carrier: 'progressive', page: 'Drivers' },
  ];
  const events = [
    ...ev('sold', '2026-11-04T15:00:00Z'), // deal 1: sold two days later
    ...ev('renewal', '2026-11-04T15:00:00Z'), // deal 2: sold last year, not since
    ...ev('old', '2026-08-01T15:00:00Z'), // deal 3: 60 days passed without a sale
    ...ev('young', '2026-11-10T15:00:00Z'), // deal 3 too: too young to say
    ...ev('nodeal', '2026-11-04T15:00:00Z'),
  ];
  const rows = warehouseRows(events, {});
  const state = {
    ...emptyState(), pulledAt: '2026-11-16T00:00:00Z', since: '2026-10-01T00:00:00Z',
    stages: [{ id: 'WON', name: 'Sold policy', semantics: 'success', category: 0 }, { id: '17', name: 'Not interested for now', semantics: 'process', category: 0 }],
    deals: {
      1: { id: 1, category: 0, stage: 'WON', created: '2026-11-01T00:00:00Z', updated: '2026-11-06T00:00:00Z', closed: true, intakes: [{ fileId: 1, sha: pdf('sold') }] },
      2: { id: 2, category: 0, stage: 'WON', created: '2025-01-01T00:00:00Z', updated: '2026-11-05T00:00:00Z', closed: true, intakes: [{ fileId: 2, sha: pdf('renewal') }] },
      3: { id: 3, category: 0, stage: '17', created: '2026-07-01T00:00:00Z', updated: '2026-11-11T00:00:00Z', closed: false, intakes: [{ fileId: 3, sha: pdf('old') }, { fileId: 4, sha: pdf('young') }, { fileId: 5, sha: null }] },
    },
    history: {
      1: { id: 1, deal: 1, stage: 'WON', at: '2026-11-06T09:00:00Z' },
      2: { id: 2, deal: 2, stage: 'WON', at: '2025-11-20T09:00:00Z' },
      3: { id: 3, deal: 3, stage: '17', at: '2026-08-05T09:00:00Z' },
    },
  };
  const sales = bitrixRows(state, /** @type {any[]} */ (rows.quotes));
  assert.deepEqual(sales.quote_deals.map((/** @type {any} */ x) => `${x.session}:${x.deal_id}`).sort(), ['old:3', 'renewal:2', 'sold:1', 'young:3']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-'));
  try {
    const file = path.join(dir, 'w.duckdb');
    await writeWarehouse(file, { ...rows, ...sales, build_info: [{ built_at: '2026-11-16T00:00:00Z', bitrix_pulled_at: state.pulledAt, bitrix_since: state.since }] });
    const instance = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
    const db = await instance.connect();
    const got = (await db.runAndReadAll('SELECT session, deal_id, client_before, days_to_sale, sold_within_60_days FROM v_quote_sales ORDER BY session')).getRowObjectsJS();
    db.closeSync();
    instance.closeSync();
    assert.deepEqual(got.map((r) => [r.session, r.deal_id, r.client_before, r.days_to_sale === null ? null : Number(r.days_to_sale), r.sold_within_60_days]), [
      ['old', 3, false, null, false],
      ['renewal', 2, true, null, null],
      ['sold', 1, false, 2, true],
      ['young', 3, false, null, null],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
