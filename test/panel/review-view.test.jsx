// @ts-check
import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, queryAllByRole } from '@testing-library/react';
import { state } from '../../sidepanel/panel/core.js';
import { toggleRow } from '../../sidepanel/panel/fill.js';
import { answerRecord, defaultFilter, listCounts, needRecord, settleRow } from '../../sidepanel/panel/report-rows.js';
import { SOURCE } from '../../sidepanel/panel/messages.js';
import { mountReview, Review } from '../../sidepanel/panel/review-view.jsx';
import { mountFeed } from '../../sidepanel/panel/feed-view.jsx';
import { mountRows } from '../../sidepanel/panel/report-view.jsx';

const ROLES = ['button', 'link', 'checkbox', 'switch', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'tab', 'menuitem'];

/**
 * @param {HTMLElement} root
 */
function nameless(root) {
  for (const el of root.querySelectorAll('[title]')) el.removeAttribute('title');
  return ROLES.flatMap((role) => queryAllByRole(root, role, { name: '' }).map((el) => `${role} ${el.outerHTML.slice(0, 120)}`));
}

/**
 * @param {string} kind
 * @param {string} label
 * @param {string} value
 * @param {Record<string, any>} [extra]
 */
function mkAnswer(kind, label, value, extra = {}) {
  const tagMap = {
    intake: SOURCE.tag.intake(' (p. 1)'),
    derived: SOURCE.tag.derived,
    standard: SOURCE.tag.standard,
    own: SOURCE.tag.own,
    edited: SOURCE.tag.edited,
    page: SOURCE.tag.page,
    clicked: SOURCE.tag.clicked,
    yours: SOURCE.tag.yours,
    changed: SOURCE.tag.changed,
  };
  const rec = answerRecord({ field: `f-${label}`, kind, label, value, answer: value, source: { tag: tagMap[kind] ?? null, title: kind, quote: value }, ...extra });
  if (extra.pending) rec.pending = true;
  if (extra.changed) rec.changed = extra.changed;
  return rec;
}

/**
 * @param {string} label
 * @param {Record<string, any>} [extra]
 */
function mkNeed(label, extra = {}) {
  return needRecord({ key: `k-${label}`, label, why: 'Not on the intake', options: ['Yes', 'No'], ...extra });
}

