// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, startupError, SERVER_HASH, EVENT_FIELDS, PROFILE, lunaRequestError, LUNA_MAX_CHARS, LUNA_TIMEOUT_MS, UPLOAD_LIMITS, minFreeBytesFrom, LUNA_DAILY_TOKENS, lunaDailyTokensFrom, SCHEMA_VERSION } from '../server/index.mjs';
import { MAX_EVENTS } from '../src/usage.js';
import { buildRequest, MAX_REQUEST_CHARS, TIMEOUT_MS } from '../src/ai/luna.js';
import { collectItems } from '../src/ai/common.js';
import { checkServer } from '../scripts/lib/central.mjs';
import { imageFiles } from '../scripts/lib/deploy.mjs';

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
  await withServer({ dataDir, adminToken: 'admin' }, async ({ post, base }) => {
    const events = [ev(), ev({ type: 'page_view', from: 'X', fields: 4 })];
    const r1 = await (await post({ agent: 'AYAZ', events })).json();
    assert.deepEqual([r1.accepted, r1.duplicates], [2, 0]);
    const r2 = await (await post({ agent: 'AYAZ', events })).json();
    assert.deepEqual([r2.accepted, r2.duplicates], [0, 2]);
    assert.equal((await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer admin' } })).json()).events, 2);
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

// Audit 2026-11-07, SRV-05: the extension deletes its copy of an upload once the server says 200,
// so the day file is flushed to the disk (fsync) before that answer. A flush that fails is a 500:
// the extension keeps the events and sends them again.
test('an upload is on the disk before its 200; a failed flush is a 500 and the events can be sent again', async (t) => {
  const dataDir = tmp();
  const synced = [];
  const sync = t.mock.method(fs, 'fsyncSync', (fd) => { synced.push(fd); });
  const events = [ev(), ev()];
  await withServer({ dataDir }, async ({ post }) => {
    synced.length = 0; // what the start flushed: its own test, below
    assert.equal((await post({ events: events.slice(0, 1) })).status, 200);
    assert.equal(synced.length, process.platform === 'win32' ? 1 : 2, 'flushed before the answer (on Linux, its folder too)');
    assert.equal(typeof synced[0], 'number');
    sync.mock.mockImplementation(() => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); });
    assert.equal((await post({ events: events.slice(1) })).status, 500);
    sync.mock.mockImplementation((fd) => { synced.push(fd); });
    const again = await (await post({ events: events.slice(1) })).json();
    assert.deepEqual([again.accepted, again.duplicates], [1, 0], 'not counted as stored: sent again, it is accepted');
  });
  assert.deepEqual(stored(dataDir).map((e) => e.id), [events[0].id, events[1].id, events[1].id], 'a line written before its failed flush may be on the disk twice');
});

// The review of #425: fsync on a new file doesn't keep its directory entry, so an upload also flushes
// the events folder (on Linux, where the server runs; Windows can't open one). Every upload does:
// one whose folder flush failed was a 500, and its retry finds the day file there already.
test('an upload also flushes the events folder, so a new day file survives a crash, retries included', async (t) => {
  const dataDir = tmp();
  const opened = new Map();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); opened.set(fd, path.relative(dataDir, String(p))); return fd; });
  const synced = [];
  const sync = t.mock.method(fs, 'fsyncSync', (fd) => { synced.push(opened.get(fd)); });
  await withServer({ dataDir }, async ({ post }) => {
    synced.length = 0;
    assert.equal((await post({ events: [ev()] })).status, 200);
    const day = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    const dayFile = path.join('events', day);
    const both = process.platform === 'win32' ? [dayFile] : [dayFile, 'events'];
    assert.deepEqual(synced, both, 'the file, then its folder');
    synced.length = 0;
    assert.equal((await post({ events: [ev()] })).status, 200);
    assert.deepEqual(synced, both, 'a day file that was there already: the same');
    if (process.platform === 'win32') return;
    // The folder's flush fails: a 500. The retry, with the day file there, flushes the folder again.
    synced.length = 0;
    sync.mock.mockImplementation((fd) => { if (opened.get(fd) === 'events') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); synced.push(opened.get(fd)); });
    const retried = ev();
    assert.equal((await post({ events: [retried] })).status, 500);
    sync.mock.mockImplementation((fd) => { synced.push(opened.get(fd)); });
    synced.length = 0;
    assert.equal((await post({ events: [retried] })).status, 200);
    assert.deepEqual(synced, [dayFile, 'events'], 'the retry flushes the folder before its 200');
  });
});

// The review of #425: after a failed flush and a restart, the retry is a duplicate of a line the
// start read, answered 200 without a write. So the start flushes every day file it reads, and the
// folder (on Linux), before it takes an upload.
test('a restarted server flushes the events it reads, so a retry answered as a duplicate is on the disk', async (t) => {
  const dataDir = tmp();
  const kept = ev();
  const day = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'events', day), `${JSON.stringify({ ...kept, receivedAt: new Date().toISOString() })}\n`);
  const opened = new Map();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); opened.set(fd, path.relative(dataDir, String(p))); return fd; });
  const synced = [];
  t.mock.method(fs, 'fsyncSync', (fd) => { synced.push(opened.get(fd)); });
  await withServer({ dataDir }, async ({ post }) => {
    assert.deepEqual(synced, process.platform === 'win32' ? [path.join('events', day)] : [path.join('events', day), 'events'], 'flushed at the start');
    const again = await (await post({ events: [kept] })).json();
    assert.equal(again.duplicates, 1);
  });
});

test('keeps only known event types and fields', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'field_change', q: '2B9D', kind: 'select', from: 'a', to: 'b', typedValue: '02/03/1988', filled: undefined }),
      ev({ type: 'screenshot', image: 'x' }),
      ev({ id: 'x' }),
      ev({ type: 'page_layout', context: { state: 'MD' }, fields: [{ q: '396', label: 'Agent of Record', options: ['JANE DOE-1'] }, { q: '2B9D', label: 'Distance', options: ['50 miles'] }] }),
    ] })).json();
    assert.equal(r.accepted, 2);
    assert.equal(r.rejected.length, 2);
  });
  const [change, layout] = stored(dataDir);
  assert.equal(change.typedValue, undefined, 'unexpected fields are dropped');
  assert.deepEqual(change.dropped, ['typedValue'], 'and named on the event, without their values');
  assert.equal(change.to, 'b');
  assert.equal(layout.fields[0].options, undefined, 'agency staff lists are dropped');
  assert.deepEqual(layout.fields[1].options, ['50 miles']);
});

test('keeps bounded Luna usage counters and drops unrelated fields', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [ev({ type: 'ai_suggest', model: 'gpt-6-luna', items: 2,
      modelCalls: 2, reasoningTokens: 31, cachedTokens: 9, cacheWriteTokens: 4,
      leaveMissing: 1, leaveConflict: 0, leaveChose: 0, leaveNoSource: 0, leaveUnverified: 1, leaveTooLarge: 1, promptHash: '0123456789ab',
      clientName: 'should not be stored' })] })).json();
    assert.equal(r.accepted, 1);
  });
  const [suggest] = stored(dataDir);
  assert.deepEqual({ modelCalls: suggest.modelCalls, reasoningTokens: suggest.reasoningTokens,
    cachedTokens: suggest.cachedTokens, cacheWriteTokens: suggest.cacheWriteTokens }, { modelCalls: 2,
    reasoningTokens: 31, cachedTokens: 9, cacheWriteTokens: 4 });
  // Why questions were left, as counts.
  assert.deepEqual({ missing: suggest.leaveMissing, unverified: suggest.leaveUnverified, chose: suggest.leaveChose, tooLarge: suggest.leaveTooLarge },
    { missing: 1, unverified: 1, chose: 0, tooLarge: 1 });
  assert.equal(suggest.promptHash, '0123456789ab');
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
      ev({ type: 'page_layout', reason: 'appeared+changed', step: 'Vehicles', fields: [
        { q: '396', label: 'Agent of Record', options: ['JANE DOE-1'], selected: 'JANE DOE-1' },
        { q: '2B9D', label: 'Distance', options: ['50 miles'], selected: '50 miles', pageHasValue: true }] }),
      ev({ type: 'layout_error', reason: 'arrived', error: 'Frame was removed' }),
    ] })).json();
    assert.equal(r.accepted, 2);
  });
  const [layout, error] = stored(dataDir);
  assert.deepEqual([layout.reason, layout.step], ['appeared+changed', 'Vehicles']);
  assert.deepEqual([layout.fields[0].options, layout.fields[0].selected], [undefined, undefined]);
  assert.equal(layout.fields[1].selected, '50 miles');
  assert.deepEqual([error.reason, error.error], ['arrived', 'Frame was removed']);
});

test('a view is kept only as a tab order and a vehicle, driver or trailer number', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: ['t1', 't12:v0', 't2:d3', 't2:tr1', 'tab 917', 't1:Jordan', 7].map((view) => ev({ type: 'page_view', page: 'AddVehicle', view, filled: undefined })) })).json();
    assert.equal(r.accepted, 7);
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((e) => e.view), ['t1', 't12:v0', 't2:d3', 't2:tr1', undefined, undefined, undefined]);
  assert.deepEqual(rows.map((e) => e.dropped), [undefined, undefined, undefined, undefined, ['view'], ['view'], ['view']], 'a view it threw away is named');
});

// Audit 2026-10-08: which copy and commit logged an event; only those values.
test('an event keeps the copy and commit that logged it, and nothing else in their place', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [ev({ channel: 'store', commit: '7a5cdb5244' }), ev({ channel: 'unpacked', commit: '7a5cdb5244+dirty' }), ev({ channel: 'beta', commit: 'Jordan Sample' })] });
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((e) => [e.channel, e.commit]), [['store', '7a5cdb5244'], ['unpacked', '7a5cdb5244+dirty'], [undefined, undefined]]);
  assert.deepEqual(rows[2].dropped, ['channel', 'commit'], 'thrown away and named');
});

