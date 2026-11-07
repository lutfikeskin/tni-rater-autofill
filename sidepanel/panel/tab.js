// The side panel: the current tab.
// One part of the panel; sidepanel.js wires the parts together.
import { carrierForUrl } from '../../src/carriers.js';
import { inExtension, popped } from './env.js';
import { restoreAgentKeys, restoreDoneActions, restoreReports, retireAiOrigins, state } from './core.js';
import { firstUnits } from './intake.js';
import { renderPickers } from './record.js';
import { ensureRecorder, pageOf } from './usage.js';
import { issueSaid, renderSite, scheduleLayout, seedQuoteState } from './coordinator.js';
import { noteQuoteTab } from './quote-owner.js';

// ---------------------------------------------------------------------------------------------
// The current tab

// A tab finished loading or changed address. The followed tab, but also the active one: Progressive
// opens the quote in a new tab, which is still loading (no rater address yet) when it becomes
// active, so the panel kept following the old portal tab in the background.
function onTabUpdated(id, change, tab) {
  // Any tab's new address: whose quote it is (quote-owner.js), the quote's tab or not.
  if (change.url) noteQuoteTab(id, change.url);
  if ((id === state.tab?.id || tab?.active) && (change.url || change.status === 'complete')) refreshTab();
}

// The tab the panel looks at: as a side panel, the active tab of its own browser window; popped
// out, of the browser window the agent last used (the panel's own window has no quote tab).
async function tabInView() {
  if (!popped) return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return win ? (await chrome.tabs.query({ active: true, windowId: win.id }))[0] : undefined;
}

// The panel has worked the tab it is on with this intake: a fill runs there, or one filled a page
// or clicked a button there. Its quote is under way.
function quoteUnderWay() {
  return (state.filling && state.fillingFor?.tabId === state.tab?.id) || state.autoPages.size > 0 || state.filled.size > 0 || state.doneActions.size > 0;
}

