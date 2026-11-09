// The side panel: the developer recording (docs/developer-recording.md).
// One part of the panel; sidepanel.js wires the parts together.
import { redactionTerms } from '../../src/plan.js';
import { redactor, knownStep } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { recordingId, stampEvents, newManifest } from '../../src/recording.js';
import { RecordingStore } from '../recording.js';
import { $, state, switchOn } from './core.js';
import { popped } from './env.js';
import { rulesFingerprint } from './coordinator.js';
import { fillDefaultsHash } from './agent-defaults/store.js';
import { ensureRecorder } from './usage.js';
import { runKit } from './fill.js';
import { planFor } from './plan-for.js';

// ---------------------------------------------------------------------------------------------
// Developer recording (docs/developer-recording.md): unpacked builds only. While it runs, the trace
// (src/content/trace.js) goes into the recorded tab with the recorder, and its events are stamped,
// redacted (labels, button words, choices, titles) and kept (sidepanel/recording.js) until Stop and
// save writes one zip to Downloads. Nothing of it is uploaded or logged.
// Its card in Settings is said as data (state.devrec; settings-view.jsx draws it): whether one runs,
// its line, and the unfinished recording to save.

function devrecSaid(text) {
  state.devrec = { ...state.devrec, status: text || null };
}

function renderDevrec() {
  const rec = state.recording;
  // Its buttons follow it, and Advanced's title says it, seen with Advanced folded too.
  state.devrec = { ...state.devrec, on: !!rec };
  if (!rec || rec.stopping) return;
  noteFollowed(rec);
  rec.store.beat();
  const s = Math.floor((Date.now() - rec.started) / 1000);
  const elapsed = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const away = rec.away ? ' The panel is on another tab: only the tab the recording began on is recorded, and what the quote does here is not.' : '';
  // A chunk the file system refused (a full disk, a quota) is in memory only: lost if the panel
  // closes, said rather than claimed durable (REC-15).
  const memoryOnly = !rec.store.durable ? '. Kept in memory only: closing the panel loses it'
    : rec.store.writeFailures ? `. ${rec.store.writeFailures} events kept in memory only (the browser refused to write them): closing the panel loses those` : '';
  devrecSaid(`Recording ${elapsed} · ${rec.store.count} events${memoryOnly}.${away}`);
  // The footer's pill while it runs, seen from the quote itself (REC-17).
  state.devrec = { ...state.devrec, pill: `${elapsed} · ${rec.store.count} events${rec.store.writeFailures || !rec.store.durable ? ' · memory only' : ''}` };
}

// The usage log's events, copied into the timeline as they are logged while the recording runs
// (REC-01): the fill's runs and each field's result and reason (fill_run, fill_field), the agent's
// edits, page layouts and the rest, as logged (already redacted, nothing more leaves the browser).
// Only this quote's (the recording's usage session), and only while the recording runs.
function copyUsage(rec) {
  return usage.onLogged((events, { t, session }) => {
    if (rec.stopping || state.recording !== rec) return;
    const mine = rec.store.manifest.session;
    if (mine && session !== mine) return;
    const at = Date.parse(t);
    rec.store.add(events.filter((/** @type {any} */ e) => e && typeof e.type === 'string').map((event) => ({ kind: 'usage', t: Number.isFinite(at) ? at : Date.now(), frame: 0, event })));
  });
}

