// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { summarize, renderDashboard, quoteSessions, testSessions, testIntakesFrom, prepare, eventReader } from '../server/dashboard.mjs';
import { quoteSessions as reviewQuotes } from '../scripts/lib/events.mjs';
import { signals, testSessionsOf } from '../scripts/lib/signals.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = (hours) => new Date(NOW - hours * 3600_000).toISOString();
let n = 0;
const ev = (hours, over) => ({ id: `ev-${String(++n).padStart(6, '0')}`, t: ago(hours), receivedAt: ago(hours), v: '0.9.29', channel: 'store', ...over });

// Five sessions: AB's quote an hour ago (Progressive, filled twice, two corrections, one answer by
// hand, a problem report), CD's quote three days ago (GEICO), a test run marked in the panel, an
// intake never taken to a carrier, and EF's quote 20 days ago on an older build.
function sample() {
  n = 0;
  const ab = { agent: 'AB', session: 's-ab', intakeId: 'aaaa1111' };
  const cd = { agent: 'CD', session: 's-cd', intakeId: 'bbbb2222' };
  const t1 = { agent: 'AB', session: 's-test', intakeId: 'cccc3333' };
  const ef = { agent: 'EF', session: 's-ef', intakeId: 'dddd4444', v: '0.9.20', channel: 'unpacked' };
  return [
    ev(1.5, { ...ab, type: 'intake_loaded', state: 'TX', businessClass: 'Trucking', counts: { vehicles: 2, drivers: 1, trailers: 0 } }),
    ev(1.4, { ...ab, type: 'fill_run', carrier: 'progressive', page: 'Vehicles', filled: 3, unknown: 1 }),
    ev(1.4, { ...ab, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'filled', q: '1', label: 'Year' }),
    ev(1.4, { ...ab, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'filled', q: '2', label: 'Make' }),
    ev(1.4, { ...ab, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'unfamiliar', q: '9', label: 'Tow <b>radius</b>' }),
    // A second fill of the same page: the same answers again, counted once.
    ev(1.3, { ...ab, type: 'fill_run', carrier: 'progressive', page: 'Vehicles-Reload', filled: 2 }),
    ev(1.3, { ...ab, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'filled', q: '1', label: 'Year' }),
    ev(1.3, { ...ab, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'unfamiliar', q: '9', label: 'Tow <b>radius</b>' }),
    ev(1.2, { ...ab, type: 'field_change', carrier: 'progressive', page: 'Vehicles', by: 'agent', autofilled: 'intake', vsAutofill: 'different' }),
    ev(1.2, { ...ab, type: 'field_change', carrier: 'progressive', page: 'Vehicles', by: 'agent', autofilled: 'intake', vsAutofill: 'cleared' }),
    ev(1.2, { ...ab, type: 'field_change', carrier: 'progressive', page: 'Vehicles', by: 'agent', autofilled: 'intake', vsAutofill: 'format' }),
    ev(1.2, { ...ab, type: 'field_change', carrier: 'progressive', page: 'Vehicles', by: 'agent', autofilled: null }),
    ev(1.2, { ...ab, type: 'field_change', carrier: 'progressive', page: 'Vehicles', by: 'page', autofilled: 'intake', vsAutofill: 'different' }),
    ev(1.0, { ...ab, type: 'problem_report', carrier: 'progressive', page: 'Vehicles', text: 'Year <script>x</script> was wrong', blockerList: ['differs: Year'] }),

    ev(72, { ...cd, type: 'intake_loaded', state: 'GA' }),
    ev(71, { ...cd, type: 'fill_run', carrier: 'geico', page: 'Quote', step: 'Drivers', filled: 1 }),
    ev(71, { ...cd, type: 'fill_field', carrier: 'geico', page: 'Quote', step: 'Drivers', result: 'filled', q: '3', label: 'Age' }),
    // A fill that filled nothing is no page filled.
    ev(70, { ...cd, type: 'fill_run', carrier: 'geico', page: 'Quote', step: 'Vehicles', filled: 0 }),

    ev(2, { ...t1, type: 'intake_loaded', state: 'TX' }),
    ev(2, { ...t1, type: 'intake_marked', test: true }),
    ev(2, { ...t1, type: 'fill_run', carrier: 'progressive', page: 'Vehicles', filled: 5 }),
    ev(2, { ...t1, type: 'fill_field', carrier: 'progressive', page: 'Vehicles', result: 'filled', q: '1', label: 'Year' }),
    ev(2, { ...t1, type: 'problem_report', carrier: 'progressive', page: 'Vehicles', text: 'test report' }),

    ev(0.5, { agent: 'CD', session: 's-noquote', intakeId: 'eeee5555', type: 'intake_loaded', state: 'FL' }),

    ev(480, { ...ef, type: 'intake_loaded', state: 'OH' }),
    ev(479, { ...ef, type: 'fill_run', carrier: 'amwins', page: 'Application', step: 'Vehicles', filled: 4 }),
    ev(479, { ...ef, type: 'fill_field', carrier: 'amwins', page: 'Application', step: 'Vehicles', result: 'filled', q: '4', label: 'VIN' }),
    // Older than 30 days: in no window.
    ev(800, { agent: 'GH', session: 's-old', type: 'intake_loaded', state: 'NY' }),
    ev(800, { agent: 'GH', session: 's-old', type: 'fill_run', carrier: 'progressive', page: 'Vehicles', filled: 9 }),
    // The local test page is never counted.
    ev(1, { agent: 'AB', session: 's-ab', type: 'fill_run', carrier: 'test', page: 'Vehicles', filled: 50 }),
  ];
}

