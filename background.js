// @ts-check
import { createTabMarker } from './src/tab-mark.js';
import { pruneKeptWork } from './src/kept-work.js';

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

// The quote's tab marked in the tab strip (a titled group, with the tabGroups permission the agent
// gave in Settings) and on the toolbar icon (a badge): what the panel says over its 'tab-mark' port,
// let go when the panel closes (src/tab-mark.js).
createTabMarker(chrome).listen();

// The agent's corrections and checks kept past their day (src/kept-work.js) are deleted as Chrome
// starts, whether or not the panel is opened.
chrome.runtime.onStartup.addListener(() => { pruneKeptWork(chrome.storage.local).catch((e) => console.warn('kept work not pruned:', e?.message ?? e)); });
