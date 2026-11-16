// @ts-check
import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, queryAllByRole } from '@testing-library/react';
import { state } from '../../sidepanel/panel/core.js';
import { render as renderRecord, setAllAnswers } from '../../sidepanel/panel/record.js';
import { toggleRow } from '../../sidepanel/panel/fill.js';
import { answerRecord, needRecord, settleRow } from '../../sidepanel/panel/report-rows.js';
import { SOURCE } from '../../sidepanel/panel/messages.js';
import { mountReview, Review } from '../../sidepanel/panel/review-view.jsx';
import { mountFeed } from '../../sidepanel/panel/feed-view.jsx';
import { mountRows } from '../../sidepanel/panel/report-view.jsx';
import { mountScreen } from '../../sidepanel/panel/screen-view.jsx';

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
    allAnswers: false,
    allAnswersFor: null,
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
      title: 'Answers on this page',
      pages: [],
      pastKey: null,
      pastWhen: '',
      report: true,
      filter: 'all',
      counts: { all: 8, needs: 2, done: 6 },
      empty: null,
      keyOpen: false,
      unmark: false,
      age: null,
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

test('Review groups Needs you uncapped, pending AI picks, Q1 Worth a look, Marked done, and See all N answers', () => {
  const needs = Array.from({ length: 6 }, (_, i) => mkNeed(`Missing question ${i + 1}`));
  const aiPending = mkAnswer('intake', 'Business entity', 'LLC', { pending: true });
  const edited = mkAnswer('edited', 'Garaging ZIP', '75001');
  const own = mkAnswer('own', 'Collision deductible', '$2,500');
  const marked = mkNeed('Upload loss runs');
  settleRow(marked, 'marked');
  const standard = mkAnswer('standard', 'Medical payments', '$5,000');
  const derived = mkAnswer('derived', 'Years in business', '5');
  const intake1 = mkAnswer('intake', 'DOT number', '1234567');
  const intake2 = mkAnswer('intake', 'Legal name', 'Acme LLC');

  const list = [...needs, aiPending, edited, own, marked, standard, derived, intake1, intake2];
  state.reportFor = {
    key: '1|/BusinessInfo||Business Info',
    step: 'Business Info',
    filled: 8,
    list,
    drawn: 0,
  };

  mountScreen(/** @type {HTMLElement} */ (document.getElementById('screen-root')), { scrollBehavior: () => 'auto' });
  mountReview(/** @type {HTMLElement} */ (document.getElementById('review-root')), {
    showAll: () => setAllAnswers(true),
    showReview: () => setAllAnswers(false),
  });
  mountFeed(/** @type {HTMLElement} */ (document.getElementById('feed-root')), {
    setFilter: () => {},
    showPast: () => {},
    toggleKey: () => {},
    clearMarks: () => {},
  });

  // Exactly one h1 in the entire document (sr-only app title); Review uses h2 and h3.
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  expect(document.getElementById('screen-head')?.hidden).toBe(true);
  expect(document.getElementById('review-title')?.tagName).toBe('H2');
  expect(document.getElementById('review-title')?.textContent).toBe('Business Info is filled');
  expect(document.getElementById('review-lead')?.textContent).toBe('8 answers are in. 7 need you before you continue.');

  // Needs you renders all 7 items uncapped, including the pending AI pick in purple tone.
  const needRows = [...document.querySelectorAll('#review-needs .review-row')];
  expect(needRows).toHaveLength(7);
  const aiRow = needRows[6];
  expect(aiRow.getAttribute('data-tone')).toBe('ai');
  expect(aiRow.textContent).toContain('Business entity');
  expect(aiRow.textContent).toContain('The AI assistant\u2019s pick, waiting for you');
  expect(aiRow.textContent).toContain('LLC');

  // Worth a look renders edited, own, marked, standard — and leaves derived + intake out.
  const worthRows = [...document.querySelectorAll('#review-worth .review-row')];
  expect(worthRows.map((r) => r.querySelector('.review-row-label')?.textContent)).toEqual([
    'Garaging ZIP',
    'Collision deductible',
    'Upload loss runs',
    'Medical payments',
  ]);
  const markedRow = worthRows[2];
  expect(markedRow.querySelector('.review-row-val')?.textContent).toBe('Marked done');
  expect(markedRow.querySelector('.review-row-sub')?.textContent).toBe('Marked done without an answer');
  expect(markedRow.textContent).not.toContain('Answered');
  expect(markedRow.textContent).not.toContain('You');

  // See all N answers uses list.length (14) and intakeCount (2, not counting derived).
  const seeAll = document.getElementById('see-all-answers');
  expect(seeAll?.textContent).toBe('See all 14 answers (2 straight from the intake)');
  expect(document.getElementById('feed')?.getAttribute('data-grouped')).toBe('true');
  // Flat filter bar: no sliding .filters-thumb element.
  expect(document.querySelector('.filters-thumb')).toBeNull();
  expect(nameless(document.body)).toEqual([]);
});

