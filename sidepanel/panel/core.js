// The side panel: its state, what it keeps in Chrome's storage, and the helpers every part uses.
// One part of the panel; sidepanel.js wires the parts together.
import { buildPlan, redactionTerms } from '../../src/plan.js';
import { clientErrorEvent, redactor } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { migrateStorage } from '../../src/storage-version.js';
import { DEFAULT_MODEL, POLICY_VERSION } from '../../src/ai/luna.js';
import { inExtension } from './env.js';
import { storeState } from './state-store.js';
import { firstUnits } from './intake.js';
import { pageOf } from './usage.js';
import { liveFrames, liveItems, refreshAnswers, renderReport, runKit, worldFor } from './fill.js';
import { editScope } from './scope.js';
import { answerItems, currentReportKey, reviewItems, stopNoteFor } from './report-model.js';

const memory = {};
const store = inExtension
  ? {
      get: async (k) => (await chrome.storage.session.get(k))[k],
      set: (k, v) => chrome.storage.session.set({ [k]: v }),
      remove: (k) => chrome.storage.session.remove(k),
      keys: () => storedKeys(chrome.storage.session),
    }
  : { get: async (k) => memory[k], set: async (k, v) => { memory[k] = v; }, remove: async (k) => { delete memory[k]; }, keys: async () => Object.keys(memory) };

// Automatic AI decisions must still be awaiting approval after the panel document reloads. Keep
// only opaque fingerprints plus the small page-level decision needed to show and approve them;
// provider keys, intake context, and raw page snapshots never enter this ledger.
const AI_PENDING_KEY = 'aiPendingDecisions';
const aiPendingStore = inExtension && globalThis.chrome?.storage?.local
  ? {
      get: async () => (await chrome.storage.local.get(AI_PENDING_KEY))[AI_PENDING_KEY] ?? [],
      set: (v) => chrome.storage.local.set({ [AI_PENDING_KEY]: v }),
    }
  : { get: async () => memory[AI_PENDING_KEY] ?? [], set: async (v) => { memory[AI_PENDING_KEY] = v; } };
// Intakes the agent marked as a test run (fingerprints, newest last, at most 200), kept on this
// computer so the same test PDF loaded again is marked again. The weekly review leaves their
// quotes out of its numbers (scripts/lib/signals.mjs).
const TEST_INTAKES_KEY = 'testIntakes';
const testIntakes = inExtension && globalThis.chrome?.storage?.local
  ? {
      get: async () => (await chrome.storage.local.get(TEST_INTAKES_KEY))[TEST_INTAKES_KEY] ?? [],
      set: (v) => chrome.storage.local.set({ [TEST_INTAKES_KEY]: v }),
    }
  : { get: async () => memory[TEST_INTAKES_KEY] ?? [], set: async (v) => { memory[TEST_INTAKES_KEY] = v; } };
// Tab ids can be reused after Chrome restarts. Local edit/helper records belong to the
// extension's current browser session, whose nonce survives panel reloads in storage.session.
const TAB_RECORDS_SESSION_KEY = 'tabRecordsSession';
let tabRecordsSessionReady = null;
function tabRecordsReady() {
  if (tabRecordsSessionReady) return tabRecordsSessionReady;
  const initialize = async () => {
    let nonce = (await chrome.storage.session.get(TAB_RECORDS_SESSION_KEY))[TAB_RECORDS_SESSION_KEY];
    if (!nonce) {
      nonce = crypto.randomUUID();
      await chrome.storage.session.set({ [TAB_RECORDS_SESSION_KEY]: nonce });
    }
    const local = chrome.storage.local;
    const previous = (await local.get(TAB_RECORDS_SESSION_KEY))[TAB_RECORDS_SESSION_KEY];
    if (previous !== nonce) {
      // Also expire legacy records without a nonce: their numeric tabs cannot be identified.
      await local.remove((await storedKeys(local)).filter((k) => k.startsWith(DONE_ACTIONS_PREFIX) || k.startsWith(UNIT_FORMS_PREFIX)));
      await local.set({ [AGENT_KEYS_KEY]: [], [TAB_RECORDS_SESSION_KEY]: nonce });
    }
  };
  // Two panels opening together must not create different nonces or clear each other's writes.
  tabRecordsSessionReady = navigator.locks.request('rater-tab-records-session', initialize).catch((e) => {
    tabRecordsSessionReady = null;
    throw e;
  });
  return tabRecordsSessionReady;
}

// Keys only, scoped to the intake and tab: no typed answer or client text is retained here.
const AGENT_KEYS_KEY = 'agentEditedKeys';
const agentKeysStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async () => { await tabRecordsReady(); return (await chrome.storage.local.get(AGENT_KEYS_KEY))[AGENT_KEYS_KEY] ?? []; },
      set: async (records) => { await tabRecordsReady(); return chrome.storage.local.set({ [AGENT_KEYS_KEY]: records }); } }
  : { get: async () => memory[AGENT_KEYS_KEY] ?? [], set: async (records) => { memory[AGENT_KEYS_KEY] = records; } };
let agentKeysQueue = Promise.resolve();
// Buttons clicked and vehicles/drivers/trailers entered on a quote tab, so a panel closed or
// reloaded mid-quote never adds a vehicle or trailer again (ids only, scoped like the keys above).
// One storage key per intake and tab: two panels filling two quote tabs never overwrite each
// other's record (Codex on PR #43).
const DONE_ACTIONS_PREFIX = 'doneActions:';
const doneKey = (scope, tabId) => `${DONE_ACTIONS_PREFIX}${scope}:${tabId}`;
// `clear(scope)`: one intake's records; `scopes()`: the intakes with records (pruneAgentRecords).
// The keys in extension storage, without reading their values: the usage queue (up to 20,000
// events) shares that storage, and every PDF load lists these records (Codex on PR #65). Chrome
// has getKeys from 130; the manifest allows 116, where all of it is still read.
async function storedKeys(local) {
  return typeof local.getKeys === 'function' ? local.getKeys() : Object.keys(await local.get(null));
}
const doneActionsStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async (scope, tabId) => { await tabRecordsReady(); return (await chrome.storage.local.get(doneKey(scope, tabId)))[doneKey(scope, tabId)] ?? []; },
      set: async (scope, tabId, ids) => { await tabRecordsReady(); return ids.length ? chrome.storage.local.set({ [doneKey(scope, tabId)]: ids }) : chrome.storage.local.remove(doneKey(scope, tabId)); },
      clear: async (scope) => { await tabRecordsReady(); return chrome.storage.local.remove((await storedKeys(chrome.storage.local)).filter((k) => k.startsWith(scope ? `${DONE_ACTIONS_PREFIX}${scope}:` : DONE_ACTIONS_PREFIX))); },
      scopes: async () => { await tabRecordsReady(); return (await storedKeys(chrome.storage.local)).filter((k) => k.startsWith(DONE_ACTIONS_PREFIX)).map((k) => k.slice(DONE_ACTIONS_PREFIX.length).replace(/:[^:]*$/, '')); } }
  : { get: async (scope, tabId) => memory[doneKey(scope, tabId)] ?? [],
      set: async (scope, tabId, ids) => { memory[doneKey(scope, tabId)] = ids; },
      clear: async (scope) => { for (const k of Object.keys(memory)) if (k.startsWith(scope ? `${DONE_ACTIONS_PREFIX}${scope}:` : DONE_ACTIONS_PREFIX)) delete memory[k]; },
      scopes: async () => Object.keys(memory).filter((k) => k.startsWith(DONE_ACTIONS_PREFIX)).map((k) => k.slice(DONE_ACTIONS_PREFIX.length).replace(/:[^:]*$/, '')) };
