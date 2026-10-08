import * as pdfjs from '../lib/pdf.min.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseEdit, ntlMention, ntlCheckMessage } from '../src/normalize.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { get, set, STATES } from '../src/util.js';
import { intakeSummary, fieldChangeEvent, fillEvents, redactor, sha256Hex } from '../src/usage.js';
import { quoteStatePick, stateCode, stateMismatch } from '../src/quote-state.js';
import * as usage from './usage-log.js';
import { collectItems, AssistError, assistContextKey } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION, claimsTruncated } from '../src/ai/luna.js';
import { PROVIDERS, settingsFrom, suggest, reviewNotes } from '../src/ai/providers.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;

// Outside the extension (e.g. opening this page directly to check the layout) there is no
// chrome.* API: keep data in memory and disable filling.
const inExtension = !!globalThis.chrome?.scripting;
const memory = {};
const store = inExtension
  ? {
      get: async (k) => (await chrome.storage.session.get(k))[k],
      set: (k, v) => chrome.storage.session.set({ [k]: v }),
      remove: (k) => chrome.storage.session.remove(k),
    }
  : { get: async (k) => memory[k], set: async (k, v) => { memory[k] = v; }, remove: async (k) => { delete memory[k]; } };

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
// Keys only, scoped to the intake and tab: no typed answer or client text is retained here.
const AGENT_KEYS_KEY = 'agentEditedKeys';
const agentKeysStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async () => (await chrome.storage.local.get(AGENT_KEYS_KEY))[AGENT_KEYS_KEY] ?? [],
      set: (records) => chrome.storage.local.set({ [AGENT_KEYS_KEY]: records }) }
  : { get: async () => memory[AGENT_KEYS_KEY] ?? [], set: async (records) => { memory[AGENT_KEYS_KEY] = records; } };
let agentKeysQueue = Promise.resolve();
// Buttons clicked and vehicles/drivers/trailers entered on a quote tab, so a panel closed or
// reloaded mid-quote never adds a vehicle or trailer again (ids only, scoped like the keys above).
// One storage key per intake and tab: two panels filling two quote tabs never overwrite each
// other's record (Codex on PR #43).
const DONE_ACTIONS_PREFIX = 'doneActions:';
const doneKey = (scope, tabId) => `${DONE_ACTIONS_PREFIX}${scope}:${tabId}`;
const doneActionsStore = inExtension && globalThis.chrome?.storage?.local
  ? { get: async (scope, tabId) => (await chrome.storage.local.get(doneKey(scope, tabId)))[doneKey(scope, tabId)] ?? [],
      set: (scope, tabId, ids) => (ids.length ? chrome.storage.local.set({ [doneKey(scope, tabId)]: ids }) : chrome.storage.local.remove(doneKey(scope, tabId))),
      clear: async () => chrome.storage.local.remove(Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(DONE_ACTIONS_PREFIX))) }
  : { get: async (scope, tabId) => memory[doneKey(scope, tabId)] ?? [],
      set: async (scope, tabId, ids) => { memory[doneKey(scope, tabId)] = ids; },
      clear: async () => { for (const k of Object.keys(memory)) if (k.startsWith(DONE_ACTIONS_PREFIX)) delete memory[k]; } };
let doneActionsQueue = Promise.resolve();

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
    && state.tab?.url === ctx.tabUrl && pageOf(state.tab?.url) === ctx.page && !state.tab?.carrier?.stopPages?.[ctx.page]
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
  filling: false,
  autoTimer: null,
  autoPending: false,
  autoPaused: false,
  // Page layouts: the last one logged per quote and page (or vehicle/driver on its page), the
  // chain that logs them one at a time, the capture waiting for the page to be quiet, failures.
  lastLayouts: new Map(),
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
  visitedPages: new Set(),
  // AI assistant: the latest request (older answers arriving late are dropped) and suggestions
  // per page and set of questions, so a refill doesn't ask again.
  aiRun: 0,
  aiCache: new Map(),
  // Which screen shows: Settings over everything; otherwise the start screen or the quote, on
  // its Check intake or Fill pages step.
  settingsOpen: false,
  // The Luna controls are available from the brain button even while the Settings screen is
  // hidden. Keep the opening trigger so Escape and the close button return focus
  // to the control the agent used.
  agentPopoverOpen: false,
  agentPopoverTrigger: null,
  step: 'check',
};

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

