import * as pdfjs from '../lib/pdf.min.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseEdit } from '../src/normalize.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { get, set } from '../src/util.js';
import { intakeSummary, fieldChangeEvent, fillEvents, redactor } from '../src/usage.js';
import * as usage from './usage-log.js';
import { collectItems, buildRequest, callModel, parseResponse, usageOf, AssistError, DEFAULT_MODEL } from '../src/ai/assist.js';

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
  state.intake = { ...result, fileName: file.name, done: [] };
  state.active = { drivers: 0, vehicles: 0, trailers: 0 };
  state.filled = new Map();
  state.doneActions = new Set();
  state.aiCache.clear();
  await store.set('session', usage.startSession(summary.intakeId));
  usage.log({ type: 'intake_loaded', ...summary });
  uploadNow();
  await save();
  render();
  refreshTab();
}

function showLoadError(msg) {
  $('load-error').textContent = msg;
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
  $('load').hidden = has;
  $('client').hidden = !has;
  $('fillbar').hidden = !has;
  if (!has) return;
  const { record, stats, fileName } = state.intake;
  $('client-name').textContent = record.applicant.name ?? 'Unnamed business';
  $('client-meta').textContent = `${fileName} · ${stats.filled} answers · ${record.drivers.length} driver${record.drivers.length === 1 ? '' : 's'}, ${record.vehicles.length} vehicle${record.vehicles.length === 1 ? '' : 's'}`;
  renderWarnings();
  renderSections();
  renderPickers();
  renderSite();
}

function renderWarnings() {
  const { warnings, done } = state.intake;
  const box = $('warnings');
  box.replaceChildren();
  const item = (w, i) => h('li', { class: `warn-item ${w.level}${done.includes(i) ? ' done' : ''}` },
    w.level === 'check' ? h('input', {
      type: 'checkbox', checked: done.includes(i), title: 'Mark as checked',
      onchange: (e) => { toggleDone(i, e.target.checked); },
    }) : null,
    h('span', { class: 'warn-text' }, w.msg),
    w.path ? h('button', { type: 'button', class: 'link small warn-go', onclick: () => jumpTo(w.path) }, 'Show') : null);
  const checks = warnings.map((w, i) => [w, i]).filter(([w]) => w.level === 'check');
  const infos = warnings.map((w, i) => [w, i]).filter(([w]) => w.level === 'info');
  if (checks.length) {
    const open = checks.filter(([, i]) => !done.includes(i)).length;
    box.append(h('div', { class: 'warnings' },
      h('h3', {}, open ? `Check before quoting (${open} of ${checks.length})` : `All ${checks.length} items checked`),
      h('ul', { class: 'warn-list' }, checks.map(([w, i]) => item(w, i)))));
  }
  if (infos.length) {
    box.append(h('details', { class: 'warnings' },
      h('summary', { class: 'small muted' }, `Cleanup notes (${infos.length})`),
      h('ul', { class: 'warn-list' }, infos.map(([w, i]) => item(w, i)))));
  }
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

function fieldRow(path, label, kind, flagged) {
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
  return h('div', { class: `field${flagged ? ' flagged' : ''}${value == null ? ' empty' : ''}`, dataset: { path } },
    h('label', { for: id }, label), input);
}

function jumpTo(path) {
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

function renderPickers() {
  const { record } = state.intake;
  const box = $('pickers');
  box.replaceChildren();
  const pickers = [
    ['drivers', 'Driver', (d) => [d.first, d.last].filter(Boolean).join(' ')],
    ['vehicles', 'Vehicle', (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')],
    ['trailers', 'Trailer', (t) => [t.year, t.make, t.type].filter(Boolean).join(' ')],
  ];
  for (const [list, label, describe] of pickers) {
    const items = record[list] ?? [];
    if (items.length < 2) continue;
    const sel = h('select', {
      onchange: async (e) => { state.active[list] = Number(e.target.value); await save(); },
    }, items.map((it, i) => h('option', { value: String(i), selected: state.active[list] === i }, `${i + 1}. ${describe(it) || label}`)));
    box.append(h('label', {}, label, sel));
  }
}

// ---------------------------------------------------------------------------------------------
// The current tab

async function refreshTab() {
  if (!inExtension) { state.tab = null; return renderSite(); }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== state.tab?.id) {
    const keys = ['filled', 'labels', 'autoPages', 'autoPaused', 'agentKeys', 'doneActions', 'visitedPages'];
    if (state.tab?.id) state.tabSessions.set(state.tab.id, Object.fromEntries(keys.map((key) => [key, state[key]])));
    const previous = state.tabSessions.get(tab?.id);
    Object.assign(state, previous ?? {
      filled: new Map(), labels: new Map(), autoPages: new Set(), autoPaused: false,
      agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(),
    });
    clearTimeout(state.autoTimer);
    state.autoPending = false;
  }
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null } : null;
  renderSite();
  ensureRecorder();
}

// ---------------------------------------------------------------------------------------------
// Usage recording (see src/usage.js for what is and isn't kept)

// Progressive re-renders a page as "<Page>-Reload"; it's the same page.
const samePage = (p) => (p ?? '').replace(/-Reload$/, '');
const pageOf = (url) => { try { const u = new URL(url); return samePage(u.searchParams.get('pageName') || u.pathname); } catch { return null; } };

// Watch the rater tab while an intake is loaded. Only carrier pages; never other sites.
async function ensureRecorder() {
  if (!inExtension || !state.intake || !state.tab?.carrier || state.tab.carrier.practice) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: state.tab.id, allFrames: true }, files: ['src/content/recorder.js'] });
  } catch { /* page not ready or not allowed; tried again on the next tab update */ }
}