let doneActionsQueue = Promise.resolve();
// Which form on the page each vehicle, driver and trailer was filled on (state.unitForms), kept
// per intake and tab like the helper records above and on the same queue: GEICO draws every unit's
// form at one address, and a panel reloaded mid-quote must still know that the form it filled for
// vehicle 1 isn't vehicle 2's. Element names only: `{ vehicles: { <name>: <index> }, … }`.
const UNIT_FORMS_PREFIX = 'unitForms:';
const unitFormsKey = (scope, tabId) => `${UNIT_FORMS_PREFIX}${scope}:${tabId}`;
const anyUnitForms = (forms) => Object.values(forms ?? {}).some((list) => Object.keys(list ?? {}).length > 0);
const unitFormsStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async (scope, tabId) => { await tabRecordsReady(); return (await chrome.storage.local.get(unitFormsKey(scope, tabId)))[unitFormsKey(scope, tabId)] ?? null; },
      set: async (scope, tabId, forms) => { await tabRecordsReady(); return anyUnitForms(forms) ? chrome.storage.local.set({ [unitFormsKey(scope, tabId)]: forms }) : chrome.storage.local.remove(unitFormsKey(scope, tabId)); },
      clear: async (scope) => { await tabRecordsReady(); return chrome.storage.local.remove((await storedKeys(chrome.storage.local)).filter((k) => k.startsWith(scope ? `${UNIT_FORMS_PREFIX}${scope}:` : UNIT_FORMS_PREFIX))); },
      scopes: async () => { await tabRecordsReady(); return (await storedKeys(chrome.storage.local)).filter((k) => k.startsWith(UNIT_FORMS_PREFIX)).map((k) => k.slice(UNIT_FORMS_PREFIX.length).replace(/:[^:]*$/, '')); } }
  : { get: async (scope, tabId) => memory[unitFormsKey(scope, tabId)] ?? null,
      set: async (scope, tabId, forms) => { if (anyUnitForms(forms)) memory[unitFormsKey(scope, tabId)] = forms; else delete memory[unitFormsKey(scope, tabId)]; },
      clear: async (scope) => { for (const k of Object.keys(memory)) if (k.startsWith(scope ? `${UNIT_FORMS_PREFIX}${scope}:` : UNIT_FORMS_PREFIX)) delete memory[k]; },
      scopes: async () => Object.keys(memory).filter((k) => k.startsWith(UNIT_FORMS_PREFIX)).map((k) => k.slice(UNIT_FORMS_PREFIX.length).replace(/:[^:]*$/, '')) };
// When each intake (by fingerprint) was last loaded: the age of its edit keys and helper records,
// which have no time of their own, so pruneAgentRecords can let old intakes' records go.
const INTAKES_SEEN_KEY = 'intakesSeen';
const intakesSeenStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async () => (await chrome.storage.local.get(INTAKES_SEEN_KEY))[INTAKES_SEEN_KEY] ?? {},
      set: (v) => chrome.storage.local.set({ [INTAKES_SEEN_KEY]: v }) }
  : { get: async () => memory[INTAKES_SEEN_KEY] ?? {}, set: async (v) => { memory[INTAKES_SEEN_KEY] = v; } };
// Records of intakes other than the loaded one are kept for this many intakes, and this long.
const KEEP_INTAKES = 20;
const KEEP_INTAKE_DAYS = 30;

const FNV_OFFSET = 1469598103934665603n;
const FNV_PRIME = 1099511628211n;
const FNV_MASK = (1n << 64n) - 1n;
const aiFingerprint = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16);
};

// Chrome's scripting InjectionResult metadata is semantically stable but its property order and
// frame order can differ between Chromium platforms. Keep identity metadata in the snapshot while
// canonicalizing only the outer execution-result envelope; pagekit's inner result string stays raw
// because answer() compares it exactly before applying an AI choice.
function canonicalSnapshotMetadata(value) {
  if (Array.isArray(value)) return value.map(canonicalSnapshotMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSnapshotMetadata(value[key])]));
}

function canonicalSnapshotFrame(frame) {
  const input = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : {};
  const output = {};
  for (const key of Object.keys(input).filter((key) => key !== 'result').sort()) {
    output[key] = canonicalSnapshotMetadata(input[key]);
  }
  if (Object.hasOwn(input, 'result')) output.result = input.result;
  return output;
}

function canonicalSnapshots(results) {
  if (!Array.isArray(results)) return results;
  return results.map(canonicalSnapshotFrame).sort((a, b) => {
    const af = Number.isFinite(Number(a.frameId)) ? Number(a.frameId) : Number.POSITIVE_INFINITY;
    const bf = Number.isFinite(Number(b.frameId)) ? Number(b.frameId) : Number.POSITIVE_INFINITY;
    if (af !== bf) return af - bf;
    const ad = String(a.documentId ?? ''), bd = String(b.documentId ?? '');
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ac = JSON.stringify(a), bc = JSON.stringify(b);
    return ac === bc ? 0 : ac < bc ? -1 : 1;
  });
}

function snapshotFingerprint(results) {
  return aiFingerprint(canonicalSnapshots(results));
}

function snapshotsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify(canonicalSnapshots(left)) === JSON.stringify(canonicalSnapshots(right));
}

// Pending records written before canonicalization used the raw JSON hash. Accept that legacy hash
// only as an exact fallback; new records use snapshotFingerprint above.
function snapshotHashMatches(results, expected) {
  return expected != null && (snapshotFingerprint(results) === expected || aiFingerprint(results) === expected);
}

function aiSnapshotFields(frame) {
  try {
    const parsed = JSON.parse(frame?.result);
    return Array.isArray(parsed?.[1]) ? parsed[1].filter(field => field && typeof field === 'object') : [];
  } catch { return []; }
}

