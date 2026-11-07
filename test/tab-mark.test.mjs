// The quote's tab in Chrome's tab strip and on the toolbar icon (src/tab-mark.js): the dock's word
// as a mark, the group's title and colour, the badge, a tab the agent keeps in a group of their own,
// a tab they took out of ours, and when the tab is let go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKS, createTabMarker, groupStep, markFor, ourTitle } from '../src/tab-mark.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake chrome with tabs, groups, badges and a granted (or not) tabGroups permission.
function fakeChrome({ granted = true, tabs = [1, 2] } = {}) {
  const calls = [];
  const tabMap = new Map(tabs.map((id) => [id, { id, windowId: 1, groupId: -1 }]));
  const groups = new Map();
  const badges = new Map();
  let nextGroup = 100;
  const session = {};
  const listeners = { connect: [], added: [], removed: [], tabRemoved: [] };
  const api = {
    calls, tabMap, groups, badges,
    get granted() { return granted; },
    set granted(v) { granted = v; },
    storage: { session: { get: async (k) => (k in session ? { [k]: session[k] } : {}), set: async (o) => { Object.assign(session, structuredClone(o)); } } },
    permissions: {
      contains: async () => granted,
      onAdded: { addListener: (f) => listeners.added.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => { badges.set(tabId, { ...badges.get(tabId), text }); },
      setBadgeBackgroundColor: async ({ tabId, color }) => { badges.set(tabId, { ...badges.get(tabId), color }); },
    },
    tabs: {
      get: async (id) => { const t = tabMap.get(id); if (!t) throw new Error('No tab'); return { ...t }; },
      group: async ({ tabIds }) => { const id = nextGroup++; groups.set(id, { id, title: '', color: 'grey' }); tabMap.get(tabIds).groupId = id; calls.push(['group', tabIds]); return id; },
      ungroup: async (id) => { tabMap.get(id).groupId = -1; calls.push(['ungroup', id]); },
      onRemoved: { addListener: (f) => listeners.tabRemoved.push(f) },
    },
    tabGroups: {
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error('No group'); return { ...g }; },
      update: async (id, props) => { Object.assign(groups.get(id), props); calls.push(['update', id, props.title]); },
    },
    runtime: { onConnect: { addListener: (f) => listeners.connect.push(f) } },
  };
  return { api, listeners };
}

const titleOf = (api, tabId) => api.groups.get(api.tabMap.get(tabId).groupId)?.title ?? null;

test('tab mark: the dock\'s word as the tab\'s mark', () => {
  assert.equal(markFor({ phase: 'filling', tone: 'blue' }), 'filling');
  // The page isn't answering: a message box on it may wait for the agent.
  assert.equal(markFor({ phase: 'filling', tone: 'warn' }), 'turn');
  for (const phase of ['ready', 'portal', 'needs', 'check', 'ai', 'hold', 'yours', 'stopped', 'stopped-fill', 'error', 'waiting', 'ready-continue']) assert.equal(markFor({ phase }), 'turn', phase);
  assert.equal(markFor({ phase: 'finished', tone: 'good' }), 'done');
  // Continue clicked: the next page's word follows.
  assert.equal(markFor({ phase: 'done', tone: 'good' }), 'keep');
  for (const phase of ['start', 'off', undefined]) assert.equal(markFor({ phase }), null, String(phase));
  assert.equal(markFor(null), null);
});

test('tab mark: each mark\'s title and colour, never red', () => {
  assert.deepEqual([MARKS.filling.title, MARKS.filling.color, MARKS.filling.badge], ['● TNI · Filling', 'blue', '•']);
  assert.deepEqual([MARKS.turn.title, MARKS.turn.color, MARKS.turn.badge], ['! TNI · Your turn', 'orange', '!']);
  assert.deepEqual([MARKS.done.title, MARKS.done.color, MARKS.done.badge], ['TNI · Done', 'green', '']);
  for (const m of Object.values(MARKS)) assert.notEqual(m.color, 'red');
  assert.ok(ourTitle('TNI · Done'));
  assert.ok(!ourTitle('Clients'));
  assert.ok(!ourTitle(undefined));
});

test('tab mark: a group of the agent\'s own is left alone; one taken out of ours stays out', () => {
  assert.equal(groupStep({ groupId: -1 }, undefined), 'group');
  assert.equal(groupStep({ groupId: 7, groupTitle: 'Clients' }, undefined), 'leave');
  assert.equal(groupStep({ groupId: 7, groupTitle: '! TNI · Your turn' }, undefined), 'adopt');
  assert.equal(groupStep({ groupId: 7 }, { groupId: 7 }), 'update');
  assert.equal(groupStep({ groupId: -1 }, { groupId: 7 }), 'off', 'dragged out of the group');
  assert.equal(groupStep({ groupId: 9, groupTitle: 'Clients' }, { groupId: 7 }), 'off', 'dragged into a group of theirs');
  assert.equal(groupStep({ groupId: -1 }, { groupId: null, off: true }), 'off');
});