test('See all answers, Back to summary, opening a Review row via toggleRow, and report/intake resets', () => {
  const need = mkNeed('Radius of operation');
  const standard = mkAnswer('standard', 'Medical payments', '$5,000');
  const intake = mkAnswer('intake', 'DOT number', '1234567');
  const entry = {
    key: '1|/Vehicles|v0|Vehicles',
    page: 'Vehicles',
    filled: 2,
    list: [need, standard, intake],
    drawn: 0,
  };
  state.reportFor = entry;
  state.reports.set(entry.key, entry);

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

  mountReview(/** @type {HTMLElement} */ (document.getElementById('review-root')), {
    openRow: (rec) => {
      setAllAnswers(true);
      toggleRow(rec, true);
      state.dock = { phase: 'needs', eyebrow: '2 filled · 1 needs you', title: 'Answer 1 question', sub: 'Never Binds or Submits.' };
    },
    showAll: () => setAllAnswers(true),
    showReview: () => setAllAnswers(false),
  });

  expect(document.getElementById('review-title')?.textContent).toBe('Vehicles · Vehicle 1 is filled');

  // Clicking a Review row switches to All answers and opens that exact ReportRows record via toggleRow.
  const worthBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#review-worth .review-row'));
  expect(worthBtn.textContent).toContain('Medical payments');
  act(() => fireEvent.click(worthBtn));

  expect(state.allAnswers).toBe(true);
  expect(document.getElementById('feed')?.getAttribute('data-all')).toBe('true');
  expect(document.getElementById('feed')?.hasAttribute('data-grouped')).toBe(false);
  expect(document.getElementById('review-title')?.textContent).toBe('All 3 answers');
  expect(document.getElementById('review-lead')?.textContent).toBe('1 answer on this page needs you.');
  expect(standard.open).toBe(true);
  expect(document.querySelector('#report .rows > .row.open')?.textContent).toContain('Medical payments');
  expect(nameless(document.body)).toEqual([]);

  // Back to summary returns to Review and moves focus to #see-all-answers.
  act(() => fireEvent.click(/** @type {HTMLElement} */ (document.getElementById('back-to-review'))));
  expect(state.allAnswers).toBe(false);
  expect(document.activeElement?.id).toBe('see-all-answers');
  expect(document.getElementById('feed')?.getAttribute('data-grouped')).toBe('true');

  // See all answers switches to All answers and moves focus to #back-to-review.
  act(() => fireEvent.click(/** @type {HTMLElement} */ (document.getElementById('see-all-answers'))));
  expect(state.allAnswers).toBe(true);
  expect(document.activeElement?.id).toBe('back-to-review');

  // Moving to another page's report automatically shows Review (allAnswersFor !== reportFor).
  const nextEntry = { key: '1|/Drivers||Drivers', step: 'Drivers', filled: 1, list: [intake], drawn: 0 };
  act(() => { state.reportFor = nextEntry; });
  expect(document.getElementById('review-title')?.textContent).toBe('Drivers is filled');
  expect(document.getElementById('feed')?.getAttribute('data-grouped')).toBe('true');

  // Loading a new intake in record.js resets state.allAnswers and state.allAnswersFor.
  act(() => { setAllAnswers(true); });
  expect(state.allAnswers).toBe(true);
  act(() => {
    state.intake = {
      fileName: 'new.pdf',
      stats: { filled: 10 },
      record: { applicant: { name: 'New Client LLC' }, drivers: [], vehicles: [], trailers: [] },
      warnings: [],
      cleanup: [],
      done: [],
    };
    renderRecord();
  });
  expect(state.allAnswers).toBe(false);
  expect(state.allAnswersFor).toBeNull();

  unmountRows();
  void Review;
});