function aiLiveFieldHash(field) {
  return aiFingerprint([field.key, field.label, field.current]);
}

function aiQuestionHash(field) {
  return aiFingerprint([field.key, field.label]);
}

function aiOriginRecord(origin) {
  if (!origin || !Number.isInteger(origin.frameId) || typeof origin.documentId !== 'string'
    || typeof origin.questionHash !== 'string' || typeof origin.fieldHash !== 'string') return null;
  return {
    frameId: origin.frameId,
    documentId: origin.documentId,
    questionHash: origin.questionHash,
    fieldHash: origin.fieldHash,
  };
}

function aiSnapshotFieldMatches(frames, x) {
  return (Array.isArray(frames) ? frames : []).flatMap(frame => aiSnapshotFields(frame)
    .filter(field => field.key === x.key && field.label === x.label)
    .map(field => ({ frame, field })));
}

function aiAnswerOrigin(frames, x, answerFrame) {
  const matches = aiSnapshotFieldMatches(frames, x);
  if (matches.length !== 1 || !answerFrame) return null;
  const [{ frame, field }] = matches;
  if (frame.frameId !== answerFrame.frameId || frame.documentId !== answerFrame.documentId) return null;
  return aiOriginRecord({
    frameId: answerFrame.frameId,
    documentId: answerFrame.documentId,
    questionHash: aiQuestionHash(field),
    fieldHash: aiLiveFieldHash({ ...field, current: answerFrame.shown }),
  });
}

function aiActionCurrent(ctx, list) {
  return !!ctx.intake && state.intake === ctx.intake && state.tab?.id === ctx.tabId
    && state.tab?.url === ctx.tabUrl && pageOf(state.tab?.url) === ctx.page && !stopNoteFor(state.tab?.carrier, ctx.page, undefined, ctx.tabId)
    && list.every(x => [...state.aiCache.values()].includes(x));
}

function aiItemFingerprint(x) {
  return aiFingerprint([x.key, x.label, x.section, x.current, x.options, x.status, x.reason,
    x.reviewOnly, x.manualOnly, x.fieldType]);
}
let aiPersistQueue = Promise.resolve();
const aiRetiredSignatures = new Set();

