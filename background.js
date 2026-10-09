// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// The extension's settings (the agent's Anthropic key, the upload token) stay with its own pages:
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
