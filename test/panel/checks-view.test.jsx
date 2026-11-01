import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Checks, Pickers, mountChecks } from '../../sidepanel/panel/checks-view.jsx';

// Step 1's checks and the unit pickers in React (React PR 8, 2026-11-01): what renderWarnings and
// renderPickers drew with h(), drawn from what they say now (state.checks, state.pickers). Which
// items show, in what order and with which buttons is checked by the safety tests (the alert check
// first, Luna's choices, the carrier's own check only on its site); here, that the page draws them
// as before and that each button and box does what it says.

let state;
beforeEach(() => { state = storeState({ checks: null, pickers: [], intake: null, detailsOpen: false }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);

test('a check is drawn as before: red and said at once when it is an alert, its field, Looks right and See intake', () => {
  const calls = [];
  const { container } = render(<Checks act={{ openDetails: () => calls.push('details') }} />);
  act(() => {
    state.intake = { stats: { filled: 61 } };
    state.checks = { title: '2 to check on the intake', sub: 'Fix or confirm each one, before or after filling.', cleanup: [], cards: [
      { i: 1, title: 'Current carrier', msg: 'Current insurance is with GEICO.', alert: true, lookRight: () => calls.push('right 1'),
        field: { path: 'priorInsurance[0].carrier', label: 'Current carrier', control: 'input', value: 'GEICO', maxLength: 200, edit: (v) => calls.push(['edit', v]) },
        pdf: { label: 'See intake · p2', onClick: () => calls.push('pdf') }, details: null },
      { i: 0, title: null, msg: 'Something else.', alert: false, lookRight: () => calls.push('right 0'), field: null, pdf: null, details: () => calls.push('jump') },
    ] };
  });
  expect([$(container, '#check-title').textContent, $(container, '#check-sub').textContent]).toEqual(['2 to check on the intake', 'Fix or confirm each one, before or after filling.']);
  const [red, plain] = $(container, '#warnings').children;
  expect([red.className, red.getAttribute('role'), red.dataset.check, red.querySelector('.check-text b').textContent]).toEqual(['check alert', 'alert', '1', 'Current carrier']);
  expect([plain.className, plain.getAttribute('role'), plain.dataset.check, plain.querySelector('.check-text b')]).toEqual(['check', null, '0', null]);
  // The field: named by the card (no id: client details may have the same field open), the intake's
  // answer in it; an edit is the box's change, not each key.
  const box = red.querySelector('.check-body input');
  expect([box.getAttribute('aria-label'), box.id, box.value, box.placeholder, box.maxLength]).toEqual(['Current carrier', '', 'GEICO', 'not on form', 200]);
  fireEvent.input(box, { target: { value: 'Progressive' } });
  expect(calls).toEqual([]);
  fireEvent.change(box);
  expect(calls).toEqual([['edit', 'Progressive']]);
  const buttons = (card) => [...card.querySelectorAll('.check-actions button')];
  expect(buttons(red).map((b) => [b.className, b.textContent])).toEqual([['tinted', 'Looks right'], ['ghost', 'See intake · p2']]);
  expect(buttons(plain).map((b) => [b.className, b.textContent])).toEqual([['tinted', 'Looks right'], ['ghost', 'Show details']]);
  for (const b of [...buttons(red), ...buttons(plain)]) fireEvent.click(b);
  expect(calls.slice(1)).toEqual(['right 1', 'pdf', 'right 0', 'jump']);
  // All client details: how many answers, and whether it is open.
  const row = $(container, '#details-row');
  expect([row.getAttribute('aria-controls'), row.getAttribute('aria-expanded'), $(container, '#details-count').textContent]).toEqual(['details-view', 'false', '61 answers']);
  fireEvent.click(row);
  expect(calls.at(-1)).toBe('details');
  act(() => { state.detailsOpen = true; });
  expect(row.getAttribute('aria-expanded')).toBe('true');
});

test('a check card\'s box shows the intake\'s answer again when it changes, and its dropdown keeps a value off the list', () => {
  const { container } = render(<Checks act={{}} />);
  const field = (value) => ({ path: 'operations.businessClass', label: 'Business class', control: 'select', value,
    options: [['', '—'], ...(value && value !== 'Expediter' ? [[value, value]] : []), ['Expediter', 'Expediter'], ['Freight Hauler', 'Freight Hauler']], edit() {} });
  const say = (value) => act(() => { state.checks = { title: 't', sub: 's', cleanup: [], cards: [{ i: 0, title: 'Business class', msg: 'm', alert: false, lookRight() {}, field: field(value) }] }; });
  say('Courier');
  const select = () => $(container, '.check-body select');
  expect([...select().options].map((o) => [o.value, o.selected])).toEqual([['', false], ['Courier', true], ['Expediter', false], ['Freight Hauler', false]]);
  say('Expediter');
  expect(select().value).toBe('Expediter');
  say(null);
  expect(select().value).toBe('');
});

test('a checked item is a row with Undo; Luna\'s choices are its buttons; the cleanup notes fold under the checks', () => {
  const calls = [];
  const { container } = render(<Checks act={{}} />);
  act(() => {
    state.checks = { title: 'Intake checked', sub: 'Nothing else looked wrong.', cleanup: ['Phone reformatted.', 'Name trimmed.'], cards: [
      { i: 2, title: 'Gender', msg: 'm', done: true, said: 'Gender checked', undo: () => calls.push('undo') },
      { i: 3, title: null, msg: 'Luna: the claims box mentions general liability.', choices: [{ label: 'Client has GL', onClick: () => calls.push('gl') }, { label: 'Not GL', onClick: () => calls.push('not') }], pdf: null },
    ] };
  });
  const [checked, luna, cleanupNotes] = $(container, '#warnings').children;
  expect([checked.className, checked.dataset.check, checked.querySelector('.tick').textContent, checked.querySelector('.grow').textContent]).toEqual(['checked-row', '2', '✓', 'Gender checked']);
  fireEvent.click(checked.querySelector('button.link'));
  expect([luna.className, luna.querySelector('input, select, textarea'), [...luna.querySelectorAll('.check-choices button')].map((b) => b.textContent)]).toEqual(['check', null, ['Client has GL', 'Not GL']]);
  expect(luna.querySelector('.tinted')).toBe(null);
  for (const b of luna.querySelectorAll('.check-choices button')) fireEvent.click(b);
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
