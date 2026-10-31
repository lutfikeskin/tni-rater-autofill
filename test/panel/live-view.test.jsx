import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { LiveView, entryKeys } from '../../sidepanel/panel/live-view.jsx';

// The live fill view in React (React PR 3, 2026-10-31): what renderLive drew and the safety tests
// checked by its source, checked here by what the list shows.

let state;
let scrolled;
beforeEach(() => {
  state = storeState({ filling: false, tab: { id: 3 }, fillingFor: null });
  scrolled = [];
  // jsdom lays nothing out: which row the list scrolled into view.
  Element.prototype.scrollIntoView = function scrollIntoView(o) { scrolled.push([this.textContent, o]); };
});
afterEach(cleanup);

const row = (key, label, shown, more = {}) => ({ key, label, shown, frame: 'f', ...more });
// The page view at its end, or `up` pixels above it.
const viewAt = (up = 0) => ({ scrollHeight: 1000, scrollTop: 1000 - 200 - up, clientHeight: 200 });
const said = (container) => [...container.querySelectorAll('.row')].map((r) => [
  r.className, r.querySelector('.row-label').textContent, r.querySelector('.row-value').textContent, r.querySelector('.tag')?.textContent ?? null]);

// From the safety test 'while a fill runs the panel streams the items judged with the answers, in the
// page order': the answers as answers, the items as what is left for the agent, in the page's order.
test('the answers and the items judged are drawn in the page order, with the row for the one coming', () => {
  const { container } = render(<LiveView view={viewAt()} />);
  act(() => {
    Object.assign(state, { filling: true, fillingFor: { run: 'r1', tabId: 3, frames: ['f', 'g'],
      rows: [row('kind', 'Kind', 'Owner', { order: 0 }), row('size', 'Size', 'Large', { order: 3 })],
      items: [{ kind: 'unknown', key: 'deed', label: 'Deed year', order: 1, frame: 'f' }, { kind: 'failed', key: 'zip', label: 'Zip', order: 2, frame: 'f' },
        { kind: 'noData', key: 'x', label: 'Other frame', order: 0, frame: 'g' }] } });
  });
  expect(container.querySelector('#live.rows.live')).toBeTruthy();
  expect(said(container)).toEqual([
    ['row', 'Kind', 'Owner', null], ['row need', 'Deed year', 'Needs your answer', null], ['row need failed', 'Zip', 'Couldn’t fill', null],
    ['row fresh', 'Size', 'Large', null], ['row need', 'Other frame', 'Needs your answer', null], ['row typing', 'Next answer', 'Working…', null]]);
  expect([...container.querySelectorAll('.row-icon')].map((x) => x.textContent)).toEqual(['✓', '?', '!', '✓', '?', '']);
  expect(container.querySelector('.row.typing .spinner')).toBeTruthy();
});

// The maintainer (2026-10-10): a TNI standard is TNI's answer, not a fact from the intake, and is
// tagged so; an answer with nothing shown says it was filled.
test('a TNI standard answer carries its tag; an answer with no label or value says so', () => {
  const { container } = render(<LiveView view={viewAt()} />);
  act(() => {
    Object.assign(state, { filling: true, fillingFor: { run: 'r1', tabId: 3, rows: [row('g', 'Gender', 'Male', { standard: true }), row('x', '', '')] } });
  });
  expect(said(container).slice(0, 2)).toEqual([['row', 'Gender', 'Male', 'TNI standard'], ['row fresh', 'Answer', 'filled', null]]);
  expect(container.querySelector('.tag.standard').title).toBe('A TNI standard answer, not a fact from the intake');
});

// From the safety test 'an automatic fill lists its answers as they go in, from the first one'
// (W43-42): shown once a row is in, never for a follow-up that has answered nothing yet; only for the
// tab in front, and only while a fill runs.
test('the list shows for the fill on the tab in front, an automatic one once a row is in', () => {
  const { container } = render(<LiveView view={viewAt()} />);
  const shown = () => !!container.querySelector('#live');
  act(() => { Object.assign(state, { filling: true, fillingFor: { run: 'r1', auto: true, tabId: 3, rows: [] } }); });
  expect(shown()).toBe(false);
  act(() => { state.fillingFor = { ...state.fillingFor, rows: [row('a', 'A', '1')] }; });
  expect(shown()).toBe(true);
  act(() => { state.tab = { id: 4 }; });
  expect(shown()).toBe(false);
  act(() => { state.tab = { id: 3 }; });
  expect(shown()).toBe(true);
  act(() => { state.filling = false; });
  expect(shown()).toBe(false);
  act(() => { Object.assign(state, { filling: true, fillingFor: { run: 'r2', tabId: 3, rows: [] } }); });
  expect(said(container)).toEqual([['row typing', 'Reading the page', 'Working…', null]]);
});