const $ = (id) => document.getElementById(id);
// What the panel knows and shows, kept in the panel's store (state-store.js): read and assigned as
// a plain object here, and subscribed to by the React views.
const state = storeState({
  intake: null, // { record, warnings, stats, fileName, done: number[] }
  // The developer recording under way (startRecording): { store, tabId, carrier, redact, started, timer, stopping }.
  recording: null,
  active: { drivers: 0, vehicles: 0, trailers: 0 },
  tab: null, // { id, url, carrier }
  checksCarrier: null, // the carrier the intake checks were last drawn for (renderSite)
  // The state each tab's quote was picked for on the carrier's page (tab id -> { carrier, code,
  // session, dismissed }): kept when the intake is cleared or replaced, as the tab's quote is.
  quoteStates: new Map(),
  // What autofill put in each field on the current tab (field key -> { path, shown }), so the
  // usage log can tell the agent's corrections apart from agreement.
  filled: new Map(),
  // Question text per field key, from the fill engine (better than the recorder's guess).
  labels: new Map(),
  // Each combo's choices seen by the fill engine (field key -> Set), so the usage log keeps a
  // combo's value only when it's one of them, never text typed into the box.
  choices: new Map(),
  // Automatic follow-up fills: pages the agent has filled in this tab, and per page the fields
  // the agent changed themselves (never refilled automatically).
  autoPages: new Set(),
  // Steps already continued from, keyed by stepScope (AmWINS steps, Progressive's per-vehicle pages).
  doneSteps: new Set(),
  advanceRetried: new Set(), // steps whose lost Continue was clicked a second time (once each)
  assistPage: null, // a page whose Luna request waits for a helper's follow-up fill (per tab, like the above)
  notesAsking: null, // the intake whose claims box Luna is reading now
  notesRetry: null, // that intake again, when the settings changed meanwhile
  tabSessions: new Map(),
  agentKeys: new Map(),
  agentKeysEpochs: new Map(), // Clear/pruning invalidate late writes for that intake only
  filling: false,
  autoTimer: null,
  // The page whose new questions the pending follow-up fill is for (scheduleAutoFill `drawn`).
  autoDrawn: null,
  autoPending: false,
  autoPaused: false,
  // An automatic fill that found a step it couldn't read (pagekit stepUnread) is tried once more;
  // per tab, until a fill reads a step again (rememberFill).
  unreadRetried: false,
  // The page and step a fill found still drawing, or done with no Continue to click yet, was
  // filled once more for (rememberFill): not again until a fill there finds neither.
  triedAgain: null,
  pagePending: null, // a page the tab moved to while a fill ran: filled when that fill ends (runPendingPage)
  // A page that arrived with no question drawn yet ({ tabId, page }): its first fill runs when they
  // show (new_fields), with "Fill each new page as soon as it opens" on (W44-11).
  drawPending: null,
  // Page layouts: the last one logged per quote and page (or vehicle/driver on its page), the
  // chain that logs them one at a time, the capture waiting for the page to be quiet, failures.
  lastLayouts: new Map(),
  // The last fill on each tab and page ("<tab>|<page>" -> { run, at, step, blockers }), so a
  // problem report names the fill it is about.
  lastRuns: new Map(),
  layoutChain: Promise.resolve(),
  layoutTimer: null,
  layoutPending: null,
  intakeRevision: 0, // goes up with every correction to the intake, so a capture waiting is redone
  layoutGeneration: 0, // goes up with every page change asked to be captured (see captureLayout)
  // After an intake is loaded or cleared, a tab may still show the previous client's quote: its
  // layouts wait until that tab shows a new page or is filled with this intake (layoutReadyTabs).
  layoutHold: false,
  layoutReadyTabs: new Set(),
  layoutNewTabs: new Set(), // tabs opened since then (a new quote, as Progressive opens one)
  viewTabs: new Map(), // tab id -> its order in this quote, for events' `view` (viewOf)
  layoutLatest: null, // the capture asked for last (waiting or queued), which later changes feed
  layoutErrors: 0,
  layoutErrorsLogged: new Set(),
  // Carrier buttons already clicked in this quote (Verify DOT, Bill plan options, …).
  doneActions: new Set(),
  // The form each vehicle, driver and trailer was filled on, where every unit's form is drawn at
  // one address (GEICO; pagekit unitForm): list -> { the form's marker element name -> its index }.
  // Per tab like the above, and persisted with it (persistUnitForms).
  unitForms: { vehicles: {}, drivers: {}, trailers: {} },
  // The unit form the tab's latest fill ended on, held (pagekit unitHeld) or filled (unitForm):
  // { step, list, id, held }, or null. The agent's edits on a unit step are scoped by it
  // (editScope). Not persisted.
  unitShown: null,
  visitedPages: new Set(),
  // AI assistant: the latest request (older answers arriving late are dropped) and suggestions
  // per page and set of questions, so a refill doesn't ask again.
  aiRun: 0,
  aiCache: new Map(),
  // The request whose settings change discarded every earlier request's answer (aiActs), and the
  // questions being asked now (cache signature -> promise settled when the answer is in).
  aiSettingsRun: 0,
  aiAsking: new Map(),
  // Which screen shows: Settings over everything; otherwise the start screen, or the quote with its
  // three steps and the view they picked: step 1's checks ('check') or the page's answers ('page'),
  // all of them or a filter's ('all' | 'needs' | 'done'). The intake PDF opens in a sheet over it.
  settingsOpen: false,
  view: 'check',
  filter: 'all',
  // Settings, as settings-view.jsx draws it. The Filling switches (`switches`: set from the saved
  // settings by init, and by the agent; the panel reads each from its box by id); the AI's card
  // (renderAiSettings: `ai`, null until first said; `keyFormOpen` while the key's box is open: the key
  // is only ever in that box); the usage card (renderUsage: `usageCard`; `usageNote`, the line under
  // it); the version, what is left to set up and the initials' box marked (renderHealth: `health`);
  // the test-run mark (render: `testRun`, null with no intake); Capture page layout off (renderSite:
  // `captureOff`) and what it did (captureSaid: `captureStatus`); and the developer recording's card
  // (dev-recording.js: `devrec`, whether one runs, its line and the unfinished one to save). And the
  // footer's Recording usage (render, renderSite, renderUsage: `recordingLine`).
  switches: { autoPages: true, autoFollowUps: true, autoAdvance: true, checkBeforeContinue: true, overwrite: false, finishSound: true },
  ai: null,
  keyFormOpen: false,
  usageCard: null,
  usageNote: '',
  health: null,
  testRun: null,
  captureOff: false,
  captureStatus: null,
  devrec: { on: false, status: null, unfinished: null },
  recordingLine: false,
  // What the three steps and the dock say now (renderSteps, renderDock), as steps-view.jsx draws
  // them: null until the panel first says it.
  steps: null,
  dock: null,
  // What the page's list of answers says around them (renderSteps), as feed-view.jsx draws it: null
  // until the panel first says it.
  feed: null,
  // The cards at the top of the page view, as cards-view.jsx draws them: `waiting` (no rater in
  // front: why), and the carrier, state, stop, review and fill cards (issueSaid), each null while
  // it says nothing.
  cards: {},
  // The panel's other notes, as notes-view.jsx draws them: `usage`, a usage log that can't be saved
  // (renderHealth, in #notices), and `window`, a Pop out or Dock that didn't work (windowProblem, in
  // #window-note), each a card as issueSaid puts it or null; and why the PDF couldn't be read
  // (showLoadError: { title, text }, in #load-error), null until then. And the quote's steps in the
  // header's strip (renderSite: { name, at } each), as site-view.jsx draws them: none off a quote.
  notes: { usage: null, window: null },
  loadError: null,
  siteTrack: [],
  // Step 1's checks (renderWarnings: the title, the cards, the cleanup notes), as checks-view.jsx
  // draws them: null until an intake is checked. And the unit pickers above the page's answers
  // (renderPickers), none until a page is about one of several.
  checks: null,
  pickers: [],
  // The file tools' question before the agent's work would go: 'replace' | 'clear' | 'new-quote',
  // the button that asked, for focus on Cancel, and what it says ({ text, yes }: askFile).
  fileConfirm: null,
  fileConfirmFrom: null,
  fileQuestion: null,
  // The client's header, as client-view.jsx draws it (render: the name, meta, the PDF button and the
  // file tools' question; null with no intake); the line under it about the file just loaded
  // (clientNote); and New quote off while answers go in (renderSteps).
  client: null,
  clientNote: null,
  newQuoteOff: false,
  // All client details, as details-view.jsx draws it (renderSections: the sections and their rows,
  // the empty fields' button): null until an intake is said.
  details: null,
  // New quote with this intake under way (newQuote): no fill starts.
  resetting: false,
  // The quote-done chime's audio element (noteQuoteDone).
  audio: null,
  // Client details: whether fields the intake leaves blank are listed (showEmpty; the flagged ones
  // always are), and the sections the agent folded (by id).
  showEmpty: false,
  detailsClosed: new Set(),
  // The intake PDF: its bytes (also kept in session storage, keepPdf), the document pdf.js opened,
  // and the viewer's page, zoom and the item marked on it ({ path, label, kind, place }); null
  // while the viewer is closed.
  pdfBytes: null,
  pdfDoc: null,
  pdfDraw: 0,
  pdfTask: null,
  pdf: null,
  // What the PDF sheet says, as pdf-sheet-view.jsx draws it (openPdf, drawPdf): its title and
  // name, what shows ('loading' | 'page' | 'error') and the error, the hint for a marked item, the
  // marks on the page and the controls (pdfControls); null until the PDF first opens.
  pdfSheet: null,
  // Each fill's report (steps 2 and 3) per tab, page and step (reportKey): { key, tabId, page,
  // fields, filled, left, waiting, advanced, error, at, … }. One kept while another tab or step is
  // in front holds its nodes, and is shown again when that page is back (showReport); `reportFor`
  // is the one shown now.
  reports: new Map(),
  reportFor: null,
  // An earlier page's report on the tab in front, picked in the answers' page menu: its key, shown
  // read-only in place of the page's own (renderSteps); null for the page in front. `keyOpen`: what
  // the tags and the rater page's marks mean, open under the list's title.
  pastKey: null,
  pastNodes: null,
  keyOpen: false,
  // The fill running now (its tab, report key and answers in so far), for step 2's progress line.
  fillingFor: null,
  // The step a one-address application's tab is on (AmWINS), for the page strip (noteStep).
  tabSteps: new Map(),
  // The screen that is the agent's (carrier `stopButtons`: GEICO's "Add USDOT Number / Skip") a tab
  // shows, as `{ name, page }` (noteStopScreen).
  stopScreens: new Map(),
  // The AI picks waiting for approval, for the dock's Approve (renderAi), by tab and page
  // (`${tabId}|${page}`): { canContinue, go }.
  aiDocks: new Map(),
  // Where focus was when the intake PDF opened, for Back.
  pdfReturn: null,
  // All client details, in a drawer over the panel, and where focus was when it opened.
  detailsOpen: false,
  detailsReturn: null,
  // The browser window of the tab in view, for Dock (popped out), and whether this copy of the
  // panel is giving way to a newer one (giveWay).
  browserWindow: null,
  closing: false,
});