// Audit 2026-10-08: 453 events from the local test page sat among agents' events.
test('events from the local test page are refused, with why', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [ev({ carrier: 'test' }), ev(), ev({ type: 'intake_loaded', carrier: undefined, filled: undefined })] })).json();
    assert.deepEqual([r.accepted, r.duplicates], [2, 0]);
    assert.deepEqual(r.rejected, [{ index: 0, error: 'events from the local test page are not collected' }]);
  });
  assert.deepEqual(stored(dataDir).map((e) => e.carrier ?? null), ['progressive', null]);
});

// Audit 2026-10-08: an older server silently dropped fields the extension sent (pageChanged, how,
// trailer views). What it drops is named on the event, and /v1/health says which version runs.
test('dropped fields are named on the event (names only, bounded), and health names the server version', async () => {
  const dataDir = tmp();
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`extra${i}`, i]));
  await withServer({ dataDir }, async ({ post, base }) => {
    await post({ events: [ev({ seq: -1, ...many, 'Jordan Sample': 'x' })] });
    const health = await (await fetch(`${base}/v1/health`)).json();
    // Every file the image copies (server/Dockerfile), in its order: a change to any of them, the
    // privacy page included, is another server (the review of #426).
    const hash = crypto.createHash('sha256');
    const copied = imageFiles(fs.readFileSync(new URL('../server/Dockerfile', import.meta.url), 'utf8')).filter((f) => f !== 'server/Dockerfile');
    assert.ok(copied.includes('server/privacy.html'));
    assert.ok(copied.includes('src/usage-schema.js'), 'the shared event contract too');
    for (const f of copied) hash.update(fs.readFileSync(new URL(`../${f}`, import.meta.url)));
    assert.equal(health.server, hash.digest('hex').slice(0, 12));
    assert.equal(health.server, SERVER_HASH);
  });
  const [row] = stored(dataDir);
  assert.equal(row.dropped.length, 20);
  assert.equal(row.droppedMore, 7, '25 extras, the bad seq and a name that is no field name');
  assert.ok(!row.dropped.includes('Jordan Sample'));
  assert.equal(row.extra0, undefined);
});

// Audit 2026-11-07, FLOW-12: a fill run's `background` (true only) and `hiddenMs` (a whole number of
// milliseconds, up to a day) are kept; anything else there is dropped and named.
test('a fill run keeps whether it ran in the background and how long its page was hidden', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [ev({ background: true, hiddenMs: 4200 }), ev({ background: 'yes', hiddenMs: -1 }), ev({ hiddenMs: 1.5 })] });
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((e) => [e.background ?? null, e.hiddenMs ?? null, (e.dropped ?? []).filter((k) => ['background', 'hiddenMs'].includes(k)).sort()]),
    [[true, 4200, []], [null, null, ['background', 'hiddenMs']], [null, null, ['hiddenMs']]]);
});

// Audit 2026-11-07, FLOW-11: a fill run or error from a lost Continue's second click keeps `retried`
// (true only); anything else there is dropped and named.
test('a Continue retry is kept on its fill_run and fill_error, true only', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [ev({ retried: true }), ev({ type: 'fill_error', error: 'continue did not take', retried: true }), ev({ retried: 'yes' })] });
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((e) => [e.type, e.retried ?? null, (e.dropped ?? []).includes('retried')]), [['fill_run', true, false], ['fill_error', true, false], ['fill_run', null, true]]);
});

// Codex on PR #47: stored events uploaded again (npm run push-logs) keep what was dropped before.
test('a re-uploaded event keeps the names an earlier server dropped', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [ev({ dropped: ['typedValue', 'Not a name'], droppedMore: 2, other: 1 }), ev({ dropped: ['how'] })] });
  });
  const [again, kept] = stored(dataDir);
  assert.deepEqual(again.dropped, ['typedValue', 'other']);
  assert.equal(again.droppedMore, 2);
  assert.deepEqual(kept.dropped, ['how']);
  assert.equal(kept.droppedMore, undefined);
});

// Audit 2026-10-08: /v1/health told anyone how many events were stored.
test('health names the server version for anyone; how many events are stored only for the admin token', async () => {
  const dataDir = tmp();
  await withServer({ dataDir, token: 'up' }, async ({ post, base }) => {
    await post({ events: [ev()] }, { authorization: 'Bearer up' });
    const anyone = await (await fetch(`${base}/v1/health`)).json();
    assert.deepEqual(anyone, { ok: true, server: SERVER_HASH, schema: SCHEMA_VERSION }, 'no admin token configured: never a count');
    const uploader = await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer up' } })).json();
    assert.equal(uploader.events, undefined, 'the token every extension carries is not enough');
  });
  await withServer({ dataDir, token: 'up', adminToken: 'admin' }, async ({ base }) => {
    assert.equal((await (await fetch(`${base}/v1/health`)).json()).events, undefined);
    const { metrics, ...admin } = await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer admin' } })).json();
    assert.deepEqual(admin, { ok: true, server: SERVER_HASH, schema: SCHEMA_VERSION, events: 1 });
    assert.ok(metrics && typeof metrics.uptimeS === 'number', 'and the counters (below)');
  });
});

// Audit 2026-11-07, SRV-11: the log was free text, and nothing counted requests, errors or refused
// events. Each line is one JSON object now, and the admin's health has the counters.
test('the log is one JSON object a line, with names and counts only, never a token or an event\'s text', async () => {
  const lines = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try {
    await withServer({ dataDir: tmp(), token: 'upload-secret-token' }, async ({ post, base }) => {
      await post({ agent: 'JC', events: [ev({ type: 'problem_report', text: 'Jane Roe at 555-0142', filled: undefined }), ev({ type: 'no_such_type_Jane' })] }, { authorization: 'Bearer upload-secret-token' });
      await post({ events: [] }, { authorization: 'Bearer wrong' });
      await fetch(`${base}/v1/events/Jane%20Roe?client=Jane`);
      await fetch(`${base}/v1/health`);
    });
  } finally { [console.log, console.error] = [log, error]; }
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.every((x) => typeof x.t === 'string' && ['info', 'error'].includes(x.level)), 'every line is JSON with a time and a level');
  assert.deepEqual(parsed.map((x) => [x.method, x.route, x.status]), [['POST', '/v1/events', 200], ['POST', '/v1/events', 401], ['GET', 'other', 404], ['GET', '/v1/health', 200]]);
  assert.deepEqual([parsed[0].agent, parsed[0].accepted, parsed[0].duplicates, parsed[0].rejected], ['JC', 1, 0, 1]);
  assert.ok(lines.every((l) => !/upload-secret-token|Jane|555-0142/.test(l)), `no token, event text or asked-for path: ${lines.join('\n')}`);
});

test('the admin\'s health counts requests by route and status, exceptions, stored, duplicate and refused events, and Luna today', async () => {
  const dataDir = tmp();
  const quiet = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  const fetchImpl = async () => new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  try {
    await withServer({ dataDir, adminToken: 'admin', openaiKey: 'sk-server', fetchImpl, freeSpace: () => 2048 * 1024 * 1024 }, async ({ post, base }) => {
      const first = ev();
      await post({ events: [first, ev({ type: 'a_made_up_type' }), ev({ type: 'another_made_up' }), ev({ type: 'a"Jane Roe' }), ev({ id: 'x' })] });
      await post({ events: [first, ev({ junk: 1 })] });
      await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
      await fetch(`${base}/v1/health`);
      const anyone = await (await fetch(`${base}/v1/health`)).json();
      assert.equal(anyone.metrics, undefined, 'the counters are TNI\'s only');
      const { metrics: m } = await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer admin' } })).json();
      assert.deepEqual(m.requests, { '/v1/events': { 200: 2 }, '/v1/luna': { 200: 1 }, '/v1/health': { 200: 2 } });
      assert.deepEqual({ ...m.events, lastStoredAt: typeof m.events.lastStoredAt }, { accepted: 2, duplicates: 1, rejected: 4, withDropped: 1, lastStoredAt: 'string' });
      assert.deepEqual(m.rejects, { 'unknown event type "…"': 3, 'event id missing or invalid': 1 }, 'by the server\'s reason, never the event\'s own words');
      assert.equal(m.exceptions, 0);
      assert.deepEqual(m.disk, { freeMB: 2048, guardMB: 500 });
      assert.deepEqual([m.luna.requests, m.luna.inputTokens, m.luna.outputTokens, m.luna.limit, m.luna.budget], [1, 10, 5, 5000, 10_000_000]);
      assert.ok(m.uptimeS >= 0 && Date.parse(m.startedAt) <= Date.now());
    });
  } finally { [console.log, console.error] = quiet; }
});

// Audit 2026-10-08: without RATER_TOKEN the server took anyone's uploads, wherever it listened.
test('without a token the server starts on loopback only', () => {
  assert.equal(startupError({ host: '127.0.0.1', token: '' }), null);
  assert.equal(startupError({ host: 'localhost', token: '' }), null);
  assert.equal(startupError({ host: '::1', token: '' }), null);
  assert.match(startupError({ host: '0.0.0.0', token: '' }), /RATER_TOKEN is not set and HOST=0\.0\.0\.0 is not loopback/);
  assert.match(startupError({ host: '::', token: '' }), /refusing to start/);
  assert.match(startupError({ host: '10.0.0.5', token: '' }), /refusing to start/);
  assert.equal(startupError({ host: '0.0.0.0', token: 'secret' }), null);
});