// From the safety tests 'a fill whose page stops answering is said in the dock…' and 'the live list
// and the dock say what the kit waits on (its phase)…': the last row says what the kit waits on, that
// the page isn't answering, and goes once Stop is pressed.
test('the last row says what the kit waits on, that the page isn’t answering, and goes on Stop', () => {
  const { container } = render(<LiveView view={viewAt()} />);
  const last = () => said(container).at(-1).slice(0, 3);
  act(() => { Object.assign(state, { filling: true, fillingFor: { run: 'r1', tabId: 3, rows: [row('a', 'A', '1')], phase: { name: 'helper', what: 'Recalculate' } } }); });
  expect(last()).toEqual(['row typing', 'Clicked: Recalculate', 'Waiting for the page to answer…']);
  act(() => { state.fillingFor = { ...state.fillingFor, phase: { name: 'premium' } }; });
  expect(last()).toEqual(['row typing', 'Waiting for the premium', 'The rater is rating the quote…']);
  act(() => { state.fillingFor = { ...state.fillingFor, unanswered: true }; });
  expect(last()).toEqual(['row typing', 'Waiting for the page', 'It isn’t answering']);
  act(() => { state.fillingFor = { ...state.fillingFor, unanswered: false, stopping: true }; });
  expect(container.querySelector('.row.typing')).toBe(null);
});

// The answer that just went in is marked fresh; each new answer draws its own row, and the rows
// already in are not drawn again (one row per answer, keyed by its field).
test('only the newest answer is fresh, and a new answer draws only its row and the one fresh before', () => {
  const { container } = render(<LiveView view={viewAt()} />);
  const a = row('a', 'A', '1');
  const b = row('b', 'B', '2');
  act(() => { Object.assign(state, { filling: true, fillingFor: { run: 'r1', tabId: 3, rows: [a] } }); });
  const first = container.querySelector('.row');
  const watch = new MutationObserver(() => {});
  watch.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
  act(() => { state.fillingFor = { ...state.fillingFor, rows: [a, b] }; });
  // The first row lost its mark and the second was added; nothing else was touched.
  const touched = watch.takeRecords().map((m) => (m.type === 'attributes' ? `${m.attributeName} of ${m.target.textContent}` : `added ${[...m.addedNodes].map((n) => n.textContent)}`));
  expect(touched).toEqual(['class of ✓A1', 'added ✓B2']);
  expect(container.querySelector('.row')).toBe(first);
  expect(said(container).map((r) => r[0])).toEqual(['row', 'row fresh', 'row typing']);
  // A phase alone marks no answer fresh.
  act(() => { state.fillingFor = { ...state.fillingFor, phase: { name: 'waiting' } }; });
  expect(said(container).map((r) => r[0])).toEqual(['row', 'row', 'row typing']);
  watch.disconnect();
});

// From the safety test 'the live list and the dock say what the kit waits on…': the list follows its
// last row while the agent is at its end (or it is new); scrolled up 80px or more, it stays put.
test('the list follows the answers only while the agent is at its end', () => {
  const a = row('a', 'A', '1');
  const b = row('b', 'B', '2');
  const c = row('c', 'C', '3');
  const view = viewAt(500);
  render(<LiveView view={view} />);
  act(() => { Object.assign(state, { filling: true, fillingFor: { run: 'r1', tabId: 3, rows: [a] } }); });
  expect(scrolled).toEqual([['Next answerWorking…', { block: 'nearest' }]]);
  act(() => { state.fillingFor = { ...state.fillingFor, rows: [a, b] }; });
  expect(scrolled.length).toBe(1);
  Object.assign(view, viewAt(79));
  act(() => { state.fillingFor = { ...state.fillingFor, rows: [a, b, c] }; });
  expect(scrolled.length).toBe(2);
  Object.assign(view, viewAt(80));
  act(() => { state.fillingFor = { ...state.fillingFor, stopping: true }; });
  expect(scrolled.length).toBe(2);
  Object.assign(view, viewAt(0));
  act(() => { state.fillingFor = { ...state.fillingFor, phase: { name: 'premium' } }; });
  expect(scrolled.at(-1)).toEqual(['✓C3', { block: 'nearest' }]);
});

test('each row is keyed by its field in its frame, answers and items apart, a field listed again counted', () => {
  expect(entryKeys([{ row: { key: 'k', frame: 'f' } }, { item: { key: 'k', frame: 'f' } }, { row: { key: 'k', frame: 'g' } },
    { row: { key: 'k', frame: 'f' } }, { row: { key: null, label: 'Zip', frame: 'f' } }])).toEqual(['a|f|k', 'i|f|k', 'a|g|k', 'a|f|k#1', 'a|f|Zip']);
});