function tellRecorder(cmd) {
  if (!state.tab) return Promise.resolve();
  return chrome.tabs.sendMessage(state.tab.id, { ra: 'recorder', cmd }).catch(() => {});
}

function onRecorderMessage(msg, sender) {
  if (msg?.ra !== 'usage' || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier?.id ?? null;
  if (msg.event === 'page_view') {
    if (msg.from) state.visitedPages.add(samePage(msg.from));
    usage.log({ type: 'page_view', carrier, page: msg.page, from: msg.from, fields: msg.fields });
    // Setting "Fill each new page as soon as it opens": wait for the page to settle, then fill.
    // Coming back to a page filled earlier in this quote (Rates after the bill plan) refills it
    // with the follow-up setting, so its next buttons (Recalculate, Print) run. Pages with only
    // buttons for us (Add Vehicle) count too.
    const page = samePage(msg.page);
    const hasButtons = (state.tab.carrier?.actions ?? []).some((a) => [].concat(a.page ?? []).includes(page));
    const wanted = $('auto-pages').checked || ($('auto-followups').checked && (state.autoPages.has(page) || (hasButtons && !msg.fields)));
    if (wanted && (msg.fields > 0 || hasButtons) && onQuotePage()) {
      setTimeout(() => { if (pageOf(state.tab?.url) === samePage(msg.page)) fillPage({ auto: 'page' }); }, 800);
    }
    return;
  }
  if (msg.event === 'field_changes') {
    const ctx = { record: state.intake.record, filled: state.filled, labels: state.labels, redact: redactor(redactionTerms(state.intake.record)) };
    usage.log(...msg.changes.map((c) => ({ carrier, page: msg.page, ...fieldChangeEvent(c, ctx) })));
    const byAgent = msg.changes.filter((c) => c.agent);
    if (byAgent.length) {
      const page = samePage(msg.page);
      const keys = state.agentKeys.get(page) ?? new Set();
      byAgent.forEach((c) => keys.add(c.key));
      state.agentKeys.set(page, keys);
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
  state.autoTimer = setTimeout(() => autoFill(page), 1200);
}

async function autoFill(page) {
  if (state.autoPaused || state.filling || pageOf(state.tab?.url) !== page) return;
  const { id: tabId, carrier } = state.tab;
  await pickListVehicle(carrier, page);
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
  if (assistFrames) runAssist(assistFrames, { tabId, page, carrier });
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
  const carrier = state.tab?.carrier;
  // No URL means the browser isn't letting the extension see this site (site access / permissions).
  const noAccess = inExtension && state.tab && !state.tab.url;
  site.textContent = !inExtension ? 'Preview only' : carrier ? carrier.name : noAccess ? 'No access to this page' : 'Not a rater page';
  site.classList.toggle('on', !!carrier);
  const canFill = inExtension && !!carrier && !!state.intake;
  $('fill').disabled = !canFill;
  $('capture').disabled = !(inExtension && carrier);
  $('fill-hint').textContent = !inExtension
    ? 'Filling works when this runs as the Chrome extension.'
    : carrier ? 'Fills what it can on the page you are looking at. Nothing is submitted — review, then click Next yourself.'
      : noAccess
        ? "The browser isn't letting the extension read this page. Allow the extension on this site (click its icon in the toolbar or check its site access in the extensions page), then reload the page."
        : 'Open a Progressive or GEICO rater page to fill it.';
}

// ---------------------------------------------------------------------------------------------
// Filling and capturing

// Carriers whose widgets live in the page's own JavaScript (ExtJS) need the MAIN world.
const worldFor = (carrier) => (carrier?.world === 'MAIN' ? 'MAIN' : 'ISOLATED');

async function injectKit(tabId, carrier) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: worldFor(carrier), files: ['src/content/pagekit.js'] });
}