function persistAgentKeys() {
  const scope = usage.currentSession()?.intakeId;
  const tabId = state.tab?.id;
  if (!scope || !Number.isInteger(tabId)) return Promise.resolve();
  const records = [...state.agentKeys].filter(([, keys]) => keys.size)
    .map(([page, keys]) => ({ scope, tabId, page, keys: [...keys] }));
  const task = agentKeysQueue.then(async () => {
    const existing = await agentKeysStore.get();
    await agentKeysStore.set([...existing.filter(x => x.scope !== scope || x.tabId !== tabId), ...records]);
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

function clearAgentKeys() {
  const task = agentKeysQueue.then(() => agentKeysStore.set([]));
  agentKeysQueue = task.catch(() => {});
  doneActionsQueue = doneActionsQueue.then(() => doneActionsStore.clear()).catch(() => {});
  return task;
}

function persistDoneActions() {
  const scope = usage.currentSession()?.intakeId;
  const tabId = state.tab?.id;
  if (!scope || !Number.isInteger(tabId)) return Promise.resolve();
  const ids = [...state.doneActions].filter((id) => typeof id === 'string');
  doneActionsQueue = doneActionsQueue.then(() => doneActionsStore.set(scope, tabId, ids)).catch(() => {});
  return doneActionsQueue;
}

// Once per tab and intake while the panel is open (after a reload): later arrivals keep the
// panel's own set, which may have dropped a button to run again (Print / Send on a return).
const doneRestored = new Set();
async function restoreDoneActions(tabId) {
  const scope = usage.currentSession()?.intakeId;
  if (!scope || !Number.isInteger(tabId) || doneRestored.has(`${scope}|${tabId}`)) return;
  const ids = await doneActionsStore.get(scope, tabId);
  if (state.tab?.id !== tabId || usage.currentSession()?.intakeId !== scope) return;
  doneRestored.add(`${scope}|${tabId}`);
  for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && id) state.doneActions.add(id);
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
    return showLoadError(`Couldn't read that PDF (${e.message}).`);
  }
  if (!Object.keys(raw).length) {
    return showLoadError('This PDF has no fillable fields — it may be a scan or a printed-and-signed copy. Only the fillable TNI quote application is supported so far.');
  }
  const result = normalizeIntake(raw);
  if (result.error) return showLoadError(result.error);
  const summary = await intakeSummary(bytes, raw, result);
  if (state.intake) usage.log({ type: 'intake_closed', reason: 'replaced' });
  clearTimeout(state.autoTimer);
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
  state.intake = { ...result, fileName: file.name, done: [] };
  // Start on Check intake when something on the intake needs a look, else straight on Fill.
  state.step = result.warnings.some((w) => w.level === 'check') ? 'check' : 'fill';
  state.settingsOpen = false;
  state.active = { drivers: 0, vehicles: 0, trailers: 0 };
  state.filled = new Map();
  state.doneActions = new Set();
  discardAiSuggestions();
  await store.set('session', usage.startSession(summary.intakeId));
  await persistAiPending();
  await restoreAiPending();
  await clearAgentKeys();
  usage.log({ type: 'intake_loaded', ...summary });
  uploadNow();
  await save();
  render();
  refreshTab();
  reviewClaimsBox();
}

function showLoadError(msg) {
  $('load-error').replaceChildren(h('b', {}, 'Couldn\'t read that file'), h('span', { class: 'small' }, msg));
  $('load-error').hidden = false;
}

async function save() {
  await store.set('intake', state.intake);
  await store.set('active', state.active);
}

// ---------------------------------------------------------------------------------------------
// Rendering the client record

function render() {
  const has = !!state.intake;
  showScreen();
  $('recording').hidden = !has;
  $('foot-version').hidden = has;
  if (!has) return;
  const { record, stats, fileName } = state.intake;
  const n = (k, one) => `${record[k].length} ${one}${record[k].length === 1 ? '' : 's'}`;
  const st = record.garaging?.state;
  $('client-name').textContent = record.applicant.name || record.applicant.owner1 || 'Unnamed business';
  $('client-meta').textContent = [STATES[st] ?? st, n('drivers', 'driver'), n('vehicles', 'vehicle')].filter(Boolean).join(' · ');
  $('client-meta').title = `${fileName} · ${stats.filled} answers`;
  $('details-count').textContent = `${stats.filled} answers`;
  renderWarnings();
  renderSections();
  renderPickers();
  renderSite();
}

// Agent options can open without leaving the current quote.
function closeAgentPopover({ restore = true } = {}) {
  $('agent-popover').hidden = true;
  $('agent-btn').setAttribute('aria-expanded', 'false');
  $('settings-agent').setAttribute('aria-expanded', 'false');
  state.agentPopoverOpen = false;
  const trigger = state.agentPopoverTrigger || $('agent-btn');
  state.agentPopoverTrigger = null;
  if (restore) trigger.focus();
}

function openAgentPopover({ trigger = $('agent-btn'), focusId = null } = {}) {
  state.agentPopoverTrigger = trigger;
  state.agentPopoverOpen = true;
  $('agent-popover').hidden = false;
  $('agent-btn').setAttribute('aria-expanded', 'true');
  $('settings-agent').setAttribute('aria-expanded', 'true');
  if (focusId) $('ai-connection').open = true;
  const target = focusId ? $(focusId) : $('ai-on');
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

// Settings over everything; otherwise the start screen, or the quote on one of its two steps.
function showScreen() {
  const has = !!state.intake;
  $('settings').hidden = !state.settingsOpen;
  $('home').hidden = state.settingsOpen || has;
  $('quote').hidden = state.settingsOpen || !has;
  $('settings-btn').setAttribute('aria-expanded', String(state.settingsOpen));
  $('check-pane').hidden = state.step !== 'check';
  $('fill-pane').hidden = state.step !== 'fill';
  $('tab-check').setAttribute('aria-selected', String(state.step === 'check'));
  $('tab-fill').setAttribute('aria-selected', String(state.step === 'fill'));
}

function setStep(step) {
  state.step = step;
  showScreen();
}

function openSettings(focusId = null) {
  // The assistant connection fields live in the agent popover now. Setup notices still call
  // openSettings('ai-openai-key'), so route those requests to the visible controls instead of
  // opening a Settings screen whose fields may be hidden behind the popover.
  if (focusId === 'ai-openai-key' || focusId === 'ai-model') {
    state.settingsOpen = false;
    showScreen();
    openAgentPopover({ trigger: state.agentPopoverTrigger || $('agent-btn'), focusId });
    return;
  }
  closeAgentPopover({ restore: false });
  state.settingsOpen = true;
  showScreen();
  if (!focusId) return;
  if ($('advanced').contains($(focusId))) $('advanced').open = true;
  $(focusId).focus();
  $(focusId).scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Check intake: one card per thing to check, with its field to fix and Mark as checked.
function renderWarnings() {
  const { warnings, done } = state.intake;
  const checks = warnings.map((w, i) => [w, i]).filter(([w]) => w.level === 'check');
  const infos = warnings.filter((w) => w.level === 'info');
  const open = checks.filter(([, i]) => !done.includes(i)).length;
  $('check-num').textContent = open ? String(open) : '✓';
  $('check-num').className = `num ${open ? 'warn' : 'good'}`;
  $('check-intro').hidden = !open;
  $('check-intro').replaceChildren(h('b', {}, `${open} thing${open === 1 ? '' : 's'}`), ' on the intake looked wrong or missing. Fix the value if needed, then mark it checked.');
  $('check-done').hidden = !!open;
  $('check-done').querySelector('.card-title').textContent = checks.length ? `All ${checks.length} item${checks.length === 1 ? '' : 's'} checked.` : 'Nothing on the intake looked wrong.';
  const editable = (path) => path && /\.|\]$/.test(path) && fieldInfo(path).label !== path;
  const cards = checks.map(([w, i]) => {
    const label = editable(w.path) ? fieldInfo(w.path).label : 'Item';
    if (done.includes(i)) {
      return h('div', { class: 'checked-row' }, h('b', {}, '✓'), h('span', { class: 'grow' }, `${label} checked`),
        h('button', { type: 'button', class: 'link small', onclick: () => toggleDone(i, false) }, 'Undo'));
    }
    const info = editable(w.path) ? fieldInfo(w.path) : null;
    return h('div', { class: 'warn-card' },
      h('div', { class: 'warn-msg' }, w.msg),
      info ? fieldRow(w.path, info.label, info.kind, true, 'stack') : w.path ? h('button', { type: 'button', class: 'link small', onclick: () => jumpTo(w.path) }, 'Show in client details') : null,
      h('button', { type: 'button', class: 'ghost', onclick: () => toggleDone(i, true) }, 'Mark as checked'));
  });
  $('warnings').replaceChildren(...cards,
    ...(infos.length ? [h('details', { class: 'cleanup' }, h('summary', { class: 'small muted' }, `Cleanup notes (${infos.length})`), h('ul', {}, infos.map((w) => h('li', {}, w.msg))))] : []));
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
}

function openFlags(prefix) {
  const { warnings, done } = state.intake;
  return warnings.filter((w, i) => w.level === 'check' && !done.includes(i) && w.path && (w.path === prefix || w.path.startsWith(`${prefix}.`) || w.path.startsWith(`${prefix}[`)));
}

function renderSections() {
  const { record } = state.intake;
  const openIds = new Set([...document.querySelectorAll('details.section[open]')].map((d) => d.dataset.id));
  const box = $('sections');
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
    box.append(h('details', { class: 'section', dataset: { id: section.id }, open: openIds.has(section.id) },
      h('summary', {}, h('span', { class: 'title' }, section.title), flags.length ? h('span', { class: 'flag' }, `${flags.length} to check`) : null),
      body));
  }
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
  input.addEventListener('change', async () => {
    const before = get(state.intake.record, path);
    const after = parseEdit(kind, input.value);
    set(state.intake.record, path, after);
    intakeEdited();
    // Log that the agent corrected the intake here (and whether it was flagged), not the value.
    const flaggedCodes = state.intake.warnings.filter((w) => w.path === path).map((w) => w.code);
    usage.log({ type: 'intake_edit', path, kind, change: before == null ? 'added' : after == null ? 'cleared' : 'changed', warnings: flaggedCodes });
    await save();
    // Luna read the claims box against the form's coverages: an edit to either is read again.
    if (path === 'claims.text') claimsTextEdited(state.intake);
    if (path === 'claims.text' || (path.startsWith('coverage.') && path !== 'coverage.ntl')) reviewClaimsBox({ retry: true });
  });
  if (layout === 'stack') {
    // On a check card the same field may also be open in the client details: keep one id.
    input.removeAttribute('id');
    input.addEventListener('change', () => renderSections());
    return h('label', { class: 'field-stack' }, label, input);
  }
  return h('div', { class: `field${flagged ? ' flagged' : ''}${value == null ? ' empty' : ''}`, dataset: { path } },
    h('label', { for: id }, label), input);
}

function jumpTo(path) {
  $('details').open = true;
  const info = fieldInfo(path);
  const sectionId = info.section?.id ?? SECTIONS.find((s) => s.id === path || s.list === path)?.id;
  const details = document.querySelector(`details.section[data-id="${sectionId}"]`);
  if (!details) return;
  details.open = true;
  const row = document.querySelector(`.field[data-path="${CSS.escape(path)}"]`) ?? details;
  row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (row.classList.contains('field')) {
    row.classList.add('pulse');
    row.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove('pulse'), 1500);
  }
}

