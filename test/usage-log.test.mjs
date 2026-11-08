import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as usage from '../sidepanel/usage-log.js';
import { createServer } from '../server/index.mjs';
import { sha256Hex, fillEvents, fieldChangeEvent, agentSettingsEvent, clientErrorEvent, checkDismissedEvent, intakeProfile } from '../src/usage.js';

// Node's own fetch, before the tests below replace it with fake servers.
const realFetch = globalThis.fetch;

// Outside Chrome the usage log keeps its queue in memory, so the upload logic runs as is.
test('events an older server refused as unknown types are sent again to a newer server', async () => {
  const bodies = [];
  let serverKnowsAi = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const rejected = serverKnowsAi ? [] : body.events.map((e, index) => (e.type === 'ai_suggest' ? { index, error: 'unknown event type "ai_suggest"' } : null)).filter(Boolean);
    return { ok: true, json: async () => ({ accepted: body.events.length - rejected.length, duplicates: 0, rejected }) };
  };
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  await usage.log({ type: 'page_view', page: 'A' }, { type: 'ai_suggest', items: 2 });
  await usage.upload();
  assert.deepEqual(await usage.counts(), { queued: 0, rejected: 1 }, 'nothing left in the upload queue; the refused event is kept aside');
  assert.equal(await usage.count(), 1, 'and still counted as waiting on this computer');
  assert.deepEqual(bodies[0].events.map((e) => e.type), ['page_view', 'ai_suggest']);

  serverKnowsAi = true;
  await usage.upload();
  const resent = bodies.at(-1).events;
  assert.deepEqual(resent.map((e) => e.type), ['ai_suggest'], 'only the refused event is sent again');
  assert.equal(resent[0].rejectedBecause, undefined);
  await usage.upload();
  assert.equal(bodies.length, 2, 'accepted on the retry: not sent a third time');
  assert.equal(await usage.count(), 0);
});

test('uploads go to the central server with the built-in token unless the agent set their own', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization ?? null });
    return { ok: true, json: async () => ({ accepted: 1, duplicates: 0, rejected: [] }) };
  };
  await usage.saveSettings({ serverUrl: undefined, serverToken: '' });
  assert.deepEqual(await usage.serverConfig(), { serverUrl: usage.DEFAULT_SERVER, serverToken: usage.DEFAULT_TOKEN });
  await usage.log({ type: 'page_view', page: 'A' });
  await usage.upload();
  assert.ok(seen.at(-1).url.startsWith(`${usage.DEFAULT_SERVER}/v1/events`));
  assert.equal(seen.at(-1).auth, `Bearer ${usage.DEFAULT_TOKEN}`);
  await usage.saveSettings({ serverUrl: 'http://localhost:8787', serverToken: '' });
  assert.deepEqual(await usage.serverConfig(), { serverUrl: 'http://localhost:8787', serverToken: '' }, 'a local test server never gets the central token');
  await usage.saveSettings({ serverUrl: '' });
  assert.equal((await usage.serverConfig()).serverUrl, '', 'blank: export only');
});

// A fake collection server: `reply(body)` answers each upload; health checks just say ok.
function fakeServer(reply) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (!init?.body) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    const body = JSON.parse(init.body);
    requests.push({ body, chars: init.body.length });
    return reply(body);
  };
  return requests;
}
const stores = (body) => ({ ok: true, status: 200, json: async () => ({ accepted: body.events.length, duplicates: 0, rejected: [] }) });