async function runKit(tabId, carrier, func, args = []) {
  await injectKit(tabId, carrier);
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: worldFor(carrier), func, args });
}

// `auto`: 'page' when started because a new page opened (setting "Fill each new page").
async function fillPage({ auto = false } = {}) {
  if (state.filling || !state.intake || !state.tab?.carrier || (auto && state.autoPaused)) return;
  if (!auto) state.autoPaused = false;
  state.filling = true;
  clearTimeout(state.autoTimer);
  const { id: tabId, carrier } = state.tab;
  const page = pageOf(state.tab.url);
  await pickListVehicle(carrier, page);
  const plan = buildPlan(state.intake.record, carrier, state.active);
  const overwrite = auto ? false : $('overwrite').checked;
  $('fill').disabled = true;
  $('fill').textContent = 'Filling…';
  $('report').replaceChildren(h('p', { class: 'muted small' }, 'Filling one answer at a time where the page checks each answer with its server. Keep this tab open.'));
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
    $('fill').disabled = false;
    $('fill').textContent = 'Fill this page';
  }
  await remarkAi({ tabId, page, carrier });
  if (assistFrames && !assistFrames.some((f) => f.halted)) runAssist(assistFrames, { tabId, page, carrier });
}

// On the carrier's vehicle list page, work on the first intake vehicle not added yet (its Add
// Vehicle or VIN lookup not done in this quote). When every vehicle is in, the active one stays
// and nothing is left to add, so the page's Continue is clicked.
async function pickListVehicle(carrier, page) {
  if (!carrier?.vehicleList || page !== carrier.vehicleList) return;
  const vehicles = state.intake?.record.vehicles ?? [];
  const next = vehicles.findIndex((_, i) => !state.doneActions.has(`lookupVin:${i}`) && !state.doneActions.has(`addVehicle:${i}`));
  if (next < 0 || next === state.active.vehicles) return;
  state.active.vehicles = next;
  await save();
  renderPickers();
}

