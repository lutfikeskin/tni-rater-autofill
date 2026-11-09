// @ts-check
// A fill whose panel went away is stopped (audit 2026-11-07, UX-03). The fill engine runs in the
// carrier's page, so closing the side panel (or Chrome closing it, or the panel reloading) left it
// typing, and perhaps clicking Continue or a helper, with no live list, no Stop and no report.
//
// While a fill runs, the panel says its tab, run id and world over a port named 'fill-watch'
// (sidepanel/panel/fill-watch.js), and says it ended when it does. The service worker (background.js)
// runs a FillWatch: a port that disconnects while its fill runs means the panel went, and the worker
// stops that run as Stop does (the kit's stopRun: the answer going in finishes, nothing more is
// written or clicked). Only that run: a fill another panel copy began since is left alone. A port is
// let go only when the panel's document goes; a popped-out window that is minimized or hidden keeps
// its port, so its fill is not stopped (a timer on the page could not tell the two apart).

/** @import { WatchedRun } from '../types.js' */

/**
 * What the panel says over the port: the fill running, or none (`tabId: null`).
 * @param {any} msg
 * @returns {WatchedRun | null}
 */
export function watchedRun(msg) {
  if (!msg || !Number.isInteger(msg.tabId) || typeof msg.run !== 'string' || !msg.run) return null;
  return { tabId: msg.tabId, run: msg.run, world: msg.world === 'MAIN' ? 'MAIN' : 'ISOLATED' };
}

/**
 * The worker's side. `api`: chrome (runtime.onConnect, scripting.executeScript).
 * @param {any} api
 */
export function createFillWatch(api) {
  /** Stops one run in every frame of its tab. @param {WatchedRun} w */
  const stopRun = (w) => api.scripting.executeScript({ target: { tabId: w.tabId, allFrames: true }, world: w.world,
    func: (run) => globalThis.__raterKit?.stopRun?.(run) ?? false, args: [w.run] }).catch(() => { /* the tab closed or navigated: the fill ended with it */ });
  /** @param {any} port */
  const watch = (port) => {
    /** @type {WatchedRun | null} */
    let current = null;
    port.onMessage.addListener((msg) => { current = watchedRun(msg); });
    port.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      const w = current;
      current = null;
      if (w) stopRun(w);
    });
  };
  return {
    watch,
    stopRun,
    listen() { api.runtime.onConnect.addListener((port) => { if (port.name === 'fill-watch') watch(port); }); },
  };
}