test('an event keeps the quote it was logged in, even when the panel moves on before it is written', async () => {
  const requests = fakeServer(stores);
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  const a = usage.startSession('intake-a');
  usage.log({ type: 'page_view', page: 'A' });
  // Replace: the old quote's close is logged, then the next intake's session starts at once.
  usage.log({ type: 'intake_closed', reason: 'replaced' });
  const b = usage.startSession('intake-b');
  usage.log({ type: 'intake_loaded' });
  // A fill begun on A whose results came back now: it names A's quote, and keeps it (noteStaleFill).
  usage.log({ type: 'fill_error', error: 'stale: intake changed during the fill', session: a.id, intakeId: 'intake-a' });
  // Clear: the close is logged, then the panel has no session.
  usage.log({ type: 'intake_closed', reason: 'cleared' });
  usage.restoreSession(null);
  await usage.upload();
  const events = requests.flatMap((r) => r.body.events);
  assert.deepEqual(events.map((e) => [e.type, e.session, e.intakeId]), [
    ['page_view', a.id, 'intake-a'],
    ['intake_closed', a.id, 'intake-a'],
    ['intake_loaded', b.id, 'intake-b'],
    ['fill_error', a.id, 'intake-a'],
    ['intake_closed', b.id, 'intake-b'],
  ]);
  assert.ok(events.every((e) => e.channel === 'source' && !('commit' in e)), 'which copy logged it: the repository, no commit');
  const seqs = events.map((e) => e.seq);
  assert.ok(seqs.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n === seqs[i - 1] + 1)), `numbered in order: ${seqs}`);
  assert.ok(a.keySalt && b.keySalt && a.keySalt !== b.keySalt, 'each quote has its own key salt');
  assert.ok(events.every((e) => !('keySalt' in e) && !JSON.stringify(e).includes(a.keySalt)), 'the salt never goes in an event');
  usage.restoreSession({ id: 'saved-before-salts', intakeId: 'intake-c' });
  assert.ok(usage.currentSession().keySalt, 'an older saved session gets a salt');
  usage.restoreSession(null);
});

test('uploads are split to fit the server, and one event too large on its own is set aside', async () => {
  let requests = fakeServer(stores);
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  // Three layouts of 400k characters: two fit in one request, the third goes in the next.
  await usage.log(...[0, 1, 2].map((i) => ({ type: 'page_layout', page: `P${i}`, fields: [{ label: 'x'.repeat(400_000) }] })));
  await usage.upload();
  assert.deepEqual(requests.map((r) => r.body.events.length), [2, 1]);
  assert.ok(requests.every((r) => r.chars < 1_100_000));
  assert.equal(await usage.count(), 0);

  // A server (or a proxy in front of it) with a smaller limit: fewer at a time until it fits.
  const tooLarge = { ok: false, status: 413, json: async () => ({ error: 'request too large' }) };
  requests = fakeServer((body) => (body.events.length > 2 ? tooLarge : stores(body)));
  await usage.log(...[0, 1, 2, 3, 4].map((i) => ({ type: 'page_view', page: `Q${i}` })));
  await usage.upload();
  assert.deepEqual(requests.map((r) => r.body.events.length), [5, 3, 2, 2, 1]);
  assert.equal(await usage.count(), 0);

  requests = fakeServer((body) => (body.events.some((e) => e.page === 'huge') ? tooLarge : stores(body)));
  await usage.log({ type: 'page_view', page: 'huge' }, { type: 'page_view', page: 'after' });
  await usage.upload();
  assert.deepEqual(requests.map((r) => r.body.events.map((e) => e.page)), [['huge', 'after'], ['huge'], ['after']]);
  assert.deepEqual(await usage.counts(), { queued: 0, rejected: 1 }, 'the queue is not stuck behind it');
  await usage.upload();
  assert.equal(requests.length, 3, 'set aside, not sent again');
});

// Audit 2026-10-08: Clear emptied the upload queue but not the events set aside, which Export
// kept writing; the shown count left them out.
test('Clear deletes the events set aside too, and the count includes them', async () => {
  await usage.clearLog();
  assert.deepEqual(await usage.counts(), { queued: 0, rejected: 0 });
  fakeServer((body) => ({ ok: true, status: 200, json: async () => ({ accepted: body.events.length - 1, duplicates: 0, rejected: [{ index: 0, error: 'event too large' }] }) }));
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  await usage.log({ type: 'page_view', page: 'A' }, { type: 'page_view', page: 'B' });
  await usage.upload();
  assert.deepEqual(await usage.counts(), { queued: 0, rejected: 1 });
  assert.equal(await usage.count(), 1, 'what the panel shows and Export writes');
  await usage.log({ type: 'page_view', page: 'C' });
  assert.equal(await usage.count(), 2);
  await usage.clearLog();
  assert.deepEqual(await usage.counts(), { queued: 0, rejected: 0 });
  assert.equal(await usage.count(), 0);
});