test('tab mark: filling, your turn (after it holds) and done, with the badge', async () => {
  const { api } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 20, closeGrace: 20 });
  const port = {};
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(titleOf(api, 1), '● TNI · Filling');
  assert.equal(api.groups.get(api.tabMap.get(1).groupId).color, 'blue');
  assert.deepEqual(api.badges.get(1), { text: '•', color: '#1a73e8' });
  // "Your turn" waits a moment: a fill starting meanwhile keeps Filling.
  await marker.said(port, { tabId: 1, mark: 'turn', quote: 'q1' });
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await wait(40);
  await marker.idle();
  assert.equal(titleOf(api, 1), '● TNI · Filling');
  await marker.said(port, { tabId: 1, mark: 'turn', quote: 'q1' });
  assert.equal(titleOf(api, 1), '● TNI · Filling', 'not yet');
  await wait(40);
  await marker.idle();
  assert.equal(titleOf(api, 1), '! TNI · Your turn');
  assert.equal(api.groups.get(api.tabMap.get(1).groupId).color, 'orange');
  assert.deepEqual(api.badges.get(1), { text: '!', color: '#e37400' });
  await marker.said(port, { tabId: 1, mark: 'done', quote: 'q1' });
  await marker.idle();
  assert.equal(titleOf(api, 1), 'TNI · Done');
  assert.equal(api.groups.get(api.tabMap.get(1).groupId).color, 'green');
  assert.equal(api.badges.get(1).text, '');
  assert.equal(api.calls.filter((c) => c[0] === 'group').length, 1, 'one group for the quote');
});

test('tab mark: a tab in the agent\'s own group gets only the badge', async () => {
  const { api } = fakeChrome();
  api.groups.set(7, { id: 7, title: 'Clients', color: 'purple' });
  api.tabMap.get(1).groupId = 7;
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  await marker.said({}, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.deepEqual(api.groups.get(7), { id: 7, title: 'Clients', color: 'purple' });
  assert.equal(api.calls.length, 0);
  assert.equal(api.badges.get(1).text, '•');
  // Let go: the badge goes, their group stays.
  await marker.said({}, { tabId: null, mark: null, quote: 'q1' });
  await marker.idle();
  assert.equal(api.tabMap.get(1).groupId, 7);
});

test('tab mark: dragged out of the group, the tab isn\'t grouped again for that quote', async () => {
  const { api } = fakeChrome();
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  const port = {};
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  api.tabMap.get(1).groupId = -1; // the agent dragged it out
  await marker.said(port, { tabId: 1, mark: 'done', quote: 'q1' });
  await wait(5);
  await marker.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
  assert.equal(api.calls.filter((c) => c[0] === 'group').length, 1);
  assert.equal(api.badges.get(1).text, '', 'the badge still follows');
  // A worker Chrome stopped and started again remembers (chrome.storage.session).
  const again = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  await again.said({}, { tabId: 1, mark: 'filling', quote: 'q1' });
  await again.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
  // A new quote on the tab is grouped again.
  await again.said({}, { tabId: 1, mark: 'filling', quote: 'q2' });
  await again.idle();
  assert.equal(titleOf(api, 1), '● TNI · Filling');
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
  assert.equal(api.tabMap.get(1).groupId, -1);
  assert.equal(api.badges.get(1).text, '');
  assert.equal(titleOf(api, 2), '● TNI · Filling');
  // The client cleared, or the tab left the carrier's site: the panel says no tab.
  await marker.said(port, { tabId: null, mark: null, quote: null });
  await marker.idle();
  assert.equal(api.tabMap.get(2).groupId, -1);
  assert.equal(api.badges.get(2).text, '');
  // Back on the first tab for the same quote: grouped again (it was let go, not taken out by the agent).
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(titleOf(api, 1), '● TNI · Filling');
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
  assert.equal(titleOf(api, 1), '● TNI · Filling');
  marker.closed(popup);
  await wait(40);
  await marker.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
  assert.equal(api.badges.get(1).text, '');
});

test('tab mark: without tabGroups, only the badge; taken back, our groups go', async () => {
  const { api, listeners } = fakeChrome({ granted: false });
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  marker.listen();
  const port = { name: 'tab-mark', onMessage: { addListener: (f) => { port.send = f; } }, onDisconnect: { addListener: () => {} } };
  listeners.connect[0](port);
  await marker.said(port, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
  assert.equal(api.calls.length, 0);
  assert.equal(api.badges.get(1).text, '•');
  // Granted in Settings: the tab is grouped at once.
  api.granted = true;
  await marker.permissionChanged();
  await marker.idle();
  assert.equal(titleOf(api, 1), '● TNI · Filling');
  // Taken back: out of the group, the badge stays.
  api.granted = false;
  await marker.permissionChanged();
  await marker.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
  assert.equal(api.badges.get(1).text, '•');
});

test('tab mark: a group of ours an earlier worker made is taken up, and let go at the end', async () => {
  const { api } = fakeChrome();
  api.groups.set(7, { id: 7, title: '! TNI · Your turn', color: 'orange' });
  api.tabMap.get(1).groupId = 7;
  const marker = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  await marker.said({}, { tabId: 1, mark: 'filling', quote: 'q1' });
  await marker.idle();
  assert.equal(api.groups.get(7).title, '● TNI · Filling');
  assert.equal(api.calls.filter((c) => c[0] === 'group').length, 0);
  const fresh = createTabMarker(api, { turnDelay: 0, closeGrace: 0 });
  await fresh.said({}, { tabId: 2, mark: null, quote: null });
  await fresh.said({}, { tabId: 1, mark: null, quote: null });
  await fresh.idle();
  assert.equal(api.tabMap.get(1).groupId, -1);
});
