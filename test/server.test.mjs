import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, startupError, SERVER_HASH, EVENT_FIELDS, PROFILE } from '../server/index.mjs';
import { checkServer } from '../scripts/lib/central.mjs';

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
    const file = fs.readFileSync(new URL('../server/index.mjs', import.meta.url));
    assert.equal(health.server, crypto.createHash('sha256').update(file).digest('hex').slice(0, 12));
    assert.equal(health.server, SERVER_HASH);
  });
  const [row] = stored(dataDir);
  assert.equal(row.dropped.length, 20);
  assert.equal(row.droppedMore, 7, '25 extras, the bad seq and a name that is no field name');
  assert.ok(!row.dropped.includes('Jordan Sample'));
  assert.equal(row.extra0, undefined);
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
    assert.deepEqual(anyone, { ok: true, server: SERVER_HASH }, 'no admin token configured: never a count');
    const uploader = await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer up' } })).json();
    assert.equal(uploader.events, undefined, 'the token every extension carries is not enough');
  });
  await withServer({ dataDir, token: 'up', adminToken: 'admin' }, async ({ base }) => {
    assert.equal((await (await fetch(`${base}/v1/health`)).json()).events, undefined);
    assert.deepEqual(await (await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer admin' } })).json(), { ok: true, server: SERVER_HASH, events: 1 });
  });
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
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: tmp(), PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    ] })).json();
    assert.equal(r.accepted, 2);
  });
  const [ok, bad] = stored(dataDir);
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

test('a problem report keeps the fill it is about, in its shapes', async () => {
  const dataDir = tmp();
  await withServer({ dataDir }, async ({ post }) => {
    await post({ events: [
      ev({ type: 'problem_report', filled: undefined, text: 'stuck on Rates', view: 't1', run: 'run-1234-abcd', blockerList: ['button: recalculate'], since: 90 }),
      ev({ type: 'problem_report', filled: undefined, text: 'x', blockerList: 'oops', since: -1 }),
    ] });
  });
  const [ok, odd] = stored(dataDir);
  assert.deepEqual([ok.view, ok.run, ok.blockerList, ok.since], ['t1', 'run-1234-abcd', ['button: recalculate'], 90]);
  assert.deepEqual([odd.blockerList, odd.since], [undefined, undefined]);
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
