// The side panel: the developer recording (docs/developer-recording.md).
// One part of the panel; sidepanel.js wires the parts together.
import { redactionTerms } from '../../src/plan.js';
import { redactor, knownStep } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { recordingId, stampEvents, newManifest } from '../../src/recording.js';
import { RecordingStore } from '../recording.js';
import { $, state } from './core.js';
import { ensureRecorder } from './usage.js';

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
  const s = Math.floor((Date.now() - rec.started) / 1000);
  devrecSaid(`Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${rec.store.count} events${rec.store.durable ? '' : '. Kept in memory only: closing the panel loses it'}.`);
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
  const manifest = newManifest({ id: recordingId(carrier.id, scenario, started), carrier: carrier.id, scenario, started,
    build: usage.build(), intake: usage.currentSession()?.intakeId ?? null, test: !!state.intake.test });
  const store = await RecordingStore.start(manifest);
  // `fills`: when fills ran ({ start, end }), noted by state.filling's setter.
  state.recording = { store, tabId, carrier, redact, fills: state.filling ? [{ start: started.getTime(), end: null }] : [], started: started.getTime(), timer: setInterval(renderDevrec, 1000), stopping: false };
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
  rec.store.add(events);
  sendResponse({ ok: true });
}

// The Note box, as a moment of the timeline ("waiting too long", "this is wrong").
function noteRecording() {
  const rec = state.recording;
  const text = rec?.redact($('capture-note').value.trim()).slice(0, 200);
  if (!rec || !text) return;
  rec.store.add([{ kind: 'note', t: Date.now(), frame: 0, text }]);
  $('capture-note').value = '';
}

async function stopRecording(why = '') {
  const rec = state.recording;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
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

export { noteRecording, onTraceMessage, recoverRecording, renderUnfinished, startRecording, stopRecording };
