import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { answerRecord, needRecord, settleRow } from '../../sidepanel/panel/report-rows.js';
import { quoteSummary, summaryFileName, summaryHtml } from '../../sidepanel/panel/quote-summary.js';
import { Summary } from '../../sidepanel/panel/summary-view.jsx';
import { ClientHead } from '../../sidepanel/panel/client-view.jsx';
import { Dock } from '../../sidepanel/panel/steps-view.jsx';

// The quote summary (audit 2026-11-07, UX-05): every answer of the quote per carrier tab and page,
// with its source, then the agent's overrides, the AI's decisions and what was marked done without
// an answer; read only, with Save summary. Here: what it says from the reports' row records, the
// HTML file it saves, and the sheet, the client strip's button and the Quote done dock's.

let state;
beforeEach(() => { state = storeState({ summary: null, client: null, clientNote: null, newQuoteOff: false, detailsOpen: false, dock: null }); });
afterEach(cleanup);

const geico = { id: 'geico', name: 'GEICO' };
const progressive = { id: 'progressive', name: 'Progressive' };
const radio = (label, extra = {}) => ({ key: label, label, controlKind: 'radio', options: ['Yes', 'No'], why: 'Not on the intake.', ...extra });

// A GEICO tab with two pages and a Progressive tab with one, as renderReport keeps them.
function reports() {
  const ai = needRecord(radio('Hauls livestock'), geico, 'quote');
  ai.settled = 'ai';
  ai.head = { icon: '✓', value: 'No', tag: { kind: 'ai', text: 'AI · you chose' } };
  const marked = needRecord(radio('Prior claims'), geico, 'quote');
  settleRow(marked, 'marked');
  const picked = needRecord(radio('Team driving'), geico, 'quote');
  settleRow(picked, 'picked', null, 'Yes');
  const open = needRecord(radio('Radius'), geico, 'quote');
  const pending = needRecord(radio('Cargo limit'), geico, 'quote');
  pending.pending = true;
  pending.head = { icon: '?', value: '$100,000', tag: { kind: 'ai', text: 'AI picked · approve' } };
  const gone = answerRecord({ label: 'Gone', value: 'x' });
  gone.gone = true;
  return new Map([
    ['1|Business', { key: '1|quote||Business & Owner Info', tabId: 1, page: 'quote', carrier: geico, at: 1, list: [
      answerRecord({ label: 'ZIP', value: '21201', path: 'garaging.zip' }),
      answerRecord({ label: 'Years in business', value: '3', from: ['business.started'] }),
      answerRecord({ label: 'Medical payments', value: '$5,000', standard: true }),
      answerRecord({ label: 'Owner name', value: 'Jo Doe', edited: true }),
      answerRecord({ label: 'Phone', value: '555', kind: 'yours' }),
      { ...answerRecord({ label: 'Email', value: 'a@b.c' }), changed: 'Now on the page: x@y.z' },
      gone,
    ] }],
    ['1|Quote', { key: '1|quote||Quote & Coverages', tabId: 1, page: 'quote', carrier: geico, at: 2, list: [ai, marked, picked, open, pending] }],
    ['2|Rates', { key: '2|Rates', tabId: 2, page: 'Rates', carrier: progressive, at: 3, stopped: true, list: [answerRecord({ label: 'Clicked', value: 'Recalculate', kind: 'clicked' })] }],
    ['3|Start', { key: '3|Start', tabId: 3, page: 'Start', carrier: geico, at: 4, notice: 'Nothing to fill on this page.', list: [] }],
  ]);
}
const intake = { fileName: 'acme.pdf', agentEdited: ['drivers[1].dob', 'applicant.name'],
  record: { applicant: { name: 'Acme <Hauling>' }, garaging: { state: 'MD' }, drivers: [{}, { dob: '01/02/1980' }] } };
const make = () => quoteSummary({ reports: reports(), intake, intakeId: 'id1', at: new Date('2026-11-07T15:04:00Z'), version: '0.9.32',
  quoteStates: new Map([[1, { carrier: 'geico', code: 'VA', dismissed: 'id1|VA' }], [2, { carrier: 'progressive', code: 'PA', dismissed: 'other|PA' }]]) });

test('every page of every carrier tab, each answer with its source; an answer gone from the page is left out', () => {
  const s = make();
  expect(s.carriers.map((c) => [c.name, c.pages.map((p) => p.title)])).toEqual([
    ['GEICO', ['Business & Owner Info', 'Quote & Coverages']], ['Progressive', ['Rates']], ['GEICO (tab 2)', ['Start']]]);
  const [business, coverages] = s.carriers[0].pages;
  expect(business.rows.map((r) => [r.label, r.value, r.sourceSaid, r.note])).toEqual([
    ['ZIP', '21201', 'Intake', null], ['Years in business', '3', 'Worked out', null], ['Medical payments', '$5,000', 'TNI standard', null],
    ['Owner name', 'Jo Doe', 'Your edit', null], ['Phone', '555', 'You', null], ['Email', 'a@b.c', 'Intake', 'Now on the page: x@y.z']]);
  expect(business.counts.map((c) => `${c.sourceSaid} ${c.n}`)).toEqual(['Intake 2', 'Worked out 1', 'TNI standard 1', 'Your edit 1', 'You 1']);
  expect(coverages.rows.map((r) => [r.label, r.value, r.source, r.sourceSaid])).toEqual([
    ['Hauls livestock', 'No', 'ai', 'AI · you chose'], ['Prior claims', 'Marked done', 'marked', 'Marked done'], ['Team driving', 'Yes', 'you', 'Your answer, put in from the panel'],
    ['Radius', 'Needs your answer', 'open', 'Left for you'], ['Cargo limit', '$100,000', 'pending', 'AI picked, not approved']]);
  expect([s.carriers[1].pages[0].said, s.carriers[2].pages[0].said]).toEqual(['You stopped the fill. What went in stays.', 'Nothing to fill on this page.']);
  expect([s.answers, s.open]).toEqual([9, 1]);
});

