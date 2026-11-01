// The side panel: loading the intake PDF.
// One part of the panel; sidepanel.js wires the parts together.
import * as pdfjs from '../../lib/pdf.min.mjs';
import { readIntakeFields, readIntakePlaces } from '../../src/intake.js';
import { normalizeIntake } from '../../src/normalize.js';
import { redactionTerms } from '../../src/plan.js';
import { intakeSummary, intakeProfile, agentSettingsEvent, platformOf, redactor } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { $, discardAiSuggestions, doneRestored, persistAiPending, pruneAgentRecords, restoreAiPending, state, store, testIntakes } from './core.js';
import { firstView, render } from './record.js';
import { refreshTab } from './tab.js';
import { cancelLayouts, dropReports, holdLayouts, resetViews, viewOf } from './coordinator.js';
import { stopRecording } from './dev-recording.js';
import { reviewIntake } from './assistant.js';
import { uploadNow } from './usage-panel.js';
import { clientNote, keepPdf, workSaid } from './pdf-view.js';

// ---------------------------------------------------------------------------------------------
// Loading the intake PDF

// `reset`: the same intake loaded again for a new quote (newQuote), not a file the agent chose.
async function loadFile(file, { reset = false } = {}) {
  $('load-error').hidden = true;
  if (!file || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return showLoadError('That is not a PDF.');
  }
  let raw;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    raw = await readIntakeFields(pdfjs, bytes.slice());
  } catch (e) {
    return showLoadError(`Couldn't read that PDF (${e.message}).`, file.name);
  }
  if (!Object.keys(raw).length) {
    return showLoadError('No fillable fields: it looks like a scan or printed copy. Ask for the fillable TNI application.', file.name);
  }
  const result = normalizeIntake(raw);
  if (result.error) return showLoadError(result.error, file.name);
  const summary = await intakeSummary(bytes, raw, result);
  const test = (await testIntakes.get()).includes(summary.intakeId);
  // Where each answer is on the PDF, so check items and filled answers can be shown on it. A PDF
  // pdf.js reads the fields of but not their places just has no "See in PDF".
  const places = await readIntakePlaces(pdfjs, bytes.slice()).catch(() => null);
  // The same PDF again (to see it in the panel again, or by mistake): the agent's work on it stays.
  const same = state.intake && usage.currentSession()?.intakeId === summary.intakeId ? state.intake : null;
  if (profileTimer) logProfile();
  if (state.intake) usage.log({ type: 'intake_closed', reason: reset ? 'reset' : 'replaced' });
  // A recording ends with its client (redacted with that client's names), as on clearing it.
  if (state.recording && !same) await stopRecording('Another client was loaded, so the recording stopped.');
  clearTimeout(state.autoTimer);
  state.autoDrawn = null;
  state.autoPending = false;
  state.autoPaused = false;
  state.tabSessions.clear();
  state.autoPages = new Set();
  state.agentKeys = new Map();
  state.labels = new Map();
  state.choices = new Map();
  state.visitedPages = new Set();
  state.doneSteps = new Set();
  state.advanceRetried = new Set();
  state.assistPage = null;
  state.layoutErrors = 0;
  cancelLayouts();
  holdLayouts();
  resetViews();
  // agentEdited: the fields the agent edited in the panel, saved with the intake so a derived one
  // among them (radius miles, years in business) stays theirs after the panel reopens.
  // test: a test run, not a client's quote (marked before on this computer, or by the agent now).
  state.intake = { ...result, fileName: file.name, done: [], agentEdited: [], places, test };
  if (same) keepWork(state.intake, same);
  state.view = firstView(state.intake);
  state.filter = 'all';
  state.aiDocks = new Map();
  state.pastKey = null;
  state.detailsOpen = false;
  state.settingsOpen = false;
  state.fileConfirm = null;
  state.pdf = null;
  dropReports();
  const work = same ? workSaid(same.agentEdited?.length ?? 0, same.done?.length ?? 0) : '';
  clientNote(same ? `${reset ? 'New quote with the same intake' : 'Same intake'}${work ? `: you ${work}, and that stays` : ''}.` : null);
  await keepPdf(bytes);
  state.active = firstUnits();
  state.activeTab = null;
  state.filled = new Map();
  state.doneActions = new Set();
  state.unitForms = { vehicles: {}, drivers: {}, trailers: {} };
  state.unitNamed = null;
  state.unitShown = null;
  state.unreadRetried = false;
  state.triedAgain = null;
  doneRestored.clear(); // every tab set was reset; retained helpers must rehydrate for this intake
  discardAiSuggestions();
  await store.set('session', usage.startSession(summary.intakeId));
  await persistAiPending();
  await restoreAiPending();
  // This intake's edit keys and helper records (also a PDF dropped again) are restored per tab by
  // refreshTab; the panel's own sets and restoration markers were reset above.
  await pruneAgentRecords(summary.intakeId);
  usage.log({ type: 'intake_loaded', ...summary, ...(test ? { test: true } : {}), platform: platformOf() });
  await logSettings('intake');
  logProfile();
  uploadNow();
  await save();
  render();
  refreshTab();
  reviewIntake();
}

