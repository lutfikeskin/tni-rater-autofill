// @ts-check
// The quote's tab, marked in Chrome's tab strip: a tab group titled with what the panel is doing
// on it, which an agent on another tab sees, and a badge on the toolbar icon for that tab, seen
// while it is in front, so the agent sees when the quote needs them (docs/browser-filling.md, "The quote's tab in the tab strip").
//
// The panel says which tab it works and its mark (markFor, from the dock: dockFor in
// sidepanel/panel/coordinator.js) over a port named 'tab-mark'; the service worker (background.js)
// runs a TabMarker, which groups the tab, titles and colours the group, and sets the badge. It
// lives there so it is the same with the panel popped out (a popup window, sidepanel/panel/window.js)
// as in the side panel, and so the mark goes when the panel closes.
//
// The badge needs no permission. The group's title and colour need `tabGroups`, an optional
// permission (manifest.json): asked for from Settings → Filling → Mark the quote's tab, never on
// install, since a required one would disable the store's update for every agent until they
// accepted its warning. Without it no group is made (an unnamed grey group says nothing).
// Never red: the group's colour says whose turn it is, not that something is wrong.

/** @typedef {'filling' | 'turn' | 'done'} TabMark */

/** What each mark shows: the group's title and colour, and the toolbar badge's text and colour. */
export const MARKS = {
  filling: { title: '● TNI · Filling', color: 'blue', badge: '•', badgeColor: '#1a73e8' },
  turn: { title: '! TNI · Your turn', color: 'orange', badge: '!', badgeColor: '#e37400' },
  done: { title: 'TNI · Done', color: 'green', badge: '', badgeColor: '#188038' },
};

const OUR_TITLES = new Set(Object.values(MARKS).map((m) => m.title));

/** A group with one of these titles is the panel's own (made by an earlier panel or worker). */
export function ourTitle(title) {
  return OUR_TITLES.has(title ?? '');
}

// The dock's phases (dockFor) where it waits on the agent: a question to answer, Looks right, a
// Continue or Fill to press, a hold to sort out, a step that is theirs, a page that stopped or
// didn't finish, AI picks to approve.
const TURN_PHASES = new Set(['ready', 'portal', 'needs', 'check', 'ai', 'hold', 'yours', 'stopped', 'stopped-fill', 'error', 'waiting', 'ready-continue']);

/**
 * The mark for the dock's word (dockFor): 'filling' while answers go in, 'turn' while the dock
 * waits on the agent, 'done' at the end of the quote; 'keep' while the page moves on after a
 * Continue the panel clicked (the next page's word follows), or while a fill runs on another tab; null for no mark (no client, or not
 * on a rater: the tab is let go). `marked`: this panel has already marked that tab for this quote.
 * Without it there is no mark to keep: the dock's "Continue clicked" is a report seen again (a
 * panel opened again or popped out on that page, or the agent back on it), which offers Fill this
 * page again, so it is the agent's turn.
 * @param {{ phase?: string, tone?: string } | null | undefined} dock
 * @param {boolean} [marked]
 * @returns {TabMark | 'keep' | null}
 */
export function markFor(dock, marked = true) {
  const phase = dock?.phase;
  // The page isn't answering: a message box on it may wait for the agent.
  if (phase === 'filling') return dock.tone === 'warn' ? 'turn' : 'filling';
  // A fill on another tab than the one in front: the tab in front's mark stays as it was.
  if (phase === 'elsewhere') return 'keep';
  if (phase === 'finished') return 'done';
  if (phase === 'done') return marked ? 'keep' : 'turn';
  return TURN_PHASES.has(phase) ? 'turn' : null;
}

// "Your turn" is shown once it has held this long: a page that opens says Fill this page for a
// moment before its automatic fill starts, and the badge shouldn't blink "!" at the agent then.
export const TURN_DELAY = 1500;
// A panel that closed (its port went) may be giving way to another copy (Pop out, Dock): its tab
// is let go only if no copy has taken it up by then.
export const CLOSE_GRACE = 5000;

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

/**
 * What to do with the tab's group, from where the tab is and what the marker did with it for this
 * quote (`memo`): 'group' (into a new group), 'update' (the group is ours: title and colour),
 * 'adopt' (a group of ours an earlier worker made: taken as this quote's), 'leave' (the agent's
 * own group: the badge only), 'off' (the agent took the tab out of our group: badge only, for the
 * rest of the quote).
 * @param {{ groupId: number, groupTitle?: string | null }} tab
 * @param {{ groupId?: number | null, off?: boolean } | undefined} memo
 * @returns {'group' | 'update' | 'adopt' | 'leave' | 'off'}
 */