async function refreshTab() {
  if (!inExtension) { state.tab = null; return renderSite(); }
  const tab = await tabInView();
  if (Number.isInteger(tab?.windowId)) state.browserWindow = tab.windowId;
  // The tab the agent asked to quote on (quoteHere): followed this once.
  const moveTo = state.quoteMove;
  state.quoteMove = null;
  // During a quote the agent may look at another site (email, the intake PDF): the panel stays
  // on the tab of the quote and keeps filling it in the background. So it does for another rater's
  // tab once the quote is under way (the agent opens GEICO to look something up while Progressive
  // fills): that tab is only looked at, nothing is filled there, and its "Quote <carrier> here"
  // moves the quote to it. A tab the quote tab opened is the quote moving on (Progressive's home
  // page opens the quote in a new tab), and is followed.
  const activeIsRater = !!(tab?.url && carrierForUrl(tab.url));
  const hold = state.intake && state.tab?.carrier && tab?.id !== state.tab.id && (moveTo == null || tab?.id !== moveTo)
    && (!activeIsRater || (quoteUnderWay() && tab.openerTabId !== state.tab.id));
  if (hold) {
    const quote = await chrome.tabs.get(state.tab.id).catch(() => null);
    const carrier = quote?.url ? carrierForUrl(quote.url) : null;
    if (carrier) {
      state.tab = { id: quote.id, url: quote.url, carrier, background: true, windowId: quote.windowId };
      showHeldNote(activeIsRater ? { id: tab.id, carrier: carrierForUrl(tab.url), windowId: tab.windowId } : null);
      renderSite();
      ensureRecorder();
      scheduleLayout(pageOf(state.tab.url), 'arrived');
      return;
    }
  }
  showHeldNote(null);
  if (tab?.id !== state.tab?.id) {
    // `active`: each quote tab is on its own vehicle and driver (Continue is remembered per vehicle).
    const keys = ['filled', 'labels', 'choices', 'autoPages', 'autoPaused', 'unreadRetried', 'triedAgain', 'agentKeys', 'doneActions', 'unitForms', 'unitShown', 'visitedPages', 'doneSteps', 'assistPage', 'unitNamed', 'active'];
    if (state.tab?.id) state.tabSessions.set(state.tab.id, Object.fromEntries(keys.map((key) => [key, state[key]])));
    const previous = state.tabSessions.get(tab?.id);
    // A quote tab the panel has no record for starts on vehicle 1 and driver 1, never on the tab it
    // was on before (W43-37, 2026-10-22: Progressive's first driver form got the second driver's
    // details, the one last picked on GEICO). The panel's first tab after it opens keeps the
    // selection saved for that tab.
    const restored = !previous && state.activeTab === tab?.id;
    Object.assign(state, previous ?? {
      filled: new Map(), labels: new Map(), choices: new Map(), autoPages: new Set(), autoPaused: false, unreadRetried: false, triedAgain: null,
      agentKeys: new Map(), doneActions: new Set(), unitForms: { vehicles: {}, drivers: {}, trailers: {} }, unitShown: null, visitedPages: new Set(), doneSteps: new Set(), assistPage: null,
      unitNamed: null, active: restored ? { ...(state.savedActive ?? state.active) } : firstUnits(),
    });
    if (state.intake) renderPickers();
    clearTimeout(state.autoTimer);
    state.autoDrawn = null;
    state.autoPending = false;
  }
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null, background: false, windowId: tab.windowId } : null;
  // Whose quote the tab is, as the panel finds it (one it saw go into a quote, or out of one).
  noteQuoteTab(state.tab?.id, state.tab?.url);
  await restoreAgentKeys(state.tab?.id);
  await restoreDoneActions(state.tab?.id);
  await restoreReports(state.tab?.id);
  if (state.tab?.carrier && !state.filling) await retireAiOrigins({ tabId: state.tab.id, tabUrl: state.tab.url, intake: state.intake, carrier: state.tab.carrier });
  renderSite();
  ensureRecorder();
  // A recorder already in the page (the panel was closed or reloaded, or another tab was in
  // front) doesn't announce the page again: ask for its layout, and its quote state, here.
  scheduleLayout(pageOf(state.tab?.url), 'arrived');
  if (state.tab?.carrier?.quoteState) seedQuoteState(state.tab.id, state.tab.carrier, pageOf(state.tab.url));
}

// Another rater's tab in front while the panel keeps the quote tab (refreshTab): said above the
// page's answers, with the way to move the quote there and the way back. `other` is that tab
// ({ id, carrier, windowId }), or null when none is.
function showHeldNote(other) {
  state.lookingAt = other;
  if (!other) { state.cards = { ...state.cards, held: null }; return; }
  const quote = state.tab.carrier.name;
  const name = other.carrier?.name ?? 'another rater';
  const same = other.carrier?.id === state.tab.carrier.id;
  state.cards = { ...state.cards, held: issueSaid({ tone: 'info',
    title: same ? `Another ${name} tab is in front. The panel stays on this ${quote} quote.` : `${name} is in front. The panel stays on the ${quote} quote.`,
    text: `Its fills, follow-ups and Continue go on in the ${quote} tab. Nothing is filled on the tab in front.`,
    actions: [
      { label: same ? 'Quote on this tab' : `Quote ${name} here`, className: 'tinted', onClick: quoteHere },
      { label: `Back to ${quote}`, className: 'ghost', onClick: backToQuote },
    ] }) };
}

// "Quote <carrier> here": the quote moves to the rater tab in front, which the panel follows from
// now on. The quote tab keeps what it had (state.tabSessions); a fill running there finishes there.
function quoteHere() {
  if (!state.lookingAt) return;
  state.quoteMove = state.lookingAt.id;
  return refreshTab();
}

// "Back to <carrier>": the quote tab in front again, in its own window.
function backToQuote() {
  const { id, windowId } = state.tab ?? {};
  if (!Number.isInteger(id)) return;
  chrome.tabs.update(id, { active: true }).catch(() => {});
  if (Number.isInteger(windowId) && windowId !== state.lookingAt?.windowId) chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

export { onTabUpdated, quoteHere, refreshTab };