// A fill starting and ending, noted for the developer recording: its events count as during a fill
// by their own time, not by when their batch reached the panel (a fill's last click, its Continue,
// arrived once the fill had ended: live recording, 2026-10-23), and the timeline shows each fill.
// One place for the eight that set `state.filling`.
let fillingNow = state.filling;
Object.defineProperty(state, 'filling', {
  enumerable: true,
  get: () => fillingNow,
  set: (on) => {
    const rec = state.recording;
    if (!!on !== fillingNow && rec && !rec.stopping) {
      const t = Date.now();
      if (on) rec.fills.push({ start: t, end: null }); else if (rec.fills.at(-1)) rec.fills.at(-1).end = t;
      rec.store.add([{ kind: 'fill', t, frame: 0, on: !!on }]);
    }
    fillingNow = !!on;
  },
});

// Crashes nothing in the panel caught (an exception, a promise nobody awaited) go in the usage log,
// so a review sees what the agent only saw as a panel that stopped: each message once while the
// panel is open, at most 20, with the page it happened on. Practice pages log nothing, as usual.
const loggedCrashes = new Set();
// What is stored on this computer brought up to this build's version (src/storage-version.js), by
// one copy of the panel at a time. A migration that fails leaves the data as it was and is logged
// as the panel's error, by its version and the error's name only (settings hold the OpenAI key).
async function migrateStoredData() {
  if (!inExtension) return;
  const run = () => migrateStorage(chrome.storage.local);
  const result = await (navigator.locks ? navigator.locks.request('rater-storage-version', run) : run()).catch((error) => ({ error }));
  if (result.error) logCrash(new Error(`stored data not migrated${result.failedAt ? ` to version ${result.failedAt}` : ''}: ${result.error?.name ?? 'Error'}`));
}

function logCrash(err) {
  try {
    if (state.tab?.carrier?.practice) return;
    // An intake without a record (the very crash this log exists for) has no terms to redact. If
    // the redactor itself can't be built, the message is dropped rather than logged unredacted.
    let redact;
    try { redact = state.intake?.record ? redactor(redactionTerms(state.intake.record)) : (x) => x; } catch { redact = () => ''; }
    const event = clientErrorEvent(err, { where: 'panel', redact });
    if (loggedCrashes.has(event.error) || loggedCrashes.size >= 20) return;
    loggedCrashes.add(event.error);
    usage.log({ ...event, carrier: state.tab?.carrier?.id ?? null, page: state.tab?.url ? pageOf(state.tab.url) : null });
  } catch { /* logging a crash must never crash */ }
}
globalThis.addEventListener?.('error', (e) => logCrash(e.error ?? e.message));
globalThis.addEventListener?.('unhandledrejection', (e) => logCrash(e.reason));

function aiSafeText(value) {
  if (value == null) return value;
  const redact = state.intake ? redactor(redactionTerms(state.intake.record)) : (x) => x;
  return redact(String(value)).slice(0, 240);
}

function aiCacheSignature({ tabId, page, model, policy = POLICY_VERSION, contextHash, itemHash, quoteHash }) {
  return [tabId, page, model, policy, contextHash, itemHash, ...(quoteHash ? [quoteHash] : [])].join('\n');
}

function aiDecisionBlocks(x) {
  return x.done === 'auto' && !x.approved && !x.manual && !x.confirmed;
}

// A manual answer observed before a panel reload must remain protected even though the in-memory
// agent-key map is rebuilt. A rejected choice whose current carrier value is still present also
// stays on the existing pending record instead of starting a second AI decision for the same key.
function aiSettledOnPage(tabId, page, item) {
  for (const [sig, x] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t !== String(tabId) || p !== page || x.key !== item.key
      || (x.quoteHash && x.quoteHash !== aiFingerprint(state.tab?.url))) continue;
    if (aiDecisionBlocks(x)) return true;
    if (x.manual || x.confirmed || x.approved) return true;
    if (x.rejected && (item.current === x.choice || (item.current != null && item.current !== ''))) return true;
  }
  return false;
}

function aiPendingRecord(sig, x, scope) {
  const [tabId, page, model, policy, contextHash, itemHash] = sig.split('\n');
  return {
    version: 1, scope: x.pendingScope ?? x.scope ?? scope, quoteHash: x.quoteHash ?? null, tabId: Number(tabId), page, model, policy, contextHash, itemHash,
    key: x.key, label: x.pendingLabel ?? aiSafeText(x.label), choice: x.pendingChoice ?? aiSafeText(x.choice), controlKind: x.controlKind,
    done: x.done, approved: !!x.approved, rejected: !!x.rejected, manual: !!x.manual, confirmed: !!x.confirmed,
    fieldHash: x.fieldHash ?? (x.restored ? null : aiFingerprint([x.key, x.label, x.choice])),
    snapshotHash: x.snapshotHash ?? (x.snapshots ? snapshotFingerprint(x.snapshots) : null),
    origin: aiOriginRecord(x.origin),
    originAmbiguous: !!x.originAmbiguous,
    // Where its protected key lives (the page, with the vehicle/driver on vehicle and driver pages).
    editScope: typeof x.editScope === 'string' ? x.editScope : null,
  };
}

function persistAiPending() {
  const task = aiPersistQueue.then(async () => {
    const scope = usage.currentSession()?.intakeId;
    const entries = [...state.aiCache.entries()];
    const retired = [...aiRetiredSignatures];
    const managed = new Set([...entries.map(([sig]) => sig), ...retired]);
    const records = entries.filter(([, x]) => x.done === 'auto' && !x.approved)
      .map(([sig, x]) => aiPendingRecord(sig, x, scope)).filter(x => x.scope);
    const existing = await aiPendingStore.get();
    const others = existing.filter(x => !managed.has(aiCacheSignature(x)));
    await aiPendingStore.set([...others, ...records].slice(-200));
    retired.forEach(sig => aiRetiredSignatures.delete(sig));
  });
  aiPersistQueue = task.catch(() => {});
  return task;
}

