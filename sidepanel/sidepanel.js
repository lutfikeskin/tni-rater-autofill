import * as pdfjs from '../lib/pdf.min.mjs';
import { readIntakeFields, readIntakePlaces } from '../src/intake.js';
import { sourcePlace } from '../src/intake-source.js';
import { normalizeIntake, parseEdit, rederive, ntlMention, ntlCheckMessage, intakeNotes } from '../src/normalize.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';
import { buildPlan, redactionTerms, supportedClass } from '../src/plan.js';
import { unitListSpecs, unitToAdd, advanceFor } from '../src/units.js';
import { carrierForUrl, quoteProgress, stopScreen } from '../src/carriers.js';
import { get, set, STATES } from '../src/util.js';
import { intakeSummary, fieldChangeEvent, fillEvents, clientErrorEvent, agentSettingsEvent, platformOf, checkDismissedEvent, redactor, sha256Hex, rulesHash, RULE_FILES, knownStep } from '../src/usage.js';
import { quoteStatePick, stateCode, stateMismatch } from '../src/quote-state.js';
import * as usage from './usage-log.js';
import { migrateStorage } from '../src/storage-version.js';
import { collectItems, AssistError, assistContextKey, stableJson, neverReason } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION, claimsTruncated, firstNameOf } from '../src/ai/luna.js';
import { PROVIDERS, settingsFrom, suggest, reviewNotes, reviewDriverNames } from '../src/ai/providers.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;

// Outside the extension (e.g. opening this page directly to check the layout) there is no
// chrome.* API: keep data in memory and disable filling.
const inExtension = !!globalThis.chrome?.scripting;
// The panel opened in a window of its own (Pop out, popOut) rather than as Chrome's side panel: it
// follows the browser window the agent last used (tabInView) and offers Dock instead.
const popped = new URLSearchParams(globalThis.location?.search ?? '').get('window') === 'popup';
// This copy of the panel: with one in its own window, only the newest stays (onPanelMessage).
const panelCopy = { id: globalThis.crypto?.randomUUID?.() ?? String(Math.random()), at: Date.now() };
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
const state = {
  intake: null, // { record, warnings, stats, fileName, done: number[] }
  active: { drivers: 0, vehicles: 0, trailers: 0 },
  tab: null, // { id, url, carrier }
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
  // Which screen shows: Settings over everything; otherwise the start screen, or the quote with its
  // three steps and the view they picked: step 1's checks ('check') or the page's answers ('page'),
  // all of them or a filter's ('all' | 'needs' | 'done'). The intake PDF opens in a sheet over it.
  settingsOpen: false,
  view: 'check',
  filter: 'all',
  fileMenuOpen: false,
  fileConfirm: null, // the file menu's question before the agent's work would go: 'replace' | 'clear'
  // The intake PDF: its bytes (also kept in session storage, keepPdf), the document pdf.js opened,
  // and the viewer's page, zoom and the item marked on it ({ path, label, kind, place }); null
  // while the viewer is closed.
  pdfBytes: null,
  pdfDoc: null,
  pdfDraw: 0,
  pdfTask: null,
  pdf: null,
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
};

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

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

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
  'halted', 'reason', 'stepUnread', 'stepKey', 'notDrawn', 'advanced', 'held', 'covered', 'coveredHelpers', 'renamed', 'pageChanged'];
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
  for (const e of was.entries) {
    if (!e?.key || !String(e.key).startsWith(`${tabId}|`) || state.reports.has(e.key) || !Array.isArray(e.frames)) continue;
    const active = { ...firstUnits(), ...(e.active ?? {}) };
    renderReport(e.frames, { tabId, page: e.page, carrier, active, plan: buildPlan(state.intake.record, carrier, active), stopped: !!e.stopped, keptKey: e.key, restoredAt: e.at ?? Date.now(), filledBefore: e.filledBefore });
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
    try { fresh = await runKit(tabId, tab.carrier, () => globalThis.__raterKit.decisionSnapshot()); } catch { /* page navigating */ }
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
    try { frames = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot()); }
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

// ---------------------------------------------------------------------------------------------
// Loading the intake PDF

async function loadFile(file) {
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
  if (state.intake) usage.log({ type: 'intake_closed', reason: 'replaced' });
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
  state.fileMenuOpen = false;
  state.fileConfirm = null;
  state.pdf = null;
  dropReports();
  const work = same ? workSaid(same.agentEdited?.length ?? 0, same.done?.length ?? 0) : '';
  clientNote(same ? `Same intake${work ? `: you ${work}, and that stays` : ''}.` : null);
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

function showLoadError(msg, name = '') {
  $('load-error').replaceChildren(h('b', {}, name ? `Couldn't read ${name}` : 'Couldn\'t read that file'), h('span', { class: 'small' }, msg));
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

// ---------------------------------------------------------------------------------------------
// Rendering the client record

function render() {
  const has = !!state.intake;
  showScreen();
  $('recording').hidden = !has;
  // Marking a test run (Settings → Advanced) needs an intake to mark.
  $('test-run-row').hidden = !has;
  if (!has) return;
  const { record, stats, fileName } = state.intake;
  const n = (k, one) => `${record[k].length} ${one}${record[k].length === 1 ? '' : 's'}`;
  const st = record.garaging?.state;
  $('client-name').textContent = record.applicant.name || record.applicant.owner1 || 'Unnamed business';
  $('client-name').title = `${fileName} · ${stats.filled} answers`;
  // The garaging state and what the quote is about: "Maryland · 2 drivers · 1 vehicle".
  $('client-meta').textContent = [st ? STATES[st] ?? st : null, n('drivers', 'driver'), n('vehicles', 'vehicle'),
    record.trailers.length ? n('trailers', 'trailer') : null].filter(Boolean).join(' · ');
  $('test-run').checked = !!state.intake.test;
  $('details-count').textContent = `${stats.filled} answers`;
  $('open-pdf').hidden = !pdfAvailable();
  $('file-menu').hidden = !state.fileMenuOpen;
  $('file-menu-btn').setAttribute('aria-expanded', String(state.fileMenuOpen));
  $('file-menu-items').hidden = !!state.fileConfirm;
  $('file-confirm').hidden = !state.fileConfirm;
  renderWarnings();
  renderSections();
  renderPickers();
  renderSite();
}

// Settings over everything but the header; otherwise the start screen, or the quote in the view its
// steps picked (step 1's checks, or the page's answers), with the intake PDF in a sheet over it.
// The dock goes away with Settings.
function showScreen() {
  const has = !!state.intake;
  const settings = state.settingsOpen;
  $('settings').hidden = !settings;
  $('pdf-view').hidden = !(has && !settings && state.pdf);
  $('details-view').hidden = !(has && !settings && state.detailsOpen && !state.pdf);
  for (const id of ['details-btn', 'details-row']) $(id).setAttribute('aria-expanded', String(!!state.detailsOpen));
  $('home').hidden = settings || has;
  $('quote').hidden = settings || !has;
  $('check-view').hidden = settings || !has || state.view !== 'check';
  $('page-view').hidden = settings || !has || state.view !== 'page';
  $('settings-btn').setAttribute('aria-expanded', String(settings));
  renderDock();
}

// Settings, at `focusId` when given (a setup reminder's field, the assistant's switch, its key).
function openSettings(focusId = null) {
  state.settingsOpen = true;
  showScreen();
  if (!focusId) { $('view').scrollTop = 0; return; }
  if ($('advanced').contains($(focusId))) $('advanced').open = true;
  if (focusId === 'ai-openai-key') openKeyForm(true);
  else $(focusId).focus();
  $(focusId).scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// The assistant's key in Settings: Add key (or Change) opens the box with the saved key in it, as
// dots, so clearing it and saving removes it; Save or Cancel closes it.
async function openKeyForm(open) {
  $('key-form').hidden = !open;
  $('key-edit').setAttribute('aria-expanded', String(open));
  if (!open) { await renderAiSettings(); return; }
  $('key-edit').textContent = 'Cancel';
  $('ai-openai-key').value = (await usage.settings()).lunaKey || '';
  $('ai-openai-key').focus();
}

// The step buttons: the quote's view, step 1's checks ('check') or the page's answers ('page').
function setView(view) {
  state.view = view;
  state.pastKey = null;
  showScreen();
  renderSteps();
  $('view').scrollTop = 0;
}

// The view an intake opens on (loaded, or restored when the panel reopens): step 1's checks while
// one is still open; else the page's answers.
function firstView(intake) {
  return intake?.warnings?.some((w, i) => w.level === 'check' && !intake.done?.includes(i)) ? 'check' : 'page';
}

// The feed's filters: every answer ('all'), what still needs the agent ('needs'), or what is in
// ('done'), whose answers are read back from the page then (refreshAnswers).
function setFilter(filter) {
  state.filter = filter;
  renderSteps();
  if (filter === 'done') refreshAnswers();
}

// Step 1, Check intake: one card per thing that looked wrong or missing, with its field to fix,
// Looks right now and where it is on the PDF; then the cleanup notes, and All client details below.
function renderWarnings() {
  const { warnings, done } = state.intake;
  const checks = warnings.map((w, i) => [w, i]).filter(([w]) => w.level === 'check');
  const infos = warnings.filter((w) => w.level === 'info');
  const open = checks.filter(([, i]) => !done.includes(i)).length;
  $('check-title').textContent = open ? `${open} thing${open === 1 ? '' : 's'} to look at on the intake` : 'The intake is checked';
  $('check-sub').textContent = open
    ? 'These looked wrong or missing. Fix the value or say it looks right. You can do this before or after filling.'
    : 'Nothing else looked wrong. You can change these any time.';
  const editable = (path) => path && /\.|\]$/.test(path) && fieldInfo(path).label !== path;
  // "See intake" only where the PDF shows the item (an answer only the agent gives: none).
  const pdfLink = (w, label) => {
    const place = sourcePlace(w.path, state.intake);
    return place && pdfAvailable()
      ? h('button', { type: 'button', class: 'link small', onclick: () => openPdf({ path: w.path, label, kind: 'check' }) }, `See intake${pdfPageSaid(place.page, ', page ')}`)
      : null;
  };
  const head = (info, w) => h('div', { class: 'issue-head' }, h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'),
    h('div', { class: 'check-text' }, info ? h('b', {}, info.label) : null, h('span', {}, w.msg)));
  const cards = checks.map(([w, i]) => {
    const info = editable(w.path) ? fieldInfo(w.path) : null;
    const label = info?.label ?? fieldInfo(w.path ?? '').label;
    if (done.includes(i)) {
      return h('div', { class: 'checked-row', dataset: { check: String(i) } }, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
        h('span', { class: 'grow' }, info ? `${info.label} checked` : 'Checked'),
        h('button', { type: 'button', class: 'link small', onclick: () => toggleDone(i, false) }, 'Undo'));
    }
    // Luna's GL and driver-gender items: their own buttons set the field (the agent's edit) or
    // dismiss the item, in place of the field and Looks right now.
    if (w.choices?.length) {
      return h('div', { class: 'check', dataset: { check: String(i) } }, head(info, w),
        h('div', { class: 'check-body' }, h('div', { class: 'check-actions' },
          h('div', { class: 'check-choices' }, ...w.choices.map((c) => h('button', { type: 'button', class: 'ghost', onclick: () => applyCheckChoice(i, c) }, c.label))),
          pdfLink(w, label))));
    }
    return h('div', { class: 'check', dataset: { check: String(i) } }, head(info, w),
      h('div', { class: 'check-body' },
        info ? fieldRow(w.path, info.label, info.kind, true, 'input') : null,
        h('div', { class: 'check-actions' },
          h('button', { type: 'button', class: 'ghost', onclick: () => toggleDone(i, true) }, 'Looks right now'),
          pdfLink(w, label) ?? (w.path && !info ? h('button', { type: 'button', class: 'link small', onclick: () => jumpTo(w.path) }, 'Show in client details') : null))));
  });
  $('warnings').replaceChildren(...cards,
    ...(infos.length ? [h('details', { class: 'cleanup' }, h('summary', { class: 'small muted' }, `Cleanup notes (${infos.length})`), h('ul', {}, infos.map((w) => h('li', {}, w.msg))))] : []));
  renderSteps();
}

async function toggleDone(i, isDone) {
  const w = state.intake.warnings[i];
  usage.log({ type: 'warning_checked', code: w.code, path: w.path, checked: isDone });
  const done = new Set(state.intake.done);
  if (isDone) done.add(i); else done.delete(i);
  state.intake.done = [...done];
  await save();
  renderWarnings();
  renderSections();
  // Keyboard focus stays where the agent was: on the row's Undo, or the card's Looks right now.
  const row = document.querySelector(`#warnings [data-check="${i}"]`);
  (row?.querySelector('button') ?? $('step-check')).focus();
}

function openFlags(prefix) {
  const { warnings, done } = state.intake;
  return warnings.filter((w, i) => w.level === 'check' && !done.includes(i) && w.path && (w.path === prefix || w.path.startsWith(`${prefix}.`) || w.path.startsWith(`${prefix}[`)));
}

// All client details, one card per section (the drawer), every field editable. Built again after
// an edit: the drawer keeps its place and the field in focus.
function renderSections() {
  const { record } = state.intake;
  const box = $('sections');
  const focused = box.contains(document.activeElement) ? document.activeElement.id : null;
  const top = box.scrollTop;
  box.replaceChildren();
  for (const section of SECTIONS) {
    const items = section.list ? record[section.list] ?? [] : [record[section.id]];
    if (section.list && !items.length) continue;
    const flags = openFlags(section.list ?? section.id);
    const body = h('div', { class: 'section-body' });
    items.forEach((_, idx) => {
      if (section.list) body.append(h('p', { class: 'item-title' }, `${section.item} ${idx + 1}`));
      for (const [tpl, label, kind = 'text'] of section.fields) {
        const path = tpl.replace('[]', `[${idx}]`);
        body.append(fieldRow(path, label, kind, flags.some((w) => w.path === path)));
      }
    });
    box.append(h('section', { class: 'section', dataset: { id: section.id }, 'aria-label': section.title },
      h('h3', { class: 'section-title' }, h('span', { class: 'title' }, section.title), flags.length ? h('span', { class: 'flag' }, `${flags.length} to check`) : null),
      body));
  }
  box.scrollTop = top;
  if (focused) $(focused)?.focus({ preventScroll: true });
}

function fieldRow(path, label, kind, flagged, layout = 'row') {
  const value = get(state.intake.record, path);
  const id = `f-${path.replace(/[^\w]/g, '_')}`;
  let input;
  if (kind === 'bool') {
    input = h('select', { id },
      h('option', { value: '' }, '—'),
      h('option', { value: 'true', selected: value === true }, 'Yes'),
      h('option', { value: 'false', selected: value === false }, 'No'));
  } else if (kind === 'textarea') {
    input = h('textarea', { id, rows: 4 });
    input.value = value ?? '';
  } else {
    input = h('input', { id, type: 'text', placeholder: 'not on form', maxLength: kind === 'state' ? 2 : 200 });
    input.value = value ?? '';
  }
  input.addEventListener('change', () => agentEdit(path, parseEdit(kind, input.value), kind));
  if (layout === 'stack' || layout === 'input') {
    // On a check card the same field may also be open in the client details: keep one id.
    input.removeAttribute('id');
    input.addEventListener('change', () => renderSections());
    // 'input': the card names the field above it.
    if (layout === 'input') { input.setAttribute('aria-label', label); return input; }
    return h('label', { class: 'field-stack' }, label, input);
  }
  return h('div', { class: `field${flagged ? ' flagged' : ''}${value == null ? ' empty' : ''}`, dataset: { path } },
    h('label', { for: id }, label), input);
}

// The agent's edit of one intake field, from All client details or a check card's button: set
// (synchronously, before anything awaits), marked agentEdited, derived values follow, logged
// without the value, saved, and what Luna read is read again when it changed.
async function agentEdit(path, after, kind) {
  const before = get(state.intake.record, path);
  set(state.intake.record, path, after);
  const edited = new Set(state.intake.agentEdited ?? []).add(path);
  state.intake.agentEdited = [...edited];
  // A value derived from this one (radius → miles, year established → years in business)
  // follows the edit, unless the agent set it here themselves; its row in the client details
  // shows the new value without a re-render.
  for (const derived of rederive(state.intake.record, path, { keep: edited })) {
    const row = document.getElementById(`f-${derived.replace(/[^\w]/g, '_')}`);
    if (!row) continue;
    const value = get(state.intake.record, derived);
    row.value = value ?? '';
    row.closest('.field')?.classList.toggle('empty', value == null);
  }
  intakeEdited();
  // Log that the agent corrected the intake here (and whether it was flagged), not the value.
  const flaggedCodes = state.intake.warnings.filter((w) => w.path === path).map((w) => w.code);
  usage.log({ type: 'intake_edit', path, kind, change: before == null ? 'added' : after == null ? 'cleared' : 'changed', warnings: flaggedCodes });
  await save();
  // Luna read the claims box against the form's coverages (NTL and GL are its own questions):
  // an edit to either is read again; a driver's first name, for the gender check, likewise.
  const notesEdit = path === 'claims.text' || path === 'notes.text';
  if (notesEdit) claimsTextEdited(state.intake);
  if (notesEdit || (path.startsWith('coverage.') && !['coverage.ntl', 'coverage.gl', 'coverage.hasGl'].includes(path))) reviewClaimsBox({ retry: true });
  if (/^drivers\[\d+\]\.first$/.test(path)) reviewDriverGender({ retry: true });
}

// "Show in client details": the drawer opens at the field, which is focused and flashed.
function jumpTo(path) {
  openDetails();
  const info = fieldInfo(path);
  const sectionId = info.section?.id ?? SECTIONS.find((s) => s.id === path || s.list === path)?.id;
  const section = $('sections').querySelector(`.section[data-id="${sectionId}"]`);
  if (!section) return;
  const row = $('sections').querySelector(`.field[data-path="${CSS.escape(path)}"]`) ?? section;
  row.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  if (row.classList.contains('field')) {
    row.classList.add('pulse');
    row.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove('pulse'), 1500);
  }
}

// The intake lists the page in front is about one of, or adds the next of: Progressive's vehicle
// and trailer pages and their list, Add Driver and the driver list; GEICO's Vehicles (vehicles and
// trailers) and Drivers & Incidents steps. None elsewhere: a business page isn't about a driver,
// and AmWINS shows every driver and every vehicle on one page.
function unitListsHere(carrier = state.tab?.carrier, page = pageOf(state.tab?.url), step = tabStep(carrier)) {
  if (!carrier) return [];
  const lists = new Set();
  if (carrier.vehiclePages?.includes(page) || carrier.vehicleList === page || (step && carrier.vehicleSteps?.includes(step))) lists.add('vehicles');
  if (carrier.trailerPages?.includes(page) || carrier.trailerList === page || (step && carrier.vehicleSteps?.includes(step))) lists.add('trailers');
  if (carrier.driverPage === page || carrier.driverList === page || (step && carrier.driverSteps?.includes(step))) lists.add('drivers');
  return [...lists];
}

// Which driver / vehicle / trailer the page is about (only when the intake has several, and only
// on a page about one of them: unitListsHere), as a compact choice each at the top of the page view.
function renderPickers() {
  if (!state.intake) return;
  const { record } = state.intake;
  const here = unitListsHere();
  const pickers = [
    ['drivers', 'Driver', (d) => [d.first, d.last].filter(Boolean).join(' ')],
    ['vehicles', 'Vehicle', (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')],
    ['trailers', 'Trailer', (t) => [t.year, t.make, t.type].filter(Boolean).join(' ')],
  ].filter(([list]) => here.includes(list) && (record[list] ?? []).length > 1)
    .map(([list, what, describe]) => ({ list, what, names: record[list].map((it, i) => `${i + 1}. ${describe(it) || what}`) }));
  // Drawn again only when what it shows changes (a list open stays open).
  const drawn = JSON.stringify(pickers.map((p) => [p.list, p.names, state.active[p.list]]));
  if ($('pickers').dataset.drawn === drawn) return;
  $('pickers').dataset.drawn = drawn;
  const focused = document.activeElement?.closest?.('#pickers') ? document.activeElement.id : null;
  $('pickers').replaceChildren(...pickers.map(({ list, what, names }) => {
    const id = `pick-${list}`;
    return h('div', { class: 'picker' },
      h('label', { for: id }, what),
      h('select', { id, onchange: async (e) => {
        const i = Number(e.target.value);
        // The agent says the form on the page is this one's: the form it was filled on before
        // (unitForms) no longer holds this form back.
        releaseUnitForms(list, i);
        state.active[list] = i;
        await save();
        renderPickers();
        // The page is now about this vehicle or driver: its own layout (a capture waiting for
        // the previous one is dropped).
        scheduleLayout(pageOf(state.tab?.url), 'picked');
      } }, names.map((name, i) => h('option', { value: String(i), selected: state.active[list] === i }, name))));
  }));
  if (focused) $(focused)?.focus();
}

// Picking vehicle (driver, trailer) `index` in the panel: the forms bound to it (unitForms) are
// let go, so the form on the page now can be filled for it (pagekit holds a form while the active
// unit was filled on another one). Other units' forms stay theirs, the one on the page too: picking
// the next vehicle before saving this one must not type the next vehicle into it. (The kit binds
// only a form it answered something on, so the owner's Add Driver, which GEICO already lists and
// the kit leaves empty, never holds the next driver back.)
function releaseUnitForms(list, index) {
  const forms = state.unitForms?.[list];
  if (!forms) return;
  const gone = Object.keys(forms).filter((id) => forms[id] === index);
  for (const id of gone) delete forms[id];
  if (gone.length) persistUnitForms(state.tab?.id, state.unitForms);
}

// ---------------------------------------------------------------------------------------------
// The current tab

// A tab finished loading or changed address. The followed tab, but also the active one: Progressive
// opens the quote in a new tab, which is still loading (no rater address yet) when it becomes
// active, so the panel kept following the old portal tab in the background.
function onTabUpdated(id, change, tab) {
  if ((id === state.tab?.id || tab?.active) && (change.url || change.status === 'complete')) refreshTab();
}

// The tab the panel looks at: as a side panel, the active tab of its own browser window; popped
// out, of the browser window the agent last used (the panel's own window has no quote tab).
async function tabInView() {
  if (!popped) return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return win ? (await chrome.tabs.query({ active: true, windowId: win.id }))[0] : undefined;
}

async function refreshTab() {
  if (!inExtension) { state.tab = null; return renderSite(); }
  const tab = await tabInView();
  if (Number.isInteger(tab?.windowId)) state.browserWindow = tab.windowId;
  // During a quote the agent may look at another site (email, the intake PDF): the panel stays
  // on the tab of the quote and keeps filling it in the background. Another rater tab is followed.
  const activeIsRater = !!(tab?.url && carrierForUrl(tab.url));
  if (!activeIsRater && state.intake && state.tab?.carrier && tab?.id !== state.tab.id) {
    const quote = await chrome.tabs.get(state.tab.id).catch(() => null);
    const carrier = quote?.url ? carrierForUrl(quote.url) : null;
    if (carrier) {
      state.tab = { id: quote.id, url: quote.url, carrier, background: true, windowId: quote.windowId };
      renderSite();
      ensureRecorder();
      scheduleLayout(pageOf(state.tab.url), 'arrived');
      return;
    }
  }
  if (tab?.id !== state.tab?.id) {
    // `active`: each quote tab is on its own vehicle and driver (Continue is remembered per vehicle).
    const keys = ['filled', 'labels', 'choices', 'autoPages', 'autoPaused', 'unreadRetried', 'triedAgain', 'agentKeys', 'doneActions', 'unitForms', 'unitShown', 'visitedPages', 'doneSteps', 'assistPage', 'unitNamed', 'active'];
    if (state.tab?.id) state.tabSessions.set(state.tab.id, Object.fromEntries(keys.map((key) => [key, state[key]])));
    const previous = state.tabSessions.get(tab?.id);
    // A quote tab the panel has no record for starts on vehicle 1 and driver 1, never on the tab it
    // was on before (W43-37, 2026-10-22: Progressive's first driver form got the second driver's
    // details, the one last picked on GEICO). The panel's first tab after it opens keeps the
    // selection saved for that tab.
    const restored = !previous && state.activeTab === tab?.id;
    Object.assign(state, previous ?? {
      filled: new Map(), labels: new Map(), choices: new Map(), autoPages: new Set(), autoPaused: false, unreadRetried: false, triedAgain: null,
      agentKeys: new Map(), doneActions: new Set(), unitForms: { vehicles: {}, drivers: {}, trailers: {} }, unitShown: null, visitedPages: new Set(), doneSteps: new Set(), assistPage: null,
      unitNamed: null, active: restored ? { ...(state.savedActive ?? state.active) } : firstUnits(),
    });
    if (state.intake) renderPickers();
    clearTimeout(state.autoTimer);
    state.autoDrawn = null;
    state.autoPending = false;
  }
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null, background: false, windowId: tab.windowId } : null;
  await restoreAgentKeys(state.tab?.id);
  await restoreDoneActions(state.tab?.id);
  await restoreReports(state.tab?.id);
  if (state.tab?.carrier && !state.filling) await retireAiOrigins({ tabId: state.tab.id, tabUrl: state.tab.url, intake: state.intake, carrier: state.tab.carrier });
  renderSite();
  ensureRecorder();
  // A recorder already in the page (the panel was closed or reloaded, or another tab was in
  // front) doesn't announce the page again: ask for its layout, and its quote state, here.
  scheduleLayout(pageOf(state.tab?.url), 'arrived');
  if (state.tab?.carrier?.quoteState) seedQuoteState(state.tab.id, state.tab.carrier, pageOf(state.tab.url));
}

// ---------------------------------------------------------------------------------------------
// Usage recording (see src/usage.js for what is and isn't kept)

// Progressive re-renders a page as "<Page>-Reload"; it's the same page.
const samePage = (p) => (p ?? '').replace(/-Reload$/, '');
// Progressive names its pages in ?pageName=; other sites by path or #/route (ids normalised).
const pageOf = (url) => {
  try {
    const u = new URL(url);
    const route = (u.pathname + (u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id');
    return samePage(u.searchParams.get('pageName') || route);
  } catch { return null; }
};

// Watch the rater tab while an intake is loaded. Only carrier pages; never other sites. Practice
// pages get it too (follow-up fills need it) but nothing from them goes in the usage log.
// A recorder already in the page is reused, and may still be paused by a fill the panel never
// finished (closed mid-fill): it is told to resume, unless a fill or AI apply is under way here.
async function ensureRecorder() {
  if (!inExtension || !state.intake || !state.tab?.carrier) return;
  const tabId = state.tab.id;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content/field-key.js', 'src/content/recorder.js'] });
  } catch { return; /* page not ready or not allowed; tried again on the next tab update */ }
  if (!state.filling) await tellRecorder('resume', tabId);
}

function tellRecorder(cmd, tabId = state.tab?.id) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, { ra: 'recorder', cmd }).catch(() => {});
}

function onRecorderMessage(msg, sender) {
  if (msg?.ra !== 'usage' || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier?.id ?? null;
  const log = (...events) => { if (!state.tab.carrier?.practice) usage.log(...events); };
  // Layouts are of the quote page, the tab's top frame; a child frame names its own address.
  const layoutPage = sender.frameId ? pageOf(state.tab.url) : samePage(msg.page);
  if (msg.event === 'page_view') {
    if (msg.from) state.visitedPages.add(samePage(msg.from));
    // A new page since this intake was loaded, or the first page of a tab opened since (the quote
    // Progressive opens in a new tab): this tab's layouts may be taken again. A tab that was
    // already open and only now gets a recorder may still show the previous client's quote.
    if (msg.from ? samePage(msg.from) !== samePage(msg.page) : state.layoutNewTabs.has(sender.tab.id)) state.layoutReadyTabs.add(sender.tab.id);
    log({ type: 'page_view', carrier, page: msg.page, view: viewOf(sender.tab.id, samePage(msg.page)), from: msg.from, fields: msg.fields });
    // A new document: a stop screen (noteStopScreen) is read again from its arrival's layout.
    state.stopScreens?.delete(sender.tab.id);
    // Arriving at a carrier stop page (a new document, a reload, or a move from another page; not
    // its "-Reload" re-render): logged as a fill run that stopped, with the page name only, and
    // only once the tab is shown to be this intake's quote. A step that is the agent's (stopSteps)
    // is logged as the step arrives (noteStep), and its note shown here too.
    const stopPage = samePage(msg.page);
    if (stopNoteFor(state.tab.carrier, stopPage)) {
      if (state.tab.carrier.stopPages?.[stopPage] && (!msg.from || samePage(msg.from) !== stopPage) && stopPageIsOurs()) {
        log(...fillEvents([{ fields: 0, blockers: [`stop: ${stopPage}`] }], { carrier, page: stopPage, view: viewOf(sender.tab.id, stopPage), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text }));
      }
      showStopPage();
    }
    if (!sender.frameId && state.tab.carrier?.quoteState) seedQuoteState(sender.tab.id, state.tab.carrier, samePage(msg.page));
    // Even with no fields in the top frame: a form may be all in child frames, which don't report
    // arrivals themselves.
    scheduleLayout(layoutPage, 'arrived');
    // Buttons that run again on every new arrival at their page (Print / Send: after the agent goes
    // back and changes something, coming back to print means printing the new quote).
    if (msg.from && samePage(msg.from) !== samePage(msg.page)) {
      for (const a of state.tab.carrier?.actions ?? []) {
        if (!a.repeatOnReturn || ![].concat(a.page ?? []).includes(samePage(msg.page))) continue;
        for (const id of [...state.doneActions]) if (id === a.id || id.startsWith(`${a.id}:`)) state.doneActions.delete(id);
        persistDoneActions();
      }
      if (state.tab.carrier?.trailerPage || state.tab.carrier?.driverPage || state.tab.carrier?.vehicleList) unitArrival(state.tab.carrier, samePage(msg.from), samePage(msg.page));
    }
    // Setting "Fill each new page as soon as it opens": fill right away (the fill itself waits
    // for the page to settle first).
    // Coming back to a page filled earlier in this quote (Rates after the bill plan) refills it
    // with the follow-up setting, so its next buttons (Recalculate, Print) run. Pages with only
    // buttons for us (Add Vehicle) count too.
    const page = samePage(msg.page);
    const hasButtons = (state.tab.carrier?.actions ?? []).some((a) => [].concat(a.page ?? []).includes(page));
    const wanted = $('auto-pages').checked || ($('auto-followups').checked && (state.autoPages.has(page) || (hasButtons && !msg.fields)));
    if (wanted && (msg.fields > 0 || hasButtons) && onQuotePage()) {
      setTimeout(() => { if (pageOf(state.tab?.url) === samePage(msg.page)) fillPage({ auto: 'page' }); }, 100);
    }
    return;
  }
  if (msg.event === 'field_changes') {
    // The step the changes were made on, as the recorder read it with them: the panel's own word on
    // the tab's step can come a message late, and GEICO's Vehicles is scoped per vehicle.
    const step = knownStep(state.tab.carrier, msg.step);
    const ctx = { record: state.intake.record, filled: state.filled, labels: state.labels, choices: state.choices, redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt,
      step };
    const view = viewOf(sender.tab.id, samePage(msg.page));
    log(...msg.changes.map((c) => ({ carrier, page: msg.page, view, ...fieldChangeEvent(c, ctx) })));
    scheduleLayout(layoutPage, 'changed');
    // The quote's state, by whoever picked it: remembered for this tab, checked against the intake.
    for (const c of msg.changes) {
      const code = quoteStatePick(state.tab.carrier, samePage(msg.page), c);
      if (code !== undefined) noteQuoteState(sender.tab.id, carrier, code);
    }
    const byAgent = msg.changes.filter((c) => c.agent);
    if (byAgent.length) {
      const page = samePage(msg.page);
      // On GEICO, by the unit forms on screen as the recorder saw them (changeScopes).
      for (const scope of changeScopes(page, state.tab.carrier, step, msg.forms)) {
        const keys = state.agentKeys.get(scope) ?? new Set();
        byAgent.forEach((c) => keys.add(c.key));
        state.agentKeys.set(scope, keys);
      }
      persistAgentKeys();
      // What the agent answered is no longer left for them in step 3 (an answer cleared still is),
      // and an answer the fill put in that they changed is theirs.
      answeredOnPage(page, byAgent.filter((c) => c.after !== ''));
      settleRejectedAi(page, byAgent, sender).then((released) => {
        if (released && state.tab?.id === sender.tab?.id && pageOf(state.tab?.url) === page) {
          syncAiBanner({ tabId: state.tab.id, page, carrier: state.tab.carrier });
          scheduleAutoFill(page);
        }
      }).catch(() => {});
      scheduleAutoFill(page);
    }
  }
  if (msg.event === 'new_fields') {
    const page = samePage(msg.page);
    // Questions drawn over a page already open (`fillOnDraw`, the addresses where it happens: GEICO's
    // Start New Quote window, over any gateway page) on a page no fill has answered anything on yet
    // (a gateway control drawn before the window is ignored): its first fill, as on arriving at a page.
    const firstFill = () => !state.autoPages.has(page) || !state.reports.get(currentReportKey())?.filled;
    if (state.tab.carrier?.fillOnDraw?.test(state.tab.url ?? '') && $('auto-pages').checked && firstFill() && onQuotePage() && !stopNoteFor(state.tab.carrier, page)) {
      setTimeout(() => { if (pageOf(state.tab?.url) === page) fillPage({ auto: 'page' }); }, 100);
    } else scheduleAutoFill(page, undefined, true);
    scheduleLayout(layoutPage, 'appeared');
  }
  if (msg.event === 'removed_fields') {
    scheduleLayout(layoutPage, 'removed');
    // A unit's form went away on a step with a unit list (GEICO's Next on a vehicle form, which
    // saves it and shows the list): the list draws no question, so no new_fields comes. With "Click
    // Continue when the page is done" on, a follow-up fill adds the next intake unit (FL live run 3,
    // 2026-10-21: nothing ran on the list until the agent clicked "+").
    const step = tabStep(state.tab.carrier);
    if (state.tab.carrier?.unitLists?.some((s) => s.steps.includes(step)) && $('auto-advance').checked) scheduleAutoFill(pageOf(state.tab.url));
  }
  // A unit list drawn, or its rows changed (the recorder's list_shown): GEICO draws the list 5–7 s
  // after the Next that saved a unit's form, after the follow-up above ran (FL live run 6,
  // 2026-10-21: nothing ran on the vehicle list until the agent clicked "+"). With "Fill the pages"
  // or "Click Continue when the page is done" on, as the "+" is clicked (pickUnitToAdd), a
  // follow-up fill adds the next intake unit.
  if (msg.event === 'list_shown') {
    const step = knownStep(state.tab.carrier, msg.step) ?? tabStep(state.tab.carrier);
    if (state.tab.carrier?.unitLists?.some((s) => s.steps.includes(step)) && ($('auto-advance').checked || $('auto-pages').checked)) scheduleAutoFill(pageOf(state.tab.url));
  }
  // A button the agent clicked themselves (its text, redacted): a helper or a Continue by hand.
  // On a one-address application, the step it was on (a known step name only, as elsewhere).
  if (msg.event === 'agent_click') {
    const page = samePage(msg.page);
    const step = state.tab.carrier?.layoutSteps ? knownStep(state.tab.carrier, msg.step) : undefined;
    log({ type: 'agent_click', carrier, page, view: viewOf(sender.tab.id, page), ...(step ? { step } : {}), text: redactor(redactionTerms(state.intake.record))(String(msg.text ?? '')).slice(0, 60) });
  }
  // An error or validation message appeared (a refused Continue): the layout carries the messages.
  if (msg.event === 'new_messages') scheduleLayout(layoutPage, 'messages');
}

// ---------------------------------------------------------------------------------------------
// Automatic follow-up fills: once the agent has filled a page, questions that appear later
// (revealed by an answer, or in a panel that opens) are filled with the intake/standard answers.
// Fields that already have a value, or that the agent changed, are left alone.

// Automatic fills only run on the carrier's quote pages (never e.g. its quote-search page).
const onQuotePage = () => !!state.tab?.carrier && (!state.tab.carrier.autoFillUrl || state.tab.carrier.autoFillUrl.test(state.tab.url ?? ''));

// A step counts as continued per page, and on a page about one vehicle or driver (Progressive's
// Add Vehicle, Add Driver) per active vehicle/driver: Add Vehicle looks the same for every
// vehicle, and the next vehicle's page is a new step, not the agent going back. Other pages stay
// quote-wide, so changing a picker never makes a page the agent left new again.
// Which tab and vehicle/driver an event was on, without naming either: the tab's order in this
// quote and, on a page about one vehicle or driver, its number (t1, t2:v0, t1:d1). Reviews use
// it to keep two quote tabs, or two vehicles, apart (scripts/lib/transitions.mjs).
function viewOf(tabId, page, carrier = state.tab?.carrier) {
  if (!Number.isInteger(tabId)) return undefined;
  if (!state.viewTabs.has(tabId)) {
    state.viewTabs.set(tabId, state.viewTabs.size + 1);
    saveViews();
  }
  const entity = stepScope(page, carrier, state.active, tabStep(carrier, tabId)).split('|')[1];
  return `t${state.viewTabs.get(tabId)}${entity ? `:${entity}` : ''}`;
}

// Kept with the quote's session (in session storage, like the intake), so a panel that's closed
// and opened again numbers the quote's tabs as before, and a new quote starts from t1.
function saveViews() {
  store.set('views', { session: usage.currentSession()?.id ?? null, tabs: [...state.viewTabs] })?.catch?.(() => {});
}
function resetViews() {
  state.viewTabs = new Map();
  saveViews();
}

// The step a tab of a one-address application (AmWINS, GEICO) is on, as the panel last heard it
// (noteStep, renderReport); undefined for carriers whose pages have their own addresses. It can lag
// the page by a message: callers that have the step the page itself named pass that instead.
function tabStep(carrier = state.tab?.carrier, tabId = state.tab?.id) {
  return carrier?.layoutSteps ? state.tabSteps?.get(tabId) : undefined;
}

// On a one-address application, a step about one vehicle or driver (GEICO's Vehicles, Drivers &
// Incidents: `vehicleSteps`, `driverSteps`) is scoped like Progressive's Add Vehicle and Add Driver.
function stepScope(page, carrier = state.tab?.carrier, active = state.active, step = tabStep(carrier)) {
  const entity = carrier?.vehiclePages?.includes(page) || (step && carrier?.vehicleSteps?.includes(step)) ? `v${active.vehicles ?? 0}`
    : carrier?.trailerPages?.includes(page) ? `tr${active.trailers ?? 0}`
      : (carrier?.driverPage && carrier.driverPage === page) || (step && carrier?.driverSteps?.includes(step)) ? `d${active.drivers ?? 0}` : '';
  return `${page}|${entity}|`;
}

// Agent edits are protected per page, and on a page about one vehicle or driver per that vehicle
// or driver (the scope of stepScope): correcting the first vehicle's value on Add Vehicle doesn't
// leave the next vehicle's box alone. `step`: the step the page named, when the caller has it.
// Where one address holds every step and unit form (formScoped: GEICO), whose steps and forms
// share field names (the owner's and each driver's name, the business's and each vehicle's ZIP):
// per step (`|s:<step>`), and on a unit step per form, the one the tab's latest fill ended on
// there (unitShown): its own while held as maybe another unit's (`|f:<id>`), else its unit's
// (`|v<i>`, `|tr<j>`, `|d<k>`); with none there (the owner check, the owner's driver form), the
// step's (`|s:<step>`, as changeScopes); before a fill read the step, the step's unit. No step
// known: the page.
// `active`, `shown`: those of the fill's tab (rememberFill).
function editScope(page, carrier = state.tab?.carrier, step = tabStep(carrier), { active = state.active, shown = state.unitShown } = {}) {
  if (formScoped(carrier)) {
    if (!step) return page;
    const list = carrier.vehicleSteps?.includes(step) ? 'vehicles' : carrier.driverSteps?.includes(step) ? 'drivers' : null;
    if (!list) return `${page}|s:${step}`;
    const here = shown?.step === step ? shown : null;
    if (here?.held) return `${page}|f:${here.id}`;
    if (here && !here.list) return `${page}|s:${step}`;
    const unit = here?.list ?? list;
    return `${page}|${{ vehicles: 'v', trailers: 'tr', drivers: 'd' }[unit]}${active?.[unit] ?? 0}`;
  }
  const scope = stepScope(page, carrier, state.active, step);
  return scope.endsWith('||') ? page : scope.slice(0, -1);
}

// One address for every step and every vehicle's, trailer's and driver's form (GEICO: its
// vehicleSteps and driverSteps): the agent's edits are kept per step and form (editScope).
function formScoped(carrier) {
  return !!(carrier?.vehicleSteps?.length || carrier?.driverSteps?.length);
}

// One vehicle's (trailer's, driver's) edits on a one-address application: `|v<i>`, `|tr<j>`, `|d<k>`.
function unitScope(page, list, index) {
  return `${page}|${{ vehicles: 'v', trailers: 'tr', drivers: 'd' }[list]}${index ?? 0}`;
}

// Where the agent's changes on the page are filed (the recorder's field_changes). Where one address
// holds every step and form (formScoped), on a unit step by the unit forms the recorder saw on
// screen with them (`forms`: [{ list, id }], pagekit unitFormsNow): each form's own (`|f:<id>`),
// and its unit's too unless the kit would hold it as maybe another unit's (bound to another, or new
// while the active unit was filled on another: pagekit unitFormsOf, against the tab's unitForms).
// None on screen (GEICO's owner check under Vehicles, a list): the step's. Forms not known (no fill
// in that document has named them): the tab's latest form (editScope). Elsewhere one scope, as
// editScope files it (Progressive and AmWINS as before). Element names only.
function changeScopes(page, carrier = state.tab?.carrier, step = tabStep(carrier), forms = null, { active = state.active, bound = state.unitForms } = {}) {
  if (!formScoped(carrier)) return [editScope(page, carrier, step)];
  if (!step) return [page];
  const list = carrier.vehicleSteps?.includes(step) ? 'vehicles' : carrier.driverSteps?.includes(step) ? 'drivers' : null;
  if (!list) return [`${page}|s:${step}`];
  if (!Array.isArray(forms)) return [editScope(page, carrier, step, { active })];
  const shown = forms.filter((u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id);
  if (!shown.length) return [`${page}|s:${step}`];
  const scopes = new Set();
  for (const { list: unit, id } of shown) {
    const forUnit = bound?.[unit] ?? {};
    const index = active?.[unit] ?? 0;
    const boundTo = Object.hasOwn(forUnit, id) ? forUnit[id] : null;
    const activeForm = Object.keys(forUnit).find((k) => forUnit[k] === index) ?? null;
    const held = (boundTo != null && boundTo !== index) || (boundTo == null && activeForm != null && activeForm !== id);
    scopes.add(`${page}|f:${id}`);
    if (!held) scopes.add(unitScope(page, unit, index));
  }
  return [...scopes];
}

// The agent's keys a fill leaves alone wherever it is: its edit scope's. Where one address holds
// every step and form (formScoped), only the page's own (edits made where no step was read): the
// kit leaves each step's and form's alone as it reads them on screen (fillSkipBy).
function fillSkip(agentKeys, scope, page, carrier) {
  return [...(agentKeys?.get(formScoped(carrier) ? page : scope) ?? [])];
}

// Where one address holds every step and form (formScoped), the agent's edits by where they were
// made, for the kit to leave alone on that step or form only (pagekit skipBy): per step (`|s:`),
// the active units' (the plan's vehicle, trailer and driver), per form (`|f:`), and which steps are
// about a vehicle or a driver. Null for other carriers. Keys and element names only.
function fillSkipBy(agentKeys, page, carrier, active = state.active) {
  if (!formScoped(carrier)) return null;
  const keysOf = (scope) => [...(agentKeys?.get(scope) ?? [])];
  const steps = {}, forms = {};
  for (const [scope, keys] of agentKeys ?? []) {
    const rest = String(scope).startsWith(`${page}|`) ? String(scope).slice(page.length + 1) : '';
    if (rest.startsWith('s:')) steps[rest.slice(2)] = [...keys];
    if (rest.startsWith('f:')) forms[rest.slice(2)] = [...keys];
  }
  return {
    steps,
    units: { vehicles: keysOf(`${page}|v${active?.vehicles ?? 0}`), trailers: keysOf(`${page}|tr${active?.trailers ?? 0}`), drivers: keysOf(`${page}|d${active?.drivers ?? 0}`) },
    forms,
    stepUnits: Object.fromEntries([...(carrier.vehicleSteps ?? []).map((s) => [s, 'vehicles']), ...(carrier.driverSteps ?? []).map((s) => [s, 'drivers'])]),
  };
}

// Whether the agent settled this field on the page. A row key (name#<row>, field-key v3) is also
// settled by its plain name, saved by an older build, which could have been any row's edit.
function agentEdited(page, key) {
  const keys = state.agentKeys.get(editScope(page));
  return !!keys && (keys.has(key) || keys.has(String(key ?? '').match(/^(.+)#\d+$/)?.[1]));
}

// `active`: the vehicle, driver and trailer the fill's plan is for (fillContext), which the agent's
// picker may have left since. `unitsListed`: the unit list on screen holds every intake unit
// (pickUnitToAdd), so its Looks Good may be clicked (advanceFor).
const fillOptions = (carrier, extra = {}, autoAdvance = $('auto-advance').checked, active = state.active, unitsListed = false) => ({
  replaceChoices: !!carrier.replaceChoices,
  // Where the page takes an answer back (GEICO's Quote & Coverages: keepTakenBack), the field keys
  // this tab's fills answered, so a later fill keeps what the page shows there now. Keys only. The
  // agent's Fill this page passes none (fillPage): it gives the answer again.
  takenBack: carrier.keepTakenBack?.length ? { steps: carrier.keepTakenBack, keys: Object.fromEntries([...(state.filled?.keys() ?? [])].map((key) => [key, true])) } : null,
  // The field keys this tab's fills answered: one the page has reset since is given again only on a
  // quiet page (W43-21). Keys only.
  filledBefore: [...(state.filled?.keys() ?? [])],
  // Carriers whose pages never wait on a server per answer are filled a round at a time.
  batch: !!carrier.batch,
  // The carrier's own components (GEICO's gds-*): a fill waits for those not defined yet.
  components: carrier.components ?? null,
  // Steps of a one-address application already continued from (a step the agent goes back to
  // isn't continued again). Each entry is scoped by its own step, not the one the panel last heard
  // the tab was on: GEICO's Vehicles is continued per vehicle, its other steps once a quote, and
  // each of its steps per form and button (advance `byForm`: "Vehicles@next@<form>").
  doneSteps: [...state.doneSteps].map((s) => [s, s.slice(s.indexOf('|', String(pageOf(state.tab?.url)).length + 1) + 1)])
    .filter(([s, raw]) => s === stepScope(pageOf(state.tab?.url), carrier, active, carrier.layoutSteps ? knownStep(carrier, raw.split('@')[0]) : undefined) + raw).map(([, raw]) => raw),
  // Click the page's Continue when nothing is left for the agent (setting below), but never
  // while the agent hasn't approved the AI's selections on this page.
  advance: autoAdvance && carrier.advance && !pendingAi(state.tab?.id, pageOf(state.tab?.url)).length ? advanceFor(carrier, unitsListed) : null,
  // "Check answers before Continue": Continue only for the page as the agent approved it (Looks
  // right passes its receipt as `confirmed`). Kept on this computer, not in the usage log.
  hold: !!$('check-continue')?.checked,
  confirmed: null,
  // Add NTL done on this intake's quote survives a panel reload (its removal hold depends on it).
  doneActions: [...state.doneActions, ...(state.intake?.ntlAdded ? ['addNtl'] : [])],
  visitedPages: [...state.visitedPages],
  // The carrier's own stop (see showStopPage): the page kit refuses to fill or click there too.
  stopPages: Object.keys(carrier.stopPages ?? {}),
  // Steps that are the agent's (GEICO's MVR & CLUE, Payment Information), by name: the kit reads
  // the step on the page at the start and every round, as the panel's word on it can lag.
  stopSteps: Object.keys(carrier.stopSteps ?? {}),
  // Which vehicle, driver and trailer the plan is for, how many the intake lists, and the forms
  // earlier fills on this tab answered for them (unitForms): a form that may be another unit's is
  // left for the agent (pagekit unitHeld). Element names and numbers only.
  units: {
    active: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, active?.[list] ?? 0])),
    count: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, state.intake?.record?.[list]?.length ?? 0])),
    bound: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, { ...state.unitForms?.[list] }])),
  },
  // A form that names its driver (carrier.unitNames: Progressive's "Questions about <name>") is
  // filled only for the driver the plan is for (W43-37).
  formUnit: unitNameFor(carrier, extra.expectPage ?? pageOf(state.tab?.url), active, state.intake?.record),
  // What this tab's fills gave, by field key, with the unit each was for: a field still showing
  // another unit's answer gets this unit's (W43-38).
  givenBefore: Object.fromEntries([...(state.filled ?? [])].map(([key, x]) => [key, { path: x.path ?? null, shown: x.shown ?? null }])),
  // Never change what the agent changed on this page, whether the fill is manual or automatic.
  skip: [...(state.agentKeys.get(editScope(pageOf(state.tab?.url))) ?? [])],
  ...extra,
});

