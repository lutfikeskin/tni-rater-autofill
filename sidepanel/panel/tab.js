// The side panel: the current tab.
// One part of the panel; sidepanel.js wires the parts together.
import { carrierForUrl } from '../../src/carriers.js';
import { inExtension, popped } from './env.js';
import { restoreAgentKeys, restoreDoneActions, restoreReports, retireAiOrigins, state } from './core.js';
import { firstUnits } from './intake.js';
import { renderPickers } from './record.js';
import { ensureRecorder, pageOf } from './usage.js';
import { renderSite, scheduleLayout, seedQuoteState } from './coordinator.js';

// ---------------------------------------------------------------------------------------------
// The current tab

// A tab finished loading or changed address. The followed tab, but also the active one: Progressive
// opens the quote in a new tab, which is still loading (no rater address yet) when it becomes
// active, so the panel kept following the old portal tab in the background.
function onTabUpdated(id, change, tab) {
  if ((id === state.tab?.id || tab?.active) && (change.url || change.status === 'complete')) refreshTab();
}

// The tab the panel looks at: as a side panel, the active tab of its own browser window; popped
// out, of the browser window the agent last used (the panel's own window has no quote tab).
async function tabInView() {
  if (!popped) return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return win ? (await chrome.tabs.query({ active: true, windowId: win.id }))[0] : undefined;
}

async function refreshTab() {
  if (!inExtension) { state.tab = null; return renderSite(); }
  const tab = await tabInView();
  if (Number.isInteger(tab?.windowId)) state.browserWindow = tab.windowId;
  // During a quote the agent may look at another site (email, the intake PDF): the panel stays
  // on the tab of the quote and keeps filling it in the background. Another rater tab is followed.
  const activeIsRater = !!(tab?.url && carrierForUrl(tab.url));
  if (!activeIsRater && state.intake && state.tab?.carrier && tab?.id !== state.tab.id) {
    const quote = await chrome.tabs.get(state.tab.id).catch(() => null);
    const carrier = quote?.url ? carrierForUrl(quote.url) : null;
    if (carrier) {
      state.tab = { id: quote.id, url: quote.url, carrier, background: true, windowId: quote.windowId };
      renderSite();
      ensureRecorder();
      scheduleLayout(pageOf(state.tab.url), 'arrived');
      return;
    }
  }
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

export { onTabUpdated, refreshTab };
