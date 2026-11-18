import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../sidepanel/panel/env.js', async (importOriginal) => ({ ...(await importOriginal()), inExtension: true }));
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ANNOUNCE_MS } from '../../sidepanel/panel/announce.js';
import { state as coreState } from '../../sidepanel/panel/core.js';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { decideLater, render as renderRecord, setChecksAll } from '../../sidepanel/panel/record.js';
import { Checks, Pickers, mountChecks } from '../../sidepanel/panel/checks-view.jsx';
import { Screen } from '../../sidepanel/panel/screen-view.jsx';
import { Dock } from '../../sidepanel/panel/steps-view.jsx';

// Step 1's checks (focus mode one-at-a-time on the canvas by default, plus the full list via
// See all intake checks or once every check is done) and the unit pickers in React.

const base = { ...coreState };
let state;
beforeEach(() => {
  state = storeState({
    ...base,
    checks: null, checksAll: false, pickers: [], intake: null, detailsOpen: false,
    view: 'check', settingsOpen: false, pdf: null, summary: null, dock: null, fillingFor: null,
    tab: null, reports: new Map(), aiDocks: new Map(), tabSteps: new Map(), stopScreens: new Map(),
    quoteStates: new Map(), quoteOwners: new Map(), detailsClosed: new Set(), showEmpty: false, unitForms: {}, active: { vehicles: 0, drivers: 0, trailers: 0 },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup();
});

const $ = (container, sel) => container.querySelector(sel);
const modeActs = (extra = {}) => ({
  showAll: () => setChecksAll(true),
  showOne: () => setChecksAll(false),
  ...extra,
});

test('focus mode shows one open check at a time, advances as each is marked, and switches to the checked list when none is left', () => {
  const calls = [];
  const { container } = render(<Checks act={modeActs({ openDetails: () => calls.push('details') })} />);
  const makeCards = (done = []) => [
    { i: 0, title: 'USDOT #', msg: 'Missing on the intake.', alert: false, done: done.includes(0), said: 'USDOT # checked',
      undo: () => calls.push('undo 0'), lookRight: () => { calls.push('right 0'); setDone([...done, 0]); },
      field: { path: 'applicant.dot', label: 'USDOT #', control: 'input', value: '1234567', maxLength: 200, edit: (v) => calls.push(['edit', v]) },
      pdf: { label: 'See intake \u00b7 p1', onClick: () => calls.push('pdf 0') }, details: null },
    { i: 1, title: null, msg: 'Check the operations note.', alert: false, done: done.includes(1), said: 'Note checked',
      undo: () => calls.push('undo 1'), lookRight: () => { calls.push('right 1'); setDone([...done, 1]); },
      field: null, pdf: null, details: () => calls.push('jump 1') },
  ];
  const setDone = (done) => {
    const cards = makeCards(done);
    const open = cards.filter((c) => !c.done).length;
    state.checks = {
      title: open ? `${open} to check on the intake` : 'Intake checked',
      sub: open ? 'Fix or confirm each one, before or after filling.' : 'Nothing else looked wrong.',
      open,
      cards,
      cleanup: ['Phone reformatted.'],
      later: () => calls.push('later'),
    };
  };
  act(() => {
    state.intake = { intakeId: 'q1', stats: { filled: 61 } };
    setDone([]);
  });
  // Only the first open check is drawn, with 1-of-2 eyebrow, 26px title, field, primary Looks right, and quiet links.
  expect(container.querySelectorAll('#warnings .check').length).toBe(1);
  const first = $(container, '#warnings .check-focus');
  expect([first.dataset.check, first.getAttribute('role'), first.querySelector('.check-eyebrow').getAttribute('role'), first.querySelector('.check-eyebrow').textContent, $(container, '#check-title').textContent, $(container, '#check-sub').textContent])
    .toEqual(['0', null, null, 'Check the intake \u00b7 1 of 2', 'USDOT #', 'Missing on the intake.']);
  const box = first.querySelector('.check-focus-body input');
  expect([box.getAttribute('aria-label'), box.id, box.value, box.placeholder, box.maxLength]).toEqual(['USDOT #', '', '1234567', 'not on form', 200]);
  fireEvent.input(box, { target: { value: '7654321' } });
  expect(calls).toEqual([]);
  fireEvent.change(box);
  expect(calls).toEqual([['edit', '7654321']]);
  expect([...first.querySelectorAll('.check-actions button')].map((b) => [b.className, b.textContent]))
    .toEqual([['primary', 'Looks right'], ['ghost', 'See intake \u00b7 p1']]);
  expect([$(container, '#check-later').className, $(container, '#check-later').textContent, $(container, '#see-all-checks').textContent])
    .toEqual(['link subtle', 'Check the rest later', 'See all intake checks']);
  fireEvent.click($(container, '#check-later'));
  expect(calls.at(-1)).toBe('later');

  // Marking check 0 done advances focus mode to check 2 of 2 (fallback title when card.title is null; See all stays while total > 1).
  act(() => { fireEvent.click(first.querySelector('.check-actions .primary')); });
  const second = $(container, '#warnings .check-focus');
  expect([second.dataset.check, second.querySelector('.check-eyebrow').textContent, $(container, '#check-title').textContent, $(container, '#check-sub').textContent])
    .toEqual(['1', 'Check the intake \u00b7 2 of 2', 'Check this answer', 'Check the operations note.']);
  expect([...second.querySelectorAll('.check-actions button')].map((b) => [b.className, b.textContent]))
    .toEqual([['primary', 'Looks right'], ['ghost', 'Show details']]);
  expect(!!$(container, '#see-all-checks')).toBe(true);
  fireEvent.click(second.querySelector('.check-actions .ghost'));
  expect(calls.at(-1)).toBe('jump 1');

  // Marking the last open check done switches to the full list ("Intake checked") with Undo rows and Cleanup notes.
  act(() => { fireEvent.click(second.querySelector('.check-actions .primary')); });
  expect($(container, '#warnings .check-focus')).toBe(null);
  expect([$(container, '#check-title').textContent, $(container, '#check-sub').textContent, !!$(container, '#one-check-mode')])
    .toEqual(['Intake checked', 'Nothing else looked wrong.', false]);
  expect([...container.querySelectorAll('#warnings .checked-row')].map((r) => r.querySelector('.grow').textContent))
    .toEqual(['USDOT # checked', 'Note checked']);
});

test('focus mode renders serious checks with role="alert" on the Serious eyebrow only, announces the serious note once, and gives all choice buttons the same class', () => {
  vi.useFakeTimers();
  const calls = [];
  const { container } = render(<><div id="announce" /><Checks act={modeActs()} /></>);
  const live = $(container, '#announce');
  act(() => {
    state.checks = { title: '1 to check on the intake', sub: 's', open: 1, cleanup: [], later: () => calls.push('later'), cards: [
      { i: 1, title: 'Current carrier', msg: 'Current policy is with GEICO.', alert: true, lookRight: () => calls.push('right'),
        field: { path: 'priorInsurance[0].carrier', label: 'Current carrier', control: 'input', value: 'GEICO', maxLength: 200, edit() {} },
        pdf: { label: 'See intake \u00b7 p2', onClick: () => calls.push('pdf') }, details: null },
    ] };
  });
  const card = $(container, '#warnings .check-focus');
  const eyebrow = card.querySelector('.check-eyebrow');
  expect([card.className, card.getAttribute('role'), eyebrow.getAttribute('role'), eyebrow.querySelector('.serious').textContent, eyebrow.textContent])
    .toEqual(['check check-focus alert', null, 'alert', 'Serious', 'Serious \u00b7 check 1 of 1']);
  act(() => { vi.advanceTimersByTime(ANNOUNCE_MS); });
  expect(live.textContent).toBe('You can fill now, but this answer affects the quote.');
  // Typing or redrawing the same serious check does not re-announce the serious note.
  live.textContent = '';
  act(() => {
    state.checks = { ...state.checks, cards: [{ ...state.checks.cards[0], msg: 'Current policy is with GEICO.' }] };
    vi.advanceTimersByTime(ANNOUNCE_MS);
  });
  expect(live.textContent).toBe('');
  expect([...card.querySelectorAll('.check-actions button')].map((b) => [b.className, b.textContent]))
    .toEqual([['tinted', 'Looks right'], ['ghost', 'See intake \u00b7 p2']]);
  expect([$(container, '#check-later').className, $(container, '#check-later').textContent, card.querySelector('.check-serious-note').textContent, $(container, '#see-all-checks')])
    .toEqual(['ghost check-decide-later', 'Decide later and fill', 'You can fill now, but this answer affects the quote.', null]);
  fireEvent.click($(container, '#check-later'));
  expect(calls.at(-1)).toBe('later');

  // Choices in focus mode: every choice button shares the same neutral class (`ghost`), never visually recommending the first.
  calls.length = 0;
  act(() => {
    state.checks = { title: '1 to check on the intake', sub: 's', open: 1, cleanup: [], later: () => {}, cards: [
      { i: 2, title: 'General liability', msg: 'The claims box mentions general liability.', choices: [
        { label: 'Client has GL', onClick: () => calls.push('gl') },
        { label: 'Not GL', onClick: () => calls.push('not') },
        { label: 'Dismiss', onClick: () => calls.push('dismiss') },
      ], pdf: { label: 'See intake \u00b7 p3', onClick: () => calls.push('pdf') } },
    ] };
  });
  const choiceBtns = [...container.querySelectorAll('#warnings .check-choices button')];
  expect(new Set(choiceBtns.map((b) => b.className))).toEqual(new Set(['ghost']));
  expect(choiceBtns.map((b) => [b.className, b.textContent])).toEqual([
    ['ghost', 'Client has GL'],
    ['ghost', 'Not GL'],
    ['ghost', 'Dismiss'],
  ]);
  fireEvent.click(choiceBtns[0]);
  fireEvent.click(container.querySelector('#warnings .check-actions > button.ghost'));
  expect(calls).toEqual(['gl', 'pdf']);
});

test('See all intake checks renders when 1 open check has cleanup notes, and hides when 1 open check has none', () => {
  const { container } = render(<Checks act={modeActs()} />);
  // 1 open check + 1 cleanup note (regular check): #see-all-checks shows and opens the full list with Cleanup notes.
  act(() => {
    state.checks = {
      title: '1 to check on the intake', sub: 's', open: 1, cleanup: ['Phone reformatted.'], later() {},
      cards: [{ i: 0, title: 'USDOT #', msg: 'Missing.', alert: false, lookRight() {} }],
    };
  });
  expect($(container, '#see-all-checks')?.textContent).toBe('See all intake checks');
  fireEvent.click($(container, '#see-all-checks'));
  expect(state.checksAll).toBe(true);
  expect($(container, '#warnings details.cleanup summary .small')?.textContent).toBe('1 change');

  // Back to focus mode on a single serious check + cleanup note: #see-all-checks shows there too, then hides once cleanup is empty.
  fireEvent.click($(container, '#one-check-mode'));
  act(() => {
    state.checks = {
      title: '1 to check on the intake', sub: 's', open: 1, cleanup: ['ZIP trimmed.'], later() {},
      cards: [{ i: 0, title: 'Current carrier', msg: 'With GEICO.', alert: true, lookRight() {} }],
    };
  });
  expect($(container, '#see-all-checks')?.textContent).toBe('See all intake checks');
  act(() => { state.checks = { ...state.checks, cleanup: [] }; });
  expect($(container, '#see-all-checks')).toBe(null);
});

test('See all intake checks opens the full list via act.showAll / act.showOne, keeps focus on the toggle, and record.js resets checksAll on a new intake', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)[1];
  document.body.innerHTML = body;
  document.getElementById('feed-root').innerHTML = '<div id="report"></div><div id="past"></div>';
  const calls = [];
  mountChecks(document.getElementById('check-view'), modeActs({ openDetails: () => calls.push('details') }));

  const makeIntake = (intakeId) => ({
    intakeId,
    fileName: `${intakeId}.pdf`,
    stats: { filled: 61 },
    record: { applicant: { name: 'Acme Hauling LLC', state: 'TX' }, vehicles: [], drivers: [], trailers: [], priorInsurance: [] },
    warnings: [
      { level: 'check', code: 'prior.carrier', path: 'applicant.dot', msg: 'Current insurance is with GEICO.', alert: true },
      { level: 'check', code: 'ops.note', path: '', msg: 'Something else.' },
    ],
    done: [],
    agentEdited: [],
    agentDerived: [],
  });

  act(() => {
    coreState.intake = makeIntake('intake-a');
    renderRecord();
  });
  const host = document.getElementById('check-view');
  const seeAll = $(host, '#see-all-checks');
  seeAll.focus();
  fireEvent.click(seeAll);
  expect(state.checksAll).toBe(true);
  expect(document.activeElement?.id).toBe('one-check-mode');
  expect([$(host, '#check-title').textContent, $(host, '#check-sub').textContent]).toEqual(['2 to check on the intake', 'Fix or confirm each one, before or after filling.']);
  const [red, plain] = $(host, '#warnings').children;
  expect([red.className, red.getAttribute('role'), red.dataset.check]).toEqual(['check alert', 'alert', '0']);
  expect([plain.className, plain.getAttribute('role'), plain.dataset.check]).toEqual(['check', null, '1']);

  // All client details row stays below in both modes.
  const row = $(host, '#details-row');
  expect([row.getAttribute('aria-controls'), row.getAttribute('aria-expanded'), $(host, '#details-count').textContent]).toEqual(['details-view', 'false', '61 answers']);
  fireEvent.click(row);
  expect(calls.at(-1)).toBe('details');
  act(() => { state.detailsOpen = true; });
  expect(row.getAttribute('aria-expanded')).toBe('true');

  // One check at a time returns to focus mode via act.showOne and keeps keyboard focus on #see-all-checks.
  fireEvent.click($(host, '#one-check-mode'));
  expect([state.checksAll, !!$(host, '#warnings .check-focus'), document.activeElement?.id]).toEqual([false, true, 'see-all-checks']);

  // Re-rendering the SAME intake keeps checksAll === true, while rendering a NEW intake in record.js resets checksAll to false.
  fireEvent.click($(host, '#see-all-checks'));
  expect(state.checksAll).toBe(true);
  act(() => { renderRecord(); });
  expect(state.checksAll).toBe(true);
  act(() => {
    coreState.intake = makeIntake('intake-b');
    renderRecord();
  });
  expect([state.checksAll, !!$(host, '#warnings .check-focus')]).toEqual([false, true]);
  fireEvent.click($(host, '#see-all-checks'));
  expect(state.checksAll).toBe(true);
  act(() => { coreState.intake = null; renderRecord(); });
  expect(state.checksAll).toBe(false);
  document.body.innerHTML = '';
});

