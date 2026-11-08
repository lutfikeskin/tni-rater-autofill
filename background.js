// @ts-check
import { createTabMarker } from './src/tab-mark.js';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// The extension's settings (the agent's OpenAI key, the upload token) stay with its own pages:
// content scripts on the carrier's pages (the recorder's isolated world) can't read
// chrome.storage.local once its access level is trusted contexts only. Chrome honours this for
// local storage from 140, the manifest's minimum (audit 2026-10-08); the recorder never reads
// storage, so nothing changes for it. The guard only keeps a failed call from stopping the
// worker.
try {
  Promise.resolve(chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch((e) => console.warn('storage access level not set:', e?.message ?? e));
} catch (e) {
  console.warn('storage access level not set:', e?.message ?? e);
}

// The quote's tab marked in the tab strip (a titled group, with the tabGroups permission the agent
// gave in Settings) and on the toolbar icon (a badge): what the panel says over its 'tab-mark' port,
// let go when the panel closes (src/tab-mark.js).
createTabMarker(chrome).listen();

// A new install has nothing new to be told: the panel's "What's new" card (sidepanel/panel/whats-new.js)
// starts from the version installed. An update leaves it, so the panel says what changed once.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.storage.local.set({ whatsNewSeen: chrome.runtime.getManifest().version })
    .catch((e) => console.warn("what's new start not saved:", e?.message ?? e));
});