// The server as deployed (node server/index.mjs): its own environment, never this shell's tokens.
const SERVER = fileURLToPath(new URL('../server/index.mjs', import.meta.url));
function startServer(env, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, SERVER], { env: { PATH: process.env.PATH, DATA_DIR: tmp(), PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // The startup line names the port it took; a server that refused never prints one.
  const started = new Promise((resolve) => {
    const look = () => { const m = stdout.match(/on http:\/\/[^\s]+:(\d+)/); if (m) resolve(Number(m[1])); };
    child.stdout.on('data', look);
    exit.then(() => resolve(null));
  });
  return { child, exit, started, out: () => ({ stdout, stderr }) };
}
// A child that neither starts nor exits fails the test instead of hanging it.
async function within(promise, what, ms = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })]);
  } finally { clearTimeout(timer); }
}

test('HOST=0.0.0.0 without RATER_TOKEN refuses to start, saying why', async () => {
  const s = startServer({ HOST: '0.0.0.0' });
  try {
    const code = await within(s.exit, 'the server did not exit');
    assert.notEqual(code, 0, 'exits with an error');
    assert.match(s.out().stderr, /RATER_TOKEN is not set and HOST=0\.0\.0\.0 is not loopback: refusing to start/);
    assert.equal(s.out().stdout, '', 'never listened');
  } finally { s.child.kill(); }
});

test('loopback without RATER_TOKEN still starts and takes uploads (npm run server)', async () => {
  const s = startServer({ HOST: '127.0.0.1' });
  try {
    const port = await within(s.started, 'the server did not start');
    assert.ok(port, `started: ${JSON.stringify(s.out())}`);
    assert.match(s.out().stdout, /\(no token: loopback only\)/);
    const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [ev()] }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accepted, 1);
  } finally { s.child.kill(); }
});

test('the daily review tells whether the deployed server is this repository\'s', async () => {
  const health = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 502, json: async () => body });
  assert.equal((await checkServer('http://x', SERVER_HASH, health({ ok: true, server: SERVER_HASH }))).status, 'same');
  assert.deepEqual(await checkServer('http://x', SERVER_HASH, health({ ok: true, server: 'abc123abc123' })), { status: 'different', deployed: 'abc123abc123', local: SERVER_HASH });
  assert.equal((await checkServer('http://x', SERVER_HASH, health({ ok: true, events: 5 }))).status, 'different', 'a server from before the check names no version');
  assert.equal((await checkServer('http://x', SERVER_HASH, health({}, false))).status, 'unreachable');
  assert.equal((await checkServer('http://x', SERVER_HASH, async () => { throw new Error('ECONNREFUSED'); })).status, 'unreachable');
});

// Audit 2026-10-08, finding 7 (Contract 1): a fill's run id, rules fingerprint, settings and step
// are kept in their exact shapes; a malformed one refuses the event rather than trimming it.
test('run-identity fields are kept as sent and a malformed one refuses the event', async () => {
  const dataDir = tmp();
  const settings = { autoAdvance: true, autoFollowUps: false, autoPages: false, overwrite: true };
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ run: 'e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', rules: '0123456789ab', settings, step: 'Vehicles' }),
      ev({ type: 'fill_field', result: 'filled', run: 'e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', step: 'Vehicles', filled: undefined }),
      ev({ type: 'fill_error', error: 'stale: intake changed during the fill', run: 'e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', filled: undefined }),
      ev({ type: 'field_change', q: '1', kind: 'select', from: 'a', to: 'b', step: 'Drivers', filled: undefined }),
      ev({ run: 'short' }),
      ev({ rules: 'XYZ' }),
      ev({ settings: { autoAdvance: true } }),
      ev({ settings: { ...settings, extra: true } }),
      ev({ settings: { ...settings, overwrite: 'yes' } }),
      ev({ step: 's'.repeat(121) }),
      ev({ run: null }),
      // A field_change carries no run: dropped like any unknown field, not refused.
      ev({ type: 'field_change', q: '1', kind: 'select', from: 'a', to: 'b', run: 'short', filled: undefined }),
    ] })).json();
    assert.equal(r.accepted, 5);
    assert.deepEqual(r.rejected.map((x) => x.index), [4, 5, 6, 7, 8, 9, 10]);
    assert.match(r.rejected[0].error, /run id/);
    assert.match(r.rejected[1].error, /rules hash/);
    assert.match(r.rejected[2].error, /settings object/);
    assert.match(r.rejected[5].error, /step name/);
  });
  const rows = stored(dataDir);
  assert.deepEqual([rows[0].run, rows[0].rules, rows[0].settings, rows[0].step], ['e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', '0123456789ab', settings, 'Vehicles']);
  assert.deepEqual([rows[1].run, rows[1].step, rows[2].run, rows[3].step], ['e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', 'Vehicles', 'e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', 'Drivers']);
  assert.deepEqual([rows[4].run, rows[4].dropped], [undefined, ['run']]);
  assert.ok(!Object.values(EVENT_FIELDS).flat().includes('cached'), 'no client emitted this obsolete suggestion field');
});

// Legacy layouts explicitly wrote null for an unrecognized AmWINS step; queued/re-uploaded
// layouts retain that representation without weakening step checks on other events.
test('legacy page-layout null steps are accepted while malformed non-null and run steps are refused', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const result = await (await post({ events: [
      ev({ type: 'page_layout', step: null, fields: [] }),
      ev({ type: 'page_layout', step: 'Vehicles', fields: [] }),
      ev({ type: 'page_layout', fields: [] }),
      ev({ type: 'page_layout', step: 123, fields: [] }),
      ev({ type: 'page_layout', step: 's'.repeat(121), fields: [] }),
      ev({ step: null }),
      ev({ type: 'fill_field', step: null }),
      ev({ type: 'field_change', step: null }),
    ] })).json();
    assert.equal(result.accepted, 3);
    assert.deepEqual(result.rejected.map((x) => x.index), [3, 4, 5, 6, 7]);
    assert.ok(result.rejected.every((x) => /step name/.test(x.error)));
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((x) => x.step), [null, 'Vehicles', undefined]);
});

test('failed runs retain rule/settings identity and reject malformed metadata like successful runs', async () => {
  const dataDir = tmp();
  const settings = { autoAdvance: false, autoFollowUps: true, autoPages: false, overwrite: false };
  await withServer({ dataDir }, async ({ post }) => {
    const result = await (await post({ events: [
      ev({ type: 'fill_error', filled: undefined, run: 'failed-run-123', rules: '0123456789ab', settings, error: 'safe error' }),
      ev({ type: 'fill_error', filled: undefined, run: 'failed-run-124', rules: 'client name', settings, error: 'safe error' }),
      ev({ type: 'fill_error', filled: undefined, run: 'failed-run-125', settings: { ...settings, client: 'must not persist' }, error: 'safe error' }),
      ev({ type: 'fill_error', filled: undefined, run: 'failed-run-126', settings: { ...settings, autoAdvance: 'yes' }, error: 'safe error' }),
    ] })).json();
    assert.equal(result.accepted, 1);
    assert.deepEqual(result.rejected.map((x) => x.index), [1, 2, 3]);
  });
  assert.deepEqual([stored(dataDir)[0].rules, stored(dataDir)[0].settings, stored(dataDir)[0].dropped], ['0123456789ab', settings, undefined]);
  assert.doesNotMatch(JSON.stringify(stored(dataDir)), /client name|must not persist/);
});

test('legacy AI decision evidence survives older-client uploads and historical reuploads in its original bounded shapes', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const result = await (await post({ events: [
      ev({ type: 'ai_decision', filled: undefined, probability: 0.99, support: 0.98, evidenceProbability: 0.97, confidence: 0.96 }),
      ev({ type: 'ai_decision', filled: undefined, confidence: 'high' }),
      ev({ type: 'ai_decision', filled: undefined, probability: 0, support: null, evidenceProbability: 0, confidence: 0, dropped: ['someOtherField'] }),
      ev({ type: 'ai_decision', filled: undefined, probability: 'client name', support: { text: 'client name' }, evidenceProbability: 2, confidence: 'client name' }),
      ev({ type: 'ai_decision', filled: undefined, probability: -1, support: 1, evidenceProbability: 1, confidence: 'medium' }),
    ] })).json();
    assert.equal(result.accepted, 5);
  });
  const rows = stored(dataDir);
  assert.deepEqual(['probability', 'support', 'evidenceProbability', 'confidence'].map((k) => rows[0][k]), [0.99, 0.98, 0.97, 0.96]);
  assert.equal(rows[0].dropped, undefined);
  assert.equal(rows[1].confidence, 'high');
  assert.deepEqual(['probability', 'support', 'evidenceProbability', 'confidence'].map((k) => rows[2][k]), [0, null, 0, 0]);
  assert.deepEqual(rows[2].dropped, ['someOtherField']);
  assert.deepEqual(rows[3].dropped, ['probability', 'support', 'evidenceProbability', 'confidence']);
  assert.deepEqual([rows[4].probability, rows[4].support, rows[4].evidenceProbability, rows[4].confidence], [undefined, 1, 1, 'medium']);
  assert.doesNotMatch(JSON.stringify(rows), /client name/);
});