// Which driver / vehicle / trailer the page is about, as pills (only when the intake has several).
function renderPickers() {
  const { record } = state.intake;
  const pickers = [
    ['drivers', 'driver', (d) => [d.first, d.last].filter(Boolean).join(' ')],
    ['vehicles', 'vehicle', (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')],
    ['trailers', 'trailer', (t) => [t.year, t.make, t.type].filter(Boolean).join(' ')],
  ];
  $('pickers').replaceChildren(...pickers.filter(([list]) => (record[list] ?? []).length > 1).map(([list, what, describe]) =>
    h('div', { class: 'picker' },
      h('div', { class: 'picker-q' }, `Which ${what} is this page about?`),
      h('div', { class: 'pills' }, record[list].map((it, i) => h('button', {
        type: 'button', class: 'pill', 'aria-pressed': String(state.active[list] === i),
        onclick: async () => {
          state.active[list] = i;
          await save();
          renderPickers();
          // The page is now about this vehicle or driver: its own layout (a capture waiting for
          // the previous one is dropped).
          scheduleLayout(pageOf(state.tab?.url), 'picked');
        },
      }, `${i + 1}. ${describe(it) || what}`))))));
}

// ---------------------------------------------------------------------------------------------
// The current tab

// A tab finished loading or changed address. The followed tab, but also the active one: Progressive
// opens the quote in a new tab, which is still loading (no rater address yet) when it becomes
// active, so the panel kept following the old portal tab in the background.
function onTabUpdated(id, change, tab) {
  if ((id === state.tab?.id || tab?.active) && (change.url || change.status === 'complete')) refreshTab();
}

async function refreshTab() {
  if (!inExtension) { state.tab = null; return renderSite(); }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // During a quote the agent may look at another site (email, the intake PDF): the panel stays
  // on the tab of the quote and keeps filling it in the background. Another rater tab is followed.
  const activeIsRater = !!(tab?.url && carrierForUrl(tab.url));
  if (!activeIsRater && state.intake && state.tab?.carrier && tab?.id !== state.tab.id) {
    const quote = await chrome.tabs.get(state.tab.id).catch(() => null);
    const carrier = quote?.url ? carrierForUrl(quote.url) : null;
    if (carrier) {
      state.tab = { id: quote.id, url: quote.url, carrier, background: true };
      renderSite();
      ensureRecorder();
      scheduleLayout(pageOf(state.tab.url), 'arrived');
      return;
    }
  }
  if (tab?.id !== state.tab?.id) {
    // `active`: each quote tab is on its own vehicle and driver (Continue is remembered per vehicle).
    const keys = ['filled', 'labels', 'choices', 'autoPages', 'autoPaused', 'agentKeys', 'doneActions', 'visitedPages', 'doneSteps', 'assistPage', 'active'];
    if (state.tab?.id) state.tabSessions.set(state.tab.id, Object.fromEntries(keys.map((key) => [key, state[key]])));
    const previous = state.tabSessions.get(tab?.id);
    Object.assign(state, previous ?? {
      filled: new Map(), labels: new Map(), choices: new Map(), autoPages: new Set(), autoPaused: false,
      agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), doneSteps: new Set(), assistPage: null,
      active: { ...state.active },
    });
    if (state.intake) renderPickers();
    clearTimeout(state.autoTimer);
    state.autoPending = false;
  }
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null, background: false } : null;
  await restoreAgentKeys(state.tab?.id);
  await restoreDoneActions(state.tab?.id);
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
async function ensureRecorder() {
  if (!inExtension || !state.intake || !state.tab?.carrier) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: state.tab.id, allFrames: true }, files: ['src/content/field-key.js', 'src/content/recorder.js'] });
  } catch { /* page not ready or not allowed; tried again on the next tab update */ }
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
    // Arriving at a carrier stop page (a new document, a reload, or a move from another page; not
    // its "-Reload" re-render): logged as a fill run that stopped, with the page name only, and
    // only once the tab is shown to be this intake's quote.
    const stopPage = samePage(msg.page);
    if (state.tab.carrier?.stopPages?.[stopPage]) {
      if ((!msg.from || samePage(msg.from) !== stopPage) && stopPageIsOurs()) {
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
      if (state.tab.carrier?.trailerPage || state.tab.carrier?.driverPage) unitArrival(state.tab.carrier, samePage(msg.from), samePage(msg.page));
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
    const ctx = { record: state.intake.record, filled: state.filled, labels: state.labels, choices: state.choices, redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt };
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
      const keys = state.agentKeys.get(editScope(page)) ?? new Set();
      byAgent.forEach((c) => keys.add(c.key));
      state.agentKeys.set(editScope(page), keys);
      persistAgentKeys();
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
    scheduleAutoFill(samePage(msg.page));
    scheduleLayout(layoutPage, 'appeared');
  }
  if (msg.event === 'removed_fields') scheduleLayout(layoutPage, 'removed');
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
  const entity = stepScope(page, carrier).split('|')[1];
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

function stepScope(page, carrier = state.tab?.carrier) {
  const entity = carrier?.vehiclePages?.includes(page) ? `v${state.active.vehicles ?? 0}`
    : carrier?.trailerPages?.includes(page) ? `tr${state.active.trailers ?? 0}`
      : carrier?.driverPage && carrier.driverPage === page ? `d${state.active.drivers ?? 0}` : '';
  return `${page}|${entity}|`;
}

// Agent edits are protected per page, and on a page about one vehicle or driver per that vehicle
// or driver (the scope of stepScope): correcting the first vehicle's value on Add Vehicle doesn't
// leave the next vehicle's box alone.
function editScope(page, carrier = state.tab?.carrier) {
  const scope = stepScope(page, carrier);
  return scope.endsWith('||') ? page : scope.slice(0, -1);
}

// Whether the agent settled this field on the page. A row key (name#<row>, field-key v3) is also
// settled by its plain name, saved by an older build, which could have been any row's edit.
function agentEdited(page, key) {
  const keys = state.agentKeys.get(editScope(page));
  return !!keys && (keys.has(key) || keys.has(String(key ?? '').match(/^(.+)#\d+$/)?.[1]));
}

const fillOptions = (carrier, extra = {}) => ({
  replaceChoices: !!carrier.replaceChoices,
  // Carriers whose pages never wait on a server per answer are filled a round at a time.
  batch: !!carrier.batch,
  // Steps of a one-address application already continued from (a step the agent goes back to
  // isn't continued again).
  doneSteps: [...state.doneSteps].filter((s) => s.startsWith(stepScope(pageOf(state.tab?.url), carrier))).map((s) => s.slice(stepScope(pageOf(state.tab?.url), carrier).length)),
  // Click the page's Continue when nothing is left for the agent (setting below), but never
  // while the agent hasn't approved the AI's selections on this page.
  advance: $('auto-advance').checked && carrier.advance && !pendingAi(state.tab?.id, pageOf(state.tab?.url)).length ? carrier.advance : null,
  // Add NTL done on this intake's quote survives a panel reload (its removal hold depends on it).
  doneActions: [...state.doneActions, ...(state.intake?.ntlAdded ? ['addNtl'] : [])],
  visitedPages: [...state.visitedPages],
  // The carrier's own stop (see showStopPage): the page kit refuses to fill or click there too.
  stopPages: Object.keys(carrier.stopPages ?? {}),
  // Never change what the agent changed on this page, whether the fill is manual or automatic.
  skip: [...(state.agentKeys.get(editScope(pageOf(state.tab?.url))) ?? [])],
  ...extra,
});

function scheduleAutoFill(page) {
  if (state.autoPaused || !$('auto-followups').checked || !state.autoPages.has(page) || !onQuotePage() || state.tab?.carrier?.stopPages?.[page]) return;
  if (state.filling) { state.autoPending = true; return; }
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => autoFill(page), 600);
}

async function autoFill(page) {
  // The client may have been cleared while this fill was waiting to run.
  if (state.autoPaused || state.filling || !state.intake || !state.tab?.carrier || pageOf(state.tab?.url) !== page) return;
  if (state.tab.carrier.stopPages?.[page]) return;
  const { id: tabId, carrier } = state.tab;
  // Before any waiting: the agent may pick another vehicle or tab while the carrier works.
  const view = viewOf(tabId, page, carrier);
  await pickListItem(carrier, page);
  state.filling = true;
  state.autoPending = false;
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  await tellRecorder('pause');
  try {
    await retireAiOrigins({ tabId, tabUrl: state.tab.url, intake: state.intake, carrier });
    const plan = buildPlan(state.intake.record, carrier, state.active);
    const skip = [...(state.agentKeys.get(editScope(page)) ?? [])];
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, fillOptions(carrier, { overwrite: false, skip, keepMarks: true })]);
    // Filled with this intake: the tab's quote is this client's, so its layouts may be taken.
    // Only once the fill went through; a fill that failed proves nothing about the page.
    state.layoutReadyTabs.add(tabId);
    const frames = results.map((r) => r.result).filter(Boolean);
    rememberFill(frames, { tabId, carrier });
    followUp = afterFill(frames, { carrier, page });
    const hasWarnings = frames.some((f) => f.unknown?.length);
    // The fill whose helper this follows up held Luna back for it.
    if (state.autoPaused || hasWarnings || state.assistPage === page) { renderReport(frames); assistFrames = frames; }
    const n = frames.reduce((k, f) => k + f.filled.length + (f.actions?.length ?? 0), 0);
    if (n || hasWarnings) {
      if (!carrier.practice) usage.log(...fillEvents(frames, { carrier: carrier.id, page, view, overwrite: false, auto: true, ms: Date.now() - started, redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt }));
      if (n) {
        const note = h('p', { class: 'muted small' }, `Filled ${n} follow-up question${n === 1 ? '' : 's'} automatically: ${frames.flatMap((f) => f.filled).map((x) => x.label).join(' · ')}`);
        $('report').append(note);
      }
      recordLayout(page);
    }
  } catch (e) {
    state.autoPaused = true;
    $('report').append(h('p', { class: 'error' }, 'Automatic filling paused after an error. Review the page, then click Fill this page to retry.'));
    usage.log({ type: 'fill_error', carrier: carrier.id, page, auto: true, error: String(e.message).slice(0, 200) });
  } finally {
    await tellRecorder('resume');
    state.filling = false;
    if (state.autoPending) scheduleAutoFill(page);
  }
  // The page moved on to a stop page while this ran: its card stays on top of this fill's report.
  if (state.tab?.carrier?.stopPages?.[pageOf(state.tab?.url)]) showStopPage();
  runPendingPage();
  if (assistFrames) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

function runPendingPage() {
  const pending = state.pagePending;
  state.pagePending = null;
  if (pending && pending === pageOf(state.tab?.url)) setTimeout(() => fillPage({ auto: 'page' }), 300);
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
    // would look like one page whose questions come and go.
    const step = carrier.layoutSteps ? top.step || null : undefined;
    const buttons = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.buttons ?? []))];
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
    const signature = await sha256Hex(JSON.stringify(shape));
    if (!jobCurrent(job) || superseded(job)) return;
    // Per quote tab too: each tab keeps its own quote state (refreshTab).
    const scope = `${job.session}|${tabId}|${carrier.id}|${editScope(page)}|${step ?? ''}`;
    // An empty page counts only when questions went away (an answer hid the last one): a fill or
    // an arrival that finds nothing is a page still loading, or one without questions.
    if (!fields.length && !why().split('+').includes('removed')) return;
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
    usage.log({ type: 'page_layout', carrier: carrier.id, page, view: viewOf(tabId, page, carrier), step, reason: why(), context, fields, buttons });
  } catch (e) {
    // A capture overtaken by a later change (a redraw can make its read fail) hands its reasons
    // on instead of reporting a failure for a page that is being captured anyway.
    if (jobCurrent(job) && !superseded(job)) layoutFailed(job, why(), layoutErrorKind(e));
  }
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
  state.layoutErrorsLogged = new Set();
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

