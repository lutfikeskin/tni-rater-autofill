import * as pdfjs from '../lib/pdf.min.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseEdit } from '../src/normalize.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { get, set, STATES } from '../src/util.js';
import { intakeSummary, fieldChangeEvent, fillEvents, redactor } from '../src/usage.js';
import * as usage from './usage-log.js';
import { collectItems, AssistError, assistContextKey } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION } from '../src/ai/luna.js';
import { PROVIDERS, settingsFrom, suggest } from '../src/ai/providers.js';

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
function aiItemFingerprint(x) {
  return aiFingerprint([x.key, x.label, x.section, x.current, x.options, x.status, x.reason,
    x.reviewOnly, x.manualOnly, x.fieldType]);
}
let aiPersistQueue = Promise.resolve();

const $ = (id) => document.getElementById(id);
const state = {
  intake: null, // { record, warnings, stats, fileName, done: number[] }
  active: { drivers: 0, vehicles: 0, trailers: 0 },
  tab: null, // { id, url, carrier }
  // What autofill put in each field on the current tab (field key -> { path, shown }), so the
  // usage log can tell the agent's corrections apart from agreement.
  filled: new Map(),
  // Question text per field key, from the fill engine (better than the recorder's guess).
  labels: new Map(),
  // Automatic follow-up fills: pages the agent has filled in this tab, and per page the fields
  // the agent changed themselves (never refilled automatically).
  autoPages: new Set(),
  // "page|step" of one-address applications already continued from (AmWINS steps).
  doneSteps: new Set(),
  advanceRetried: new Set(), // steps whose lost Continue was clicked a second time (once each)
  tabSessions: new Map(),
  agentKeys: new Map(),
  filling: false,
  autoTimer: null,
  autoPending: false,
  autoPaused: false,
  layoutsSent: new Set(),
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

function aiCacheSignature({ tabId, page, model, policy = POLICY_VERSION, contextHash, itemHash }) {
  return [tabId, page, model, policy, contextHash, itemHash].join('\n');
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
    if (t !== String(tabId) || p !== page || x.key !== item.key) continue;
    if (aiDecisionBlocks(x)) return true;
    if (x.manual || x.confirmed || x.approved) return true;
    if (x.rejected && (item.current === x.choice || (item.current != null && item.current !== ''))) return true;
  }
  return false;
}

function aiPendingRecord(sig, x, scope) {
  const [tabId, page, model, policy, contextHash, itemHash] = sig.split('\n');
  return {
    version: 1, scope, tabId: Number(tabId), page, model, policy, contextHash, itemHash,
    key: x.key, label: aiSafeText(x.label), choice: aiSafeText(x.choice), controlKind: x.controlKind,
    done: x.done, approved: !!x.approved, rejected: !!x.rejected, manual: !!x.manual, confirmed: !!x.confirmed,
    fieldHash: x.fieldHash ?? (x.restored ? null : aiFingerprint([x.key, x.label, x.choice])),
    snapshotHash: x.snapshotHash ?? (x.snapshots ? aiFingerprint(x.snapshots) : null),
  };
}

function persistAiPending() {
  const task = aiPersistQueue.then(async () => {
    const scope = usage.currentSession()?.intakeId;
    if (!scope) return;
    const records = [...state.aiCache.entries()]
      .filter(([, x]) => x.done === 'auto' && !x.approved)
      .map(([sig, x]) => aiPendingRecord(sig, x, scope));
    const existing = await aiPendingStore.get();
    const otherScopes = existing.filter((x) => x?.scope && x.scope !== scope);
    await aiPendingStore.set([...otherScopes, ...records].slice(-200));
  });
  aiPersistQueue = task.catch(() => {});
  return task;
}

async function restoreAiPending() {
  const scope = usage.currentSession()?.intakeId;
  if (!scope) return;
  const all = await aiPendingStore.get();
  const records = all.filter((x) => x?.scope === scope && Number.isInteger(x.tabId) && x.page && x.itemHash && x.contextHash);
  for (const x of records) {
    const retired = x.model !== DEFAULT_MODEL || x.policy !== POLICY_VERSION;
    state.aiCache.set(aiCacheSignature(x), {
      ...x, restored: true, retired, provider: 'luna', done: 'auto', approved: !!x.approved,
      rejected: !!x.rejected || (retired && !x.approved && !x.manual && !x.confirmed),
      manual: !!x.manual, confirmed: !!x.confirmed, tip: '', checks: [], leave: false,
      applyable: true, autoOk: !retired, contextKey: null, snapshots: null,
    });
  }
  if (records.length !== all.length) await aiPendingStore.set(records);
}