test('keeps a panel crash with its bounded message and extension frames only', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ type: 'client_error', filled: undefined, where: 'panel', error: 'Cannot read properties of null', stack: ['sidepanel/sidepanel.js:12:5'] }),
      ev({ type: 'client_error', filled: undefined, where: 'carrier page', error: 'x'.repeat(301), stack: ['https://carrier.example/app.js:1:1'] }),
      // The page's recorder's own exception (LEARN-10).
      ev({ type: 'client_error', filled: undefined, where: 'recorder', error: 'Cannot read properties of undefined', stack: ['src/content/recorder.js:120:9'] }),
    ] })).json();
    assert.equal(r.accepted, 3);
  });
  const [ok, bad, recorder] = stored(dataDir);
  assert.deepEqual([recorder.where, recorder.stack], ['recorder', ['src/content/recorder.js:120:9']]);
  assert.deepEqual([ok.where, ok.error, ok.stack], ['panel', 'Cannot read properties of null', ['sidepanel/sidepanel.js:12:5']]);
  assert.deepEqual([bad.where, bad.error, bad.stack], [undefined, undefined, undefined]);
  assert.deepEqual(bad.dropped.sort(), ['error', 'stack', 'where']);
});

test('a page layout keeps the page\'s messages, bounded', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'page_layout', filled: undefined, fields: [], messages: ['This field is required'] }),
      ev({ type: 'page_layout', filled: undefined, fields: [], messages: ['x'.repeat(201)] }),
    ] });
  });
  const [ok, long] = stored(dataDir);
  assert.deepEqual(ok.messages, ['This field is required']);
  assert.equal(long.messages, undefined);
  assert.deepEqual(long.dropped, ['messages']);
});

test('keeps an intake marked as a test run, and only a yes/no mark', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'intake_marked', filled: undefined, carrier: undefined, page: undefined, test: true }),
      ev({ type: 'intake_loaded', filled: undefined, carrier: undefined, page: undefined, state: 'FL', test: true }),
      ev({ type: 'intake_loaded', filled: undefined, carrier: undefined, page: undefined, state: 'FL', test: 'yes' }),
    ] });
  });
  const [marked, loaded, odd] = stored(dataDir);
  assert.equal(marked.test, true);
  assert.equal(loaded.test, true);
  assert.equal(odd.test, undefined);
  assert.deepEqual(odd.dropped, ['test']);
});

test('keeps the agent\'s settings, booleans and where usage goes only', async () => {
  const dataDir = tmp();
  const values = { autoFollowUps: true, autoAdvance: false, autoPages: false, overwrite: false, aiOn: true, aiAuto: false, aiKey: true, uploads: 'central' };
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', changed: 'autoAdvance', values }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', values: { ...values, lunaKey: 'sk-secret' } }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'whenever', values: { ...values, uploads: 'https://x' } }),
    ] });
  });
  const [ok, key, odd] = stored(dataDir);
  assert.deepEqual([ok.reason, ok.changed, ok.values], ['changed', 'autoAdvance', values]);
  assert.equal(key.values, undefined, 'a value that is not a yes/no never stays (a key)');
  assert.deepEqual(odd.dropped.sort(), ['reason', 'values']);
});

test('keeps the install id, the platform and a lost-events count, in their shapes only', async () => {
  const dataDir = tmp();
  const install = crypto.randomUUID();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'intake_loaded', filled: undefined, install, platform: { os: 'Windows', chrome: 141 } }),
      ev({ type: 'usage_lost', filled: undefined, install, count: 12 }),
      ev({ type: 'intake_loaded', filled: undefined, install: 'JOHN-PC', platform: { os: 'Windows', chrome: 141, user: 'john' } }),
    ] });
  });
  const [loaded, lost, odd] = stored(dataDir);
  assert.deepEqual([loaded.install, loaded.platform], [install, { os: 'Windows', chrome: 141 }]);
  assert.deepEqual([lost.type, lost.count], ['usage_lost', 12]);
  assert.deepEqual([odd.install, odd.platform], [undefined, undefined]);
});

// Audit 2026-11-07, LEARN-09: why an answer failed, as a code (types.js FailCode), never text.
test('keeps a failed answer\'s code in its shape only', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'fill_field', filled: undefined, result: 'failed', q: '2B9D', code: 'option.no-match', reason: 'no option matches "…"' }),
      ev({ type: 'fill_field', filled: undefined, result: 'failed', q: '2B9E', code: 'No option for John Smith' }),
    ] });
  });
  const [ok, odd] = stored(dataDir);
  assert.deepEqual([ok.code, ok.reason], ['option.no-match', 'no option matches "…"']);
  assert.deepEqual([odd.code, odd.dropped], [undefined, ['code']]);
});

test('keeps why an answer was given, and a dismissed check, in their shapes only', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'fill_field', filled: undefined, result: 'filled', q: '2CCC', source: 'standard', standard: true, review: true }),
      ev({ type: 'fill_field', filled: undefined, result: 'filled', q: '2B20', source: 'a guess', standard: 'yes' }),
      ev({ type: 'check_dismissed', filled: undefined, q: '1D97', key: '1D97', label: 'Liability', mark: 'check' }),
    ] });
  });
  const [ok, odd, dismissed] = stored(dataDir);
  assert.deepEqual([ok.source, ok.standard, ok.review], ['standard', true, true]);
  assert.deepEqual([odd.source, odd.standard], [undefined, undefined]);
  assert.deepEqual([dismissed.type, dismissed.label, dismissed.mark], ['check_dismissed', 'Liability', 'check']);
});

// agent defaults (server/agent-defaults.mjs; docs/agent-defaults-spec.md): the server keeps them
// before any build sends them, so the first build that does loses nothing.
test('keeps an agent default\'s answer source, the agent\'s defaults and their fingerprint, in their shapes only', async () => {
  const dataDir = tmp();
  const defaults = [{ id: 'medPay', value: 1000 }, { id: 'umCsl', value: 300000, carrier: 'geico' }, { id: 'hazmat', value: 'ask' }, { id: 'umType', value: 'Add-On', carrier: 'geico' }];
  let r;
  await withServer({ dataDir }, async ({ post }) => {
    r = await (await post({ events: [
      ev({ type: 'fill_field', filled: undefined, result: 'filled', q: '1FE4', source: 'agent-default' }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', changed: 'defaults', defaults }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', defaults: [{ id: 'medPay', value: 1000, client: 'Ann' }] }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', defaults: [{ id: 'medPay', value: 'x'.repeat(41) }] }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', defaults: { medPay: 1000 } }),
      ev({ type: 'agent_settings', filled: undefined, reason: 'changed', defaults: Array.from({ length: 41 }, () => ({ id: 'medPay', value: 1000 })) }),
      ev({ defaultsHash: '0123456789ab' }),
      ev({ type: 'fill_error', filled: undefined, error: 'x', defaultsHash: '0123456789ab' }),
      ev({ defaultsHash: 'not a hash' }),
    ] })).json();
  });
  assert.equal(r.accepted, 8);
  assert.deepEqual(r.rejected.map((x) => x.index), [8], 'a malformed fingerprint refuses the event, like the rules\'');
  const [field, settings, extraKey, longValue, notList, tooMany, run, error] = stored(dataDir);
  assert.equal(field.source, 'agent-default');
  assert.deepEqual([settings.changed, settings.defaults], ['defaults', defaults]);
  for (const odd of [extraKey, longValue, notList, tooMany]) {
    assert.equal(odd.defaults, undefined);
    assert.deepEqual(odd.dropped, ['defaults']);
  }
  assert.deepEqual([run.defaultsHash, error.defaultsHash], ['0123456789ab', '0123456789ab']);
});

test('a problem report keeps the fill it is about, in its shapes', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'problem_report', filled: undefined, text: 'stuck on Rates', view: 't1', run: 'run-1234-abcd', blockerList: ['button: recalculate'], since: 90 }),
      ev({ type: 'problem_report', filled: undefined, text: 'x', blockerList: 'oops', since: -1 }),
      // Audit 2026-11-07, SRV-04: at most the panel's 1,000 characters, and text only.
      ev({ type: 'problem_report', filled: undefined, text: 'y'.repeat(1000) }),
      ev({ type: 'problem_report', filled: undefined, text: 'z'.repeat(1001) }),
      ev({ type: 'problem_report', filled: undefined, text: { say: 'x' } }),
    ] });
  });
  const [ok, odd, longest, tooLong, notText] = stored(dataDir);
  assert.deepEqual([ok.view, ok.run, ok.blockerList, ok.since], ['t1', 'run-1234-abcd', ['button: recalculate'], 90]);
  assert.deepEqual([odd.blockerList, odd.since], [undefined, undefined]);
  assert.equal(longest.text.length, 1000);
  for (const e of [tooLong, notText]) assert.deepEqual([e.text, e.dropped], [undefined, ['text']]);
});

test('keeps a button the agent clicked: its text, bounded', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'agent_click', filled: undefined, page: 'CoveragesRates', view: 't1', text: 'Recalculate' }),
      ev({ type: 'agent_click', filled: undefined, page: 'CoveragesRates', text: 'x'.repeat(61) }),
    ] });
  });
  const [ok, long] = stored(dataDir);
  assert.deepEqual([ok.type, ok.text, ok.view], ['agent_click', 'Recalculate', 't1']);
  assert.equal(long.text, undefined);
});

