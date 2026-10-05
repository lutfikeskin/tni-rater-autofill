import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rater-server-'));
const ev = (over = {}) => ({ id: crypto.randomUUID(), t: new Date().toISOString(), type: 'fill_run', carrier: 'progressive', page: 'AddVehicle', filled: 3, ...over });

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try { await fn({ base, post }); } finally { await new Promise((r) => server.close(r)); }
}

const stored = (dir) => fs.readdirSync(path.join(dir, 'events')).flatMap((f) => fs.readFileSync(path.join(dir, 'events', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

test('stores events once, even when an upload is retried', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post, base }) => {
    const events = [ev(), ev({ type: 'page_view', from: 'X', fields: 4 })];
    const r1 = await (await post({ agent: 'AYAZ', events })).json();
    assert.deepEqual([r1.accepted, r1.duplicates], [2, 0]);
    const r2 = await (await post({ agent: 'AYAZ', events })).json();
    assert.deepEqual([r2.accepted, r2.duplicates], [0, 2]);
    assert.equal((await (await fetch(`${base}/v1/health`)).json()).events, 2);
  });
  const rows = stored(dataDir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, 'AYAZ', 'agent filled from the request when the event has none');
  assert.ok(rows[0].receivedAt);
  // A restarted server still knows which ids it has.
  await withServer({ dataDir }, async ({ post }) => {
    assert.equal((await (await post({ events: [ev({ id: rows[0].id })] })).json()).duplicates, 1);
  });
});

test('keeps only known event types and fields', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'field_change', q: '2B9D', kind: 'select', from: 'a', to: 'b', typedValue: '02/03/1988' }),
      ev({ type: 'screenshot', image: 'x' }),
      ev({ id: 'x' }),
      ev({ type: 'page_layout', context: { state: 'MD' }, fields: [{ q: '396', label: 'Agent of Record', options: ['JANE DOE-1'] }, { q: '2B9D', label: 'Distance', options: ['50 miles'] }] }),
    ] })).json();
    assert.equal(r.accepted, 2);
    assert.equal(r.rejected.length, 2);
  });
  const [change, layout] = stored(dataDir);
  assert.equal(change.typedValue, undefined, 'unexpected fields are dropped');
  assert.equal(change.to, 'b');
  assert.equal(layout.fields[0].options, undefined, 'agency staff lists are dropped');
  assert.deepEqual(layout.fields[1].options, ['50 miles']);
});

test('keeps bounded Luna usage counters and drops unrelated fields', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [ev({ type: 'ai_suggest', model: 'gpt-6-luna', items: 2,
      modelCalls: 2, reasoningTokens: 31, cachedTokens: 9, cacheWriteTokens: 4,
      clientName: 'should not be stored' })] })).json();
    assert.equal(r.accepted, 1);
  });
  const [suggest] = stored(dataDir);
  assert.deepEqual({ modelCalls: suggest.modelCalls, reasoningTokens: suggest.reasoningTokens,
    cachedTokens: suggest.cachedTokens, cacheWriteTokens: suggest.cacheWriteTokens }, { modelCalls: 2,
    reasoningTokens: 31, cachedTokens: 9, cacheWriteTokens: 4 });
  assert.equal(suggest.clientName, undefined);
});

test('token, content type and size checks', async () => {
  await withServer({ dataDir: tmp(), token: 'secret' }, async ({ post, base }) => {
    assert.equal((await post({ events: [ev()] })).status, 401);
    assert.equal((await post({ events: [ev()] }, { authorization: 'Bearer wrong!' })).status, 401);
    assert.equal((await post({ events: [ev()] }, { authorization: 'Bearer secret' })).status, 200);
    const form = await fetch(`${base}/v1/events`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415, 'plain-text posts (what a web page can send without asking) are refused');
    assert.equal((await post({ events: 'nope' }, { authorization: 'Bearer secret' })).status, 400);
    assert.equal((await post({ events: Array.from({ length: 2001 }, () => ev()) }, { authorization: 'Bearer secret' })).status, 413);
  });
});