function clearAiPending() {
  const task = aiPersistQueue.then(() => aiPendingStore.set([]));
  aiPersistQueue = task.catch(() => {});
  return task;
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
  return task;
}

// Durable decisions store display text separately from the exact live-value fingerprint.
function aiCurrentAnswerPresent(frames, x) {
  const fields = frames.flatMap(frame => {
    try { return JSON.parse(frame.result)[1] ?? []; } catch { return []; }
  });
  const field = fields.find(field => field.key === x.key);
  if (!field) return false;
  if (x.fieldHash) return aiFingerprint([field.key, field.label, field.current]) === x.fieldHash;
  // Upgrade compatibility: old records have only a whole-page fingerprint. An unchanged page
  // or an exact unredacted match still proves the selected value; display redaction never does.
  return (x.snapshotHash && aiFingerprint(frames) === x.snapshotHash)
    || (field.label === x.label && field.current === x.choice);
}

function settleRejectedAi(page, keys, tabId = state.tab?.id) {
  let changed = false;
  for (const [sig, x] of state.aiCache) {
    const [cachedTab, cachedPage] = sig.split('\n');
    if (cachedTab === String(tabId) && x.done === 'auto' && x.rejected && !x.confirmed && keys.has(x.key) && cachedPage === page) {
      x.manual = true;
      changed = true;
    }
  }
  if (changed) persistAiPending();
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
  state.visitedPages = new Set();
  state.doneSteps = new Set();
  state.advanceRetried = new Set();
  state.intake = { ...result, fileName: file.name, done: [] };
  // Start on Check intake when something on the intake needs a look, else straight on Fill.
  state.step = result.warnings.some((w) => w.level === 'check') ? 'check' : 'fill';
  state.settingsOpen = false;
  state.active = { drivers: 0, vehicles: 0, trailers: 0 };
  state.filled = new Map();
  state.doneActions = new Set();
  state.aiCache.clear();
  await store.set('session', usage.startSession(summary.intakeId));
  await clearAiPending();
  await clearAgentKeys();
  usage.log({ type: 'intake_loaded', ...summary });
  uploadNow();
  await save();
  render();
  refreshTab();
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
    // Log that the agent corrected the intake here (and whether it was flagged), not the value.
    const flaggedCodes = state.intake.warnings.filter((w) => w.path === path).map((w) => w.code);
    usage.log({ type: 'intake_edit', path, kind, change: before == null ? 'added' : after == null ? 'cleared' : 'changed', warnings: flaggedCodes });
    await save();
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
        onclick: async () => { state.active[list] = i; await save(); renderPickers(); },
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
      return;
    }
  }
  if (tab?.id !== state.tab?.id) {
    const keys = ['filled', 'labels', 'autoPages', 'autoPaused', 'agentKeys', 'doneActions', 'visitedPages', 'doneSteps'];
    if (state.tab?.id) state.tabSessions.set(state.tab.id, Object.fromEntries(keys.map((key) => [key, state[key]])));
    const previous = state.tabSessions.get(tab?.id);
    Object.assign(state, previous ?? {
      filled: new Map(), labels: new Map(), autoPages: new Set(), autoPaused: false,
      agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), doneSteps: new Set(),
    });
    clearTimeout(state.autoTimer);
    state.autoPending = false;
  }
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null, background: false } : null;
  await restoreAgentKeys(state.tab?.id);
  renderSite();
  ensureRecorder();
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

function tellRecorder(cmd) {
  if (!state.tab) return Promise.resolve();
  return chrome.tabs.sendMessage(state.tab.id, { ra: 'recorder', cmd }).catch(() => {});
}

