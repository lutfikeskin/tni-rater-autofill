import * as pdfjs from '../lib/pdf.min.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseEdit } from '../src/normalize.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { get, set } from '../src/util.js';

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
  try {
    raw = await readIntakeFields(pdfjs, new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return showLoadError(`Couldn't read that PDF (${e.message}).`);
  }
  if (!Object.keys(raw).length) {
    return showLoadError('This PDF has no fillable fields — it may be a scan or a printed-and-signed copy. Only the fillable TNI quote application is supported so far.');
  }
  const result = normalizeIntake(raw);
  if (result.error) return showLoadError(result.error);
  state.intake = { ...result, fileName: file.name, done: [] };
  state.active = { drivers: 0, vehicles: 0, trailers: 0 };
  await save();
  render();
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
    set(state.intake.record, path, parseEdit(kind, input.value));
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
  state.tab = tab ? { id: tab.id, url: tab.url, carrier: tab.url ? carrierForUrl(tab.url) : null } : null;
  renderSite();
}

function renderSite() {
  const site = $('site');
  const carrier = state.tab?.carrier;
  site.textContent = !inExtension ? 'Preview only' : carrier ? carrier.name : 'Not a rater page';
  site.classList.toggle('on', !!carrier);
  const canFill = inExtension && !!carrier && !!state.intake;
  $('fill').disabled = !canFill;
  $('capture').disabled = !(inExtension && carrier);
  $('fill-hint').textContent = !inExtension
    ? 'Filling works when this runs as the Chrome extension.'
    : carrier ? 'Fills what it can on the page you are looking at. Nothing is submitted — review, then click Next yourself.'
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

async function fillPage() {
  const { id: tabId, carrier } = state.tab;
  const plan = buildPlan(state.intake.record, carrier, state.active);
  const overwrite = $('overwrite').checked;
  $('fill').disabled = true;
  $('fill').textContent = 'Filling…';
  $('report').replaceChildren(h('p', { class: 'muted small' }, 'Filling one answer at a time where the page checks each answer with its server. Keep this tab open.'));
  try {
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, { overwrite }]);
    renderReport(results.map((r) => r.result).filter(Boolean));
  } catch (e) {
    $('report').replaceChildren(h('p', { class: 'error' }, `Couldn't fill this page: ${e.message}`));
  } finally {
    $('fill').disabled = false;
    $('fill').textContent = 'Fill this page';
  }
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
  box.className = 'report';
  if (!fields) {
    box.replaceChildren(h('p', { class: 'muted' }, 'No form fields found on this page.'));
    return;
  }
  const group = (cls, title, items, line, open = false) => items.length
    ? h('details', { class: cls, open }, h('summary', {}, `${title} (${items.length})`), h('ul', {}, items.map((x) => h('li', {}, line(x)))))
    : null;
  const needs = [...noData.map((x) => ({ ...x, why: x.note ?? 'not on intake' })), ...leftRequired.map((x) => ({ ...x, why: 'required' }))];
  box.replaceChildren(
    h('p', { class: 'report-summary' }, `Filled ${filled.length} of ${fields} fields on this page`),
    group('r-failed', "Couldn't fill", failed, (x) => [h('b', {}, x.label), ` — ${x.reason}`, x.options?.length ? h('div', { class: 'muted' }, `Options: ${x.options.join(' · ')}`) : null], true),
    group('r-needs', 'Needs you', needs, (x) => [h('b', {}, x.label), ` — ${x.why}`], true),
    group('r-filled', 'Filled', filled, (x) => [h('b', {}, x.label), ` ← ${x.shown}`]),
    group('r-kept', 'Already had a value (left alone)', kept, (x) => h('b', {}, x.label)),
  );
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
    state.intake = null;
    await store.remove('intake');
    $('report').replaceChildren();
    render();
  });
  $('fill').addEventListener('click', fillPage);
  $('unmark').addEventListener('click', clearMarks);
  $('capture').addEventListener('click', capturePage);
  if (inExtension) {
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onUpdated.addListener((id, change) => { if (id === state.tab?.id && (change.url || change.status === 'complete')) refreshTab(); });
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  wire();
  state.intake = (await store.get('intake')) ?? null;
  state.active = (await store.get('active')) ?? state.active;
  render();
  await refreshTab();
}

init();