// For the kit (fill `formUnit`) on a page whose form names its unit (carrier.unitNames): the
// pattern, each intake unit's name words (first and last, 2 letters or more), the plan's unit and
// its name as the panel shows it.
function unitNameFor(carrier, page, active, record) {
  const spec = (carrier?.unitNames ?? []).find((s) => s.page === page);
  if (!spec || !record) return null;
  const units = record[spec.list] ?? [];
  const words = (d) => [d?.first, d?.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
  const i = active?.[spec.list] ?? 0;
  return { list: spec.list, text: spec.text, names: units.map(words), active: i, label: [units[i]?.first, units[i]?.last].filter(Boolean).join(' ') || 'the selected driver' };
}

// Which rules this copy fills with: the rule files' fingerprint (src/usage.js rulesHash), read
// from the extension's own package when the panel starts, on every fill_run. Null outside the
// extension or until it's read; then the run just carries none.
let rulesVersion = null;
if (inExtension) {
  Promise.all(RULE_FILES.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text()))).then(rulesHash)
    .then((hash) => { rulesVersion = hash; }).catch(() => {});
}

// What a fill is about, taken before it waits on anything (audit 2026-10-08, finding 5): its own
// id (`run`, shared by its events), the tab, carrier and page it fills, the intake and revision it
// fills from, the view and edit scope for its tab, and the panel's switches. The intake may be
// replaced or corrected while the carrier works; the results then belong to this context, not to
// the panel's current state (staleFill), and its bookkeeping goes to this tab (rememberFill).
// `ids`: the quote (usage session) and intake the fill began in, which its events keep when they're
// logged after another intake was loaded. `settings.overwrite` is the overwrite the fill used
// (never for an automatic fill), not the checkbox. `asked`: the agent's own Fill this page (not an
// automatic fill, nor Looks right, which continues the page as approved).
function fillContext({ tabId, carrier, page, tabUrl, auto = false, overwrite = false, asked = false }) {
  const session = usage.currentSession();
  return {
    run: crypto.randomUUID(), tabId, carrier, page, tabUrl, auto, overwrite, asked,
    intake: state.intake, revision: state.intakeRevision, ids: { session: session?.id ?? null, intakeId: session?.intakeId ?? null },
    view: viewOf(tabId, page, carrier), scope: editScope(page, carrier, tabStep(carrier, tabId)), active: { ...state.active },
    settings: { autoAdvance: !!$('auto-advance').checked, autoFollowUps: !!$('auto-followups').checked, autoPages: !!$('auto-pages').checked, overwrite: !!overwrite },
  };
}
// The intake was replaced or corrected while the page was being filled: the answers on the page
// are the earlier intake's, and nothing from this fill may be remembered, logged or shown as the
// current intake's.
function staleFill(ctx) { return state.intake !== ctx.intake || state.intakeRevision !== ctx.revision; }
// Automatic work and panel reports belong only to the fill still shown in the panel.
function fillCurrent(ctx) { return !staleFill(ctx) && state.tab?.id === ctx.tabId; }
function noteStaleFill(ctx) {
  logFillError(ctx, 'stale: intake changed during the fill');
  fillProblem(ctx, 'The intake changed during the fill: the page may hold earlier answers. Check it, then fill again.');
}

// Whether the fill's tab shows another page than the one it was asked for, as Chrome has the tab's
// address now (the panel's own word on it can lag a message). Unknown counts as not moved: the kit
// checks again as it starts.
async function pageMoved(ctx) {
  let url;
  try { ({ url } = await chrome.tabs.get(ctx.tabId)); } catch { return false; }
  const now = pageOf(url);
  return now != null && now !== ctx.page;
}
// A fill whose page moved on before it began: nothing was filled or clicked. The page in front now is
// filled as a new page when the agent fills each new page (runPendingPage, once the fill is over); a
// fill the agent asked for says so and is logged. An automatic one isn't: a follow-up for the page
// a Continue just left is routine.
function notePageMoved(ctx) {
  if (ctx.auto) return;
  logFillError(ctx, 'page moved before the fill began');
  fillProblem(ctx, 'The page changed before the fill began. Nothing was filled or clicked; fill the page in front.', 'notice');
}

// A fill's error in words the agent can act on, with the browser's own message (redacted with the
// intake: it may quote the page) after it for a problem report.
function fillErrorMessage(ctx, e) {
  const raw = String(e?.message ?? e ?? '');
  const plain = /cannot access|permission|not allowed|cannot be scripted|chrome:\/\//i.test(raw)
    ? 'The browser blocked the extension on this page. Reload it, then fill again.'
    : /no tab with id|tab was closed/i.test(raw) ? 'The tab was closed during the fill.'
      : /frame|document|navigat|unload|back\/forward|receiving end/i.test(raw)
        ? 'The page changed or reloaded during the fill. Let it load, then fill again.'
        : 'Filling failed. Check the page, then fill again.';
  const detail = fillErrorText(ctx, e);
  return detail ? `${plain} (${detail})` : plain;
}

// While a fill runs: the answers in so far, read from the page every half second (pagekit
// progress), listed as they go in (renderLive) and counted in step 2 and the dock. Each frame sends
// only the rows after those the panel has from its list (`seen`, by the frame's list); a reading
// still under way skips the next. One the page hasn't answered for UNANSWERED_MS (a message box
// open on it holds its scripts, or a frame is stuck) is said in the dock and the list
// (`unanswered`); nothing is done to the page, and the fill goes on once it answers. Returns what
// stops the reading.
const UNANSWERED_MS = 5000;
function watchFill(ctx) {
  if (!inExtension) return () => {};
  const lists = new Map();
  let reading = null;
  const timer = setInterval(async () => {
    if (state.fillingFor?.run !== ctx.run) { clearInterval(timer); return; }
    if (reading != null) {
      if (Date.now() - reading >= UNANSWERED_MS && !state.fillingFor.unanswered) {
        state.fillingFor.unanswered = true;
        renderSteps();
      }
      return;
    }
    reading = Date.now();
    let frames;
    try {
      const seen = Object.fromEntries([...lists].map(([list, rows]) => [list, rows.length]));
      frames = await chrome.scripting.executeScript({ target: { tabId: ctx.tabId, allFrames: true }, world: worldFor(ctx.carrier),
        func: (s) => globalThis.__raterKit?.progress?.(s) ?? null, args: [seen] });
    } catch { return; /* the page is navigating */ } finally { reading = null; }
    const f = state.fillingFor;
    if (f?.run !== ctx.run) return;
    const answered = !!f.unanswered;
    f.unanswered = false;
    for (const { result } of frames) {
      if (!result?.list) continue;
      // A list the frame has rewritten (an answer given again) comes whole (`since` 0), as a new one.
      const had = result.since ? lists.get(result.list) ?? [] : [];
      if (!result.since) for (const list of lists.keys()) if (list.startsWith(`${result.frame}:`)) lists.delete(list);
      lists.set(result.list, [...had.slice(0, result.since), ...result.rows]);
    }
    // This step's answers only: another step's hidden fields filled again (otherStep) aren't its.
    const rows = [...lists.values()].flat().filter((x) => !x.otherStep);
    if (!answered && rows.length === f.filled && rows.every((x, i) => f.rows[i] === x)) return;
    f.filled = rows.length;
    f.rows = rows;
    renderSteps();
  }, 500);
  return () => clearInterval(timer);
}

// The answers going in now, one row each as the page takes them, and a row for the one coming:
// read from the page (pagekit progress), nothing typed or guessed here. Shown in the page view in
// place of the report while a fill on the tab in front runs.
function renderLive() {
  const f = state.fillingFor;
  const live = $('live');
  const on = !!f && state.filling && f.tabId === state.tab?.id && (!f.auto || !!f.rows?.length);
  live.hidden = !on;
  if (!on) { live.replaceChildren(); delete live.dataset.count; live.drawn = []; return; }
  const rows = f.rows ?? [];
  const count = `${rows.length}${f.stopping ? 's' : ''}${f.unanswered ? 'u' : ''}`;
  if (live.dataset.count === count && live.drawn === rows) return;
  live.dataset.count = count;
  // The new answers join those listed already; a list the page rewrote is listed anew.
  const drawn = live.drawn ?? [];
  const more = drawn.length <= rows.length && drawn.every((x, i) => rows[i] === x);
  if (more) {
    live.querySelector(':scope > .typing')?.remove();
    live.querySelector(':scope > .fresh')?.classList.remove('fresh');
  } else live.replaceChildren();
  live.append(...rows.slice(more ? drawn.length : 0).map((x) => h('div', { class: 'row' },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-icon', 'aria-hidden': 'true' }, '✓'),
      h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, x.label || 'Answer'), h('span', { class: 'row-value' }, x.shown || 'filled')),
      x.standard ? h('span', { class: 'tag standard', title: 'A TNI standard answer, not a fact from the intake' }, 'TNI standard') : null))));
  live.drawn = rows;
  if (rows.length) live.lastElementChild?.classList.add('fresh');
  if (!f.stopping) {
    live.append(h('div', { class: 'row typing' }, h('div', { class: 'row-head' },
      h('span', { class: 'row-icon', 'aria-hidden': 'true' }, h('span', { class: 'spinner' })),
      h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, f.unanswered ? 'Waiting for the page' : rows.length ? 'Next answer' : 'Reading the page'),
        h('span', { class: 'row-value' }, f.unanswered ? 'It isn’t answering' : 'Working…')))));
  }
  live.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
}

// Step 2's Stop: halts the running fill in every frame of its tab (pagekit stop), as an agent edit
// does. What is in stays; nothing more is filled or clicked, Continue included.
async function stopFill() {
  const f = state.fillingFor;
  if (!f || f.stopping) return;
  f.stopping = true;
  $('fill-stop').disabled = true;
  renderSteps();
  try {
    // With the fill's run id: a fill that hasn't begun in a frame yet halts as it starts there.
    await chrome.scripting.executeScript({ target: { tabId: f.tabId, allFrames: true }, world: worldFor(f.carrier),
      func: (run) => globalThis.__raterKit?.stop?.(run) ?? false, args: [f.run] });
  } catch { /* the page is navigating: the fill ends anyway */ }
}

// Scrolling into view: at once for an agent who asked the system for less motion.
function scrollBehavior() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// After a fill: the page's answers come into view (steps 2 and 3). An automatic fill doesn't pull
// the agent out of step 1 while they're working in it.
function showFinish({ auto = false } = {}) {
  if (auto && state.view === 'check' && $('check-view').contains(document.activeElement)) return;
  state.view = 'page';
  showScreen();
  renderSteps();
  $('page-view').scrollIntoView({ block: 'start', behavior: scrollBehavior() });
}
// The step a one-address application (AmWINS) showed to the fill: the top frame's headings, sent
// only as one of the carrier's step names (knownStep).
function stepOfResults(carrier, results) { return knownStep(carrier, results.find((r) => r.frameId === 0)?.result?.stepKey); }
// The events of a fill, redacted with the intake it filled from.
function logFill(ctx, frames, results, started) {
  if (ctx.carrier.practice) return;
  const redact = redactor(redactionTerms(ctx.intake.record));
  state.lastRuns?.set(`${ctx.tabId}|${ctx.page}`, { run: ctx.run, at: Date.now(), step: stepOfResults(ctx.carrier, results),
    blockers: frames.flatMap((f) => f.blockers ?? []).slice(0, 6).map((b) => redact(String(b)).slice(0, 120)) });
  // Why a unit list's Looks Good wasn't among the buttons (pickUnitToAdd), with the kit's blockers.
  usage.log(...fillEvents(ctx.listNote ? [...frames, { blockers: [ctx.listNote] }] : frames, {
    carrier: ctx.carrier.id, page: ctx.page, view: ctx.view, overwrite: ctx.overwrite, auto: ctx.auto, ms: Date.now() - started,
    redact: redactor(redactionTerms(ctx.intake.record)), keySalt: usage.currentSession()?.keySalt,
    run: ctx.run, rules: rulesVersion ?? undefined, settings: ctx.settings, step: stepOfResults(ctx.carrier, results),
  }));
}
function fillErrorText(ctx, e) { return redactor(redactionTerms(ctx.intake.record))(String(e?.message ?? e)).slice(0, 200); }
// A rejected fill has no fill_run result to carry its rule version and switches.
function logFillError(ctx, error) {
  if (ctx.carrier.practice) return;
  usage.log({ type: 'fill_error', carrier: ctx.carrier.id, page: ctx.page, run: ctx.run,
    rules: rulesVersion ?? undefined, settings: ctx.settings, auto: ctx.auto, error: fillErrorText(ctx, error), ...ctx.ids });
}

// `drawn`: the page drew new questions (the recorder's new_fields), which a step that takes
// follow-ups only for those (`newQuestionsOnlySteps`) waits for.
function scheduleAutoFill(page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }, drawn = false) {
  if (state.autoPaused || !$('auto-followups').checked || !state.autoPages.has(page) || !onQuotePage() || stopNoteFor(state.tab?.carrier, page, undefined, ctx.tabId) || stateIssue()) return;
  if (drawn) state.autoDrawn = page;
  if (state.filling) { state.autoPending = true; return; }
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => { if (fillCurrent(ctx)) autoFill(page); }, 600);
}

async function autoFill(page) {
  // New questions drawn (scheduleAutoFill), used by this fill only: never left for a later one,
  // which may follow an answer.
  const drawn = state.autoDrawn === page;
  state.autoDrawn = null;
  // The client may have been cleared while this fill was waiting to run.
  if (state.autoPaused || state.filling || state.closing || !state.intake || !state.tab?.carrier || pageOf(state.tab?.url) !== page) return;
  if (stopNoteFor(state.tab.carrier, page) || stateIssue()) return;
  const { id: tabId, carrier } = state.tab;
  // A page or step without a report yet is new, not a follow-up: the agent moved to AmWINS' next
  // step themselves (same address, new questions). It's filled as a new page, with its report.
  if (!state.reports.has(reportKey(tabId, page, carrier))) { fillPage({ auto: 'page' }); return; }
  const stepBefore = state.tabSteps?.get(tabId);
  // A step the carrier redraws on every answer (GEICO's Quote & Coverages: newQuestionsOnlySteps)
  // is filled when it opens, on Fill this page, and when it draws new questions (the cargo
  // section's), never after an answer or a redraw.
  if (carrier.newQuestionsOnlySteps?.includes(stepBefore) && !drawn) return;
  // Before any waiting: the agent may pick another vehicle or tab, or load another intake, while
  // the carrier works (fillContext; the view is taken there).
  const ctx = fillContext({ tabId, carrier, page, tabUrl: state.tab.url, auto: true });
  await pickListItem(carrier, page, ctx);
  if (staleFill(ctx) || state.tab?.id !== tabId) return;
  // A fill the agent started while the list was read (Fill this page, Looks right) goes first;
  // this one follows it rather than running beside it.
  if (state.filling) { state.autoPending = true; if (drawn) state.autoDrawn = page; return; }
  state.filling = true;
  state.autoPending = false;
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  // The page moved on before the fill began (pageMoved): the page in front gets its fill after this.
  let moved = false;
  let unwatch = () => {};
  try {
    await tellRecorder('pause', tabId);
    await retireAiOrigins({ tabId, tabUrl: ctx.tabUrl, intake: ctx.intake, carrier });
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (!fillCurrent(ctx)) return;
    // The list page may have picked the next vehicle or driver: the plan is for that one.
    ctx.active = { ...state.active };
    // A unit no fill has a report for yet (the one the list added, or the next one's form): its
    // report is shown, as a new step's is (FL live run 6, 2026-10-21: vehicles 2 and 3 were filled by
    // follow-ups while the panel still showed the answers of the vehicle before).
    const unseen = !state.reports.has(reportKey(tabId, page, carrier, ctx.active, stepBefore));
    // Honor the latest switch after preparation, and log the same value used by the kit. The unit the
    // fill adds (pickUnitToAdd) has its "+" and chooser Next clicked only with it on (`click`).
    ctx.settings.autoAdvance = !!$('auto-advance').checked;
    const plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
    const skip = fillSkip(tabMaps(tabId).agentKeys, ctx.scope, ctx.page, carrier);
    const skipBy = fillSkipBy(tabMaps(tabId).agentKeys, ctx.page, carrier, ctx.active);
    // The tab moved on to another page meanwhile: that one gets its own fill (fillPage).
    if (await pageMoved(ctx)) { moved = true; notePageMoved(ctx); return; }
    const options = fillOptions(carrier, { overwrite: false, skip, ...(skipBy ? { skipBy } : {}), keepMarks: true, expectPage: ctx.page }, ctx.settings.autoAdvance, ctx.active, ctx.unitsListed);
    // Its answers listed as they go in, as a fill the agent asked for, from the first one in (`auto`:
    // a follow-up that answers nothing never replaces the report; W43-42, 2026-10-22: a 29-second
    // automatic fill showed nothing until it ended).
    state.fillingFor = { run: ctx.run, tabId, carrier, key: reportKey(tabId, page, carrier, ctx.active), filled: 0, rows: [], stopping: false, auto: true };
    unwatch = watchFill(ctx);
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, options]);
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (results.some((r) => r.result?.pageMoved)) { moved = true; notePageMoved(ctx); return; }
    // Filled with this intake: the tab's quote is this client's, so its layouts may be taken.
    // Only once the fill went through; a fill that failed proves nothing about the page.
    state.layoutReadyTabs.add(tabId);
    const frames = results.map((r) => r.result).filter(Boolean);
    const retrying = rememberFill(frames, ctx);
    followUp = afterFill(frames, ctx);
    const hasWarnings = frames.some((f) => f.unknown?.length);
    // Held for the agent's check (Check answers before Continue): Looks right is in its report. A
    // unit form held as maybe another vehicle's or driver's (pagekit unitHeld) is said there too:
    // a quiet follow-up would leave the agent looking at the last form's report.
    const held = frames.some((f) => f.held || f.unitHeld);
    // Continue or a helper not clicked for something open over it on the page (pagekit `covered`,
    // `coveredHelpers`): said in the report, which a quiet follow-up wouldn't show.
    const covered = frames.some((f) => f.covered || f.coveredHelpers?.length);
    // Stopped by the agent: said as a stop, not as an error (as fillPage does).
    const stopped = state.fillingFor?.run === ctx.run && !!state.fillingFor.stopping && frames.some((f) => f.halted);
    const current = fillCurrent(ctx);
    // The page showed another step than the panel knew (the recorder's step came late): a new
    // step, with a report of its own, as above.
    const step = carrier.layoutSteps ? stepOfResults(carrier, results) : null;
    const newStep = !!step && step !== stepBefore && !state.reports.has(reportKey(tabId, page, carrier, ctx.active, step));
    // The fill whose helper this follows up held Luna back for it.
    const rendered = current && (newStep || unseen || held || covered || state.autoPaused || hasWarnings || state.assistPage === page);
    if (rendered) { renderReport(frames, { ...ctx, plan, retrying, stopped }); assistFrames = frames; }
    if (current && (newStep || unseen || held || covered)) showFinish({ auto: true });
    // This step's answers only: another step's hidden fields filled again (otherStep) aren't its.
    const added = frames.flatMap((f) => f.filled).filter((x) => !x.otherStep);
    const n = added.length + frames.reduce((k, f) => k + (f.actions?.length ?? 0), 0);
    if (n || hasWarnings || frames.some((f) => f.filled.length)) {
      logFill(ctx, frames, results, started);
      if (n && current && !rendered && reportShown()) {
        // Listed with the page's answers, marked new, and counted in step 2.
        // With their sources and groups as the report has them (answerSources, groupRows).
        const rctx = { tabId, page, carrier };
        const { fromOf, groupOf, ticks, editedBy } = answerSources(plan);
        const answers = groupRows(added.map((x) => ({ label: x.label || x.name, value: x.shown ?? '', standard: !!x.standard, path: x.path, from: fromOf.get(x.stepId), edited: editedBy(x.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId, answer: true, key: x.key, field: x.label ?? null, q: x.q ?? null })), ticks);
        const rows = [...answers.map((row) => answerRow({ ...row, fresh: true }, rctx)),
          ...frames.flatMap((f) => f.actions ?? []).map((a) => answerRow({ label: 'Clicked', value: a.text || a.id, kind: 'clicked', fresh: true }, rctx))];
        let list = $('report').querySelector(':scope > .rows');
        if (!list) { list = h('div', { class: 'rows' }); $('report').append(list); }
        list.append(...rows);
        state.reportFor.filled = (state.reportFor.filled ?? 0) + answers.filter((row) => row.answer).length;
        renderSteps();
        announce(`Filled ${n} follow-up question${n === 1 ? '' : 's'} automatically.`);
      }
      if (current) recordLayout(page);
    } else if (ctx.listNote || frames.some((f) => f.advanceDue || f.held)) logFill(ctx, frames, results, started);
  } catch (e) {
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    tabMaps(tabId).autoPaused = true;
    // The message may quote the page, so it's redacted with the origin intake.
    logFillError(ctx, e);
    fillProblem(ctx, 'Automatic filling paused after an error. Check the page, then fill again.');
  } finally {
    unwatch();
    if (state.fillingFor?.run === ctx.run) state.fillingFor = null;
    await tellRecorder('resume', tabId);
    state.filling = false;
    renderSteps();
    if (fillCurrent(ctx) && state.autoPending) scheduleAutoFill(page);
    // The page in front, which this fill wasn't for: its stop card, or its own fill.
    if (moved && fillCurrent(ctx)) {
      if (stopNoteFor(state.tab?.carrier, pageOf(state.tab?.url))) showStopPage();
      runPendingPage(ctx);
    }
  }
  if (!fillCurrent(ctx)) return;
  // The page moved on to a stop page while this ran: its card stays on top of this fill's report.
  if (stopNoteFor(state.tab?.carrier, pageOf(state.tab?.url))) showStopPage();
  runPendingPage(ctx);
  // A fill that halted on a step it couldn't read (GEICO's progress bar and title disagreeing:
  // pagekit reads nothing there) leaves the page to the agent: Luna isn't asked about it.
  const unread = formScoped(carrier) && !!assistFrames?.some((f) => f.halted && !knownStep(carrier, f.stepKey));
  if (assistFrames && !unread) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

