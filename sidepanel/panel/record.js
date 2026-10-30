// The side panel: rendering the client record.
// One part of the panel; sidepanel.js wires the parts together.
import { sourcePlace } from '../../src/intake-source.js';
import { parseEdit, rederive } from '../../src/normalize.js';
import { SECTIONS, fieldInfo } from '../../src/schema.js';
import { get, set, STATES, quotedCarrierPolicy } from '../../src/util.js';
import * as usage from '../usage-log.js';
import { $, h, persistUnitForms, state } from './core.js';
import { profileLater, save } from './intake.js';
import { pageOf } from './usage.js';
import { intakeEdited, renderDock, renderSite, renderSteps, scheduleLayout, scrollBehavior, tabStep } from './coordinator.js';
import { refreshAnswers } from './fill.js';
import { applyCheckChoice, claimsTextEdited, ntlAnswerEdited, ntlCargoEdited, ntlPrimaryEdited, renderAiSettings, reviewClaimsBox, reviewDriverGender } from './assistant.js';
import { openDetails, openPdf, pdfAvailable, pdfPageSaid } from './pdf-view.js';

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
  for (const id of ['client-card', 'details-row']) $(id).setAttribute('aria-expanded', String(!!state.detailsOpen));
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

// A check the agent sees here. The current insurance being with a carrier the panel quotes
// (prior.carrier-is-quoted) only on that carrier's site: on another carrier's quote it is no
// concern (TNI, 2026-10-27: GEICO's red card on a Progressive quote).
function checkShown(w, intake = state.intake) {
  if (w.level !== 'check') return false;
  if (w.code !== 'prior.carrier-is-quoted') return true;
  const carrier = state.tab?.carrier;
  return !!carrier && quotedCarrierPolicy(intake?.record?.priorInsurance?.[0], carrier.id);
}

// The view an intake opens on (loaded, or restored when the panel reopens): step 1's checks while
// one is still open; else the page's answers.
function firstView(intake) {
  return intake?.warnings?.some((w, i) => checkShown(w, intake) && !intake.done?.includes(i)) ? 'check' : 'page';
}

// The feed's filters: every answer ('all'), what still needs the agent ('needs'), or what is in
// ('done'), whose answers are read back from the page then (refreshAnswers).
function setFilter(filter) {
  state.filter = filter;
  renderSteps();
  if (filter === 'done') refreshAnswers();
}

// Step 1, Intake: one card per thing that looked wrong or missing, with its field to fix,
// Looks right now and where it is on the PDF; then the cleanup notes, and All client details below.
function renderWarnings() {
  const { warnings, done } = state.intake;
  // An `alert` check first, in red: the current commercial auto policy is with the carrier whose
  // site is open (prior.carrier-is-quoted, checkShown; TNI, 2026-10-26: answer to PR question 9).
  // Still a check like the others, no stop (question 19).
  const checks = warnings.map((w, i) => [w, i]).filter(([w]) => checkShown(w)).sort(([a], [b]) => Number(!!b.alert) - Number(!!a.alert));
  const infos = warnings.filter((w) => w.level === 'info');
  const open = checks.filter(([, i]) => !done.includes(i)).length;
  $('check-title').textContent = open ? `${open} to check on the intake` : 'Intake checked';
  $('check-sub').textContent = open
    ? 'Fix or confirm each one, before or after filling.'
    : 'Nothing else looked wrong.';
  const editable = (path) => path && /\.|\]$/.test(path) && fieldInfo(path).label !== path;
  // "See intake" only where the PDF shows the item (an answer only the agent gives: none).
  const pdfLink = (w, label) => {
    const place = sourcePlace(w.path, state.intake);
    return place && pdfAvailable()
      ? h('button', { type: 'button', class: 'ghost', onclick: () => openPdf({ path: w.path, label, kind: 'check' }) }, `See intake${pdfPageSaid(place.page, ' · p')}`)
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
    return h('div', { class: w.alert ? 'check alert' : 'check', ...(w.alert ? { role: 'alert' } : {}), dataset: { check: String(i) } }, head(info, w),
      h('div', { class: 'check-body' },
        info ? fieldRow(w.path, info.label, info.kind, true, 'input') : null,
        h('div', { class: 'check-actions' },
          h('button', { type: 'button', class: 'tinted', onclick: () => toggleDone(i, true) }, 'Looks right'),
          pdfLink(w, label) ?? (w.path && !info ? h('button', { type: 'button', class: 'ghost', onclick: () => jumpTo(w.path) }, 'Show details') : null))));
  });
  $('warnings').replaceChildren(...cards,
    // A row like All client details below it, opening its notes in a card joined under it.
    ...(infos.length ? [h('details', { class: 'fold cleanup' },
      h('summary', { class: 'list-row' }, h('span', { class: 'grow' }, 'Cleanup notes'),
        h('span', { class: 'small muted' }, `${infos.length} change${infos.length === 1 ? '' : 's'}`), h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      h('div', { class: 'card' }, infos.map((w) => h('p', {}, w.msg))))] : []));
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
  return warnings.filter((w, i) => checkShown(w) && !done.includes(i) && w.path && (w.path === prefix || w.path.startsWith(`${prefix}.`) || w.path.startsWith(`${prefix}[`)));
}

