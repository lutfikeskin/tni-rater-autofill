import test from 'node:test';
import assert from 'node:assert/strict';
import * as usage from '../sidepanel/usage-log.js';

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
  } finally {
    delete globalThis.chrome;
  }
});