test('totals per window: per quote, test runs left out', () => {
  const s = summarize(sample(), { now: NOW });
  const byWindow = Object.fromEntries(s.totals.map((t) => [t.window, t]));
  assert.deepEqual(byWindow['24h'], { window: '24h', quotes: 1, pagesFilled: 1, answersFilled: 2, corrected: 1, reformatted: 1, byHand: 1, problems: 1, unfamiliar: 1, testRuns: 1 });
  assert.deepEqual([byWindow['7d'].quotes, byWindow['7d'].pagesFilled, byWindow['7d'].answersFilled], [2, 2, 3]);
  assert.deepEqual([byWindow['30d'].quotes, byWindow['30d'].pagesFilled, byWindow['30d'].answersFilled, byWindow['30d'].testRuns], [3, 3, 4, 1]);
});

test('test runs are counted when asked for', () => {
  const s = summarize(sample(), { now: NOW, includeTests: true });
  const day = s.totals[0];
  assert.deepEqual([day.quotes, day.pagesFilled, day.answersFilled, day.problems], [2, 2, 3, 2]);
  assert.ok(s.problems.some((p) => p.test), 'a test run\'s report is marked');
  // Unmarked after: a quote again.
  const events = [...sample(), ev(0.1, { agent: 'AB', session: 's-test', type: 'intake_marked', test: false })];
  assert.equal(summarize(events, { now: NOW }).totals[0].quotes, 2);
});

test('fingerprints from RATER_TEST_INTAKES leave their quotes out', () => {
  assert.deepEqual(testIntakesFrom(' AAAA1111, nothex!, abc\nbbbb2222 '), ['aaaa1111', 'bbbb2222']);
  const s = summarize(sample(), { now: NOW, testIntakes: testIntakesFrom('aaaa1111') });
  assert.equal(s.totals[0].quotes, 0);
  assert.equal(s.totals[0].testRuns, 2);
});

test('per agent, carrier and build, and the lists newest first', () => {
  const s = summarize(sample(), { now: NOW, window: '30d' });
  assert.deepEqual(s.agents.map((r) => [r.key, r.quotes, r.answersFilled, r.corrected, r.problems]), [['AB', 1, 2, 1, 1], ['CD', 1, 1, 0, 0], ['EF', 1, 1, 0, 0]]);
  // AB's two changes to one autofilled answer (another value, then cleared) count once (W46-07).
  assert.deepEqual(s.carriers.map((r) => [r.key, r.quotes, r.pagesFilled]), [['progressive', 1, 1], ['amwins', 1, 1], ['geico', 1, 1]]);
  assert.deepEqual(s.builds.map((r) => [r.key, r.quotes]), [['0.9.29 store', 2], ['0.9.20 unpacked', 1]]);
  const times = s.activity.map((a) => a.t);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal(s.activity[0].what, 'Intake loaded (no carrier page yet)');
  assert.ok(s.activity.some((a) => a.what === 'Quote started' && a.detail === 'TX · Trucking · 2 vehicles, 1 drivers'));
  assert.ok(!s.activity.some((a) => a.carrier === 'test'));
  assert.deepEqual(s.unknown.map((u) => [u.label, u.seen, u.quotes]), [['Tow <b>radius</b>', 2, 1]]);
  assert.equal(s.problems.length, 1);
  // The 24-hour lists hold only the last day's.
  assert.ok(summarize(sample(), { now: NOW, window: '24h' }).activity.every((a) => a.t >= ago(24)));
});