// All client details, one card per section (the drawer), every field editable. Built again after
// an edit: the drawer keeps its place and the field in focus. Each section folds (state.detailsClosed),
// and fields the intake leaves blank are hidden unless flagged or the agent's own (`agentEdited`,
// also one they emptied), behind "Show N empty fields" (state.showEmpty): the sample intake has 96
// fields, a third of them blank, and the drawer was too long to scroll (the maintainer, 2026-10-23).
// A section says how many it hides.
function renderSections() {
  const { record } = state.intake;
  const box = $('sections');
  const focused = box.contains(document.activeElement) ? document.activeElement.id : null;
  const top = box.scrollTop;
  box.replaceChildren();
  let hidden = 0;
  for (const section of SECTIONS) {
    const items = section.list ? record[section.list] ?? [] : [record[section.id]];
    if (section.list && !items.length) continue;
    const flags = openFlags(section.list ?? section.id);
    const body = h('div', { class: 'section-body' });
    let empty = 0;
    let fields = 0;
    items.forEach((_, idx) => {
      if (section.list) body.append(h('p', { class: 'item-title' }, `${section.item} ${idx + 1}`));
      for (const [tpl, label, kind = 'text'] of section.fields) {
        const path = tpl.replace('[]', `[${idx}]`);
        const flagged = flags.some((w) => w.path === path);
        const row = fieldRow(path, label, kind, flagged);
        fields++;
        if (row.classList.contains('empty') && !flagged) empty++;
        body.append(row);
      }
    });
    hidden += empty;
    const allEmpty = empty === fields;
    const details = h('details', { class: `section${allEmpty ? ' all-empty' : ''}`, open: !state.detailsClosed.has(section.id), dataset: { id: section.id }, 'aria-label': section.title,
      ontoggle: () => { if (details.open) state.detailsClosed.delete(section.id); else state.detailsClosed.add(section.id); } },
    h('summary', { class: 'section-title' }, h('span', { class: 'title' }, section.title),
      flags.length ? h('span', { class: 'flag' }, `${flags.length} to check`) : null,
      empty && !state.showEmpty ? h('span', { class: 'hidden-count' }, allEmpty ? 'not on form' : `${empty} empty`) : null),
    body);
    box.append(details);
  }
  $('details-view').dataset.empty = state.showEmpty ? 'shown' : 'hidden';
  const toggle = $('details-empty');
  toggle.hidden = !hidden && !state.showEmpty;
  toggle.textContent = state.showEmpty ? 'Hide empty fields' : `Show ${hidden} empty field${hidden === 1 ? '' : 's'}`;
  toggle.setAttribute('aria-pressed', String(state.showEmpty));
  box.scrollTop = top;
  if (focused) $(focused)?.focus({ preventScroll: true });
}

