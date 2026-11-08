// The side panel: loading the intake PDF.
// One part of the panel; sidepanel.js wires the parts together.
import * as pdfjs from '../../lib/pdf.min.mjs';
import { readIntakeFields, readIntakePlaces } from '../../src/intake.js';
import { normalizeIntake, rederive } from '../../src/normalize.js';
import { KEPT_WORK_PREFIX, checksOn, keptFresh, keptWorkOf } from '../../src/kept-work.js';
import { get, set } from '../../src/util.js';
import { ownerDrivesAnswered } from '../../src/answers/owner.js';
import { redactionTerms } from '../../src/plan.js';
import { intakeSummary, intakeProfile, agentSettingsEvent, platformOf, redactor } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { $, discardAiSuggestions, doneRestored, forgetKeptWork, keptWorkCleared, keptWorkLocal, persistAiPending, pruneAgentRecords, restoreAiPending, state, store, switchOn, testIntakes } from './core.js';
import { firstView, render } from './record.js';
import { refreshTab } from './tab.js';
import { cancelLayouts, dropReports, holdLayouts, resetViews, stopFillFirst, viewOf } from './coordinator.js';
import { stopRecording } from './dev-recording.js';
import { ntlAnswerEdited, ntlCargoEdited, ntlNotesItem, ntlPrimaryEdited, reviewIntake } from './assistant.js';
import { uploadNow } from './usage-panel.js';
import { clientNote, keepPdf, workSaid } from './pdf-view.js';
import { quoteStarting, refreshDefaults, settingsDefaults } from './agent-defaults/store.js';
import { settleQuoteEntries } from './quote-owner.js';

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
  // The intake changes from here: a fill running on any tab is stopped first and waited for
  // (stopFillFirst), and none starts until this intake is the panel's (`resetting`). Changes that
  // overlap (a Clear or another file during the wait, New quote's own load) each hold it
  // (`resetDepth`), so it lifts only when the last is done.
  state.resetDepth = (state.resetDepth ?? 0) + 1;
  state.resetting = true;
  try {
    await stopFillFirst();
    // The same PDF again (to see it in the panel again, or by mistake): the agent's work on it stays.
    const same = state.intake && usage.currentSession()?.intakeId === summary.intakeId ? state.intake : null;
    if (profileTimer) logProfile();
    if (state.intake) usage.log({ type: 'intake_closed', reason: reset ? 'reset' : 'replaced' });
    // A recording ends with its client (redacted with that client's names), as on clearing it.
    if (state.recording && !same) await stopRecording('Another client was loaded, so the recording stopped.');
    // A tab that went into a quote while the panel was closed did so before this intake (quote-owner.js).
    await settleQuoteEntries(async (id) => (await chrome.tabs.get(id)).url);
    clearTimeout(state.autoTimer);
    state.autoDrawn = null;
    state.autoPending = false;
    state.autoPaused = false;
    // A page the last intake's fill left to fill next (runPendingPage, new_fields): never this one's.
    state.pagePending = null;
    state.drawPending = null;
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
    // intakeId: whose quote a tab is (quote-owner.js), from the moment this intake is the panel's.
    state.intake = { ...result, fileName: file.name, done: [], agentEdited: [], places, test, intakeId: summary.intakeId };
    // agent defaults: nothing fills with the last quote's answer until this one is set up and asked.
    quoteStarting();
    if (same) keepWork(state.intake, same);
    // A new client's intake: the last client's kept corrections and checks go (FLOW-17). The same
    // PDF after a browser restart (no copy of it in the session): its own, from the last day, come back.
    await forgetKeptWork({ except: summary.intakeId });
    // A Clear that failed is tried again first; while it still fails only what was kept after it
    // comes back, and when that can't be known nothing does, nor is the kept copy saved over.
    const gate = same ? null : await keptWorkCleared();
    const restored = gate?.known ? await restoreKeptWork(state.intake, gate.after) : null;
    if (gate && !gate.known) holdKeptWork(state.intake.intakeId);
    state.view = firstView(state.intake);
    state.filter = 'all';
    state.aiDocks = new Map();
    state.pastKey = null;
    state.detailsOpen = false;
    state.settingsOpen = false;
    state.fileConfirm = null;
    state.pdf = null;
    dropReports();
    const work = same ? workSaid(same.agentEdited?.length ?? 0, same.done?.length ?? 0) : restored ? workSaid(restored.edits, restored.checks) : '';
    clientNote(same ? `${reset ? 'New quote with the same intake' : 'Same intake'}${work ? `: you ${work}, and that stays` : ''}.`
      : restored ? `Same intake as earlier: you ${work}, and that's back (kept on this computer for a day).` : null);
    await keepPdf(bytes);
    state.active = firstUnits();
    state.activeTab = null;
    state.filled = new Map();
    state.givenEarlier = new Map();
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
    // agent defaults: a new quote, asked again whose defaults it fills with.
    refreshDefaults();
  } finally {
    state.resetDepth -= 1;
    state.resetting = state.resetDepth > 0;
  }
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
    // agent defaults: the quote's own defaults once the agent answered whose they are.
    usage.log(agentSettingsEvent(saved, { overwrite: switchOn('overwrite', 'overwrite'), reason, changed, centralServer: usage.DEFAULT_SERVER, defaults: settingsDefaults() }));
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
// The agent's corrections and checks of this intake, kept on this computer (src/kept-work.js), put
// back on it as made in the panel: each corrected value set and marked the agent's, the values derived
// from it following (as agentEdit does), and each check found again marked done. Returns how many
// came back ({ edits, checks }), or null when nothing was kept for it within the day. `after`: only
// what was kept after then (a Clear that still fails: keptWorkCleared). A kept copy that can't be
// read is held (keptHeld): no save overwrites or deletes it.
const keptHeld = new Set();
const holdKeptWork = (intakeId) => { keptHeld.add(intakeId); };
async function restoreKeptWork(intake, after = -Infinity) {
  const key = `${KEPT_WORK_PREFIX}${intake.intakeId}`;
  let kept;
  try { kept = (await keptWorkLocal.get(key))?.[key]; } catch { keptHeld.add(intake.intakeId); return null; }
  keptHeld.delete(intake.intakeId);
  if (!kept) return null;
  if (!keptFresh(kept)) { await keptWorkLocal.remove([key]).catch(() => {}); return null; }
  if (!(kept.at > after)) return null;
  const edited = new Set(intake.agentEdited ?? []);
  for (const [path, value] of Array.isArray(kept.edits) ? kept.edits : []) {
    if (typeof path !== 'string' || !path) continue;
    set(intake.record, path, value);
    edited.add(path);
  }
  intake.agentEdited = [...edited];
  for (const path of edited) rederive(intake.record, path, { keep: edited });
  // The checks a correction raises (NTL with cargo, say) are raised again before the kept checks are
  // found, so a Looks right on one has it to land on.
  for (const path of edited) editChecks(intake, path);
  const back = checksOn(intake.warnings ?? [], kept.checks);
  const done = new Set([...(intake.done ?? []), ...back]);
  intake.done = [...done];
  // Looks right on "Does the owner drive?" answers it, as toggleDone does.
  for (const i of back) if (intake.warnings[i]?.code === 'drivers.owner-excluded') ownerDrivesAnswered(intake, { check: { i, done: true } });
  return edited.size || done.size ? { edits: edited.size, checks: done.size } : null;
}