function runPendingPage(ctx) {
  const pending = state.pagePending;
  state.pagePending = null;
  if (pending && pending === pageOf(state.tab?.url)) setTimeout(() => {
    if (fillCurrent(ctx) && pending === pageOf(state.tab?.url)) fillPage({ auto: 'page' });
  }, 300);
}

// Each page's question layout (ids, question text, options, which choice is picked; no typed
// text) goes into the usage log whenever it differs from the last one logged for that page, so
// layouts for every state and product collect themselves as agents quote, and a follow-up
// question's appearing and going away are both seen. scripts/build-layouts.mjs turns them into
// test pages. `reason`: fill, or what changed on the page (see scheduleLayout). One at a time, in
// order, so a page's layouts are logged in the order they were seen.
function recordLayout(page, reason = 'fill', job = layoutJob(page)) {
  const run = state.layoutChain.then(() => captureLayout(job, reason)).finally(() => { job.done = !job.waitsForFill; });
  state.layoutChain = run.catch(() => {});
  return run;
}

// A capture is asked for one quote, tab, page and active vehicle/driver. It's dropped when any of
// them has changed by the time the page is read or its answer comes back, so a page is never
// logged under another page's name, another client's quote, context or redaction.
// Corrected intake facts count too: the page may still show the old ones, and the context and
// redaction would come from the new.
function layoutJob(page, session = usage.currentSession()?.id) {
  return { session, tabId: state.tab?.id, carrier: state.tab?.carrier, page, active: JSON.stringify(state.active), revision: state.intakeRevision };
}

function jobCurrent(job) {
  return !!job.session && !!state.intake && usage.currentSession()?.id === job.session
    && state.tab?.id === job.tabId && state.tab?.carrier?.id === job.carrier?.id
    && pageOf(state.tab.url) === job.page && JSON.stringify(state.active) === job.active
    && state.intakeRevision === job.revision;
}

// The agent corrected the intake: a capture already reading the page is dropped (jobCurrent), and
// one still waiting is asked again for the corrected intake.
function intakeEdited() {
  state.intakeRevision++;
  showStateNote();
  const pending = state.layoutPending;
  if (!pending) return;
  cancelLayouts();
  for (const reason of pending.reasons) scheduleLayout(pending.page, reason);
}

// A capture asked for by a page change is also dropped when a later change has been asked for
// since: this one would log the later state under the earlier answer. The latest capture reads
// the page after both and, until it's logged, takes this one's reasons. (A fill's own capture
// has no generation.)
function sameLayoutScope(a, b) {
  return ['session', 'tabId', 'page', 'active'].every((k) => a[k] === b[k]);
}
function superseded(job) {
  if (job.generation === undefined || job.generation === state.layoutGeneration) return false;
  const later = state.layoutLatest;
  if (job.reasons && later && later !== job && !later.done && sameLayoutScope(later, job)) job.reasons.forEach((r) => later.reasons.add(r));
  return true;
}

// `reason`: given for a fill's capture; one asked for by page changes says its reasons when it's
// logged, since later changes may have handed it theirs.
async function captureLayout(job, reason) {
  const why = () => reason ?? [...job.reasons].sort().join('+');
  job.waitsForFill = false;
  if (!jobCurrent(job) || job.carrier.practice || superseded(job)) return;
  // A fill started while this page change's capture was queued: reading now could catch the page
  // half filled. It waits for the fill again, as it did before it was queued.
  const fillStarted = () => job.generation !== undefined && state.filling;
  if (fillStarted()) return waitForFill(job);
  const { tabId, carrier, page } = job;
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [buildPlan(state.intake.record, carrier, state.active), redactionTerms(state.intake.record)]);
    if (!jobCurrent(job) || superseded(job)) return;
    if (fillStarted()) return waitForFill(job);
    // The page actually read, as the page itself names it: the tab's address in the panel can
    // lag behind a navigation, and the next page must never be logged under this one's name.
    const top = results.map((r) => r.result).find((f) => f?.isTopFrame);
    if (top?.page !== page) return;
    // On a one-address application, which step (Insured Info, Vehicles, …): otherwise every step
    // would look like one page whose questions come and go. Only as one of the carrier's step
    // names (knownStep), like fill and field-change events: a heading can name the insured, and
    // the tab may still show the previous client's quote. Any other heading: no step.
    const step = carrier.layoutSteps ? knownStep(carrier, top.step) : undefined;
    // A stop step (GEICO's Payment Information, MVR & CLUE) is the agent's alone: no layout of it,
    // whose labels and messages may repeat payment or report details. By its title too, since the
    // kit reads no step when the progress bar and the title disagree.
    const stopTitle = Object.keys(carrier.stopSteps ?? {}).some((n) => String(top.title ?? '').toLowerCase().includes(n.toLowerCase()));
    if ((step && carrier.stopSteps?.[step]) || stopTitle) return;
    const buttons = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.buttons ?? []))];
    noteStopScreen(job, step, buttons);
    // What the page said about the answers (validation, errors, help), as pagekit's capture reads
    // and redacts it: the carrier's own wording of a refusal, which no other event carries.
    const messages = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.messages ?? []))].slice(0, 40);
    const fields = results.map((r) => r.result).filter(Boolean).flatMap((f) => f.controls).map((c) => {
      // Agency staff lists (agent of record, agent/producer codes) aren't page structure.
      const staff = /agent|producer/i.test(c.label ?? '');
      return {
        q: c.q ?? null, ref: c.ref ?? null, row: /^\d{1,3}_\d{1,3}$/.test(c.row ?? '') ? c.row : null, kind: c.kind, type: c.type, label: c.label, required: c.required, section: c.section,
        // Element ids (stable ones only) and data-ids: how id-based rules (AmWINS) find the field.
        id: c.id && !/\d{5,}|ext-|-inputEl$/.test(c.id) ? c.id : null, dataId: c.dataId ?? null, name: c.name ?? null,
        options: c.options?.length && !staff ? c.options : undefined,
        optionsTruncated: c.optionsTruncated, mapped: c.wouldFill ?? null,
        // The choice picked now and whether a box has something in it: which answers were on the
        // page when follow-up questions appeared. Only a pick that is one of the captured choices
        // (or a checkbox's state): an editable dropdown's text may be typed or half-searched.
        selected: !staff && c.selected && (c.kind === 'checkbox' || (c.options ?? []).includes(c.selected)) ? c.selected : undefined,
        pageHasValue: c.pageHasValue,
      };
    });
    // Compared with the last layout logged for this page in this quote. Only the structure
    // counts: the questions, their choices and which are required. Answers are in the change
    // events; counting them would log a layout per answer. Yes, No, then Yes again on a
    // question that shows a follow-up logs three layouts. A field renamed under the same number
    // (its data-model name) is a change too: that's the evidence of a carrier rename.
    const shape = fields.map((f) => [f.q ?? f.label, f.ref, f.label, !!f.required, f.options ?? [], !!f.optionsTruncated]);
    // Messages too: the same questions with a new error on them is a page worth recording.
    const signature = await sha256Hex(JSON.stringify(messages.length ? [shape, messages] : shape));
    if (!jobCurrent(job) || superseded(job)) return;
    // Per quote tab too: each tab keeps its own quote state (refreshTab).
    const scope = `${job.session}|${tabId}|${carrier.id}|${editScope(page, carrier, step)}|${step ?? ''}`;
    // An empty page counts only when questions went away (an answer hid the last one) or a message
    // appeared: a fill or an arrival that finds nothing is a page still loading, or one without questions.
    if (!fields.length && !why().split('+').some((r) => r === 'removed' || (r === 'messages' && messages.length))) return;
    if (state.lastLayouts.get(scope) === signature) return;
    state.lastLayouts.set(scope, signature);
    const r = state.intake.record;
    const context = {
      state: r.garaging?.state ?? null,
      businessClass: r.operations.businessClass,
      vehicleTypes: [...new Set(r.vehicles.map((v) => v.type).filter(Boolean))],
      trailers: r.trailers.length > 0,
      drivers: r.drivers.length,
      vehicles: r.vehicles.length,
      coverages: Object.entries(r.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    };
    usage.log({ type: 'page_layout', carrier: carrier.id, page, view: viewOf(tabId, page, carrier), step, reason: why(), context, fields, buttons, ...(messages.length ? { messages } : {}) });
  } catch (e) {
    // A capture overtaken by a later change (a redraw can make its read fail) hands its reasons
    // on instead of reporting a failure for a page that is being captured anyway.
    if (jobCurrent(job) && !superseded(job)) layoutFailed(job, why(), layoutErrorKind(e));
  }
}

// A screen that is the agent's (carrier `stopButtons`: GEICO's "Add USDOT Number / Skip", W43-27),
// known by a button only it shows, as a layout reads the page: said on a quiet card above the page's answers while the
// tab shows it (showStopPage), its arrival logged as a fill run that stopped, as a stop step's is,
// and nothing filled, clicked or asked of the AI there (stopNoteFor). A layout read without it, a
// move to a step or a new document (noteStep, the page_view arrival) ends it; a question or list
// GEICO draws while the screen is up doesn't (review of #141).
function noteStopScreen({ tabId, carrier, page }, step, buttons) {
  const name = stopScreen(carrier, buttons);
  const was = state.stopScreens.get(tabId);
  if (name === (was?.name ?? null) && (!name || was.page === page)) return;
  if (name) state.stopScreens.set(tabId, { name, page }); else state.stopScreens.delete(tabId);
  if (name) usage.log(...fillEvents([{ fields: 0, blockers: [`stop: ${name}`] }], { carrier: carrier.id, page, view: viewOf(tabId, page, carrier), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text, step }));
  if (tabId === state.tab?.id) renderSite();
}

function waitForFill(job) {
  job.waitsForFill = true;
  state.layoutPending = job;
  clearTimeout(state.layoutTimer);
  state.layoutTimer = setTimeout(() => layoutWhenQuiet(job), LAYOUT_DELAY_MS);
}

// A layout that couldn't be read: counted for the panel, and logged once per quote, page and kind
// of failure, so it shows up in the review instead of just missing.
function layoutFailed({ tabId, carrier, page }, reason, error) {
  state.layoutErrors++;
  // Per quote tab, as layouts are: each tab is its own quote.
  const once = `${usage.currentSession()?.id}|${tabId}|${page}|${error}`;
  if (state.layoutErrorsLogged.has(once)) return;
  state.layoutErrorsLogged.add(once);
  usage.log({ type: 'layout_error', carrier: carrier.id, page, view: viewOf(tabId, page, carrier), reason, error });
}

// What kind of failure, never its message: Chrome's and the page's errors can quote the page's
// address and values from it.
function layoutErrorKind(e) {
  const m = String(e?.message ?? e);
  if (/frame/i.test(m) && /removed|not found|no frame/i.test(m)) return 'frame gone';
  if (/no tab|tab\b.*\b(closed|not found)/i.test(m)) return 'tab gone';
  if (/cannot access|cannot be scripted|permission|not allowed/i.test(m)) return 'page not accessible';
  if (/__raterKit/.test(m)) return 'kit missing';
  return /^[A-Za-z]*Error$/.test(e?.name ?? '') ? `other ${e.name}` : 'other';
}

// Layouts as the page changes, whether or not anything is filled: on arrival, when questions
// appear or go away, after an answer changes (which can change another question's choices or
// make it required without adding a question), and when the agent picks another vehicle or
// driver. Waits for the page to be quiet after the last change: each change starts a new wait,
// taking over the reasons of the one before on the same page (whose run, if under way, then stops
// itself); a change elsewhere just replaces it. A fill logs its own layout when it ends.
const LAYOUT_DELAY_MS = 1200;
function scheduleLayout(page, reason) {
  // Only on the carrier's quote pages, named for it: never a portal, account or search page,
  // whose text the intake's redaction may not cover.
  const quotePages = state.tab?.carrier?.layoutUrl ?? state.tab?.carrier?.autoFillUrl;
  if (!state.intake || !state.tab?.carrier || state.tab.carrier.practice || !quotePages?.test(state.tab.url ?? '')) return;
  if (state.layoutHold && !state.layoutReadyTabs.has(state.tab.id)) return;
  const job = { ...layoutJob(page), generation: ++state.layoutGeneration, reasons: new Set([reason]) };
  const before = state.layoutPending;
  if (before && sameLayoutScope(before, job)) before.reasons.forEach((r) => job.reasons.add(r));
  state.layoutPending = state.layoutLatest = job;
  clearTimeout(state.layoutTimer);
  state.layoutTimer = setTimeout(() => layoutWhenQuiet(job), LAYOUT_DELAY_MS);
}

// Another intake loaded or the client cleared: a capture still waiting is for the old quote.
function cancelLayouts() {
  clearTimeout(state.layoutTimer);
  state.layoutPending = null;
}

// ...and the tabs still show whatever they showed: maybe the previous client's quote, whose
// text the new intake's redaction doesn't cover. No layouts from them until they move on.
function holdLayouts() {
  state.layoutHold = true;
  state.layoutReadyTabs = new Set();
  state.layoutNewTabs = new Set();
  // What was kept for the previous quote's layouts is no use any more.
  state.lastLayouts = new Map();
  // Nor is the previous client's last fill: a problem report must not name it.
  state.lastRuns = new Map();
  state.layoutErrorsLogged = new Set();
  // Nor a stop screen read for the previous client (its note names their USDOT number).
  state.stopScreens = new Map();
}

async function layoutWhenQuiet(job, tries = 0) {
  // Not replaced by a later change and still its quote, tab, page and vehicle/driver. Work that
  // isn't live only drops itself. While a fill runs (here or in another tab, and it may fail
  // without logging a layout), the capture waits for it rather than counting on it.
  const live = () => state.layoutPending === job && jobCurrent(job);
  const drop = () => { job.done = true; if (state.layoutPending === job) state.layoutPending = null; };
  const reason = () => [...job.reasons].sort().join('+');
  const afterFill = () => { state.layoutTimer = setTimeout(() => layoutWhenQuiet(job, tries), LAYOUT_DELAY_MS); };
  if (!live()) return drop();
  if (state.filling) return afterFill();
  let busy;
  try {
    busy = (await runKit(job.tabId, job.carrier, () => globalThis.__raterKit.busy())).some((r) => r.result);
  } catch (e) {
    // Couldn't ask the page: the same as a layout that couldn't be read, unless it moved on.
    if (live()) layoutFailed(job, reason(), layoutErrorKind(e));
    return drop();
  }
  if (!live()) return drop();
  if (state.filling) return afterFill();
  if (busy) {
    // Still loading (an answer's server round trip): look again shortly, a few times at most.
    // A page still busy after that (about eight seconds in all) is counted like one that couldn't
    // be read: nothing else may ask for its layout again.
    if (tries < 6) state.layoutTimer = setTimeout(() => layoutWhenQuiet(job, tries + 1), LAYOUT_DELAY_MS);
    else {
      layoutFailed(job, reason(), 'page busy');
      drop();
    }
    return;
  }
  state.layoutPending = null;
  // No reason given (null, not a fill's): the job says its own when it's logged.
  await recordLayout(job.page, null, job);
}

// The maps of the tab a fill was about: the panel's own while that tab is in front, else the
// session kept for it (refreshTab), made when there is none, so the bookkeeping of a fill whose
// results come back after the agent moved to another tab never lands on that other tab (audit
// 2026-10-08, finding 5).
function tabMaps(tabId) {
  if (!Number.isInteger(tabId) || state.tab?.id === tabId) return state;
  let saved = state.tabSessions.get(tabId);
  if (!saved) {
    saved = { filled: new Map(), labels: new Map(), choices: new Map(), autoPages: new Set(), autoPaused: false, unreadRetried: false, triedAgain: null,
      agentKeys: new Map(), doneActions: new Set(), unitForms: { vehicles: {}, drivers: {}, trailers: {} }, unitShown: null, visitedPages: new Set(), doneSteps: new Set(), assistPage: null, unitNamed: null, active: firstUnits() };
    state.tabSessions.set(tabId, saved);
  }
  return saved;
}

// Bookkeeping of a fill's results, for the tab, carrier and page the fill was about (fillContext;
// `scope`: the page's edit scope as the fill saw it, `editScope`, except where one address holds
// every step and form (formScoped); `active`: the vehicle, driver and trailer its plan was for;
// `auto`: an automatic fill's), never the tab in front now.
function rememberFill(frames, { tabId = state.tab?.id, carrier = state.tab?.carrier, page = pageOf(state.tab?.url), scope = editScope(page, carrier), active = state.active,
  intake = state.intake, revision = state.intakeRevision, auto = false } = {}) {
  const maps = tabMaps(tabId);
  if (state.intake && !state.intake.ntlAdded && frames.some((f) => (f.actions ?? []).some((a) => a.id === 'addNtl'))) {
    state.intake.ntlAdded = true;
    save();
  }
  // The intake unit the form named (pagekit unitNamed), for the mark once its list comes back.
  const named = frames.find((f) => f.unitNamed)?.unitNamed;
  maps.unitNamed = named ? { ...named, page } : null;
  const unitOk = (u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id;
  // Where one address holds every step and unit form (formScoped: GEICO): the form the page shows
  // now, held (pagekit unitHeld, the one the agent has to look at) or else filled (unitForm), with
  // the step it is on. The agent's edits there are scoped by it (editScope). A unit step that shows
  // none (its form closed, or the owner check) is noted with no form; any other step leaves it as
  // it was, and so does a fill that read nothing (the page never settled, Stop): the form may still
  // be there.
  const scoped = formScoped(carrier);
  const step = scoped ? knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey) : undefined;
  if (scoped) {
    const held = frames.findLast((f) => unitOk(f.unitHeld));
    const frame = held ?? frames.findLast((f) => unitOk(f.unitForm));
    if (frame) {
      const { list, id } = held ? frame.unitHeld : frame.unitForm;
      maps.unitShown = { step: knownStep(carrier, frame.stepKey), list, id, held: !!held };
    } else if (step && (carrier.vehicleSteps?.includes(step) || carrier.driverSteps?.includes(step)) && frames.some((f) => f.fields > 0)) maps.unitShown = { step, list: null, id: null, held: false };
  }
  // The agent's edits during the fill. Where every step and form shares the address, under the
  // step the fill read and the form it ended on (just noted), not the scope it began with: the
  // agent may have moved on meanwhile. A step the kit couldn't read: the page's, left alone by
  // every fill.
  const editedIn = scoped ? editScope(page, carrier, step ?? null, { active, shown: maps.unitShown }) : scope;
  const keys = maps.agentKeys.get(editedIn) ?? new Set();
  for (const key of frames.flatMap((f) => f.protectedKeys ?? [])) keys.add(key);
  maps.agentKeys.set(editedIn, keys);
  persistAgentKeys(tabId, maps.agentKeys);
  // A step the kit couldn't read (pagekit stepUnread: GEICO's progress bar and title disagree for a
  // moment right after Next) pauses nothing: an automatic fill there is tried once more shortly,
  // and not again until a fill reads a step. A fill the agent asked for isn't retried.
  if (frames.some((f) => f.halted && !f.stepUnread)) {
    maps.autoPaused = true;
    if (maps === state) {
      state.autoPending = false;
      clearTimeout(state.autoTimer);
      state.autoDrawn = null;
    }
  }
  if (frames.some((f) => f.fields > 0 && knownStep(carrier, f.stepKey))) maps.unreadRetried = false;
  else if (auto && !maps.unreadRetried && frames.some((f) => f.halted && f.stepUnread)) {
    maps.unreadRetried = true;
    setTimeout(() => {
      if (fillCurrent({ tabId, intake, revision }) && pageOf(state.tab?.url) === page && state.unreadRetried) scheduleAutoFill(page);
    }, 1500);
  }
  // A page the fill found still drawing (pagekit notDrawn: no question yet where the plan has
  // some, W43-42: Progressive's Business Owner Info, 0 fields, "No questions found", then a
  // 29-second fill), or done with no Continue to click yet (advanceDue, W43-40: a list page still
  // loading as the fill ended), is filled once more in a moment, once per page and step. Its
  // report says nothing until then (`retrying`, renderReport).
  const where = `${page}|${knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey) ?? ''}`;
  const due = !frames.some((f) => f.halted || f.advanced) && frames.some((f) => f.notDrawn || f.advanceDue);
  let retrying = false;
  if (due && maps.triedAgain !== where && $('auto-followups').checked && !maps.autoPaused) {
    maps.triedAgain = where;
    retrying = true;
    setTimeout(() => {
      if (fillCurrent({ tabId, intake, revision }) && pageOf(state.tab?.url) === page) scheduleAutoFill(page);
    }, 1500);
  } else if (!due) maps.triedAgain = null;
  for (const id of frames.flatMap((f) => f.invalidatedActions ?? [])) maps.doneActions.delete(id);
  for (const a of frames.flatMap((f) => f.actions ?? [])) maps.doneActions.add(a.id);
  persistDoneActions(tabId, maps.doneActions);
  // The unit form this fill answered (pagekit unitForm: its marker's element name, new with every
  // form GEICO draws) is now that vehicle's, driver's or trailer's: a follow-up fill never types
  // this unit's answers into the next unit's form, drawn at the same address (survey 2026-10-20).
  // The agent's edits filed under the form itself (made while it was held, changeScopes) become the
  // unit's too: GEICO draws a new form, a new marker, when the agent opens a saved vehicle again.
  const forms = frames.map((f) => f.unitForm).filter(unitOk);
  if (forms.length) {
    maps.unitForms ??= { vehicles: {}, drivers: {}, trailers: {} };
    let copied = false;
    for (const { list, id } of forms) {
      const index = active?.[list] ?? 0;
      (maps.unitForms[list] ??= {})[id] = index;
      const own = scoped ? maps.agentKeys.get(`${page}|f:${id}`) : null;
      if (!own?.size) continue;
      const unit = unitScope(page, list, index);
      const keys = maps.agentKeys.get(unit) ?? new Set();
      for (const key of own) keys.add(key);
      maps.agentKeys.set(unit, keys);
      copied = true;
    }
    persistUnitForms(tabId, maps.unitForms);
    if (copied) persistAgentKeys(tabId, maps.agentKeys);
  }
  for (const x of frames.flatMap((f) => f.filled)) maps.filled.set(x.key, { path: x.path, shown: x.shown, standard: !!x.standard });
  // The quote's state this fill picked (AmWINS' risk state): the recorder is paused while filling.
  const quoteKey = carrier?.quoteState?.key;
  const pickedState = quoteKey && frames.flatMap((f) => f.filled).find((x) => x.key === quoteKey);
  if (pickedState) noteQuoteState(tabId, carrier.id, stateCode(pickedState.shown));
  for (const [key, label] of frames.flatMap((f) => f.labels ?? [])) if (label) maps.labels.set(key, label);
  // Kept from every fill: a searched combo's list differs from one fill to the next.
  for (const [key, options] of frames.flatMap((f) => f.choices ?? [])) {
    const seen = maps.choices.get(key) ?? new Set();
    for (const o of options) seen.add(o);
    maps.choices.set(key, seen);
  }
  return retrying;
}

function renderSite() {
  const site = $('site');
  const logo = $('site-logo');
  const caption = $('site-caption');
  const carrier = state.tab?.carrier;
  // No URL means the browser isn't letting the extension see this site (site access / permissions).
  const noAccess = inExtension && state.tab && !state.tab.url;
  // Retain the carrier text as an image-error fallback and for the panel harness.
  site.textContent = !inExtension ? 'Preview only' : carrier ? carrier.name : noAccess ? 'No access to this page' : 'Not a rater page';
  // On a rater page, its logo, page and place in the quote; elsewhere the panel's own name (the
  // dock says what to open).
  $('carrier-line').hidden = !carrier;
  $('brand').hidden = !!carrier;
  // Where the tab is in the quote: its step, "Step 3 of 7" and a bar (carriers.js quoteProgress).
  const page = pageOf(state.tab?.url);
  const progress = carrier ? quoteProgress(carrier, page, state.tabSteps.get(state.tab.id)) : null;
  $('site-step').hidden = !progress;
  $('site-step').textContent = progress ? `${progress.name} page` : '';
  $('site-count').hidden = !progress;
  $('site-count').textContent = progress ? `Step ${progress.index + 1} of ${progress.count}` : '';
  const filledHere = reportShown() && !!state.reportFor.fields;
  $('site-track').hidden = !progress;
  $('site-track').replaceChildren(...(progress ? (carrier.quoteSteps ?? []).map((step, i) => h('span', {
    title: step.name, class: i < progress.index ? 'done' : i === progress.index ? `here${filledHere ? ' filled' : ''}` : null,
  })) : []));
  caption.textContent = [
    carrier ? (carrier.practice ? 'Practice page' : progress ? null : 'Commercial auto') : null,
    carrier && state.tab?.background ? 'In background' : null,
  ].filter(Boolean).join(' · ');
  caption.hidden = !caption.textContent;
  const paths = {
    progressive: 'assets/raters/progressive.svg',
    geico: 'assets/raters/geico.gif',
    amwins: 'assets/raters/amwins.svg',
  };
  const src = paths[carrier?.id] || null;
  const title = state.tab?.background ? 'Working on the quote tab. Go back to it to see the marks.' : '';
  caption.title = title;
  logo.alt = carrier?.name || '';
  logo.title = title;
  if (logo.getAttribute('src') !== src) {
    // Use a fresh image when the carrier changes so an old load event cannot hide the fallback.
    const nextLogo = logo.cloneNode(false);
    nextLogo.removeAttribute('src');
    nextLogo.alt = carrier?.name || '';
    nextLogo.hidden = true;
    site.hidden = false;
    nextLogo.onload = () => {
      if (!nextLogo.isConnected) return;
      nextLogo.hidden = false;
      site.hidden = true;
    };
    nextLogo.onerror = () => {
      if (!nextLogo.isConnected) return;
      nextLogo.hidden = true;
      site.hidden = false;
    };
    logo.replaceWith(nextLogo);
    if (src) nextLogo.src = src;
  } else if (!src) {
    logo.hidden = true;
    site.hidden = false;
  }
  // Practice pages aren't recorded: don't say they are.
  $('recording').hidden = !state.intake || !!carrier?.practice;
  site.title = title;
  site.classList.toggle('on', !!carrier);
  $('capture').disabled = !(inExtension && carrier);
  // "Let me look before Continue" is about the panel's Continue: off with it.
  $('check-continue').disabled = !$('auto-advance').checked;
  showStopPage();
  showStateNote();
  showReviewMode();
  renderSteps();
}

// Which report a page has: its tab and page (on a page or step about one vehicle or driver, that
// one: stepScope) and, on a one-address application (AmWINS, GEICO), its step, which changes while
// the address stays. Null off a rater page.
function reportKey(tabId, page, carrier, active = state.active, step = state.tabSteps?.get(tabId)) {
  if (!Number.isInteger(tabId) || !carrier) return null;
  return `${tabId}|${stepScope(page, carrier, active, step ?? null)}${carrier.layoutSteps ? step ?? '' : ''}`;
}
function currentReportKey() { return reportKey(state.tab?.id, pageOf(state.tab?.url), state.tab?.carrier); }

// The reports of other pages on the tab in front, in the order they were first filled: the
// answers' page menu (renderSteps). Only reports with answers; never the page in front's.
function earlierReports() {
  const here = currentReportKey();
  return [...state.reports.values()].filter((e) => e.fields && e.tabId === state.tab?.id && e.key !== here && e.nodes);
}

// An earlier page's name in the page menu: its step on a one-address application (AmWINS, GEICO),
// else its page's name spaced out ("AddDriver": Add Driver); on a page about one vehicle, trailer
// or driver, which one ("Add Driver · Driver 2"). From its report key (reportKey).
function reportTitle(entry) {
  const [, page = '', unit = '', step = ''] = String(entry?.key ?? '').split('|');
  const place = step || page.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  const which = /^(v|tr|d)(\d+)$/.exec(unit);
  return which ? `${place} · ${{ v: 'Vehicle', tr: 'Trailer', d: 'Driver' }[which[1]]} ${Number(which[2]) + 1}` : place;
}

// Shows an earlier page's answers (its report key), read-only, in place of this page's; null goes
// back to this page's. Nothing on either page changes.
function showPast(key) {
  state.pastKey = key && state.reports.get(key)?.tabId === state.tab?.id ? key : null;
  renderSteps();
  if (state.pastKey) announce(`Showing the answers of ${reportTitle(state.reports.get(state.pastKey))}, as filled.`);
}

// Puts the report of the page in front into the page view, keeping the one it replaces with its
// own nodes, so its buttons and the AI's cards work again when its page is back. Returns it.
function showReport() {
  const key = currentReportKey();
  const shown = state.reportFor;
  if ((shown?.key ?? null) === key) return shown;
  if (shown) shown.nodes = [...$('report').childNodes];
  const next = key ? state.reports.get(key) ?? null : null;
  // Kept while another page was in front: said in the page view (renderSteps).
  if (next?.nodes) next.restored = true;
  $('report').replaceChildren(...(next?.nodes ?? []));
  state.reportFor = next;
  return next;
}
function reportShown() { return !!showReport(); }

// A fill's report for its page: shown when that page is in front, else kept until it is.
function putReport(entry, nodes) {
  showReport();
  state.reports.set(entry.key, entry);
  if (entry.key === currentReportKey()) {
    $('report').replaceChildren(...nodes);
    state.reportFor = entry;
  } else {
    entry.nodes = nodes;
  }
}

// Forgets the reports `drop` picks (all: a new or cleared client; a closed tab's; one page's).
function dropReports(drop = () => true) {
  for (const [key, entry] of state.reports) if (drop(entry)) state.reports.delete(key);
  forgetKeptReports(drop);
  if (state.reportFor && state.reports.get(state.reportFor.key) !== state.reportFor) {
    state.reportFor = null;
    $('report').replaceChildren();
  }
}

// A fill that couldn't finish ('error'), or found nothing to do ('notice'), said above its page's
// answers (a report is made for a page that has none), where Fill this page retries it. `ctx`: the
// fill's tab, page, carrier and unit.
function fillProblem(ctx, text, kind = 'error') {
  const key = reportKey(ctx.tabId, ctx.page, ctx.carrier, ctx.active ?? state.active);
  if (!key) return;
  showReport();
  const entry = state.reports.get(key);
  if (entry) Object.assign(entry, { error: null, notice: null, [kind]: text });
  else putReport({ key, tabId: ctx.tabId, page: ctx.page, at: Date.now(), [kind]: text }, []);
  renderSteps();
}

// What's left for the agent on the report shown: its items not settled since (answered on the
// page or here, marked done, an AI answer the agent accepted). The steps, the filters and the dock
// follow.
function recount() {
  const entry = state.reportFor;
  if (!entry?.fields) return;
  const items = [...$('report').querySelectorAll('.row.need')];
  const left = items.filter((n) => !n.classList.contains('resolved')).length;
  if (left === entry.left) return;
  // Settled since the fill: the panel's Continue is a click away now, never on its own.
  entry.settled = !left && entry.left > 0;
  entry.left = left;
  renderSteps();
  announce(left ? `${left} left for you on this page.` : 'Nothing is left for you on this page.');
}

// Polite announcements for screen readers: fill results and counts that change.
function announce(text) {
  const live = $('announce');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
}

