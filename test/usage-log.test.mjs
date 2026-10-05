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
  assert.equal(await usage.count(), 0, 'nothing left in the upload queue');
  assert.deepEqual(bodies[0].events.map((e) => e.type), ['page_view', 'ai_suggest']);

  serverKnowsAi = true;
  await usage.upload();
  const resent = bodies.at(-1).events;
  assert.deepEqual(resent.map((e) => e.type), ['ai_suggest'], 'only the refused event is sent again');
  assert.equal(resent[0].rejectedBecause, undefined);
  await usage.upload();
  assert.equal(bodies.length, 2, 'accepted on the retry: not sent a third time');
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
  // Clear: the close is logged, then the panel has no session.
  usage.log({ type: 'intake_closed', reason: 'cleared' });
  usage.restoreSession(null);
  await usage.upload();
  const events = requests.flatMap((r) => r.body.events);
  assert.deepEqual(events.map((e) => [e.type, e.session, e.intakeId]), [
    ['page_view', a.id, 'intake-a'],
    ['intake_closed', a.id, 'intake-a'],
    ['intake_loaded', b.id, 'intake-b'],
    ['intake_closed', b.id, 'intake-b'],
  ]);
  const seqs = events.map((e) => e.seq);
  assert.ok(seqs.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n === seqs[i - 1] + 1)), `numbered in order: ${seqs}`);
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
  assert.equal(await usage.count(), 0, 'the queue is not stuck behind it');
  await usage.upload();
  assert.equal(requests.length, 3, 'set aside, not sent again');
});

test('a reply that does not account for every event sent keeps them in the queue', async () => {
  let requests = fakeServer(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('an HTML page'); } }));
  await usage.saveSettings({ serverUrl: 'http://usage.test' });
  await usage.log({ type: 'page_view', page: 'R1' }, { type: 'page_view', page: 'R2' });
  await usage.upload();
  assert.equal(await usage.count(), 2);
  assert.equal(usage.lastUpload().state, 'error');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [] }) }));
  await usage.upload();
  assert.equal(await usage.count(), 2, 'one event unaccounted for');

  requests = fakeServer(() => ({ ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [{ index: 7, error: 'x' }] }) }));
  await usage.upload();
  assert.equal(await usage.count(), 2, 'a refusal for an event that was not sent');

  requests = fakeServer(stores);
  await usage.upload();
  assert.equal(await usage.count(), 0);
  assert.equal(requests.length, 1);
  assert.equal(usage.lastUpload().state, 'ok');
});