// `tabId`, `carrier`: the fill's own tab (the agent may have gone to another one meanwhile).
function rememberFill(frames, { tabId = state.tab?.id, carrier = state.tab?.carrier } = {}) {
  const page = pageOf(state.tab?.url);
  if (state.intake && !state.intake.ntlAdded && frames.some((f) => (f.actions ?? []).some((a) => a.id === 'addNtl'))) {
    state.intake.ntlAdded = true;
    save();
  }
  const keys = state.agentKeys.get(editScope(page)) ?? new Set();
  for (const key of frames.flatMap((f) => f.protectedKeys ?? [])) keys.add(key);
  state.agentKeys.set(editScope(page), keys);
  persistAgentKeys();
  if (frames.some((f) => f.halted)) {
    state.autoPaused = true;
    state.autoPending = false;
    clearTimeout(state.autoTimer);
  }
  for (const id of frames.flatMap((f) => f.invalidatedActions ?? [])) state.doneActions.delete(id);
  for (const a of frames.flatMap((f) => f.actions ?? [])) state.doneActions.add(a.id);
  persistDoneActions();
  for (const x of frames.flatMap((f) => f.filled)) state.filled.set(x.key, { path: x.path, shown: x.shown });
  // The quote's state this fill picked (AmWINS' risk state): the recorder is paused while filling.
  const quoteKey = carrier?.quoteState?.key;
  const pickedState = quoteKey && frames.flatMap((f) => f.filled).find((x) => x.key === quoteKey);
  if (pickedState) noteQuoteState(tabId, carrier.id, stateCode(pickedState.shown));
  for (const [key, label] of frames.flatMap((f) => f.labels ?? [])) if (label) state.labels.set(key, label);
  // Kept from every fill: a searched combo's list differs from one fill to the next.
  for (const [key, options] of frames.flatMap((f) => f.choices ?? [])) {
    const seen = state.choices.get(key) ?? new Set();
    for (const o of options) seen.add(o);
    state.choices.set(key, seen);
  }
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
  caption.textContent = [
    carrier ? (carrier.practice ? 'Practice page' : 'Commercial auto') : null,
    state.tab?.background ? 'In background' : null,
  ].filter(Boolean).join(' · ');
  caption.hidden = !caption.textContent;
  const paths = {
    progressive: 'assets/raters/progressive.svg',
    geico: 'assets/raters/geico.gif',
    amwins: 'assets/raters/amwins.svg',
  };
  const src = paths[carrier?.id] || null;
  const title = state.tab?.background ? 'You are on another tab. The panel keeps working on the quote tab; go back to it to see the marks.' : '';
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
  const stopped = !!carrier?.stopPages?.[pageOf(state.tab?.url)];
  const canFill = inExtension && !!carrier && !!state.intake && !stopped;
  $('fill').disabled = !canFill || state.filling;
  if (!state.filling) $('fill').textContent = state.autoPages.has(pageOf(state.tab?.url)) ? 'Fill this page again' : 'Fill this page';
  $('capture').disabled = !(inExtension && carrier);
  $('fill-hint').textContent = !inExtension
    ? 'Filling works when this runs as the Chrome extension.'
    : stopped ? 'Nothing on this page is filled or clicked.'
    : carrier && state.tab.background ? 'Working on the quote tab in the background. Fill this page fills that tab; go back to it to review.'
    : carrier ? 'Nothing is submitted. Review the page, then click Next yourself.'
      : noAccess
        ? "The browser isn't letting the extension read this page. Allow the extension on this site (click its icon in the toolbar or check its site access in the extensions page), then reload the page."
        : 'Open a Progressive, GEICO or AmWINS quote page to fill it.';
  showStopPage();
  showStateNote();
}

// Pages where the carrier has stopped the quote (Progressive's DeclinationNotice: the client
// already has a commercial auto policy with Progressive). Nothing is filled or clicked there,
// automatically or on request, and Luna isn't asked; the panel says why above both steps (outside
// the fill report, which Clear marks empties) and the page is the agent's. The carrier's reason is
// said of this client only once the tab is shown to be this intake's quote (stopPageIsOurs).
function showStopPage() {
  const carrier = state.tab?.carrier;
  const page = pageOf(state.tab?.url);
  const note = state.intake ? carrier?.stopPages?.[page] : null;
  const box = $('stop-note');
  box.hidden = !note;
  if (!note) { box.replaceChildren(); return; }
  clearTimeout(state.autoTimer);
  state.autoPending = false;
  state.pagePending = null;
  const ours = stopPageIsOurs();
  box.replaceChildren(h('div', { class: 'agent-page stop-page', role: 'alert' },
    h('b', {}, ours ? `${carrier.name} stopped this quote` : `${carrier.name} stop page`),
    h('p', {}, ours ? note : `This tab was already on ${carrier.name}'s stop page before this client was loaded, so it may be another client's quote. Open or start this client's quote.`),
    h('p', { class: 'small' }, 'Nothing on this page is filled or clicked.')));
}

// The tab's quote is for another state than the intake's garaging state (src/quote-state.js): said
// above both steps until the pick matches, the intake does, or the agent says the pick is right
// (for this intake). Also when the pick came before this intake was loaded: the tab's quote
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

function showStateNote() {
  const box = $('state-note');
  const tabId = state.tab?.id;
  let pick = state.quoteStates.get(tabId);
  if (pick && state.tab?.carrier && pick.carrier !== state.tab.carrier.id) { state.quoteStates.delete(tabId); pick = null; }
  const intakeId = usage.currentSession()?.intakeId ?? null;
  const off = !pick || !state.intake || pick.carrier !== state.tab?.carrier?.id || pick.dismissed === `${intakeId}|${pick.code}`;
  const differs = off ? null : stateMismatch(pick.code, state.intake.record);
  box.hidden = !differs;
  if (!differs) { box.replaceChildren(); return; }
  const name = state.tab.carrier.name;
  const before = pick.session !== (usage.currentSession()?.id ?? null);
  box.replaceChildren(h('div', { class: 'agent-page stop-page', role: 'alert' },
    h('b', {}, `This ${name} quote is for ${differs.picked}, the intake for ${differs.intake}`),
    h('p', {}, before
      ? `This tab's ${name} quote was started in ${differs.picked} before this intake was loaded; the intake's garaging state is ${differs.intake}.`
      : `${differs.picked} was picked for this ${name} quote; the intake's garaging state is ${differs.intake}.`),
    h('p', { class: 'small' }, `A ${differs.picked} quote won't take ${differs.intake} ZIP codes or rules. Start the quote in ${differs.intake}, or check the intake's address.`),
    h('button', { type: 'button', class: 'link small', onclick: () => { pick.dismissed = `${intakeId}|${pick.code}`; showStateNote(); } }, `${differs.picked} is right for this client`)));
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

async function runKit(tabId, carrier, func, args = []) {
  await injectKit(tabId, carrier);
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: worldFor(carrier), func, args });
}

// `auto`: 'page' when started because a new page opened (setting "Fill each new page").
async function fillPage({ auto = false } = {}) {
  // The carrier stopped the quote on this page: nothing is filled or clicked, even on request.
  if (state.intake && state.tab?.carrier?.stopPages?.[pageOf(state.tab.url)]) { showStopPage(); return; }
  // A new page that opens while the previous one is still finishing its fill is filled right
  // after it (it used to be skipped: "it stopped here").
  if (state.filling && auto === 'page') { state.pagePending = pageOf(state.tab?.url); return; }
  if (state.filling || !state.intake || !state.tab?.carrier || (auto && state.autoPaused)) return;
  // The carrier's portal pages outside a quote (Progressive's home / quote search) are never
  // filled, and the AI isn't asked about them.
  if (!onQuotePage()) {
    if (!auto) $('report').replaceChildren(h('p', { class: 'muted center' }, 'This is the portal, not a quote page. Open or start a quote, then fill.'));
    return;
  }
  if (!auto) state.autoPaused = false;
  state.filling = true;
  clearTimeout(state.autoTimer);
  const { id: tabId, carrier } = state.tab;
  const page = pageOf(state.tab.url);
  // Before any waiting: the agent may pick another vehicle or tab while the carrier works.
  const view = viewOf(tabId, page, carrier);
  await pickListItem(carrier, page);
  const plan = buildPlan(state.intake.record, carrier, state.active);
  const overwrite = auto ? false : $('overwrite').checked;
  $('fill').disabled = true;
  $('fill').textContent = 'Filling…';
  $('report').replaceChildren(h('p', { class: 'muted small center' }, 'Filling one answer at a time: the page checks each answer with its server. Keep this tab open.'));
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  // Our own fills aren't the agent's changes: pause the recorder while filling.
  await ensureRecorder();
  await tellRecorder('pause');
  try {
    await retireAiOrigins({ tabId, tabUrl: state.tab.url, intake: state.intake, carrier });
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, fillOptions(carrier, { overwrite })]);
    // Filled with this intake (and the fill went through): this tab's layouts may be taken.
    state.layoutReadyTabs.add(tabId);
    const frames = results.map((r) => r.result).filter(Boolean);
    rememberFill(frames, { tabId, carrier });
    state.autoPages.add(page);
    followUp = afterFill(frames, { carrier, page });
    recordLayout(page);
    if (!carrier.practice) usage.log(...fillEvents(frames, {
      carrier: carrier.id, page, view, overwrite, auto, ms: Date.now() - started, redact: redactor(redactionTerms(state.intake.record)),
      keySalt: usage.currentSession()?.keySalt,
    }));
    renderReport(frames);
    assistFrames = frames;
  } catch (e) {
    state.autoPaused = true;
    usage.log({ type: 'fill_error', carrier: carrier.id, page: pageOf(state.tab.url), error: String(e.message).slice(0, 200) });
    $('report').replaceChildren(h('p', { class: 'error' }, `Couldn't fill this page: ${e.message}`));
  } finally {
    await tellRecorder('resume');
    state.filling = false;
    renderSite();
  }
  runPendingPage();
  await remarkAi({ tabId, page, carrier });
  if (assistFrames && !assistFrames.some((f) => f.halted)) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