// The three steps under the client's name: what each says about the intake and the page in front,
// and which one's view is shown; then the page view (the answers going in, or the last fill's, with
// their filters) and the dock. Steps 2 and 3 show the last fill of the page in front.
function renderSteps() {
  renderLive();
  // Pop out or Dock: never while a fill runs.
  $('pop-out').hidden = !inExtension || popped;
  $('dock-back').hidden = !popped;
  $('pop-out').disabled = $('dock-back').disabled = !!state.filling;
  if (!state.intake) { renderDock(); return; }
  // The unit pickers follow the page or step in front (unitListsHere).
  renderPickers();
  const { warnings, done } = state.intake;
  const open = warnings.filter((w, i) => w.level === 'check' && !done.includes(i)).length;
  const carrier = state.tab?.carrier;
  const page = pageOf(state.tab?.url);
  const onRater = inExtension && !!carrier;
  const stopped = !!stopNoteFor(carrier, page);
  const report = showReport();
  // The fill running on this tab: its answers in so far, in place of the report.
  // A quiet automatic fill (no rows yet) leaves the report in place, as the live list and the dock do.
  const filling = state.filling && !!state.fillingFor && state.fillingFor.tabId === state.tab?.id && (!state.fillingFor.auto || !!state.fillingFor.rows?.length);
  const filled = !filling && !!report?.fields;
  // Why the last fill didn't finish, or what it found instead of questions (a portal page).
  const error = filling ? null : report?.error ?? null;
  const notice = filling || error ? null : report?.notice ?? null;
  const left = filled ? report.left ?? 0 : 0;
  const step = (id, prefix, number, { tone = '', note, current }) => {
    const button = $(`step-${id}`);
    button.dataset.state = tone;
    if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    $(`${prefix}-num`).textContent = tone === 'done' ? '✓' : number;
    $(`${prefix}-summary`).textContent = note;
  };
  // 1. Check intake.
  step('check', 'check', '1', { tone: open ? 'warn' : 'done', note: open ? `${open} to look at` : 'All checked', current: state.view === 'check' });
  // 2. Fill page.
  step('fill', 'fill', '2', {
    tone: !onRater ? '' : error || (stopped && !filled) ? 'bad' : filled ? 'done' : 'active',
    note: !onRater ? 'Open a rater' : filling ? `Filling… ${state.fillingFor.filled ?? 0} in` : error ? 'Didn’t finish'
      : filled ? `${report.filled} filled${report.auto ? ' automatically' : ''}` : stopped ? 'Stopped' : 'Ready to fill',
    current: state.view === 'page' && !filled,
  });
  // 3. Confirm: what's left for the agent, and Continue.
  step('confirm', 'finish', '3', {
    tone: !filled ? '' : report.advanced ? 'done' : 'active',
    note: !filled ? 'After filling' : report.advanced ? 'Continued' : left ? `${left} need${left === 1 ? 's' : ''} you` : 'Ready',
    current: state.view === 'page' && filled,
  });
  // The page view: a rater to open, what's wrong about the last fill, the answers.
  $('fill-waiting').hidden = onRater;
  $('fill-waiting-text').textContent = !inExtension ? 'Filling works only in the Chrome extension.'
    : state.tab && !state.tab.url ? 'The extension can’t read this page. Allow it on this site (toolbar icon or site access), then reload.'
      : 'Open the client’s quote on one of these raters.';
  const problem = $('fill-error');
  problem.hidden = !error && !notice;
  problem.replaceChildren(...(error ? [issueCard({ title: 'Filling didn’t finish', text: error, role: 'alert' })]
    : notice ? [issueCard({ tone: 'quiet', title: notice })] : []));
  // Pages filled earlier on this tab (the page menu), and the one picked, shown read-only in place
  // of this page's: never while a fill runs on the tab.
  const earlier = onRater && !filling ? earlierReports() : [];
  const past = earlier.find((e) => e.key === state.pastKey) ?? null;
  if (!past) state.pastKey = null;
  if (!past) $('past').replaceChildren();
  else if (state.pastNodes !== past.nodes) $('past').replaceChildren(...past.nodes);
  state.pastNodes = past?.nodes ?? null;
  const at = (entry) => new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('feed').hidden = !onRater || (!filling && !filled && !earlier.length);
  $('feed-title').textContent = filling ? 'Filling now' : earlier.length ? 'Answers' : 'Answers on this page';
  const menu = $('page-menu');
  menu.hidden = !earlier.length;
  if (earlier.length) {
    const keys = JSON.stringify(earlier.map((e) => e.key));
    if (menu.dataset.keys !== keys) {
      menu.replaceChildren(h('option', { value: '' }, 'This page'), ...earlier.map((e) => h('option', { value: e.key }, reportTitle(e))));
      menu.dataset.keys = keys;
    }
    menu.value = past?.key ?? '';
  }
  $('past').hidden = !past;
  $('past-head').hidden = !past;
  $('past-when').textContent = past ? `${reportTitle(past)} · filled ${at(past)} · view only` : '';
  $('report').hidden = !filled || !!past;
  $('report').dataset.filter = state.filter;
  const rows = filled ? [...$('report').querySelectorAll('.rows > .row')] : [];
  const needing = rows.filter((n) => n.classList.contains('need') && !n.classList.contains('resolved')).length;
  const counts = { all: rows.length, needs: needing, done: rows.length - needing };
  $('filters').hidden = !filled || !rows.length || !!past;
  for (const b of $('filters').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
    b.querySelector('span').textContent = String(counts[b.dataset.filter] ?? 0);
  }
  $('feed-empty').hidden = !!past || filling || (filled && (counts[state.filter] ?? 0) > 0);
  $('feed-empty').textContent = !filled ? 'This page isn’t filled yet.' : state.filter === 'needs' ? 'Nothing needs you on this page.' : 'Nothing here.';
  // What the tags and the rater page's marks mean: behind the i in the title.
  const keyHere = !filling && (filled || !!past);
  $('key-btn').hidden = !keyHere;
  $('key-btn').setAttribute('aria-expanded', String(keyHere && state.keyOpen));
  $('answer-key').hidden = !(keyHere && state.keyOpen);
  $('unmark').hidden = !filled || !!past;
  // A report kept while another page was in front may be out of date.
  const age = filled && !past && report.restored && report.at ? at(report) : null;
  $('report-age').hidden = !age;
  $('report-age').textContent = age ? `From the fill at ${age}. Fill again if the page changed.` : '';
  renderDock();
}

// The dock's word on a page the fill went through: whether Continue was clicked, is the panel's
// to click, or the agent's, and what is left before it. `settled`: what was left has been settled
// since the fill; the panel's Continue then waits for a fill again. `held`: the fill found the page
// done but held Continue for the agent's check ('check'), or the page changed after they clicked
// Looks right ('changed'). With "Let me look before Continue" on, Looks right takes the place of
// Fill again and continue.
function continueSaid({ advanced, filled = 0, left = 0, waiting = 0, covered = 0, page, settled, held, tabId }, carrier = state.tab?.carrier) {
  const holding = left || waiting;
  // A step the carrier's Continue is never clicked on (GEICO's Quote & Coverages: advance `steps`).
  const offSteps = !!carrier?.advance?.steps?.length && !carrier.advance.steps.includes(tabStep(carrier, tabId ?? state.tab?.id));
  const autoAdvance = !!carrier?.advance && $('auto-advance').checked && !carrier.advance.exceptPages?.includes(page) && !offSteps;
  const check = autoAdvance && !!$('check-continue')?.checked;
  const looks = { button: 'look-right', label: 'Looks right, continue' };
  const again = { alt: 'fill-again', altLabel: 'Fill this page again' };
  // Seen again once the agent went back to the page, or in a panel opened again (W43-39): it can be
  // filled again.
  if (advanced) return { phase: 'done', tone: 'good', eyebrow: 'Continued', title: 'Continue clicked', sub: `Clicked “${advanced}” for you. Nothing is submitted or bound.`, ...again };
  if (holding) {
    const then = check ? 'Then check the answers and click Looks right. Never Bind or Submit.'
      : offSteps ? 'Then moving on is yours: nothing on this step is clicked for you.'
      : !autoAdvance ? (carrier?.advance && $('auto-advance').checked
        ? 'Then click Continue on this page yourself. Nothing is submitted or bound.'
        : 'Then click Continue yourself, and Fill this page on the next one.')
      : $('auto-followups').checked ? 'Then the panel continues to the next page. Never Bind or Submit.'
      : 'Then Fill this page again to continue. Never Bind or Submit.';
    // Buttons waiting on others (Progressive's bill plan before Recalculate): the fill clicks them
    // in turn, and a question one waits on is a row of its own.
    // Something open on the page over the button: never clicked in turn until it is closed.
    if (!left && covered) return { phase: 'needs', tone: 'warn', eyebrow: `${filled} filled`, title: 'Close what is open over the button', sub: 'Then fill this page again. Never Bind or Submit.', ...again };
    if (!left) return { phase: 'waiting', tone: 'blue', eyebrow: `${filled} filled`, title: 'The fill clicks the rest in turn', sub: then, ...again };
    return { phase: 'needs', tone: 'warn', eyebrow: `${filled} filled · ${left} need${left === 1 ? 's' : ''} you`,
      title: left === 1 ? 'Answer the last question' : `Answer ${left} questions`, sub: then, button: 'dock-next', label: 'Show the next one', ...again };
  }
  if (held === 'changed') return { phase: 'check', tone: 'warn', eyebrow: 'The page changed', title: 'Check the answers again', sub: 'It changed after you clicked Looks right. Check them, or click Continue on the page yourself.', ...looks };
  if (held || (check && settled)) return { phase: 'check', tone: 'good', eyebrow: 'All answered', title: 'Look over the answers, then continue', sub: 'The panel clicks Continue. Never Bind or Submit.', ...looks };
  if (offSteps) return { phase: 'yours', tone: 'good', eyebrow: 'All answered', title: 'Moving on is yours', sub: 'Nothing on this step is clicked for you. Nothing is submitted or bound.', ...again };
  if (!autoAdvance) {
    return { phase: 'ready-continue', tone: 'good', eyebrow: 'All answered', title: 'Ready for Continue', ...again,
      sub: carrier?.advance && $('auto-advance').checked ? 'Click Continue on this page yourself. Nothing is submitted or bound.' : 'Click Continue yourself, then Fill this page on the next one.' };
  }
  if (settled) return { phase: 'ready-continue', tone: 'good', eyebrow: 'All answered', title: 'Ready for Continue', sub: 'Fill again to click Continue, or click it yourself. Nothing is submitted or bound.', button: 'fill', label: 'Fill again and continue' };
  // Nothing left and the page not moved on: the main button continues (a fill, which clicks the
  // page's Continue once nothing is left: W43-40).
  return { phase: 'ready-continue', tone: 'good', eyebrow: 'All answered', title: 'Ready for Continue', sub: 'Continue clicks the page’s Continue for you. Nothing is submitted or bound.', button: 'fill', label: 'Continue', go: 'continue', ...again };
}

// The dock: the one next thing to do, always in the same place under the panel, and its button.
// #dock[data-phase] names it, and data-report the fill it is about (the panel harness reads both).
function dockFor() {
  if (!state.intake) return { phase: 'start', eyebrow: 'Step 1 of 3', title: 'Add the client’s intake PDF', sub: 'Then the panel checks it and fills the rater for you.' };
  const { warnings, done } = state.intake;
  const open = warnings.filter((w, i) => w.level === 'check' && !done.includes(i)).length;
  const checksSaid = state.view === 'check' && open ? `${open} intake item${open === 1 ? '' : 's'} not looked at yet. You can still fill.` : null;
  const carrier = state.tab?.carrier;
  if (!inExtension) return { phase: 'off', eyebrow: 'Preview', title: 'Filling works only in the Chrome extension' };
  if (!carrier) {
    return state.tab && !state.tab.url
      ? { phase: 'off', eyebrow: 'Next', title: 'The extension can’t read this page', sub: 'Allow it on this site (toolbar icon or site access), then reload.' }
      : { phase: 'off', eyebrow: 'Next', title: 'Open the client’s quote on a rater', sub: checksSaid ?? 'Progressive, GEICO or AmWINS. Filling starts on its page.' };
  }
  const f = state.fillingFor;
  if (state.filling && f?.tabId === state.tab.id && (!f.auto || !!f.rows?.length)) {
    const last = f.rows?.at(-1);
    // The page hasn't answered for a while (watchFill): a message box open on it waits for the agent.
    if (f.unanswered) {
      return { phase: 'filling', tone: 'warn', progress: true, eyebrow: f.stopping ? 'Stopping' : `Filling · ${f.filled ?? 0} in`,
        title: 'The page isn’t answering', sub: 'If it shows a message box, answer it there. The fill goes on after.',
        button: 'fill-stop', label: f.stopping ? 'Stopping…' : 'Stop', disabled: !!f.stopping };
    }
    return { phase: 'filling', tone: 'blue', progress: true, eyebrow: f.stopping ? 'Stopping' : `Filling · ${f.filled ?? 0} in`,
      title: f.stopping ? 'Stopping after the answer going in now…' : last ? `Just filled: ${last.label || 'an answer'}` : 'Reading the page…',
      sub: 'Keep this tab open.', button: 'fill-stop', label: f.stopping ? 'Stopping…' : 'Stop', disabled: !!f.stopping };
  }
  const page = pageOf(state.tab.url);
  const step = tabStep(carrier);
  // The carrier stopped the quote here, or the step or screen is the agent's: nothing to press.
  if (stopNoteFor(carrier, page, step)) {
    if (carrier.stopPages?.[page]) return { phase: 'stopped', tone: 'bad', eyebrow: `Stopped by ${carrier.name}`, title: 'Nothing to fill on this rater', sub: 'Nothing on this page was filled or clicked.' };
    const screen = step && carrier.stopSteps?.[step] ? null : state.stopScreens?.get(state.tab.id)?.name;
    return { phase: 'yours', eyebrow: 'This step is yours', title: `Finish ${screen ?? step ?? 'this step'} yourself`, sub: `Nothing on this ${screen ? 'screen' : 'step'} is filled or clicked.` };
  }
  // The tab's quote is for another state than the intake's: no fill until the agent says which.
  const issue = stateIssue();
  if (issue) {
    return { phase: 'hold', tone: 'bad', eyebrow: 'Check first', title: 'Sort out the state above', sub: `Filling a ${issue.picked} quote with ${issue.intake} answers will fail on later pages.`,
      button: 'fill', label: 'Fill this page', disabled: true, alt: 'fill-anyway', altLabel: 'Fill anyway' };
  }
  // The carrier's portal pages outside a quote are never filled (fillPage).
  if (!onQuotePage()) return { phase: 'portal', eyebrow: 'Next', title: 'Open the client’s quote', sub: 'This is the portal. Filling starts on a quote page.' };
  const report = showReport();
  // On a one-address application (AmWINS) every step shares the address: "again" only once this
  // step has a report.
  const filledBefore = carrier.layoutSteps ? !!report?.fields : state.autoPages.has(page);
  const fill = { button: 'fill', label: filledBefore || report?.fields ? 'Fill this page again' : 'Fill this page' };
  if (report?.error) return { phase: 'error', tone: 'bad', eyebrow: 'Didn’t finish', title: 'Check the page, then fill again', sub: 'What went in stays; your changes are kept.', ...fill };
  // A page the fill had no question for and left nothing on (a unit list with every unit on it):
  // Continue is next (W43-40: the dock offered Fill this page again on finished vehicle lists).
  if (report?.empty) return continueSaid({ ...report, tabId: state.tab.id }, carrier);
  if (report?.fields) {
    if (report.stopped) return { phase: 'stopped-fill', tone: 'warn', eyebrow: 'Stopped', title: `${report.filled} filled before you stopped`, sub: 'What went in stays. Fill again to finish the rest; your changes are kept.', button: 'fill', label: 'Fill this page again' };
    // AI picks waiting for approval hold Continue: approved (or confirmed) from here or their rows.
    const aiDock = state.aiDocks.get(`${state.tab.id}|${page}`);
    const ai = aiDock ? pendingAi(state.tab.id, page) : [];
    if (ai.length) {
      const waiting = ai.filter((x) => !x.rejected).length;
      const continues = aiDock.canContinue && (report.left ?? 0) <= ai.length;
      return { phase: 'ai', tone: 'ai', eyebrow: `AI picked ${ai.length} answer${ai.length === 1 ? '' : 's'}`,
        title: waiting ? 'Check the purple answers, then approve' : 'Confirm the page answer, or change it',
        sub: waiting < ai.length ? 'Continue waits until you confirm the page answer or change it.'
          : aiDock.canContinue ? 'Continue waits until you approve them.' : 'Check them (purple on the page), then approve.',
        button: 'ai-approve', label: waiting ? (continues ? 'Approve and continue' : `Approve ${waiting === 1 ? 'the AI pick' : `${waiting} AI picks`}`)
          : continues ? 'Confirm and continue' : 'Confirm the page answer' };
    }
    const said = continueSaid(report, carrier);
    // A question open now with others after it: the dock moves on past it.
    if (said.button === 'dock-next' && (report.left ?? 0) > 1 && $('report').querySelector('.row.need.open:not(.resolved)')) said.label = 'Skip to the next one';
    return said;
  }
  // Nothing filled on this page yet: what the fill will and won't do here.
  const hint = state.tab.background ? 'Fills the quote tab in the background. Go back to it to review.'
    // GEICO: the units it adds with that setting on (unitLists, pickUnitToAdd), and Next only up to
    // Additional Business Info (advance `steps`).
    : $('auto-advance').checked && carrier.advance && carrier.unitLists ? 'Adds the intake’s vehicles, trailers and drivers not on the quote yet, and clicks Next once nothing is left for you, up to Quote & Coverages. Never submits or binds.'
    : $('auto-advance').checked && carrier.advance ? 'Clicks Continue once nothing is left for you. Never submits or binds.'
    : 'Nothing is submitted. Review, then click Next yourself.';
  const progress = quoteProgress(carrier, page, state.tabSteps.get(state.tab.id));
  return { phase: 'ready', eyebrow: 'Next', title: progress ? `Fill the ${progress.name} page` : 'Fill this page', sub: checksSaid ?? hint, ...fill };
}

function renderDock() {
  const dock = $('dock');
  const d = dockFor();
  dock.hidden = state.settingsOpen;
  dock.dataset.phase = d.phase;
  dock.dataset.report = state.reportFor?.at && d.phase !== 'filling' ? String(state.reportFor.at) : '';
  $('fill-progress').hidden = !d.progress;
  $('dock-eyebrow').textContent = d.eyebrow ?? '';
  $('dock-eyebrow').dataset.tone = d.tone ?? '';
  $('dock-title').textContent = d.title;
  $('dock-sub').textContent = d.sub ?? '';
  $('dock-sub').hidden = !d.sub;
  // The dock's Continue is a fill that replaces nothing (`go`: fillPage `continuing`).
  $('fill').dataset.go = d.go ?? '';
  for (const id of ['fill', 'fill-stop', 'dock-next', 'look-right', 'ai-approve']) {
    const button = $(id);
    button.hidden = d.button !== id;
    if (d.button !== id) continue;
    button.textContent = d.label;
    button.disabled = !!d.disabled || (id === 'fill' && !!state.filling);
  }
  $('dock-alt').hidden = !d.alt;
  $('dock-alt').dataset.go = d.alt ?? '';
  $('dock-alt').textContent = d.altLabel ?? '';
}

// Review mode (plan.js supportedClass): the intake's business class isn't one this carrier's rules
// were written for, so every standard answer is filled as a check item (Continue waits on every
// page) and the agent is told why, above the page's answers.
function showReviewMode() {
  const box = $('review-note');
  const carrier = state.tab?.carrier;
  const record = state.intake?.record;
  const on = !!carrier && !!record && !supportedClass(record, carrier);
  box.hidden = !on;
  if (!on) { box.replaceChildren(); return; }
  const cls = String(record.operations?.businessClass ?? '').trim();
  box.replaceChildren(issueCard({ tone: 'warn', title: `Review mode: ${cls ? `"${cls}"` : 'no business class'} on the intake`,
    text: `${carrier.name}'s rules cover expediters and general freight. Standard answers are filled but marked for you to confirm; Continue waits on each page.` }));
}

// A card above the page's answers (or in them): what's wrong or different, in the panel's own
// words, never the page's. `tone`: '' (red: the carrier stopped the quote, a fill failed, the
// quote's state differs), 'warn', 'info' or 'quiet' (a step that is the agent's).
function issueCard({ tone = '', title, text = null, notes = [], compare = [], actions = [], role = 'status' }) {
  return h('div', { class: `issue${tone ? ` ${tone}` : ''}`, role },
    h('div', { class: 'issue-head' }, h('span', { class: 'bang', 'aria-hidden': 'true' }, tone === 'info' ? 'i' : '!'),
      h('div', { class: 'issue-text' }, h('span', { class: 'issue-title' }, title), text ? h('span', {}, text) : null,
        ...notes.map((note) => h('span', { class: 'small-note' }, note)))),
    compare.length ? h('div', { class: 'compare' }, compare.map(([k, v]) => h('span', {}, h('span', { class: 'k' }, `${k}:`), ` ${v}`))) : null,
    actions.filter(Boolean).length ? h('div', { class: 'issue-actions' }, actions.filter(Boolean)) : null);
}

// Pages where the carrier has stopped the quote (Progressive's DeclinationNotice: the client
// already has a commercial auto policy with Progressive). Nothing is filled or clicked there,
// automatically or on request, and Luna isn't asked; the panel says why in red above the page's
// answers (outside the fill report, which Clear marks empties) and the page is the agent's. The
// carrier's reason is said of this client only once the tab is shown to be this intake's quote
// (stopPageIsOurs). Steps of a one-address application that are the agent's (GEICO's Final Quote
// Details, MVR & CLUE, Payment Information: `stopSteps`) are kept the same way, in a quiet card:
// their note is the step's, about no client, so it is said as it is.
function showStopPage() {
  const carrier = state.tab?.carrier;
  const page = pageOf(state.tab?.url);
  const step = tabStep(carrier);
  const note = state.intake ? stopNoteFor(carrier, page, step) : null;
  const box = $('stop-note');
  // A step the fill still answers, with what the carrier says there (GEICO: stop at Quote & Coverages).
  const stepNote = !note && state.intake && step ? carrier?.stepNotes?.[step] ?? null : null;
  box.hidden = !note && !stepNote;
  if (stepNote) { box.replaceChildren(issueCard({ tone: 'info', title: step, text: stepNote })); return; }
  if (!note) { box.replaceChildren(); return; }
  clearTimeout(state.autoTimer);
  state.autoDrawn = null;
  state.autoPending = false;
  state.pagePending = null;
  if (!carrier.stopPages?.[page]) {
    // A stop step's, or a stop screen's (`stopButtons`) on a step that is no stop.
    const screen = step && carrier.stopSteps?.[step] ? null : state.stopScreens?.get(state.tab?.id)?.name;
    box.replaceChildren(issueCard({ tone: 'quiet', title: `${screen ?? step}: yours`, text: note,
      notes: [`Nothing on this ${screen ? 'screen' : 'step'} is filled or clicked.`] }));
    return;
  }
  const ours = stopPageIsOurs();
  box.replaceChildren(issueCard({ role: 'alert', title: ours ? `${carrier.name} stopped this quote` : `${carrier.name} stop page`,
    text: ours ? note : 'This tab was on the stop page before this client was loaded; it may be another client\'s quote. Open this client\'s quote.',
    notes: ['Nothing on this page is filled or clicked.'] }));
}

// The tab's quote is for another state than the intake's garaging state (src/quote-state.js): said
// above the page's answers, and filling waits, until the pick matches, the intake does, or the
// agent says the pick is right (for this intake). Also when the pick came before this intake was loaded: the tab's quote
// doesn't change with the intake. A tab that moves to another carrier forgets its pick.
// A tab's quote state: a new pick replaces it (the same pick keeps when it was made and whether the
// agent said it's right); no state forgets it.
function noteQuoteState(tabId, carrier, code) {
  const was = state.quoteStates.get(tabId);
  const same = was && was.carrier === carrier && was.code === code;
  if (code) state.quoteStates.set(tabId, same ? was : { carrier, code, session: usage.currentSession()?.id ?? null, dismissed: null });
  else state.quoteStates.delete(tabId);
  showStateNote();
}

// The quote-state page's pick as it is (a state the page restored or defaulted, or picked before
// the recorder attached): a change would never report it. Read when the recorder announces the
// page, and when the panel finds the tab on it (a recorder already in the page, after the panel
// was closed or reloaded, doesn't announce it again). A pick noted while the page is read (a
// change, a fill) is newer: the read doesn't replace it.
function seedQuoteState(tabId, carrier, page) {
  if (!state.intake || !carrier?.quoteState?.pages.includes(page)) return;
  const known = state.quoteStates.get(tabId);
  readQuoteState(tabId, carrier).then((shown) => { if (shown != null && state.quoteStates.get(tabId) === known) noteQuoteState(tabId, carrier.id, stateCode(shown)); });
}

// The quote-state control's pick on the page's top frame, by its field key: the option's text, ''
// for no state, null when it isn't there (or the page can't be read).
async function readQuoteState(tabId, carrier) {
  const key = carrier?.quoteState?.key;
  if (!inExtension || !key) return null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, args: [key], func: (k) => {
      const el = [...document.querySelectorAll('select')].find((x) => globalThis.__raterFieldKey?.(x) === k);
      const o = el?.selectedOptions?.[0];
      return el ? (o && o.value !== '' ? o.text : '') : null;
    } });
    return res?.result ?? null;
  } catch { return null; }
}

// Progressive opens the quote in a new tab from its home page: that tab's quote is the one picked
// there. Not while no intake is loaded: the tab isn't watched then, so its pick may be stale.
function inheritQuoteState(tab) {
  if (!state.intake) return;
  const pick = state.quoteStates.get(tab?.openerTabId);
  if (pick && Number.isInteger(tab.id) && !state.quoteStates.has(tab.id)) state.quoteStates.set(tab.id, { ...pick });
}

// The tab's quote state against the intake's garaging state (stateIssue): said in red above the
// page's answers, with the pick and the intake's address side by side, "<state> is right" and
// where the address is on the intake. Filling waits meanwhile (dockFor, fillPage, autoFill).
function showStateNote() {
  const box = $('state-note');
  const issue = stateIssue();
  box.hidden = !issue;
  if (!issue) { box.replaceChildren(); return; }
  const { picked, intake, pick } = issue;
  const name = state.tab.carrier.name;
  const before = pick.session !== (usage.currentSession()?.id ?? null);
  const g = state.intake.record.garaging ?? {};
  const address = [g.street, g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const place = sourcePlace('garaging.state', state.intake);
  const pdf = place && pdfAvailable();
  box.replaceChildren(issueCard({ role: 'alert', title: `This ${name} quote is for ${picked}. The intake says ${intake}.`,
    text: `${before ? `The quote was started in ${picked} before this intake was loaded. ` : ''}A ${picked} quote won’t take ${intake} ZIP codes or rules. Start the quote in ${intake}, or check the intake.`,
    compare: [['Rater', picked], [`Intake${place ? pdfPageSaid(place.page, ' page ') : ''}`, address || intake]],
    actions: [
      h('button', { type: 'button', class: 'ghost', onclick: dismissState }, `${picked} is right`),
      pdf ? h('button', { type: 'button', class: 'link small', onclick: () => openPdf({ path: 'garaging.state', label: 'Garaging state', kind: 'check' }) }, `See intake${pdfPageSaid(place.page, ', page ')}`) : null,
    ] }));
}

// The tab's quote is for another state than the intake's garaging state (src/quote-state.js), until
// the pick matches, the intake does, or the agent says the pick is right (for this intake). Also
// when the pick came before this intake was loaded: the tab's quote doesn't change with the
// intake. A tab that moves to another carrier forgets its pick. Returns { picked, intake } (state
// names) with the pick, or null.
function stateIssue() {
  const tabId = state.tab?.id;
  let pick = state.quoteStates.get(tabId);
  if (pick && state.tab?.carrier && pick.carrier !== state.tab.carrier.id) { state.quoteStates.delete(tabId); pick = null; }
  const intakeId = usage.currentSession()?.intakeId ?? null;
  const off = !pick || !state.intake || pick.carrier !== state.tab?.carrier?.id || pick.dismissed === `${intakeId}|${pick.code}`;
  const differs = off ? null : stateMismatch(pick.code, state.intake.record);
  return differs ? { ...differs, pick, intakeId } : null;
}

// "<state> is right" or the dock's Fill anyway: the tab's quote state stands for this intake, and
// filling goes on.
function dismissState() {
  const issue = stateIssue();
  if (!issue) return;
  issue.pick.dismissed = `${issue.intakeId}|${issue.pick.code}`;
  showStateNote();
  renderSteps();
}

// What the carrier's stop says on this page, or on the step this tab is on (`step`, its name):
// null where filling and clicking are allowed. Every check of a stop goes through it, so a stop
// step is refused wherever a stop page is (fill, follow-ups, Luna, the panel's buttons). `tabId`:
// the tab being filled or asked about (a follow-up's, the AI's), the shown one by default.
function stopNoteFor(carrier, page, step, tabId = state.tab?.id) {
  if (step === undefined) step = tabStep(carrier, tabId);
  // A screen that is the agent's (`stopButtons`), while that tab shows it on this page (noteStopScreen).
  const screen = state.stopScreens?.get(tabId);
  const said = screen?.page === page ? carrier?.stopButtons?.[screen.name]?.note : null;
  return carrier?.stopPages?.[page] ?? (step ? carrier?.stopSteps?.[step] : null)
    ?? (typeof said === 'function' ? said(state.intake?.record ?? null) : said) ?? null;
}

// A tab may still show the previous client's quote after an intake is loaded (or the panel
// started): the same evidence as for layouts (a new page since, or a fill with this intake).
function stopPageIsOurs() {
  return !state.layoutHold || state.layoutReadyTabs.has(state.tab?.id);
}

// ---------------------------------------------------------------------------------------------
// Filling and capturing

// Carriers whose widgets live in the page's own JavaScript (ExtJS) need the MAIN world.
const worldFor = (carrier) => (carrier?.world === 'MAIN' ? 'MAIN' : 'ISOLATED');

async function injectKit(tabId, carrier) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: worldFor(carrier), files: ['src/content/field-key.js', 'src/content/pagekit.js'] });
}

async function runKit(tabId, carrier, func, args = [], frameIds) {
  await injectKit(tabId, carrier);
  return chrome.scripting.executeScript({ target: { tabId, ...(frameIds ? { frameIds } : { allFrames: true }) }, world: worldFor(carrier), func, args });
}

// `auto`: 'page' when started because a new page opened (setting "Fill each new page").
// `confirmed`: the page's receipt the agent approved with Looks right (lookRight).
async function fillPage({ auto = false, confirmed = null, continuing = false } = {}) {
  // The carrier stopped the quote on this page: nothing is filled or clicked, even on request.
  if (state.intake && stopNoteFor(state.tab?.carrier, pageOf(state.tab.url))) { showStopPage(); return; }
  // The tab's quote is for another state than the intake's: nothing is filled until the agent says
  // the state is right (or Fill anyway), on request or automatically (stateIssue).
  if (state.intake && stateIssue()) { showStateNote(); renderSteps(); return; }
  // A new page that opens while the previous one is still finishing its fill is filled right
  // after it (it used to be skipped: "it stopped here").
  if (state.filling && auto === 'page') { state.pagePending = pageOf(state.tab?.url); return; }
  if (state.filling || state.closing || !state.intake || !state.tab?.carrier || (auto && state.autoPaused)) return;
  // Back on a step that takes follow-ups only for new questions (newQuestionsOnlySteps) after its
  // fill: only the agent, or new questions, fill it again.
  if (auto && state.tab.carrier.newQuestionsOnlySteps?.includes(tabStep(state.tab.carrier)) && state.reports.get(currentReportKey())?.fields) return;
  // The carrier's portal pages outside a quote (Progressive's home / quote search) are never
  // filled, and the AI isn't asked about them.
  if (!onQuotePage()) {
    if (!auto) fillProblem({ tabId: state.tab.id, page: pageOf(state.tab.url), carrier: state.tab.carrier }, 'This is the portal. Open a quote, then fill.', 'notice');
    return;
  }
  if (!auto) state.autoPaused = false;
  state.filling = true;
  clearTimeout(state.autoTimer);
  state.autoDrawn = null;
  const { id: tabId, carrier } = state.tab;
  const page = pageOf(state.tab.url);
  // Looks right never replaces anything: the page is continued as the agent approved it. Nor does
  // the dock's Continue (W43-40).
  const overwrite = auto || confirmed || continuing ? false : $('overwrite').checked;
  // Before any waiting: the agent may pick another vehicle or tab, or load another intake, while
  // the carrier works (fillContext; the view is taken there).
  const ctx = fillContext({ tabId, carrier, page, tabUrl: state.tab.url, auto, overwrite, asked: !auto && !confirmed });
  await pickListItem(carrier, page, ctx);
  if (staleFill(ctx) || state.tab?.id !== tabId) { state.filling = false; renderSite(); return; }
  // The list page may have picked the next vehicle or driver: the plan is for that one.
  ctx.active = { ...state.active };
  // And the unit it adds, if any (pickUnitToAdd): the chooser's answer and the add helpers.
  let plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
  // The page view lists the answers as they go in and the dock has Stop; the new report replaces
  // the last one when it comes (kept until then, in case this fill stops before it gets anywhere).
  state.fillingFor = { run: ctx.run, tabId, carrier, key: reportKey(tabId, page, carrier, ctx.active), filled: 0, rows: [], stopping: false };
  const unwatch = watchFill(ctx);
  renderSteps();
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  // The page moved on before the fill began (pageMoved): the page in front gets its fill after this.
  let moved = false;
  // Our own fills aren't the agent's changes: pause the recorder while filling.
  try {
    await ensureRecorder();
    await tellRecorder('pause', tabId);
    await retireAiOrigins({ tabId, tabUrl: ctx.tabUrl, intake: ctx.intake, carrier });
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (!fillCurrent(ctx)) return;
    // The agent's edits on this page as the fill's tab holds them (retiring AI picks may just
    // have released some), never the tab in front.
    // Honor the latest switch after preparation, and log the same value used by the kit.
    ctx.settings.autoAdvance = !!$('auto-advance').checked;
    // The add helpers are clicked only with the switch on now.
    if (ctx.adding) plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
    // Stopped while the panel prepared: the kit isn't asked to fill at all.
    if (state.fillingFor?.run === ctx.run && state.fillingFor.stopping) {
      tabMaps(tabId).autoPaused = true;
      fillProblem(ctx, 'You stopped the fill. Nothing was filled or clicked.', 'notice');
      return;
    }
    // The tab moved on to another page while the panel prepared: that one isn't filled with this
    // page's plan (the kit checks again as it starts: `expectPage`).
    if (await pageMoved(ctx)) { moved = true; notePageMoved(ctx); return; }
    const skipBy = fillSkipBy(tabMaps(tabId).agentKeys, ctx.page, carrier, ctx.active);
    // The agent's Fill this page gives back an answer the page took back (keepTakenBack): GEICO's
    // own coverage choice put back over the fill's, on a question the agent didn't answer
    // themselves (their answers are in `skip`). An automatic fill keeps and flags it.
    const options = fillOptions(carrier, { overwrite, skip: fillSkip(tabMaps(tabId).agentKeys, ctx.scope, ctx.page, carrier), ...(skipBy ? { skipBy } : {}), ...(confirmed ? { confirmed } : {}), ...(ctx.asked ? { takenBack: null } : {}), run: ctx.run, expectPage: ctx.page }, ctx.settings.autoAdvance, ctx.active, ctx.unitsListed);
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, options]);
    // The intake changed meanwhile: the page holds the earlier one's answers (fillContext).
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (results.some((r) => r.result?.pageMoved)) { moved = true; notePageMoved(ctx); return; }
    // Filled with this intake (and the fill went through): this tab's layouts may be taken.
    state.layoutReadyTabs.add(tabId);
    const frames = results.map((r) => r.result).filter(Boolean);
    const retrying = rememberFill(frames, ctx);
    tabMaps(tabId).autoPages.add(page);
    followUp = afterFill(frames, ctx);
    logFill(ctx, frames, results, started);
    // The report is its own tab's: kept for it when the agent has moved to another tab meanwhile.
    // Stopped by the agent before the kit was done (a frame halted): said so, and the dock offers to
    // fill the rest.
    renderReport(frames, { ...ctx, plan, retrying, stopped: state.fillingFor?.run === ctx.run && !!state.fillingFor.stopping && frames.some((f) => f.halted) });
    if (!fillCurrent(ctx)) return;
    recordLayout(page);
    assistFrames = frames;
  } catch (e) {
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    tabMaps(tabId).autoPaused = true;
    // The message may quote the page, so it's redacted with the origin intake.
    logFillError(ctx, e);
    fillProblem(ctx, fillErrorMessage(ctx, e));
  } finally {
    unwatch();
    await tellRecorder('resume', tabId);
    state.filling = false;
    if (state.fillingFor?.run === ctx.run) state.fillingFor = null;
    renderSite();
    // The page in front, which this fill wasn't for, gets its own fill.
    if (moved && fillCurrent(ctx)) runPendingPage(ctx);
  }
  if (!fillCurrent(ctx)) return;
  // The agent's next step is the page's answers: in view (showFinish).
  // An automatic fill too: the agent sees what it filled and what's left, as after their own.
  showFinish({ auto: !!auto });
  runPendingPage(ctx);
  await remarkAi({ tabId, page, carrier });
  if (!fillCurrent(ctx)) return;
  if (assistFrames && !assistFrames.some((f) => f.halted)) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