test('the overrides, the AI decisions and what was marked done without an answer are listed on their own', () => {
  const s = make();
  expect(s.overrides.map((o) => [o.kind, o.carrier, o.label, o.value, o.said])).toEqual([
    ['edit', null, 'Driver 2: Date of birth', '01/02/1980', 'Corrected in the panel'],
    ['edit', null, 'Company name', 'Acme <Hauling>', 'Corrected in the panel'],
    // Only the quote state kept for this intake (another intake's isn't this quote's).
    ['state', 'GEICO', 'Quote state', 'Virginia', 'Kept, though the intake says Maryland'],
    ['edited', 'GEICO', 'Owner name', 'Jo Doe', 'Your edit'], ['you', 'GEICO', 'Phone', '555', 'You'], ['you', 'GEICO', 'Team driving', 'Yes', 'Your answer, put in from the panel']]);
  expect(s.ai.map((r) => [r.page, r.label, r.value])).toEqual([['Quote & Coverages', 'Hauls livestock', 'No'], ['Quote & Coverages', 'Cargo limit', '$100,000']]);
  expect(s.marked.map((r) => [r.carrier, r.label, r.note])).toEqual([['GEICO', 'Prior claims', 'Not on the intake.']]);
});

test('Save summary\'s file: one HTML page, no scripts, every value escaped, named for the client and the time', () => {
  const s = make();
  const html = summaryHtml(s);
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).not.toMatch(/<script/i);
  expect(html).toContain('Quote summary: Acme &lt;Hauling&gt;');
  expect(html).not.toContain('Acme <Hauling>');
  expect(html).toContain('It is not a record of what was done on the carrier');
  expect(html).not.toContain('Nothing was submitted');
  for (const said of ['Your overrides (6)', 'AI decisions (2)', 'Marked done without an answer (1)', 'Business &amp; Owner Info', 'GEICO (tab 2)', 'Now on the page: x@y.z']) expect(html).toContain(said);
  expect(summaryFileName(s)).toBe('quote-summary-Acme-Hauling-2026-11-07-15-04.html');
});

test('the sheet: read only, its lists and pages, Save summary and Back ask the panel; what Save said is shown', () => {
  const calls = [];
  const { container } = render(<Summary act={{ close: () => calls.push('close'), save: () => calls.push('save') }} />);
  act(() => { state.summary = { summary: make(), saved: null }; });
  const q = (sel) => container.querySelector(sel);
  expect(q('#summary-sub').textContent).toBe('Acme <Hauling> · 9 answers in · 1 left for you · read only');
  expect([...container.querySelectorAll('.summary-h')].map((h) => h.textContent)).toEqual(['Your overrides (6)', 'AI decisions (2)', 'Marked done without an answer (1)', 'GEICO', 'Progressive', 'GEICO (tab 2)']);
  expect([...container.querySelectorAll('.summary-row')].length).toBe(12);
  // Nothing on it to change an answer: no box to type in, no choice to pick.
  expect(container.querySelectorAll('input, select, textarea').length).toBe(0);
  expect(q('#summary-saved').hidden).toBe(true);
  fireEvent.click(q('#summary-save'));
  fireEvent.click(q('#summary-back'));
  fireEvent.click(q('#summary-close'));
  expect(calls).toEqual(['save', 'close', 'close']);
  act(() => { state.summary = { ...state.summary, saved: 'Saved x.html to Downloads.' }; });
  expect([q('#summary-saved').hidden, q('#summary-saved').textContent]).toEqual([false, 'Saved x.html to Downloads.']);
});

test('opened from the client strip and from the Quote done dock', () => {
  const calls = [];
  const acts = Object.fromEntries(['details', 'pdf', 'summary', 'replace', 'newQuote', 'clear', 'yes', 'cancel', 'fill', 'stop', 'next', 'lookRight', 'approve', 'defaults', 'alt']
    .map((name) => [name, () => calls.push(name)]));
  const head = render(<ClientHead act={acts} />);
  act(() => { state.client = { name: 'Acme', title: '', meta: '', pdf: false, ask: null }; });
  fireEvent.click(head.container.querySelector('#quote-summary'));
  const dock = render(<Dock act={acts} />);
  act(() => { state.dock = { phase: 'finished', tone: 'good', eyebrow: 'Quote done', title: 'The quote proposal is printed', button: 'dock-summary', label: 'Quote summary', alt: 'fill-again', altLabel: 'Fill this page again' }; });
  const button = dock.container.querySelector('#dock-summary');
  expect([button.hidden, button.textContent]).toEqual([false, 'Quote summary']);
  fireEvent.click(button);
  expect(calls).toEqual(['summary', 'summary']);
});
