// @ts-check
// The side panel: "Update ready" (audit 2026-11-07, GAP-07). Chrome downloads a new version on its
// own schedule; with a listener on onUpdateAvailable it waits for the extension to reload instead of
// swapping it under an open panel. background.js keeps that version as `updateReady`, and the panel
// says so with Reload now, which reloads only while no fill runs (a reload cuts a fill short, and
// closes the panel: the agent opens it again from the toolbar). The flag is dropped once the new
// version is installed (background.js onInstalled). Storage that can't be read says nothing.
// One part of the panel; sidepanel.js calls showUpdateReady as the panel opens.
import { compareVersions } from '../../src/whats-new.js';
import { inExtension } from './env.js';
import { state } from './core.js';
import { issueSaid } from './coordinator.js';

const KEY = 'updateReady';

/** @param {string} version @param {boolean} [busy] */
function updateCard(version, busy = false) {
  return issueSaid({ tone: 'info', title: `Update ready: v${version}`,
    text: busy ? 'A fill is running. Reload once it ends.' : 'Reload now to use it. The panel closes; open it again from the toolbar.',
    actions: [{ label: 'Reload now', className: 'small-btn', onClick: () => reloadNow(version) }] });
}

// Reloads the extension into the new version, unless a fill runs: then the card says to wait.
/** @param {string} version */
function reloadNow(version) {
  if (state.filling) {
    state.notes = { ...state.notes, updateReady: updateCard(version, true) };
    return false;
  }
  chrome.runtime.reload();
  return true;
}

/** @param {unknown} version */
function say(version) {
  const now = chrome.runtime.getManifest().version;
  const ready = typeof version === 'string' && compareVersions(version, now) > 0 ? version : null;
  state.notes = { ...state.notes, updateReady: ready ? updateCard(ready) : null };
}

// Says an update that is ready as the panel opens, and one that becomes ready while it is open.
async function showUpdateReady() {
  if (!inExtension) return;
  try {
    say((await chrome.storage.local.get(KEY))[KEY]);
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && KEY in changes) say(changes[KEY].newValue); });
  } catch (e) {
    console.warn('update ready not shown:', e?.message ?? e);
  }
}

export { showUpdateReady, reloadNow, updateCard };
