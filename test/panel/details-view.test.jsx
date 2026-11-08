// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Details, mountDetails } from '../../sidepanel/panel/details-view.jsx';

// All client details in React (React PR 9, 2026-11-01): what renderSections built with h(), drawn
// from what it says now (state.details). Which fields show, flagged or empty, and what an edit does
// to the record is checked by the safety tests (renderSections, fieldRow, agentEdit); here, that the
// drawer draws them as before, that a box's edit is its change, and that a value said again is
// shown in the same box (the agent's focus stays).

let state;
beforeEach(() => { state = storeState({ details: null }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);
const field = (path, value, more = {}) => ({ id: `f-${path.replace(/[^\w]/g, '_')}`, path, label: path, control: 'input', value, blank: value === '', maxLength: 200, flagged: false, empty: false, edit() {}, ...more });

test('the drawer: its sections, each field\'s row, the empty fields\' button, and Close', () => {
  const calls = [];
  const folds = [];
  const { container } = render(<Details act={{ close: () => calls.push('close'), showEmpty: () => calls.push('empty') }} />);
  act(() => {
    state.details = { showEmpty: false, toggle: 'Show 12 empty fields', fold: (id, open) => folds.push([id, open]), sections: [
      { id: 'garaging', title: 'Garaging', open: true, allEmpty: false, flags: 1, hiddenSaid: '3 empty', rows: [
        field('garaging.city', 'Austin'), field('garaging.zip', '', { flagged: true, empty: true }), field('garaging.county', '', { empty: true })] },
      { id: 'drivers', title: 'Drivers', open: false, allEmpty: true, flags: 0, hiddenSaid: 'not on form', rows: [{ item: 'Driver 1' }, field('drivers[0].email', '', { empty: true })] },
    ] };
  });
  const panel = $(container, '.drawer-panel');
  expect([panel.getAttribute('role'), panel.getAttribute('aria-modal'), panel.getAttribute('aria-labelledby'), panel.dataset.empty]).toEqual(['dialog', 'true', 'details-title', 'hidden']);
  const [garaging, drivers] = container.querySelectorAll('#sections > details');
  expect([garaging.className, garaging.open, garaging.dataset.id, garaging.getAttribute('aria-label')]).toEqual(['section', true, 'garaging', 'Garaging']);
  expect([...garaging.querySelectorAll('summary > span')].map((s) => [s.className, s.textContent])).toEqual([['title', 'Garaging'], ['flag', '1 to check'], ['hidden-count', '3 empty']]);
  expect([drivers.className, drivers.open, drivers.querySelector('.item-title').textContent]).toEqual(['section all-empty', false, 'Driver 1']);
  // A row: its class (flagged, empty), its path, and its label for its box.
  const rows = [...garaging.querySelectorAll('.section-body > .field')];
  expect(rows.map((r) => [r.className, r.dataset.path])).toEqual([['field', 'garaging.city'], ['field flagged empty', 'garaging.zip'], ['field empty', 'garaging.county']]);
  const city = rows[0].querySelector('input');
  expect([rows[0].querySelector('label').htmlFor, city.id, city.value, city.placeholder, city.maxLength]).toEqual(['f-garaging_city', 'f-garaging_city', 'Austin', 'not on form', 200]);
  // Folding a section keeps it folded when the drawer is said again.
  garaging.open = false;
  fireEvent(garaging, new Event('toggle'));
  expect(folds).toEqual([['garaging', false]]);
  // The empty fields' button, Close and the scrim.
  const toggle = $(container, '#details-empty');
  expect([toggle.hidden, toggle.textContent, toggle.getAttribute('aria-pressed')]).toEqual([false, 'Show 12 empty fields', 'false']);
  fireEvent.click(toggle);
  fireEvent.click($(container, '#details-close'));
  fireEvent.click($(container, '#details-scrim'));
  expect(calls).toEqual(['empty', 'close', 'close']);
  act(() => { state.details = { ...state.details, showEmpty: true, toggle: 'Hide empty fields' }; });
  expect([panel.dataset.empty, toggle.textContent, toggle.getAttribute('aria-pressed')]).toEqual(['shown', 'Hide empty fields', 'true']);
  act(() => { state.details = { ...state.details, showEmpty: false, toggle: null }; });
  expect(toggle.hidden, 'nothing to hide: no button').toBe(true);
});

test('a box\'s edit is its change, not each key; a value said again shows in the same box, and the agent keeps their focus', () => {
  const edits = [];
  const { container } = render(<Details act={{}} />);
  const say = (radius, miles) => act(() => {
    state.details = { showEmpty: false, toggle: null, fold() {}, sections: [{ id: 'operations', title: 'Operations', open: true, allEmpty: false, flags: 0, hiddenSaid: null, rows: [
      field('operations.radius', radius, { edit: (v) => edits.push(['radius', v]) }), field('operations.radiusMiles', miles, { edit: (v) => edits.push(['miles', v]) })] }] };
  });
  say('100', '100');
  const radius = $(container, '#f-operations_radius');
  const miles = $(container, '#f-operations_radiusMiles');
  radius.focus();
  fireEvent.input(radius, { target: { value: 'Unlimited' } });
  expect(edits).toEqual([]);
  fireEvent.change(radius);
  expect(edits).toEqual([['radius', 'Unlimited']]);
  // The miles follow (agentEdit says the drawer again): the same boxes, focus where it was.
  say('Unlimited', '');
  expect([$(container, '#f-operations_radius'), $(container, '#f-operations_radiusMiles')]).toEqual([radius, miles]);
  expect([radius.value, miles.value, document.activeElement]).toEqual(['Unlimited', '', radius]);
  // Said again with nothing changed (the panel draws often): what the agent is typing stays.
  fireEvent.input(radius, { target: { value: 'Unlimi' } });
  say('Unlimited', '');
  expect(radius.value).toBe('Unlimi');
});

// Review of PR #376 (CodeRabbit): "No" typed into a USDOT box that was empty is saved empty
// (noNumberEdit), the same value as before, so the box went on showing "No". The edit says the
// field again (`rev`): its box shows the record's value, and what the agent is typing elsewhere stays.
test('a field said again after its edit shows the record\'s value, though the value is the same as before', () => {
  const { container } = render(<Details act={{}} />);
  const say = (rev) => act(() => {
    state.details = { showEmpty: false, toggle: null, fold() {}, sections: [{ id: 'applicant', title: 'Business', open: true, allEmpty: false, flags: 0, hiddenSaid: null, rows: [
      field('applicant.dot', '', { rev }), field('operations.radius', '100')] }] };
  });
  say(0);
  const dot = $(container, '#f-applicant_dot');
  const radius = $(container, '#f-operations_radius');
  fireEvent.input(dot, { target: { value: 'No' } });
  fireEvent.change(dot);
  fireEvent.input(radius, { target: { value: 'Unlim' } });
  say(0);
  expect([dot.value, radius.value], 'said again unchanged: nothing moves').toEqual(['No', 'Unlim']);
  say(1);
  expect([$(container, '#f-applicant_dot'), dot.value, radius.value]).toEqual([dot, '', 'Unlim']);
});

test('a dropdown shows the record\'s value, one off the list kept; a long answer is a text area', () => {
  const edits = [];
  const { container } = render(<Details act={{}} />);
  const say = (value) => act(() => {
    state.details = { showEmpty: false, toggle: null, fold() {}, sections: [{ id: 'operations', title: 'Operations', open: true, allEmpty: false, flags: 0, hiddenSaid: null, rows: [
      field('operations.businessClass', value ?? '', { control: 'select', options: [['', '—'], ...(value && value !== 'Expediter' ? [[value, value]] : []), ['Expediter', 'Expediter'], ['Freight Hauler', 'Freight Hauler']], edit: (v) => edits.push(v) }),
      field('notes.text', 'Hauls produce.', { control: 'textarea' })] }] };
  });
  say('Courier');
  const select = $(container, '#f-operations_businessClass');
  expect([...select.options].map((o) => [o.value, o.selected])).toEqual([['', false], ['Courier', true], ['Expediter', false], ['Freight Hauler', false]]);
  fireEvent.change(select, { target: { value: 'Freight Hauler' } });
  expect(edits).toEqual(['Freight Hauler']);
  say('Freight Hauler');
  expect([$(container, '#f-operations_businessClass'), select.value]).toEqual([select, 'Freight Hauler']);
  say(null);
  expect(select.value).toBe('');
  const notes = $(container, '#f-notes_text');
  expect([notes.tagName, notes.rows, notes.value]).toEqual(['TEXTAREA', 4, 'Hauls produce.']);
});

// Audit 2026-11-07, UX-07: an edited row is marked like the report's Your edit, says what the
// intake had and offers Restore; the box at the top finds fields, and Your corrections lists the
// agent's (what each does to the record: the safety tests, renderSections and restoreField).
test('a corrected field shows Your edit, the intake\'s value and Restore; the find box and Your corrections ask the panel', () => {
  const calls = [];
  const { container } = render(<Details act={{}} />);
  act(() => {
    state.details = { showEmpty: false, toggle: null, fold() {}, query: '', editedOnly: false, edited: 'Your corrections (1)', nothing: null,
      search: (text) => calls.push(['search', text]), editedToggle: () => calls.push(['edited']),
      sections: [{ id: 'operations', title: 'Operations', open: true, allEmpty: false, flags: 0, hiddenSaid: null, rows: [
        field('operations.radius', 'Unlimited', { label: 'Radius (as written)', edited: true, original: '100', restore: () => calls.push(['restore']) }),
        field('operations.radiusMiles', '')] }] };
  });
  const [radius, miles] = container.querySelectorAll('.field');
  expect([radius.className, radius.querySelector('label .tag.you')?.textContent, radius.querySelector('.field-was span').textContent]).toEqual(['field edited', 'Your edit', 'On the intake: 100']);
  expect([miles.className, miles.querySelector('.tag'), miles.querySelector('.field-was')]).toEqual(['field', null, null]);
  const restore = radius.querySelector('.field-was button');
  expect(restore.getAttribute('aria-label')).toBe('Restore Radius (as written) to the intake\'s value');
  fireEvent.click(restore);
  const find = $(container, '#details-find');
  fireEvent.change(find, { target: { value: 'rad' } });
  const edited = $(container, '#details-edited');
  expect([edited.hidden, edited.textContent, edited.getAttribute('aria-pressed')]).toEqual([false, 'Your corrections (1)', 'false']);
  fireEvent.click(edited);
  expect(calls).toEqual([['restore'], ['search', 'rad'], ['edited']]);
  act(() => { state.details = { ...state.details, query: 'zzz', sections: [], nothing: 'No field matches.' }; });
  expect([find.value, $(container, '#sections .feed-empty').textContent]).toEqual(['zzz', 'No field matches.']);
  act(() => { state.details = { ...state.details, edited: null }; });
  expect(edited.hidden, 'nothing corrected: no switch').toBe(true);
});

test('mountDetails draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountDetails(host, {});
    expect(['details-scrim', 'details-title', 'details-empty', 'details-close', 'sections'].map((id) => !!host.querySelector(`#${id}`))).toEqual([true, true, true, true, true]);
  });
  host.remove();
});