// A synthetic business profile, as src/usage.js intakeProfile builds it.
const profile = () => ({
  business: { state: 'TX', businessClass: 'Freight Hauler', dot: 'given', mc: 'blank', fein: 'given', dotWithin60Days: null, yearsInBusiness: 4, yearsExperience: 6, ownerDrives: true },
  operations: { whatHaul: 'General freight', radiusMiles: 500, vehicleOwnership: 'Owned', personalUse: false, usesEld: true, eldBrand: 'Motive', needSr22: false,
    filingsRequired: true, filingsWhich: 'MCS-90', hazmat: false, hazPlacard: null, movingState: false, teamDriving: null, canadaLoads: false, equipVehicle: null },
  vehicles: [{ type: 'Semi Truck', year: 2019, make: 'Freightliner', model: 'Cascadia', value: 65000 }],
  trailers: [{ type: 'Dry Van', year: 2016, make: 'Great Dane', model: null, value: 25000 }],
  trailerInfo: { ownership: 'Owned', hitch: null, interchange: false, interchangeLimit: null, equipTrailer: null },
  drivers: [{ age: 41, licenseState: 'TX', cdl: true, cdlYear: 2010, excluded: false, maritalStatus: 'Married', gender: null }],
  coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, hasGl: null, glLimit: null, reeferBreakdown: false, ntl: null },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Progressive', limit: '$1M CSL', expires: '2026-11' }],
  hasClaims: false,
});
const profileEvent = (over = {}) => ev({ type: 'intake_profile', filled: undefined, carrier: undefined, page: undefined, ...profile(), ...over });

test('keeps a business profile as sent when every value is in its shape', async () => {
  const dataDir = tmp();
  const sent = profileEvent();
  await withServer({ dataDir }, async ({ post }) => {
    assert.equal((await (await post({ events: [sent] })).json()).accepted, 1);
  });
  const [kept] = stored(dataDir);
  for (const group of EVENT_FIELDS.intake_profile) assert.deepEqual(kept[group], sent[group], group);
  assert.equal(kept.dropped, undefined);
  assert.deepEqual(EVENT_FIELDS.intake_profile, Object.keys(PROFILE), 'the event keeps the profile\'s groups, no more');
});

test('a profile value out of its shape, or one that identifies the client, is left out and its group named', async () => {
  const dataDir = tmp();
  const p = profile();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [profileEvent({
      business: { ...p.business, dot: '1234567', constructor: 'x' },
      operations: { ...p.operations, whatHaul: 'call owner@example.com', eldBrand: 'x'.repeat(61) },
      vehicles: [{ ...p.vehicles[0], vin: '1FUJGLDR0CLBP8834', make: 'Freightliner 1FUJGLDR0CLBP8834' }],
      trailers: { type: 'Dry Van' },
      drivers: [{ ...p.drivers[0], dob: '01/02/1980', gender: 'M', age: 41.5 }],
      coverage: { ...p.coverage, cargoLimit: 1500.5 },
      priorInsurance: [{ ...p.priorInsurance[0], expires: '11/30/2026' }],
      hasClaims: 'yes',
      name: 'Sample Trucking LLC',
    })] });
  });
  const [kept] = stored(dataDir);
  assert.equal(kept.business.dot, undefined, 'a number in place of given/blank');
  assert.equal(kept.business.constructor, Object, 'a key the profile has no shape for is left out');
  assert.equal(kept.business.mc, 'blank');
  assert.equal(kept.operations.whatHaul, undefined, 'an email address');
  assert.equal(kept.operations.eldBrand, undefined, 'too long');
  assert.equal(kept.operations.radiusMiles, 500);
  assert.deepEqual(kept.vehicles, [{ type: 'Semi Truck', year: 2019, model: 'Cascadia', value: 65000 }], 'no VIN, in its own key or in a make');
  assert.equal(kept.trailers, undefined, 'a list sent as an object goes whole');
  assert.deepEqual(kept.drivers, [{ licenseState: 'TX', cdl: true, cdlYear: 2010, excluded: false, maritalStatus: 'Married' }]);
  assert.equal(kept.coverage.cargoLimit, undefined, 'dollars are whole');
  assert.equal(kept.priorInsurance[0].expires, undefined, 'a month, never a date');
  assert.equal(kept.hasClaims, undefined);
  assert.equal(kept.name, undefined);
  assert.deepEqual(kept.dropped.sort(), ['business', 'coverage', 'drivers', 'hasClaims', 'name', 'operations', 'priorInsurance', 'trailers', 'vehicles']);
});

test('a profile keeps at most 50 vehicles, trailers or drivers', async () => {
  const dataDir = tmp();
  const p = profile();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [profileEvent({ drivers: Array(51).fill(p.drivers[0]), vehicles: Array(50).fill(p.vehicles[0]) })] });
  });
  const [kept] = stored(dataDir);
  assert.equal(kept.drivers, undefined);
  assert.equal(kept.vehicles.length, 50);
  assert.deepEqual(kept.dropped, ['drivers']);
});

test('profile text with a phone, SSN, date of birth, licence or policy number written with punctuation is left out; limits as written are kept', async () => {
  const dataDir = tmp();
  const p = profile();
  const ids = ['call 312-555-0142', '(312) 555-0142', 'SSN 123-45-6789', 'born 01-05-1980', 'born 01.05.1980', 'licence S123-4567-8901', 'policy CA-0193-4471'];
  const limits = ['$1M CSL', '$1,000,000', '1000000', '$1000000 CSL', '$1M/$2M', '25/50/25', '100/300/100', 'State Minimum'];
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ...ids.map((whatHaul) => profileEvent({ operations: { ...p.operations, whatHaul } })),
      ...limits.map((l) => profileEvent({ coverage: { ...p.coverage, autoLiabLimit: l, glLimit: l }, priorInsurance: [{ ...p.priorInsurance[0], limit: l }] })),
      profileEvent({ coverage: { ...p.coverage, autoLiabLimit: 'SSN 123 45 6789' } }),
      profileEvent({ priorInsurance: [{ ...p.priorInsurance[0], limit: '123-45-6789' }], business: { ...p.business, dot: 'other', mc: 'other', fein: 'blank' } }),
    ] });
  });
  const kept = stored(dataDir);
  for (const [i, id] of ids.entries()) {
    assert.equal(kept[i].operations.whatHaul, undefined, id);
    assert.deepEqual(kept[i].dropped, ['operations'], id);
  }
  for (const [i, l] of limits.entries()) {
    const e = kept[ids.length + i];
    assert.deepEqual([e.coverage.autoLiabLimit, e.coverage.glLimit, e.priorInsurance[0].limit, e.dropped], [l, l, l, undefined], l);
  }
  const spaced = kept.at(-2);
  assert.deepEqual([spaced.coverage.autoLiabLimit, spaced.dropped], [undefined, ['coverage']], 'an SSN written with spaces is no limit');
  const last = kept.at(-1);
  assert.equal(last.priorInsurance[0].limit, undefined, 'an SSN is no limit');
  assert.deepEqual([last.business.dot, last.business.mc, last.business.fein], ['other', 'other', 'blank'], 'something other than a number is said as such');
});

// The premium a carrier page quoted (src/premium.js): amounts, term and payments, nothing else.
test('a quoted premium is kept in its shape; anything else in it is dropped', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ filled: undefined, type: 'quote_premium', carrier: 'geico', page: 'quote', step: 'Quote & Coverages', total: 101287, termMonths: 12, dueToday: 16908.71, payments: 10, payment: 8437.83 }),
      ev({ filled: undefined, type: 'quote_premium', carrier: 'progressive', page: 'CoveragesRates', total: 12815, termMonths: 120, dueToday: -1, payments: 1.5, payment: null, insured: 'Sample Co' }),
      // No total: refused, so the loss is counted.
      ev({ filled: undefined, type: 'quote_premium', carrier: 'progressive', page: 'CoveragesRates', total: '12,815' }),
    ] })).json();
    assert.deepEqual(r.rejected, [{ index: 2, error: 'quote_premium needs a total' }]);
  });
  const [geico, odd, ...more] = stored(dataDir);
  assert.equal(more.length, 0);
  assert.deepEqual([geico.total, geico.termMonths, geico.dueToday, geico.payments, geico.payment, geico.dropped], [101287, 12, 16908.71, 10, 8437.83, undefined]);
  assert.equal(odd.total, 12815);
  for (const k of ['termMonths', 'dueToday', 'payments', 'insured']) assert.equal(odd[k], undefined, k);
  assert.deepEqual([...odd.dropped].sort(), ['dueToday', 'insured', 'payments', 'termMonths']);
});

// A real panel request (src/ai/luna.js), so the server's check can't drift from what Luna sends.
const lunaBody = () => buildRequest(collectItems([{ unknown: [{ key: 'haz', label: 'Hazardous materials requiring placards?', controlKind: 'select', options: ['Yes', 'No'], current: '' }] }]).items,
  { carrier: 'geico', page: 'operations', active: { drivers: 0, vehicles: 0 }, record: { operations: {}, drivers: [], vehicles: [] } });

test('/v1/luna adds the server\'s OpenAI key to a Luna request and returns the answer, nothing stored', async () => {
  const dataDir = tmp();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ status: 'completed', model: 'gpt-6-luna', output: [] }), { status: 200 }); };
  await withServer({ dataDir, token: 'upload', openaiKey: 'sk-server', openaiUrl: 'https://openai.test/v1/responses', fetchImpl }, async ({ base }) => {
    const luna = (body, token = 'upload') => fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const body = lunaBody();
    const r = await luna(body);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).model, 'gpt-6-luna');
    assert.deepEqual(sent, [{ url: 'https://openai.test/v1/responses', auth: 'Bearer sk-server', body }]);
    assert.equal((await luna(body, 'wrong')).status, 401, 'the upload token is required');
    for (const bad of [{ ...body, model: 'gpt-5' }, { ...body, tools: [] }, { ...body, store: true }, { ...body, max_output_tokens: 100_000 },
      { ...body, input: [...body.input, { role: 'user', content: 'more' }] }, { ...body, instructions: 'x'.repeat(LUNA_MAX_CHARS) }]) {
      assert.equal((await luna(bad)).status, 400, JSON.stringify(Object.keys(bad)));
    }
    assert.equal(sent.length, 1, 'nothing else reached OpenAI');
  });
  assert.equal(fs.readdirSync(path.join(dataDir, 'events')).length, 0);
});

