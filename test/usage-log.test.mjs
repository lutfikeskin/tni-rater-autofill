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