async function restoreAiPending() {
  const scope = usage.currentSession()?.intakeId;
  const all = await aiPendingStore.get();
  const valid = all.filter(x => x?.scope && Number.isInteger(x.tabId) && x.page && x.itemHash && x.contextHash);
  // New records follow their physical quote/document even after the intake changes. Legacy
  // records without that identity retain their original intake scope.
  const records = valid.filter(x => x.quoteHash || aiOriginRecord(x.origin) || x.scope === scope);
  for (const x of records) {
    const sig = aiCacheSignature(x);
    if (state.aiCache.has(sig)) continue;
    const retired = x.model !== DEFAULT_MODEL || x.policy !== POLICY_VERSION;
    state.aiCache.set(sig, {
      ...x, restored: true, retired, provider: 'luna', pendingScope: x.scope,
      pendingLabel: x.label, pendingChoice: x.choice, done: 'auto', approved: !!x.approved,
      rejected: !!x.rejected || (retired && !x.approved && !x.manual && !x.confirmed),
      manual: !!x.manual, confirmed: !!x.confirmed, tip: '', checks: [], leave: false,
      origin: aiOriginRecord(x.origin), originAmbiguous: !!x.originAmbiguous,
      applyable: true, autoOk: !retired, contextKey: null, snapshots: null,
    });
  }
  if (valid.length !== all.length) await aiPendingStore.set(valid);
}

// An intake replacement can discard suggestions, but an answer already sent to the carrier
// remains a review hold in its original quote until the agent settles it or its document is gone.
function discardAiSuggestions() {
  for (const [sig, x] of state.aiCache) if (!aiDecisionBlocks(x)) {
    state.aiCache.delete(sig);
    aiRetiredSignatures.add(sig);
  }
}

// `tabId`, `agentKeys`: a fill's own tab and its maps, when its results come back after the
// agent moved to another tab (rememberFill); by default the tab in front.
function persistAgentKeys(tabId = state.tab?.id, agentKeys = state.agentKeys) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId)) return Promise.resolve();
  const records = [...agentKeys].filter(([, keys]) => keys.size)
    .map(([page, keys]) => ({ scope, tabId, page, keys: [...keys] }));
  const task = agentKeysQueue.then(async () => {
    const existing = await agentKeysStore.get();
    await agentKeysStore.set([...existing.filter(x => x.scope !== scope || x.tabId !== tabId), ...records]);
  });
  agentKeysQueue = task.catch(() => {});
  return agentKeysQueue;
}

// A paused recorder may resume after the panel moved to another tab/intake/entity. Guarded
// edits still belong to the captured origin, whose tab snapshot may already have been saved.
// Merge only field keys into that origin's ledger; never persist a label, answer or snapshot.
function persistGuardedEdits(origin, editedKeys) {
  const additions = editedKeys.filter(key => typeof key === 'string' && key);
  if (!additions.length || origin.epoch !== (state.agentKeysEpochs?.get(origin.scope) ?? 0)) return Promise.resolve();
  const merge = (pages) => {
    if (!pages) return;
    const keys = pages.get(origin.page) ?? new Set();
    for (const key of additions) keys.add(key);
    pages.set(origin.page, keys);
  };
  merge(origin.keys);
  if (usage.currentSession()?.intakeId === origin.scope) {
    merge(state.tab?.id === origin.tabId ? state.agentKeys : state.tabSessions?.get(origin.tabId)?.agentKeys);
  }
  if (!origin.scope || !Number.isInteger(origin.tabId)) return Promise.resolve();
  const keys = [...origin.keys.get(origin.page)];
  const task = agentKeysQueue.then(async () => {
    if (origin.epoch !== (state.agentKeysEpochs?.get(origin.scope) ?? 0)) return;
    const existing = await agentKeysStore.get();
    if (origin.epoch !== (state.agentKeysEpochs?.get(origin.scope) ?? 0)) return;
    const matches = record => record.scope === origin.scope && record.tabId === origin.tabId && record.page === origin.page;
    const merged = new Set(existing.filter(matches).flatMap(record => record.keys ?? []).filter(key => typeof key === 'string' && key));
    for (const key of keys) merged.add(key);
    await agentKeysStore.set([...existing.filter(record => !matches(record)),
      { scope: origin.scope, tabId: origin.tabId, page: origin.page, keys: [...merged] }]);
  });
  agentKeysQueue = task.catch(() => {});
  return agentKeysQueue;
}

async function restoreAgentKeys(tabId) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId)) return;
  const records = await agentKeysStore.get();
  if (state.tab?.id !== tabId || usage.currentSession()?.intakeId !== scope) return;
  for (const x of records) {
    if (x.scope !== scope || x.tabId !== tabId || typeof x.page !== 'string' || !Array.isArray(x.keys)) continue;
    const keys = state.agentKeys.get(x.page) ?? new Set();
    for (const key of x.keys) if (typeof key === 'string' && key) keys.add(key);
    state.agentKeys.set(x.page, keys);
  }
}

// Forgets one intake's edit keys and helper records on every tab (Clear). Until the 2026-10-08
// audit this wiped every intake's: coming back to a client whose quote was still open then added
// its vehicles again and refilled what the agent had corrected. Nothing without a scope.
function clearAgentKeys(scope) {
  if (!scope) return Promise.resolve();
  // Cancel that intake's in-flight origin writes before waiting on either persistence queue.
  const epochs = state.agentKeysEpochs ??= new Map();
  epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
  const task = agentKeysQueue.then(async () => agentKeysStore.set((await agentKeysStore.get()).filter((x) => x.scope !== scope)));
  agentKeysQueue = task.catch(() => {});
  doneActionsQueue = doneActionsQueue.then(() => Promise.all([doneActionsStore.clear(scope), unitFormsStore.clear(scope)])).catch(() => {});
  // Done once the helper records are gone too: the same PDF loaded again right after a Clear must
  // not get the cleared intake's helper ids back (units taken as already added; Codex on PR #65).
  return Promise.all([task, doneActionsQueue]);
}

// On loading an intake: its own records stay (a PDF dropped again is the same intake, and its
// quote tabs may still be open), and so do other intakes' until there are more than KEEP_INTAKES
// of them or one hasn't been loaded for KEEP_INTAKE_DAYS; a record from before intakes were
// stamped counts from now. Returns the intakes whose records were let go.
async function pruneAgentRecords(current, now = Date.now()) {
  if (!current) return [];
  const seen = await intakesSeenStore.get();
  seen[current] = new Date(now).toISOString();
  const [keys, doneScopes, unitScopes] = await Promise.all([agentKeysStore.get(), doneActionsStore.scopes(), unitFormsStore.scopes()]);
  for (const scope of new Set([...keys.map((x) => x.scope), ...doneScopes, ...unitScopes])) if (scope && !seen[scope]) seen[scope] = seen[current];
  const others = Object.keys(seen).filter((scope) => scope !== current).sort((a, b) => Date.parse(seen[b]) - Date.parse(seen[a]));
  const gone = others.filter((scope, i) => i >= KEEP_INTAKES - 1 || now - Date.parse(seen[scope]) > KEEP_INTAKE_DAYS * 86_400_000);
  for (const scope of gone) delete seen[scope];
  await intakesSeenStore.set(seen);
  await Promise.all(gone.map((scope) => clearAgentKeys(scope)));
  return gone;
}