// On the carrier's vehicle list page, work on the first intake vehicle not added yet (its Add
// Vehicle or VIN lookup not done in this quote). When every vehicle is in, the active one stays
// and nothing is left to add, so the page's Continue is clicked. Trailers (added from the same
// list) and the driver list work the same way (a driver or trailer counts as entered once its
// page was filled).
async function pickListItem(carrier, page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  await pickUnitForm(carrier, ctx);
  if (!fillCurrent(ctx)) return;
  await pickUnitToAdd(carrier, ctx);
  if (!fillCurrent(ctx)) return;
  await verifyListed(carrier, page, ctx);
  // Another tab came to the front while the list was read: its own fill picks for it.
  if (!fillCurrent(ctx)) return;
  const lists = [
    [carrier?.vehicleList, 'vehicles', (i) => ['lookupVin', 'addVehicle'].some((a) => state.doneActions.has(`${a}:${i}`))],
    // A trailer only once its page was filled: Add Trailer opened and left (an unsupported tile)
    // doesn't count, and Vehicle Summary holds Continue for it (the action's `unfinished` note).
    [carrier?.trailerList, 'trailers', (i) => state.doneActions.has(`trailerEntered:${i}`)],
    [carrier?.driverList, 'drivers', (i) => state.doneActions.has(`driverEntered:${i}`)],
  ];
  for (const [listPage, list, done] of lists) {
    if (!listPage || page !== listPage) continue;
    const next = (state.intake?.record[list] ?? []).findIndex((_, i) => !done(i));
    if (next < 0 || next === state.active[list]) continue;
    state.active[list] = next;
    await save();
    if (!fillCurrent(ctx)) return;
    renderPickers();
  }
}

// Where one address draws each unit's form (formScoped: GEICO's Add Vehicle or Trailer, Add
// Driver), a new, blank form while the panel's unit was already filled on another one is the next
// intake unit no form was filled for (FL live run, 2026-10-21: the second vehicle's and the second
// driver's forms waited for a pick). The driver the carrier lists itself (`listedDriver`: GEICO's
// owner who drives) is never the one an Add Driver form is for. A form with answers (a saved unit
// opened again) or with no unit left keeps the pagekit hold.
async function pickUnitForm(carrier, ctx) {
  if (!formScoped(carrier) || !Number.isInteger(ctx.tabId) || !ctx.intake) return;
  let forms = null;
  try {
    const frames = await runKit(ctx.tabId, carrier, () => globalThis.__raterKit?.unitFormsNow?.() ?? null);
    forms = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  if (!fillCurrent(ctx)) return;
  const record = ctx.intake.record ?? {};
  let picked = false;
  for (const { list, id, blank } of forms ?? []) {
    const bound = state.unitForms?.[list] ?? {};
    if (!blank || Object.hasOwn(bound, id)) continue;
    const listed = list === 'drivers' ? carrier.listedDriver?.(record) ?? -1 : -1;
    const taken = new Set(Object.values(bound));
    const free = (i) => !taken.has(i) && i !== listed;
    const active = state.active[list] ?? 0;
    if (free(active)) continue;
    const next = (record[list] ?? []).findIndex((_, i) => free(i));
    if (next < 0) continue;
    state.active[list] = next;
    picked = true;
  }
  if (!picked) return;
  await save();
  if (fillCurrent(ctx)) renderPickers();
}

// Where one address shows the quote's unit lists on a step (carrier.unitLists: GEICO's Vehicles and
// Trailers, Drivers), the unit the fill adds next (`ctx.adding`: { list, index }, for the plan: the
// chooser's answer and the add helpers), read from the lists and chosen by src/units.js unitToAdd:
// the intake's next unit no fill answered a form for and the list doesn't show (marked
// `<unit>Entered:<i>` while the list is on screen), never the driver GEICO lists itself, none while
// the list holds as many units as the intake, and none the list can't be read for while it has a
// row no intake unit is known to be on (it may be that one, added by hand). With no unit form on
// screen (the list, the chooser, the owner's own forms) the picker moves to that unit, so the plan
// is for it. The plan clicks the list's "+" and the chooser's Next for it (`click`) with "Fill the
// pages" or "Click Continue when the page is done" on (TNI, FL live run 5, 2026-10-21, W43-20), and
// on the agent's own Fill this page with both off (FL live run 6, 2026-10-21: Fill this page on the
// vehicle list did nothing, and the agent clicked "+"); an automatic fill with both off only answers
// the chooser.
async function pickUnitToAdd(carrier, ctx) {
  ctx.adding = null;
  ctx.unitsListed = false;
  if (!carrier?.unitLists?.length || !Number.isInteger(ctx.tabId) || !ctx.intake) return;
  const record = ctx.intake.record ?? {};
  const specs = unitListSpecs(carrier, record);
  let seen = null;
  try {
    const frames = await runKit(ctx.tabId, carrier, (specs) => {
      const kit = globalThis.__raterKit;
      if (!kit?.unitList) return null;
      return { step: kit.step?.() ?? '', forms: kit.unitFormsNow?.() ?? null, lists: specs.map((s) => kit.unitList(s.selector, s.items)) };
    }, [specs.map(({ selector, items }) => ({ selector, items }))]);
    seen = frames.map((f) => f?.result).find((x) => x && Array.isArray(x.lists)) ?? null;
  } catch { return; }
  if (!seen || !fillCurrent(ctx)) return;
  const next = unitToAdd(carrier, record, knownStep(carrier, seen.step), seen, { unitForms: state.unitForms, done: state.doneActions });
  if (!next) return;
  // Every intake unit on the list on screen: its Looks Good may be clicked (advanceFor). A list
  // holding as many rows as the intake that isn't read as complete is said in the usage log, in
  // counts only (W43-40: GEICO's Looks Good never clicked on a list that needed a VIN or name read).
  ctx.unitsListed = !!next.complete;
  const read = next.read;
  ctx.listNote = !next.complete && read && read.rows >= read.units ? `list: ${read.rows} rows for ${read.units} units, ${read.shown} shown, ${read.saved} saved by a fill` : null;
  if (next.marks.some((id) => !state.doneActions.has(id))) {
    next.marks.forEach((id) => state.doneActions.add(id));
    persistDoneActions(ctx.tabId, state.doneActions);
  }
  if (!next.adding) return;
  ctx.adding = { ...next.adding, click: !!(ctx.settings?.autoPages || ctx.settings?.autoAdvance || ctx.asked) };
  const { list, index } = next.adding;
  if (next.move && state.active[list] !== index) {
    state.active[list] = index;
    await save();
    if (fillCurrent(ctx)) renderPickers();
  }
}

// On the vehicle list, a trailer is on the quote when the list shows its VIN (Progressive lists each
// unit with its VIN), and not when the list shows the quote's vehicles by VIN but not this one
// (Add Trailer left by Back or the top menu, Codex on PR #43). Without VINs to compare, the return
// from its page decides (unitArrival).
async function verifyListed(carrier, page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  if (carrier?.driverList && page === carrier.driverList) return verifyDrivers(carrier, ctx);
  const onList = (carrier?.trailerList && page === carrier.trailerList) || (carrier?.vehicleList && page === carrier.vehicleList);
  if (!onList || !Number.isInteger(ctx.tabId)) return;
  const record = ctx.intake?.record ?? {};
  const vin = (u) => String(u?.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const trailers = (record.trailers ?? []).map(vin);
  const vehicles = (record.vehicles ?? []).map(vin);
  if (![...vehicles, ...trailers].some((v) => v.length >= 11)) return;
  let shown = null;
  const tabId = ctx.tabId;
  try {
    const frames = await runKit(tabId, carrier, (vins) => globalThis.__raterKit?.listed?.(vins) ?? null, [[...vehicles, ...trailers]]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  if (!shown || !fillCurrent(ctx)) return;
  const showsVins = shown.slice(0, vehicles.length).some(Boolean);
  // A vehicle back from its own pages (vehicleReturned, unitArrival) that the list now shows by
  // its VIN is on the quote, however it got there (the agent's own VIN lookup included): Add
  // Vehicle is never clicked for it again (live run 2026-10-10: the automatic fill added the same
  // vehicle a second time). The VIN alone isn't enough: the list also shows the vehicles the USDOT
  // lookup found, which aren't on the quote until added (audit 2026-10-10). A VIN not shown
  // proves nothing.
  if (carrier.vehicleList === page) {
    vehicles.forEach((v, i) => {
      if (v.length >= 11 && shown[i] && state.doneActions.has(`vehicleReturned:${i}`)) for (const id of [`lookupVin:${i}`, `addVehicle:${i}`]) state.doneActions.add(id);
    });
  }
  trailers.forEach((v, i) => {
    if (v.length < 11) return;
    if (shown[vehicles.length + i]) state.doneActions.add(`trailerEntered:${i}`);
    else if (showsVins) state.doneActions.delete(`trailerEntered:${i}`);
  });
  persistDoneActions(tabId, state.doneActions);
}

// On the driver list, a driver it shows by name (first and last) is entered, also when the panel
// was closed while the agent finished the driver's page (Codex on PR #43). A name not shown proves
// nothing (the list may write it another way): the return from the driver page decides. Nor does
// a name another intake driver's name holds (two John Smiths, Ann Lee and Mary Ann Lee): one row
// would count for both, and the other driver would never be added (Codex on PR #43).
async function verifyDrivers(carrier, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  if (!Number.isInteger(ctx.tabId)) return;
  const words = (d) => [d.first, d.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
  const drivers = (ctx.intake?.record?.drivers ?? []).map(words);
  const names = (ctx.intake?.record?.drivers ?? []).map((d, i) => drivers.some((other, j) => j !== i && drivers[i].every((w) => other.includes(w)))
    ? [] : [d.first, d.last].filter(Boolean));
  if (!names.some((n) => n.length >= 2)) return;
  let shown = null;
  const tabId = ctx.tabId;
  try {
    const frames = await runKit(tabId, carrier, (items) => globalThis.__raterKit?.listed?.(items) ?? null, [names]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  // The agent switched tabs meanwhile: the answer is about the other tab's quote (Codex on PR #43).
  if (!shown || !fillCurrent(ctx)) return;
  shown.forEach((on, i) => { if (on) state.doneActions.add(`driverEntered:${i}`); });
  persistDoneActions(tabId, state.doneActions);
}

// A driver or trailer is entered once the carrier took its page: its list comes back from it (its
// Continue went through). Answers filled there alone don't count: the page may still have failed
// or been left (Codex on PR #43). A driver page Progressive filled itself from Business Owner Info
// counts the same way once continued (OK 2026-10-07: the list added that driver again).
function unitArrival(carrier, from, page) {
  for (const [unitPage, listPage, list, marker] of [[carrier?.driverPage, carrier?.driverList, 'drivers', 'driverEntered'], [carrier?.trailerPage, carrier?.trailerList, 'trailers', 'trailerEntered']]) {
    if (!unitPage || from !== unitPage || page !== listPage) continue;
    // The unit the form named, when it named one (W43-37): a form for no intake driver marks none.
    const named = state.unitNamed?.list === list && state.unitNamed.page === unitPage ? state.unitNamed : null;
    const index = named ? named.index : state.active[list] ?? 0;
    if (index != null) state.doneActions.add(`${marker}:${index}`);
    if (named) state.unitNamed = null;
    persistDoneActions();
  }
  // Back on the vehicle list from the active vehicle's pages: only a mark that it may be on the
  // quote; the list showing its VIN decides (verifyListed).
  if (carrier?.vehicleList && page === carrier.vehicleList && carrier.vehiclePages?.includes(from)) {
    state.doneActions.add(`vehicleReturned:${state.active.vehicles ?? 0}`);
    persistDoneActions();
  }
}

// Bookkeeping after a fill: a click that opens more
// questions (cargo "+", Add a commodity) gets a follow-up fill once the page has drawn them.
// Returns whether that follow-up fill is coming.
function afterFill(frames, { tabId = state.tab?.id, carrier, page, run = null, intake = state.intake, revision = state.intakeRevision, active = state.active }) {
  const ctx = { tabId, carrier, page, run, intake, revision };
  const maps = tabMaps(tabId);
  // A helper found already done on the page (alreadyShown) clicked nothing: no follow-up for it.
  const clicked = frames.some((f) => (f.actions ?? []).some((a) => !a.alreadyShown));
  const moved = frames.some((f) => f.navigatedTo || f.advanced || f.halted);
  const advanced = frames.find((f) => f.advanced && f.signatureBefore != null);
  // Scoped by the step the fill continued from, as the kit read it (the tab's step is noted later);
  // per form and button where the carrier continues a step so (advance `byForm`: advanceKey).
  const doneKey = advanced?.stepKey ? stepScope(page, carrier, active, carrier?.layoutSteps ? knownStep(carrier, advanced.stepKey) : undefined) + (advanced.advanceKey ?? advanced.stepKey) : null;
  if (doneKey) maps.doneSteps.add(doneKey);
  // Keep the origin's bookkeeping, but never start helpers or Continue work in another tab.
  if (!fillCurrent(ctx)) return false;
  if (clicked && !moved) setTimeout(() => {
    if (fillCurrent(ctx) && pageOf(state.tab?.url) === page) scheduleAutoFill(page);
  }, 900);
  if (advanced) watchNextStep(carrier, page, advanced.signatureBefore, doneKey, run, ctx);
  return clicked && !moved && !state.autoPaused && $('auto-followups').checked;
}

// Luna is asked once the page has stopped changing: after the last follow-up fill of a helper
// chain (cargo "+", Add a commodity), and never about a page the fill has just left
// (2026-10-05: asked while the cargo follow-up still ran, its answer came back stale).
function assistAfterFill(frames, ctx, followUp) {
  const moved = frames.some((f) => f.navigatedTo || f.advanced);
  const wait = followUp && !moved ? ctx.page : null;
  // The agent switched rater tabs while this fill ran: its marker goes to its own tab's session.
  if (state.tab?.id !== ctx.tabId) {
    const saved = state.tabSessions.get(ctx.tabId);
    if (saved) saved.assistPage = wait;
    return;
  }
  state.assistPage = wait;
  if (!followUp && !moved) runAssist(frames, ctx);
}

// After Continue on an application that keeps one address for every step (AmWINS' Save &
// Continue), no page_view comes: wait until the questions on screen have changed (and stopped
// changing), then fill the new step. If the address changes instead, page_view handles it. Never
// fills the old step again, so Continue can't be clicked twice.
// A Continue that didn't take (the page neither moved nor changed for about 6 s, and isn't
// loading) is tried once more: Progressive's Change Payment Plan lost one while it redrew.
// When the second click doesn't take either, automatic filling pauses and the agent is told
// (audit 2026-10-08, finding 6): until then the lost Continue went unreported.
// A carrier without the retry (`continueRetry: false`: GEICO, FL live run 4, 2026-10-21, where the
// retry sent Next again while GEICO still worked on the first) is never clicked again: its page
// may load for up to a minute, and a quiet page that hasn't moved for about 18 s is the agent's.
// `doneKey`: the continued step's entry in state.doneSteps (see stepScope); `run`: the fill's.
async function watchNextStep(carrier, page, before, doneKey = null, run = null, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  const tabId = ctx.tabId;
  if (!$('auto-followups').checked && !$('auto-pages').checked) return;
  let last = null;
  let unchanged = 0;
  const retries = carrier.continueRetry !== false;
  const patience = retries ? 20 : 60;
  for (let i = 0; i < (retries ? 100 : 200); i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!fillCurrent(ctx) || pageOf(state.tab?.url) !== page || !state.intake) return;
    let now = null;
    try {
      // While the page saves / reloads (its loading overlay) the step isn't ready yet.
      const results = await runKit(tabId, carrier, () => (globalThis.__raterKit.busy() ? null : globalThis.__raterKit.signature()));
      now = results.find((r) => r.frameId === 0)?.result ?? null;
    } catch { return; }
    if (!fillCurrent(ctx) || pageOf(state.tab?.url) !== page) return;
    if (now != null && now !== before && now === last) {
      if (state.filling) state.pagePending = page;
      else fillPage({ auto: 'page' });
      return;
    }
    unchanged = now != null && now === before ? unchanged + 1 : 0;
    if (retries && unchanged >= patience && doneKey && !state.filling && !state.advanceRetried.has(doneKey)) {
      state.advanceRetried.add(doneKey);
      state.doneSteps.delete(doneKey);
      fillPage({ auto: 'page' });
      return;
    }
    if (unchanged >= patience && doneKey && !state.filling && (!retries || state.advanceRetried.has(doneKey))) {
      state.autoPaused = true;
      fillProblem({ tabId, page, carrier }, 'Continue didn\'t take: click it yourself.');
      if (!carrier.practice) usage.log({ type: 'fill_error', carrier: carrier.id, page, ...(run ? { run } : {}), auto: 'page', error: 'continue did not take' });
      return;
    }
    last = now;
  }
}

// "Mark done" on an item left for the agent: they answered it, or it stays as the page has it.
// Its field then joins the agent's on this page, as an edit there does: no fill changes it and
// Continue no longer waits on it. Nothing is filled or clicked now (Continue stays its own click),
// and it can be undone until the agent edits the field.
async function markDone(item, key, tabId, page, x = null) {
  if (!key || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  // Which question the agent marked done, and why it needed them: the review sees what was
  // waved through, not only what was filled.
  if (x && state.intake && !state.tab?.carrier?.practice) {
    usage.log({ ...checkDismissedEvent(x, { redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt }),
      carrier: state.tab.carrier?.id ?? null, page, view: viewOf(tabId, page, state.tab.carrier) });
  }
  const scope = editScope(page);
  const keys = state.agentKeys.get(scope) ?? new Set();
  const had = keys.has(key);
  keys.add(key);
  state.agentKeys.set(scope, keys);
  await persistAgentKeys();
  // Already the agent's (an edit on the page): nothing to undo. The undo takes it back from where
  // it was marked: the step, unit or form may be another by then (Next, a pick, a fill).
  settleNeed(item, 'marked', had ? null : () => undoMarkDone(item, key, tabId, page, scope));
}

async function undoMarkDone(item, key, tabId, page, scope = editScope(page)) {
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page || item.dataset.settled !== 'marked') return;
  state.agentKeys.get(scope)?.delete(key);
  await persistAgentKeys();
  item.classList.remove('resolved');
  delete item.dataset.settled;
  item.querySelector('.mark-done').hidden = false;
  // Open again: its row says what it waits on, and the note is empty.
  setRowHead(item, { icon: item.dataset.icon, value: item.dataset.wait });
  const note = item.querySelector('.need-note');
  note.replaceChildren();
  note.hidden = true;
  item.querySelector('.mark-done').focus();
  recount();
}

// "Show on page" on an item left for the agent: the carrier page scrolls to its field and the
// field's mark flashes (pagekit reveal), in whichever frame has it. Nothing is filled, clicked or
// focused there. Only on the item's own tab and page, as for Mark done. A field the page doesn't
// show now (in a closed section, or gone) is said on the item for a few seconds.
async function showOnPage(item, x, tabId, page, carrier) {
  if (!x.key || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  let found = false;
  try {
    const frames = await runKit(tabId, carrier, (key, label) => globalThis.__raterKit?.reveal?.(key, label) === true, [x.key, x.label ?? null]);
    found = frames.some((f) => f.result === true);
  } catch { /* the page is navigating */ }
  const where = item.querySelector('.need-where');
  if (!where) return;
  clearTimeout(where.hideTimer);
  where.hidden = found;
  where.textContent = found ? '' : 'Not on the page now (it may be in a closed section).';
  if (found) return;
  announce(where.textContent);
  where.hideTimer = setTimeout(() => { where.hidden = true; where.textContent = ''; }, 6000);
}

// An item left for the agent that is settled now: answered on the page ('answered'), put in from
// its row ('picked', with what the page shows), or marked done ('marked', with `undo`). It leaves
// "need you" at once, without a refill: its row says the answer is theirs.
function settleNeed(item, how, undo = null, value = null) {
  item.classList.add('resolved');
  item.dataset.settled = how;
  const focused = item.contains(document.activeElement);
  const button = item.querySelector('.mark-done');
  if (button) button.hidden = true;
  setRowHead(item, { icon: '✓', value: value ?? (how === 'marked' ? 'Marked done' : 'Answered on the page'),
    tag: { kind: 'you', text: 'You', title: how === 'picked' ? 'Your answer, put in from the panel' : 'Your answer' } });
  const note = item.querySelector('.need-note');
  note.hidden = false;
  note.classList.remove('bad');
  note.replaceChildren(...(how === 'answered'
    ? ['✓ You answered it on the page.']
    : how === 'picked' ? ['✓ Put in for you. No fill changes it now.']
      : ['✓ Marked done: won’t be filled or waited on.',
        undo ? h('button', { type: 'button', class: 'link small', onclick: undo }, 'Undo') : null].filter(Boolean)));
  // Keyboard focus stays on the item: on its Undo, or on its row.
  if (focused) (note.querySelector('button') ?? item.querySelector('.row-head') ?? item).focus();
  recount();
}

// A row's head: its icon, what it says now, and its source tag (none for an open item).
function setRowHead(item, { icon, value = null, tag = null }) {
  const head = item.querySelector('.row-head');
  if (!head) return;
  if (icon != null) head.querySelector('.row-icon').textContent = icon;
  if (value != null) head.querySelector('.row-value').textContent = value;
  head.querySelector('.tag')?.remove();
  if (tag) head.append(h('span', { class: `tag ${tag.kind}`, title: tag.title ?? '' }, tag.text));
}

// The agent changed questions on the page (the recorder's field_changes: { key, label, after }, `after`
// what it holds now): their items in the page's list are settled, and an answer the fill put in that
// they changed is theirs now, when the report shown is this page's. Rows of one repeated question
// share its key (one per vehicle or driver): one of those is matched by its label too, and left as
// it is when the change doesn't say which.
function answeredOnPage(page, changes) {
  if (!changes.length || pageOf(state.tab?.url) !== page || !state.reportFor?.fields) return;
  for (const item of $('report').querySelectorAll('.row.need')) {
    const change = changes.findLast((c) => c.key === item.dataset.key);
    if (change && item.dataset.settled !== 'answered') settleNeed(item, 'answered', null, change.after || null);
  }
  const rows = [...$('report').querySelectorAll('.row:not(.need)[data-key]')];
  for (const row of rows) {
    const shared = rows.some((r) => r !== row && r.dataset.key === row.dataset.key);
    const change = changes.findLast((c) => c.key === row.dataset.key && (!shared || c.label === row.dataset.field));
    if (!change?.after) continue;
    row.dataset.value = change.after;
    row.classList.remove('changed');
    setRowHead(row, { icon: '✓', value: row.dataset.value, tag: { kind: 'you', text: 'You', title: 'You changed it on the page: no fill puts it back' } });
  }
}

// Looks right: the agent approved the page as it stands now. Its receipt (pagekit receipt: a
// fingerprint of every answer on the page, no values) goes with a fill that clicks Continue only
// if the page still matches it then; a page that changed meanwhile is held again. Only for the page
// in front, and never while a fill runs.
async function lookRight(tabId, page, carrier, button = null) {
  const again = () => { if (button) button.disabled = false; };
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) { again(); return; }
  let confirmed = null;
  try {
    const frames = await runKit(tabId, carrier, () => globalThis.__raterKit?.receipt?.() ?? null, []);
    confirmed = frames.find((f) => f.frameId === 0)?.result ?? null;
  } catch { /* the page is navigating */ }
  if (!confirmed || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) {
    again();
    if (!confirmed) announce('Couldn’t read the page. Try Looks right again.');
    return;
  }
  await fillPage({ confirmed });
}

// Whether the page still shows the answers the fill put in (pagekit readBack: reads only). A row
// whose field shows something else now (the carrier's server, or the agent) says what; one whose
// field isn't on the page now (a closed section) is left as it was. Only for the page in front.
// `plan`: the fill's plan, so the kit judges each answer as fill does (readBack `agrees`).
async function checkAnswers(body, tabId, page, carrier, plan = []) {
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const rows = [...body.querySelectorAll('.row:not(.need)[data-key]')];
  if (!rows.length) return;
  const items = rows.map((row) => ({ key: row.dataset.key, label: row.dataset.field || null, stepId: row.dataset.step || null }));
  const ids = new Set(items.map((x) => x.stepId).filter(Boolean));
  const steps = (plan ?? []).filter((s) => ids.has(String(s.id)));
  let frames;
  try {
    frames = await runKit(tabId, carrier, (asked, filledBy) => globalThis.__raterKit?.readBack?.(asked, filledBy) ?? [], [items, steps]);
  } catch { return; /* the page is navigating */ }
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const now = new Map(frames.flatMap((f) => Array.isArray(f.result) ? f.result : []).map((x) => [`${x.key}|${x.label ?? ''}`, x]));
  // Spacing, case and punctuation aside: a phone number the page formats on blur is the same.
  const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const row of rows) {
    const x = now.get(`${row.dataset.key}|${row.dataset.field}`) ?? now.get(`${row.dataset.key}|`);
    if (!x) continue;
    // The kit's word first (an address the page rewrote in its own format is the same answer);
    // without it, the text. An unticked box we left unticked reads back 'unchecked' (and empty).
    const differs = x.agrees === true ? false : loose(x.shown) !== loose(row.dataset.value);
    row.classList.toggle('changed', differs);
    const note = row.querySelector('.kv-now');
    note.hidden = !differs;
    note.textContent = differs ? `Now on the page: ${x.shown || 'empty'}` : '';
  }
  const changed = rows.filter((row) => row.classList.contains('changed')).length;
  if (changed) announce(`${changed} answer${changed === 1 ? '' : 's'} on the page changed since the fill.`);
}

// Reads the answers of the report shown back from the page (checkAnswers): when the agent looks at
// what is in (the Filled filter, step 3) and when the fill holds Continue for their check.
function refreshAnswers() {
  const entry = state.reportFor;
  if (entry?.fields && entry.tabId === state.tab?.id) checkAnswers($('report'), entry.tabId, entry.page, entry.carrier ?? state.tab.carrier, entry.plan);
}

// After a fill: the page's answers in one list, in the order of their fields on the page. Each
// answer that went in says what and where it came from (the intake, worked out from it, a TNI
// standard, the agent, the page) and opens to its source, Change answer and See in intake; each
// item left for the agent says why, and offers its choices where the panel may put the agent's
// pick in (agentPickable), or Show on page and Mark done. The report is the fill's own tab and
// page's (`ctx`; the tab in front when none is given), kept for it while another one is in front.
function renderReport(frames, ctx = {}) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const fields = frames.reduce((n, f) => n + (f.fields ?? 0), 0);
  const tabId = ctx.tabId ?? state.tab?.id;
  const page = ctx.page ?? pageOf(state.tab?.url);
  const carrier = ctx.carrier ?? state.tab?.carrier;
  const maps = tabMaps(tabId);
  // The one-address application's step this fill was on, for the page strip and the report's key.
  const step = knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey);
  // A report made again on reopen (restoreReports) is an earlier step's: the tab's step stays.
  if (step && !ctx.restoredAt) state.tabSteps.set(tabId, step);
  const key = ctx.keptKey ?? reportKey(tabId, page, carrier, ctx.active ?? state.active);
  // Kept for the panel opened again (keepReport); one made again from what was kept isn't, nor
  // one that says nothing while its page is filled again.
  const keep = () => { if (!ctx.restoredAt) keepReport(tabId, { key, page, active: { ...(ctx.active ?? state.active) }, at: Date.now(), stopped: !!ctx.stopped,
    // What earlier passes on this page filled, for the report shown again (restoreReports).
    filledBefore: Object.fromEntries(frames.flatMap((fr) => fr.kept ?? []).filter((x) => maps.filled?.get?.(x.key)).map((x) => [x.key, maps.filled.get(x.key)])), frames }); };
  // A page of tiles only (Most Common Vehicles) has no fields but may still need the agent.
  if (!fields && !all('actions').length && !all('noData').length) {
    // A step the kit couldn't read pauses nothing (rememberFill): its reason alone.
    const halted = frames.find((f) => f.halted && !f.stepUnread) ?? frames.find((f) => f.halted);
    // Still drawing, or Continue not there yet: filled again in a moment (rememberFill), nothing
    // said until then (W43-40, W43-42).
    if (!halted && ctx.retrying) { renderSteps(); return; }
    keep();
    // A page with no question for the fill (a unit list, every unit on it) is done: its dock offers
    // Continue (`empty`, W43-40). One that should have some (notDrawn) still has none.
    putReport({ key, tabId, page, at: ctx.restoredAt ?? Date.now(), ...(ctx.restoredAt ? { restored: true } : {}), ...(halted
      // A panel opened again doesn't keep the pause: a report made again doesn't say it.
      ? { error: `${halted.stepUnread || ctx.restoredAt ? '' : 'Automatic filling and helpers paused. '}${halted.reason ?? 'Review this page before retrying.'}` }
      : frames.some((f) => f.notDrawn) ? { notice: 'No questions found on this page.' }
        : { notice: 'Nothing to fill on this page.', empty: true, advanced: frames.find((f) => f.advanced)?.advanced ?? null,
          held: frames.some((f) => f.advanced) ? null : frames.find((f) => f.held)?.held ?? null }) }, []);
    renderSteps();
    return;
  }
  keep();
  const unknownKeys = new Set(all('unknown').map((x) => x.key));
  // Each item with its frame's place among the page's frames (pagekit's `order` counts within one).
  // A field of another step (pagekit otherStep: AmWINS' prior carriers, filled again while hidden)
  // isn't this step's: left out of its list and count (live run 2026-10-09).
  const framed = (k) => frames.flatMap((f, frame) => (f[k] ?? []).map((x) => ({ ...x, frame })));
  const filled = framed('filled').filter((x) => !x.otherStep);
  const kept = framed('kept').filter((x) => !x.otherStep);
  const items = [
    ...framed('unknown').map((x) => ({ ...x, mark: 'needs', why: `Unfamiliar question${x.required ? ' (required)' : ''}: no TNI rule for it yet.` })),
    ...framed('failed').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'failed', why: `Couldn't fill: ${x.reason}` })),
    ...framed('noData').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'needs', why: x.note ?? 'Not on the intake.' })),
    ...framed('leftRequired').filter((x) => !unknownKeys.has(x.key)).map((x) => ({ ...x, mark: 'needs', why: 'Required, and not on the intake.' })),
    ...kept.filter((x) => x.differs).map((x) => ({ ...x, mark: 'needs', why: 'The page already had a different value than the intake; it was kept.' })),
    // Defaults filled for the agent to confirm (e.g. marital status missing on the intake).
    ...framed('checks').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'needs', why: x.note })),
  ];
  const onPage = (x) => Number.isInteger(x.order);
  const needs = [...items.filter(onPage).sort((a, b) => a.frame - b.frame || a.order - b.order), ...items.filter((x) => !onPage(x))];
  const waiting = all('blocked');
  const advanced = frames.find((f) => f.advanced)?.advanced;
  // Buttons not clicked for something open over them on the page (pagekit `coveredHelpers`, a
  // helper's words; `covered`, Continue).
  const covered = [...new Set(frames.flatMap((f) => [...(f.coveredHelpers ?? []), ...(f.covered ? ['Continue'] : [])]))];
  // A page note may depend on the intake (Progressive's Rates for an NTL quote).
  const pageNote = carrier?.agentPages?.[page];
  const agentPage = typeof pageNote === 'function' ? pageNote(state.intake?.record ?? {}) : pageNote;
  // Answers an earlier pass on this page filled (a follow-up pass, after the VIN lookup or a
  // redraw, finds them already there): still ours, shown as filled.
  const before = ctx.filledBefore ? new Map(Object.entries(ctx.filledBefore)) : maps.filled;
  const earlier = kept.filter((x) => !x.differs && before?.get?.(x.key));
  const { fromOf, groupOf, ticks, editedBy } = answerSources(ctx.plan);
  const doneRows = groupRows([
    // `key`/`field`: the field and its label on the page, for checking the answer is still there
    // (checkAnswers) and changing it (changeAnswer); `kind`: what it is when it's no answer of ours.
    ...filled.map((x) => ({ label: x.label || x.name, value: x.shown ?? '', standard: !!x.standard, path: x.path, from: fromOf.get(x.stepId), edited: editedBy(x.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId, answer: true, key: x.key, field: x.label ?? null, q: x.q ?? null, frame: x.frame, order: x.order })),
    ...earlier.map((x) => {
      const was = before.get(x.key);
      return { label: x.label || x.name, value: was.shown || 'filled', standard: !!(x.standard || was.standard), path: was.path, from: fromOf.get(x.stepId), edited: editedBy(was.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId, answer: true, key: was.shown ? x.key : null, field: x.label ?? null, q: x.q ?? null, frame: x.frame, order: x.order };
    }),
    ...all('actions').map((x) => ({ label: 'Clicked', value: x.text || x.id, kind: 'clicked' })),
    ...kept.filter((x) => !x.differs && !earlier.includes(x)).map((x) => ({ label: x.label || x.name, value: 'left as the page had it', standard: !!x.standard, group: groupOf.get(x.stepId), stepId: x.stepId, kind: 'page', frame: x.frame, order: x.order })),
    ...all('skipped').map((x) => ({ label: x.label, value: 'yours, not filled', kind: 'yours' })),
  ], ticks);
  const count = doneRows.filter((row) => row.answer).length;
  // The carrier probably changed this page (pagekit: a known field renamed, or most questions
  // unfamiliar). The rest still filled; Continue waits for the agent.
  const renamedNames = all('renamed').map((x) => '"' + x.name + '"').join(', ');
  const pageChanged = frames.some((f) => f.pageChanged)
    ? (carrier?.name ?? 'The carrier') + ' seems to have changed this page: ' + all('unknown').length + " question(s) aren't known"
      + (renamedNames ? ', and ' + renamedNames + " moved to a field the extension doesn't know" : '')
      + ". They're left for you and Continue waits. Please report it (a Capture page layout helps)."
    : null;
  // Held for the agent's check (Let me look before Continue): the top frame's word.
  const held = advanced ? null : frames.find((f) => f.held)?.held ?? null;
  const stopped = !!ctx.stopped;
  const entry = { key, tabId, page, carrier, plan: ctx.plan ?? [], fields, filled: count, left: needs.length, waiting: waiting.length, covered: covered.length, advanced: advanced ?? null, held, at: ctx.restoredAt ?? Date.now(), auto: !!ctx.auto, stopped,
    ...(ctx.restoredAt ? { restored: true } : {}) };
  // The answers and the items in one list, by their place on the page: an item without a field on
  // the page (a helper, a unit without its row) after them, then answers without one (a click).
  const listed = [...doneRows.map((row) => ({ row, at: row })), ...needs.map((x) => ({ x, at: x }))];
  const ordered = [...listed.filter((e) => onPage(e.at)).sort((a, b) => a.at.frame - b.at.frame || a.at.order - b.at.order),
    ...listed.filter((e) => !onPage(e.at) && e.x), ...listed.filter((e) => !onPage(e.at) && e.row)];
  const first = ordered.find((e) => e.x);
  const rctx = { tabId, page, carrier };
  const halted = frames.find((f) => f.halted);
  const nodes = [
    agentPage ? h('p', { class: 'note-line agent-page' }, agentPage) : null,
    // An answer picked in place of one the page doesn't offer (pagekit `orMost`: GEICO's pay plan
    // with no 11 Payments, W43-32): named here; nothing is left for the agent by it.
    ...filled.filter((x) => x.said).map((x) => h('p', { class: 'note-line said' }, x.said)),
    // Not clicked through what is open over them (Continue, a helper), which the agent closes.
    !advanced && covered.length
      ? issueCard({ tone: 'warn', title: `${covered.length > 1 ? `${covered.slice(0, -1).join(', ')} and ${covered.at(-1)} weren’t` : `${covered[0]} wasn’t`} clicked`,
        text: `Something is open over ${covered.length > 1 ? 'them' : 'it'} on the page, such as a dialog or a message. Close it, then fill again${covered.includes('Continue') ? ' or click Continue yourself' : ''}.` }) : null,
    halted ? (stopped
      ? issueCard({ tone: 'quiet', title: 'You stopped the fill', text: 'Nothing more was filled or clicked. What went in stays.' })
      : issueCard({ title: 'Filling stopped', text: `${halted.reason ?? ''} Check the page, then fill again.`.trim(), role: 'alert' })) : null,
    pageChanged ? issueCard({ title: 'This page seems to have changed', text: pageChanged, role: 'alert' }) : null,
    advanced ? h('div', { class: 'done-card' }, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('b', {}, 'This page is done'),
      h('span', {}, `${count} answer${count === 1 ? '' : 's'} in. Clicked “${advanced}” for you.`)) : null,
    // The AI's messages, and what it suggests without a row, go here, above the list (runAssist).
    h('div', { class: 'needs-head', hidden: true }),
    // Buttons waiting on others (Progressive's bill plan before Recalculate) aren't listed: the fill
    // clicks them in turn, and a question one waits on is a row. The fill log keeps them (blockerList).
    ordered.length ? h('div', { class: 'rows' }, ordered.map((e) => (e.x ? needRow(e.x, rctx, e === first) : answerRow(e.row, rctx)))) : null,
  ].filter((node) => node != null && node !== false);
  if (key === currentReportKey()) state.filter = 'all';
  putReport(entry, nodes);
  renderSteps();
  if (state.reportFor !== entry || ctx.restoredAt) return;
  announce(`Filled ${count} answer${count === 1 ? '' : 's'}. ${needs.length ? `${needs.length} left for you.` : held ? 'Check the answers, then click Looks right.' : 'Nothing is left for you.'}`);
  if (held) refreshAnswers();
}

// Where a fill's answers came from, by their plan step (plan.js): `fromOf`, the intake answers a
// derived one was worked out from; `groupOf`, the question several boxes answer together; `ticks`,
// the boxes our answer ticks. `editedBy`: an answer filled from a field the agent set or corrected
// in the panel (client details, a Check intake button such as Use Female) is the agent's, not the
// client's (also openPdf's `edited`).
function answerSources(plan) {
  const steps = plan ?? [];
  return {
    fromOf: new Map(steps.filter((s) => s.from).map((s) => [s.id, s.from])),
    groupOf: new Map(steps.filter((s) => s.group).map((s) => [s.id, s.group])),
    ticks: new Set(steps.filter((s) => s.group && s.value === true).map((s) => s.id)),
    editedBy: (path, from) => [path, ...(from ?? [])].some((p) => p && state.intake?.agentEdited?.includes(p)),
  };
}

// One question asked as several boxes (plan.js `group`: AmWINS' auto symbols): one row, the
// question and the boxes ticked, where the first box was (live run 2026-10-09: nine rows).
function groupRows(rows, ticks) {
  return rows.reduce((out, row) => {
    if (!row.group) return [...out, row];
    const g = out.find((r) => r.grouped === row.group)
      ?? (out.push({ label: row.group, grouped: row.group, ticked: [], standard: true, answer: false, frame: row.frame, order: row.order }), out.at(-1));
    // Ticked by our answer (filled now, earlier, or already so on the page).
    if (ticks.has(row.stepId)) g.ticked.push(row.label);
    g.answer ||= !!row.answer;
    g.standard &&= row.standard;
    g.value = g.ticked.join(', ') || 'none ticked';
    return out;
  }, []);
}

// One answer in the page's list (renderReport): what went in and where it came from, opening to its
// source with Change answer and See in intake. `row.kind`: 'clicked', 'page' (left as the page had
// it) or 'yours' (the agent's own answer, not filled); otherwise an answer, by its source.
function answerRow(row, { tabId, page, carrier }) {
  const kind = row.kind ?? (row.edited ? 'edited' : row.standard ? 'standard' : row.from ? 'derived' : 'intake');
  // Where it is on the intake PDF: the field an answer came from, or those a derived one was worked
  // out from. A TNI standard is no intake fact; no link while the PDF isn't kept.
  const pdfHere = pdfAvailable();
  const paths = [].concat(row.from ?? row.path ?? []);
  const place = ['intake', 'derived', 'edited'].includes(kind) && pdfHere && state.intake && paths.length ? sourcePlace(paths, state.intake) : null;
  const tag = {
    intake: { cls: 'intake', text: `Intake${place ? pdfPageSaid(place.page, ' p.') : ''}`, title: 'From the intake' },
    derived: { cls: 'derived', text: 'Worked out', title: 'Worked out from intake answers' },
    standard: { cls: 'standard', text: 'TNI standard', title: 'A TNI standard answer, not a fact from the intake' },
    edited: { cls: 'you', text: 'Your edit', title: 'From your correction in the panel' },
    page: row.standard ? { cls: 'standard', text: 'TNI standard', title: 'The page already had the TNI standard answer' } : { cls: 'page', text: 'On the page', title: 'The page already had it' },
    clicked: { cls: 'clicked', text: 'Clicked', title: 'Clicked for you' },
    yours: { cls: 'you', text: 'You', title: 'Your answer: no fill changes it' },
  }[kind];
  const fmt = (v) => (v === true ? 'Yes' : v === false ? 'No' : v == null || v === '' ? 'not on the intake' : String(v));
  const said = (path) => `${fieldInfo(path).label}: ${fmt(get(state.intake?.record ?? {}, path))}`;
  const [title, quote] = {
    intake: [`Intake${place ? pdfPageSaid(place.page, ', page ') : ''}`, row.path ? said(row.path) : `Answer: ${row.value}`],
    derived: ['Worked out from the intake', (row.from ?? []).map(said).join(' · ')],
    standard: ['TNI standard answer', `Answer: ${row.value}`],
    edited: ['Your correction in the panel', row.path ? said(row.path) : `Answer: ${row.value}`],
    page: ['Already on the page', 'The fill left it as the page had it.'],
    clicked: ['Clicked for you', `“${row.value}”`],
    yours: ['Your answer', 'You changed it on the page, so no fill puts it back.'],
  }[kind];
  const item = h('div', { class: `row${{ page: ' page', clicked: ' clicked', yours: ' yours' }[kind] ?? ''}${row.fresh ? ' fresh' : ''}`,
    dataset: row.key ? { key: row.key, field: row.field ?? '', value: row.value, step: row.stepId ?? '' } : {} },
  h('button', { type: 'button', class: 'row-head', 'aria-expanded': 'false', onclick: () => toggleRow(item) },
    h('span', { class: 'row-icon', 'aria-hidden': 'true' }, kind === 'page' || kind === 'yours' ? '•' : '✓'),
    h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, row.label), h('span', { class: 'row-value' }, row.value),
      row.key ? h('span', { class: 'kv-now', hidden: true }) : null),
    // From the intake is the usual source: no tag to read past (said to screen readers), so the
    // others stand out.
    kind === 'intake' ? h('span', { class: 'sr-only' }, tag.title) : h('span', { class: `tag ${tag.cls}`, title: tag.title }, tag.text)),
  h('div', { class: 'row-body', hidden: true },
    h('div', { class: 'src-box' }, h('span', { class: 'src-title' }, title), quote ? h('span', { class: 'src-quote' }, quote) : null),
    h('div', { class: 'change-slot' }),
    row.answer && row.key || place ? h('div', { class: 'row-actions' },
      row.answer && row.key ? h('button', { type: 'button', class: 'ghost change', 'aria-label': `Change answer: ${row.label}`, onclick: () => changeAnswer(item, row, { tabId, page, carrier }) }, 'Change answer') : null,
      place ? h('button', { type: 'button', class: 'link small src',
        title: kind === 'edited' ? 'Show what the intake said before your edit' : kind === 'derived' ? 'Show the intake answers this was worked out from' : 'Show where this came from in the intake',
        onclick: () => openPdf({ path: row.path, from: row.from, label: row.label, kind: 'filled' }) }, 'See in intake') : null) : null,
    row.key ? h('span', { class: 'need-where', hidden: true }) : null,
    h('p', { class: 'need-note', hidden: true })));
  return item;
}