// Audit 2026-11-07, UX-17 (review of #463): Clear log's yes deletes only the events its question
// counted. The count is checked under the log's lock as it deletes, so an event logged after the
// question (by this panel or another window's) is kept and asked about.
test('Clear with the count asked about deletes nothing once more events are logged', async () => {
  await usage.clearLog();
  await usage.log({ type: 'page_view', page: 'A' }, { type: 'page_view', page: 'B' });
  const asked = await usage.count();
  await usage.log({ type: 'page_view', page: 'C' });
  assert.equal(await usage.clearLog({ expected: asked }), false);
  assert.equal(await usage.count(), 3, 'nothing deleted');
  assert.equal(await usage.clearLog({ expected: 3 }), true);
  assert.equal(await usage.count(), 0);
});

test('a reply that does not account for every event sent keeps them in the queue', async () => {
  let requests = fakeServer(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('an HTML page'); } }));
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  await usage.log({ type: 'page_view', page: 'R1' }, { type: 'page_view', page: 'R2' });
  await usage.upload();
  assert.equal((await usage.counts()).queued, 2);
  assert.equal(usage.lastUpload().state, 'error');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [] }) }));
  await usage.upload();
  assert.equal((await usage.counts()).queued, 2, 'one event unaccounted for');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [{ index: 7, error: 'x' }] }) }));
  await usage.upload();
  assert.equal((await usage.counts()).queued, 2, 'a refusal for an event that was not sent');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 0, duplicates: 0, rejected: [{ index: 0, error: 'x' }, { index: 0, error: 'x' }] }) }));
  await usage.upload();
  assert.equal((await usage.counts()).queued, 2, 'the same event refused twice leaves the other unaccounted for');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 3, duplicates: -1, rejected: [] }) }));
  await usage.upload();
  assert.equal((await usage.counts()).queued, 2, 'negative counts');

  requests = fakeServer(stores);
  await usage.upload();
  assert.equal((await usage.counts()).queued, 0);
  assert.equal(requests.length, 1);
  assert.equal(usage.lastUpload().state, 'ok');
});

test('side panels in two windows share the stored log without losing events or reusing numbers', async () => {
  // chrome.storage.local, slow enough that two unsynchronized writers would overwrite each other.
  const data = {};
  const later = () => new Promise((resolve) => setTimeout(resolve, 3));
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => { await later(); return { [key]: structuredClone(data[key]) }; },
      set: async (items) => { await later(); Object.assign(data, structuredClone(items)); },
    } },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  // Web Locks where this Node has none: one holder at a time, in request order.
  const addedLocks = !globalThis.navigator?.locks;
  if (addedLocks) {
    let tail = Promise.resolve();
    Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: (name, fn) => {
      const run = tail.then(() => fn());
      tail = run.catch(() => {});
      return run;
    } } });
  }
  try {
    const [left, right] = await Promise.all(['left', 'right'].map((w) => import(`../sidepanel/usage-log.js?window=${w}`)));
    left.startSession('intake-1');
    right.startSession('intake-2');
    await Promise.all([1, 2, 3].flatMap((i) => [left.log({ type: 'page_view', page: `L${i}` }), right.log({ type: 'page_view', page: `R${i}` })]));
    const pages = data.usageLog.map((e) => e.page).sort();
    assert.deepEqual(pages, ['L1', 'L2', 'L3', 'R1', 'R2', 'R3'], 'no event lost');
    const seqs = data.usageLog.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, `no number used twice: ${seqs}`);
    assert.equal(data.usageSeq, Math.max(...seqs));
  } finally {
    delete globalThis.chrome;
    if (addedLocks) delete globalThis.navigator.locks;
  }
});