async function ignoreReview(key, tabId, page) {
  if (!key || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const keys = state.agentKeys.get(page) ?? new Set();
  keys.add(key);
  state.agentKeys.set(page, keys);
  await fillPage();
}

function renderReport(frames) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const filled = all('filled');
  const noData = all('noData');
  const leftRequired = all('leftRequired');
  const failed = all('failed');
  const kept = all('kept');
  const fields = frames.reduce((n, f) => n + f.fields, 0);
  const box = $('report');
  const tabId = state.tab?.id;
  const page = pageOf(state.tab?.url);
  const reviewLine = (x, children) => [
    h('span', {}, children),
    x.key ? h('button', { class: 'ignore-review', type: 'button', title: 'Ignore this field and continue', 'aria-label': `Ignore ${x.label} and continue`, onclick: () => ignoreReview(x.key, tabId, page) }, '×') : null,
  ];
  box.className = 'report';
  if (!fields && !all('actions').length) {
    const halted = frames.find((f) => f.halted);
    box.replaceChildren(h('p', { class: halted ? 'error' : 'muted' }, halted ? `Automatic filling and helpers paused. ${halted.reason ?? 'Review this page before retrying.'}` : 'No form fields found on this page.'));
    return;
  }
  const group = (cls, title, items, line, open = false) => items.length
    ? h('details', { class: cls, open }, h('summary', {}, `${title} (${items.length})`), h('ul', {}, items.map((x) => h('li', {}, line(x)))))
    : null;
  const unknownKeys = new Set(all('unknown').map((x) => x.key));
  const needs = [...noData.map((x) => ({ ...x, why: x.note ?? 'not on intake' })), ...leftRequired.filter((x) => !unknownKeys.has(x.key)).map((x) => ({ ...x, why: 'required' }))];
  const advanced = frames.find((f) => f.advanced)?.advanced;
  const blockers = all('blockers');
  box.replaceChildren(...[
    frames.some((f) => f.halted) ? h('p', { class: 'error' }, `Filling stopped: ${frames.find((f) => f.halted).reason ?? ''} Check the page, then click Fill this page to retry.`) : null,
    h('p', { class: 'report-summary' }, `Filled ${filled.length} of ${fields} fields on this page${advanced ? ` · clicked "${advanced}"` : blockers.length ? ` · ${blockers.length} thing${blockers.length === 1 ? '' : 's'} to look at before Continue` : ''}`),
    group('r-needs', 'Unfamiliar questions — left for you', all('unknown'), (x) => reviewLine(x, [h('b', {}, x.label), x.required ? ' (required)' : '']), true),
    group('r-failed', "Couldn't fill", failed, (x) => reviewLine(x, [h('b', {}, x.label), ` — ${x.reason}`, x.options?.length ? h('div', { class: 'muted' }, `Options: ${x.options.slice(0, 25).join(' · ')}${x.options.length > 25 ? ' · …' : ''}`) : null]), true),
    group('r-needs', 'Needs you', needs, (x) => reviewLine(x, [h('b', {}, x.label), ` — ${x.why}`]), true),
    group('r-needs', 'Page already had a different value (kept)', kept.filter((x) => x.differs), (x) => reviewLine(x, [h('b', {}, x.label)]), true),
    group('r-needs', 'Buttons waiting', all('blocked'), (x) => [h('b', {}, x.id), ` — ${x.why}`]),
    group('r-kept', 'Ignored (left unchanged)', all('skipped'), (x) => h('b', {}, x.label)),
    group('r-filled', 'Filled', filled, (x) => [h('b', {}, x.label), ` ← ${x.shown}`]),
    group('r-kept', 'Clicked', all('actions'), (x) => h('b', {}, x.text || x.id)),
    group('r-kept', 'Already had a value (left alone)', kept.filter((x) => !x.differs), (x) => h('b', {}, x.label)),
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
// AI assistant (src/ai/assist.js): after a fill, suggests answers for the questions left for the
// agent. Suggestions go in only when the agent accepts them, or, with "Let the AI select answers
// it's sure of", when the answer comes straight from the intake or a written TNI rule.

async function aiSettings() {
  const { aiOn = false, aiAuto = false, aiKey = '', aiModel = '' } = await usage.settings();
  return { on: aiOn, auto: aiAuto, apiKey: aiKey, model: aiModel || DEFAULT_MODEL };
}

// ctx: { tabId, page, carrier } of the fill these frames came from.
async function runAssist(frames, ctx) {
  const cfg = await aiSettings();
  if (!cfg.on || !state.intake) return;
  const { items, blocked } = collectItems(frames);
  if (!items.length) return;
  const holder = h('div', { class: 'ai-box' });
  $('report').append(holder);
  if (!cfg.apiKey) {
    holder.append(h('p', { class: 'muted small' }, 'The AI assistant is on but has no API key. Add one under AI assistant.'));
    return;
  }
  const run = ++state.aiRun;
  const stale = () => run !== state.aiRun || state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page || !holder.isConnected;
  const sig = [ctx.tabId, ctx.page, cfg.model, ...items.map((x) => `${x.key}|${x.label}|${x.current}|${x.options.length}`)].join('\n');
  let suggestions = state.aiCache.get(sig);
  if (!suggestions) {
    holder.replaceChildren(h('p', { class: 'muted small ai-wait' }, `Asking the AI about ${items.length} question${items.length === 1 ? '' : 's'} left for you…`));
    const started = Date.now();
    const onPage = frames.flatMap((f) => f.filled ?? []).map((x) => ({ question: x.label, answer: x.shown }));
    const body = buildRequest(items, { record: state.intake.record, carrier: ctx.carrier.id, page: ctx.page, active: state.active, onPage }, cfg);
    const logged = { type: 'ai_suggest', carrier: ctx.carrier.id, page: ctx.page, model: cfg.model, items: items.length, blocked: blocked.length };
    try {
      const json = await callModel({ apiKey: cfg.apiKey, body });
      suggestions = parseResponse(json, items, state.intake.record);
      state.aiCache.set(sig, suggestions);
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, suggested: suggestions.filter((x) => !x.leave).length, leave: suggestions.filter((x) => x.leave).length, autoOk: suggestions.filter((x) => x.autoOk).length, ...usageOf(json) });
    } catch (e) {
      const msg = e instanceof AssistError ? e.message : `Something went wrong (${String(e?.message ?? e).slice(0, 120)}).`;
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (!stale()) holder.replaceChildren(h('p', { class: 'error small' }, `AI assistant: ${msg}`));
      return;
    }
  }
  if (stale()) return;
  if (cfg.auto) {
    const picks = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
    if (picks.length) await applyAi(picks, ctx, 'auto');
  }
  if (!stale()) renderAi(holder, suggestions, ctx);
  syncAiBanner(ctx);
}

// AI selections on this tab's page that the agent hasn't approved or rejected yet. While there
// are any, the page's Continue is never clicked automatically.
function pendingAi(tabId, page) {
  const out = [];
  for (const [sig, list] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(tabId) && p === page) out.push(...list.filter((x) => x.done === 'auto' && !x.approved && !x.rejected));
  }
  return out;
}

