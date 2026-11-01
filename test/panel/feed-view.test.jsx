import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Feed, mountFeed } from '../../sidepanel/panel/feed-view.jsx';

// The page's list around its answers in React (React PR 6, 2026-11-01): what renderSteps wrote on
// the page's own elements, drawn from what it says now (state.feed: the safety test 'the page's list
// says what it shows…' checks what it says). Here, that the page shows it with the ids and wording
// the e2e reads (#page-menu options, #key-btn, #past-back, #report, #past), that the lists' own
// places are left to the panel, and what each control asks the panel to do.

let state;
beforeEach(() => { state = storeState({ feed: null }); });
afterEach(cleanup);

const acts = () => {
  const calls = [];
  const call = (name) => (...args) => { calls.push([name, ...args]); };
  return { calls, act: { setFilter: call('setFilter'), showPast: call('showPast'), toggleKey: call('toggleKey'), clearMarks: call('clearMarks') } };
};
const feed = (more = {}) => ({ shown: true, title: 'Answers on this page', pages: [], pastKey: null, pastWhen: '', report: true, filter: 'all',
  counts: { all: 4, needs: 1, done: 3 }, empty: null, keyOpen: false, unmark: true, age: null, ...more });
const $ = (container, id) => container.querySelector(`#${id}`);
const filters = (container) => [...container.querySelectorAll('#filters button')].map((b) => [b.dataset.filter, b.textContent, b.getAttribute('aria-pressed')]);

test('this page\'s answers: the title, the filters with their counts, the key, Clear the marks; the lists left to the panel', () => {
  const t = acts();
  const { container } = render(<Feed act={t.act} />);
  act(() => { state.feed = feed(); });
  expect([$(container, 'feed').hidden, $(container, 'feed-title').textContent, $(container, 'page-menu').hidden]).toEqual([false, 'Answers on this page', true]);
  expect(filters(container)).toEqual([['all', 'All 4', 'true'], ['needs', 'Need you 1', 'false'], ['done', 'Filled 3', 'false']]);
  expect([$(container, 'report').hidden, $(container, 'report').dataset.filter, $(container, 'past').hidden, $(container, 'past-head').hidden]).toEqual([false, 'all', true, true]);
  expect([$(container, 'key-btn').hidden, $(container, 'key-btn').getAttribute('aria-expanded'), $(container, 'answer-key').hidden]).toEqual([false, 'false', true]);
  expect([$(container, 'unmark').hidden, $(container, 'feed-empty').hidden, $(container, 'report-age').hidden]).toEqual([false, true, true]);
  // The panel's own nodes in the lists stay as the list is drawn again.
  const row = $(container, 'report').appendChild(document.createElement('div'));
  const live = $(container, 'live-root').appendChild(document.createElement('div'));
  act(() => { state.feed = feed({ filter: 'needs', counts: { all: 4, needs: 0, done: 4 }, empty: 'Nothing needs you on this page.', keyOpen: true, age: 'From the fill at 3:05 PM. Fill again if the page changed.' }); });
  expect([row.isConnected, live.isConnected, $(container, 'report').dataset.filter]).toEqual([true, true, 'needs']);
  expect(filters(container)[1]).toEqual(['needs', 'Need you 0', 'true']);
  expect([$(container, 'feed-empty').textContent, $(container, 'feed-empty').hidden, $(container, 'answer-key').hidden, $(container, 'key-btn').getAttribute('aria-expanded')])
    .toEqual(['Nothing needs you on this page.', false, false, 'true']);
  expect([$(container, 'report-age').textContent, $(container, 'report-age').hidden]).toEqual(['From the fill at 3:05 PM. Fill again if the page changed.', false]);
  expect($(container, 'answer-key').textContent).toContain('Marks on the rater page:');
  fireEvent.click(container.querySelector('#filters [data-filter="done"]'));
  fireEvent.click($(container, 'key-btn'));
  fireEvent.click($(container, 'unmark'));
  expect(t.calls).toEqual([['setFilter', 'done'], ['toggleKey'], ['clearMarks']]);
});

// From the e2e: an earlier step's answers from the page menu, read-only, and back to this step's.
test('an earlier page from the menu is shown in place of this one, said when, with the way back to the menu', () => {
  const t = acts();
  const { container } = render(<Feed act={t.act} />);
  const pages = [{ key: '7|/application||Insured Info', title: 'Insured Info' }, { key: '7|/application||Drivers', title: 'Drivers' }];
  act(() => { state.feed = feed({ title: 'Answers', pages }); });
  const menu = $(container, 'page-menu');
  expect([menu.hidden, [...menu.options].map((o) => [o.value, o.textContent]), menu.value]).toEqual([false,
    [['', 'This page'], ['7|/application||Insured Info', 'Insured Info'], ['7|/application||Drivers', 'Drivers']], '']);
  fireEvent.change(menu, { target: { value: '7|/application||Insured Info' } });
  expect(t.calls.at(-1)).toEqual(['showPast', '7|/application||Insured Info']);
  act(() => { state.feed = feed({ title: 'Answers', pages, pastKey: pages[0].key, pastWhen: 'Insured Info · filled 2:50 PM · view only', report: false, counts: null, unmark: false }); });
  expect([menu.value, $(container, 'past').hidden, $(container, 'past-head').hidden, $(container, 'past-when').textContent, $(container, 'report').hidden]).toEqual([
    '7|/application||Insured Info', false, false, 'Insured Info · filled 2:50 PM · view only', true]);
  expect([$(container, 'filters').hidden, $(container, 'unmark').hidden]).toEqual([true, true]);
  // The menu follows the panel, not only the agent's pick.
  act(() => { state.feed = { ...state.feed, pastKey: pages[1].key }; });
  expect(menu.value).toBe('7|/application||Drivers');
  fireEvent.click($(container, 'past-back'));
  expect([t.calls.at(-1), document.activeElement]).toEqual([['showPast', null], menu]);
  // "This page" picked: back too.
  fireEvent.change(menu, { target: { value: '' } });
  expect(t.calls.at(-1)).toEqual(['showPast', null]);
});

test('while a fill goes in, and before a fill: no menu, filters or key; the empty list says so', () => {
  const { container } = render(<Feed act={acts().act} />);
  // Before the panel says anything: the list as the page had it.
  expect([$(container, 'feed-title').textContent, $(container, 'filters').hidden, $(container, 'key-btn').hidden, $(container, 'feed-empty').hidden, $(container, 'unmark').hidden])
    .toEqual(['Answers on this page', true, true, true, true]);
  act(() => { state.feed = feed({ title: 'Filling now', report: false, counts: null, keyOpen: null, unmark: false }); });
  expect([$(container, 'feed-title').textContent, $(container, 'filters').hidden, $(container, 'key-btn').hidden, $(container, 'report').hidden, $(container, 'feed-empty').hidden])
    .toEqual(['Filling now', true, true, true, true]);
  act(() => { state.feed = feed({ shown: false, report: false, counts: null, keyOpen: null, unmark: false, empty: 'This page isn’t filled yet.' }); });
  expect([$(container, 'feed').hidden, $(container, 'feed-empty').textContent]).toEqual([true, 'This page isn’t filled yet.']);
});

// sidepanel.js mounts the live list into #live-root and the panel fills #report right after.
test('mountFeed draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountFeed(host, acts().act);
    expect(['live-root', 'report', 'past'].map((id) => !!host.querySelector(`#${id}`))).toEqual([true, true, true]);
  });
  host.remove();
});