// Audit 2026-10-08: a write that failed (storage full) lost the events with only a console line.
test('events that could not be saved on this computer are reported, until a save works again', async () => {
  const data = {};
  let full = true;
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(data[key]) }),
      set: async (items) => { if (full && 'usageLog' in items) throw new Error('QUOTA_BYTES quota exceeded'); Object.assign(data, structuredClone(items)); },
    } },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  try {
    const log = await import('../sidepanel/usage-log.js?storage=full');
    assert.equal(log.lastSave().state, 'ok');
    await log.log({ type: 'page_view', page: 'A' });
    assert.deepEqual([log.lastSave().state, log.lastSave().message], ['error', 'QUOTA_BYTES quota exceeded']);
    full = false;
    await log.log({ type: 'page_view', page: 'B' });
    assert.equal(log.lastSave().state, 'ok');
    assert.deepEqual(data.usageLog.map((e) => e.page), ['B']);
  } finally {
    delete globalThis.chrome;
  }
});

// Audit 2026-10-08, finding 11: an upload that hangs (a proxy, a half-open connection) kept the
// queue waiting on it; now it is given up and the events stay for the next upload.
test('an upload that hangs is given up: the status says so and the events stay queued', async () => {
  let aborted = 0;
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); });
  });
  await usage.saveSettings({ serverUrl: 'http://usage.test', serverToken: '' });
  await usage.log({ type: 'page_view', page: 'T1' });
  await usage.upload({ timeoutMs: 20 });
  assert.equal(aborted, 1);
  assert.equal(await usage.count(), 1, 'the event stays queued');
  assert.equal(usage.lastUpload().state, 'error');
  assert.match(usage.lastUpload().message, /didn't answer in time; the events stay here/);
  assert.equal(usage.UPLOAD_TIMEOUT_MS, 20_000);
  // The health check (nothing queued) is given up the same way.
  const requests = fakeServer(stores);
  await usage.upload();
  assert.deepEqual([await usage.count(), requests.length, usage.lastUpload().state], [0, 1, 'ok']);
  globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await usage.upload({ timeoutMs: 20 });
  assert.match(usage.lastUpload().message, /didn't answer in time/);
  assert.ok(requests.every((r) => r.body), 'every upload request still carried its events');
});

// Codex on PR #65 (2c8eeb9): the timer stopped once the headers came, so a reply whose body never
// arrived held the upload queue for good.
test('a reply whose body never arrives is given up too, and the next upload still runs', async () => {
  for (const status of [200, 500]) {
    globalThis.fetch = async () => ({ ok: status === 200, status, statusText: 'x', json: () => new Promise(() => {}) });
    await usage.saveSettings({ serverUrl: 'http://usage.test', serverToken: '' });
    await usage.log({ type: 'page_view', page: 'T2' });
    await usage.upload({ timeoutMs: 20 });
    assert.equal(usage.lastUpload().state, 'error');
    assert.match(usage.lastUpload().message, /didn't answer in time; the events stay here/);
    assert.equal(await usage.count(), 1, 'the event stays queued');
    const requests = fakeServer(stores);
    await usage.upload();
    assert.deepEqual([await usage.count(), requests.length, usage.lastUpload().state], [0, 1, 'ok'], 'the queue is not held');
  }
});

// Audit 2026-11-07, SRV-13: the collection server refuses uploads over an address's limit (429) or
// while its disk is low (507). The panel keeps those events and sends them once it takes them.
test('a server that is rate limiting (429) or out of space (507) leaves the events queued, sent later', async () => {
  let free = 0;
  let now = 0;
  const server = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rater-usage-log-')), clock: () => now,
    uploadLimits: { requests: { size: 1, perMinute: 1 }, bytes: { size: 1e9, perMinute: 1e9 } }, minFreeBytes: 1, freeSpace: () => free });
  const quiet = console.log;
  console.log = () => {};
  const error = console.error;
  console.error = () => {};
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    globalThis.fetch = realFetch;
    await usage.saveSettings({ serverUrl: `http://127.0.0.1:${server.address().port}`, serverToken: '' });
    await usage.clearLog();
    await usage.log({ type: 'page_view', page: 'L1' }, { type: 'page_view', page: 'L2' });
    await usage.upload();
    assert.match(usage.lastUpload().message, /server said 507: the server is out of space/);
    assert.deepEqual(await usage.counts(), { queued: 2, rejected: 0 }, 'kept, not refused or dropped');
    free = 10;
    await usage.upload();
    assert.match(usage.lastUpload().message, /server said 429: too many uploads/, 'the 507 spent the only request of the minute');
    assert.deepEqual(await usage.counts(), { queued: 2, rejected: 0 });
    now += 60_000;
    await usage.upload();
    assert.deepEqual([usage.lastUpload().state, usage.lastUpload().sent], ['ok', 2]);
    assert.deepEqual(await usage.counts(), { queued: 0, rejected: 0 });
  } finally {
    console.log = quiet;
    console.error = error;
    await new Promise((r) => server.close(r));
  }
});