test('/v1/luna: 501 without a key, a daily limit, and OpenAI refusing the server\'s key is 424 without its body', async () => {
  await withServer({ dataDir: tmp() }, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) })).status, 501);
  });
  let status = 200;
  const fetchImpl = async () => new Response(status === 200 ? '{"status":"completed"}' : '{"error":"echoed-private-input"}', { status });
  await withServer({ dataDir: tmp(), openaiKey: 'sk-server', lunaDailyLimit: 2, fetchImpl }, async ({ base }) => {
    const luna = () => fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
    status = 401;
    const refused = await luna();
    assert.equal(refused.status, 424);
    assert.doesNotMatch(await refused.text(), /private/);
    status = 200;
    assert.equal((await luna()).status, 200);
    const limited = await luna();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '3600');
  });
  assert.equal(lunaRequestError(lunaBody()), null);
});

// Audit 2026-11-07, AI-09: the server gives up on OpenAI well before the panel gives up on it, so the
// panel gets the server's 504 instead of leaving a call that is still paid for.
test("the server's wait for OpenAI ends at least 5 s before the panel's", () => {
  assert.ok(LUNA_TIMEOUT_MS + 5000 <= TIMEOUT_MS, `${LUNA_TIMEOUT_MS} vs ${TIMEOUT_MS}`);
});

// CodeRabbit on #416: OpenAI's headers in time, its body still coming when the wait ends, is a 504
// too (the panel says "The AI assistant took too long"), not an unreadable answer or OpenAI's own status.
test('/v1/luna: a body still being read when the wait ends is a 504, an answer or an error alike', async () => {
  for (const [ok, status] of [[true, 200], [false, 500]]) {
    const fetchImpl = async (url, init) => ({ ok, status, headers: new Headers(),
      json: () => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    await withServer({ dataDir: tmp(), openaiKey: 'sk-server', lunaTimeoutMs: 50, fetchImpl }, async ({ base }) => {
      const res = await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
      assert.equal(res.status, 504, `OpenAI ${status}`);
      assert.deepEqual(await res.json(), { error: 'OpenAI did not answer' });
    });
  }
});

// Audit 2026-11-07, AI-01: the server's bound is above the panel's, so the largest request the panel
// may send passes both the check and the body limit; one over the server's own bound is refused.
test('/v1/luna takes the largest request the panel may send', async () => {
  assert.ok(LUNA_MAX_CHARS > MAX_REQUEST_CHARS);
  const body = lunaBody(), pad = (n) => ({ ...body, instructions: body.instructions + 'x'.repeat(n - JSON.stringify(body).length) });
  const largest = pad(MAX_REQUEST_CHARS), over = pad(LUNA_MAX_CHARS + 1);
  assert.equal(JSON.stringify(largest).length, MAX_REQUEST_CHARS);
  assert.equal(lunaRequestError(largest), null);
  assert.equal(lunaRequestError(over), 'request too large');
  // In three-byte characters, the largest request is more bytes than twice the bound (CodeRabbit on #357).
  const bare = { ...body, input: [{ role: 'user', content: '' }] };
  const wide = { ...bare, input: [{ role: 'user', content: '€'.repeat(MAX_REQUEST_CHARS - JSON.stringify(bare).length) }] };
  assert.equal(JSON.stringify(wide).length, MAX_REQUEST_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) > 2 * LUNA_MAX_CHARS);
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(init.body.length); return new Response('{"status":"completed"}', { status: 200 }); };
  await withServer({ dataDir: tmp(), openaiKey: 'sk-server', fetchImpl }, async ({ base }) => {
    const luna = (b) => fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await luna(largest)).status, 200);
    assert.equal((await luna(wide)).status, 200);
    assert.equal((await luna(over)).status, 400);
  });
  assert.deepEqual(sent, [MAX_REQUEST_CHARS, MAX_REQUEST_CHARS]);
});

// Review of PR 179: RATER_LUNA_DAILY_LIMIT=0 started the server with the default 3000 a day
// (`Number(v) || 3000`), so a limit set to 0 to stop the spending didn't. Unset or blank is the
// default (5000 since the maintainer raised it, 2026-10-26); a whole number is the limit, 0 stopping every request; anything else spends nothing.
test('RATER_LUNA_DAILY_LIMIT: 0 stops Luna requests, a mistyped value spends nothing, blank is the default', async () => {
  const startup = async (limit, tokens) => {
    const s = startServer({ HOST: '127.0.0.1', OPENAI_API_KEY: 'sk-synthetic', ...(limit == null ? {} : { RATER_LUNA_DAILY_LIMIT: limit }),
      ...(tokens == null ? {} : { RATER_LUNA_DAILY_TOKENS: tokens }) });
    try {
      const port = await within(s.started, 'the server did not start');
      assert.ok(port, `started: ${JSON.stringify(s.out())}`);
      return s.out().stdout.match(/\(Luna on, ([^)]*)\)/)?.[1] ?? null;
    } finally { s.child.kill(); }
  };
  const said = (requests, tokens = 10_000_000) => `${requests} requests and ${tokens} tokens a day`;
  assert.equal(await startup('0'), said(0));
  assert.equal(await startup('abc'), said(0));
  assert.equal(await startup('-5'), said(0));
  assert.equal(await startup('25'), said(25));
  assert.equal(await startup(' '), said(5000));
  assert.equal(await startup(null), said(5000));
  // The token budget reads the same way (audit 2026-11-07, SRV-12).
  assert.equal(await startup(null, '2000000'), said(5000, 2_000_000));
  assert.equal(await startup(null, 'lots'), said(5000, 0));
  assert.equal(await startup(null, ''), said(5000));
  assert.equal(lunaDailyTokensFrom(undefined), LUNA_DAILY_TOKENS);
  assert.equal(lunaDailyTokensFrom('0'), 0);
  // A limit of 0 refuses every request before OpenAI is asked.
  await withServer({ dataDir: tmp(), openaiKey: 'sk-server', lunaDailyLimit: 0, fetchImpl: async () => { throw new Error('OpenAI was asked'); } }, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) })).status, 429);
  });
});

// Audit 2026-11-07, SRV-12: the day's Luna count was in memory, so a restart started it again, and
// it counted requests only. It is kept on the volume now, with the tokens OpenAI says each used.
const askLuna = (base) => fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
const lunaUsage = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'luna', `${new Date().toISOString().slice(0, 10)}.json`), 'utf8'));

test('/v1/luna: the day\'s requests and tokens survive a restart, and the limit holds across it', async () => {
  const dataDir = tmp();
  const answer = { status: 'completed', output: [], usage: { input_tokens: 3100, output_tokens: 350, output_tokens_details: { reasoning_tokens: 200 } } };
  const fetchImpl = async () => new Response(JSON.stringify(answer), { status: 200 });
  const opts = { dataDir, openaiKey: 'sk-server', lunaDailyLimit: 3, fetchImpl };
  await withServer(opts, async ({ base }) => {
    for (let i = 0; i < 2; i++) assert.equal((await askLuna(base)).status, 200);
  });
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(lunaUsage(dataDir), { day, requests: 2, inputTokens: 6200, outputTokens: 700, estimated: 0 });
  assert.ok(!JSON.stringify(lunaUsage(dataDir)).includes('completed'), 'counts only, never the answer');
  // A restart (or a redeploy on the same volume) goes on from the day's count.
  await withServer(opts, async ({ base }) => {
    assert.equal((await askLuna(base)).status, 200);
    const limited = await askLuna(base);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'daily Luna limit reached' });
  });
  assert.equal(lunaUsage(dataDir).requests, 3);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'luna')), [`${day}.json`], 'no temporary file left');
});

test('/v1/luna: a daily token budget refuses requests once the day\'s tokens reach it; an answer without usage counts at its most', async () => {
  const dataDir = tmp();
  let usage = { input_tokens: 4000, output_tokens: 1000 };
  const asked = [];
  const fetchImpl = async () => { asked.push(1); return new Response(JSON.stringify({ status: 'completed', output: [], ...(usage ? { usage } : {}) }), { status: 200 }); };
  await withServer({ dataDir, openaiKey: 'sk-server', lunaDailyTokens: 9000, fetchImpl }, async ({ base }) => {
    assert.equal((await askLuna(base)).status, 200);
    usage = { input_tokens: 'many', output_tokens: -1 };
    assert.equal((await askLuna(base)).status, 200, 'below the budget when it started');
    const body = lunaBody();
    // At its most (CodeRabbit on #375): a token is at least one byte of the request as sent, plus the
    // message framing; a token per 4 characters undercounted text in other scripts and punctuation.
    assert.deepEqual(lunaUsage(dataDir), { day: lunaUsage(dataDir).day, requests: 2, inputTokens: 4000 + Buffer.byteLength(JSON.stringify(body)) + 64,
      outputTokens: 1000 + body.max_output_tokens, estimated: 1 });
    const refused = await askLuna(base);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '3600');
    assert.deepEqual(await refused.json(), { error: 'daily Luna token budget reached' });
    assert.equal(asked.length, 2, 'OpenAI was not asked once the budget was spent');
  });
  // Text that takes more than a byte a character (Turkish, punctuation-dense JSON) counts by its bytes.
  const wide = tmp();
  const body = { ...lunaBody(), instructions: `${lunaBody().instructions} ${'şğü…'.repeat(500)}` };
  await withServer({ dataDir: wide, openaiKey: 'sk-server', fetchImpl: async () => new Response('{"output":[]}', { status: 200 }) }, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 200);
  });
  assert.equal(lunaUsage(wide).inputTokens, Buffer.byteLength(JSON.stringify(body)) + 64);
  assert.ok(lunaUsage(wide).inputTokens > JSON.stringify(body).length);
});

