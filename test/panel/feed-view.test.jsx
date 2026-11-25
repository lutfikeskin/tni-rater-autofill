import fs from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Feed, mountFeed } from '../../sidepanel/panel/feed-view.jsx';

// The unified Model 2 single tabbed sheet (feed-view.jsx): one header (page title, earlier-page
// menu, answer key button, help link, summary subtitle) above one white tabbed sheet with three
// segment tabs (Needs | Worth a look | All), inline live search in All, the lists left to the panel
// (#live-root, #report, #past), and the integrated footer (#unmark + total field count).

let state;
beforeEach(() => { state = storeState({ feed: null, reportFor: null }); });
afterEach(cleanup);

const acts = () => {
  const calls = [];
  const call = (name) => (...args) => { calls.push([name, ...args]); };
  return { calls, act: { setFilter: call('setFilter'), showPast: call('showPast'), toggleKey: call('toggleKey'), clearMarks: call('clearMarks') } };
};
const feed = (more = {}) => ({
  shown: true,
  title: 'Household Members',
  filledCount: 3,
  pages: [],
  pastKey: null,
  pastWhen: '',
  report: true,
  filter: 'needs',
  counts: { all: 4, needs: 1, worth: 2, done: 3 },
  empty: null,
  keyOpen: false,
  unmark: true,
  age: null,
  ...more,
});
const $ = (container, id) => container.querySelector(`#${id}`);
const filters = (container) => [...container.querySelectorAll('#filters button')].map((b) => [b.dataset.filter, b.textContent, b.getAttribute('aria-pressed')]);