// Audit 2026-11-07, SRV-07: the server refuses an event whose common fields are out of their shape.
// What this log stamps (time, version, initials, session, intake fingerprint) on the extension's
// own events, with carrier pages as the panel names them, is all stored, nothing refused or dropped.
test('events as the extension builds and stamps them are all stored by the server, none refused or dropped', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-usage-log-'));
  const server = createServer({ dataDir });
  const quiet = console.log;
  console.log = () => {};
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    globalThis.fetch = realFetch;
    await usage.saveSettings({ serverUrl: `http://127.0.0.1:${server.address().port}`, serverToken: '', agent: 'JC' });
    await usage.clearLog();
    usage.startSession(await sha256Hex(new TextEncoder().encode('%PDF-1.7 intake')));
    const redact = (s) => s;
    const settings = { autoAdvance: true, autoFollowUps: true, autoPages: false, overwrite: false };
    const frames = [{ fields: 2, rounds: 1, filled: [{ label: 'Farthest distance', key: '2B9D', q: '2B9D', controlKind: 'select', shown: '500 miles' }], unknown: [], failed: [], noData: [], kept: [], leftRequired: [], blockers: [] }];
    const pages = [['progressive', 'AddVehicle'], ['geico', '/quote/vehicles'], ['amwins', '/Portal/Application/:id/Edit']];
    await usage.log(
      { type: 'intake_loaded', formVersion: '2026-10', state: 'TX', test: false },
      { type: 'intake_profile', ...intakeProfile({ garaging: { state: 'TX' }, vehicles: [], trailers: [], drivers: [] }) },
      { ...agentSettingsEvent({}, { reason: 'intake', centralServer: usage.DEFAULT_SERVER }) },
      ...pages.flatMap(([carrier, page]) => [
        { type: 'page_view', carrier, page, view: 't1', from: null, fields: 4 },
        ...fillEvents(frames, { carrier, page, view: 't1', overwrite: false, ms: 900, redact, run: crypto.randomUUID(), rules: 'abcdef012345', settings, step: 'Vehicles' }),
        { carrier, page, view: 't1', ...fieldChangeEvent({ key: '2B9D', q: '2B9D', label: 'Farthest distance', kind: 'select', before: '500 miles', after: '200 miles', agent: true }, { record: {}, filled: new Map(), redact, step: 'Vehicles' }) },
        { carrier, page, ...checkDismissedEvent({ q: '2B9D', key: '2B9D', label: 'Farthest distance', mark: 'needs' }) },
      ]),
      { ...clientErrorEvent(new Error('x'), { where: 'panel' }), carrier: null, page: null },
      { type: 'problem_report', carrier: 'geico', page: '/quote/vehicles', text: 'stuck' },
      { type: 'intake_closed', reason: 'cleared' },
    );
    const sent = await usage.count();
    await usage.upload();
    assert.deepEqual([usage.lastUpload().state, usage.lastUpload().sent], ['ok', sent], usage.lastUpload().message);
    assert.deepEqual(await usage.counts(), { queued: 0, rejected: 0 }, 'none refused');
  } finally {
    console.log = quiet;
    usage.restoreSession(null);
    await usage.saveSettings({ agent: null });
    await new Promise((r) => server.close(r));
  }
  const rows = fs.readdirSync(path.join(dataDir, 'events')).flatMap((f) => fs.readFileSync(path.join(dataDir, 'events', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  assert.ok(rows.length >= 15, `${rows.length} stored`);
  assert.deepEqual(rows.filter((e) => e.dropped).map((e) => [e.type, e.dropped]), [], 'nothing dropped');
  assert.ok(rows.every((e) => e.agent === 'JC' && /^[0-9a-f]{64}$/.test(e.intakeId) && e.v === 'dev'));
});

test('every event names its install; a full log says how many oldest events it dropped', async () => {
  const data = {};
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(data[key]) }),
      set: async (items) => { Object.assign(data, structuredClone(items)); },
    } },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  const { MAX_EVENTS } = await import('../src/usage.js');
  try {
    const log = await import('../sidepanel/usage-log.js?install=1');
    await log.log({ type: 'page_view', page: 'A' });
    await log.log({ type: 'page_view', page: 'B' });
    const install = data.usageInstall;
    assert.match(install, /^[0-9a-f-]{36}$/);
    assert.deepEqual(data.usageLog.map((e) => e.install), [install, install], 'one id for this copy, kept');
    // The queue is full: the oldest go, and how many is logged in their place.
    data.usageLog = Array.from({ length: MAX_EVENTS }, (_, i) => ({ id: `old-${i}`, type: 'page_view', seq: i + 1 }));
    await log.log({ type: 'page_view', page: 'C' }, { type: 'page_view', page: 'D' });
    assert.equal(data.usageLog.length, MAX_EVENTS);
    const lost = data.usageLog.at(-1);
    assert.deepEqual([lost.type, lost.count, lost.install], ['usage_lost', 3, install]);
    assert.deepEqual(data.usageLog.slice(-3, -1).map((e) => e.page), ['C', 'D']);
    assert.equal(data.usageLog[0].id, 'old-3');
    assert.equal(data.usageSeq, lost.seq, 'the loss has its own number');
    // A second overflow drops the first usage_lost too: its count carries into the new one.
    data.usageLog = [lost, ...Array.from({ length: MAX_EVENTS - 1 }, (_, i) => ({ id: `n-${i}`, type: 'page_view', seq: 1000 + i }))];
    await log.log({ type: 'page_view', page: 'E' }, { type: 'page_view', page: 'F' });
    assert.equal(data.usageLog.length, MAX_EVENTS);
    const again = data.usageLog.at(-1);
    assert.equal(again.type, 'usage_lost');
    assert.equal(again.count, 3 + 2, 'the earlier 3 plus the 2 real events dropped now');
    assert.equal(data.usageLog.filter((e) => e.type === 'usage_lost').length, 1);
  } finally {
    delete globalThis.chrome;
  }
});