test('Decide later and fill switches to the page view without starting a fill and moves focus to the dock primary button when focus was inside the panel', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)[1];
  document.getElementById('feed-root').innerHTML = '<div id="report"></div><div id="past"></div>';
  let fillClicks = 0;
  const dockActs = { fill: () => { fillClicks += 1; }, stop() {}, next() {}, lookRight() {}, approve() {}, defaults() {}, summary() {}, alt() {} };
  const screenView = render(<Screen />, { container: document.getElementById('screen-root') });
  const checksView = render(<Checks act={modeActs()} />, { container: document.getElementById('check-view') });
  const dockView = render(<Dock act={dockActs} />, { container: document.getElementById('dock-root') });

  const intake = {
    intakeId: 'intake-later',
    fileName: 'acme.pdf',
    stats: { filled: 10 },
    record: { applicant: { name: 'Acme LLC', garagingState: 'TX' }, vehicles: [], drivers: [], trailers: [], priorInsurance: [] },
    warnings: [{ level: 'check', code: 'owner.drives', path: 'applicant.ownerDrives', msg: 'Does the owner drive?', alert: true }],
    done: [],
    agentEdited: [],
    agentDerived: [],
  };
  act(() => {
    coreState.intake = intake;
    coreState.view = 'check';
    renderRecord();
    // Put the dock on a ready rater page with an enabled #fill primary button.
    state.dock = {
      phase: 'ready', eyebrow: 'Next', title: 'Fill the Business page', sub: '',
      button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false,
    };
  });
  // Keep dockFor on a ready carrier page when setView('page') calls showScreen() -> renderDock().
  coreState.tab = {
    id: 7,
    url: 'https://gateway.geico.com/Commercial/BusinessInfo',
    carrier: { id: 'geico', name: 'GEICO', steps: ['BusinessInfo'], pageOf: () => 'BusinessInfo', labelOf: () => 'Business Info' },
  };
  coreState.quoteOwners = new Map([[7, { intakeId: 'intake-later' }]]);

  // 1. Focus inside the panel on #check-later ("Decide later and fill"): switches to page view, does NOT fill, and focuses #fill instead of #screen-title.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const laterBtn = document.getElementById('check-later');
  expect(laterBtn?.textContent).toBe('Decide later and fill');
  laterBtn.focus();
  expect(document.activeElement).toBe(laterBtn);
  fireEvent.click(laterBtn);
  expect([state.view, fillClicks, document.activeElement?.id]).toEqual(['page', 0, 'fill']);

  // 2. When the dock primary button is disabled (e.g. state mismatch hold), focus falls cleanly to #screen-title.
  act(() => {
    coreState.view = 'check';
    coreState.filling = true;
    renderRecord();
  });
  const holdLater = document.getElementById('check-later');
  holdLater.focus();
  fireEvent.click(holdLater);
  expect([state.view, /** @type {HTMLButtonElement} */ (document.getElementById('fill')).disabled, document.activeElement?.id]).toEqual(['page', true, 'screen-title']);
  coreState.filling = false;

  // 3. When the panel did NOT have focus (focus on document.body or unfocused window), decideLater() switches views without stealing focus to #fill.
  /** @type {HTMLElement | null} */ (document.activeElement)?.blur?.();
  act(() => { coreState.view = 'check'; renderRecord(); });
  expect(document.activeElement).toBe(document.body);
  act(() => { decideLater(); });
  expect([state.view, fillClicks, document.activeElement]).toEqual(['page', 0, document.body]);

  screenView.unmount();
  checksView.unmount();
  dockView.unmount();
  document.body.innerHTML = '';
});