export function groupStep(tab, memo) {
  if (memo?.off) return 'off';
  const inGroup = Number.isInteger(tab.groupId) && tab.groupId !== NO_GROUP;
  const ours = memo?.groupId ?? null;
  if (ours != null) return inGroup && tab.groupId === ours ? 'update' : 'off';
  if (!inGroup) return 'group';
  return ourTitle(tab.groupTitle) ? 'adopt' : 'leave';
}

/**
 * The service worker's half (background.js): the marks the panels ask for, put on their tabs.
 * `api` is chrome (tests pass a fake). What it did with each tab, per quote, is kept in
 * chrome.storage.session (`tabMarks`), so a worker that Chrome stopped and started again still
 * knows a tab the agent took out of its group.
 * @param {any} api
 * @param {{ turnDelay?: number, closeGrace?: number }} [opts]
 */
export function createTabMarker(api, { turnDelay = TURN_DELAY, closeGrace = CLOSE_GRACE } = {}) {
  /** @type {Map<any, { tabId: number | null, mark: TabMark | null, quote: string | null }>} */
  const ports = new Map();
  /** @type {Map<number, { quote: string | null, groupId: number | null, off: boolean, shown: TabMark | null }>} */
  let memos = null;
  /** @type {Map<number, any>} */
  const timers = new Map();
  /** @type {Map<number, Promise<void>>} */
  const queues = new Map();

  const load = async () => {
    if (memos) return memos;
    const saved = await Promise.resolve(api.storage?.session?.get('tabMarks')).catch(() => null);
    memos ??= new Map(Array.isArray(saved?.tabMarks) ? saved.tabMarks : []);
    return memos;
  };
  const persist = () => Promise.resolve(api.storage?.session?.set({ tabMarks: [...memos] })).catch(() => {});
  const canGroup = async () => !!(api.tabGroups && api.tabs?.group && await Promise.resolve(api.permissions?.contains({ permissions: ['tabGroups'] })).catch(() => false));
  // One change at a time per tab: two calls racing would make two groups.
  const queue = (tabId, job) => {
    const next = (queues.get(tabId) ?? Promise.resolve()).then(job).catch((e) => console.warn('tab mark:', e?.message ?? e));
    queues.set(tabId, next);
    next.then(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
    return next;
  };
  const badge = async (tabId, mark) => {
    const m = mark ? MARKS[mark] : null;
    await api.action?.setBadgeText({ tabId, text: m?.badge ?? '' });
    if (m?.badge) await api.action?.setBadgeBackgroundColor({ tabId, color: m.badgeColor });
  };

  const apply = (tabId, mark, quote) => queue(tabId, async () => {
    const tab = await Promise.resolve(api.tabs.get(tabId)).catch(() => null);
    const all = await load();
    if (!tab) { all.delete(tabId); await persist(); return; }
    await badge(tabId, mark);
    let memo = all.get(tabId);
    if (!memo || memo.quote !== quote) memo = { quote, groupId: null, off: false, shown: null };
    all.set(tabId, memo);
    if (await canGroup()) {
      const inGroup = Number.isInteger(tab.groupId) && tab.groupId !== NO_GROUP;
      const group = inGroup && memo.groupId == null ? await Promise.resolve(api.tabGroups.get(tab.groupId)).catch(() => null) : null;
      const step = groupStep({ groupId: tab.groupId, groupTitle: group?.title }, memo);
      if (step === 'off') { memo.off = true; memo.groupId = null; }
      if (step === 'adopt') memo.groupId = tab.groupId;
      if (step === 'group') memo.groupId = await api.tabs.group({ tabIds: tabId });
      if (step === 'group' || step === 'adopt' || step === 'update') {
        const { title, color } = MARKS[mark];
        await api.tabGroups.update(memo.groupId, { title, color });
      }
    }
    memo.shown = mark;
    await persist();
  });

  // The tab let go: no badge, and out of our group (tabs.ungroup needs no permission). What the
  // agent did with it this quote is kept, should the quote come back to it.
  const release = (tabId) => queue(tabId, async () => {
    const all = await load();
    const memo = all.get(tabId);
    const tab = await Promise.resolve(api.tabs.get(tabId)).catch(() => null);
    if (!tab) { all.delete(tabId); await persist(); return; }
    await badge(tabId, null);
    let ours = memo?.groupId ?? null;
    // A group of ours this worker doesn't know (made before Chrome restarted it): let go too.
    if (ours == null && !memo?.off && Number.isInteger(tab.groupId) && tab.groupId !== NO_GROUP && api.tabGroups) {
      const group = await Promise.resolve(api.tabGroups.get(tab.groupId)).catch(() => null);
      if (ourTitle(group?.title)) ours = tab.groupId;
    }
    if (ours != null && tab.groupId === ours) await api.tabs.ungroup(tabId);
    if (memo) { memo.groupId = null; memo.shown = null; }
    await persist();
  });

  const held = (tabId, except) => [...ports].some(([p, s]) => p !== except && s.tabId === tabId && s.mark);
  const cancel = (tabId) => { clearTimeout(timers.get(tabId)); timers.delete(tabId); };

  /** A panel's word: the tab it works (or none) and its mark there. */
  const said = async (port, msg) => {
    const tabId = Number.isInteger(msg?.tabId) ? msg.tabId : null;
    const mark = msg?.mark && MARKS[msg.mark] ? /** @type {TabMark} */ (msg.mark) : null;
    const quote = typeof msg?.quote === 'string' ? msg.quote : null;
    const before = ports.get(port);
    ports.set(port, { tabId, mark, quote });
    // A new quote on another tab: the one before is let go.
    if (before?.tabId != null && before.tabId !== tabId && !held(before.tabId, port)) { cancel(before.tabId); release(before.tabId); }
    if (tabId == null) return;
    cancel(tabId);
    if (!mark) { if (!held(tabId, port)) await release(tabId); return; }
    const shown = (await load()).get(tabId);
    const waits = mark === 'turn' && !(shown?.quote === quote && shown?.shown === 'turn');
    if (!waits) { await apply(tabId, mark, quote); return; }
    timers.set(tabId, setTimeout(() => { timers.delete(tabId); const now = ports.get(port); if (now?.tabId === tabId && now.mark === 'turn') apply(tabId, 'turn', quote); }, turnDelay));
  };

  /** A panel closed: its tab is let go unless another copy took it up meanwhile. */
  const closed = (port) => {
    const was = ports.get(port);
    ports.delete(port);
    if (was?.tabId == null) return;
    const tabId = was.tabId;
    cancel(tabId);
    timers.set(tabId, setTimeout(() => { timers.delete(tabId); if (!held(tabId)) release(tabId); }, closeGrace));
  };

  /** tabGroups granted or taken back: every tab marked again (or let go of its group). */
  const permissionChanged = async () => {
    const granted = await canGroup();
    for (const [, s] of ports) {
      if (s.tabId == null || !s.mark) continue;
      if (granted) await apply(s.tabId, s.mark, s.quote);
    }
    if (granted) return;
    // Taken back: our groups go (ungroup needs no permission); the badges stay.
    const all = await load();
    for (const [tabId, memo] of all) {
      if (memo.groupId == null) continue;
      const tab = await Promise.resolve(api.tabs.get(tabId)).catch(() => null);
      if (tab?.groupId === memo.groupId) await Promise.resolve(api.tabs.ungroup(tabId)).catch(() => {});
      memo.groupId = null;
    }
    await persist();
  };

  /** A tab closed: nothing more to do with it. */
  const tabRemoved = async (tabId) => {
    cancel(tabId);
    const all = await load();
    if (all.delete(tabId)) await persist();
  };

  /** Listens on the worker's events: background.js calls it once. */
  const listen = () => {
    api.runtime.onConnect.addListener((port) => {
      if (port.name !== 'tab-mark') return;
      port.onMessage.addListener((msg) => { said(port, msg); });
      port.onDisconnect.addListener(() => closed(port));
    });
    api.permissions?.onAdded?.addListener(() => { permissionChanged(); });
    api.permissions?.onRemoved?.addListener(() => { permissionChanged(); });
    api.tabs.onRemoved.addListener((tabId) => { tabRemoved(tabId); });
  };

  return { said, closed, permissionChanged, tabRemoved, listen, idle: () => Promise.all([...queues.values()]) };
}