// A new fill clears the page's marks: put the purple back on the AI's answers on this page.
async function remarkAi(ctx) {
  const answered = [];
  for (const [sig, list] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(ctx.tabId) && p === ctx.page) answered.push(...list.filter((x) => x.done && !x.rejected));
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
  state.filling = true;
  await tellRecorder('pause');
  try {
    const answers = list.map((x) => ({
      key: x.key, label: x.label, value: x.choice,
      note: `${decision === 'auto' ? 'selected by the AI' : 'AI suggestion you accepted'}: ${x.tip}`.slice(0, 240),
    }));
    const results = (await runKit(ctx.tabId, ctx.carrier, (a) => globalThis.__raterKit.answer(a), [answers])).flatMap((r) => r.result ?? []);
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
    return true;
  } catch (e) {
    for (const x of list) x.error = `couldn't reach the page (${String(e?.message ?? e).slice(0, 80)})`;
    return false;
  } finally {
    await tellRecorder('resume');
    state.filling = false;
    if (state.autoPending) scheduleAutoFill(ctx.page);
  }
}

function aiDecisionEvent(x, ctx, decision) {
  const redact = redactor(redactionTerms(state.intake.record));
  return {
    type: 'ai_decision', carrier: ctx.carrier.id, page: ctx.page, q: x.q ?? null, label: redact(x.label), controlKind: x.controlKind,
    decision, choice: x.controlKind !== 'text' && x.choice ? redact(x.choice) : undefined,
    confidence: x.confidence, basis: x.basis, intakePath: x.intakePath, reason: x.error ? redact(x.error) : undefined,
  };
}

