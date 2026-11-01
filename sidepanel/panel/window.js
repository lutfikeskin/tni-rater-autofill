// The side panel: its own window (Pop out) and back to the side panel (Dock).
// One part of the panel; sidepanel.js wires the parts together.
import * as usage from '../usage-log.js';
import { inExtension, panelCopy, popped } from './env.js';
import { $, state } from './core.js';
import { issueSaid, renderSite, stopFill } from './coordinator.js';
import { stopRecording } from './dev-recording.js';

// ---------------------------------------------------------------------------------------------
// Its own window (Pop out) and back to the side panel (Dock)

// Pop out: the panel in a window of its own, which the agent can move anywhere (another monitor),
// where they last left it (panelWindow); this copy then gives way to it (onPanelMessage). Not while
// a fill runs: its report would have no panel to come back to. A place no screen shows now (a
// monitor unplugged) is left to Chrome.
async function popOut() {
  if (!inExtension || popped) return;
  // An answer going in (a fill, a pick from a row, an AI answer) may not have rendered the button
  // disabled: said rather than nothing done.
  if (state.filling) { windowProblem('Wait for the answers going in to finish, then try again.'); return; }
  windowProblem(null);
  const { panelWindow: was = {} } = await chrome.storage.local.get('panelWindow').catch(() => ({}));
  const size = (k, min, fallback) => (Number.isInteger(was[k]) && was[k] >= min ? was[k] : fallback);
  const opts = { url: chrome.runtime.getURL('sidepanel/sidepanel.html?window=popup'), type: 'popup', focused: true, width: size('width', 320, 420), height: size('height', 480, 860) };
  const place = Number.isInteger(was.left) && Number.isInteger(was.top) ? { left: was.left, top: was.top } : null;
  try {
    await chrome.windows.create(place ? { ...opts, ...place } : opts);
  } catch {
    try { await chrome.windows.create(opts); } catch { windowProblem('The panel couldn’t open in its own window.'); }
  }
}

// Dock: back to Chrome's side panel, in the browser window of the quote, and this window closes.
// sidePanel.open needs the click's own gesture: it is called before anything is awaited. The side
// panel says it opened and this window gives way to it, handing over (giveWay); closed here if
// that hasn't happened in 5 s.
function dock() {
  if (!popped) return;
  const windowId = state.tab?.windowId ?? state.browserWindow;
  if (state.filling) { windowProblem('Wait for the answers going in to finish, then try again.'); return; }
  if (!Number.isInteger(windowId)) { windowProblem('Click into the quote’s Chrome window, then try again.'); return; }
  windowProblem(null);
  chrome.sidePanel.open({ windowId }).then(() => setTimeout(() => { if (!state.closing) closeSelf(); }, 5000),
    () => windowProblem('The side panel couldn’t open here. Use the extension’s icon in the toolbar.'));
}

// A Pop out or Dock that didn't work, said at the top of the panel (and to screen readers); the
// next try clears it.
function windowProblem(text) {
  state.notes = { ...state.notes, window: text ? issueSaid({ tone: 'warn', role: 'alert', title: text }) : null };
  $('window-note').hidden = !text;
}

// The panel in its own window is the only copy, so no page is filled from two: it follows the tab
// a side panel shows. Each copy says when it opens, and where one of the two is in its own window,
// the older gives way. Side panels of two browser windows each follow their own tab, as before. A
// copy that hears from an older one says so again, for one that opened before it listened.
function announceCopy() {
  if (inExtension) chrome.runtime.sendMessage({ ra: 'panel', event: 'opened', ...panelCopy, popped }).catch(() => {});
}
function onPanelMessage(msg) {
  if (msg?.ra !== 'panel' || msg.id === panelCopy.id) return;
  if (msg.event === 'handoff') { if (msg.to === panelCopy.id) takeOver(msg); return; }
  if (msg.event !== 'opened' || !(popped || msg.popped)) return;
  const newer = msg.at > panelCopy.at || (msg.at === panelCopy.at && msg.id > panelCopy.id);
  if (newer) giveWay(msg.id); else announceCopy();
}

// This copy gives way to a newer one (`to`): a fill it runs is stopped first (the answer going in
// finishes; nothing more is filled or clicked), and what is underway (that fill's end, an answer
// the agent picked, an AI answer) finishes, for up to 15 s, nothing new starting (state.closing).
// It then hands over what it knows of the tabs and closes.
async function giveWay(to) {
  if (state.closing) return;
  state.closing = true;
  if (state.fillingFor && !state.fillingFor.stopping) await stopFill();
  for (const end = Date.now() + 15000; state.filling && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  // The copy taking over doesn't take up a recording: this one saves it, with its last events.
  if (state.recording) await stopRecording('The panel moved, so the recording stopped.');
  await handOver(to);
  closeSelf();
}

// What this copy knows of the quote's tabs that only its memory holds, for the copy taking over:
// each tab's step, a stop screen read there (GEICO's USDOT screen), its quote's state, and that
// its layouts may be taken. The new copy keeps what it learned itself, for the same intake only.
function handOver(to) {
  if (!inExtension) return Promise.resolve();
  return chrome.runtime.sendMessage({ ra: 'panel', event: 'handoff', id: panelCopy.id, to, intakeId: usage.currentSession()?.intakeId ?? null,
    tabSteps: [...state.tabSteps], stopScreens: [...state.stopScreens], quoteStates: [...state.quoteStates], layoutReadyTabs: [...state.layoutReadyTabs] }).catch(() => {});
}
function takeOver(msg) {
  const intakeId = usage.currentSession()?.intakeId;
  if (!intakeId || msg.intakeId !== intakeId) return;
  for (const name of ['tabSteps', 'stopScreens', 'quoteStates']) {
    for (const [tabId, value] of msg[name] ?? []) if (!state[name].has(tabId)) state[name].set(tabId, value);
  }
  for (const tabId of msg.layoutReadyTabs ?? []) state.layoutReadyTabs.add(tabId);
  if (state.tab) renderSite();
}

// Closes this copy of the panel: its own window, the tab it was opened in (a harness opens it as a
// page), or Chrome's side panel (sidePanel.close from Chrome 141; before it, the page closes itself).
async function closeSelf() {
  const mine = await chrome.windows.getCurrent().catch(() => null);
  if (popped) {
    if (mine) chrome.windows.remove(mine.id).catch(() => {});
    return;
  }
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  else if (mine && chrome.sidePanel?.close) chrome.sidePanel.close({ windowId: mine.id }).catch(() => window.close());
  else window.close();
}

// Popped out: where the agent leaves the window and its size, for the next Pop out. Maximized,
// minimized or full screen, it isn't kept: the next one opens as the window was before.
async function keepPlace() {
  const mine = await chrome.windows.getCurrent().catch(() => null);
  if (!mine) return;
  chrome.windows.onBoundsChanged?.addListener((win) => {
    if (win.id === mine.id && (win.state ?? 'normal') === 'normal') chrome.storage.local.set({ panelWindow: { left: win.left, top: win.top, width: win.width, height: win.height } }).catch(() => {});
  });
}

export { announceCopy, dock, keepPlace, onPanelMessage, popOut };