// Review of PR #376 (CodeRabbit): "No" typed on a card for an empty USDOT box is saved empty, the
// same value as before; the edit's `rev` makes it another box, which shows the record's value.
test('a check card\'s box shows the record\'s value after an edit saved it as it was', () => {
  const { container } = render(<Checks act={{}} />);
  const say = (rev) => act(() => { state.checks = { title: 't', sub: 's', open: 1, cleanup: [], cards: [{ i: 0, title: 'USDOT #', msg: 'm', alert: false, lookRight() {},
    field: { path: 'applicant.dot', label: 'USDOT #', control: 'input', value: '', rev, maxLength: 200, edit() {} } }] }; });
  say(0);
  const box = container.querySelector('#warnings input');
  fireEvent.input(box, { target: { value: 'No' } });
  fireEvent.change(box);
  say(0);
  /** @returns {HTMLInputElement} */
  const shown = () => /** @type {HTMLInputElement} */ (container.querySelector('#warnings input'));
  expect(shown().value).toBe('No');
  say(1);
  expect(shown().value).toBe('');
});

test('a check card\'s box shows the intake\'s answer again when it changes, and its dropdown keeps a value off the list', () => {
  const { container } = render(<Checks act={{}} />);
  const field = (value) => ({ path: 'operations.businessClass', label: 'Business class', control: 'select', value,
    options: [['', '\u2014'], ...(value && value !== 'Expediter' ? [[value, value]] : []), ['Expediter', 'Expediter'], ['Freight Hauler', 'Freight Hauler']], edit() {} });
  const say = (value) => act(() => { state.checks = { title: 't', sub: 's', open: 1, cleanup: [], cards: [{ i: 0, title: 'Business class', msg: 'm', alert: false, lookRight() {}, field: field(value) }] }; });
  say('Courier');
  const select = () => $(container, '#warnings select');
  expect([...select().options].map((o) => [o.value, o.selected])).toEqual([['', false], ['Courier', true], ['Expediter', false], ['Freight Hauler', false]]);
  say('Expediter');
  expect(select().value).toBe('Expediter');
  say(null);
  expect(select().value).toBe('');
});

