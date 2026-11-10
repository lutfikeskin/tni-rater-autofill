// @ts-check
import { createTabMarker } from './src/tab-mark.js';
import { pruneKeptWork } from './src/kept-work.js';
import { createFillWatch } from './src/fill-watch.js';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// The extension's settings (the agent's OpenAI key, the upload token) stay with its own pages:
// content scripts on the carrier's pages (the recorder's isolated world) can't read
// chrome.storage.local once its access level is trusted contexts only. Chrome honours this for
// local storage from 140, the manifest's minimum (audit 2026-10-08); the recorder never reads
// storage, so nothing changes for it. The guard only keeps a failed call from stopping the
// worker. The same goes for what an organization's policy deployed (chrome.storage.managed: its
// upload token among them, usage-log.js managedSettings).
for (const area of ['local', 'managed']) {
  try {
    Promise.resolve(chrome.storage[area]?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }))
      .catch((e) => console.warn(`${area} storage access level not set:`, e?.message ?? e));
  } catch (e) {
    console.warn(`${area} storage access level not set:`, e?.message ?? e);
  }
}

// The quote's tab marked on the toolbar icon (a badge): what the panel says over its 'tab-mark'
// port, let go when the panel closes (src/tab-mark.js).
createTabMarker(chrome).listen();

// A fill whose panel went away (closed, or reloaded, while it ran) is stopped as Stop does: what
// the panel says over its 'fill-watch' port (src/fill-watch.js).
createFillWatch(chrome).listen();

// Where the panel's "What's new" card (sidepanel/panel/whats-new.js) starts: a new install has
// nothing new to be told, so from the version installed; an update with no version said yet (the
// panel not opened since this card came, perhaps over several updates) from the version updated
// from, so the card says every version since. A version already said is left as it is.
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  const from = reason === 'install' ? chrome.runtime.getManifest().version : reason === 'update' ? previousVersion : null;
  if (!from) return;
  chrome.storage.local.get('whatsNewSeen')
    .then(({ whatsNewSeen }) => (whatsNewSeen ? null : chrome.storage.local.set({ whatsNewSeen: from })))
    .catch((e) => console.warn("what's new start not saved:", e?.message ?? e));
});

// A new version Chrome has downloaded (audit 2026-11-07, GAP-07): with this listener Chrome waits for
// the extension to reload instead of swapping it under an open panel; the panel says it's ready, with
// Reload now (sidepanel/panel/update-ready.js). Dropped once a version is installed.
chrome.runtime.onUpdateAvailable.addListener(({ version }) => {
  chrome.storage.local.set({ updateReady: version }).catch((e) => console.warn('update ready not saved:', e?.message ?? e));
});
chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.remove('updateReady').catch(() => {}); });

// The agent's corrections and checks kept past their day (src/kept-work.js) are deleted as Chrome
// starts, whether or not the panel is opened.
chrome.runtime.onStartup.addListener(() => { pruneKeptWork(chrome.storage.local).catch((e) => console.warn('kept work not pruned:', e?.message ?? e)); });