beforeEach(() => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  document.getElementById('quote')?.removeAttribute('hidden');
  document.getElementById('page-view')?.removeAttribute('hidden');
  Object.assign(state, {
    intake: { record: { applicant: { name: 'Acme LLC' } }, warnings: [], done: [] },
    view: 'page',
    settingsOpen: false,
    detailsOpen: false,
    pdf: null,
    summary: null,
    filling: false,
    pastKey: null,
    reportFor: null,
    reports: new Map(),
    rowsDrawn: 0,
    rowsAll: 0,
    dock: {
      phase: 'needs',
      eyebrow: '6 filled · 2 need you',
      title: 'Answer 2 questions',
      sub: 'Never Binds or Submits.',
      go: 'next',
      label: 'Show the next one',
      report: true,
    },
    feed: {
      shown: true,
      title: 'Household Members',
      filledCount: 6,
      pages: [],
      pastKey: null,
      pastWhen: '',
      report: true,
      filter: 'needs',
      counts: { all: 8, needs: 2, worth: 3, done: 6 },
      empty: null,
      keyOpen: false,
      unmark: true,
      age: null,
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

test('Review is retired (renders nothing) so post-fill answers live in one unified tabbed sheet', () => {
  const host = /** @type {HTMLElement} */ (document.getElementById('review-root'));
  mountReview(host);
  expect(host.childElementCount).toBe(0);
  expect(document.getElementById('review')).toBeNull();
  expect(document.getElementById('see-all-answers')).toBeNull();
  void Review;
});

test('listCounts and defaultFilter route a filled page to Needs, Worth a look, or All automatically', () => {
  const need = mkNeed('Employment');
  const aiPending = mkAnswer('intake', 'Business entity', 'LLC', { pending: true });
  const standard = mkAnswer('standard', 'Driver License Type', 'Personal Auto');
  const edited = mkAnswer('edited', 'Garaging ZIP', '75001');
  const marked = mkNeed('Upload loss runs');
  settleRow(marked, 'marked');
  const intake = mkAnswer('intake', 'First Name', 'Jane');
  const goneNeed = mkNeed('Hidden field');
  goneNeed.gone = true;

  // Needs present -> defaults to 'needs' (pending AI counts as a need; gone rows skipped).
  const full = [need, aiPending, standard, edited, marked, intake, goneNeed];
  expect(listCounts(full)).toEqual({ all: 6, needs: 2, worth: 3, done: 4 });
  expect(defaultFilter(full)).toBe('needs');

  // Zero needs, worth-a-look rows present -> defaults to 'worth'.
  const worthOnly = [standard, edited, marked, intake];
  expect(listCounts(worthOnly)).toEqual({ all: 4, needs: 0, worth: 3, done: 4 });
  expect(defaultFilter(worthOnly)).toBe('worth');

  // Only plain intake answers -> defaults to 'all'.
  expect(listCounts([intake])).toEqual({ all: 1, needs: 0, worth: 0, done: 1 });
  expect(defaultFilter([intake])).toBe('all');
});

test('unified sheet + Option B rows: data-worth/data-tone markers, inline expansion without screen jumps, report age, and accessible controls', () => {
  const need = mkNeed('Employment');
  const aiPending = mkNeed('Business entity');
  aiPending.pending = true;
  aiPending.aiCard = { kind: 'picked', choice: 'LLC', tip: null, notes: [], approve: () => {}, reject: () => {} };
  const standard = mkAnswer('standard', 'Medical payments', '$5,000', {
    key: 'medpay',
    answer: true,
    source: { title: 'TNI standard answer', quote: 'Standard $5,000', place: { page: 1 }, seeTitle: 'Show in intake', tag: SOURCE.tag.standard },
  });
  const edited = mkAnswer('edited', 'Garaging ZIP', '75001', {
    key: 'zip',
    answer: true,
    source: { title: 'Your correction in the panel', quote: '75001', place: null, tag: SOURCE.tag.edited },
  });
  const yours = mkAnswer('yours', 'Occupation', 'Construction', {
    key: 'occ',
    answer: true,
    source: { title: 'Your answer', quote: 'Construction', place: null, tag: SOURCE.tag.yours },
  });
  const intake = mkAnswer('intake', 'DOT number', '1234567', {
    key: 'dot',
    answer: true,
    source: { title: 'From the intake', quote: 'DOT 1234567', place: { page: 1 }, seeTitle: 'Show in intake', tag: null, quiet: 'From the intake' },
  });
  const marked = mkNeed('Upload loss runs');
  settleRow(marked, 'marked', vi.fn());

  const entry = {
    key: '1|/Vehicles||Vehicles',
    step: 'Vehicles',
    filled: 5,
    list: [need, aiPending, standard, edited, yours, intake, marked],
    drawn: 0,
  };
  state.reportFor = entry;
  state.reports.set(entry.key, entry);
  state.feed = {
    ...state.feed,
    title: 'Vehicles',
    filledCount: 4,
    filter: 'needs',
    counts: listCounts(entry.list),
    age: 'From the fill at 2:15 PM. Fill again if the page changed.',
  };

  const rowActs = {
    toggleRow: (rec) => toggleRow(rec),
    markRow: vi.fn(),
    showRow: vi.fn(),
    pickRow: vi.fn(),
    changeRow: vi.fn(),
    seeRow: vi.fn(),
    node: () => {},
  };

  mountFeed(/** @type {HTMLElement} */ (document.getElementById('feed-root')), {
    setFilter: (f) => { state.feed = { ...state.feed, filter: f }; },
    showPast: () => {},
    toggleKey: () => {},
    clearMarks: () => {},
  });
  const rowsHost = document.createElement('div');
  rowsHost.className = 'rows';
  document.getElementById('report')?.appendChild(rowsHost);
  const unmountRows = mountRows(rowsHost, entry, { tabId: 1, page: '/Vehicles', carrier: null }, rowActs);

  // Kept report age shows inside the unified sheet.
  expect(document.getElementById('report-age')?.textContent).toBe('From the fill at 2:15 PM. Fill again if the page changed.');
  // Exactly one h1 in the document; page title is h2.
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  expect(document.getElementById('feed-title')?.tagName).toBe('H2');

  // Verify Option B data-worth & data-tone markers across every row type.
  const rowOf = (label) => /** @type {HTMLElement} */ ([...document.querySelectorAll('#report .rows > .row')]
    .find((el) => el.querySelector('.row-label')?.textContent === label));

  expect(rowOf('Employment').getAttribute('data-tone')).toBe('need');
  expect(rowOf('Employment').hasAttribute('data-worth')).toBe(false);
  expect(rowOf('Business entity').getAttribute('data-tone')).toBe('ai');
  expect(rowOf('Medical payments').getAttribute('data-worth')).toBe('1');
  expect(rowOf('Garaging ZIP').getAttribute('data-worth')).toBe('1');
  expect(rowOf('Garaging ZIP').getAttribute('data-tone')).toBe('you');
  expect(rowOf('Occupation').getAttribute('data-tone')).toBe('you');
  expect(rowOf('DOT number').hasAttribute('data-worth')).toBe(false);
  expect(rowOf('Upload loss runs').getAttribute('data-worth')).toBe('1');
  expect(rowOf('Upload loss runs').getAttribute('data-tone')).toBe('you');

  // Switching to Worth a look and expanding a row expands its Option B inset tray inline without switching screens.
  act(() => fireEvent.click(/** @type {HTMLElement} */ (document.querySelector('#filters [data-filter="worth"]'))));
  expect(document.getElementById('report')?.dataset.filter).toBe('worth');
  const medHead = /** @type {HTMLButtonElement} */ (rowOf('Medical payments').querySelector('.row-head'));
  expect(medHead.getAttribute('aria-expanded')).toBe('false');
  act(() => fireEvent.click(medHead));
  expect(medHead.getAttribute('aria-expanded')).toBe('true');
  expect(rowOf('Medical payments').querySelector('.row-tray')).not.toBeNull();
  expect(document.getElementById('report')?.hasAttribute('data-focus')).toBe(false);
  act(() => fireEvent.click(/** @type {HTMLElement} */ (rowOf('Medical payments').querySelector('.tray-link.src'))));
  expect(rowActs.seeRow).toHaveBeenCalledWith(standard);
  act(() => fireEvent.click(/** @type {HTMLElement} */ (rowOf('Medical payments').querySelector('.tray-link.change'))));
  expect(rowActs.changeRow).toHaveBeenCalled();

  // DOM focus order matches visual top-to-bottom order: #filters -> #report rows -> .feed-tools (#unmark).
  const isBefore = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  const filterBtn = document.querySelector('#filters button');
  const unmarkBtn = document.getElementById('unmark');
  expect(isBefore(filterBtn, medHead)).toBe(true);
  expect(isBefore(medHead, unmarkBtn)).toBe(true);

  expect(nameless(document.body)).toEqual([]);
  unmountRows();
});
