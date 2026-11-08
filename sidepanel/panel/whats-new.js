// The side panel: "What's new in vX", said once per version (audit 2026-11-07, UX-12 c). The lines are
// src/whats-new.js's; the version last said is kept in chrome.storage.local (`whatsNewSeen`), which
// background.js sets to the version installed on a new install, so a new agent isn't told what
// changed since a version they never had.
// One part of the panel; sidepanel.js calls showWhatsNew as the panel opens.
import { whatsNewSince } from '../../src/whats-new.js';
import { inExtension } from './env.js';
import { state } from './core.js';
import { issueSaid } from './coordinator.js';

const SEEN_KEY = 'whatsNewSeen';

// Says what's new since the version last said, in #whats-new (state.notes.whatsNew), and marks this
// version said at once: the card stays until Got it or the panel closes, and isn't said again. A
// version with nothing new is marked said without a card. Storage that can't be read or written says
// nothing (the card is a courtesy, never in the way).
async function showWhatsNew() {
  if (!inExtension) return;
  try {
    const version = chrome.runtime.getManifest().version;
    const { [SEEN_KEY]: seen = null } = await chrome.storage.local.get(SEEN_KEY);
    if (seen === version) return;
    const entries = whatsNewSince(seen, version);
    await chrome.storage.local.set({ [SEEN_KEY]: version });
    if (!entries.length) return;
    state.notes = { ...state.notes, whatsNew: whatsNewCard(version, entries) };
  } catch (e) {
    console.warn("what's new not shown:", e?.message ?? e);
  }
}

// The card: this version's lines, then each earlier version's under its name.
function whatsNewCard(version, entries) {
  const notes = entries.flatMap((e) => (e.version === version ? e.lines : [`In v${e.version}:`, ...e.lines]));
  return issueSaid({ tone: 'info', title: `What's new in v${version}`, notes,
    actions: [{ label: 'Got it', className: 'ghost small-btn', onClick: () => { state.notes = { ...state.notes, whatsNew: null }; } }] });
}

export { showWhatsNew, whatsNewCard };