// One item left for the agent (renderReport): why, and its choices where the panel may put the
// agent's pick in (agentPickable; the AI's suggestion joins them, renderAi), with Show on page and
// Mark done. `open`: the first one starts open.
function needRow(x, { tabId, page, carrier }, open = false) {
  const label = x.label || x.name;
  const pickable = agentPickable(x, carrier, page);
  const options = [...new Set(choicesOf(x.controlKind, x.options))];
  const kind = x.mark === 'failed' ? 'failed' : pickable ? 'need' : 'yours';
  const icon = { failed: '!', need: '?', yours: '•' }[kind];
  const wait = { failed: 'Couldn’t fill', need: 'Needs your answer', yours: 'Left for you' }[kind];
  const now = x.controlKind !== 'text' && x.current ? x.current : null;
  // Scrolls the carrier page to its field and flashes its mark (showOnPage): changes nothing.
  const show = x.key ? h('button', { class: 'link small show-on-page', type: 'button', title: 'Scroll the carrier page to this question and flash its mark',
    'aria-label': `Show on page: ${label}`, onclick: () => showOnPage(item, x, tabId, page, carrier) }, 'Show on page') : null;
  const done = x.key ? h('button', { class: 'ghost mark-done', type: 'button', title: 'You answered it, or it stays as the page has it: the panel won’t fill it or wait on it on this page',
    'aria-label': `Mark done: ${label}`, onclick: () => markDone(item, x.key, tabId, page, x) }, 'Mark done') : null;
  const item = h('div', { class: `row need${kind === 'need' ? '' : ` ${kind}`}${open ? ' open' : ''}`, tabindex: '-1', dataset: { need: `${x.key}|${x.label}`, key: x.key ?? '', icon, wait } },
    h('button', { type: 'button', class: 'row-head', 'aria-expanded': String(open), onclick: () => toggleRow(item) },
      h('span', { class: 'row-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'row-text' }, h('span', { class: 'row-label' }, label), h('span', { class: 'row-value' }, wait))),
    h('div', { class: 'row-body', hidden: !open },
      h('p', { class: 'why' }, x.why, now ? ` On the page now: ${choiceSaid(now)}.` : ''),
      h('div', { class: 'ai-slot' }),
      pickable
        ? choiceList(options, { current: now, onPick: (choice, button) => (item.aiAccept && choice === item.dataset.aiPick
          ? item.aiAccept(button) : agentAnswer(item, x, choice, { tabId, page, carrier }, button)) })
        : h('p', { class: 'row-say' }, 'Answer it on the rater page, then mark it done here.'),
      !pickable && x.options?.length && x.mark === 'failed' ? h('div', { class: 'options' }, `Options: ${x.options.slice(0, 25).join(' · ')}${x.options.length > 25 ? ' · …' : ''}`) : null,
      h('div', { class: 'row-actions' }, show, done),
      show ? h('span', { class: 'need-where', hidden: true }) : null,
      // Empty while the item is open: what settled it, once it is (settleNeed), or why the page
      // didn't take a pick (agentAnswer).
      h('p', { class: 'need-note', hidden: true })));
  return item;
}

// Whether the panel may put the agent's own pick in for a question (agentAnswer): a choice the page
// offers, never one TNI leaves to the agent on the page (report orders, exclusions, signatures,
// payment: neverReason) or a lookup identity they must verify there (reviewOnly), and nothing on a
// stop page, step or screen.
function agentPickable(x, carrier = state.tab?.carrier, page = pageOf(state.tab?.url)) {
  if (!x?.key || !['radio', 'select', 'checkbox'].includes(x.controlKind)) return false;
  const options = choicesOf(x.controlKind, x.options);
  return options.length > 0 && !x.reviewOnly && !neverReason(x) && !stopNoteFor(carrier, page);
}

// The choices a question offers the agent: a checkbox's two states, or the options the page lists.
function choicesOf(kind, options) {
  return kind === 'checkbox' ? ['checked', 'unchecked'] : options ?? [];
}

// A choice as the agent reads it (a checkbox's two states named).
function choiceSaid(choice) {
  return choice === 'checked' ? 'Checked' : choice === 'unchecked' ? 'Unchecked' : String(choice);
}

// The choices the panel may put in for the agent: buttons, or a list past six; the page's answer now
// pressed. `onPick(choice, button)`.
function choiceList(options, { current = null, onPick }) {
  if (options.length <= 6) {
    return h('div', { class: 'opts', role: 'group', 'aria-label': 'Answers' }, options.map((o) => h('button', { type: 'button', class: 'opt-btn',
      'aria-pressed': String(o === current), dataset: { choice: o }, onclick: (e) => onPick(o, e.currentTarget) }, h('span', {}, choiceSaid(o)))));
  }
  const select = h('select', { 'aria-label': 'Answer' }, h('option', { value: '' }, 'Choose…'),
    options.map((o) => h('option', { value: o, selected: o === current }, choiceSaid(o))));
  return h('div', { class: 'opt-select' }, select,
    h('button', { type: 'button', class: 'ghost', onclick: (e) => { if (select.value) onPick(select.value, e.currentTarget); } }, 'Put it in'));
}

// Opens a row of the page's list in place (closing the one open before), or closes it.
function toggleRow(item, open = !item.classList.contains('open')) {
  if (open) for (const other of item.parentNode?.querySelectorAll(':scope > .row.open') ?? []) if (other !== item) toggleRow(other, false);
  item.classList.toggle('open', open);
  item.querySelector('.row-head')?.setAttribute('aria-expanded', String(open));
  const body = item.querySelector('.row-body');
  if (body) body.hidden = !open;
  renderDock();
}

// The dock's Show the next one: the next question still needing the agent after the one open now
// (the first when none is), opened in the whole list and brought into view.
function showNextNeed() {
  if (state.view !== 'page' || state.filter !== 'all' || state.pastKey) {
    state.view = 'page';
    state.filter = 'all';
    state.pastKey = null;
    showScreen();
    renderSteps();
  }
  const open = [...$('report').querySelectorAll('.row.need:not(.resolved)')];
  if (!open.length) return;
  const now = $('report').querySelector('.row.open');
  const next = (now && open.find((n) => n !== now && (now.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))) || open.find((n) => n !== now) || open[0];
  toggleRow(next, true);
  next.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  next.querySelector('.row-head')?.focus({ preventScroll: true });
}

// Change answer on a row that went in: the choices the page offers now, put in for the agent from
// the row (agentAnswer); a typed answer, or one the panel may not answer, is shown on the page for
// the agent to change there (showOnPage), where their answer then stays theirs.
async function changeAnswer(item, row, { tabId, page, carrier }) {
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const slot = item.querySelector('.change-slot');
  if (slot.childElementCount) { slot.replaceChildren(); return; }
  let frames = null;
  try { frames = await runKit(tabId, carrier, () => globalThis.__raterKit.decisionSnapshot()); } catch { /* the page is navigating */ }
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const matches = aiSnapshotFieldMatches(frames, { key: row.key, label: row.field });
  const field = matches.length === 1 ? matches[0].field : null;
  const x = field ? { key: field.key, label: field.label, section: field.section, controlKind: field.kind, q: row.q ?? null, current: field.current,
    options: choicesOf(field.kind, field.options) } : null;
  if (!x || !agentPickable(x, carrier, page)) {
    const note = item.querySelector('.need-note');
    note.hidden = false;
    note.classList.remove('bad');
    note.textContent = 'Change it on the rater page. Your answer there stays: no fill puts this one back.';
    showOnPage(item, { key: row.key, label: row.field }, tabId, page, carrier);
    return;
  }
  slot.replaceChildren(h('p', { class: 'why' }, 'Pick the answer to put in instead:'),
    choiceList(x.options, { current: x.current, onPick: (choice, button) => agentAnswer(item, x, choice, { tabId, page, carrier }, button) }));
  slot.querySelector('button, select')?.focus();
}

// The agent's pick for a question, from its row (an item left for them, or Change answer): put in
// through the same guarded path as an AI answer (pagekit answerEdits and answer, `by: 'agent'`),
// only while the page still shows the question and the choice as the row read them, never on a
// stop step. The field then joins the agent's on this page, as their own edit there does: no fill
// changes it and Continue no longer waits on it. Logged as the agent's field change.
async function agentAnswer(item, x, choice, { tabId, page, carrier }, button = null) {
  if (state.filling || state.closing || !state.intake || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page || !agentPickable(x, carrier, page)) return;
  const note = item.querySelector('.need-note');
  const say = (text) => { note.hidden = false; note.classList.add('bad'); note.replaceChildren(text); };
  const intake = state.intake;
  const revision = state.intakeRevision;
  const scope = usage.currentSession()?.intakeId;
  const editOrigin = { scope, tabId, page: editScope(page, carrier), keys: state.agentKeys, epoch: state.agentKeysEpochs?.get(scope) ?? 0 };
  const current = () => state.tab?.id === tabId && pageOf(state.tab?.url) === page && state.intake === intake && state.intakeRevision === revision;
  const token = crypto.randomUUID();
  let field = null;
  let result = null;
  let guarding = false;
  let edited = [];
  state.filling = true;
  if (button) button.disabled = true;
  // Our own answer isn't the agent's change on the page: the recorder is paused, as for a fill.
  await tellRecorder('pause', tabId);
  try {
    guarding = true;
    await runKit(tabId, carrier, (t) => globalThis.__raterKit.answerEdits('begin', t), [token]);
    if (!current()) return;
    const frames = await runKit(tabId, carrier, () => globalThis.__raterKit.decisionSnapshot());
    if (!current()) return;
    const matches = aiSnapshotFieldMatches(frames, x);
    if (matches.length !== 1) { say('The page changed: answer it on the page.'); return; }
    const [{ frame }] = matches;
    field = matches[0].field;
    const options = choicesOf(field.kind, field.options);
    if (!options.includes(choice) || !agentPickable({ ...x, controlKind: field.kind, section: field.section, options }, carrier, page)) {
      say('The page doesn’t offer that answer now: answer it on the page.');
      return;
    }
    const answered = await runKit(tabId, carrier, (a, t, o) => globalThis.__raterKit.answer(a, null, t, o),
      [[{ key: field.key, label: field.label, value: choice, expected: { kind: field.kind, section: field.section, options, current: field.current } }],
        token, { stopSteps: Object.keys(carrier.stopSteps ?? {}), by: 'agent' }], [frame.frameId]);
    result = answered.flatMap((f) => f.result ?? []).find((r) => r?.key === field.key) ?? null;
  } catch {
    result = null;
  } finally {
    if (guarding) {
      try {
        const frames = await runKit(tabId, carrier, (t) => globalThis.__raterKit.answerEdits('end', t), [token]);
        // The agent's own edits while the answer went in stay theirs, as after a fill.
        edited = frames.flatMap((f) => f.result ?? []).filter((r) => r?.protected).map((r) => r.key);
      } catch { /* a removed or navigating frame no longer has live listeners */ }
    }
    await persistGuardedEdits(editOrigin, edited);
    await tellRecorder('resume', tabId);
    state.filling = false;
    if (button) button.disabled = false;
    // The recorder was paused: the questions the answer revealed or hid are read here.
    if (field && state.tab?.id === tabId) scheduleLayout(page, 'changed');
  }
  if (!field) return;
  if (!result?.ok) {
    if (current()) say(result?.reason ? `The page didn’t take it (${result.reason}). Answer it on the page.` : 'Couldn’t reach the page. Answer it on the page.');
    return;
  }
  const shown = result.shown || choice;
  // In on the page, so the agent's from now on where it went in (no fill changes it) and logged with
  // the quote it went into, also when they moved to another tab, page or intake meanwhile.
  await persistGuardedEdits(editOrigin, [x.key]);
  if (!carrier.practice && usage.currentSession()?.intakeId === scope) {
    const maps = tabMaps(tabId);
    const ctx = { record: intake.record, filled: maps.filled, labels: maps.labels, choices: maps.choices,
      redact: redactor(redactionTerms(intake.record)), keySalt: usage.currentSession()?.keySalt, step: knownStep(carrier, tabStep(carrier, tabId)) };
    usage.log({ carrier: carrier.id, page, view: viewOf(tabId, page, carrier),
      ...fieldChangeEvent({ key: field.key, q: x.q ?? null, label: field.label, kind: field.kind, before: field.current ?? '', after: shown, agent: true }, ctx) });
  }
  if (!current()) return;
  // The AI's word on it, if any: a suggestion the agent answered otherwise is dismissed (logged);
  // a pick it put in that waits for approval is the agent's answer now, as after an edit there.
  const sugg = item.aiSuggestion;
  if (sugg && [...state.aiCache.values()].includes(sugg)) {
    if (sugg.done === 'auto' && !sugg.approved && !sugg.manual) {
      sugg.manual = true;
      persistAiPending();
      syncAiBanner({ tabId, page, carrier });
    } else if (!sugg.done && !sugg.dismissed) {
      sugg.dismissed = true;
      if (!carrier.practice) usage.log(aiDecisionEvent(sugg, { carrier, page }, 'dismissed'));
    }
  }
  item.querySelector('.ai-slot')?.replaceChildren();
  for (const b of item.querySelectorAll('.opt-btn')) b.setAttribute('aria-pressed', String(b.dataset.choice === choice));
  // The question's other row too: a filled answer with a check shows as an answer and as a check.
  const label = x.label ?? field.label ?? '';
  const same = [...(item.closest?.('#report')?.querySelectorAll('.row[data-key]') ?? [])]
    .filter((r) => r.dataset.key === x.key && (r.dataset.need ?? `|${r.dataset.field ?? ''}`).endsWith(`|${label}`));
  for (const row of new Set([item, ...same])) {
    if (row.classList.contains('need')) { settleNeed(row, 'picked', null, choiceSaid(shown)); continue; }
    row.dataset.value = shown;
    row.classList.remove('changed');
    setRowHead(row, { icon: '✓', value: choiceSaid(shown), tag: { kind: 'you', text: 'You', title: 'Your answer, put in from the panel' } });
    row.querySelector('.change-slot')?.replaceChildren();
    const n = row.querySelector('.need-note');
    if (!n) continue;
    n.hidden = false;
    n.classList.remove('bad');
    n.replaceChildren('✓ Put in for you. No fill changes it now.');
  }
  // Questions the answer revealed are filled as after an edit on the page.
  scheduleAutoFill(page);
}

async function clearMarks() {
  if (!state.tab?.carrier) return;
  await runKit(state.tab.id, state.tab.carrier, () => globalThis.__raterKit.clear());
  const key = currentReportKey();
  dropReports((entry) => entry.key === key);
  renderSite();
}

// A developer's capture of the page as it is now, for writing rules and mock pages (docs/learning.md):
// its questions, choices, picks, messages and any open dropdown list, never typed text, client
// details redacted. Captures belong to a scenario and are numbered within it, so a series (an
// answer changed, then captured again) reads as before and after; `npm run captures` lists what
// changed between them. Downloaded only: nothing is uploaded. Alt+Shift+C takes one without
// leaving the page, e.g. with a dropdown open.
const captureCountsStore = inExtension
  ? { get: async () => (await chrome.storage.local.get('captureCounts')).captureCounts, set: (v) => chrome.storage.local.set({ captureCounts: v }) }
  : { get: async () => memory.captureCounts, set: async (v) => { memory.captureCounts = v; } };

// A scenario's next capture number, kept in the extension's settings (local storage, so a scenario
// continued after Chrome restarts carries on) and taken one at a time, also across panels in two
// windows (a Web Lock), so two quick captures never share a number.
async function nextCaptureNumber(scenario) {
  // Under its own storage key, not in the settings object other settings rewrite.
  const take = async () => {
    const counts = (await captureCountsStore.get()) ?? {};
    const n = (counts[scenario] ?? 0) + 1;
    await captureCountsStore.set({ ...counts, [scenario]: n });
    return n;
  };
  return globalThis.navigator?.locks ? navigator.locks.request('capture-counts', take) : take();
}

// Alt+Shift+C reaches the side panel of every window: only the one in the focused window captures.
// Popped out, the panel is the only copy and captures the tab it follows, wherever focus is.
async function captureFromShortcut() {
  if (!popped) {
    const [mine, focused] = await Promise.all([chrome.windows.getCurrent(), chrome.windows.getLastFocused()]).catch(() => [null, null]);
    if (mine && focused && mine.id !== focused.id) return;
  }
  capturePage();
}

// What a capture did, under its button in Settings (never over a fill report).
function captureSaid(text) {
  $('capture-status').hidden = false;
  $('capture-status').textContent = text;
}

async function capturePage() {
  if (!state.tab?.carrier) {
    captureSaid('Open a carrier page to capture its layout.');
    return;
  }
  // Client details are redacted with the loaded intake's names and numbers: without one, nothing
  // on the page or typed in the scenario and note would be.
  if (!state.intake?.record) {
    captureSaid('Load the intake first, so client details can be redacted.');
    return;
  }
  const { id: tabId, carrier } = state.tab;
  const record = state.intake?.record;
  const redact = redactor(redactionTerms(record));
  // Both are typed by the agent: a client's name or number in them is redacted like the page's.
  const scenario = redact($('capture-scenario').value.trim()).slice(0, 60) || 'unnamed';
  const typedNote = $('capture-note').value;
  const note = redact(typedNote.trim()).slice(0, 200) || null;
  // Which quote the scenario belongs to (its session's first characters, no client data): two
  // clients' scenarios redacted to the same name stay apart.
  const quote = String(usage.currentSession()?.id ?? '').slice(0, 8) || null;
  const page = pageOf(state.tab.url);
  const view = viewOf(tabId, page, carrier);
  // What the capture is of; checked again once the page has been read (as layout jobs are).
  const asked = JSON.stringify([tabId, page, state.active, state.intakeRevision, usage.currentSession()?.id ?? null]);
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [record ? buildPlan(record, carrier, state.active) : null, record ? redactionTerms(record) : []]);
    // Frames with questions, the top one, and any with messages or an open list (evidence only).
    const frames = results.map((r) => r.result).filter((f) => f && (f.controls.length || f.isTopFrame || f.messages?.length || f.openLists?.length));
    const top = frames.find((f) => f.isTopFrame);
    const now = JSON.stringify([state.tab?.id, pageOf(state.tab?.url), state.active, state.intakeRevision, usage.currentSession()?.id ?? null]);
    if (now !== asked || top?.page !== page) {
      captureSaid('The page changed during capture. Nothing saved; capture again.');
      return;
    }
    // Rater pages change with the state and product being quoted, so every capture records them.
    const context = record ? {
      state: record.garaging?.state ?? null,
      businessClass: record.operations?.businessClass ?? null,
      vehicleTypes: [...new Set(record.vehicles.map((v) => v.type).filter(Boolean))],
      hasTrailers: record.trailers.length > 0,
      coverages: Object.entries(record.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    } : null;
    const n = await nextCaptureNumber(`${quote ?? ''}|${scenario}`);
    const data = { tool: 'tni-rater-autofill', kind: 'page-capture', version: 2, carrier: carrier.id, capturedAt: new Date().toISOString(),
      // The step only for a one-address application (layoutSteps, AmWINS), as layouts do: other
      // carriers' headings change with the questions shown (a follow-up's own heading).
      scenario, quote, n, note, page: top?.page ?? page, step: (carrier.layoutSteps && top?.step) || null, view: view ?? null, context, frames };
    const slug = (s, max) => String(s ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, max) || 'page';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `capture-${carrier.id}-${slug(scenario, 30)}${quote ? `-${quote.slice(0, 4)}` : ''}-${String(n).padStart(3, '0')}-${slug(data.page, 30)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // Only the note this capture took: one being typed for the next step stays.
    if ($('capture-note').value === typedNote) $('capture-note').value = '';
    captureSaid(`Saved capture ${n} of "${scenario}" (${frames.reduce((k, f) => k + f.controls.length, 0)} fields${top?.openLists?.length ? ', an open list' : ''}) to Downloads. Client details are [client]. Move it to layouts/ and skim it before sharing.`);
  } catch (e) {
    captureSaid(`Couldn't capture this page: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Luna assistant: after a fill, suggests answers for the questions left for the agent.
// Verified choices can be applied automatically, but Continue waits for explicit agent review.

async function aiSettings() {
  return settingsFrom(await usage.settings());
}

// Luna reads the claims box once per intake (reviewNotes in src/ai/luna.js): lines that may name
// non-trucking liability, ask for a coverage change or say how long the business has run (when
// that differs from the intake) become Check intake items, and the tab
// count goes up (the panel doesn't switch steps under the agent). Flags only; the agent decides.
// Logged as counts, never the text. A review that failed says so on Check intake and is tried
// again when the assistant settings change (`retry`), not on every panel reload. What it read
// (the claims box and the form's coverages) must still be the intake's when Luna answers;
// otherwise the answer is dropped and the box read again.
// Luna's claims-box items for a text the agent has since edited become info notes, in place
// (warnings are marked checked by position).
// The claims box text changed: the intake's own NTL item follows it (updated, re-asked, or retired
// when NTL is no longer mentioned), and a checked long-box or failed-review item is asked again,
// since its check was for the old text. Items are kept by position (checked marks are).
function claimsTextEdited(intake) {
  const uncheck = (i) => { intake.done = intake.done.filter((d) => d !== i); };
  const mention = ntlMention(intakeNotes(intake.record));
  const i = intake.warnings.findIndex((w) => w.code === 'coverage.ntl');
  if (mention && i < 0) intake.warnings.push({ code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) });
  else if (mention && intake.warnings[i].msg !== ntlCheckMessage(mention)) {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) };
    uncheck(i);
  } else if (!mention && i >= 0 && intake.warnings[i].level === 'check') {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'info', msg: 'The claims box and Additional Notes no longer mention non-trucking liability (NTL).' };
  }
  intake.warnings.forEach((w, j) => { if (['ai.claims-truncated', 'ai.claims-review-failed'].includes(w.code)) uncheck(j); });
  save();
  render();
}

// The long-claims-box item is the code's own: it stays while the box is still too long to read whole.
function supersedeClaimsItems(intake) {
  const truncated = claimsTruncated(intakeNotes(intake.record));
  intake.warnings.forEach((w, i) => {
    if (['ai.ntl', 'ai.coverage-change', 'ai.years-in-business', 'ai.gl'].includes(w.code) ||(w.code === 'ai.claims-truncated' && !truncated)) {
      if (w.code === 'ai.ntl' && intake.record.claims) intake.record.claims.aiNtl = false;
      intake.warnings[i] = { code: 'ai.claims-superseded', path: w.path, level: 'info', msg: `Earlier Luna item, for a claims box or Additional Notes since edited: ${w.msg}` };
    }
  });
}

function claimsContext(record) {
  // NTL and GL (asked for or had) are not sent as form coverage (Luna's own questions): setting
  // them isn't a change.
  const { ntl, gl, hasGl, ...coverage } = record.coverage ?? {};
  // In key order (stableJson): otherwise every reopen took the saved intake for an edit, Luna's
  // claims-box items were retired, the box was sent again, and the intake saved over any change
  // made meanwhile.
  // The Additional Notes box only when the intake has it: an older saved intake keeps its context.
  return stableJson([record.claims?.text ?? null, coverage, ...(record.notes?.text ? [record.notes.text] : [])]);
}