function renderAi(holder, suggestions, ctx) {
  const rerender = () => { if (holder.isConnected) renderAi(holder, suggestions, ctx); };
  const act = async (list, decision, button) => {
    if (state.filling) { $('ai-note').textContent = 'Wait for the fill to finish, then try again.'; return; }
    if (button) { button.disabled = true; button.textContent = 'Putting it in…'; }
    await applyAi(list, ctx, decision);
    rerender();
  };
  const sure = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
  const pending = suggestions.filter((x) => x.done === 'auto' && !x.approved && !x.rejected);
  const canContinue = $('auto-advance').checked && !!ctx.carrier.advance;
  const decide = async (list, decision) => {
    for (const x of list) {
      if (decision === 'approved') x.approved = true; else x.rejected = true;
      if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, decision));
    }
    if (decision === 'rejected') {
      for (const x of list) {
        try { await runKit(ctx.tabId, ctx.carrier, (k, l, n) => globalThis.__raterKit.markKey(k, l, 'needs', n), [x.key, x.label, 'AI choice rejected: set this answer yourself']); } catch { /* page navigating */ }
      }
    }
    await syncAiBanner(ctx);
    rerender();
    // Approved and nothing else left: the normal fill clicks Continue (when that setting is on).
    if (decision === 'approved' && canContinue && !pendingAi(ctx.tabId, ctx.page).length
      && state.tab?.id === ctx.tabId && pageOf(state.tab?.url) === ctx.page) fillPage();
  };
  const why = (x) => [
    x.basis === 'intake' ? `from the intake: ${x.intakePath}` : x.basis === 'tni_rule' ? 'TNI rule' : x.basis === 'page' ? 'from other answers on the page' : x.basis === 'judgement' ? 'AI judgement' : null,
    x.status === 'failed' ? 'autofill couldn\'t fill it' : x.status === 'unfamiliar' ? 'no TNI rule yet' : x.status === 'not_on_intake' ? 'not on the intake' : 'required',
  ].filter(Boolean).join(' · ');
  const line = (x) => {
    const chip = x.rejected ? h('span', { class: 'ai-chip bad' }, 'rejected')
      : x.done === 'auto' && !x.approved ? h('span', { class: 'ai-chip high' }, 'selected by AI · needs your OK')
        : x.done ? h('span', { class: 'ai-chip done' }, x.done === 'auto' ? 'selected by AI · approved' : 'accepted')
      : x.dismissed ? h('span', { class: 'ai-chip' }, 'dismissed')
        : x.error ? h('span', { class: 'ai-chip bad' }, 'not taken')
          : x.leave ? h('span', { class: 'ai-chip' }, 'yours to decide')
            : h('span', { class: `ai-chip ${x.confidence === 'high' ? 'high' : ''}` }, `${x.confidence} confidence`);
    const canAct = !x.leave && !x.done && !x.dismissed && x.applyable;
    return [
      h('b', {}, x.label),
      h('div', { class: 'ai-line' },
        x.leave ? h('span', { class: 'muted' }, 'Leave for you') : h('span', { class: 'ai-choice' }, x.controlKind === 'text' ? `Type “${x.choice}”` : x.choice),
        chip),
      x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
      h('div', { class: 'ai-why' }, why(x)),
      ...x.checks.map((c) => h('div', { class: 'ai-check' }, `Checked by the extension: ${c}`)),
      x.error ? h('div', { class: 'ai-check' }, `Not taken by the page: ${x.error}`) : null,
      canAct ? h('div', { class: 'ai-actions' },
        h('button', { type: 'button', class: 'ghost accept', onclick: (e) => act([x], 'accepted', e.target) }, 'Accept'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { x.dismissed = true; if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, 'dismissed')); rerender(); } }, 'Dismiss')) : null,
    ];
  };
  const open = suggestions.filter((x) => !x.done);
  const done = suggestions.filter((x) => x.done);
  holder.replaceChildren(...[
    h('details', { class: 'r-ai', open: true },
      h('summary', {}, `AI suggestions (${open.length} open${done.length ? `, ${done.length} put in` : ''})`),
      sure.length > 1 ? h('button', { type: 'button', class: 'ghost ai-all', onclick: (e) => act(sure, 'accepted', e.target) }, `Accept all ${sure.length} suggested answers`) : null,
      h('ul', {}, [...open, ...done].map((x) => h('li', {}, line(x))))),
    // End of the page report: what the AI selected by itself, waiting for the agent's OK.
    pending.length ? h('div', { class: 'ai-approve' },
      h('p', { class: 'ai-approve-title' }, `The AI selected ${pending.length} answer${pending.length === 1 ? '' : 's'} on this page`),
      h('p', { class: 'muted small' }, canContinue ? 'Continue waits until you approve them.' : 'Check them (purple on the page), then approve.'),
      h('ul', {}, pending.map((x) => h('li', {},
        h('span', {}, h('b', {}, x.label), ' ← ', h('span', { class: 'ai-choice' }, x.choice)),
        h('button', { type: 'button', class: 'link small ai-reject', onclick: () => decide([x], 'rejected') }, 'Reject')))),
      h('div', { class: 'ai-actions' },
        h('button', { type: 'button', class: 'ghost accept', onclick: () => decide(pending, 'approved') }, canContinue ? 'Approve and continue' : `Approve ${pending.length === 1 ? 'it' : `all ${pending.length}`}`))) : null,
  ].filter(Boolean));
}