function onRecorderMessage(msg, sender) {
  if (msg?.ra !== 'usage' || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier?.id ?? null;
  const log = (...events) => { if (!state.tab.carrier?.practice) usage.log(...events); };
  if (msg.event === 'page_view') {
    if (msg.from) state.visitedPages.add(samePage(msg.from));
    log({ type: 'page_view', carrier, page: msg.page, from: msg.from, fields: msg.fields });
    // Buttons that run again on every new arrival at their page (Print / Send: after the agent goes
    // back and changes something, coming back to print means printing the new quote).
    if (msg.from && samePage(msg.from) !== samePage(msg.page)) {
      for (const a of state.tab.carrier?.actions ?? []) {
        if (a.repeatOnReturn && [].concat(a.page ?? []).includes(samePage(msg.page))) state.doneActions.delete(a.id);
      }
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
    const ctx = { record: state.intake.record, filled: state.filled, labels: state.labels, redact: redactor(redactionTerms(state.intake.record)) };
    log(...msg.changes.map((c) => ({ carrier, page: msg.page, ...fieldChangeEvent(c, ctx) })));
    const byAgent = msg.changes.filter((c) => c.agent);
    if (byAgent.length) {
      const page = samePage(msg.page);
      const keys = state.agentKeys.get(page) ?? new Set();
      byAgent.forEach((c) => keys.add(c.key));
      state.agentKeys.set(page, keys);
      persistAgentKeys();
      const released = settleRejectedAi(page, new Set(byAgent.map((c) => c.key)));
      if (released) syncAiBanner({ tabId: state.tab.id, page, carrier: state.tab.carrier });
      scheduleAutoFill(page);
    }
  }
  if (msg.event === 'new_fields') scheduleAutoFill(samePage(msg.page));
}

// ---------------------------------------------------------------------------------------------
// Automatic follow-up fills: once the agent has filled a page, questions that appear later
// (revealed by an answer, or in a panel that opens) are filled with the intake/standard answers.
// Fields that already have a value, or that the agent changed, are left alone.

// Automatic fills only run on the carrier's quote pages (never e.g. its quote-search page).
const onQuotePage = () => !!state.tab?.carrier && (!state.tab.carrier.autoFillUrl || state.tab.carrier.autoFillUrl.test(state.tab.url ?? ''));

const fillOptions = (carrier, extra = {}) => ({
  optional: carrier.optional ?? [],
  replaceChoices: !!carrier.replaceChoices,
  // Carriers whose pages never wait on a server per answer are filled a round at a time.
  batch: !!carrier.batch,
  // Steps of a one-address application already continued from (a step the agent goes back to
  // isn't continued again).
  doneSteps: [...state.doneSteps].filter((s) => s.startsWith(`${pageOf(state.tab?.url)}|`)).map((s) => s.slice(s.indexOf('|') + 1)),
  // Click the page's Continue when nothing is left for the agent (setting below), but never
  // while the agent hasn't approved the AI's selections on this page.
  advance: $('auto-advance').checked && carrier.advance && !pendingAi(state.tab?.id, pageOf(state.tab?.url)).length ? carrier.advance : null,
  doneActions: [...state.doneActions],
  visitedPages: [...state.visitedPages],
  // Never change what the agent changed on this page, whether the fill is manual or automatic.
  skip: [...(state.agentKeys.get(pageOf(state.tab?.url)) ?? [])],
  ...extra,
});

function scheduleAutoFill(page) {
  if (state.autoPaused || !$('auto-followups').checked || !state.autoPages.has(page) || !onQuotePage()) return;
  if (state.filling) { state.autoPending = true; return; }
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => autoFill(page), 600);
}

async function autoFill(page) {
  // The client may have been cleared while this fill was waiting to run.
  if (state.autoPaused || state.filling || !state.intake || !state.tab?.carrier || pageOf(state.tab?.url) !== page) return;
  const { id: tabId, carrier } = state.tab;
  await pickListItem(carrier, page);
  state.filling = true;
  state.autoPending = false;
  const started = Date.now();
  let assistFrames = null;
  await tellRecorder('pause');
  try {
    const plan = buildPlan(state.intake.record, carrier, state.active);
    const skip = [...(state.agentKeys.get(page) ?? [])];
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, fillOptions(carrier, { overwrite: false, skip, keepMarks: true })]);
    const frames = results.map((r) => r.result).filter(Boolean);
    rememberFill(frames);
    afterFill(frames, { carrier, page });
    const hasWarnings = frames.some((f) => f.unknown?.length);
    if (state.autoPaused || hasWarnings) { renderReport(frames); assistFrames = frames; }
    const n = frames.reduce((k, f) => k + f.filled.length + (f.actions?.length ?? 0), 0);
    if (n || hasWarnings) {
      if (!carrier.practice) usage.log(...fillEvents(frames, { carrier: carrier.id, page, overwrite: false, auto: true, ms: Date.now() - started, redact: redactor(redactionTerms(state.intake.record)) }));
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
  runPendingPage();
  if (assistFrames) runAssist(assistFrames, { tabId, page, carrier });
}

function runPendingPage() {
  const pending = state.pagePending;
  state.pagePending = null;
  if (pending && pending === pageOf(state.tab?.url)) setTimeout(() => fillPage({ auto: 'page' }), 300);
}

// Each page's question layout (ids, question text, options; no answers) goes into the usage
// log once per session, so layouts for every state and product collect themselves as agents
// quote. scripts/build-layouts.mjs turns them into test pages.
async function recordLayout(page) {
  const { id: tabId, carrier } = state.tab;
  if (carrier.practice) return;
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [buildPlan(state.intake.record, carrier, state.active), redactionTerms(state.intake.record)]);
    const buttons = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.buttons ?? []))];
    const fields = results.map((r) => r.result).filter(Boolean).flatMap((f) => f.controls).map((c) => ({
      q: c.q ?? null, kind: c.kind, type: c.type, label: c.label, required: c.required, section: c.section,
      // Element ids (stable ones only) and data-ids: how id-based rules (AmWINS) find the field.
      id: c.id && !/\d{5,}|ext-|-inputEl$/.test(c.id) ? c.id : null, dataId: c.dataId ?? null, name: c.name ?? null,
      // Agency staff lists (agent of record, agent/producer codes) aren't page structure.
      options: c.options?.length && !/agent|producer/i.test(c.label ?? '') ? c.options : undefined, mapped: c.wouldFill ?? null,
    }));
    const signature = `${usage.currentSession()?.id}|${page}|${fields.map((f) => f.q ?? f.label).join(',')}`;
    if (!fields.length || state.layoutsSent.has(signature)) return;
    state.layoutsSent.add(signature);
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
    usage.log({ type: 'page_layout', carrier: carrier.id, page, context, fields, buttons });
  } catch { /* layout capture is best-effort */ }
}