async function reviewClaimsBox({ retry = false } = {}) {
  const intake = state.intake;
  // A finished review stands while what it read is unchanged (older records didn't keep that).
  // Once the agent has edited it, Luna's items for the old text are retired right away, whether or
  // not a new review can run now (assistant off, no key, a failure).
  if (intake?.notesReview?.done && intake.notesReview.context != null && intake.notesReview.context !== claimsContext(intake.record)) {
    supersedeClaimsItems(intake);
    intake.notesReview = null;
    await save();
    render();
  }
  if (!intakeNotes(intake?.record) || intake.notesReview?.done || (intake.notesReview?.failed && !retry)) return;
  // One at a time: a settings change during a review runs once it ends (a corrected key).
  if (state.notesAsking === intake) { if (retry) state.notesRetry = intake; return; }
  // Taken before the first await: two triggers close together ask once.
  state.notesAsking = intake;
  let again = false;
  try {
    const cfg = await aiSettings();
    if (!cfg.on || !cfg.apiKey || state.intake !== intake) return;
    const started = Date.now();
    const read = claimsContext(intake.record);
    const logged = { type: 'ai_suggest', page: 'ClaimsBox', model: cfg.model };
    const failed = intake.warnings.findIndex((w) => w.code === 'ai.claims-review-failed');
    try {
      const result = await reviewNotes(intake.record, cfg, { redact: redactor(redactionTerms(intake.record)) });
      // Nothing about a replaced intake is logged under the new one.
      if (state.intake !== intake) return;
      const changed = claimsContext(intake.record) !== read;
      usage.log({ ...logged, ms: Date.now() - started, items: result.lines, suggested: result.flagged, leave: result.lines - result.flagged,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls, reasoningTokens: result.reasoningTokens,
        cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens, ...(changed ? { error: 'Answer discarded: the claims box or coverages changed.' } : {}) });
      if (changed) { again = true; return; }
      // Warnings are marked checked by position: an earlier failure, or Luna's items from a claims
      // box the agent has since edited, are replaced in place, never removed.
      if (failed >= 0) intake.warnings[failed] = { code: 'ai.claims-reviewed', path: 'claims.text', level: 'info', msg: 'Luna reviewed the claims box and Additional Notes after an earlier failure.' };
      supersedeClaimsItems(intake);
      // One long-claims-box item, kept from an earlier review.
      const kept = intake.warnings.some((w) => w.code === 'ai.claims-truncated');
      intake.warnings.push(...result.warnings.filter((w) => !(kept && w.code === 'ai.claims-truncated')));
      // Luna's NTL flag holds Progressive's Rates until the agent answers it, like an NTL mention.
      if (result.warnings.some((w) => w.code === 'ai.ntl') && intake.record.claims) intake.record.claims.aiNtl = true;
      intake.notesReview = { done: true, model: cfg.model, flagged: result.warnings.length, context: read };
    } catch (e) {
      if (state.intake !== intake) return;
      const msg = e instanceof AssistError ? e.message : 'The claims-box review failed.';
      usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (failed < 0) intake.warnings.push({ code: 'ai.claims-review-failed', path: 'claims.text', level: 'check', msg: "Luna couldn't review the claims box and Additional Notes. Read them for coverage requests, e.g. NTL or a different limit." });
      intake.notesReview = { failed: true, model: cfg.model };
    }
    await save();
    render();
  } finally {
    if (state.notesAsking === intake) state.notesAsking = null;
    const queued = state.notesRetry === intake;
    if (queued) state.notesRetry = null;
    if ((again || queued) && state.intake === intake) reviewClaimsBox({ retry: true });
  }
}

// Driver gender is filled MALE (TNI standard) unless drivers[i].gender is set. Once per intake,
// with the assistant on, Luna is asked whether each such driver's first name is more often a
// woman's (reviewDriverNames in src/ai/luna.js: only the first names are sent, nothing else).
// likely_female becomes a Check intake item with Use Female / Keep Male (applyCheckChoice: the
// agent's edit). A failure is an info note: the TNI standard stands. What it read (the drivers'
// first names) must still be the intake's when Luna answers; an edit to a first name afterwards
// retires its items (info notes, in place) and reads the names again. Logged as counts only.
function driverNamesContext(record) {
  return JSON.stringify((record.drivers ?? []).map((d) => firstNameOf(d?.first)));
}

function supersedeGenderItems(intake) {
  intake.warnings.forEach((w, i) => {
    if (w.code === 'ai.driver-gender') intake.warnings[i] = { code: 'ai.driver-gender-superseded', path: w.path, level: 'info', msg: `Earlier Luna item, for a driver name since edited: ${w.msg}` };
  });
}

async function reviewDriverGender({ retry = false } = {}) {
  const intake = state.intake;
  if (intake?.namesReview?.done && intake.namesReview.context !== driverNamesContext(intake.record)) {
    supersedeGenderItems(intake);
    intake.namesReview = null;
    await save();
    render();
  }
  if (!intake?.record.drivers?.length || intake.namesReview?.done || (intake.namesReview?.failed && !retry)) return;
  if (state.namesAsking === intake) { if (retry) state.namesRetry = intake; return; }
  state.namesAsking = intake;
  let again = false;
  try {
    const cfg = await aiSettings();
    if (!cfg.on || !cfg.apiKey || state.intake !== intake) return;
    const started = Date.now();
    const read = driverNamesContext(intake.record);
    const logged = { type: 'ai_suggest', page: 'DriverNames', model: cfg.model };
    const failed = intake.warnings.findIndex((w) => w.code === 'ai.driver-names-failed');
    try {
      const result = await reviewDriverNames(intake.record, cfg);
      if (state.intake !== intake) return;
      const changed = driverNamesContext(intake.record) !== read;
      if (result.modelCalls) {
        usage.log({ ...logged, ms: Date.now() - started, items: result.names, suggested: result.flagged, leave: result.names - result.flagged,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls, reasoningTokens: result.reasoningTokens,
          cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens, ...(changed ? { error: 'Answer discarded: a driver name changed.' } : {}) });
      }
      if (changed) { again = true; return; }
      if (failed >= 0) intake.warnings[failed] = { code: 'ai.driver-names-reviewed', path: 'drivers', level: 'info', msg: 'Luna checked the drivers\' first names after an earlier failure.' };
      // A driver whose gender the agent set meanwhile keeps it: no item for them.
      intake.warnings.push(...result.warnings.filter((w) => !get(intake.record, w.path)));
      intake.namesReview = { done: true, model: cfg.model, flagged: result.flagged, context: read };
    } catch (e) {
      if (state.intake !== intake) return;
      const msg = e instanceof AssistError ? e.message : 'The driver-name check failed.';
      usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (failed < 0) intake.warnings.push({ code: 'ai.driver-names-failed', path: 'drivers', level: 'info', msg: "Luna couldn't check the drivers' first names. Gender is filled Male (TNI standard) unless you set it under All client details." });
      intake.namesReview = { failed: true, model: cfg.model };
    }
    await save();
    render();
  } finally {
    if (state.namesAsking === intake) state.namesAsking = null;
    const queued = state.namesRetry === intake;
    if (queued) state.namesRetry = null;
    if ((again || queued) && state.intake === intake) reviewDriverGender({ retry: true });
  }
}

// Luna's reviews of a loaded intake: the claims box, and drivers' first names.
function reviewIntake(opts) {
  reviewClaimsBox(opts);
  reviewDriverGender(opts);
}

// A check card's own buttons (Luna's GL and driver-gender items): set the field as the agent's
// edit, then mark the item checked. Only these fields and values: the item is stored data.
const CHOICE_FIELDS = [[/^coverage\.hasGl$/, [true]], [/^drivers\[\d+\]\.gender$/, ['FEMALE', 'MALE']]];
async function applyCheckChoice(i, choice) {
  const w = state.intake?.warnings[i];
  if (!w || !w.choices?.some((c) => c.label === choice.label && c.path === choice.path && c.value === choice.value)) return;
  if (choice.path !== undefined) {
    const allowed = choice.path === w.path && CHOICE_FIELDS.some(([re, values]) => re.test(choice.path) && values.includes(choice.value));
    if (!allowed) return;
    if (get(state.intake.record, choice.path) !== choice.value) {
      // Changed before anything awaits, like an edit in All client details.
      const editing = agentEdit(choice.path, choice.value, typeof choice.value === 'boolean' ? 'bool' : 'text');
      renderSections();
      await editing;
    }
  }
  // Logged as the edit (intake_edit, no value) and the check (warning_checked).
  await toggleDone(i, true);
}

// ctx: { tabId, page, carrier } of the fill these frames came from.
async function runAssist(frames, ctx) {
  const record = state.intake?.record;
  const active = { ...state.active };
  ctx = { ...ctx, intake: state.intake, tabUrl: state.tab?.url, contextKey: assistContextKey(record, active) };
  const cfg = await aiSettings();
  if (!cfg.on || !record || !aiActionCurrent(ctx, []) || ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return;
  const provider = PROVIDERS[cfg.provider];
  // Questions the agent (or an applied AI answer) already settled on this page are not asked again.
  const collected = collectItems(frames);
  const items = collected.items.filter(x => !agentEdited(ctx.page, x.key) && !aiSettledOnPage(ctx.tabId, ctx.page, x));
  const blocked = collected.blocked;
  // Messages, the approval card and suggestions without a list item go above "Needs you".
  const holder = h('div', { class: 'ai-holder' });
  const head = $('report').querySelector('.needs-head');
  if (!items.length) {
    // Nothing new to ask, but AI picks still waiting for approval keep their card.
    if (pendingAi(ctx.tabId, ctx.page).length) {
      if (head) head.before(holder); else $('report').append(holder);
      renderAi(holder, [], ctx);
    }
    return;
  }
  if (head) head.before(holder); else $('report').append(holder);
  if (!cfg.apiKey) {
    holder.append(h('p', { class: 'note-line' }, `${provider.name} needs an ${provider.keyLabel}. `,
      h('button', { type: 'button', class: 'link small', onclick: () => openSettings('ai-openai-key') }, 'Add the key')));
    return;
  }
  const run = ++state.aiRun;
  ctx.run = run;
  try {
    ctx.snapshots = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
  } catch { return; }
  // Why this request (or its answer) no longer fits what the panel shows; null while it does.
  const staleWhy = () => (run !== state.aiRun ? 'a newer request'
    : !aiActionCurrent(ctx, []) ? 'the tab or page changed'
    : ctx.contextKey !== assistContextKey(state.intake?.record, state.active) ? 'the intake or driver/vehicle changed'
    : !holder.isConnected ? 'the panel was redrawn' : null);
  const stale = () => !!staleWhy();
  // A dropped answer never leaves "Asking…" on screen (2026-10-05 FL run: Luna answered in 17 s,
  // the panel kept waiting for minutes).
  // Also in a report kept while another tab or step is in front: it says so when that one is back.
  const dropped = (what, next = 'Click Fill this page to ask again.') => {
    if (run !== state.aiRun) { holder.remove(); return; }
    holder.replaceChildren(h('p', { class: 'card bad small' }, `${provider.name}: ${what}. ${next}`));
  };
  // Reuse an answer for the same question (as the page shows it now) in the same intake and
  // driver/vehicle, model and policy. Not keyed on the rest of the page: every automatic
  // follow-up fill changes that, which asked the assistant again each time. Putting an answer in still
  // checks the page snapshot (applyAi), and approving checks it again.
  const contextHash = aiFingerprint(ctx.contextKey);
  const sigOf = x => aiCacheSignature({ tabId: ctx.tabId, page: ctx.page, model: cfg.model, policy: provider.policy, contextHash, itemHash: aiItemFingerprint(x), quoteHash: aiFingerprint(ctx.tabUrl) });
  const missing = items.filter((x) => !state.aiCache.has(sigOf(x)));
  if (missing.length) {
    holder.replaceChildren(h('p', { class: 'ai-wait' }, `Asking ${provider.name} about ${missing.length} question${missing.length === 1 ? '' : 's'} left for you…`));
    const started = Date.now();
    const context = { record, carrier: ctx.carrier.id, page: ctx.page, active };
    const logged = { type: 'ai_suggest', carrier: ctx.carrier.id, page: ctx.page, model: cfg.model, items: missing.length, blocked: blocked.length };
    try {
      const result = await suggest(missing, context, cfg, { isStale: stale });
      const fresh = result.suggestions;
      // An answer that came too late is still logged (its tokens were spent), with the reason.
      const why = staleWhy();
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, suggested: fresh.filter(x => !x.leave).length,
        leave: fresh.filter(x => x.leave).length, autoOk: fresh.filter(x => x.autoOk).length,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls,
        reasoningTokens: result.reasoningTokens, cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens,
        ...(why ? { error: `Answer discarded: ${why}.` } : {}) });
      if (why) { dropped(`it answered after ${why}, so nothing was applied`); return; }
      fresh.forEach(x => state.aiCache.set(sigOf(x), {
        ...x, policy: provider.policy, contextKey: ctx.contextKey, contextHash, itemHash: aiItemFingerprint(x), quoteHash: aiFingerprint(ctx.tabUrl),
      }));
    } catch (e) {
      const msg = e instanceof AssistError ? e.message : 'The assistant could not review this page. Nothing was applied.';
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, error: redactor(redactionTerms(record))(msg).slice(0, 200) });
      if (!stale()) holder.replaceChildren(h('p', { class: 'card bad small' }, `AI assistant: ${msg}`));
      else dropped(`${staleWhy()} while it was answering, so nothing was applied`);
      return;
    }
  }
  const suggestions = items.map((x) => state.aiCache.get(sigOf(x))).filter(Boolean);
  if (stale()) { dropped(`${staleWhy()} before its answers were shown, so nothing was applied`); return; }
  let applied = false;
  if (cfg.auto) {
    const picks = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
    // Anything sent to the page counts, also an answer that couldn't be confirmed.
    if (picks.length) { await applyAi(picks, ctx, 'auto'); applied = picks.some((x) => x.done); }
  }
  if (!stale()) renderAi(holder, suggestions, ctx);
  else if (applied) dropped(`${staleWhy()} after its selections were put in`, 'Click Fill this page to review them before continuing.');
  else dropped(`${staleWhy()} before its answers were shown, so nothing was applied`);
  syncAiBanner(ctx);
}

// AI selections on this tab's page that the agent hasn't approved or rejected yet. While there
// are any, the page's Continue is never clicked automatically. Picks made before the agent
// changed the intake or the driver/vehicle are included: they're still on the page, unapproved,
// so they keep blocking until the agent approves or rejects them (the card always offers both).
function pendingAi(tabId, page) {
  const out = [];
  for (const [sig, x] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(tabId) && p === page && aiDecisionBlocks(x)
      && (!x.quoteHash || x.quoteHash === aiFingerprint(state.tab?.url))) out.push(x);
  }
  return out;
}

// A new fill clears the page's marks: put the purple back on the AI's answers on this page.
async function remarkAi(ctx) {
  const answered = [];
  const contextHash = aiFingerprint(assistContextKey(state.intake?.record, state.active));
  for (const [sig, x] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(ctx.tabId) && p === ctx.page && x.done && !x.rejected
      && (x.contextKey === assistContextKey(state.intake?.record, state.active) || x.contextHash === contextHash)) answered.push(x);
  }
  if (!answered.length) return;
  try {
    await runKit(ctx.tabId, ctx.carrier, (list) => list.forEach(([k, l, n]) => globalThis.__raterKit.markKey(k, l, 'ai', n)),
      [answered.map((x) => [x.key, x.label, x.done === 'auto' && !x.approved ? 'selected by the AI: approve it in the side panel' : 'AI answer'])]);
  } catch { /* page navigating */ }
  await syncAiBanner(ctx);
}

// The note at the bottom of the rater page listing the selections waiting for approval.
async function syncAiBanner(ctx) {
  if (state.tab?.id !== ctx.tabId) return;
  const lines = pendingAi(ctx.tabId, ctx.page).map((x) => `${x.label}: ${x.choice}`);
  try { await runKit(ctx.tabId, ctx.carrier, (l) => globalThis.__raterKit.aiBanner(l), [lines]); } catch { /* page navigating */ }
}

// Puts AI answers into the page through the fill engine, which checks the page kept each one.
// decision: 'accepted' (the agent clicked Accept) or 'auto' (the auto-select setting).
async function applyAi(list, ctx, decision) {
  if (state.filling || state.closing) return false;
  if (state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page) return false;
  if (ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return false;
  if (ctx.run !== undefined && ctx.run !== state.aiRun) return false;
  list = list.filter(x => ['radio', 'select', 'checkbox'].includes(x.controlKind) && !x.leave && !agentEdited(ctx.page, x.key) && (decision !== 'auto' || x.autoOk));
  if (!list.length || !aiActionCurrent(ctx, list)) return false;
  const isCurrent = () => aiActionCurrent(ctx, list)
    && ctx.contextKey === assistContextKey(state.intake?.record, state.active)
    && (ctx.run === undefined || ctx.run === state.aiRun);
  const entries = [...state.aiCache].filter(([, x]) => list.includes(x));
  const editOrigin = { scope: usage.currentSession()?.intakeId, tabId: ctx.tabId,
    page: editScope(ctx.page, ctx.carrier), keys: state.agentKeys, epoch: state.agentKeysEpochs?.get(usage.currentSession()?.intakeId) ?? 0 };
  let dispatched = false, prepared = false, guarding = false;
  const guardToken = crypto.randomUUID();
  state.filling = true;
  await tellRecorder('pause', ctx.tabId);
  try {
    if (!isCurrent()) return false;
    // Watch every frame before the snapshot and pending-hold writes. An idle frame stays
    // guarded while another waits on its server, until the full apply finishes.
    guarding = true;
    await runKit(ctx.tabId, ctx.carrier, (t) => globalThis.__raterKit.answerEdits('begin', t), [guardToken]);
    if (!isCurrent()) return false;
    const current = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
    if (!isCurrent()) return false;
    if (!snapshotsEqual(current, ctx.snapshots)) {
      for (const x of list) x.error = 'the page changed; click Fill this page for fresh suggestions';
      return false;
    }
    list = list.filter(x => {
      if (aiSnapshotFieldMatches(current, x).length === 1) return true;
      x.error = 'the question is ambiguous across page frames; answer it on the page';
      return false;
    });
    if (!list.length) return false;
    const answers = list.map((x) => ({
      key: x.key, label: x.label, value: x.choice,
      expected: { kind: x.controlKind, section: x.section, options: x.options, current: x.current },
      note: `${decision === 'auto' ? 'selected by the AI' : 'AI suggestion you accepted'}: ${x.tip}`.slice(0, 240),
    }));
    // Persist a conservative hold before dispatch. The carrier can change a field before answer()
    // returns, so replacing the intake or clearing a cache must never erase that operation.
    prepared = true;
    for (const x of list) {
      const [{ frame }] = aiSnapshotFieldMatches(current, x);
      x.pendingScope = usage.currentSession()?.intakeId ?? `pending:${aiFingerprint(ctx.contextKey)}`;
      x.pendingLabel = aiSafeText(x.label);
      x.pendingChoice = aiSafeText(x.choice);
      x.quoteHash = aiFingerprint(ctx.tabUrl);
      x.origin = aiAnswerOrigin(current, x, { ...frame, shown: x.choice });
      x.originAmbiguous = !x.origin;
      x.fieldHash = x.origin?.fieldHash ?? null;
      x.snapshots = current;
      x.snapshotHash = snapshotFingerprint(current);
      x.done = 'auto';
    }
    await persistAiPending();
    if (!isCurrent()) return false;
    // One answer at a time lets an edit in any frame stop every answer still to come,
    // including later answers in the active frame.
    const results = [];
    const readEdits = async (command = 'read') => {
      const frames = await runKit(ctx.tabId, ctx.carrier, (c, t) => globalThis.__raterKit.answerEdits(c, t), [command, guardToken]);
      for (const frame of frames) for (const item of frame.result ?? []) {
        if (item?.protected) results.push({ ...item, frameId: frame.frameId, documentId: frame.documentId });
      }
      if (current.some(origin => !frames.some(frame => frame.frameId === origin.frameId
        && frame.documentId === origin.documentId && Array.isArray(frame.result)))) {
        return 'the page or frame changed while applying the answers; request fresh suggestions';
      }
      return results.some(r => r.protected)
        ? 'an agent edit interrupted applying the answers; review the page, then request fresh suggestions' : null;
    };
    const startedFrames = new Set();
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      const interruption = await readEdits();
      if (interruption || !isCurrent()) {
        results.push({ key: a.key, label: a.label, ok: false, reason: interruption
          ?? 'the intake or page context changed; request fresh suggestions' });
        continue;
      }
      const frameId = aiSnapshotFieldMatches(current, list[i])[0].frame.frameId;
      const expected = startedFrames.has(frameId) ? null : ctx.snapshots.map(r => r.result);
      startedFrames.add(frameId);
      dispatched = true;
      // The carrier's stop steps go along: after a reload no fill has told this document about them.
      const answerFrames = await runKit(ctx.tabId, ctx.carrier, (a, snapshots, t, o) => globalThis.__raterKit.answer(a, snapshots, t, o),
        [[a], expected, guardToken, { stopSteps: Object.keys(ctx.carrier.stopSteps ?? {}) }], [frameId]);
      for (const frame of answerFrames) for (const item of frame.result ?? []) {
        if (item && typeof item === 'object') results.push({ ...item, frameId: frame.frameId, documentId: frame.documentId });
      }
    }
    await readEdits('end');
    guarding = false;
    const sameContext = isCurrent();
    const keys = sameContext ? state.agentKeys.get(editOrigin.page) ?? new Set() : null;
    // The agent's own edits while the answers went in (also on a control the carrier redrew, which
    // the recorder cannot match on resume): a later fill keeps them, as after a fill.
    const protectedKeys = results.filter(r => r.protected).map(r => r.key);
    for (const x of list) {
      const mine = results.filter((r) => r.key === x.key && r.label === x.label);
      const ok = !protectedKeys.includes(x.key) && mine.find((r) => r.ok);
      const problem = mine.find((r) => !r.ok && !/no longer on this page/.test(r.reason ?? '')) ?? mine[0];
      if (ok) {
        x.origin = aiOriginRecord({ frameId: ok.frameId, documentId: ok.documentId,
          questionHash: aiQuestionHash(x), fieldHash: aiLiveFieldHash({ ...x, current: ok.shown }) });
        x.originAmbiguous = !x.origin;
        x.fieldHash = x.origin?.fieldHash ?? null;
        x.done = sameContext ? decision : 'auto';
        x.error = null;
        if (sameContext) {
          keys.add(x.key);
          x.editScope = editScope(ctx.page);
          state.filled.set(x.key, { path: null, shown: ok.shown });
        }
      } else {
        x.done = null;
        x.error = problem?.reason ?? 'the question is no longer on this page';
      }
      if (sameContext && !ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, ok ? decision : 'failed'));
    }
    if (sameContext) state.agentKeys.set(editOrigin.page, keys);
    await persistGuardedEdits(editOrigin, protectedKeys);
    // Read the original carrier tab even if the panel has since switched to another intake/tab.
    const after = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
    for (const x of list) if (x.done) {
      x.snapshots = after;
      x.snapshotHash = snapshotFingerprint(after);
    }
    if (sameContext) ctx.snapshots = after;
    return true;
  } catch (e) {
    // A transport failure after dispatch does not prove that no carrier field changed.
    for (const x of list) x.error = dispatched
      ? 'the answer was sent but could not be confirmed; review the page before continuing'
      : `couldn't reach the page (${String(e?.message ?? e).slice(0, 80)})`;
    return false;
  } finally {
    if (guarding) {
      try {
        const frames = await runKit(ctx.tabId, ctx.carrier, (t) => globalThis.__raterKit.answerEdits('end', t), [guardToken]);
        // Even a failed answer transport must preserve edits the still-live guards caught.
        const edited = frames.flatMap(frame => frame.result ?? []).filter(item => item?.protected);
        await persistGuardedEdits(editOrigin, edited.map(item => item.key));
      } catch { /* a removed or navigating frame no longer has live listeners */ }
    }
    if (prepared && !dispatched) for (const x of list) x.done = null;
    if (dispatched) for (const [sig, x] of entries) if (list.includes(x) && x.done === 'auto') {
      if (!aiActionCurrent(ctx, list)) {
        x.rejected = true;
        x.label = x.pendingLabel;
        x.choice = x.pendingChoice;
        x.contextKey = null;
        x.autoOk = false;
        x.tip = ''; x.checks = [];
      }
      state.aiCache.set(sig, x);
      aiRetiredSignatures.delete(sig);
    }
    await tellRecorder('resume', ctx.tabId);
    state.filling = false;
    // The recorder was paused while Luna's picks went in, so it won't report the questions they
    // revealed or hid: ask for the page's layout, if that tab is still the one followed (a job
    // is built from the followed tab, and checks the page).
    if (dispatched && state.tab?.id === ctx.tabId) scheduleLayout(ctx.page, 'changed');
    if (prepared) await persistAiPending();
    if (isCurrent() && state.autoPending) scheduleAutoFill(ctx.page);
  }
}

function aiDecisionEvent(x, ctx, decision) {
  const redact = redactor(redactionTerms(state.intake.record));
  return {
    type: 'ai_decision', carrier: ctx.carrier.id, page: ctx.page, q: x.q ?? null, label: redact(x.label), controlKind: x.controlKind,
    decision, choice: x.controlKind !== 'text' && x.choice ? redact(x.choice) : undefined,
    model: x.model, policy: x.policy, basis: x.basis, intakePath: x.intakePath, reason: x.error ? redact(x.error) : undefined,
  };
}

// Each suggestion goes on its question's row (AI suggests …, Use this answer / No thanks; its pick
// marked among the row's own choices), and each pick the AI put in itself says so there, purple,
// with Approve and Reject; the dock approves them all. Above the list: Use all, and any suggestion
// whose question has no row.
function renderAi(holder, suggestions, ctx) {
  const rerender = () => { if (holder.isConnected) renderAi(holder, suggestions, ctx); };
  const act = async (list, decision, button) => {
    if (state.filling) { announce('Wait for the fill to finish, then try again.'); return; }
    if (button) { button.disabled = true; button.textContent = 'Putting it in…'; }
    await applyAi(list, ctx, decision);
    rerender();
  };
  const sure = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
  // Every pick on this page still waiting for approval, also from before an intake or
  // driver/vehicle change (those are labelled), so each one can always be approved or rejected.
  const pending = pendingAi(ctx.tabId, ctx.page);
  const awaiting = pending.filter((x) => !x.rejected);
  const rejectedPending = pending.filter((x) => x.rejected);
  const current = assistContextKey(state.intake?.record, state.active);
  const currentHash = aiFingerprint(current);
  const canContinue = $('auto-advance').checked && !!ctx.carrier.advance;
  // Approving or rejecting acts on a cached pick in this intake and page. A driver/vehicle
  // switch can keep that pick pending; replacing the intake or page invalidates the callback.
  const decide = async (list, decision) => {
    if (state.filling || !aiActionCurrent(ctx, list)) return;
    if (decision === 'approved') {
      // Approve only what the page still shows as the AI left it; a pick whose page changed since
      // is rejected so the agent reviews it after a fresh fill.
      let now;
      try { now = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot()); }
      catch {
        if (!aiActionCurrent(ctx, list)) return;
        for (const x of list) x.error = 'the page is unavailable; return to it and run Fill again';
        rerender();
        return;
      }
      if (!aiActionCurrent(ctx, list)) return;
      const moved = list.filter((x) => !aiCurrentAnswerPresent(now, x) || (x.snapshotHash
        ? !snapshotHashMatches(now, x.snapshotHash)
        : !snapshotsEqual(now, x.snapshots ?? ctx.snapshots)));
      if (moved.length) {
        for (const x of moved) {
          x.rejected = true;
          x.error = 'the page changed after this choice; run Fill again and review it';
          state.agentKeys.get(x.editScope ?? editScope(ctx.page))?.delete(x.key);
        }
        list = list.filter((x) => !moved.includes(x));
        if (!list.length) {
          await persistAiPending();
          await syncAiBanner(ctx);
          rerender();
          return;
        }
      }
    }
    for (const x of list) {
      if (decision === 'approved') x.approved = true; else x.rejected = true;
      if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, decision));
    }
    if (decision === 'rejected') {
      for (const x of list) {
        try { await runKit(ctx.tabId, ctx.carrier, (k, l, n) => globalThis.__raterKit.markKey(k, l, 'needs', n), [x.key, x.label, 'AI choice rejected: set this answer yourself']); } catch { /* page navigating */ }
      }
    }
    await persistAiPending();
    await syncAiBanner(ctx);
    rerender();
    // Approved and nothing else left: the normal fill clicks Continue (when that setting is on).
    if (decision === 'approved' && canContinue && !pendingAi(ctx.tabId, ctx.page).length
      && aiActionCurrent(ctx, list)) fillPage();
  };
  // Rejecting leaves Continue blocked until the agent either changes that field on the page
  // (the recorder marks it manual) or explicitly confirms the current carrier value here. This
  // confirmation is intentional and does not infer consent from unrelated page changes.
  const confirmRejected = async (list) => {
    if (state.filling || !aiActionCurrent(ctx, list)) return;
    for (const x of list) {
      let present = false;
      try {
        const result = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
        present = aiCurrentAnswerPresent(result, x);
      } catch { /* page navigating */ }
      if (!aiActionCurrent(ctx, list)) return;
      if (present) {
        x.confirmed = true;
        if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, 'rejected_confirmed'));
      } else {
        x.confirmError = 'The page answer changed; review it.';
      }
    }
    await persistAiPending();
    await syncAiBanner(ctx);
    rerender();
    if (canContinue && !pendingAi(ctx.tabId, ctx.page).length
      && aiActionCurrent(ctx, list)) fillPage();
  };
  const why = (x) => [
    x.evidenceSources?.length ? `cited evidence: ${x.evidenceSources.map(source => source.basis === 'intake' ? source.path : 'TNI rule').join(', ')}` : null,
    'Evidence checked · needs your review',
  ].filter(Boolean).join(' · ');
  const answer = (x) => (x.controlKind === 'text' ? `typing “${x.choice}”` : `“${x.choice}”`);
  // Said of a pick waiting for approval that came from before a change, or a retired assistant.
  const notes = (x) => [x.retired ? 'From a retired assistant: review the page answer.' : null,
    (x.contextKey ? x.contextKey !== current : x.contextHash !== currentHash) ? 'Picked before the intake or unit changed.' : null].filter(Boolean);
  // What goes on a row: the suggestion and its buttons, or what happened to it.
  const box = (x) => {
    // The agent's own answer is protected: no fill or AI answer replaces it (agentKeys).
    if (x.manual) return h('div', { class: 'ai-done mine' }, h('b', {}, '✓'), h('span', { class: 'grow' }, 'You changed this answer on the page.'), h('span', { class: 'note' }, 'Won’t be refilled'));
    if (x.rejected) {
      return h('div', { class: 'ai-done bad' }, h('span', { class: 'grow' }, x.confirmError ?? (x.retired ? 'From a retired assistant: review the page answer.' : 'AI answer rejected: answer it on the page.')),
        rejectedPending.includes(x) ? h('button', { type: 'button', class: 'link small ai-reject', onclick: () => confirmRejected([x]) }, 'Confirm the current page answer') : null);
    }
    if (x.error) return h('div', { class: 'ai-done bad' }, `The page didn't take the AI answer (${x.error}). Answer it on the page.`);
    if (x.done === 'auto' && !x.approved) {
      return h('div', { class: 'ai-box' },
        h('div', { class: 'ai-says' }, 'Picked by the AI: ', h('b', {}, x.choice)),
        x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
        ...notes(x).map((n) => h('div', { class: 'ai-tip' }, n)),
        h('div', { class: 'ai-why' }, 'Purple on the page. Continue waits until you approve or reject it.'),
        h('div', { class: 'ai-actions' },
          h('button', { type: 'button', class: 'primary accept', onclick: () => decide([x], 'approved') }, 'Approve'),
          h('button', { type: 'button', class: 'link ai-reject', onclick: () => decide([x], 'rejected') }, 'Reject')));
    }
    if (x.done) return h('div', { class: 'ai-done' }, h('b', {}, '✓'), h('span', { class: 'grow' }, `Put in ${answer(x)} (purple on the page).`));
    if (x.dismissed) return null;
    if (x.leave || !x.applyable) {
      return h('div', { class: 'ai-box' }, h('div', { class: 'ai-says' }, x.leave ? 'AI: this one is yours to decide.' : 'AI tip'), x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null);
    }
    return h('div', { class: 'ai-box' },
      h('div', { class: 'ai-says' }, 'AI suggests ', h('b', {}, x.controlKind === 'text' ? `typing “${x.choice}”` : x.choice)),
      x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
      h('div', { class: 'ai-why' }, why(x)),
      ...x.checks.map((c) => h('div', { class: 'ai-check' }, `Checked by the extension: ${c}`)),
      h('div', { class: 'ai-actions' },
        h('button', { type: 'button', class: 'primary accept', onclick: (e) => act([x], 'accepted', e.target) }, 'Use this answer'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { x.dismissed = true; if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, 'dismissed')); rerender(); } }, 'No thanks')));
  };
  const rows = [...$('report').querySelectorAll('.row.need')];
  const orphans = [];
  for (const x of new Set([...suggestions, ...pending])) {
    const item = rows.find((n) => n.dataset.need === `${x.key}|${x.label}`);
    const content = box(x);
    if (!item) {
      if (content) orphans.push(h('div', { class: 'ai-orphan' }, h('b', {}, x.label), content));
      continue;
    }
    item.aiSuggestion = x;
    item.querySelector('.ai-slot').replaceChildren(...(content ? [content] : []));
    // The AI's choice among the row's own: picking it there is accepting it (applyAi).
    const offered = !x.done && !x.dismissed && !x.leave && x.applyable && x.controlKind !== 'text' ? x.choice : null;
    item.aiAccept = offered ? () => act([x], 'accepted') : null;
    if (offered) item.dataset.aiPick = offered; else delete item.dataset.aiPick;
    for (const b of item.querySelectorAll('.opt-btn')) {
      const pick = b.dataset.choice === offered;
      b.classList.toggle('ai-pick', pick);
      b.querySelector('.ai-badge')?.remove();
      if (pick) b.append(h('span', { class: 'ai-badge' }, 'AI pick'));
    }
    for (const o of item.querySelectorAll('.opt-select option')) if (o.value) o.textContent = `${choiceSaid(o.value)}${o.value === offered ? ' (AI pick)' : ''}`;
    // The row says only what the agent settled (answered on the page or here, marked done), else
    // the AI's word: an answer the agent accepted or approved settles it; one waiting for approval
    // (or rejected, or not taken by the page) is still theirs.
    if (['answered', 'marked', 'picked'].includes(item.dataset.settled)) continue;
    item.querySelector('.need-note').hidden = true;
    const settled = !!x.manual || (!!x.done && !x.rejected && !x.error && (x.done !== 'auto' || !!x.approved));
    const waiting = !settled && x.done === 'auto' && !x.rejected && !x.error;
    item.classList.toggle('resolved', settled);
    item.classList.toggle('pending', waiting);
    if (settled) item.dataset.settled = 'ai'; else delete item.dataset.settled;
    setRowHead(item, settled
      ? { icon: '✓', value: x.manual ? 'Your answer on the page' : x.choice, tag: x.manual ? { kind: 'you', text: 'You' }
        : { kind: 'ai', text: x.done === 'auto' ? 'AI · approved' : 'AI · you chose', title: 'AI suggestion, chosen by you' } }
      : waiting ? { icon: '?', value: x.choice, tag: { kind: 'ai', text: 'AI picked · approve', title: 'Picked by the AI: approve or reject it' } }
        : { icon: item.dataset.icon, value: item.dataset.wait });
  }
  holder.replaceChildren(...[
    sure.length > 1 ? h('div', { class: 'ai-actions' }, h('button', { type: 'button', class: 'ghost', onclick: (e) => act(sure, 'accepted', e.target) }, `Use all ${sure.length} AI answers`)) : null,
    ...orphans,
  ].filter(Boolean));
  // The dock's Approve (dockFor): every pick waiting on this page, or the rejected ones confirmed.
  if (pending.length) state.aiDocks.set(`${ctx.tabId}|${ctx.page}`, { canContinue, go: () => (awaiting.length ? decide(awaiting, 'approved') : confirmRejected(rejectedPending)) });
  else state.aiDocks.delete(`${ctx.tabId}|${ctx.page}`);
  recount();
  renderSteps();
}