test('in full-list mode a checked item is a row with Undo; choices are ghost buttons; cleanup notes fold under the checks', () => {
  const calls = [];
  const { container } = render(<Checks act={{}} />);
  act(() => {
    state.checksAll = true;
    state.checks = { title: '1 to check on the intake', sub: 'Fix or confirm each one, before or after filling.', open: 1, cleanup: ['Phone reformatted.', 'Name trimmed.'], cards: [
      { i: 2, title: 'Gender', msg: 'm', done: true, said: 'Gender checked', undo: () => calls.push('undo') },
      { i: 3, title: null, msg: 'The claims box mentions general liability.', choices: [{ label: 'Client has GL', onClick: () => calls.push('gl') }, { label: 'Not GL', onClick: () => calls.push('not') }], pdf: null },
    ] };
  });
  const [checked, choiceCard, cleanupNotes] = $(container, '#warnings').children;
  expect([checked.className, checked.dataset.check, checked.querySelector('.tick').textContent, checked.querySelector('.grow').textContent]).toEqual(['checked-row', '2', '\u2713', 'Gender checked']);
  // Undo is an icon button, named for the check it undoes.
  expect(checked.querySelector('button.undo-btn').getAttribute('aria-label')).toBe('Undo: Gender checked');
  fireEvent.click(checked.querySelector('button.undo-btn'));
  expect([choiceCard.className, choiceCard.querySelector('input, select, textarea'), [...choiceCard.querySelectorAll('.check-choices button')].map((b) => b.textContent)]).toEqual(['check', null, ['Client has GL', 'Not GL']]);
  expect(choiceCard.querySelector('.tinted')).toBe(null);
  for (const b of choiceCard.querySelectorAll('.check-choices button')) fireEvent.click(b);
  expect(calls).toEqual(['undo', 'gl', 'not']);
  expect([cleanupNotes.tagName, cleanupNotes.className, cleanupNotes.querySelector('summary .small').textContent, [...cleanupNotes.querySelectorAll('.card p')].map((p) => p.textContent)])
    .toEqual(['DETAILS', 'fold cleanup', '2 changes', ['Phone reformatted.', 'Name trimmed.']]);
});