function wireAi() {
  const save = (patch) => usage.saveSettings(patch).then(renderAiSettings);
  $('ai-on').addEventListener('change', (e) => save({ aiOn: e.target.checked }));
  $('ai-auto').addEventListener('change', (e) => save({ aiAuto: e.target.checked }));
  $('ai-key').addEventListener('change', (e) => save({ aiKey: e.target.value.trim() }));
  $('ai-model').addEventListener('change', (e) => save({ aiModel: e.target.value.trim() }));
}

async function renderAiSettings() {
  const cfg = await aiSettings();
  $('ai-on').checked = cfg.on;
  $('ai-auto').checked = cfg.auto;
  $('ai-auto').disabled = !cfg.on;
  if (document.activeElement !== $('ai-key')) $('ai-key').value = cfg.apiKey;
  if (document.activeElement !== $('ai-model')) $('ai-model').value = cfg.model === DEFAULT_MODEL ? '' : cfg.model;
  $('ai-note').textContent = !cfg.on ? 'Off.' : !cfg.apiKey ? 'On, but needs an API key.' : `On · ${cfg.model}${cfg.auto ? ' · makes selections, you approve them before Continue' : ' · suggestions only'}`;
}

// ---------------------------------------------------------------------------------------------
// Usage log panel and problem reports

async function renderUsage() {
  const n = await usage.count();
  const { agent = '', serverUrl = usage.DEFAULT_SERVER, serverToken = '' } = await usage.settings();
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
  for (const [id, v] of [['agent', agent], ['server-url', serverUrl], ['server-token', serverToken]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  $('recording').hidden = !state.intake;
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
  $('choose').addEventListener('click', () => $('file').click());
  $('replace').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  for (const t of [document.body]) {
    t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    t.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
    t.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  }
  $('clear-client').addEventListener('click', async () => {
    usage.log({ type: 'intake_closed', reason: 'cleared' });
    state.intake = null;
    usage.restoreSession(null);
    await store.remove('intake');
    await store.remove('session');
    $('report').replaceChildren();
    render();
  });
  $('fill').addEventListener('click', () => fillPage());
  $('unmark').addEventListener('click', clearMarks);
  $('capture').addEventListener('click', capturePage);
  wireUsage();
  wireAi();
  if (inExtension) {
    chrome.runtime.onMessage.addListener(onRecorderMessage);
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onUpdated.addListener((id, change) => { if (id === state.tab?.id && (change.url || change.status === 'complete')) refreshTab(); });
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  wire();
  state.intake = (await store.get('intake')) ?? null;
  state.active = (await store.get('active')) ?? state.active;
  usage.restoreSession((await store.get('session')) ?? null);
  const saved = await usage.settings();
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