// What a problem report is about: the tab's vehicle, driver or trailer (`view`), and the last fill
// on that tab and page within half an hour (its `run`, `step`, what held Continue, and how long ago
// in seconds), so the review joins the agent's words to what the fill did.
function problemContext(tab, page) {
  if (!tab?.id || !page || !state.intake) return {};
  const last = state.lastRuns?.get(`${tab.id}|${page}`);
  const fresh = last && Date.now() - last.at <= 30 * 60 * 1000;
  return {
    ...(tab.carrier ? { view: viewOf(tab.id, page, tab.carrier) } : {}),
    ...(fresh ? { run: last.run, ...(last.step ? { step: last.step } : {}), blockerList: last.blockers, since: Math.round((Date.now() - last.at) / 1000) } : {}),
  };
}

// The agent's settings, logged whole: when an intake is loaded, when the panel opens on a saved
// one, and when one changes (agentSettingsEvent). Practice pages are no exception: settings
// belong to the agent, not to a page.
// A change with no intake and session open belongs to no quote, so it is not logged. A failure
// here must never reach the caller: the handlers do not await it.
async function logSettings(reason, changed) {
  try {
    if (reason === 'changed' && !(state.intake && usage.currentSession())) return;
    const saved = await usage.settings();
    usage.log(agentSettingsEvent(saved, { overwrite: !!$('overwrite')?.checked, reason, changed, centralServer: usage.DEFAULT_SERVER }));
  } catch { /* the settings log is best effort */ }
}

// The client's business as the intake and the agent's corrections describe it, never who the
// client is (intakeProfile): logged when the intake is loaded, PROFILE_DELAY after the agent's last
// correction, and when the panel opens on a saved intake, each time only when it differs from the
// one last logged for this intake (`profileLogged`, saved with it). One still waiting is logged
// before the intake is replaced or cleared, so it stays with its own quote. True when it logged one.
const PROFILE_DELAY = 15_000;
let profileTimer = null;
function logProfile() {
  clearTimeout(profileTimer);
  profileTimer = null;
  if (!state.intake || !usage.currentSession()) return false;
  try {
    const event = intakeProfile(state.intake.record, { redact: redactor(redactionTerms(state.intake.record)) });
    const json = JSON.stringify(event);
    if (json === state.intake.profileLogged) return false;
    state.intake.profileLogged = json;
    usage.log(event);
    return true;
  } catch { return false; /* the profile is best effort */ }
}
function profileLater() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => { if (logProfile()) save(); }, PROFILE_DELAY);
}

// The agent marks (or unmarks) the loaded intake as a test run: remembered for this PDF on this
// computer and logged, so the quote's events, already sent or still to come, are known as a test.
async function markTestRun(test) {
  if (!state.intake || !!state.intake.test === test) return;
  const intakeId = usage.currentSession()?.intakeId;
  state.intake.test = test;
  if (intakeId) {
    const list = (await testIntakes.get()).filter((id) => id !== intakeId);
    await testIntakes.set((test ? [...list, intakeId] : list).slice(-200));
  }
  usage.log({ type: 'intake_marked', test });
  await save();
}

// The agent's work on an intake loaded again from the same PDF: the record with their corrections
// (and what was derived from them), the items with their checks (checked by position, Luna's
// claims-box items included), Luna's claims-box review, and Add NTL done on its quote.
function keepWork(intake, was) {
  Object.assign(intake, { record: was.record ?? intake.record, warnings: was.warnings ?? intake.warnings, done: [...(was.done ?? [])], agentEdited: [...(was.agentEdited ?? [])],
    notesReview: was.notesReview ?? null, namesReview: was.namesReview ?? null, ntlAdded: !!was.ntlAdded });
}

// Why the PDF couldn't be read, under the drop zone (drawn by notes-view.jsx).
function showLoadError(msg, name = '') {
  state.loadError = { title: name ? `Couldn't read ${name}` : 'Couldn\'t read that file', text: msg };
  $('load-error').hidden = false;
}

async function save() {
  await store.set('intake', state.intake);
  await store.set('active', state.active);
  await store.set('activeTab', state.tab?.id ?? null);
}

// Vehicle 1, driver 1, trailer 1: where an intake, and a quote tab, starts.
function firstUnits() {
  return { drivers: 0, vehicles: 0, trailers: 0 };
}

export { firstUnits, loadFile, logProfile, logSettings, markTestRun, problemContext, profileLater, profileTimer, save };