test('the page escapes what the events hold', () => {
  const html = renderDashboard(summarize(sample(), { now: NOW }));
  assert.match(html, /Year &lt;script&gt;x&lt;\/script&gt; was wrong/);
  assert.match(html, /Tow &lt;b&gt;radius&lt;\/b&gt;/);
  assert.ok(!html.includes('<script'), 'no script on the page');
  assert.match(html, /http-equiv="refresh" content="60"/);
  assert.match(html, /Include test runs/);
  assert.match(html, /filled 2 answers on <b>Progressive › Vehicles<\/b>/, 'a fill in plain words');
  assert.match(html, /<span class="col on" title="2026-11-02: 1 quote">/, 'the bar for today, in the period');
});

test('the same quotes, test runs and corrections as the review scripts', () => {
  const stored = sample();
  const all = prepare(stored);
  assert.deepEqual([...quoteSessions(all)].sort(), [...reviewQuotes(all)].sort());
  for (const list of [[], ['aaaa1111']]) assert.deepEqual([...testSessions(all, list)].sort(), [...testSessionsOf(all, list)].sort());
  for (const [window, days] of [['24h', 1], ['7d', 7], ['30d', 30]]) {
    const since = new Date(NOW - days * 86400_000).toISOString();
    // signals() reports from `since` but knows quotes from everything; the dashboard reads 31 days.
    const k = signals(all, { since }).kpis;
    const t = summarize(stored, { now: NOW, window }).totals.find((x) => x.window === window);
    assert.deepEqual([t.quotes, t.corrected, t.reformatted, t.testRuns], [k.quotes, k.corrected, k.reformatted, k.testRunsLeftOut], window);
    assert.equal(k.filledPerQuote, k.quotes ? Math.round((t.answersFilled / k.quotes) * 10) / 10 : null, `${window} answers filled`);
  }
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rater-dashboard-'));
const TOKEN = 'dashboard-secret-0123456789';
async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { await fn({ base, logs }); } finally { console.log = log; await new Promise((r) => server.close(r)); }
}
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('the dashboard needs its token, and is off without one', async () => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  const today = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'events', `${today.slice(0, 10)}.jsonl`), `${[
    { id: 'ev-live-0001', t: today, receivedAt: today, agent: 'AB', session: 's1', type: 'intake_loaded', state: 'TX' },
    { id: 'ev-live-0002', t: today, receivedAt: today, agent: 'AB', session: 's1', type: 'fill_run', carrier: 'progressive', page: 'Vehicles', filled: 3 },
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);

  for (const dashboardToken of ['', 'short']) {
    await withServer({ dataDir, adminToken: TOKEN, dashboardToken }, async ({ base }) => {
      assert.equal((await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404, `off with "${dashboardToken}"`);
    });
  }
  await withServer({ dataDir, token: 'upload', adminToken: 'admin-token-0123456789', dashboardToken: TOKEN }, async ({ base, logs }) => {
    const get = (headers = {}, q = '') => fetch(`${base}/dashboard${q}`, { headers });
    const none = await get();
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /^Basic realm=/);
    assert.ok(!(await none.text()).includes('Vehicles'), 'nothing of the usage without the token');
    for (const auth of [basic('x', 'wrong'), basic(TOKEN, ''), 'Bearer upload', 'Bearer admin-token-0123456789', `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
      assert.equal((await get({ authorization: auth })).status, 401, auth);
    }
    const ok = await get({ authorization: basic('maintainer', TOKEN) });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/html/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await ok.text();
    assert.match(html, /Rater Autofill · live usage/);
    assert.match(html, /<div class="label">Quotes started<\/div><div class="value">1<\/div>/);
    assert.equal((await get({ authorization: `Bearer ${TOKEN}` }, '?window=30d&tests=1')).status, 200);
    assert.equal((await get({ authorization: `Bearer ${TOKEN}` }, '?window=1y')).status, 400);
    assert.equal((await fetch(`${base}/dashboard`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.ok(logs.length && logs.every((l) => !l.includes(TOKEN)), 'the token never reaches the log');
  });
});

