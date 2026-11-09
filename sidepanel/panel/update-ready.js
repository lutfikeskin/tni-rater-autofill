// @ts-check
// The side panel: "Update ready" (audit 2026-11-07, GAP-07). Chrome downloads a new version on its
// own schedule; with a listener on onUpdateAvailable it waits for the extension to reload instead of
// swapping it under an open panel. background.js keeps that version as `updateReady`, and the panel
// says so with Reload now, which reloads unless something holds it back (reloadHeldBy). A reload
// closes the panel and clears its session: the agent opens it again from the toolbar. The flag is
// dropped once the new version is installed (background.js onInstalled). Storage that can't be read
// says nothing.
// One part of the panel; sidepanel.js calls showUpdateReady as the panel opens.
import { compareVersions } from '../../src/whats-new.js';
import { inExtension } from './env.js';
import { state } from './core.js';
import { issueSaid } from './coordinator.js';

const KEY = 'updateReady';

// What holds a reload back: a fill running (a reload cuts it short), or the AI assistant still
// answering (its answer would be lost). Null when nothing does (the review of #505).
function reloadHeldBy() {
  if (state.filling) return 'A fill is running. Reload once it ends.';
  if (state.aiAsking?.size || state.notesAsking || state.namesAsking) return 'The AI assistant is still answering. Reload once it’s done.';
  return null;
}

// The card. With a client loaded it says what a reload costs: the panel's session goes, so the client
// is cleared from the panel; the agent's corrections and checks are kept on this computer for a day
// (src/kept-work.js, FLOW-17) and come back when the same PDF is dropped again.
/** @param {string} version @param {string | null} [held] */
function updateCard(version, held = null) {
  const text = held ?? (state.intake
    ? 'Reloading closes the panel and clears this client from it. Drop the same PDF again after: your corrections and checks come back.'
    : 'Reload now to use it. The panel closes; open it again from the toolbar.');
  return issueSaid({ tone: 'info', title: `Update ready: v${version}`, text,
    actions: [{ label: 'Reload now', className: 'small-btn', onClick: () => reloadNow(version) }] });
}

// Reloads the extension into the new version, unless something holds it back: then the card says why.
/** @param {string} version */
function reloadNow(version) {
  const held = reloadHeldBy();
  if (held) {
    state.notes = { ...state.notes, updateReady: updateCard(version, held) };
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

export { showUpdateReady, reloadHeldBy, reloadNow, updateCard };