function rememberFill(frames) {
  const page = pageOf(state.tab?.url);
  const keys = state.agentKeys.get(page) ?? new Set();
  for (const key of frames.flatMap((f) => f.protectedKeys ?? [])) keys.add(key);
  state.agentKeys.set(page, keys);
  persistAgentKeys();
  if (frames.some((f) => f.halted)) {
    state.autoPaused = true;
    state.autoPending = false;
    clearTimeout(state.autoTimer);
  }
  for (const id of frames.flatMap((f) => f.invalidatedActions ?? [])) state.doneActions.delete(id);
  for (const a of frames.flatMap((f) => f.actions ?? [])) state.doneActions.add(a.id);
  for (const x of frames.flatMap((f) => f.filled)) state.filled.set(x.key, { path: x.path, shown: x.shown });
  for (const [key, label] of frames.flatMap((f) => f.labels ?? [])) if (label) state.labels.set(key, label);
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
  const canFill = inExtension && !!carrier && !!state.intake;
  $('fill').disabled = !canFill || state.filling;
  if (!state.filling) $('fill').textContent = state.autoPages.has(pageOf(state.tab?.url)) ? 'Fill this page again' : 'Fill this page';
  $('capture').disabled = !(inExtension && carrier);
  $('fill-hint').textContent = !inExtension
    ? 'Filling works when this runs as the Chrome extension.'
    : carrier && state.tab.background ? 'Working on the quote tab in the background. Fill this page fills that tab; go back to it to review.'
    : carrier ? 'Nothing is submitted. Review the page, then click Next yourself.'
      : noAccess
        ? "The browser isn't letting the extension read this page. Allow the extension on this site (click its icon in the toolbar or check its site access in the extensions page), then reload the page."
        : 'Open a Progressive, GEICO or AmWINS quote page to fill it.';
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
  await pickListItem(carrier, page);
  const plan = buildPlan(state.intake.record, carrier, state.active);
  const overwrite = auto ? false : $('overwrite').checked;
  $('fill').disabled = true;
  $('fill').textContent = 'Filling…';
  $('report').replaceChildren(h('p', { class: 'muted small center' }, 'Filling one answer at a time: the page checks each answer with its server. Keep this tab open.'));
  const started = Date.now();
  let assistFrames = null;
  // Our own fills aren't the agent's changes: pause the recorder while filling.
  await ensureRecorder();
  await tellRecorder('pause');
  try {
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, fillOptions(carrier, { overwrite })]);
    const frames = results.map((r) => r.result).filter(Boolean);
    rememberFill(frames);
    state.autoPages.add(page);
    afterFill(frames, { carrier, page });
    recordLayout(page);
    if (!carrier.practice) usage.log(...fillEvents(frames, {
      carrier: carrier.id, page, overwrite, auto, ms: Date.now() - started, redact: redactor(redactionTerms(state.intake.record)),
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
  if (assistFrames && !assistFrames.some((f) => f.halted)) runAssist(assistFrames, { tabId, page, carrier });
}

// On the carrier's vehicle list page, work on the first intake vehicle not added yet (its Add
// Vehicle or VIN lookup not done in this quote). When every vehicle is in, the active one stays
// and nothing is left to add, so the page's Continue is clicked. The driver list works the same
// way (a driver counts as entered once its driver page was filled).
async function pickListItem(carrier, page) {
  const lists = [
    [carrier?.vehicleList, 'vehicles', (i) => ['lookupVin', 'addVehicle'].some((a) => state.doneActions.has(`${a}:${i}`))],
    [carrier?.driverList, 'drivers', (i) => ['driverEntered', 'addDriver'].some((a) => state.doneActions.has(`${a}:${i}`))],
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

// Bookkeeping after a fill: the driver page marks its driver entered; a click that opens more
// questions (cargo "+", Add a commodity) gets a follow-up fill once the page has drawn them.
function afterFill(frames, { carrier, page }) {
  if (carrier.driverPage && carrier.driverPage === page && frames.some((f) => f.filled?.length)) {
    state.doneActions.add(`driverEntered:${state.active.drivers ?? 0}`);
  }
  const clicked = frames.some((f) => (f.actions ?? []).length);
  const moved = frames.some((f) => f.navigatedTo || f.advanced || f.halted);
  if (clicked && !moved) setTimeout(() => scheduleAutoFill(page), 900);
  const advanced = frames.find((f) => f.advanced && f.signatureBefore != null);
  if (advanced) {
    if (advanced.stepKey) state.doneSteps.add(`${page}|${advanced.stepKey}`);
    watchNextStep(carrier, page, advanced.signatureBefore, advanced.stepKey);
  }
}

// After Continue on an application that keeps one address for every step (AmWINS' Save &
// Continue), no page_view comes: wait until the questions on screen have changed (and stopped
// changing), then fill the new step. If the address changes instead, page_view handles it. Never
// fills the old step again, so Continue can't be clicked twice.
// A Continue that didn't take (the page neither moved nor changed for about 6 s, and isn't
// loading) is tried once more: Progressive's Change Payment Plan lost one while it redrew.
async function watchNextStep(carrier, page, before, stepKey = null) {
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
    const retryKey = `${page}|${stepKey}`;
    if (unchanged >= 20 && stepKey && !state.filling && !state.advanceRetried.has(retryKey)) {
      state.advanceRetried.add(retryKey);
      state.doneSteps.delete(retryKey);
      fillPage({ auto: 'page' });
      return;
    }
    last = now;
  }
}

async function ignoreReview(key, tabId, page) {
  if (!key || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const keys = state.agentKeys.get(page) ?? new Set();
  keys.add(key);
  state.agentKeys.set(page, keys);
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
  if (!fields && !all('actions').length) {
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
  const agentPage = state.tab?.carrier?.agentPages?.[page];
  const pct = fields ? Math.round(((fields - needs.length) / fields) * 100) : 100;
  const need = (x) => h('div', { class: 'need', dataset: { need: `${x.key}|${x.label}` } },
    h('div', { class: 'need-head' },
      h('span', { class: `mark ${x.mark}` }),
      h('div', { class: 'row-text' }, h('b', {}, x.label), h('span', {}, x.why)),
      x.key ? h('button', { class: 'ignore-review', type: 'button', title: 'Ignore this question and continue', 'aria-label': `Ignore ${x.label} and continue`, onclick: () => ignoreReview(x.key, tabId, page) }, '×') : null),
    x.options?.length && x.mark === 'failed' ? h('div', { class: 'options' }, `Options: ${x.options.slice(0, 25).join(' · ')}${x.options.length > 25 ? ' · …' : ''}`) : null,
    h('div', { class: 'ai-slot' }),
    h('div', { class: 'need-note' }, 'Answer it on the page.'));
  const doneRows = [
    ...filled.map((x) => [x.label, x.shown ?? '']),
    ...all('actions').map((x) => ['Clicked', x.text || x.id]),
    ...kept.filter((x) => !x.differs).map((x) => [x.label, 'left as the page had it']),
    ...all('skipped').map((x) => [x.label, 'ignored']),
  ];
  box.replaceChildren(...[
    agentPage ? h('p', { class: 'agent-page' }, agentPage) : null,
    frames.some((f) => f.halted) ? h('p', { class: 'card bad' }, `Filling stopped: ${frames.find((f) => f.halted).reason ?? ''} Check the page, then click Fill this page to retry.`) : null,
    h('div', { class: 'card summary' },
      h('div', { class: 'summary-line' }, h('b', {}, `Filled ${filled.length} of ${fields} questions`),
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
      h('summary', {}, h('span', { class: 'arrow' }, '›'), h('span', { class: 'grow' }, 'See what was filled'), h('span', { class: 'small muted' }, String(filled.length))),
      h('div', { class: 'more-body' }, doneRows.map(([k, v]) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v))))) : null,
  ].filter((node) => node != null && node !== false));
}

async function clearMarks() {
  if (!state.tab?.carrier) return;
  await runKit(state.tab.id, state.tab.carrier, () => globalThis.__raterKit.clear());
  $('report').replaceChildren();
}

async function capturePage() {
  const { id: tabId, carrier } = state.tab;
  const record = state.intake?.record;
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [record ? buildPlan(record, carrier, state.active) : null, record ? redactionTerms(record) : []]);
    const frames = results.map((r) => r.result).filter((f) => f && (f.controls.length || f.isTopFrame));
    // Rater pages change with the state and product being quoted, so every capture records them.
    const context = record ? {
      state: record.garaging?.state ?? null,
      businessClass: record.operations?.businessClass ?? null,
      vehicleTypes: [...new Set(record.vehicles.map((v) => v.type).filter(Boolean))],
      hasTrailers: record.trailers.length > 0,
      coverages: Object.entries(record.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    } : null;
    const data = { tool: 'tni-rater-autofill', version: 1, carrier: carrier.id, capturedAt: new Date().toISOString(), context, frames };
    const slug = (frames.find((f) => f.isTopFrame)?.frame ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `capture-${carrier.id}-${slug}-${Date.now()}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $('report').replaceChildren(h('p', { class: 'muted small' },
      `Saved the layout of ${frames.reduce((n, f) => n + f.controls.length, 0)} fields to your Downloads. It has no field values, and client names/numbers are replaced with [client] — still, skim it before sending.`));
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

// ctx: { tabId, page, carrier } of the fill these frames came from.
async function runAssist(frames, ctx) {
  const record = state.intake?.record;
  const active = { ...state.active };
  ctx = { ...ctx, contextKey: assistContextKey(record, active) };
  const cfg = await aiSettings();
  if (!cfg.on || !record || ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return;
  const provider = PROVIDERS[cfg.provider];
  // Questions the agent (or an applied AI answer) already settled on this page are not asked again.
  const collected = collectItems(frames);
  const items = collected.items.filter(x => !state.agentKeys.get(ctx.page)?.has(x.key) && !aiSettledOnPage(ctx.tabId, ctx.page, x));
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
  const stale = () => run !== state.aiRun || state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page
    || ctx.contextKey !== assistContextKey(state.intake?.record, state.active) || !holder.isConnected;
  // Reuse an answer for the same question (as the page shows it now) in the same intake and
  // driver/vehicle, model and policy. Not keyed on the rest of the page: every automatic
  // follow-up fill changes that, which asked the assistant again each time. Putting an answer in still
  // checks the page snapshot (applyAi), and approving checks it again.
  const onPage = frames.flatMap(f => f.filled ?? []).map(x => ({ question: x.label, answer: x.shown, controlKind: x.controlKind }));
  const contextHash = aiFingerprint(ctx.contextKey);
  const sigOf = x => aiCacheSignature({ tabId: ctx.tabId, page: ctx.page, model: cfg.model, policy: provider.policy, contextHash, itemHash: aiItemFingerprint(x) });
  const missing = items.filter((x) => !state.aiCache.has(sigOf(x)));
  if (missing.length) {
    holder.replaceChildren(h('p', { class: 'ai-wait' }, `Asking ${provider.name} about ${missing.length} question${missing.length === 1 ? '' : 's'} left for you…`));
    const started = Date.now();
    const context = { record, carrier: ctx.carrier.id, page: ctx.page, active, onPage };
    const logged = { type: 'ai_suggest', carrier: ctx.carrier.id, page: ctx.page, model: cfg.model, items: missing.length, blocked: blocked.length };
    try {
      const result = await suggest(missing, context, cfg, { isStale: stale });
      if (stale()) return;
      const fresh = result.suggestions;
      fresh.forEach(x => state.aiCache.set(sigOf(x), {
        ...x, policy: provider.policy, contextKey: ctx.contextKey, contextHash, itemHash: aiItemFingerprint(x),
      }));
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, suggested: fresh.filter(x => !x.leave).length,
        leave: fresh.filter(x => x.leave).length, autoOk: fresh.filter(x => x.autoOk).length,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls,
        reasoningTokens: result.reasoningTokens, cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens });
    } catch (e) {
      const msg = e instanceof AssistError ? e.message : 'The assistant could not review this page. Nothing was applied.';
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (!stale()) holder.replaceChildren(h('p', { class: 'card bad small' }, `AI assistant: ${msg}`));
      return;
    }
  }
  const suggestions = items.map((x) => state.aiCache.get(sigOf(x))).filter(Boolean);
  if (stale()) return;
  if (cfg.auto) {
    const picks = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
    if (picks.length) await applyAi(picks, ctx, 'auto');
  }
  if (!stale()) renderAi(holder, suggestions, ctx);
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
    if (t === String(tabId) && p === page && aiDecisionBlocks(x)) out.push(x);
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
  list = list.filter(x => ['radio', 'select', 'checkbox'].includes(x.controlKind) && !x.leave && !state.agentKeys.get(ctx.page)?.has(x.key) && (decision !== 'auto' || x.autoOk));
  if (!list.length) return false;
  state.filling = true;
  await tellRecorder('pause');
  try {
    const current = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
    if (JSON.stringify(current) !== JSON.stringify(ctx.snapshots)) {
      for (const x of list) x.error = 'the page changed; click Fill this page for fresh suggestions';
      return false;
    }
    const answers = list.map((x) => ({
      key: x.key, label: x.label, value: x.choice,
      expected: { kind: x.controlKind, section: x.section, options: x.options, current: x.current },
      note: `${decision === 'auto' ? 'selected by the AI' : 'AI suggestion you accepted'}: ${x.tip}`.slice(0, 240),
    }));
    const results = (await runKit(ctx.tabId, ctx.carrier, (a, snapshots) => globalThis.__raterKit.answer(a, snapshots), [answers, ctx.snapshots.map(r => r.result)])).flatMap((r) => r.result ?? []);
    const keys = state.agentKeys.get(ctx.page) ?? new Set();
    for (const x of list) {
      const mine = results.filter((r) => r.key === x.key && r.label === x.label);
      const ok = mine.find((r) => r.ok);
      const problem = mine.find((r) => !r.ok && !/no longer on this page/.test(r.reason ?? '')) ?? mine[0];
      x.done = ok ? decision : null;
      x.error = ok ? null : problem?.reason ?? 'the question is no longer on this page';
      if (ok) {
        // Decided now: later fills leave this question alone instead of asking again.
        keys.add(x.key);
        state.filled.set(x.key, { path: null, shown: ok.shown });
      }
      if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, ok ? decision : 'failed'));
    }
    state.agentKeys.set(ctx.page, keys);
    ctx.snapshots = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
    // Each applied pick remembers the page as it left it, for approving it later (also after a
    // context change, when the snapshot of this run is gone).
    for (const x of list) if (x.done) {
      x.snapshots = ctx.snapshots;
      x.snapshotHash = aiFingerprint(ctx.snapshots);
    }
    return true;
  } catch (e) {
    for (const x of list) x.error = `couldn't reach the page (${String(e?.message ?? e).slice(0, 80)})`;
    return false;
  } finally {
    await tellRecorder('resume');
    state.filling = false;
    await persistAiPending();
    if (state.autoPending) scheduleAutoFill(ctx.page);
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
  // Approving or rejecting a pick acts on what is already on the page, so it does not depend on
  // the current intake or driver/vehicle.
  const decide = async (list, decision) => {
    if (state.filling || state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page) return;
    if (decision === 'approved') {
      // Approve only what the page still shows as the AI left it; a pick whose page changed since
      // is rejected so the agent reviews it after a fresh fill.
      let now;
      try { now = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot()); }
      catch {
        for (const x of list) x.error = 'the page is unavailable; return to it and run Fill again';
        rerender();
        return;
      }
      const moved = list.filter((x) => aiFingerprint(now) !== (x.snapshotHash ?? aiFingerprint(x.snapshots ?? ctx.snapshots)));
      if (moved.length) {
        const keys = state.agentKeys.get(ctx.page);
        for (const x of moved) {
          x.rejected = true;
          x.error = 'the page changed after this choice; run Fill again and review it';
          keys?.delete(x.key);
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
      && state.tab?.id === ctx.tabId && pageOf(state.tab?.url) === ctx.page) fillPage();
  };
  // Rejecting leaves Continue blocked until the agent either changes that field on the page
  // (the recorder marks it manual) or explicitly confirms the current carrier value here. This
  // confirmation is intentional and does not infer consent from unrelated page changes.
  const confirmRejected = async (list) => {
    if (state.filling || state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page) return;
    for (const x of list) {
      let present = false;
      try {
        const result = await runKit(ctx.tabId, ctx.carrier, () => globalThis.__raterKit.decisionSnapshot());
        present = aiCurrentAnswerPresent(result, x);
      } catch { /* page navigating */ }
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
      && state.tab?.id === ctx.tabId && pageOf(state.tab?.url) === ctx.page) fillPage();
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
  $('usage-count').textContent = n
    ? `${n.toLocaleString()} event${n === 1 ? '' : 's'} waiting on this computer`
    : 'Nothing waiting on this computer.';
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
  const info = up.state === 'error'
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
    state.intake = null;
    usage.restoreSession(null);
    await store.remove('intake');
    await store.remove('session');
    await clearAiPending();
    await clearAgentKeys();
    $('report').replaceChildren();
    render();
  });
  $('fill').addEventListener('click', () => fillPage());
  $('unmark').addEventListener('click', clearMarks);
  $('capture').addEventListener('click', capturePage);
  wireAgentPopover();
  wireUsage();
  wireAi();
  if (inExtension) {
    chrome.runtime.onMessage.addListener(onRecorderMessage);
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  wire();
  state.intake = (await store.get('intake')) ?? null;
  state.active = (await store.get('active')) ?? state.active;
  usage.restoreSession((await store.get('session')) ?? null);
  await restoreAiPending();
  const saved = await usage.migrateAssistantSettings();
  $('auto-followups').checked = saved.autoFollowUps ?? true;
  $('auto-pages').checked = saved.autoPages ?? false;
  $('auto-advance').checked = saved.autoAdvance ?? true;
  uploadNow();
  render();
  renderUsage();
  renderAiSettings();
  await refreshTab();
}

init();