test('the deployed image has every file the server imports', () => {
  const index = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  const docker = fs.readFileSync(new URL('../server/Dockerfile', import.meta.url), 'utf8');
  const local = [...index.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(local.includes('dashboard.mjs'));
  for (const f of local) assert.match(docker, new RegExp(`COPY [^\\n]*server/${f.replace('.', '\\.')}`), f);
});

// Review of #261: the upload token ships in the extension, so a stored event may carry any JSON as
// its agent or carrier. The page must still render, not throw (which would stop the server).
test('agents and carriers that are not text still group and sort', () => {
  const odd = [
    ev(1, { agent: 7, session: 's-n1', type: 'intake_loaded' }), ev(1, { agent: 7, session: 's-n1', type: 'fill_run', carrier: 5, page: 'P', filled: 1 }),
    ev(1, { agent: { x: 1 }, session: 's-n2', type: 'intake_loaded' }), ev(1, { agent: { x: 1 }, session: 's-n2', type: 'fill_run', carrier: ['a'], page: 'P', filled: 1 }),
    ev(1, { agent: 'AB', session: 's-n3', type: 'intake_loaded' }), ev(1, { agent: 'AB', session: 's-n3', type: 'fill_run', carrier: 'progressive', page: 'P', filled: 1 }),
  ];
  const s = summarize(odd, { now: NOW });
  assert.deepEqual(s.agents.map((r) => r.key).sort(), ['7', 'AB', '[object Object]']);
  assert.ok(s.carriers.every((r) => typeof r.key === 'string'));
  assert.match(renderDashboard(s), /Rater Autofill · live usage/);
});

// Review of #261: the page runs on the process that takes uploads, and every open tab reloads it
// each minute; one summary serves every request for a short while.
test('requests within the cache time reuse one summary', async () => {
  const dataDir = tmp();
  const dir = path.join(dataDir, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString();
  const file = path.join(dir, `${today.slice(0, 10)}.jsonl`);
  const line = (id, session) => `${JSON.stringify({ id, t: today, receivedAt: today, agent: 'AB', session, type: 'intake_loaded' })}\n${JSON.stringify({ id: `${id}-f`, t: today, receivedAt: today, agent: 'AB', session, type: 'fill_run', carrier: 'progressive', page: 'V', filled: 1 })}\n`;
  fs.writeFileSync(file, line('ev-cache-0001', 's1'));
  const quotes = (html) => html.match(/<div class="label">Quotes started<\/div><div class="value">(\d+)<\/div>/)[1];
  let clock = Date.now();
  await withServer({ dataDir, dashboardToken: TOKEN, dashboardCacheMs: 30_000, clock: () => clock }, async ({ base }) => {
    const get = (q = '') => fetch(`${base}/dashboard${q}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
    assert.equal(quotes(await get()), '1');
    fs.appendFileSync(file, line('ev-cache-0002', 's2'));
    assert.equal(quotes(await get()), '1', 'the same summary within 30 seconds');
    assert.equal(quotes(await get('?window=30d')), '2', 'another period is its own summary');
    clock += 31_000;
    assert.equal(quotes(await get()), '2', 'a new one after it');
  });
});

test('a page that fails to build answers 500 and the server keeps serving', async () => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  await withServer({ dataDir, dashboardToken: TOKEN }, async ({ base, logs }) => {
    // A day file the reader can't read (a folder by that name), made after the server started.
    fs.mkdirSync(path.join(dataDir, 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`));
    assert.equal((await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 500);
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    assert.ok(logs.every((l) => !l.includes(TOKEN)));
  });
});

// Review of #261: the chart says what the data says, and lights the days the period reaches.
test('the chart: no busiest day without quotes, and every day the period reaches is lit', () => {
  assert.match(renderDashboard(summarize([], { now: NOW })), /busiest day: 0 quotes/);
  // NOW is 12:00 UTC: the last 24 hours reach into yesterday, the last 7 days into the 8th day back.
  const lit = (window) => [...renderDashboard(summarize(sample(), { now: NOW, window })).matchAll(/<span class="col on" title="(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
  assert.deepEqual(lit('24h'), ['2026-11-01', '2026-11-02']);
  assert.equal(lit('7d')[0], '2026-10-26');
  assert.equal(lit('7d').length, 8);
  assert.equal(lit('30d').length, 30);
});

// The review of #425: a line written before a failed flush is in the files again after its retry,
// possibly the next day. The dashboard reads each event once, by its id.
test('the dashboard reads an event retried after a failed flush once', () => {
  const dir = tmp();
  const now = Date.parse('2026-11-07T12:00:00Z');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(path.join(dir, '2026-11-06.jsonl'), line({ id: 'a', type: 'problem_report' }) + line({ id: 'b', type: 'intake_loaded' }));
  fs.writeFileSync(path.join(dir, '2026-11-07.jsonl'), line({ id: 'a', type: 'problem_report' }) + line({ id: 'c', type: 'intake_loaded' }) + line({ id: 'c', type: 'intake_loaded' }));
  assert.deepEqual(eventReader(dir)(7, now).map((e) => e.id), ['a', 'b', 'c']);
});
