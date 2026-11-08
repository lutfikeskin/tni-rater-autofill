// @ts-check
// The side panel: the fill running, said to the service worker over a 'fill-watch' port, so it is
// stopped if this panel goes away while it runs (src/fill-watch.js; audit 2026-11-07, UX-03).
// watchFill (coordinator.js) says each fill as it begins and that it ended as it stops watching it.
// One part of the panel; coordinator.js uses it.
import { inExtension } from './env.js';

/** @type {chrome.runtime.Port | null} */
let port = null;
/** @type {{ tabId: number | null, run?: string, world?: string }} */
let said = { tabId: null };

function post() {
  if (!port) {
    // Nothing running and nothing to take back: no port (no worker woken for it).
    if (said.tabId == null) return;
    try { port = chrome.runtime.connect({ name: 'fill-watch' }); } catch { port = null; return; }
    // The worker stopped (Chrome stops an idle one) or reloaded: the fill still running is said to
    // the next one at once.
    port.onDisconnect.addListener(() => {
      port = null;
      void chrome.runtime.lastError;
      if (said.tabId != null) post();
    });
  }
  try { port.postMessage(said); } catch { port = null; }
}

/**
 * A fill begins (`run`: the panel's id for it) on a tab, in the carrier's world.
 * @param {string} run @param {number} tabId @param {'MAIN' | 'ISOLATED'} world
 */
function fillRunning(run, tabId, world) {
  if (!inExtension || !run || !Number.isInteger(tabId)) return;
  said = { tabId, run, world };
  post();
}

/** That fill ended (or this panel stopped watching it): nothing is stopped if the panel goes now. @param {string} run */
function fillEnded(run) {
  if (said.run !== run) return;
  said = { tabId: null };
  if (port) post();
}

export { fillEnded, fillRunning };