// What a correction made in the panel does to the intake's checks (agentEdit), done again for one
// brought back: Owner drives answered, and the NTL items (the form's NTL note, NTL with primary auto
// liability, NTL with cargo, the notes' NTL item). Luna's reviews are asked as the intake loads.
function editChecks(intake, path) {
  if (path === 'applicant.ownerDrives') ownerDrivesAnswered(intake, { edit: path });
  if (['coverage.ntl', 'coverage.autoLiability'].includes(path)) { ntlAnswerEdited(intake, path); ntlPrimaryEdited(intake); }
  if (['coverage.ntl', 'coverage.cargo', 'coverage.autoLiability'].includes(path)) ntlCargoEdited(intake);
  if (path === 'claims.text' || path === 'notes.text') ntlNotesItem(intake);
}

// Each save keeps the agent's corrections and checks on this computer for a day from their last
// change (FLOW-17), or lets them go when there are none left. A save that changed neither (the
// vehicle picked, say) leaves their day as it was.
async function keepKeptWork(intake) {
  if (!intake?.intakeId || keptHeld.has(intake.intakeId)) return;
  const key = `${KEPT_WORK_PREFIX}${intake.intakeId}`;
  const kept = keptWorkOf(intake, get);
  try {
    if (!kept) { await keptWorkLocal.remove([key]); return; }
    const was = (await keptWorkLocal.get(key))?.[key];
    if (keptFresh(was) && JSON.stringify([was.edits, was.checks]) === JSON.stringify([kept.edits, kept.checks])) return;
    await keptWorkLocal.set({ [key]: kept });
  } catch { /* kept in the session as before */ }
}

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
  await keepKeptWork(state.intake);
  await store.set('active', state.active);
  await store.set('activeTab', state.tab?.id ?? null);
}

// Vehicle 1, driver 1, trailer 1: where an intake, and a quote tab, starts.
function firstUnits() {
  return { drivers: 0, vehicles: 0, trailers: 0 };
}

export { firstUnits, loadFile, logProfile, logSettings, markTestRun, problemContext, profileLater, profileTimer, save };