function wireAi() {
  const save = async patch => {
    state.aiRun++;
    if (Object.hasOwn(patch, 'lunaKey')) {
      for (const [key, value] of state.aiCache) if (!value.done) state.aiCache.delete(key);
    }
    // Keep pending approvals; their cache keys remain bound to the original model and context.
    await usage.saveSettings(patch);
    logSettings('changed', Object.keys(patch).map((k) => ({ aiOn: 'aiOn', lunaAuto: 'aiAuto', lunaKey: 'aiKey' })[k] ?? k).join(','));
    await renderAiSettings();
    // Luna just turned on or got a key: read the open intake's claims box and driver names if not done yet.
    reviewIntake({ retry: true });
  };
  $('ai-on').addEventListener('change', (e) => save({ aiOn: e.target.checked }));
  $('ai-auto').addEventListener('change', (e) => save({ lunaAuto: e.target.checked }));
  // The key is saved with Save (or Enter), never while it is typed.
  const saveKey = async () => {
    await save({ lunaKey: $('ai-openai-key').value.trim() });
    $('ai-openai-key').value = '';
    await openKeyForm(false);
    $('key-edit').focus();
  };
  $('key-edit').addEventListener('click', () => openKeyForm($('key-form').hidden));
  $('key-save').addEventListener('click', saveKey);
  $('ai-openai-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('ai-openai-key').value = ''; openKeyForm(false).then(() => $('key-edit').focus()); }
  });
}

async function renderAiSettings() {
  const cfg = await aiSettings();
  const provider = PROVIDERS[cfg.provider];
  $('ai-on').checked = cfg.on;
  $('ai-auto').checked = cfg.auto;
  $('ai-auto').disabled = !cfg.on || !provider.automatic;
  $('ai-auto-option').hidden = !provider.automatic;
  $('agent-name').textContent = provider.name;
  $('key-status').textContent = cfg.apiKey ? 'Saved on this computer' : 'Not added yet';
  $('key-status').className = cfg.apiKey ? 'ok' : 'warn';
  if ($('key-form').hidden) $('key-edit').textContent = cfg.apiKey ? 'Change' : 'Add key';
  // On without a key: it can't help yet, said on its card and with a dot on the brain button.
  $('agent-card').classList.toggle('warn', cfg.on && !cfg.apiKey);
  $('agent-btn').dataset.on = String(cfg.on);
  $('agent-dot').hidden = !(cfg.on && !cfg.apiKey);
  $('agent-btn').title = !cfg.on ? 'Assistant off'
    : cfg.apiKey ? `${provider.name} assistant on · ${cfg.model}` : `Assistant needs an ${provider.keyLabel}`;
  $('ai-note').textContent = !cfg.on ? 'Off. Questions are left for you.' : !cfg.apiKey ? 'On, but it needs a key to work.'
    : cfg.auto ? 'On. Picks answers; you approve them.' : 'On. Suggests answers; you choose.';
  $('ai-note').className = !cfg.on ? 'off' : !cfg.apiKey ? 'warn' : 'on';
  $('ai-privacy').textContent = `Sent to ${provider.company} with your key: the questions left for you, TNI's rules, and the intake with client names, birth dates, address, contact and ID numbers replaced by [client]. Written differently in the claims box or notes, they may still go. Business, coverage, vehicle, driver and prior-insurance details are sent. Missing facts stay unanswered. Report orders, exclusions, signatures and payment stay with you. Key saved on this device.`;
  renderUsage();
}

// ---------------------------------------------------------------------------------------------
// Usage log panel and problem reports

async function renderUsage() {
  const n = await usage.count();
  const { agent = '', serverToken = '' } = await usage.settings();
  const { serverUrl } = await usage.serverConfig();
  $('usage-count').textContent = (n
    ? `${n.toLocaleString()} event${n === 1 ? '' : 's'} waiting on this computer.`
    : 'Nothing waiting on this computer.')
    + (state.layoutErrors ? ` ${state.layoutErrors} page layout${state.layoutErrors === 1 ? '' : 's'} couldn't be read (logged).` : '');
  const up = usage.lastUpload();
  const when = up.at ? new Date(up.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  $('upload-status').textContent = {
    ok: `Uploaded to the server at ${when}.`,
    error: `Upload failed at ${when}: ${up.message}. Saved here and retried every minute.`,
    off: 'No server set. Use Export log to hand it in.',
    idle: serverUrl ? `Uploads to ${serverUrl} every minute.` : '',
  }[up.state] ?? '';
  $('upload-status').className = `status-line${up.state === 'ok' ? ' ok' : up.state === 'error' || up.state === 'off' ? ' warn' : ''}`;
  for (const [id, v] of [['agent', agent], ['server-url', serverUrl], ['server-token', serverToken]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  $('recording').hidden = !state.intake || !!state.tab?.carrier?.practice;
  renderHealth({ n, agent, serverUrl, up });
}

// The version this browser is running, and setup problems that otherwise go unnoticed until a
// review shows missing data: no initials, no AI key, no usage server (said in Settings, with a dot
// on its button), and a usage log that can't be saved (said on the main screen: nothing is recorded).
async function renderHealth({ up }) {
  const version = inExtension ? chrome.runtime.getManifest().version : 'dev';
  $('version').textContent = `Version ${version}`;
  $('foot-version').textContent = `v${version}`;
  const { agent = '' } = await usage.settings();
  const ai = await aiSettings();
  const setup = [
    !agent && 'add your initials',
    ai.on && !ai.apiKey && `add the ${PROVIDERS[ai.provider].keyLabel}`,
    up.state === 'off' && 'set the usage server (Advanced)',
  ].filter(Boolean);
  $('setup-note').hidden = !setup.length;
  $('setup-text').textContent = `To finish setting up, ${joinAnd(setup)}. Filling still works without ${setup.length === 1 ? 'it' : 'them'}.`;
  $('settings-dot').hidden = !setup.length;
  $('agent').classList.toggle('missing', !agent);
  // Events that can't even be saved here are lost: that is said where the agent works.
  const saved = usage.lastSave();
  $('notices').replaceChildren(...(saved.state === 'error' ? [issueCard({ tone: 'warn', role: 'alert', title: "Usage log can't be saved on this computer",
    text: `Nothing is recorded now (${saved.message}). Export the log (Settings, Advanced) and tell TNI.` })] : []));
}

// "a", "a and b", "a, b and c".
function joinAnd(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '';
}

async function uploadNow() {
  await usage.upload();
  renderUsage();
}

function wireUsage() {
  $('auto-followups').addEventListener('change', async (e) => { await usage.saveSettings({ autoFollowUps: e.target.checked }); logSettings('changed', 'autoFollowUps'); });
  $('auto-pages').addEventListener('change', async (e) => { await usage.saveSettings({ autoPages: e.target.checked }); logSettings('changed', 'autoPages'); });
  $('auto-advance').addEventListener('change', async (e) => { const saving = usage.saveSettings({ autoAdvance: e.target.checked }); renderSite(); await saving; logSettings('changed', 'autoAdvance'); });
  $('overwrite').addEventListener('change', () => logSettings('changed', 'overwrite'));
  // Saved with the other switches but never logged (fillContext's settings are the four the
  // usage server knows). The dock follows it (Looks right, continue).
  $('check-continue').addEventListener('change', (e) => { usage.saveSettings({ checkBeforeContinue: e.target.checked }); renderSteps(); });
  $('server-url').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    // Blank means "no server" (export only); anything else must be an http(s) URL.
    if (v && !/^https?:\/\/[^\s]+$/i.test(v)) { $('usage-note').textContent = 'Server must look like http://host:port'; return; }
    await usage.saveSettings({ serverUrl: v });
    uploadNow();
  });
  $('server-token').addEventListener('change', async (e) => { await usage.saveSettings({ serverToken: e.target.value.trim() }); uploadNow(); });
  $('upload-usage').addEventListener('click', uploadNow);
  setInterval(uploadNow, 60_000);
  $('agent').addEventListener('change', async (e) => {
    await usage.saveSettings({ agent: e.target.value.trim().toUpperCase().slice(0, 6) || null });
    renderUsage();
  });
  $('export-usage').addEventListener('click', async () => {
    const n = await usage.exportLog();
    $('usage-note').textContent = `Exported ${n} events to your Downloads.`;
    renderUsage();
  });
  $('clear-usage').addEventListener('click', async () => {
    const { lastExportCount = 0 } = await usage.settings();
    const n = await usage.count();
    const msg = n > lastExportCount
      ? `${n} events aren't uploaded or exported. Delete them anyway?`
      : `Delete the ${n} exported events from this computer?`;
    if (!confirm(msg)) return;
    await usage.clearLog();
    $('usage-note').textContent = 'Usage log cleared.';
    renderUsage();
  });
  // Report a problem opens its box above the footer, and says so (aria-expanded).
  const problemOpen = (open) => { $('problem-form').hidden = !open; $('report-problem').setAttribute('aria-expanded', String(open)); };
  $('report-problem').addEventListener('click', () => {
    problemOpen($('problem-form').hidden);
    if (!$('problem-form').hidden) $('problem-text').focus();
  });
  $('cancel-problem').addEventListener('click', () => { $('problem-text').value = ''; problemOpen(false); $('report-problem').focus(); });
  $('send-problem').addEventListener('click', () => {
    const text = $('problem-text').value.trim();
    if (!text) return;
    const redact = state.intake ? redactor(redactionTerms(state.intake.record)) : (x) => x;
    const page = state.tab?.url ? pageOf(state.tab.url) : null;
    usage.log({ type: 'problem_report', carrier: state.tab?.carrier?.id ?? null, page, text: redact(text).slice(0, 1000), ...problemContext(state.tab, page) });
    $('problem-text').value = '';
    problemOpen(false);
    announce('Thanks — saved with the usage log.');
    $('usage-note').textContent = 'Thanks — saved with the usage log.';
    // Sent now rather than on the minute: the panel is often closed right after (audit 2026-10-08).
    uploadNow();
  });
  setInterval(renderUsage, 5000);
}

// ---------------------------------------------------------------------------------------------
// The intake PDF, shown in the panel with the item it was opened for marked on it

// Kept in session storage beside the intake (cleared when Chrome closes, or by Clear this client),
// so a reopened panel can still show it. That storage holds 10 MB in all: a larger PDF is shown
// only until the panel closes.
const PDF_KEY = 'intakePdf';
const PDF_KEEP_MAX = 4 * 1024 * 1024;
// Zoom steps, relative to the page fitting the panel's width. The whole PDF opens at PDF_OPEN_ZOOM,
// an item marked on it at PDF_FOCUS_ZOOM: at the panel's width, the form's text is readable from 200%.
const PDF_ZOOMS = [1, 1.5, 2, 3, 4];
const PDF_OPEN_ZOOM = 2;
// An item opens at 200%: 300% showed too little around it (2026-10-10).
const PDF_FOCUS_ZOOM = 2;

// Whether the intake PDF can be shown (this panel read it, or it is kept for the session).
function pdfAvailable() {
  return !!(state.pdfBytes || state.intake?.pdfKept);
}

// "page 2" for an intake of several pages; nothing for a one-page intake (TNI's is one page).
function pdfPageSaid(page, before) {
  return (state.intake?.places?.pages?.length ?? 1) > 1 ? `${before}${page + 1}` : '';
}

async function keepPdf(bytes) {
  state.pdfBytes = bytes;
  state.pdfDoc?.doc.then((d) => d.destroy()).catch(() => {});
  state.pdfDoc = null;
  let kept = false;
  if (bytes.length <= PDF_KEEP_MAX) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    kept = await store.set(PDF_KEY, btoa(text)).then(() => true, () => false);
  }
  if (!kept) await store.remove(PDF_KEY).catch(() => {});
  if (state.intake) state.intake.pdfKept = kept;
}

async function forgetPdf() {
  state.pdfBytes = null;
  state.pdfDoc?.doc.then((d) => d.destroy()).catch(() => {});
  state.pdfDoc = null;
  state.pdf = null;
  await store.remove(PDF_KEY);
}

async function intakePdfBytes() {
  if (state.pdfBytes) return state.pdfBytes;
  const kept = state.intake?.pdfKept ? await store.get(PDF_KEY) : null;
  if (!kept) return null;
  const text = atob(kept);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return (state.pdfBytes = bytes);
}

async function intakePdfDocument() {
  const bytes = await intakePdfBytes();
  if (!bytes) return null;
  if (state.pdfDoc?.bytes !== bytes) {
    // pdf.js takes the buffer it is given: it gets a copy.
    state.pdfDoc = { bytes, doc: pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise };
  }
  return state.pdfDoc.doc;
}

// `target`: { path, from, label, kind: 'check' | 'filled' }, the record path to mark, or for a
// derived answer the paths it was worked out from (`from`, plan.js; intake-source.js); none for
// the whole PDF from its first page. Shown in a sheet over the panel; Back (or Escape) returns to
// where the agent was.
async function openPdf(target = null) {
  const paths = [].concat(target?.from ?? target?.path ?? []);
  const place = target ? sourcePlace(paths, state.intake) : null;
  // An answer the agent corrected in the panel: the PDF still shows what the client wrote.
  const kind = target?.kind === 'filled' && paths.some((p) => state.intake?.agentEdited?.includes(p)) ? 'edited'
    : target?.kind === 'filled' && target.from ? 'derived' : target?.kind;
  if (!state.pdf) state.pdfReturn = document.activeElement;
  state.pdf = { page: place?.page ?? 0, zoom: place ? PDF_FOCUS_ZOOM : PDF_OPEN_ZOOM, pages: state.pdf?.pages ?? null, mark: place ? { ...target, kind, place } : null };
  state.fileMenuOpen = false;
  render();
  $('pdf-title').textContent = place ? target.label : 'Intake PDF';
  $('pdf-name').textContent = place ? `Intake${pdfPageSaid(place.page, ', page ')} · marked` : state.intake?.fileName ?? 'Intake PDF';
  // The last PDF drawn stays hidden until this one is.
  $('pdf-sheet').hidden = true;
  $('pdf-error').hidden = true;
  $('pdf-loading').hidden = false;
  $('pdf-scroll').scrollTo(0, 0);
  $('pdf-back').focus();
  await drawPdf({ focus: !!place });
}

// All client details: the drawer over the panel, from the button by the client's name or the row
// under the checks. Focus goes into it and back where it was when it closes.
function openDetails() {
  if (!state.intake) return;
  if (!state.detailsOpen) state.detailsReturn = document.activeElement;
  state.detailsOpen = true;
  state.fileMenuOpen = false;
  render();
  if (!$('details-view').contains(document.activeElement)) $('details-close').focus();
}
function closeDetails() {
  if (!state.detailsOpen) return;
  state.detailsOpen = false;
  showScreen();
  const back = state.detailsReturn;
  state.detailsReturn = null;
  (back?.isConnected ? back : $(state.view === 'check' ? 'step-check' : 'step-fill'))?.focus();
}

function closePdf() {
  state.pdf = null;
  state.pdfTask?.cancel();
  render();
  const back = state.pdfReturn;
  state.pdfReturn = null;
  (back?.isConnected ? back : $(state.view === 'check' ? 'step-check' : 'step-fill'))?.focus();
}

async function drawPdf({ focus = false } = {}) {
  const view = state.pdf;
  if (!view) return;
  const draw = ++state.pdfDraw;
  const mark = view.mark?.place.page === view.page ? view.mark : null;
  $('pdf-hint').hidden = !mark;
  $('pdf-hint').classList.toggle('filled', ['filled', 'derived', 'edited'].includes(mark?.kind));
  if (mark) {
    const where = pdfPageSaid(mark.place.page, ' on page ');
    $('pdf-hint-text').replaceChildren(...{
      check: ['Showing ', h('b', {}, mark.label), where],
      filled: ['Filled from ', h('b', {}, mark.label), where],
      derived: [h('b', {}, mark.label), ` was worked out from the marked answer${mark.place.rects?.length > 1 ? 's' : ''}${where}`],
      edited: ['You corrected ', h('b', {}, mark.label), ` in the panel. The intake as the client wrote it${where}`],
    }[mark.kind ?? 'check']);
  }
  renderPdfControls();
  let page;
  try {
    const doc = await intakePdfDocument();
    if (!doc) throw new Error('missing');
    view.pages = doc.numPages;
    page = await doc.getPage(view.page + 1);
  } catch (e) {
    if (draw !== state.pdfDraw) return;
    $('pdf-sheet').hidden = true;
    $('pdf-loading').hidden = true;
    $('pdf-error').hidden = false;
    $('pdf-error').textContent = e?.message === 'missing'
      ? 'This PDF is no longer kept. Load the same file again (⋯, Change file); your work stays.'
      : 'Couldn’t show this PDF here. Open it in a new tab instead.';
    // Nothing to page, zoom or mark; a PDF that isn't kept can't open in a tab either.
    for (const id of ['pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-fit', 'pdf-zoom-in', 'pdf-focus']) $(id).disabled = true;
    $('pdf-tab').disabled = e?.message === 'missing';
    $('pdf-hint').hidden = true;
    return;
  }
  if (draw !== state.pdfDraw || !state.pdf) return;
  renderPdfControls();
  // Fit the page to the panel's width, then zoom; drawn sharp on high-density screens.
  const scroll = $('pdf-scroll');
  const fit = Math.max(scroll.clientWidth - 28, 120) / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale: fit * view.zoom });
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.id = 'pdf-canvas';
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  state.pdfTask?.cancel();
  // The form's answers are drawn from its fields (their appearance), as a PDF viewer shows them.
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], annotationMode: pdfjs.AnnotationMode.ENABLE });
  state.pdfTask = task;
  try { await task.promise; } catch { return; /* cancelled by a newer draw */ }
  if (draw !== state.pdfDraw || !state.pdf) return;
  $('pdf-canvas').replaceWith(canvas);
  $('pdf-error').hidden = true;
  $('pdf-loading').hidden = true;
  $('pdf-sheet').hidden = false;
  // One mark per field the answer came from (a derived answer may have read several).
  $('pdf-marks').replaceChildren(...(mark ? (mark.place.rects ?? [mark.place.rect]) : []).map((rect) => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
    const box = h('div', { class: `pdf-mark${mark.kind === 'check' ? '' : ' filled'}` });
    Object.assign(box.style, { left: `${Math.min(x1, x2) - 2}px`, top: `${Math.min(y1, y2) - 2}px`, width: `${Math.abs(x2 - x1) + 4}px`, height: `${Math.abs(y2 - y1) + 4}px` });
    return box;
  }));
  if (mark && focus) focusPdfMark();
}

// Scrolls the marked items into the middle of the view, with the question's label to their left
// in view too where the panel is wide enough.
function focusPdfMark() {
  const scroll = $('pdf-scroll');
  const marks = [...$('pdf-marks').children];
  if (!marks.length) return;
  const sr = scroll.getBoundingClientRect();
  const boxes = marks.map((m) => m.getBoundingClientRect());
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  scroll.scrollTop += top - sr.top - (scroll.clientHeight - (bottom - top)) / 2;
  // The field's label is printed to its left: show up to a third of the view of it, unless the
  // marks would then run off the right edge.
  const lead = Math.max(14, Math.min(scroll.clientWidth / 3, scroll.clientWidth - (right - left) - 14));
  scroll.scrollLeft += left - sr.left - lead;
}

function renderPdfControls() {
  const view = state.pdf;
  if (!view) return;
  $('pdf-pages').textContent = view.pages ? `${view.page + 1} / ${view.pages}` : '';
  $('pdf-prev').disabled = view.page <= 0;
  $('pdf-next').disabled = !view.pages || view.page >= view.pages - 1;
  $('pdf-zoom-out').disabled = view.zoom <= PDF_ZOOMS[0];
  $('pdf-zoom-in').disabled = view.zoom >= PDF_ZOOMS.at(-1);
  $('pdf-zoom-fit').disabled = false;
  $('pdf-tab').disabled = false;
  $('pdf-focus').disabled = false;
  const pct = Math.round(view.zoom * 100);
  $('pdf-zoom-fit').textContent = `${pct}%`;
  // It shows the zoom, and sets it back to the page's width.
  $('pdf-zoom-fit').setAttribute('aria-label', `Zoom ${pct}%. Fit the page to the panel`);
}

function pdfZoom(zoom, { focus = false } = {}) {
  if (!state.pdf || zoom == null) return;
  // Zooming keeps the middle of the view in the middle.
  const scroll = $('pdf-scroll');
  const keep = [(scroll.scrollLeft + scroll.clientWidth / 2) / scroll.scrollWidth, (scroll.scrollTop + scroll.clientHeight / 2) / scroll.scrollHeight];
  state.pdf.zoom = zoom;
  drawPdf({ focus }).then(() => {
    if (focus || !state.pdf) return;
    scroll.scrollLeft = keep[0] * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop = keep[1] * scroll.scrollHeight - scroll.clientHeight / 2;
  });
}

function pdfPage(step) {
  const view = state.pdf;
  if (!view?.pages) return;
  const next = Math.min(Math.max(view.page + step, 0), view.pages - 1);
  if (next === view.page) return;
  view.page = next;
  $('pdf-scroll').scrollTo(0, 0);
  drawPdf();
}

// Chrome's own PDF viewer, in a tab beside the quote (the panel keeps working on the quote tab).
async function openPdfInTab() {
  const bytes = await intakePdfBytes();
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  if (inExtension) await chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

// The step a one-address application's tab is on (AmWINS), as the recorder reads it on arrival,
// with new questions, with each batch of changes and whenever the headings change (step_shown): for
// the page strip and the report shown (renderSite), so the agent's own Continue to the next step,
// or a click on another step's tab, is followed. A fill's own step is noted by renderReport.
// Registered before onRecorderMessage, which then scopes the same message by this step.
// Arriving at a step that is the agent's (stopSteps: GEICO's MVR & CLUE, Payment Information; a
// move from another step, or a new document on it) is logged as a fill run that stopped, as a stop
// page is, with the step's name only, once the tab is shown to be this intake's quote.
function noteStep(msg, sender) {
  if (msg?.ra !== 'usage' || !['field_changes', 'new_fields', 'page_view', 'step_shown', 'list_shown'].includes(msg.event) || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier;
  const step = knownStep(carrier, msg.step);
  if (!step) return;
  const moved = state.tabSteps.get(sender.tab.id) !== step;
  if (moved) state.tabSteps.set(sender.tab.id, step);
  if (carrier?.stopSteps?.[step] && (moved || (msg.event === 'page_view' && !msg.from)) && !carrier.practice && stopPageIsOurs()) {
    const page = samePage(msg.page) || pageOf(state.tab.url);
    usage.log(...fillEvents([{ fields: 0, blockers: [`stop: ${step}`] }], { carrier: carrier.id, page, view: viewOf(sender.tab.id, page), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text, step }));
  }
  // A stop screen (noteStopScreen) ends with a move to a step or a new document: a question or list
  // drawn while it shows doesn't end it (a layout read without its button does).
  const screenOver = !!state.stopScreens?.has(sender.tab.id) && (moved || msg.event === 'page_view');
  if (screenOver) state.stopScreens.delete(sender.tab.id);
  if (moved || screenOver) renderSite();
  // A report shown again for this step is read back from the page (read only).
  if (moved && state.reportFor?.restored) refreshAnswers();
}

// What the agent did on this intake, for the file menu's question and the same-file note:
// "corrected 2 answers and checked 3 items", '' for nothing.
function workSaid(edits, checks) {
  return [edits ? `corrected ${edits} answer${edits === 1 ? '' : 's'}` : null,
    checks ? `checked ${checks} item${checks === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
}

// The file menu asks before the agent's work would go: `what` 'replace' or 'clear'.
function askFile(what, text, yes) {
  state.fileConfirm = what;
  $('file-confirm-text').textContent = text;
  $('file-confirm-yes').textContent = yes;
  render();
  $('file-confirm-no').focus();
}

// A line under the client's name about the file just loaded (null hides it).
function clientNote(text) {
  $('client-note').hidden = !text;
  $('client-note').textContent = text ?? '';
}

async function clearClient() {
  const scope = usage.currentSession()?.intakeId;
  usage.log({ type: 'intake_closed', reason: 'cleared' });
  cancelLayouts();
  holdLayouts();
  resetViews();
  state.intake = null;
  state.fileMenuOpen = false;
  state.fileConfirm = null;
  state.view = 'check';
  state.filter = 'all';
  state.aiDocks = new Map();
  state.pastKey = null;
  state.detailsOpen = false;
  dropReports();
  clientNote(null);
  usage.restoreSession(null);
  await store.remove('intake');
  await store.remove('session');
  await forgetPdf();
  await persistAiPending();
  await clearAgentKeys(scope);
  render();
  renderSite();
}

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
  $('window-note').replaceChildren(...(text ? [issueCard({ tone: 'warn', role: 'alert', title: text })] : []));
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

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  const drop = $('load');
  $('choose').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
  drop.addEventListener('click', () => $('file').click());
  $('settings-btn').addEventListener('click', () => { if (state.settingsOpen) { state.settingsOpen = false; showScreen(); } else openSettings(); });
  $('pop-out').addEventListener('click', popOut);
  $('dock-back').addEventListener('click', dock);
  $('settings-done').addEventListener('click', () => { state.settingsOpen = false; showScreen(); $('settings-btn').focus(); });
  // The brain button: the assistant's settings, at its key when it is on without one.
  $('agent-btn').addEventListener('click', async () => { const cfg = await aiSettings(); openSettings(cfg.on && !cfg.apiKey ? 'ai-openai-key' : 'ai-on'); });
  $('step-check').addEventListener('click', () => setView('check'));
  $('step-fill').addEventListener('click', () => setView('page'));
  $('step-confirm').addEventListener('click', () => { setView('page'); refreshAnswers(); });
  for (const b of $('filters').querySelectorAll('button')) b.addEventListener('click', () => setFilter(b.dataset.filter));
  $('file-menu-btn').addEventListener('click', () => { state.fileMenuOpen = !state.fileMenuOpen; state.fileConfirm = null; render(); });
  $('open-pdf').addEventListener('click', () => openPdf());
  $('details-btn').addEventListener('click', () => (state.detailsOpen ? closeDetails() : openDetails()));
  $('details-row').addEventListener('click', () => openDetails());
  $('details-close').addEventListener('click', closeDetails);
  $('details-scrim').addEventListener('click', closeDetails);
  // An earlier page's answers on this tab (read-only), and back to this page's.
  $('page-menu').addEventListener('change', (e) => showPast(e.target.value || null));
  $('past-back').addEventListener('click', () => { showPast(null); $('page-menu').focus(); });
  $('key-btn').addEventListener('click', () => { state.keyOpen = !state.keyOpen; renderSteps(); });
  $('pdf-back').addEventListener('click', closePdf);
  $('pdf-close').addEventListener('click', closePdf);
  $('pdf-scrim').addEventListener('click', closePdf);
  $('pdf-tab').addEventListener('click', openPdfInTab);
  $('pdf-focus').addEventListener('click', () => pdfZoom(Math.max(state.pdf?.zoom ?? 1, PDF_FOCUS_ZOOM), { focus: true }));
  $('pdf-prev').addEventListener('click', () => pdfPage(-1));
  $('pdf-next').addEventListener('click', () => pdfPage(1));
  $('pdf-zoom-in').addEventListener('click', () => pdfZoom(PDF_ZOOMS.find((z) => z > state.pdf?.zoom)));
  $('pdf-zoom-out').addEventListener('click', () => pdfZoom(PDF_ZOOMS.findLast((z) => z < state.pdf?.zoom)));
  $('pdf-zoom-fit').addEventListener('click', () => pdfZoom(1));
  // The page is drawn for the panel's width: again when it changes (the panel resized).
  let width = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== width && state.pdf && width) drawPdf();
    width = w;
  }).observe($('pdf-scroll'));
  // Escape closes the PDF sheet, the client details drawer, then Settings; the sheet or the drawer
  // keeps keyboard focus while it's open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pdf && !$('pdf-view').hidden) { e.preventDefault(); closePdf(); return; }
    if (e.key === 'Escape' && state.detailsOpen && !$('details-view').hidden) { e.preventDefault(); closeDetails(); return; }
    if (e.key === 'Escape' && state.settingsOpen) { e.preventDefault(); state.settingsOpen = false; showScreen(); $('settings-btn').focus(); return; }
    const modal = state.pdf && !$('pdf-view').hidden ? $('pdf-view') : state.detailsOpen && !$('details-view').hidden ? $('details-view') : null;
    if (e.key !== 'Tab' || !modal) return;
    const stops = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const [first, last] = [stops[0], stops.at(-1)];
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  for (const t of [document.body]) {
    t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    t.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
    t.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
    t.addEventListener('dragover', () => { if (!state.intake) $('load-error').hidden = true; });
  }
  $('test-run').addEventListener('change', () => markTestRun($('test-run').checked));
  // Change file: straight to the file picker, unless the agent has corrected or checked this
  // intake (a different file starts over). Clear: always asked first.
  $('replace').addEventListener('click', () => {
    const work = workSaid(state.intake?.agentEdited?.length ?? 0, state.intake?.done?.length ?? 0);
    if (!work) { state.fileMenuOpen = false; render(); $('file').click(); return; }
    askFile('replace', `You ${work}. A different file starts over; the same file keeps it.`, 'Choose a file');
  });
  $('clear-client').addEventListener('click', () => {
    const name = state.intake?.record.applicant.name || state.intake?.record.applicant.owner1 || 'this client';
    askFile('clear', `Clear ${name}? Your corrections, checks and reports go. The carrier's site isn't changed.`, 'Clear this client');
  });
  $('file-confirm-no').addEventListener('click', () => { state.fileConfirm = null; render(); $('file-menu-btn').focus(); });
  $('file-confirm-yes').addEventListener('click', () => {
    const what = state.fileConfirm;
    state.fileConfirm = null;
    state.fileMenuOpen = false;
    render();
    if (what === 'replace') $('file').click();
    if (what === 'clear') clearClient();
  });
  // The dock: its one button and its alternative.
  $('fill').addEventListener('click', () => fillPage({ continuing: $('fill').dataset.go === 'continue' }));
  $('fill-stop').addEventListener('click', stopFill);
  $('dock-next').addEventListener('click', showNextNeed);
  $('look-right').addEventListener('click', function () { this.disabled = true; lookRight(state.tab?.id, pageOf(state.tab?.url), state.tab?.carrier, this); });
  $('ai-approve').addEventListener('click', () => state.aiDocks.get(`${state.tab?.id}|${pageOf(state.tab?.url)}`)?.go());
  $('dock-alt').addEventListener('click', () => {
    if ($('dock-alt').dataset.go === 'fill-anyway') dismissState();
    fillPage();
  });
  $('unmark').addEventListener('click', clearMarks);
  $('capture').addEventListener('click', capturePage);
  // Alt+Shift+C (manifest "commands"): a capture without leaving the page, e.g. with a list open.
  if (inExtension) chrome.commands?.onCommand.addListener((command) => { if (command === 'capture-page') captureFromShortcut(); });
  wireUsage();
  wireAi();
  if (inExtension) {
    // The step first: a field change or new question is scoped by the step it came with.
    chrome.runtime.onMessage.addListener(noteStep);
    chrome.runtime.onMessage.addListener(onRecorderMessage);
    chrome.runtime.onMessage.addListener(onPanelMessage);
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onCreated.addListener((tab) => { if (state.layoutHold) state.layoutNewTabs.add(tab.id); inheritQuoteState(tab); });
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener((tabId) => { state.tabSteps.delete(tabId); state.stopScreens.delete(tabId); dropReports((entry) => entry.tabId === tabId); });
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  // Stored data in this build's shape before anything reads it (migrateStoredData).
  await migrateStoredData();
  wire();
  if (inExtension && popped) keepPlace();
  // An intake saved by an earlier panel: while the panel was closed the tabs may have moved to
  // another client's quote, so their layouts wait as after loading one (holdLayouts).
  holdLayouts();
  state.intake = (await store.get('intake')) ?? null;
  if (state.intake) state.view = firstView(state.intake);
  state.active = (await store.get('active')) ?? state.active;
  // The selection saved for that tab, kept should the panel reach another tab first.
  state.savedActive = state.active;
  state.activeTab = (await store.get('activeTab')) ?? null;
  usage.restoreSession((await store.get('session')) ?? null);
  const views = await store.get('views');
  if (views?.session && views.session === usage.currentSession()?.id) state.viewTabs = new Map(views.tabs);
  // With the panel in its own window, the newest copy is the one that stays (onPanelMessage); said
  // once its intake is known, for the copy giving way to hand over to (takeOver).
  announceCopy();
  await restoreAiPending();
  const saved = await usage.settings();
  $('auto-followups').checked = saved.autoFollowUps ?? true;
  $('auto-pages').checked = saved.autoPages ?? false;
  $('auto-advance').checked = saved.autoAdvance ?? true;
  // The panel opened on a saved intake: the settings in force for the rest of its quote.
  if (state.intake && usage.currentSession()) logSettings('opened');
  $('check-continue').checked = saved.checkBeforeContinue ?? false;
  uploadNow();
  render();
  renderUsage();
  renderAiSettings();
  reviewIntake();
  await refreshTab();
}

init();
