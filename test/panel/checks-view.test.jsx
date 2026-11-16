import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Checks, Pickers, mountChecks } from '../../sidepanel/panel/checks-view.jsx';

// Step 1's checks (focus mode one-at-a-time on the canvas by default, plus the full list via
// See all intake checks or once every check is done) and the unit pickers in React.

let state;
beforeEach(() => { state = storeState({ checks: null, checksAll: false, pickers: [], intake: null, detailsOpen: false }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);

test('focus mode shows one open check at a time, advances as each is marked, and switches to the checked list when none is left', () => {
  const calls = [];
  const { container } = render(<Checks act={{ openDetails: () => calls.push('details') }} />);
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
  expect([first.dataset.check, first.getAttribute('role'), first.querySelector('.check-eyebrow').textContent, $(container, '#check-title').textContent, $(container, '#check-sub').textContent])
    .toEqual(['0', null, 'Check the intake \u00b7 1 of 2', 'USDOT #', 'Missing on the intake.']);
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

test('focus mode renders serious checks with crimson Serious eyebrow, role="alert", outline Decide later and fill, and choices', () => {
  const calls = [];
  const { container } = render(<Checks act={{}} />);
  act(() => {
    state.checks = { title: '1 to check on the intake', sub: 's', cleanup: [], later: () => calls.push('later'), cards: [
      { i: 1, title: 'Current carrier', msg: 'Current policy is with GEICO.', alert: true, lookRight: () => calls.push('right'),
        field: { path: 'priorInsurance[0].carrier', label: 'Current carrier', control: 'input', value: 'GEICO', maxLength: 200, edit() {} },
        pdf: { label: 'See intake \u00b7 p2', onClick: () => calls.push('pdf') }, details: null },
    ] };
  });
  const card = $(container, '#warnings .check-focus');
  expect([card.className, card.getAttribute('role'), card.querySelector('.check-eyebrow .serious').textContent, card.querySelector('.check-eyebrow').textContent])
    .toEqual(['check check-focus alert', 'alert', 'Serious', 'Serious \u00b7 check 1 of 1']);
  expect([...card.querySelectorAll('.check-actions button')].map((b) => [b.className, b.textContent]))
    .toEqual([['tinted', 'Looks right'], ['ghost', 'See intake \u00b7 p2']]);
  expect([$(container, '#check-later').className, $(container, '#check-later').textContent, card.querySelector('.check-serious-note').textContent, $(container, '#see-all-checks')])
    .toEqual(['ghost check-decide-later', 'Decide later and fill', 'You can fill now, but this answer affects the quote.', null]);
  fireEvent.click($(container, '#check-later'));
  expect(calls.at(-1)).toBe('later');

  // Choices in focus mode: first choice is tinted, second is ghost, with See intake alongside.
  calls.length = 0;
  act(() => {
    state.checks = { title: '1 to check on the intake', sub: 's', cleanup: [], later: () => {}, cards: [
      { i: 2, title: 'General liability', msg: 'The claims box mentions general liability.', choices: [
        { label: 'Client has GL', onClick: () => calls.push('gl') },
        { label: 'Not GL', onClick: () => calls.push('not') },
      ], pdf: { label: 'See intake \u00b7 p3', onClick: () => calls.push('pdf') } },
    ] };
  });
  const choiceBtns = [...container.querySelectorAll('#warnings .check-choices button')];
  expect(choiceBtns.map((b) => [b.className, b.textContent])).toEqual([['tinted', 'Client has GL'], ['ghost', 'Not GL']]);
  fireEvent.click(choiceBtns[0]);
  fireEvent.click(container.querySelector('#warnings .check-actions > button.ghost'));
  expect(calls).toEqual(['gl', 'pdf']);
});

test('See all intake checks opens the full list with One check at a time, keeps focus on the toggle, and resets on a new intake', () => {
  const calls = [];
  const { container } = render(<Checks act={{ openDetails: () => calls.push('details') }} />);
  act(() => {
    state.intake = { intakeId: 'intake-a', stats: { filled: 61 } };
    state.checks = { title: '2 to check on the intake', sub: 'Fix or confirm each one, before or after filling.', cleanup: [], cards: [
      { i: 1, title: 'Current carrier', msg: 'Current insurance is with GEICO.', alert: true, lookRight: () => calls.push('right 1'),
        field: { path: 'priorInsurance[0].carrier', label: 'Current carrier', control: 'input', value: 'GEICO', maxLength: 200, edit: (v) => calls.push(['edit', v]) },
        pdf: { label: 'See intake \u00b7 p2', onClick: () => calls.push('pdf') }, details: null },
      { i: 0, title: null, msg: 'Something else.', alert: false, lookRight: () => calls.push('right 0'), field: null, pdf: null, details: () => calls.push('jump') },
    ] };
  });
  const seeAll = $(container, '#see-all-checks');
  seeAll.focus();
  fireEvent.click(seeAll);
  expect(state.checksAll).toBe(true);
  expect(document.activeElement?.id).toBe('one-check-mode');
  expect([$(container, '#check-title').textContent, $(container, '#check-sub').textContent]).toEqual(['2 to check on the intake', 'Fix or confirm each one, before or after filling.']);
  const [red, plain] = $(container, '#warnings').children;
  expect([red.className, red.getAttribute('role'), red.dataset.check, red.querySelector('.check-text b').textContent]).toEqual(['check alert', 'alert', '1', 'Current carrier']);
  expect([plain.className, plain.getAttribute('role'), plain.dataset.check, plain.querySelector('.check-text b')]).toEqual(['check', null, '0', null]);
  const buttons = (card) => [...card.querySelectorAll('.check-actions button')];
  expect(buttons(red).map((b) => [b.className, b.textContent])).toEqual([['tinted', 'Looks right'], ['ghost', 'See intake \u00b7 p2']]);
  expect(buttons(plain).map((b) => [b.className, b.textContent])).toEqual([['tinted', 'Looks right'], ['ghost', 'Show details']]);
  for (const b of [...buttons(red), ...buttons(plain)]) fireEvent.click(b);
  expect(calls).toEqual(['right 1', 'pdf', 'right 0', 'jump']);

  // All client details row stays below in both modes.
  const row = $(container, '#details-row');
  expect([row.getAttribute('aria-controls'), row.getAttribute('aria-expanded'), $(container, '#details-count').textContent]).toEqual(['details-view', 'false', '61 answers']);
  fireEvent.click(row);
  expect(calls.at(-1)).toBe('details');
  act(() => { state.detailsOpen = true; });
  expect(row.getAttribute('aria-expanded')).toBe('true');

  // One check at a time returns to focus mode and keeps keyboard focus on #see-all-checks.
  fireEvent.click($(container, '#one-check-mode'));
  expect([state.checksAll, !!$(container, '#warnings .check-focus'), document.activeElement?.id]).toEqual([false, true, 'see-all-checks']);

  // Loading another intake resets full-list mode back to focus mode.
  fireEvent.click($(container, '#see-all-checks'));
  expect(state.checksAll).toBe(true);
  act(() => { state.intake = { intakeId: 'intake-b', stats: { filled: 12 } }; });
  expect([state.checksAll, !!$(container, '#warnings .check-focus')]).toEqual([false, true]);
});

// Review of PR #376 (CodeRabbit): "No" typed on a card for an empty USDOT box is saved empty, the
// same value as before; the edit's `rev` makes it another box, which shows the record's value.
test('a check card\'s box shows the record\'s value after an edit saved it as it was', () => {
  const { container } = render(<Checks act={{}} />);
  const say = (rev) => act(() => { state.checks = { title: 't', sub: 's', cleanup: [], cards: [{ i: 0, title: 'USDOT #', msg: 'm', alert: false, lookRight() {},
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
  const say = (value) => act(() => { state.checks = { title: 't', sub: 's', cleanup: [], cards: [{ i: 0, title: 'Business class', msg: 'm', alert: false, lookRight() {}, field: field(value) }] }; });
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
    state.checks = { title: '1 to check on the intake', sub: 'Fix or confirm each one, before or after filling.', cleanup: ['Phone reformatted.', 'Name trimmed.'], cards: [
      { i: 2, title: 'Gender', msg: 'm', done: true, said: 'Gender checked', undo: () => calls.push('undo') },
      { i: 3, title: null, msg: 'The claims box mentions general liability.', choices: [{ label: 'Client has GL', onClick: () => calls.push('gl') }, { label: 'Not GL', onClick: () => calls.push('not') }], pdf: null },
    ] };
  });
  const [checked, choiceCard, cleanupNotes] = $(container, '#warnings').children;
  expect([checked.className, checked.dataset.check, checked.querySelector('.tick').textContent, checked.querySelector('.grow').textContent]).toEqual(['checked-row', '2', '\u2713', 'Gender checked']);
  fireEvent.click(checked.querySelector('button.link'));
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