test('answers the browser preflight for extensions only', async () => {
  await withServer({ dataDir: tmp() }, async ({ base }) => {
    const ext = await fetch(`${base}/v1/events`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'POST' } });
    assert.equal(ext.status, 204);
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    const web = await fetch(`${base}/v1/events`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(web.status, 403);
    assert.equal(web.headers.get('access-control-allow-origin'), null);
  });
});

test('export: only with the admin token, the upload token is not enough; days and date range', async () => {
  const dataDir = tmp();
  await withServer({ dataDir, token: 'up', adminToken: 'admin' }, async ({ post, base }) => {
    await post({ events: [ev(), ev()] }, { authorization: 'Bearer up' });
    const get = (p, tokenValue) => fetch(`${base}${p}`, { headers: tokenValue ? { authorization: `Bearer ${tokenValue}` } : {} });
    assert.equal((await get('/v1/export')).status, 401);
    assert.equal((await get('/v1/export', 'up')).status, 401, 'the token every extension carries cannot read logs');
    const days = await (await get('/v1/days', 'admin')).json();
    assert.equal(days.days.length, 1);
    const today = days.days[0].day;
    const all = (await (await get(`/v1/export?since=${today}`, 'admin')).text()).trim().split('\n');
    assert.equal(all.length, 2);
    assert.equal((await (await get('/v1/export?since=2999-01-01', 'admin')).text()), '');
    assert.equal((await get('/v1/export?since=yesterday', 'admin')).status, 400);
  });
  await withServer({ dataDir }, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/export`, { headers: { authorization: 'Bearer ' } })).status, 401, 'no admin token configured: export off');
  });
});

test('keeps an event\'s order number and field key, and nothing else in their place', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'field_change', q: '2B9D', key: '2B9D@2', seq: 41, kind: 'select', from: 'a', to: 'b' }),
      ev({ type: 'fill_field', result: 'filled', q: '2B9D', key: { name: 'x' }, seq: -1 }),
      ev({ type: 'fill_field', result: 'filled', key: 'k'.repeat(300), seq: '7' }),
    ] })).json();
    assert.equal(r.accepted, 3);
  });
  const [change, odd, long] = stored(dataDir);
  assert.deepEqual([change.key, change.seq], ['2B9D@2', 41]);
  assert.deepEqual([odd.key, odd.seq], [undefined, undefined]);
  assert.deepEqual([long.key, long.seq], [undefined, undefined]);
});

test('a page layout with long choice lists fits, other events keep the smaller limit', async () => {
  const dataDir = tmp();
  const options = Array.from({ length: 250 }, (_, i) => `Synthetic business type ${i}`);
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'page_layout', context: { state: 'FL' }, fields: Array.from({ length: 6 }, (_, i) => ({ q: `Q${i}`, label: `Question ${i}`, options })) }),
      ev({ type: 'problem_report', text: 'x'.repeat(40 * 1024) }),
      ev({ type: 'page_layout', fields: Array.from({ length: 30 }, () => ({ options })) }),
    ] })).json();
    assert.equal(r.accepted, 1);
    assert.deepEqual(r.rejected.map((x) => [x.index, x.error]), [[1, 'event too large'], [2, 'event too large']]);
  });
  assert.equal(stored(dataDir)[0].fields[5].options.length, 250);
});

test('layouts keep why they were taken, never a pick from a staff list; layout errors are kept', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'page_layout', reason: 'appeared+changed', fields: [
        { q: '396', label: 'Agent of Record', options: ['JANE DOE-1'], selected: 'JANE DOE-1' },
        { q: '2B9D', label: 'Distance', options: ['50 miles'], selected: '50 miles', pageHasValue: true }] }),
      ev({ type: 'layout_error', reason: 'arrived', error: 'Frame was removed' }),
    ] })).json();
    assert.equal(r.accepted, 2);
  });
  const [layout, error] = stored(dataDir);
  assert.equal(layout.reason, 'appeared+changed');
  assert.deepEqual([layout.fields[0].options, layout.fields[0].selected], [undefined, undefined]);
  assert.equal(layout.fields[1].selected, '50 miles');
  assert.deepEqual([error.reason, error.error], ['arrived', 'Frame was removed']);
});
