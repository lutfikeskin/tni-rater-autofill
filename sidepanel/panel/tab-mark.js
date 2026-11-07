// @ts-check
// The side panel: the quote's tab marked in the tab strip and on the toolbar icon. The panel says
// which carrier tab it works and the dock's mark there (markFor) to the service worker, which
// groups and badges the tab (src/tab-mark.js); and Settings' Mark the quote's tab, which asks for the
// optional tabGroups permission.
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
  const mark = onQuote ? markFor(dock) : null;
  if (mark === 'keep') return;
  const msg = { tabId: mark ? state.tab.id : null, mark, quote: usage.currentSession()?.id ?? null };
  if (last && last.tabId === msg.tabId && last.mark === msg.mark && last.quote === msg.quote) return;
  // Nothing marked and nothing to mark: nothing said (no worker woken for it).
  if (!last && msg.tabId == null) return;
  last = msg;
  post(msg);
}

// Settings → Filling → Mark the quote's tab: on while the extension has tabGroups. Asked for from the
// switch's own click (permissions.request needs it); off gives the permission back, and the worker
// takes the tab out of its group (the badge stays: it needs no permission).
async function readMarkSwitch() {
  if (!inExtension || !chrome.permissions) return;
  const on = await chrome.permissions.contains({ permissions: ['tabGroups'] }).catch(() => false);
  state.switches = { ...state.switches, markTab: on };
}
function markSwitch(on) {
  if (!inExtension || !chrome.permissions) { state.switches = { ...state.switches, markTab: false }; return; }
  const asked = on ? chrome.permissions.request({ permissions: ['tabGroups'] }) : chrome.permissions.remove({ permissions: ['tabGroups'] }).then(() => false);
  return asked.catch(() => false).then(() => readMarkSwitch());
}
// Granted or taken back elsewhere (chrome://extensions): the switch follows.
function watchMarkSwitch() {
  if (!inExtension || !chrome.permissions?.onAdded) return;
  chrome.permissions.onAdded.addListener(() => { readMarkSwitch(); });
  chrome.permissions.onRemoved.addListener(() => { readMarkSwitch(); });
}

export { markSwitch, markTab, readMarkSwitch, watchMarkSwitch };