// A moment of the timeline whose page matters (REC-05): a fill that ended with an answer failed,
// a question left for the agent or something holding Continue, and each note. The kit's capture
// of the recorded tab (as Alt+Shift+C saves it: the form as data, redacted, no typed text) goes
// into the recording as layouts/<n>.json, and a `moment` event names it. One at a time: one asked
// while another is being read is left out. It only reads the page, never while something is going
// in: a moment asked during a fill waits for its end, MOMENT_WAIT_MS at most, then says it couldn't.
const MOMENT_WAIT_MS = 60_000;
async function takeMoment(why, extra = {}) {
  const rec = state.recording;
  if (!rec || rec.stopping || rec.momentBusy) return;
  rec.momentBusy = true;
  const t = Date.now();
  try {
    // Never while something is going in: the page is read once the fill (or pick, or AI answer)
    // has ended, after the layouts already asked for, as the usage log's layouts are (captureLayout).
    for (const until = t + MOMENT_WAIT_MS; state.filling && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
    if (state.filling) throw Object.assign(new Error('still filling'), { name: 'StillFilling' });
    if (state.recording !== rec || rec.stopping) return;
    const record = state.intake?.record;
    const read = (state.layoutChain ?? Promise.resolve()).then(() => runKit(rec.tabId, rec.carrier, (p, r) => globalThis.__raterKit?.capture(p, r) ?? null,
      [record ? planFor(record, rec.carrier, state.active) : null, record ? redactionTerms(record) : []]));
    state.layoutChain = read.catch(() => {});
    const results = await read;
    const frames = results.map((r) => r.result).filter((f) => f && (f.controls?.length || f.isTopFrame || f.messages?.length || f.openLists?.length));
    const top = frames.find((f) => f.isTopFrame);
    if (state.recording !== rec || rec.stopping) return;
    const layout = { tool: 'tni-rater-autofill', kind: 'page-capture', version: 2, carrier: rec.carrier.id, capturedAt: new Date(t).toISOString(),
      scenario: rec.store.manifest.id, quote: null, n: rec.store.layouts + 1, note: why, page: top?.page ?? null, step: (rec.carrier.layoutSteps && top?.step) || null, view: null, context: null, frames };
    const name = await rec.store.addLayout(layout);
    rec.store.add([{ kind: 'moment', t, frame: 0, why, layout: name, fields: frames.reduce((n, f) => n + (f.controls?.length ?? 0), 0), ...extra }]);
  } catch (e) {
    if (state.recording === rec) rec.store.add([{ kind: 'moment', t, frame: 0, why, layout: null, error: String(e?.name || 'Error').slice(0, 40), ...extra }]);
  } finally {
    rec.momentBusy = false;
  }
}

// The kit's fill ended (its `run` with `on` false): a moment when it left something to look at.
function momentAfterRun(events) {
  for (const e of events) {
    if (e.kind !== 'kit' || e.what !== 'run' || e.on !== false) continue;
    const said = [['failed', 'failed'], ['leftRequired', 'left for you'], ['blockers', 'holding Continue']].filter(([k]) => e[k] > 0).map(([k, words]) => `${e[k]} ${words}`);
    if (said.length) takeMoment(`fill ended: ${said.join(', ')}`);
  }
}

// The recording follows the one tab it began on (rec.tabId), whatever tab the panel follows (REC-04,
// 2026-11-07; W44-23: 4 of 10 recordings held nothing of the quote, which had moved to another tab).
// When the panel follows another tab, or comes back, the timeline says so (`panel`: `away`, and the
// tab followed, a tab number only), once each time, and the panel's line above says it while it lasts.
// Noted as the panel changes tab (refreshTab), so a move away and back between two of the line's
// renders is in the timeline too (review of PR #383).
function noteFollowed(rec = state.recording) {
  if (!rec || rec.stopping) return;
  const away = state.tab?.id !== rec.tabId;
  if (away === !!rec.away) return;
  rec.away = away;
  rec.store.add([{ kind: 'panel', t: Date.now(), frame: 0, away, followed: Number.isInteger(state.tab?.id) ? state.tab.id : null, recorded: rec.tabId }]);
}

// The recorded tab loaded a new document while the panel follows another one: the panel's own
// reinjection (ensureRecorder) is only for the tab it follows, so the trace goes in here, with the
// recorder whose readers it uses and the carrier's page adapter. It only watches (trace.js).
async function recordedTabUpdated(tabId, change) {
  const rec = state.recording;
  if (!rec || rec.stopping || tabId !== rec.tabId || change?.status !== 'complete' || state.tab?.id === tabId) return;
  const adapter = rec.carrier?.pageAdapter ? [rec.carrier.pageAdapter] : [];
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [...adapter, 'src/content/field-key.js', 'src/content/recorder.js', 'src/content/trace.js'] });
  } catch { /* not a page the extension may read now; the next load tries again */ }
}

// The recorded tab was closed: nothing more can be recorded, so the recording is saved, saying why.
function recordedTabRemoved(tabId) {
  const rec = state.recording;
  if (!rec || rec.stopping || tabId !== rec.tabId) return;
  rec.store.add([{ kind: 'panel', t: Date.now(), frame: 0, closed: true, recorded: rec.tabId }]);
  stopRecording('The recorded tab was closed.');
}