function persistDoneActions(tabId = state.tab?.id, doneActions = state.doneActions) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId)) return Promise.resolve();
  const ids = [...doneActions].filter((id) => typeof id === 'string');
  doneActionsQueue = doneActionsQueue.then(() => doneActionsStore.set(scope, tabId, ids)).catch(() => {});
  return doneActionsQueue;
}

// The tab's unit forms (state.unitForms), saved like its helper records: as they are now.
function persistUnitForms(tabId = state.tab?.id, unitForms = state.unitForms) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId)) return Promise.resolve();
  const forms = JSON.parse(JSON.stringify(unitForms ?? {}));
  doneActionsQueue = doneActionsQueue.then(() => unitFormsStore.set(scope, tabId, forms)).catch(() => {});
  return doneActionsQueue;
}

// Once per tab and intake while the panel is open (after a reload): later arrivals keep the
// panel's own set, which may have dropped a button to run again (Print / Send on a return). The
// tab's unit forms come back with them; a form the panel has bound since keeps its own unit.
const doneRestored = new Set();
// The reports of a quote tab's pages, kept for the browser session (`store`, storage.session: gone
// when the browser closes), so the panel opened again shows what it showed (W43-39, 2026-10-22:
// opened again three times on one quote, it came back empty each time). Each is kept as the fill
// results it was made from (`REPORT_PARTS` of each frame), the last REPORTS_KEPT per tab and intake
// within about REPORTS_BYTES (the store's 10 MB also holds the intake and its PDF), and made again from them when the panel opens on that tab, marked as from its fill's time
// (`restoredAt`). The answers of the one in front are read back from the page (refreshAnswers).
const REPORTS_PREFIX = 'reports:';
const REPORTS_KEPT = 30;
const REPORTS_BYTES = 512 * 1024;
const REPORT_PARTS = ['fields', 'filled', 'kept', 'failed', 'noData', 'leftRequired', 'unknown', 'checks', 'actions', 'blocked', 'skipped',
  'halted', 'reason', 'stepUnread', 'stepKey', 'notDrawn', 'advanced', 'advanceDue', 'held', 'covered', 'coveredHelpers', 'renamed', 'pageChanged'];
const reportsRestored = new Set();
let reportsQueue = Promise.resolve();
function keepReport(tabId, saved) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId)) return;
  const frames = saved.frames.map((f) => Object.fromEntries(REPORT_PARTS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])));
  reportsQueue = reportsQueue.then(async () => {
    const was = await store.get(`${REPORTS_PREFIX}${tabId}`);
    const entries = [...(was?.scope === scope && Array.isArray(was.entries) ? was.entries : []).filter((e) => e.key !== saved.key), { ...saved, frames }].slice(-REPORTS_KEPT);
    // The oldest go first; the newest stays.
    let size = entries.reduce((n, e) => n + JSON.stringify(e).length, 0);
    while (entries.length > 1 && size > REPORTS_BYTES) size -= JSON.stringify(entries.shift()).length;
    await store.set(`${REPORTS_PREFIX}${tabId}`, { scope, entries });
  }).catch(() => {});
}
// Forgets kept reports as dropReports forgets shown ones (`drop` gets each with its tabId): a new
// or cleared client, a closed tab, one page's.
function forgetKeptReports(drop) {
  reportsQueue = reportsQueue.then(async () => {
    for (const k of (await store.keys()).filter((key) => key.startsWith(REPORTS_PREFIX))) {
      const was = await store.get(k);
      const tabId = Number(k.slice(REPORTS_PREFIX.length));
      const entries = (Array.isArray(was?.entries) ? was.entries : []).filter((e) => !drop({ ...e, tabId }));
      await (entries.length ? store.set(k, { ...was, entries }) : store.remove(k));
    }
  }).catch(() => {});
}
async function restoreReports(tabId) {
  const scope = usage.currentSession()?.intakeId;
  const done = `${scope}|${tabId}`;
  if (!scope || !Number.isInteger(tabId) || reportsRestored.has(done)) return;
  const was = await store.get(`${REPORTS_PREFIX}${tabId}`).catch(() => null);
  const carrier = state.tab?.carrier;
  // Once, and only once the tab shows a rater for this intake: one opened elsewhere first gets its
  // reports when it comes to the rater.
  if (reportsRestored.has(done) || state.tab?.id !== tabId || !carrier || !state.intake || usage.currentSession()?.intakeId !== scope) return;
  reportsRestored.add(done);
  if (was?.scope !== scope || !Array.isArray(was.entries)) return;
  // A report a fill made since the panel opened is newer: kept. Each keeps its key, which holds
  // its step on a one-address application (GEICO, AmWINS): the tab's step may not be known yet.
  // Each is made again as the page is now (liveFrames): the page in front's read once for all its
  // items before it shows (a question gone since never shows again), another page's with nothing
  // said of its page until it is in front (checkItems).
  const front = currentReportKey();
  for (const e of was.entries) {
    if (!e?.key || !String(e.key).startsWith(`${tabId}|`) || state.reports.has(e.key) || !Array.isArray(e.frames)) continue;
    const active = { ...firstUnits(), ...(e.active ?? {}) };
    const plan = buildPlan(state.intake.record, carrier, active);
    const live = e.key === front ? await liveItems(tabId, carrier, [...reviewItems(e.frames), ...answerItems(e.frames)], plan) : null;
    // A fill, another tab or another intake since the page was read: not made again here.
    if (state.reports.has(e.key) || state.tab?.id !== tabId || usage.currentSession()?.intakeId !== scope) continue;
    renderReport(liveFrames(e.frames, live), { tabId, page: e.page, carrier, active, plan, stopped: !!e.stopped, keptKey: e.key, restoredAt: e.at ?? Date.now(), filledBefore: e.filledBefore });
  }
  refreshAnswers();
}

async function restoreDoneActions(tabId) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId) || doneRestored.has(`${scope}|${tabId}`)) return;
  await doneActionsQueue; // a Clear's removal still queued is done first
  const [ids, forms] = await Promise.all([doneActionsStore.get(scope, tabId), unitFormsStore.get(scope, tabId)]);
  if (state.tab?.id !== tabId || usage.currentSession()?.intakeId !== scope) return;
  doneRestored.add(`${scope}|${tabId}`);
  for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && id) state.doneActions.add(id);
  const mine = state.unitForms ??= { vehicles: {}, drivers: {}, trailers: {} };
  for (const list of ['vehicles', 'drivers', 'trailers']) {
    const kept = forms?.[list] && typeof forms[list] === 'object' ? forms[list] : {};
    for (const [id, i] of Object.entries(kept)) if (id && Number.isInteger(i) && i >= 0 && !Object.hasOwn(mine[list] ??= {}, id)) mine[list][id] = i;
  }
}

