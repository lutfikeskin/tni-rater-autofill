// The quote's tab on the toolbar icon (src/tab-mark.js): the dock's word as a mark, the badge, and
// when the tab is let go. The tab group and its tabGroups permission were taken out (2026-11-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKS, createTabMarker, markFor } from '../src/tab-mark.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake chrome with tabs and badges, and no tabGroups: the marker must never ask for it.
function fakeChrome({ tabs = [1, 2] } = {}) {
  const calls = [];
  const tabMap = new Map(tabs.map((id) => [id, { id, windowId: 1, groupId: -1 }]));
  const badges = new Map();
  const session = {};
  const listeners = { connect: [], tabRemoved: [] };
  const api = {
    calls, tabMap, badges,
    storage: { session: { get: async (k) => (k in session ? { [k]: session[k] } : {}), set: async (o) => { Object.assign(session, structuredClone(o)); } } },
    action: {
      setBadgeText: async ({ tabId, text }) => { badges.set(tabId, { ...badges.get(tabId), text }); },
      setBadgeBackgroundColor: async ({ tabId, color }) => { badges.set(tabId, { ...badges.get(tabId), color }); },
    },
    tabs: {
      get: async (id) => { const t = tabMap.get(id); if (!t) throw new Error('No tab'); return { ...t }; },
      group: async () => { calls.push(['group']); throw new Error('no tab groups'); },
      ungroup: async () => { calls.push(['ungroup']); },
      onRemoved: { addListener: (f) => listeners.tabRemoved.push(f) },
    },
    runtime: { onConnect: { addListener: (f) => listeners.connect.push(f) } },
  };
  return { api, listeners };
}

test('tab mark: the dock\'s word as the tab\'s mark', () => {
  assert.equal(markFor({ phase: 'filling', tone: 'blue' }), 'filling');
  // The page isn't answering: a message box on it may wait for the agent.
  assert.equal(markFor({ phase: 'filling', tone: 'warn' }), 'turn');
  for (const phase of ['ready', 'portal', 'needs', 'check', 'ai', 'hold', 'yours', 'stopped', 'stopped-fill', 'error', 'waiting', 'ready-continue']) assert.equal(markFor({ phase }), 'turn', phase);
  assert.equal(markFor({ phase: 'finished', tone: 'good' }), 'done');
  // Continue clicked: the next page's word follows.
  assert.equal(markFor({ phase: 'done', tone: 'good' }), 'keep');
  assert.equal(markFor({ phase: 'done', tone: 'good' }, true), 'keep');
  // Nothing marked on that tab for this quote yet (a panel opened again on a page it continued):
  // no mark to keep, and the page offers Fill this page again, so it is the agent's turn.
  assert.equal(markFor({ phase: 'done', tone: 'good' }, false), 'turn');
  // A fill on another tab than the one in front (audit 2026-11-07, FLOW-05): the tab in front's mark stays.
  assert.equal(markFor({ phase: 'elsewhere', tone: 'blue' }), 'keep');
  for (const phase of ['start', 'off', undefined]) assert.equal(markFor({ phase }), null, String(phase));
  assert.equal(markFor(null), null);
});

test('tab mark: each mark\'s badge, never red, and no tab group', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MARKS).map(([k, m]) => [k, [m.badge, m.badgeColor]])),
    { filling: ['•', '#1a73e8'], turn: ['!', '#e37400'], done: ['', '#188038'] });
  for (const m of Object.values(MARKS)) assert.deepEqual(Object.keys(m).sort(), ['badge', 'badgeColor']);
});

test('tab mark: filling, your turn (after it holds) and done, on the badge only', async () => {
  const { api, listeners } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 20, closeGrace: 20 });
  marker.listen();
  assert.equal(listeners.connect.length, 1);
  const port = {};
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.deepEqual(api.badges.get(1), { text: '•', color: '#1a73e8' });
  // "Your turn" waits a moment: a fill starting meanwhile keeps Filling.
  await marker.said(port, { tabId: 1, mark: 'turn', quote: 'q1' });
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await wait(40);
  await marker.idle();
  assert.equal(api.badges.get(1).text, '•');
  await marker.said(port, { tabId: 1, mark: 'turn', quote: 'q1' });
  assert.equal(api.badges.get(1).text, '•', 'not yet');
  await wait(40);
  await marker.idle();
  assert.deepEqual(api.badges.get(1), { text: '!', color: '#e37400' });
  await marker.said(port, { tabId: 1, mark: 'done', quote: 'q1' });
  await marker.idle();
  assert.equal(api.badges.get(1).text, '');
  assert.deepEqual(api.calls, [], 'never groups or ungroups a tab');
  assert.equal(api.tabMap.get(1).groupId, -1);
});

test('tab mark: let go when the client is cleared, the quote moves to another tab, or the tab leaves the rater', async () => {
  const { api } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  const port = {};
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  // Another rater tab: the first is let go, the new one marked.
  await marker.said(port, { tabId: 2, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(api.badges.get(1).text, '');
  assert.equal(api.badges.get(2).text, '•');
  // The client cleared, or the tab left the carrier's site: the panel says no tab.
  await marker.said(port, { tabId: null, mark: null, quote: null });
  await marker.idle();
  assert.equal(api.badges.get(2).text, '');
  // Back on the first tab for the same quote: marked again.
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(api.badges.get(1).text, '•');
  assert.deepEqual(api.calls, []);
});

test('tab mark: let go when the panel closes, unless another copy takes the tab up', async () => {
  const { api } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 20 });
  const side = {};
  await marker.said(side, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  // Pop out: the side panel gives way to the window, which says the same tab.
  marker.closed(side);
  const popup = {};
  await marker.said(popup, { tabId: 1, mark: 'filling', quote: 'q1' });
  await wait(40);
  await marker.idle();
  assert.equal(api.badges.get(1).text, '•');
  marker.closed(popup);
  await wait(40);
  await marker.idle();
  assert.equal(api.badges.get(1).text, '');
});

test('tab mark: a turn already shown before the worker restarted is shown again at once', async () => {
  const { api } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 30, closeGrace: 0 });
  await marker.said({}, { tabId: 1, mark: 'turn', quote: 'q1' });
  await wait(50);
  await marker.idle();
  assert.equal(api.badges.get(1).text, '!');
  // A worker Chrome stopped and started again remembers (chrome.storage.session).
  const again = createTabMarker(api, { turnDelay: 30, closeGrace: 0 });
  api.badges.set(1, { text: '' });
  await again.said({}, { tabId: 1, mark: 'turn', quote: 'q1' });
  await again.idle();
  assert.equal(api.badges.get(1).text, '!', 'no wait for a turn already shown');
});