test('/v1/luna: a day file that cannot be read or written is logged and the count goes on in memory', async () => {
  const dataDir = tmp();
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dataDir, 'luna'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'luna', `${day}.json`), '{"requests": 4');
  const logged = [];
  const error = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    const fetchImpl = async () => new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    await withServer({ dataDir, openaiKey: 'sk-server', lunaDailyLimit: 1, fetchImpl }, async ({ base }) => {
      assert.equal((await askLuna(base)).status, 200);
      assert.equal((await askLuna(base)).status, 429);
    });
    assert.equal(lunaUsage(dataDir).requests, 1, 'written whole again');
    // A volume that can't be written: Luna still answers, within the limit kept in memory.
    const blocked = tmp();
    fs.writeFileSync(path.join(blocked, 'luna'), 'a file where the folder goes');
    await withServer({ dataDir: blocked, openaiKey: 'sk-server', lunaDailyLimit: 1, fetchImpl }, async ({ base }) => {
      assert.equal((await askLuna(base)).status, 200);
      assert.equal((await askLuna(base)).status, 429);
    });
  } finally { console.error = error; }
  assert.ok(logged.some((l) => /Luna usage for \d{4}-\d{2}-\d{2} unreadable \(SyntaxError\): counting from 0/.test(l)));
  assert.ok(logged.some((l) => /Luna usage not saved/.test(l)));
});

// Review of PR 179: OpenAI answers 429 insufficient_quota when TNI's project is out of credit or
// over its budget. Passed on as 429, the panel retried it twice and said to try again shortly, and
// the log said only "luna upstream 429". It is the server's key that can't be used, as a refused
// key is: 424 (the panel says to tell TNI), still without OpenAI's body. A rate limit stays a 429.
test('/v1/luna: OpenAI out of quota for the server\'s key is 424, a rate limit stays 429, neither with its body', async () => {
  let reply;
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: reply.code, message: 'echoed-private-input' } }), { status: 429, headers: reply.retry ? { 'retry-after': reply.retry } : {} });
  await withServer({ dataDir: tmp(), openaiKey: 'sk-server', fetchImpl }, async ({ base }) => {
    const luna = () => fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
    reply = { code: 'insufficient_quota' };
    const out = await luna();
    assert.equal(out.status, 424);
    assert.doesNotMatch(await out.text(), /private/);
    reply = { code: 'rate_limit_exceeded', retry: '2' };
    const limited = await luna();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '2');
    assert.doesNotMatch(await limited.text(), /private/);
  });
});

// Audit 2026-11-07, SRV-01: one request took the whole server down. A malformed request target
// (no token needed) threw from new URL before any check; an event typed as an Object.prototype
// member (constructor, __proto__) read an inherited function as its field list and threw in the
// upload's 'end' handler. Each is a 4xx now, and the server keeps serving.
const raw = (base, text) => new Promise((resolve, reject) => {
  const socket = net.connect(Number(new URL(base).port), '127.0.0.1', () => socket.write(text));
  let got = '';
  socket.on('data', (c) => { got += c; });
  socket.on('close', () => resolve(got));
  socket.on('error', reject);
  socket.setTimeout(5000, () => socket.destroy());
});
// A crashed request never answers: the test fails in time instead of hanging.
const crashTest = { timeout: 15000 };
const healthy = async (base) => assert.equal((await fetch(`${base}/v1/health`)).status, 200, 'the server still answers');

test('a malformed request target is a 400 before any check, and the server keeps serving', crashTest, async () => {
  await withServer({ dataDir: tmp(), token: 'upload' }, async ({ base }) => {
    const reply = await raw(base, 'GET http://[::1/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 400 /);
    await healthy(base);
  });
});

test('an event typed as an Object.prototype member is refused as unknown, not a crash', crashTest, async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ base, post }) => {
    const types = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
    const res = await post({ events: [...types.map((type) => ev({ type })), ev()] });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.accepted, 1, 'the good event in the same upload is still stored');
    assert.deepEqual(r.rejected.map((x) => x.error), types.map((t) => `unknown event type "${t}"`));
    await healthy(base);
  });
  assert.equal(stored(dataDir).length, 1);
});

test('an exception inside one request is a 500, logged by name, and the server keeps serving', crashTest, async () => {
  const logged = [];
  const error = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    // A throw in the listener itself: the dashboard reads the clock outside its own try.
    const dashboardToken = 'd'.repeat(32);
    await withServer({ dataDir: tmp(), dashboardToken, clock: () => { throw new RangeError('clock broke'); } }, async ({ base }) => {
      const res = await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${dashboardToken}` } });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'server error' });
      await healthy(base);
    });
    // A rejection after the body arrived (Luna's async path): an upstream answer without headers.
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await withServer({ dataDir: tmp(), openaiKey: 'sk-server', fetchImpl }, async ({ base }) => {
      const res = await fetch(`${base}/v1/luna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lunaBody()) });
      assert.equal(res.status, 500);
      await healthy(base);
    });
  } finally { console.error = error; }
  assert.ok(logged.some((l) => /RangeError/.test(l)), 'the error is logged by name');
  assert.ok(logged.some((l) => /TypeError/.test(l)));
  assert.ok(logged.every((l) => !/clock broke/.test(l)), 'not its message');
});