// On the carrier's vehicle list page, work on the first intake vehicle not added yet (its Add
// Vehicle or VIN lookup not done in this quote). When every vehicle is in, the active one stays
// and nothing is left to add, so the page's Continue is clicked. Trailers (added from the same
// list) and the driver list work the same way (a driver or trailer counts as entered once its
// page was filled).
async function pickListItem(carrier, page) {
  const tabId = state.tab?.id;
  await verifyListed(carrier, page);
  // Another tab came to the front while the list was read: its own fill picks for it.
  if (state.tab?.id !== tabId) return;
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
    renderPickers();
  }
}

// On the vehicle list, a trailer is on the quote when the list shows its VIN (Progressive lists each
// unit with its VIN), and not when the list shows the quote's vehicles by VIN but not this one
// (Add Trailer left by Back or the top menu, Codex on PR #43). Without VINs to compare, the return
// from its page decides (unitArrival).
async function verifyListed(carrier, page) {
  if (carrier?.driverList && page === carrier.driverList) return verifyDrivers(carrier);
  if (!carrier?.trailerList || page !== carrier.trailerList || !Number.isInteger(state.tab?.id)) return;
  const record = state.intake?.record ?? {};
  const vin = (u) => String(u?.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const trailers = (record.trailers ?? []).map(vin);
  if (!trailers.some((v) => v.length >= 11)) return;
  const vehicles = (record.vehicles ?? []).map(vin);
  let shown = null;
  const tabId = state.tab.id;
  try {
    const frames = await runKit(tabId, carrier, (vins) => globalThis.__raterKit?.listed?.(vins) ?? null, [[...vehicles, ...trailers]]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  if (!shown || state.tab?.id !== tabId) return;
  const showsVins = shown.slice(0, vehicles.length).some(Boolean);
  trailers.forEach((v, i) => {
    if (v.length < 11) return;
    if (shown[vehicles.length + i]) state.doneActions.add(`trailerEntered:${i}`);
    else if (showsVins) state.doneActions.delete(`trailerEntered:${i}`);
  });
  persistDoneActions();
}

// On the driver list, a driver it shows by name (first and last) is entered, also when the panel
// was closed while the agent finished the driver's page (Codex on PR #43). A name not shown proves
// nothing (the list may write it another way): the return from the driver page decides. Nor does
// a name another intake driver's name holds (two John Smiths, Ann Lee and Mary Ann Lee): one row
// would count for both, and the other driver would never be added (Codex on PR #43).
async function verifyDrivers(carrier) {
  if (!Number.isInteger(state.tab?.id)) return;
  const words = (d) => [d.first, d.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
  const drivers = (state.intake?.record?.drivers ?? []).map(words);
  const names = (state.intake?.record?.drivers ?? []).map((d, i) => drivers.some((other, j) => j !== i && drivers[i].every((w) => other.includes(w)))
    ? [] : [d.first, d.last].filter(Boolean));
  if (!names.some((n) => n.length >= 2)) return;
  let shown = null;
  const tabId = state.tab.id;
  try {
    const frames = await runKit(tabId, carrier, (items) => globalThis.__raterKit?.listed?.(items) ?? null, [names]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  // The agent switched tabs meanwhile: the answer is about the other tab's quote (Codex on PR #43).
  if (!shown || state.tab?.id !== tabId) return;
  shown.forEach((on, i) => { if (on) state.doneActions.add(`driverEntered:${i}`); });
  persistDoneActions();
}

// A driver or trailer is entered once the carrier took its page: its list comes back from it (its
// Continue went through). Answers filled there alone don't count: the page may still have failed
// or been left (Codex on PR #43). A driver page Progressive filled itself from Business Owner Info
// counts the same way once continued (OK 2026-10-07: the list added that driver again).
function unitArrival(carrier, from, page) {
  for (const [unitPage, listPage, list, marker] of [[carrier?.driverPage, carrier?.driverList, 'drivers', 'driverEntered'], [carrier?.trailerPage, carrier?.trailerList, 'trailers', 'trailerEntered']]) {
    if (!unitPage || from !== unitPage || page !== listPage) continue;
    state.doneActions.add(`${marker}:${state.active[list] ?? 0}`);
    persistDoneActions();
  }
}

// Bookkeeping after a fill: a click that opens more
// questions (cargo "+", Add a commodity) gets a follow-up fill once the page has drawn them.
// Returns whether that follow-up fill is coming.
function afterFill(frames, { carrier, page }) {
  persistDoneActions();
  const clicked = frames.some((f) => (f.actions ?? []).length);
  const moved = frames.some((f) => f.navigatedTo || f.advanced || f.halted);
  if (clicked && !moved) setTimeout(() => scheduleAutoFill(page), 900);
  const advanced = frames.find((f) => f.advanced && f.signatureBefore != null);
  if (advanced) {
    const doneKey = advanced.stepKey ? stepScope(page, carrier) + advanced.stepKey : null;
    if (doneKey) state.doneSteps.add(doneKey);
    watchNextStep(carrier, page, advanced.signatureBefore, doneKey);
  }
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
// `doneKey`: the continued step's entry in state.doneSteps (see stepScope).
async function watchNextStep(carrier, page, before, doneKey = null) {
  const tabId = state.tab?.id;
  if (!$('auto-followups').checked && !$('auto-pages').checked) return;
  let last = null;
  let unchanged = 0;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page || !state.intake) return;
    let now = null;
    try {
      // While the page saves / reloads (its loading overlay) the step isn't ready yet.
      const results = await runKit(tabId, carrier, () => (globalThis.__raterKit.busy() ? null : globalThis.__raterKit.signature()));
      now = results.find((r) => r.frameId === 0)?.result ?? null;
    } catch { return; }
    if (now != null && now !== before && now === last) {
      if (state.filling) state.pagePending = page;
      else fillPage({ auto: 'page' });
      return;
    }
    unchanged = now != null && now === before ? unchanged + 1 : 0;
    if (unchanged >= 20 && doneKey && !state.filling && !state.advanceRetried.has(doneKey)) {
      state.advanceRetried.add(doneKey);
      state.doneSteps.delete(doneKey);
      fillPage({ auto: 'page' });
      return;
    }
    last = now;
  }
}

async function ignoreReview(key, tabId, page) {
  if (!key || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const keys = state.agentKeys.get(editScope(page)) ?? new Set();
  keys.add(key);
  state.agentKeys.set(editScope(page), keys);
  await persistAgentKeys();
  await fillPage();
}

// After a fill: a summary card, then one list of everything left for the agent on this page
// (each item with its × and, once the AI has looked, its suggestion), then what was filled.
function renderReport(frames) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const filled = all('filled');
  const failed = all('failed');
  const kept = all('kept');
  const fields = frames.reduce((n, f) => n + (f.fields ?? 0), 0);
  const box = $('report');
  const tabId = state.tab?.id;
  const page = pageOf(state.tab?.url);
  box.className = 'report';
  // A page of tiles only (Most Common Vehicles) has no fields but may still need the agent.
  if (!fields && !all('actions').length && !all('noData').length) {
    const halted = frames.find((f) => f.halted);
    box.replaceChildren(h('p', { class: halted ? 'error' : 'muted center' }, halted ? `Automatic filling and helpers paused. ${halted.reason ?? 'Review this page before retrying.'}` : 'No form fields found on this page.'));
    return;
  }
  const unknownKeys = new Set(all('unknown').map((x) => x.key));
  const needs = [
    ...all('unknown').map((x) => ({ ...x, mark: 'needs', why: `Unfamiliar question${x.required ? ' (required)' : ''}: no TNI rule for it yet.` })),
    ...failed.map((x) => ({ ...x, mark: 'failed', why: `Couldn't fill: ${x.reason}` })),
    ...all('noData').map((x) => ({ ...x, mark: 'needs', why: x.note ?? 'Not on the intake.' })),
    ...all('leftRequired').filter((x) => !unknownKeys.has(x.key)).map((x) => ({ ...x, mark: 'needs', why: 'Required, and not on the intake.' })),
    ...kept.filter((x) => x.differs).map((x) => ({ ...x, mark: 'needs', why: 'The page already had a different value than the intake; it was kept.' })),
    // Defaults filled for the agent to confirm (e.g. marital status missing on the intake).
    ...all('checks').map((x) => ({ ...x, mark: 'needs', why: x.note })),
  ];
  const waiting = all('blocked');
  const advanced = frames.find((f) => f.advanced)?.advanced;
  // A page note may depend on the intake (Progressive's Rates for an NTL quote).
  const pageNote = state.tab?.carrier?.agentPages?.[page];
  const agentPage = typeof pageNote === 'function' ? pageNote(state.intake?.record ?? {}) : pageNote;
  const pct = fields ? Math.round(((fields - needs.length) / fields) * 100) : 100;
  const need = (x) => h('div', { class: 'need', dataset: { need: `${x.key}|${x.label}` } },
    h('div', { class: 'need-head' },
      h('span', { class: `mark ${x.mark}` }),
      h('div', { class: 'row-text' }, h('b', {}, x.label || x.name), h('span', {}, x.why)),
      x.key ? h('button', { class: 'ignore-review', type: 'button', title: 'Ignore this question and continue', 'aria-label': `Ignore ${x.label || x.name} and continue`, onclick: () => ignoreReview(x.key, tabId, page) }, '×') : null),
    x.options?.length && x.mark === 'failed' ? h('div', { class: 'options' }, `Options: ${x.options.slice(0, 25).join(' · ')}${x.options.length > 25 ? ' · …' : ''}`) : null,
    h('div', { class: 'ai-slot' }),
    h('div', { class: 'need-note' }, 'Answer it on the page.'));
  // Answers an earlier pass on this page filled (a follow-up pass, after the VIN lookup or a
  // redraw, finds them already there): still ours, shown as filled.
  const earlier = kept.filter((x) => !x.differs && state.filled?.get?.(x.key));
  const doneRows = [
    ...filled.map((x) => [x.label || x.name, x.shown ?? '']),
    ...earlier.map((x) => [x.label || x.name, state.filled.get(x.key).shown || 'filled']),
    ...all('actions').map((x) => ['Clicked', x.text || x.id]),
    ...kept.filter((x) => !x.differs && !earlier.includes(x)).map((x) => [x.label || x.name, 'left as the page had it']),
    ...all('skipped').map((x) => [x.label, 'ignored']),
  ];
  // The carrier probably changed this page (pagekit: a known field renamed, or most questions
  // unfamiliar). The rest still filled; Continue waits for the agent.
  const renamedNames = all('renamed').map((x) => '"' + x.name + '"').join(', ');
  const pageChanged = frames.some((f) => f.pageChanged)
    ? (state.tab?.carrier?.name ?? 'The carrier') + ' seems to have changed this page: ' + all('unknown').length + " question(s) aren't known"
      + (renamedNames ? ', and ' + renamedNames + " moved to a field the extension doesn't know" : '')
      + ". They're left for you and Continue waits. Please report it (a Capture page layout helps)."
    : null;
  box.replaceChildren(...[
    agentPage ? h('p', { class: 'agent-page' }, agentPage) : null,
    frames.some((f) => f.halted) ? h('p', { class: 'card bad' }, `Filling stopped: ${frames.find((f) => f.halted).reason ?? ''} Check the page, then click Fill this page to retry.`) : null,
    pageChanged ? h('p', { class: 'card bad' }, pageChanged) : null,
    h('div', { class: 'card summary' },
      h('div', { class: 'summary-line' }, h('b', {}, `Filled ${filled.length + earlier.length} of ${fields} questions`),
        h('span', { class: 'small muted' }, advanced ? `Clicked "${advanced}"` : needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : 'Nothing left for you')),
      h('div', { class: 'bar' }, h('div', { style: `width: ${pct}%` })),
      h('div', { class: 'legend' },
        h('span', {}, h('span', { class: 'mark filled' }), 'Filled'),
        h('span', {}, h('span', { class: 'mark needs' }), 'Needs you'),
        h('span', {}, h('span', { class: 'mark failed' }), "Couldn't fill"),
        h('span', {}, h('span', { class: 'mark ai' }), 'AI answer'))),
    needs.length ? h('div', { class: 'eyebrow needs-head' }, 'Needs you on this page') : null,
    ...needs.map(need),
    waiting.length ? h('div', { class: 'card quiet small' }, h('b', {}, 'Buttons waiting'), h('span', { class: 'muted' }, waiting.map((x) => `${x.id.replace(/:\d+$/, '')}${x.why?.startsWith('waiting for ') ? ` (${x.why})` : ''}`).join('; '))) : null,
    doneRows.length ? h('details', { class: 'more' },
      h('summary', {}, h('span', { class: 'arrow' }, '›'), h('span', { class: 'grow' }, 'See what was filled'), h('span', { class: 'small muted' }, String(filled.length + earlier.length))),
      h('div', { class: 'more-body' }, doneRows.map(([k, v]) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v))))) : null,
  ].filter((node) => node != null && node !== false));
}

async function clearMarks() {
  if (!state.tab?.carrier) return;
  await runKit(state.tab.id, state.tab.carrier, () => globalThis.__raterKit.clear());
  $('report').replaceChildren();
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
async function captureFromShortcut() {
  const [mine, focused] = await Promise.all([chrome.windows.getCurrent(), chrome.windows.getLastFocused()]).catch(() => [null, null]);
  if (mine && focused && mine.id !== focused.id) return;
  capturePage();
}

async function capturePage() {
  if (!state.tab?.carrier) {
    $('report').replaceChildren(h('p', { class: 'muted small' }, 'Open a carrier page to capture its layout.'));
    return;
  }
  // Client details are redacted with the loaded intake's names and numbers: without one, nothing
  // on the page or typed in the scenario and note would be.
  if (!state.intake?.record) {
    $('report').replaceChildren(h('p', { class: 'muted small' }, 'Load the client\'s intake first, so their details can be redacted from the capture.'));
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
      $('report').replaceChildren(h('p', { class: 'error' }, 'The page, vehicle or driver changed while it was being captured. Nothing was saved; capture again.'));
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
    $('report').replaceChildren(h('p', { class: 'muted small' },
      `Saved capture ${n} of "${scenario}" (${frames.reduce((k, f) => k + f.controls.length, 0)} fields${top?.openLists?.length ? ', an open list' : ''}) to your Downloads. No typed values; client names and numbers are [client]. Move it to layouts/ (kept out of git) and skim it before sharing.`));
  } catch (e) {
    $('report').replaceChildren(h('p', { class: 'error' }, `Couldn't capture this page: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------------------------
// Luna assistant: after a fill, suggests answers for the questions left for the agent.
// Verified choices can be applied automatically, but Continue waits for explicit agent review.

async function aiSettings() {
  return settingsFrom(await usage.settings());
}

// Luna reads the claims box once per intake (reviewNotes in src/ai/luna.js): lines that may name
// non-trucking liability or ask for a coverage change become Check intake items, and the tab
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
  const mention = ntlMention(intake.record.claims?.text);
  const i = intake.warnings.findIndex((w) => w.code === 'coverage.ntl');
  if (mention && i < 0) intake.warnings.push({ code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) });
  else if (mention && intake.warnings[i].msg !== ntlCheckMessage(mention)) {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) };
    uncheck(i);
  } else if (!mention && i >= 0 && intake.warnings[i].level === 'check') {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'info', msg: 'The claims box no longer mentions non-trucking liability (NTL).' };
  }
  intake.warnings.forEach((w, j) => { if (['ai.claims-truncated', 'ai.claims-review-failed'].includes(w.code)) uncheck(j); });
  save();
  render();
}

// The long-claims-box item is the code's own: it stays while the box is still too long to read whole.
function supersedeClaimsItems(intake) {
  const truncated = claimsTruncated(intake.record.claims?.text);
  intake.warnings.forEach((w, i) => {
    if (['ai.ntl', 'ai.coverage-change'].includes(w.code) || (w.code === 'ai.claims-truncated' && !truncated)) {
      if (w.code === 'ai.ntl' && intake.record.claims) intake.record.claims.aiNtl = false;
      intake.warnings[i] = { code: 'ai.claims-superseded', path: w.path, level: 'info', msg: `Earlier Luna item, for a claims box since edited: ${w.msg}` };
    }
  });
}

function claimsContext(record) {
  const { ntl, ...coverage } = record.coverage ?? {};
  return JSON.stringify([record.claims?.text ?? null, coverage]);
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
  if (!intake?.record.claims?.text || intake.notesReview?.done || (intake.notesReview?.failed && !retry)) return;
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
      if (failed >= 0) intake.warnings[failed] = { code: 'ai.claims-reviewed', path: 'claims.text', level: 'info', msg: 'Luna reviewed the claims box after an earlier failure.' };
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
      if (failed < 0) intake.warnings.push({ code: 'ai.claims-review-failed', path: 'claims.text', level: 'check', msg: "Luna couldn't review the claims box. Read it yourself for coverage requests, such as non-trucking liability (NTL) or a different limit." });
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
    holder.append(h('p', { class: 'muted small' }, `${provider.name} needs an OpenAI API key. Add it in Agent options.`));
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
  const dropped = (what, next = 'Click Fill this page to ask again.') => {
    if (!holder.isConnected) return;
    if (run !== state.aiRun) { holder.remove(); return; }
    holder.replaceChildren(h('p', { class: 'card bad small' }, `${provider.name}: ${what}. ${next}`));
  };
  // Reuse an answer for the same question (as the page shows it now) in the same intake and
  // driver/vehicle, model and policy. Not keyed on the rest of the page: every automatic
  // follow-up fill changes that, which asked the assistant again each time. Putting an answer in still
  // checks the page snapshot (applyAi), and approving checks it again.
  const onPage = frames.flatMap(f => f.filled ?? []).map(x => ({ question: x.label, answer: x.shown, controlKind: x.controlKind }));
  const contextHash = aiFingerprint(ctx.contextKey);
  const sigOf = x => aiCacheSignature({ tabId: ctx.tabId, page: ctx.page, model: cfg.model, policy: provider.policy, contextHash, itemHash: aiItemFingerprint(x), quoteHash: aiFingerprint(ctx.tabUrl) });
  const missing = items.filter((x) => !state.aiCache.has(sigOf(x)));
  if (missing.length) {
    holder.replaceChildren(h('p', { class: 'ai-wait' }, `Asking ${provider.name} about ${missing.length} question${missing.length === 1 ? '' : 's'} left for you…`));
    const started = Date.now();
    const context = { record, carrier: ctx.carrier.id, page: ctx.page, active, onPage };
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
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
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
  if (state.filling) return false;
  if (state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page) return false;
  if (ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return false;
  if (ctx.run !== undefined && ctx.run !== state.aiRun) return false;
  list = list.filter(x => ['radio', 'select', 'checkbox'].includes(x.controlKind) && !x.leave && !agentEdited(ctx.page, x.key) && (decision !== 'auto' || x.autoOk));
  if (!list.length || !aiActionCurrent(ctx, list)) return false;
  const isCurrent = () => aiActionCurrent(ctx, list)
    && ctx.contextKey === assistContextKey(state.intake?.record, state.active)
    && (ctx.run === undefined || ctx.run === state.aiRun);
  const entries = [...state.aiCache].filter(([, x]) => list.includes(x));
  let dispatched = false, prepared = false;
  state.filling = true;
  await tellRecorder('pause', ctx.tabId);
  try {
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
    dispatched = true;
    // One frame's answers at a time (each question is in exactly one frame): an agent edit caught
    // in one frame (a protected item) stops the answers of the frames still to come, as answer()
    // stops its own. With several frames, a frame's items count only for its own questions; the
    // other frames answer "not on this page" or, their page changed by the earlier answers,
    // "the page changed", and protected items count from any frame.
    const byFrame = new Map();
    list.forEach((x, i) => {
      const frameId = aiSnapshotFieldMatches(current, x)[0].frame.frameId;
      byFrame.set(frameId, [...(byFrame.get(frameId) ?? []), answers[i]]);
    });
    const results = [];
    let halted = false;
    for (const [frameId, group] of byFrame) {
      if (halted) {
        for (const a of group) results.push({ key: a.key, label: a.label, ok: false, reason: 'an agent edit interrupted applying the answers; review the page, then request fresh suggestions' });
        continue;
      }
      const answerFrames = await runKit(ctx.tabId, ctx.carrier, (a, snapshots) => globalThis.__raterKit.answer(a, snapshots), [group, ctx.snapshots.map(r => r.result)]);
      const items = answerFrames.flatMap((frame) => (Array.isArray(frame.result) ? frame.result : [])
        .filter(result => result && typeof result === 'object')
        .map(result => ({ ...result, frameId: frame.frameId, documentId: frame.documentId })));
      halted = items.some(r => r.protected);
      results.push(...(byFrame.size > 1 ? items.filter(r => r.frameId === frameId || r.protected) : items));
    }
    const sameContext = isCurrent();
    const keys = sameContext ? state.agentKeys.get(editScope(ctx.page)) ?? new Set() : null;
    // The agent's own edits while the answers went in (also on a control the carrier redrew, which
    // the recorder cannot match on resume): a later fill keeps them, as after a fill.
    const protectedKeys = results.filter(r => r.protected).map(r => r.key);
    for (const x of list) {
      const mine = results.filter((r) => r.key === x.key && r.label === x.label);
      const ok = mine.find((r) => r.ok);
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
    if (sameContext) {
      for (const key of protectedKeys) keys.add(key);
      state.agentKeys.set(editScope(ctx.page), keys);
      if (protectedKeys.length) persistAgentKeys();
    }
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

// Each suggestion goes on its item in "Needs you on this page" (AI suggests …, Use this answer /
// No thanks). Above the list: the approval card for answers the AI picked itself, Accept all,
// and any suggestion whose item isn't on the list.
function renderAi(holder, suggestions, ctx) {
  const rerender = () => { if (holder.isConnected) renderAi(holder, suggestions, ctx); };
  const act = async (list, decision, button) => {
    if (state.filling) { $('ai-note').textContent = 'Wait for the fill to finish, then try again.'; return; }
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
        x.confirmError = 'The current page answer changed; review it before continuing.';
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
    'Luna evidence check passed · agent review required',
  ].filter(Boolean).join(' · ');
  const answer = (x) => (x.controlKind === 'text' ? `typing “${x.choice}”` : `“${x.choice}”`);
  // What goes on an item: the suggestion and its buttons, or what happened to it.
  const box = (x) => {
    if (x.manual) return h('div', { class: 'ai-done' }, 'You changed this answer on the page.');
    if (x.rejected) return h('div', { class: 'ai-done bad' }, x.confirmError ?? (x.retired ? 'Saved answer from a retired assistant: review the current page answer.' : 'AI answer rejected: answer it on the page.'));
    if (x.error) return h('div', { class: 'ai-done bad' }, `The page didn't take the AI answer (${x.error}). Answer it on the page.`);
    if (x.done === 'auto' && !x.approved) return h('div', { class: 'ai-box' }, h('div', { class: 'ai-says' }, 'Picked by the AI: ', h('b', {}, x.choice)), h('div', { class: 'ai-tip' }, 'Approve or reject it above.'));
    if (x.done) return h('div', { class: 'ai-done' }, h('b', {}, '✓'), h('span', { class: 'grow' }, `Put in ${answer(x)} (purple on the page). Change it on the page if needed.`));
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
  const report = $('report');
  const orphans = [];
  for (const x of suggestions) {
    const item = [...report.querySelectorAll('.need')].find((n) => n.dataset.need === `${x.key}|${x.label}`);
    const slot = item?.querySelector('.ai-slot');
    const content = box(x);
    if (slot) {
      slot.replaceChildren(...(content ? [content] : []));
      // "Answer it on the page" only while nothing (AI or agent) has answered it.
      item.querySelector('.need-note').hidden = !!x.done || (!!content && !x.leave && x.applyable && !x.dismissed && !x.rejected && !x.error);
    } else if (content) orphans.push(h('div', { class: 'need' }, h('div', { class: 'row-text' }, h('b', {}, x.label)), content));
  }
  holder.replaceChildren(...[
    pending.length ? h('div', { class: 'ai-approve' },
      h('p', { class: 'ai-approve-title' }, `The AI picked ${pending.length} answer${pending.length === 1 ? '' : 's'} on this page`),
      h('p', { class: 'small muted' }, rejectedPending.length
        ? 'Continue waits until you confirm the current page answer to accept the carrier value, or change it on the page.'
        : canContinue ? 'Continue waits until you approve them.' : 'Check them (purple on the page), then approve.'),
      h('ul', {}, pending.map((x) => h('li', {},
        h('span', {}, h('b', {}, x.label), ' ← ', x.choice,
          x.retired ? h('span', { class: 'small muted' }, ' (saved by a retired assistant; review the current page answer)') : null,
          (x.contextKey ? x.contextKey !== current : x.contextHash !== currentHash) ? h('span', { class: 'small muted' }, ' (picked before you changed the intake or the driver/vehicle)') : null),
        x.rejected
          ? h('button', { type: 'button', class: 'link small ai-reject', onclick: () => confirmRejected([x]) }, 'Confirm the current page answer')
          : h('button', { type: 'button', class: 'link small ai-reject', onclick: () => decide([x], 'rejected') }, 'Reject')))),
      h('div', { class: 'ai-actions' },
        awaiting.length ? h('button', { type: 'button', class: 'primary accept', onclick: () => decide(awaiting, 'approved') }, canContinue ? 'Approve and continue' : `Approve ${awaiting.length === 1 ? 'it' : `all ${awaiting.length}`}`) : null,
        rejectedPending.length ? h('button', { type: 'button', class: 'ghost', onclick: () => confirmRejected(rejectedPending) }, canContinue ? 'Confirm and continue' : 'Confirm the current page answer') : null)) : null,
    sure.length > 1 ? h('div', { class: 'ai-actions' }, h('button', { type: 'button', class: 'ghost', onclick: (e) => act(sure, 'accepted', e.target) }, `Use all ${sure.length} AI answers`)) : null,
    ...orphans,
  ].filter(Boolean));
}

function wireAgentPopover() {
  const button = $('agent-btn');
  const popover = $('agent-popover');
  const settingsTrigger = $('settings-agent');
  button.addEventListener('click', (e) => {
    if (state.agentPopoverOpen) closeAgentPopover();
    else openAgentPopover({ trigger: e.currentTarget });
  });
  $('close-agent').addEventListener('click', () => closeAgentPopover());
  settingsTrigger.addEventListener('click', (e) => openAgentPopover({ trigger: e.currentTarget }));
  const outside = target => !popover.contains(target) && !button.contains(target) && !settingsTrigger.contains(target);
  for (const event of ['pointerdown', 'focusin']) {
    document.addEventListener(event, (e) => {
      if (state.agentPopoverOpen && outside(e.target)) closeAgentPopover({ restore: false });
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.agentPopoverOpen) return;
    e.preventDefault();
    closeAgentPopover();
  });
}

function wireAi() {
  const save = async patch => {
    state.aiRun++;
    if (Object.hasOwn(patch, 'lunaKey')) {
      for (const [key, value] of state.aiCache) if (!value.done) state.aiCache.delete(key);
    }
    // Keep pending approvals; their cache keys remain bound to the original model and context.
    await usage.saveSettings(patch);
    await renderAiSettings();
    // Luna just turned on or got a key: read the open intake's claims box if not done yet.
    reviewClaimsBox({ retry: true });
  };
  $('ai-on').addEventListener('change', (e) => save({ aiOn: e.target.checked }));
  $('ai-auto').addEventListener('change', (e) => save({ lunaAuto: e.target.checked }));
  $('ai-openai-key').addEventListener('change', (e) => save({ lunaKey: e.target.value.trim() }));
}

async function renderAiSettings() {
  const cfg = await aiSettings();
  const provider = PROVIDERS[cfg.provider];
  const saved = await usage.settings();
  $('ai-on').checked = cfg.on;
  $('ai-auto').checked = cfg.auto;
  $('ai-auto').disabled = !cfg.on || !provider.automatic;
  $('ai-auto-option').hidden = !provider.automatic;
  if (document.activeElement !== $('ai-openai-key')) $('ai-openai-key').value = saved.lunaKey || '';
  $('ai-model').disabled = true;
  $('ai-model').placeholder = provider.defaultModel;
  if (document.activeElement !== $('ai-model')) $('ai-model').value = cfg.model;
  $('agent-btn').dataset.on = String(cfg.on);
  $('agent-btn').title = cfg.on
    ? (cfg.apiKey ? `${provider.name} assistant on · ${cfg.model}` : `${provider.name} assistant on · ${provider.keyLabel} needed`)
    : `${provider.name} assistant off`;
  $('settings-agent-name').textContent = `${provider.name} assistant`;
  $('agent-name').textContent = provider.name;
  $('agent-provider').textContent = provider.company;
  $('agent-model').textContent = cfg.model;
  $('agent-status').dataset.on = String(cfg.on);
  $('ai-note').textContent = !cfg.on ? 'Off · Turn on when you need help.' : !cfg.apiKey ? `On, but needs ${provider.keyLabel}.` : `On · ${cfg.model}${cfg.auto ? ' · picks answers, you approve them before Continue' : ' · suggestions only'}`;
  $('ai-privacy').textContent = `Relevant intake facts, page context and TNI rules are sent to ${provider.company} with your key. Keys are saved on this device. Missing facts stay unanswered. Report orders, exclusions, signatures and payment fields stay with you.`;
  renderUsage();
}

// ---------------------------------------------------------------------------------------------
// Usage log panel and problem reports

async function renderUsage() {
  const n = await usage.count();
  const { agent = '', serverToken = '' } = await usage.settings();
  const { serverUrl } = await usage.serverConfig();
  $('usage-count').textContent = (n
    ? `${n.toLocaleString()} event${n === 1 ? '' : 's'} waiting on this computer`
    : 'Nothing waiting on this computer.')
    + (state.layoutErrors ? ` ${state.layoutErrors} page layout${state.layoutErrors === 1 ? '' : 's'} couldn't be read (logged for review).` : '');
  const up = usage.lastUpload();
  const when = up.at ? new Date(up.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  $('upload-status').textContent = {
    ok: `Uploaded to the server at ${when}.`,
    error: `Upload failed at ${when}: ${up.message}. Events stay here and are retried every minute.`,
    off: 'No server set: use Export log to hand in the usage log.',
    idle: serverUrl ? `Uploads to ${serverUrl} every minute.` : '',
  }[up.state] ?? '';
  $('upload-status').className = `small${up.state === 'ok' ? ' ok' : up.state === 'error' ? ' bad' : ''}`;
  for (const [id, v] of [['agent', agent], ['server-url', serverUrl], ['server-token', serverToken]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  $('recording').hidden = !state.intake;
  $('foot-version').hidden = !!state.intake;
  renderHealth({ n, agent, serverUrl, up });
}

// The version this browser is running, and setup problems that otherwise go unnoticed until a
// review shows missing data: an old build, the usage server down, no initials, no AI key.
async function renderHealth({ n, agent, serverUrl, up }) {
  const version = inExtension ? chrome.runtime.getManifest().version : 'dev';
  $('version').textContent = `Version ${version}`;
  $('foot-version').textContent = `v${version}`;
  const ai = await aiSettings();
  // Things the agent fixes (one card, a button each) and things that need nothing from them.
  const setup = [
    !agent && { title: 'Add your initials', text: 'So your quotes are counted as yours.', button: 'Add', go: () => openSettings('agent') },
    ai.on && !ai.apiKey && { title: 'AI suggestions need a key', text: `They're turned on, but no ${PROVIDERS[ai.provider].keyLabel} is set.`, button: 'Add key', go: () => openSettings('ai-openai-key') },
    up.state === 'off' && { title: 'Usage log has no server', text: 'Nothing is recorded centrally (Export log only).', button: 'Set up', go: () => openSettings('server-url') },
  ].filter(Boolean);
  // Events that can't even be saved here are lost: that comes first.
  const saved = usage.lastSave();
  const info = saved.state === 'error'
    ? { title: "Usage log can't be saved on this computer", text: `What you do now isn't recorded (${saved.message}). Use Export log in settings (Advanced), then tell TNI.` }
    : up.state === 'error'
      ? { title: "Usage log can't upload right now", text: `Nothing for you to do. ${n ? `${n.toLocaleString()} event${n === 1 ? ' is' : 's are'} saved on this computer and` : 'What happens is saved on this computer and'} sent when the server is back.` }
      : null;
  const cards = () => [
    setup.length ? h('div', { class: 'setup' },
      h('div', { class: 'setup-head' }, `Finish setting up (${setup.length})`),
      setup.map((x) => h('div', { class: 'setup-row' },
        h('div', { class: 'row-text' }, h('b', {}, x.title), h('span', {}, x.text)),
        h('button', { type: 'button', class: 'ghost', onclick: x.go }, x.button)))) : null,
    info ? h('div', { class: 'notice' }, h('div', { class: 'row-text' }, h('b', {}, info.title), h('span', {}, info.text))) : null,
  ].filter(Boolean);
  $('home-notices').replaceChildren(...cards());
  $('check-notices').replaceChildren(...cards());
  $('fill-notices').replaceChildren(...cards());
  $('settings-dot').hidden = !setup.length;
  // The welcome text is for a panel that's ready to use.
  $('intro').hidden = !!setup.length;
  $('next-steps').hidden = !!setup.length;
}

async function uploadNow() {
  await usage.upload();
  renderUsage();
}

function wireUsage() {
  $('auto-followups').addEventListener('change', (e) => usage.saveSettings({ autoFollowUps: e.target.checked }));
  $('auto-pages').addEventListener('change', (e) => usage.saveSettings({ autoPages: e.target.checked }));
  $('auto-advance').addEventListener('change', (e) => usage.saveSettings({ autoAdvance: e.target.checked }));
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
      ? `${n} events are waiting here and haven't been uploaded or exported. Delete them anyway?`
      : `Delete the ${n} exported events from this computer?`;
    if (!confirm(msg)) return;
    await usage.clearLog();
    $('usage-note').textContent = 'Usage log cleared.';
    renderUsage();
  });
  $('report-problem').addEventListener('click', () => {
    $('problem-form').hidden = !$('problem-form').hidden;
    if (!$('problem-form').hidden) $('problem-text').focus();
  });
  $('send-problem').addEventListener('click', () => {
    const text = $('problem-text').value.trim();
    if (!text) return;
    const redact = state.intake ? redactor(redactionTerms(state.intake.record)) : (x) => x;
    usage.log({ type: 'problem_report', carrier: state.tab?.carrier?.id ?? null, page: state.tab?.url ? pageOf(state.tab.url) : null, text: redact(text).slice(0, 1000) });
    $('problem-text').value = '';
    $('problem-form').hidden = true;
    $('usage-note').textContent = 'Thanks — saved with the usage log.';
  });
  setInterval(renderUsage, 5000);
}

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  const drop = $('load');
  $('choose').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
  drop.addEventListener('click', () => $('file').click());
  $('settings-btn').addEventListener('click', () => { closeAgentPopover({ restore: false }); state.settingsOpen = !state.settingsOpen; showScreen(); });
  $('settings-done').addEventListener('click', () => { closeAgentPopover({ restore: false }); state.settingsOpen = false; showScreen(); });
  $('tab-check').addEventListener('click', () => setStep('check'));
  $('tab-fill').addEventListener('click', () => setStep('fill'));
  $('go-fill').addEventListener('click', () => setStep('fill'));
  $('replace').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  for (const t of [document.body]) {
    t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    t.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
    t.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
    t.addEventListener('dragover', () => { if (!state.intake) $('load-error').hidden = true; });
  }
  $('clear-client').addEventListener('click', async () => {
    usage.log({ type: 'intake_closed', reason: 'cleared' });
    cancelLayouts();
    holdLayouts();
    resetViews();
    state.intake = null;
    usage.restoreSession(null);
    await store.remove('intake');
    await store.remove('session');
    await persistAiPending();
    await clearAgentKeys();
    $('report').replaceChildren();
    render();
  });
  $('fill').addEventListener('click', () => fillPage());
  $('unmark').addEventListener('click', clearMarks);
  $('capture').addEventListener('click', capturePage);
  // Alt+Shift+C (manifest "commands"): a capture without leaving the page, e.g. with a list open.
  if (inExtension) chrome.commands?.onCommand.addListener((command) => { if (command === 'capture-page') captureFromShortcut(); });
  wireAgentPopover();
  wireUsage();
  wireAi();
  if (inExtension) {
    chrome.runtime.onMessage.addListener(onRecorderMessage);
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onCreated.addListener((tab) => { if (state.layoutHold) state.layoutNewTabs.add(tab.id); inheritQuoteState(tab); });
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  wire();
  // An intake saved by an earlier panel: while the panel was closed the tabs may have moved to
  // another client's quote, so their layouts wait as after loading one (holdLayouts).
  holdLayouts();
  state.intake = (await store.get('intake')) ?? null;
  state.active = (await store.get('active')) ?? state.active;
  usage.restoreSession((await store.get('session')) ?? null);
  const views = await store.get('views');
  if (views?.session && views.session === usage.currentSession()?.id) state.viewTabs = new Map(views.tabs);
  await restoreAiPending();
  const saved = await usage.migrateAssistantSettings();
  $('auto-followups').checked = saved.autoFollowUps ?? true;
  $('auto-pages').checked = saved.autoPages ?? false;
  $('auto-advance').checked = saved.autoAdvance ?? true;
  uploadNow();
  render();
  renderUsage();
  renderAiSettings();
  reviewClaimsBox();
  await refreshTab();
}

init();