// Durable decisions store display text separately from the exact live-value fingerprint.
function aiCurrentAnswerPresent(frames, x) {
  const entries = (Array.isArray(frames) ? frames : []).flatMap(frame => aiSnapshotFields(frame)
    .map(field => ({ frame, field })));
  const origin = aiOriginRecord(x.origin);
  if (x.originAmbiguous) return false;
  if (origin) {
    const matches = entries.filter(({ field }) => field.key === x.key
      && aiQuestionHash(field) === origin.questionHash);
    if (matches.length !== 1) return false;
    const [{ frame, field }] = matches;
    return frame.frameId === origin.frameId && frame.documentId === origin.documentId
      && aiLiveFieldHash(field) === origin.fieldHash;
  }
  // Older records have no frame identity. They can be confirmed only when their whole-page
  // snapshot is unchanged; a matching key or display string cannot prove the originating frame.
  const matches = entries.filter(({ field }) => field.key === x.key);
  return !!(x.snapshotHash && snapshotHashMatches(frames, x.snapshotHash))
    && matches.length === 1 && (!x.fieldHash || aiLiveFieldHash(matches[0].field) === x.fieldHash);
}

async function settleRejectedAi(page, changes, sender, tabId = state.tab?.id) {
  if (!Number.isInteger(sender?.frameId) || typeof sender.documentId !== 'string') return false;
  const tab = state.tab, intake = state.intake;
  const eligible = [...state.aiCache].filter(([sig, x]) => {
    const [cachedTab, cachedPage] = sig.split('\n');
    return cachedTab === String(tabId) && cachedPage === page && x.done === 'auto' && !x.approved && !x.manual && !x.confirmed
      && (!x.quoteHash || x.quoteHash === aiFingerprint(tab?.url));
  });
  let fresh = null;
  if (eligible.some(([, x]) => !x.origin && !x.originAmbiguous)) {
    try { fresh = await runKit(tabId, tab.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null)); } catch { /* page navigating */ }
  }
  if (state.tab?.id !== tabId || state.tab?.url !== tab?.url || state.intake !== intake) return false;
  let changed = false;
  for (const [sig, x] of eligible) {
    if (state.aiCache.get(sig) !== x || x.originAmbiguous) continue;
    let questionHash = x.origin?.questionHash;
    if (x.origin) {
      if (sender.frameId !== x.origin.frameId || sender.documentId !== x.origin.documentId) continue;
    } else {
      // An old record has no origin. A trusted edit must target the single live question with
      // this key, in the sender's current document; another frame's copy cannot settle it.
      const matches = (Array.isArray(fresh) ? fresh : []).flatMap(frame => aiSnapshotFields(frame)
        .filter(field => field.key === x.key).map(field => ({ frame, field })));
      if (matches.length !== 1 || matches[0].frame.frameId !== sender.frameId
        || matches[0].frame.documentId !== sender.documentId) continue;
      questionHash = aiQuestionHash(matches[0].field);
    }
    if (!changes.some(c => c?.key === x.key
      && aiQuestionHash({ key: c.key, label: c.label }) === questionHash)) continue;
    x.manual = true;
    changed = true;
  }
  if (changed) persistAiPending();
  return changed;
}

// Missing injection results alone can mean denied access. Retire a missing source document only
// when Chrome explicitly reports that it no longer exists; other failures keep the hold.
async function aiDocumentGone(tabId, documentId, carrier) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
      world: worldFor(carrier), func: () => true });
    return false;
  } catch (e) {
    return /No (?:document|frame) with id .+ in tab with id/i.test(String(e?.message ?? e));
  }
}

async function retireAiOrigins(ctx, frames = null) {
  const current = () => state.tab?.id === ctx.tabId && state.tab?.url === ctx.tabUrl
    && state.intake === ctx.intake;
  if (!current()) return false;
  const quoteHash = aiFingerprint(ctx.tabUrl);
  const entries = [...state.aiCache].filter(([sig, x]) => sig.split('\n')[0] === String(ctx.tabId)
    && x.done === 'auto' && (x.quoteHash || aiOriginRecord(x.origin)));
  if (!entries.length) return false;
  if (frames == null && entries.some(([, x]) => x.origin && (!x.quoteHash || x.quoteHash === quoteHash))) {
    try { frames = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null)); }
    catch { frames = null; }
  }
  if (!current()) return false;
  const known = Array.isArray(frames) ? frames.filter(f => Number.isInteger(f?.frameId)
    && typeof f.documentId === 'string') : [];
  const retiring = [];
  for (const [sig, x] of entries) {
    if (state.aiCache.get(sig) !== x) continue;
    let gone = !!x.quoteHash && x.quoteHash !== quoteHash;
    const origin = aiOriginRecord(x.origin);
    if (!gone && origin && known.length) {
      const replacement = known.find(f => f.frameId === origin.frameId);
      if (replacement) gone = replacement.documentId !== origin.documentId;
      else gone = await aiDocumentGone(ctx.tabId, origin.documentId, ctx.carrier);
    }
    if (!current()) return false;
    if (gone) retiring.push([sig, x]);
  }
  let changed = false;
  for (const [sig, x] of retiring) if (state.aiCache.get(sig) === x) {
    state.aiCache.delete(sig);
    aiRetiredSignatures.add(sig);
    // From the vehicle/driver the pick was made on, not whichever is active now.
    state.agentKeys.get(x.editScope ?? editScope(sig.split('\n')[1]))?.delete(x.key);
    changed = true;
  }
  if (changed) {
    await persistAiPending();
    await persistAgentKeys();
  }
  return changed;
}

export { $, aiActionCurrent, aiAnswerOrigin, aiCacheSignature, aiCurrentAnswerPresent, aiDecisionBlocks, aiFingerprint, aiItemFingerprint, aiLiveFieldHash, aiOriginRecord, aiQuestionHash, aiRetiredSignatures, aiSafeText, aiSettledOnPage, aiSnapshotFieldMatches, clearAgentKeys, discardAiSuggestions, doneRestored, forgetKeptReports, keepReport, memory, migrateStoredData, persistAgentKeys, persistAiPending, persistDoneActions, persistGuardedEdits, persistUnitForms, pruneAgentRecords, restoreAgentKeys, restoreAiPending, restoreDoneActions, restoreReports, retireAiOrigins, settleRejectedAi, snapshotFingerprint, snapshotHashMatches, snapshotsEqual, state, store, testIntakes };