// SRV-11 review: the 500 an exception answers is an answer like any other, counted by route and
// status and logged with them; where it was thrown is its frames, never a message's later lines.
test('an exception\'s 500 is counted and logged with its status and time, by frames only', crashTest, async () => {
  const logged = [];
  const error = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  const dashboardToken = 'd'.repeat(32);
  let broken = true;
  // A message line that reads like a frame ("at …") is still the message.
  const clock = () => { if (broken) throw new RangeError('clock broke\nsecond line of the message\n    at Jane Roe 555-0142'); return Date.now(); };
  try {
    await withServer({ dataDir: tmp(), dashboardToken, adminToken: 'admin', clock }, async ({ base }) => {
      assert.equal((await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${dashboardToken}` } })).status, 500);
      broken = false;
      const { metrics: m } = await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer admin' } })).json();
      assert.deepEqual(m.requests['/dashboard'], { 500: 1 });
      assert.equal(m.exceptions, 1);
    });
  } finally { console.error = error; }
  const failure = logged.map((l) => JSON.parse(l)).find((x) => x.msg === 'request failed');
  assert.deepEqual([failure.level, failure.method, failure.route, failure.status, typeof failure.ms, failure.error], ['error', 'GET', '/dashboard', 500, 'number', 'RangeError']);
  assert.match(failure.where, /^at /);
  assert.ok(logged.every((l) => !/clock broke|second line|Jane|555-0142/.test(l)), `no line of the message: ${logged.join('\n')}`);
});

test('an uncaught exception exits non-zero with its name and frames, never its message', crashTest, async () => {
  // The message comes from the environment, so the frame naming this preload doesn't quote it.
  const throwLater = 'setTimeout(() => { throw new SyntaxError(process.env.THROWN); }, 1500);';
  const s = startServer({ HOST: '127.0.0.1', THROWN: 'Unexpected token in "Jane Roe 555-0142"\nsecond line Jane\n    at Jane Roe (555-0142)' },
    ['--import', `data:text/javascript,${encodeURIComponent(throwLater)}`]);
  try {
    assert.ok(await within(s.started, 'the server did not start'));
    assert.notEqual(await within(s.exit, 'the server did not exit'), 0);
  } finally { s.child.kill(); }
  const { stdout, stderr } = s.out();
  const line = stderr.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.msg === 'uncaughtException');
  assert.equal(line.error, 'SyntaxError');
  assert.match(line.stack, /^at /, 'where it was thrown');
  assert.ok(!/Jane|555-0142/.test(stdout + stderr), `no message in the log: ${stderr}`);
});

// Audit 2026-11-07, SRV-13: the upload token ships in the extension, so anyone could fill the
// volume. Uploads are limited per address (requests and bytes), and stop while the disk is low.
test('uploads from one address over its limit are refused with 429 and retry-after, nothing stored; another address has its own', async () => {
  const dataDir = tmp();
  let now = 1_000_000;
  const uploadLimits = { requests: { size: 3, perMinute: 60 }, bytes: { size: 10 * 1024 * 1024, perMinute: 60 } };
  await withServer({ dataDir, uploadLimits, clock: () => now, clientIpHeader: 'X-Real-IP' }, async ({ post }) => {
    const from = (ip) => ({ 'x-real-ip': ip });
    for (let i = 0; i < 3; i++) assert.equal((await post({ events: [ev()] }, from('203.0.113.7'))).status, 200);
    const refused = await post({ events: [ev({ page: 'refused' })] }, from('203.0.113.7'));
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '1');
    assert.match((await refused.json()).error, /too many uploads/);
    assert.equal((await post({ events: [ev()] }, from('198.51.100.2'))).status, 200, 'another address is not held back');
    now += 1000;
    assert.equal((await post({ events: [ev()] }, from('203.0.113.7'))).status, 200, 'a second later the bucket has one more');
  });
  const rows = stored(dataDir);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((e) => e.page !== 'refused'));
});

test('uploads over an address\'s byte allowance are refused with 429 and stored once allowed', async () => {
  const dataDir = tmp();
  let now = 1_000_000;
  // 6,000 bytes at most, 6,000 a minute: 100 a second.
  const uploadLimits = { requests: { size: 100, perMinute: 6000 }, bytes: { size: 6000, perMinute: 6000 } };
  await withServer({ dataDir, uploadLimits, clock: () => now }, async ({ post }) => {
    const big = () => ({ events: [ev({ type: 'page_layout', fields: [{ label: 'x'.repeat(4000) }] })] });
    assert.equal((await post(big())).status, 200);
    const refused = await post(big());
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /bytes/);
    assert.ok(Number(refused.headers.get('retry-after')) >= 20, 'the wait covers the bytes missing');
    now += 60_000;
    assert.equal((await post(big())).status, 200);
  });
  assert.equal(stored(dataDir).length, 2);
});

test('the default upload limits let a full queue drain at once, well above what the pilot sent', async () => {
  // The panel sends at most 500 events and a million characters a request (sidepanel/usage-log.js
  // BATCH, BATCH_CHARS), and keeps at most MAX_EVENTS: a full queue is 40 requests back to back.
  const requests = Math.ceil(MAX_EVENTS / 500);
  assert.ok(UPLOAD_LIMITS.requests.size >= requests);
  // The pilot's busiest minute was 9 requests and 4.8 MB, its busiest day 8.3 MB (all agents).
  assert.ok(UPLOAD_LIMITS.requests.perMinute >= 6 * 9);
  assert.ok(UPLOAD_LIMITS.bytes.size >= 10 * 4.8 * 1024 * 1024);
  assert.ok(UPLOAD_LIMITS.bytes.perMinute * 60 * 24 >= 50 * 8.3 * 1024 * 1024);
  await withServer({ dataDir: tmp() }, async ({ post }) => {
    for (let i = 0; i < requests; i++) assert.equal((await post({ events: [ev()] })).status, 200, `request ${i + 1}`);
  });
});

test('uploads stop with 507 while the disk is low, logged once when it starts and when it ends', async () => {
  const dataDir = tmp();
  let free = 400 * 1024 * 1024;
  const logged = [];
  const [error, log] = [console.error, console.log];
  console.error = (...a) => { logged.push(a.join(' ')); };
  console.log = (...a) => { logged.push(a.join(' ')); };
  try {
    await withServer({ dataDir, minFreeBytes: minFreeBytesFrom(''), freeSpace: () => free }, async ({ post, base }) => {
      for (let i = 0; i < 2; i++) {
        const res = await post({ events: [ev({ page: 'refused' })] });
        assert.equal(res.status, 507);
        assert.match((await res.json()).error, /out of space/);
      }
      assert.equal(logged.filter((l) => /DISK LOW/.test(l)).length, 1, 'said once, not per upload');
      assert.match(logged.find((l) => /DISK LOW/.test(l)), /400 MB, the guard 500 MB/);
      await healthy(base);
      free = 2 * 1024 * 1024 * 1024;
      assert.equal((await post({ events: [ev()] })).status, 200);
      assert.equal(logged.filter((l) => /disk ok again/.test(l)).length, 1);
    });
    // A reading that fails never stops uploads.
    await withServer({ dataDir, freeSpace: () => { throw new Error('ENOSYS'); } }, async ({ post }) => {
      assert.equal((await post({ events: [ev()] })).status, 200);
      assert.equal((await post({ events: [ev()] })).status, 200);
    });
  } finally { [console.error, console.log] = [error, log]; }
  assert.equal(logged.filter((l) => /unreadable/.test(l)).length, 1);
  assert.equal(stored(dataDir).length, 3);
  assert.ok(stored(dataDir).every((e) => e.page !== 'refused'));
});

test('RATER_MIN_FREE_MB: blank is 500 MB, 0 switches the guard off, a mistyped value keeps the default', async () => {
  const MB = 1024 * 1024;
  assert.equal(minFreeBytesFrom(undefined), 500 * MB);
  assert.equal(minFreeBytesFrom(' '), 500 * MB);
  assert.equal(minFreeBytesFrom('1000'), 1000 * MB);
  assert.equal(minFreeBytesFrom('0'), 0);
  assert.equal(minFreeBytesFrom('lots'), 500 * MB);
  assert.equal(minFreeBytesFrom('-5'), 500 * MB);
  await withServer({ dataDir: tmp(), minFreeBytes: 0, freeSpace: () => 0 }, async ({ post }) => {
    assert.equal((await post({ events: [ev()] })).status, 200);
  });
});

// Audit 2026-11-07, SRV-07: agent, session, intakeId, carrier, page and v were stored as sent, any
// JSON up to the event's size limit, and t could be any year. Out of shape, the event is refused.
test('common fields out of their shape refuse the event, with why; in their shape or null they are kept as sent', async () => {
  const dataDir = tmp();
  const session = crypto.randomUUID();
  const intakeId = crypto.createHash('sha256').update('intake').digest('hex');
  const good = { agent: 'JC', session, intakeId, carrier: 'amwins', page: '/Portal/Application/:id/Edit', v: '0.9.32' };
  const day = 24 * 60 * 60 * 1000;
  await withServer({ dataDir }, async ({ post }) => {
    const bad = [
      [{ agent: { name: 'x' } }, 'agent is not a valid agent initials'],
      [{ agent: 'A'.repeat(13) }, 'agent is not a valid agent initials'],
      [{ agent: 'jo@x' }, 'agent is not a valid agent initials'],
      [{ session: 'not a session' }, 'session is not a valid session id'],
      [{ session: 42 }, 'session is not a valid session id'],
      [{ intakeId: 'Acme Trucking LLC' }, 'intakeId is not a valid intake fingerprint'],
      [{ intakeId: intakeId.toUpperCase() }, 'intakeId is not a valid intake fingerprint'],
      [{ carrier: ['progressive'] }, 'carrier is not a valid carrier id'],
      [{ carrier: 'GEICO' }, 'carrier is not a valid carrier id'],
      [{ page: { path: '/x' } }, 'page is not a valid page name'],
      [{ page: `/${'p'.repeat(200)}` }, 'page is not a valid page name'],
      [{ page: 'Jane <jane@example.com>' }, 'page is not a valid page name'],
      [{ v: 9 }, 'v is not a valid version'],
      [{ v: '0.9.32; client Jane' }, 'v is not a valid version'],
      [{ t: '1970-01-01T00:00:00.000Z' }, 'event time is not an ISO time in UTC from 2025 to 30 days ahead'],
      [{ t: new Date(Date.now() + 31 * day).toISOString() }, 'event time is not an ISO time in UTC from 2025 to 30 days ahead'],
      [{ t: '2026-11-07T10:00:00+03:00' }, 'event time is not an ISO time in UTC from 2025 to 30 days ahead'],
      // Date.parse rolls these over (to March 2, and to the next day) rather than refusing them.
      [{ t: '2025-02-30T00:00:00.000Z' }, 'event time is not an ISO time in UTC from 2025 to 30 days ahead'],
      [{ t: '2026-11-06T24:00:00Z' }, 'event time is not an ISO time in UTC from 2025 to 30 days ahead'],
    ];
    const ok = [
      good,
      { agent: null, session: null, intakeId: null, carrier: null, page: null, v: null },
      { agent: 'Ş. K', carrier: 'new-carrier2', page: 'Add Vehicle (2), step:1', v: 'dev', t: new Date(Date.now() + 29 * day).toISOString() },
      { t: '2026-09-30T21:05:43Z' },
    ];
    const r = await (await post({ agent: 'AD', events: [...bad.map(([over]) => ev({ ...good, ...over })), ...ok.map((over) => ev(over))] })).json();
    assert.deepEqual(r.rejected, bad.map(([, error], index) => ({ index, error })));
    assert.equal(r.accepted, ok.length);
  });
  const rows = stored(dataDir);
  assert.deepEqual(rows.map((e) => Object.fromEntries(Object.keys(good).map((k) => [k, e[k]]))), [
    good,
    { agent: 'AD', session: null, intakeId: null, carrier: null, page: null, v: null },
    { agent: 'Ş. K', session: undefined, intakeId: undefined, carrier: 'new-carrier2', page: 'Add Vehicle (2), step:1', v: 'dev' },
    { agent: 'AD', session: undefined, intakeId: undefined, carrier: 'progressive', page: 'AddVehicle', v: undefined },
  ], 'kept as sent; the request\'s agent where the event has none (null included, as before)');
  assert.ok(rows.every((e) => !e.dropped));
});

test('the request\'s agent is used only in the shape of an event\'s', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    for (const agent of ['AYAZ', 'x'.repeat(40), { initials: 'AB' }, 'a@b.c']) await post({ agent, events: [ev()] });
  });
  assert.deepEqual(stored(dataDir).map((e) => e.agent), ['AYAZ', null, null, null]);
});

// Audit 2026-11-07, SRV-14: an extension released before its server sent fields the server dropped
// for good. Events carry the schema they were logged under; one newer than the server's is refused
// in words the extension retries, so it waits for the deploy instead of losing its new fields.
test('an event of a newer schema than the server\'s is refused, saying so; this one and older ones are kept with their schema', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    const r = await (await post({ events: [
      ev({ schema: SCHEMA_VERSION + 1, newField: 'x' }), ev({ schema: SCHEMA_VERSION }), ev(), ev({ schema: 0 }), ev({ schema: '1' }), ev({ type: 'a_new_type', schema: SCHEMA_VERSION + 1 }),
    ] })).json();
    assert.deepEqual(r.rejected, [
      { index: 0, error: `schema newer than server (${SCHEMA_VERSION + 1} > ${SCHEMA_VERSION})` },
      { index: 3, error: 'schema is not a valid schema version' },
      { index: 4, error: 'schema is not a valid schema version' },
      { index: 5, error: `schema newer than server (${SCHEMA_VERSION + 1} > ${SCHEMA_VERSION})` },
    ]);
    assert.equal(r.accepted, 2);
  });
  assert.deepEqual(stored(dataDir).map((e) => [e.schema, e.dropped]), [[SCHEMA_VERSION, undefined], [undefined, undefined]], 'kept, never in dropped; an older client\'s has none');
});