test('the unit pickers: one per list the page is about, the one picked chosen, a pick said with its number; none leaves the box empty', () => {
  const picks = [];
  const { container } = render(<div id="pickers"><Pickers act={{ pick: (list, i) => picks.push([list, i]) }} /></div>);
  const box = $(container, '#pickers');
  expect(box.childElementCount).toBe(0);
  act(() => { state.pickers = [{ list: 'vehicles', what: 'Vehicle', names: ['1. 2020 Ford Transit', '2. 2018 Isuzu NPR'], active: 1 }, { list: 'trailers', what: 'Trailer', names: ['1. Trailer', '2. Trailer'], active: null }]; });
  const [vehicles, trailers] = box.querySelectorAll('.picker');
  expect([vehicles.querySelector('label').htmlFor, vehicles.querySelector('label').textContent, vehicles.querySelector('select').id, vehicles.querySelector('select').value]).toEqual(['pick-vehicles', 'Vehicle', 'pick-vehicles', '1']);
  expect(trailers.querySelector('select').value, 'none picked yet: the first').toBe('0');
  fireEvent.change(vehicles.querySelector('select'), { target: { value: '0' } });
  expect(picks).toEqual([['vehicles', 0]]);
  act(() => { state.pickers = []; });
  expect(box.childElementCount).toBe(0);
});

test('mountChecks draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('section'));
  act(() => {
    mountChecks(host, {});
    expect(['check-title', 'warnings', 'details-row', 'details-count'].map((id) => !!host.querySelector(`#${id}`))).toEqual([true, true, true, true]);
  });
  host.remove();
});