async function startRecording() {
  if (state.recording) return;
  if (!state.tab?.carrier) { devrecSaid('Open a carrier page to record.'); return; }
  // Labels and choices are redacted with the loaded intake's names and numbers, as captures are.
  if (!state.intake?.record) { devrecSaid('Load the intake first, so client details can be redacted from the timeline.'); return; }
  const { id: tabId, carrier } = state.tab;
  // A trace a closed panel left in the tab (alive for up to a minute) would be taken up as this
  // recording's, without its opening page and with events from before it: stopped first.
  await chrome.tabs.sendMessage(tabId, { ra: 'trace', cmd: 'stop' }).catch(() => {});
  const redact = redactor(redactionTerms(state.intake.record));
  const scenario = redact($('capture-scenario').value.trim()).slice(0, 60) || 'unnamed';
  const started = new Date();
  // What the run needs to be reproduced (REC-10): the session to join the usage log by, the rules
  // and the agent's defaults it fills with, the filling switches, the platform.
  // navigator.userAgentData, where Chrome gives it, isn't in TypeScript's DOM types.
  /** @type {Navigator & { userAgentData?: { platform?: string } }} */
  const nav = navigator;
  const manifest = newManifest({ id: recordingId(carrier.id, scenario, started), carrier: carrier.id, scenario, started,
    build: usage.build(), intake: usage.currentSession()?.intakeId ?? null, test: !!state.intake.test,
    session: usage.currentSession()?.id ?? null, rules: rulesFingerprint(), defaultsHash: fillDefaultsHash() ?? null,
    settings: { autoAdvance: switchOn('autoAdvance', 'auto-advance'), autoFollowUps: switchOn('autoFollowUps', 'auto-followups'), autoPages: switchOn('autoPages', 'auto-pages'),
      checkBeforeContinue: switchOn('checkBeforeContinue', 'check-continue') },
    platform: nav.userAgentData?.platform || nav.platform || null });
  const store = await RecordingStore.start(manifest);
  // `fills`: when fills ran ({ start, end, what }), noted by state.filling's setter.
  state.recording = { store, tabId, carrier, redact, fills: state.filling ? [{ start: started.getTime(), end: null, what: state.fillingKind ?? 'fill' }] : [], started: started.getTime(), timer: setInterval(renderDevrec, 1000), stopping: false, momentBusy: false };
  state.recording.untap = copyUsage(state.recording);
  // Started during a fill: its start is the recording's, so the timeline counts that fill as one
  // (its end alone would be no fill at all to the report).
  if (state.filling) store.add([{ kind: 'fill', t: started.getTime(), frame: 0, on: true, what: state.fillingKind ?? 'fill' }]);
  renderDevrec();
  await ensureRecorder();
}

// Answered, so the trace knows the batch was taken: one it can't deliver it keeps and sends again.
function onTraceMessage(msg, sender, sendResponse) {
  const rec = state.recording;
  if (msg?.ra !== 'trace' || !rec || sender.tab?.id !== rec.tabId) return;
  const frame = sender.frameId ?? 0;
  const fillingAt = (t) => rec.fills.some((f) => t >= f.start && (f.end == null || t <= f.end));
  const events = stampEvents(msg.events, { frame, fillingAt, redact: rec.redact, stepName: (s) => knownStep(rec.carrier, s) ?? null });
  // What the trace couldn't keep while no panel took its events (closed, reloading).
  if (msg.dropped > 0) events.push({ kind: 'gap', t: Date.now(), frame, dropped: msg.dropped });
  // Which trace and recorder wrote them (REC-10), the top frame's first word on it kept.
  const versions = rec.store.manifest?.versions;
  if (versions && frame === 0 && versions.trace == null && Number.isInteger(msg.v)) {
    versions.trace = msg.v;
    versions.recorder = Number.isInteger(msg.recorder) ? msg.recorder : null;
  }
  rec.store.add(events);
  momentAfterRun(events);
  sendResponse({ ok: true });
}

// A note as a moment of the timeline ("waiting too long", "this is wrong"), with the page as it is
// then: Settings' Note box, or the footer pill's own (`text`, REC-17).
function noteRecording(text = null) {
  const rec = state.recording;
  const box = text == null ? $('capture-note') : null;
  const said = rec?.redact(String(text ?? box?.value ?? '').trim()).slice(0, 200);
  if (!rec || !said) return false;
  rec.store.add([{ kind: 'note', t: Date.now(), frame: 0, text: said }]);
  if (box) box.value = '';
  takeMoment('note', { note: said });
  return true;
}