test('this page\'s unified sheet: title, summary, 3 segment tabs, key, Clear page marks; the lists left to the panel', () => {
  const t = acts();
  const { container } = render(<Feed act={t.act} />);
  act(() => { state.feed = feed(); });
  expect([$(container, 'feed').hidden, $(container, 'feed-title').textContent, $(container, 'page-menu').hidden]).toEqual([false, 'Household Members', true]);
  expect(container.querySelector('.feed-sub').textContent).toBe('3 filled · 1 needs you');
  expect(filters(container)).toEqual([['needs', 'Needs 1', 'true'], ['worth', 'Worth a look 2', 'false'], ['all', 'All 4', 'false']]);
  expect([$(container, 'report').hidden, $(container, 'report').dataset.filter, $(container, 'past').hidden, $(container, 'past-head').hidden]).toEqual([false, 'needs', true, true]);
  expect([$(container, 'key-btn').hidden, $(container, 'key-btn').getAttribute('aria-expanded'), $(container, 'answer-key').hidden]).toEqual([false, 'false', true]);
  expect([$(container, 'unmark').hidden, $(container, 'unmark').textContent, $(container, 'feed-empty').hidden, $(container, 'report-age').hidden]).toEqual([false, 'Clear page marks', true, true]);
  expect(container.querySelector('.feed-total').textContent).toBe('4 fields total');

  // The panel's own nodes in the lists stay as the list is drawn again.
  const row = $(container, 'report').appendChild(document.createElement('div'));
  const live = $(container, 'live-root').appendChild(document.createElement('div'));
  act(() => {
    state.feed = feed({
      filter: 'worth',
      filledCount: 4,
      counts: { all: 4, needs: 0, worth: 0, done: 4 },
      empty: 'Nothing flagged as worth a look on this page.',
      keyOpen: true,
      age: 'From the fill at 3:05 PM. Fill again if the page changed.',
    });
  });
  expect([row.isConnected, live.isConnected, $(container, 'report').dataset.filter]).toEqual([true, true, 'worth']);
  expect(container.querySelector('.feed-sub').textContent).toBe('4 filled · all set');
  expect(filters(container)[1]).toEqual(['worth', 'Worth a look 0', 'true']);
  expect([$(container, 'feed-empty').textContent, $(container, 'feed-empty').hidden, $(container, 'answer-key').hidden, $(container, 'key-btn').getAttribute('aria-expanded')])
    .toEqual(['Nothing flagged as worth a look on this page.', false, false, 'true']);
  expect([$(container, 'report-age').textContent, $(container, 'report-age').hidden]).toEqual(['From the fill at 3:05 PM. Fill again if the page changed.', false]);
  expect($(container, 'answer-key').textContent).toContain('Marks on the rater page:');
  // A mark is named with its tag's word: AI for the assistant's answers, You for the agent's.
  const marks = [...container.querySelectorAll('.legend > span')].filter((s) => s.querySelector('.mark.ai, .mark.agent')).map((s) => s.textContent);
  expect(marks).toEqual(['AI', 'You']);

  fireEvent.click(container.querySelector('#filters [data-filter="all"]'));
  fireEvent.click($(container, 'key-btn'));
  fireEvent.click($(container, 'unmark'));
  expect(t.calls).toEqual([['setFilter', 'all'], ['toggleKey'], ['clearMarks']]);
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

// agent defaults: the key names "Your default" (tag and mark) only where the feature is on: not in
// agents' store build until it is released (src/agent-defaults/index.js RELEASED_TO_AGENTS).
test('the answer key shows Your default only while the feature is on', () => {
  const t = acts();
  const { container } = render(<Feed act={t.act} />);
  act(() => { state.feed = feed({ keyOpen: true }); state.defaultsOn = false; });
  expect($(container, 'answer-key').textContent).not.toContain('Your default');
  act(() => { state.defaultsOn = true; });
  expect([...container.querySelectorAll('#answer-key .tag.own, #answer-key .mark.own')].length).toBe(2);
});

test('inline live search appears on All when a page has > 6 fields, filters rows, and resets on tab switch', () => {
  const { container } = render(<Feed act={acts().act} />);
  const rowsHost = $(container, 'report').appendChild(document.createElement('div'));
  rowsHost.className = 'rows';
  const mkRow = (label, val) => {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<span class="row-label">${label}</span><span class="row-value">${val}</span>`;
    rowsHost.appendChild(r);
    return r;
  };
  const r1 = mkRow('Marital Status', 'Married');
  const r2 = mkRow('Driver License Type', 'Personal Auto');

  // On Needs tab, search bar is omitted.
  act(() => { state.feed = feed({ filter: 'needs', counts: { all: 12, needs: 1, worth: 4, done: 11 } }); });
  expect(container.querySelector('.feed-search')).toBeNull();

  // On All tab with > 6 fields, search bar appears and filters rows live.
  act(() => { state.feed = feed({ filter: 'all', counts: { all: 12, needs: 1, worth: 4, done: 11 } }); });
  const input = /** @type {HTMLInputElement} */ ($(container, 'feed-search-input'));
  expect(container.querySelector('.feed-search')).not.toBeNull();
  expect(input.placeholder).toBe('Filter 12 fields on this page…');

  fireEvent.change(input, { target: { value: 'license' } });
  expect(r1.getAttribute('data-search-hide')).toBe('1');
  expect(r2.hasAttribute('data-search-hide')).toBe(false);
  expect($(container, 'feed-empty').hidden).toBe(true);

  fireEvent.change(input, { target: { value: 'zzz-nothing' } });
  expect(r1.getAttribute('data-search-hide')).toBe('1');
  expect(r2.getAttribute('data-search-hide')).toBe('1');
  expect([$(container, 'feed-empty').hidden, $(container, 'feed-empty').textContent]).toEqual([false, 'No matching fields on this page.']);

  // Switching back to Needs clears the query and unhides all rows; returning to All starts fresh.
  act(() => { state.feed = feed({ filter: 'needs', counts: { all: 12, needs: 1, worth: 4, done: 11 } }); });
  expect(container.querySelector('.feed-search')).toBeNull();
  expect(r1.hasAttribute('data-search-hide')).toBe(false);
  expect(r2.hasAttribute('data-search-hide')).toBe(false);
  act(() => { state.feed = feed({ filter: 'all', counts: { all: 12, needs: 1, worth: 4, done: 11 } }); });
  expect(/** @type {HTMLInputElement} */ ($(container, 'feed-search-input')).value).toBe('');
});

const findNestedHas = (source) => {
  const nested = [];
  const stack = [];
  let inComment = false;
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inComment) {
      if (ch === '*' && source[i + 1] === '/') { inComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') { inComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (source.startsWith(':has(', i)) {
      if (stack.some((entry) => entry.isHas)) {
        nested.push(source.slice(Math.max(0, i - 40), i + 40));
      }
      stack.push({ isHas: true });
      i += 4;
      continue;
    }
    if (ch === '(') {
      stack.push({ isHas: false });
    } else if (ch === ')' && stack.length > 0) {
      stack.pop();
    }
  }
  return nested;
};

test('unified sheet CSS avoids nested :has(), retires data-focus="need" and #review, and keeps #feed-root display:contents', () => {
  const css = fs.readFileSync('sidepanel/sidepanel.css', 'utf8');
  expect(findNestedHas('.a:has(> .b:not(:has(.c))) {}')).toHaveLength(1);
  expect(findNestedHas(css)).toEqual([]);
  expect(css).toContain('#feed-root { display: contents; }');
  expect(css).toContain('.report[data-filter="worth"] .row:not([data-worth="1"]) { display: none; }');
  expect(css).not.toContain('data-focus="need"');
  expect(css).not.toContain('#review-worth');
});
