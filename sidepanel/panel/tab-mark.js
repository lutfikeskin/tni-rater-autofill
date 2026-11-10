// @ts-check
// The side panel: the quote's tab marked on the toolbar icon. The panel says which carrier tab it
// works and the dock's mark there (markFor) to the service worker, which badges the tab
// (src/tab-mark.js).
// One part of the panel; sidepanel.js wires the parts together.
import { markFor } from '../../src/tab-mark.js';
import * as usage from '../usage-log.js';
import { inExtension } from './env.js';
import { state } from './core.js';

/** @type {chrome.runtime.Port | null} */
let port = null;
/** @type {{ tabId: number | null, mark: string | null, quote: string | null } | null} */
let last = null;
let retry = null;

function post(msg) {
  if (!port) {
    try {
      port = chrome.runtime.connect({ name: 'tab-mark' });
    } catch { port = null; return; }
    // The worker stopped (Chrome stops an idle one) or reloaded: said again to a new one, once a
    // second at most, while there is a tab to mark.
    port.onDisconnect.addListener(() => {
      port = null;
      void chrome.runtime.lastError;
      clearTimeout(retry);
      if (last?.tabId != null && !state.closing) retry = setTimeout(() => { if (!port && last) post(last); }, 1000);
    });
  }
  try { port.postMessage(msg); } catch { port = null; }
}

/**
 * The dock's word (dockFor) as the quote tab's mark, said to the worker when it changes: the carrier
 * tab in state.tab, with a client loaded; no tab (the one before is let go) otherwise. While the page
 * moves on after a Continue the panel clicked, the mark stays as it was.
 * @param {{ phase?: string, tone?: string }} dock
 */
function markTab(dock) {
  if (!inExtension || state.closing) return;
  const onQuote = !!(state.intake && state.tab?.carrier && Number.isInteger(state.tab.id));
  const quote = usage.currentSession()?.id ?? null;
  // A mark to keep only when this panel put one on this tab for this quote (markFor).
  const marked = !!(last?.mark && last.tabId === state.tab?.id && last.quote === quote);
  const mark = onQuote ? markFor(dock, marked) : null;
  if (mark === 'keep') return;
  const msg = { tabId: mark ? state.tab.id : null, mark, quote };
  if (last && last.tabId === msg.tabId && last.mark === msg.mark && last.quote === msg.quote) return;
  // Nothing marked and nothing to mark: nothing said (no worker woken for it).
  if (!last && msg.tabId == null) return;
  last = msg;
  post(msg);
}

export { markTab };