// An Alt+Shift+C capture taken while recording: a note naming its file, so the capture and the
// recording share one timeline (REC-17).
function noteCaptured(file) {
  const rec = state.recording;
  if (!rec || rec.stopping || !file) return;
  rec.store.add([{ kind: 'note', t: Date.now(), frame: 0, text: `capture ${String(file).slice(0, 160)}`, capture: String(file).slice(0, 160) }]);
}

// Alt+Shift+R (manifest "commands"): starts a recording, or stops and saves the one running. The
// shortcut reaches every window's panel: only the focused window's acts, as for Alt+Shift+C.
// Popped out, the panel is the only copy and acts wherever focus is.
async function toggleRecording() {
  if (!popped) {
    const [mine, focused] = await Promise.all([chrome.windows.getCurrent(), chrome.windows.getLastFocused()]).catch(() => [null, null]);
    if (mine && focused && mine.id !== focused.id) return;
  }
  return state.recording ? stopRecording() : startRecording();
}

// The unfinished recording's Discard: removes its copy from the browser, which can't be undone,
// once the developer says so (REC-15). Never one another panel is recording (unfinished leaves
// those out). Asked in the panel, never in a browser dialog (#463): the first Discard says what it
// deletes, and a second one for the same recording deletes it.
async function discardUnfinished() {
  const unfinished = state.devrec?.unfinished;
  const id = unfinished?.id;
  if (!id) return;
  if (!unfinished.discardAsked) {
    unfinished.discardAsked = true;
    devrecSaid(`Discard again to delete the unfinished recording ${id} from this browser. It is not saved anywhere else, and this can't be undone.`);
    return;
  }
  try {
    await (await RecordingStore.reopen(id)).discard();
    devrecSaid(`Deleted the unfinished recording ${id}.`);
  } catch (e) {
    devrecSaid(e?.name === 'NotFoundError' ? 'That recording is no longer in this browser: another panel already saved it.' : `Couldn't delete it: ${e.message}`);
  }
  await renderUnfinished();
}

async function stopRecording(why = '') {
  const rec = state.recording;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
  rec.untap?.();
  state.devrec = { ...state.devrec, pill: null };
  devrecSaid('Saving the recording…');
  // The trace sends what it holds, then stops; its last batch is taken before the store closes.
  await chrome.tabs.sendMessage(rec.tabId, { ra: 'trace', cmd: 'stop' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
  state.recording = null;
  renderDevrec();
  await saveRecording(rec.store, why);
}

async function saveRecording(store, why = '') {
  try {
    const { blob, events } = await store.zip();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    Object.assign(link, { href: url, download: `recording-${store.manifest.id}.zip` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    await store.discard();
    devrecSaid(`${why ? `${why} ` : ''}Saved recording-${store.manifest.id}.zip (${events} events) to Downloads. It shows the client as the page did: keep it in layouts/recordings/, never in git.`);
  } catch (e) {
    devrecSaid(`Couldn't save the recording: ${e.message}. ${store.durable ? 'It stays in the browser: save it from here later.' : 'It was kept in memory only, so it is lost.'}`);
  }
  await renderUnfinished();
}

// A recording a closed or reloaded panel left unsaved: saved from here, newest first.
async function renderUnfinished() {
  const left = (await RecordingStore.unfinished().catch(() => [])).filter((m) => m.id !== state.recording?.store.manifest.id);
  // Its button: the newest one's id, and how many are left (null: none).
  state.devrec = { ...state.devrec, unfinished: left.length
    ? { id: left[0].id, label: left.length > 1 ? `Save ${left.length} unfinished recordings, one by one` : 'Save the unfinished recording' }
    : null };
}

async function recoverRecording() {
  const id = state.devrec?.unfinished?.id;
  if (!id) return;
  try { await saveRecording(await RecordingStore.reopen(id), 'From a panel closed while recording:'); } catch (e) {
    // Gone from the browser since the button was drawn: another panel (the side panel and its
    // popped-out window) saved it, which removes it from the store (the maintainer, 2026-10-26:
    // "Couldn't open it: A requested file or directory could not be found", and the button
    // stayed). The button is drawn again from what is left.
    devrecSaid(e?.name === 'NotFoundError' ? 'That recording is no longer in this browser: another panel already saved it.' : `Couldn't open it: ${e.message}`);
    await renderUnfinished();
  }
}

export { discardUnfinished, noteCaptured, noteFollowed, noteRecording, onTraceMessage, recordedTabRemoved, recordedTabUpdated, recoverRecording, renderUnfinished, startRecording, stopRecording, takeMoment, toggleRecording };