// The drawer's empty fields shown or hidden again (the button in its head); focus stays on it.
function showEmpty(on = !state.showEmpty) {
  state.showEmpty = on;
  renderSections();
  $('details-empty').focus();
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
  } else if (kind === 'state' || fieldInfo(path).options) {
    // The intake form's dropdown, its options in client details too. Its boxes also take typed
    // text, so a value off the list stays, as written, among the options.
    const options = kind === 'state' ? Object.keys(STATES) : fieldInfo(path).options;
    const shown = value == null ? null : String(value);
    input = h('select', { id },
      h('option', { value: '' }, '—'),
      ...(shown != null && !options.includes(shown) ? [h('option', { value: shown, selected: true }, shown)] : []),
      ...options.map((o) => h('option', { value: o, selected: o === shown }, o)));
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
  const empty = value == null && !state.intake.agentEdited?.includes(path);
  return h('div', { class: `field${flagged ? ' flagged' : ''}${empty ? ' empty' : ''}`, dataset: { path } },
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
    // Shown as it fills in; one that empties stays until the drawer is built again (it would go
    // under the agent's eyes as they typed).
    if (value != null) row.closest('.field')?.classList.remove('empty');
  }
  intakeEdited();
  // Log that the agent corrected the intake here (and whether it was flagged), not the value.
  const flaggedCodes = state.intake.warnings.filter((w) => w.path === path).map((w) => w.code);
  usage.log({ type: 'intake_edit', path, kind, change: before == null ? 'added' : after == null ? 'cleared' : 'changed', warnings: flaggedCodes });
  profileLater();
  await save();
  // Luna read the claims box against the form's coverages (NTL and GL are its own questions):
  // an edit to either is read again; a driver's first name, for the gender check, likewise.
  const notesEdit = path === 'claims.text' || path === 'notes.text';
  if (notesEdit) claimsTextEdited(state.intake);
  if (['coverage.ntl', 'coverage.autoLiability'].includes(path)) ntlAnswerEdited(state.intake, path);
  if (['coverage.ntl', 'coverage.autoLiability'].includes(path)) ntlPrimaryEdited(state.intake);
  if (['coverage.ntl', 'coverage.cargo', 'coverage.autoLiability'].includes(path)) { ntlCargoEdited(state.intake); await save(); render(); }
  if (notesEdit || (path.startsWith('coverage.') && !['coverage.ntl', 'coverage.gl', 'coverage.hasGl'].includes(path))) reviewClaimsBox({ retry: true });
  if (/^drivers\[\d+\]\.first$/.test(path)) reviewDriverGender({ retry: true });
}

// "Show in client details": the drawer opens at the field, which is focused and flashed. A field
// hidden as empty, or in a folded section, is brought out first.
function jumpTo(path) {
  openDetails();
  const info = fieldInfo(path);
  const sectionId = info.section?.id ?? SECTIONS.find((s) => s.id === path || s.list === path)?.id;
  let section = $('sections').querySelector(`.section[data-id="${sectionId}"]`);
  if (!section) return;
  let row = $('sections').querySelector(`.field[data-path="${CSS.escape(path)}"]`) ?? section;
  if (!state.showEmpty && row.classList.contains('empty') && !row.classList.contains('flagged')) {
    state.showEmpty = true;
    renderSections();
    section = $('sections').querySelector(`.section[data-id="${sectionId}"]`);
    row = $('sections').querySelector(`.field[data-path="${CSS.escape(path)}"]`) ?? section;
  }
  if (section instanceof HTMLDetailsElement) section.open = true;
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

// The unit forms on screen as the agent discarded their changes (GEICO's "Yes, Discard Changes"; the
// recorder sends the forms with the click): a form's unit was never saved from it, so it no longer
// holds that unit (unitForms). The next blank form is filled for it, and the list's "+" adds it, unless
// the list already shows it (W44-05, PA 2026-10-26: the van's discarded form kept the van bound, so the
// next blank form was filled as the box truck and the van was never added). Its other marks stay: a
// unit a list showed while bound is still on the quote.
function releaseDiscardedForms(forms) {
  let released = false;
  for (const { list, id } of forms) {
    if (!id || !Object.hasOwn(state.unitForms?.[list] ?? {}, id)) continue;
    delete state.unitForms[list][id];
    released = true;
  }
  if (released) persistUnitForms(state.tab?.id, state.unitForms);
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

export { agentEdit, checkShown, firstView, openKeyForm, openSettings, releaseDiscardedForms, render, renderPickers, renderSections, renderWarnings, setFilter, setView, showEmpty, showScreen, toggleDone };
