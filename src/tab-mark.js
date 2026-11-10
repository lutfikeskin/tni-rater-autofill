// @ts-check
// The quote's tab, marked with a badge on the toolbar icon for that tab, seen while it is in front,
// so the agent sees when the quote needs them (docs/browser-filling.md, "The quote's tab's badge").
//
// The panel says which tab it works and its mark (markFor, from the dock: dockFor in
// sidepanel/panel/coordinator.js) over a port named 'tab-mark'; the service worker (background.js)
// runs a TabMarker, which sets the badge. It
// lives there so it is the same with the panel popped out (a popup window, sidepanel/panel/window.js)
// as in the side panel, and so the mark goes when the panel closes.
//
// The badge needs no permission. The tab group with a title that went with it (Settings → Filling →
// Mark the quote's tab) and its optional `tabGroups` permission were taken out (the maintainer,
// 2026-11-10): off by default, likely unused, and the turn sound, the dock and the held quote tab
// say the same. Never red: the badge says whose turn it is, not that something is wrong.

/** @typedef {'filling' | 'turn' | 'done'} TabMark */

/** What each mark shows: the toolbar badge's text and colour. */
export const MARKS = {
  filling: { badge: '•', badgeColor: '#1a73e8' },
  turn: { badge: '!', badgeColor: '#e37400' },
  done: { badge: '', badgeColor: '#188038' },
};

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

/**
 * The service worker's half (background.js): the marks the panels ask for, put on their tabs.
 * `api` is chrome (tests pass a fake). What each tab shows, per quote, is kept in
 * chrome.storage.session (`tabMarks`), so a worker that Chrome stopped and started again still
 * knows a turn already shown.
 * @param {any} api
 * @param {{ turnDelay?: number, closeGrace?: number }} [opts]
 */
export function createTabMarker(api, { turnDelay = TURN_DELAY, closeGrace = CLOSE_GRACE } = {}) {
  /** @type {Map<any, { tabId: number | null, mark: TabMark | null, quote: string | null }>} */
  const ports = new Map();
  /** @type {Map<number, { quote: string | null, shown: TabMark | null }>} */
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
  // One change at a time per tab, in the order asked.
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
    if (!memo || memo.quote !== quote) memo = { quote, shown: null };
    all.set(tabId, memo);
    memo.shown = mark;
    await persist();
  });

  // The tab let go: no badge.
  const release = (tabId) => queue(tabId, async () => {
    const all = await load();
    const memo = all.get(tabId);
    const tab = await Promise.resolve(api.tabs.get(tabId)).catch(() => null);
    if (!tab) { all.delete(tabId); await persist(); return; }
    await badge(tabId, null);
    if (memo) memo.shown = null;
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
    api.tabs.onRemoved.addListener((tabId) => { tabRemoved(tabId); });
  };

  return { said, closed, tabRemoved, listen, idle: () => Promise.all([...queues.values()]) };
}