// #422 review: the footer said a problem report reached TNI for any upload that ended `ok`, though
// one the server refused is parked, and an empty queue's health check ends `ok` too. Where the report
// itself is now says it: still waiting here, set aside as refused, or gone, which only a confirmed
// upload does.
test('an event is found waiting, set aside as refused, or sent', async () => {
  await usage.clearLog();
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  let refuse = true;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const rejected = refuse ? body.events.map((e, index) => ({ index, error: 'unknown field' })) : [];
    return { ok: true, json: async () => ({ accepted: body.events.length - rejected.length, duplicates: 0, rejected }) };
  };
  await usage.log({ id: 'report-1', type: 'problem_report', text: 'x' });
  assert.equal(await usage.eventFate('report-1'), 'queued');
  await usage.upload();
  assert.deepEqual([usage.lastUpload().state, await usage.eventFate('report-1')], ['ok', 'refused']);
  refuse = false;
  await usage.log({ id: 'report-2', type: 'problem_report', text: 'y' });
  await usage.upload();
  assert.equal(await usage.eventFate('report-2'), 'sent');
  // Gone from this computer with no receipt for it (Clear, or the queue's cap): not known to be sent.
  await usage.log({ id: 'report-3', type: 'problem_report', text: 'z' });
  await usage.clearLog();
  assert.equal(await usage.eventFate('report-3'), 'unknown');
});
