// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { answerRecord, needRecord, settleRow } from '../../sidepanel/panel/report-rows.js';
import { COMMON, EVENT_FIELDS, SUMMARY_SHAPE } from '../../server/index.mjs';

// Save summary also attaches the summary to the quote's usage session on TNI's collection server
// (audit 2026-11-07, UX-05; the maintainer, 2026-11-07): a quote_summary event, logged with the
// rest of the usage log. Here: what it sends is in the shape the server keeps, practice pages are
// left out, and Save summary logs it once with the file saved.

const logged = vi.hoisted(() => []);
vi.mock('../../sidepanel/usage-log.js', async (original) => ({ ...(await original()), log: (...events) => { logged.push(...events); return Promise.resolve(); } }));
const { quoteSummary, saveSummary, summaryEvent } = await import('../../sidepanel/panel/quote-summary.js');

let state;
beforeEach(() => { logged.length = 0; state = storeState({ summary: null }); });

const geico = { id: 'geico', name: 'GEICO' };
const practice = { id: 'amwins-practice', name: 'AmWINS (practice)', practice: true };
const radio = (label) => ({ key: label, label, controlKind: 'radio', options: ['Yes', 'No'], why: 'Not on the intake.' });
function summary() {
  const marked = needRecord(radio('Prior claims'), geico, 'quote');
  settleRow(marked, 'marked');
  const onPractice = needRecord(radio('Practice question'), practice, 'app');
  settleRow(onPractice, 'marked');
  return quoteSummary({
    reports: new Map([
      ['1', { key: '1|quote||Quote & Coverages', tabId: 1, page: 'quote', carrier: geico, at: 1, list: [answerRecord({ label: 'ZIP', value: '2'.repeat(900), path: 'garaging.zip' }), marked] }],
      ['2', { key: '2|app||Insured Info', tabId: 2, page: 'app', carrier: practice, at: 2, list: [answerRecord({ label: 'Name', value: 'x', path: 'applicant.name' }), onPractice] }],
    ]),
    intake: { fileName: 'acme.pdf', agentEdited: [], record: { applicant: { name: 'Acme Hauling' }, garaging: { state: 'MD' } } },
    at: new Date('2026-11-07T15:04:00Z'), version: '0.9.32',
  });
}

test('the summary sent is in the shape the server keeps: no tab ids, practice pages left out, long text cut', () => {
  const s = summaryEvent(summary());
  expect(SUMMARY_SHAPE(s)).toBe(true);
  expect(s.carriers.map((c) => c.name)).toEqual(['GEICO']);
  expect('tabId' in s.carriers[0]).toBe(false);
  expect(s.carriers[0].pages[0].rows[0].value.length).toBe(500);
  expect(s.marked.map((r) => r.label)).toEqual(['Prior claims']);
  expect([s.answers, s.open]).toEqual([1, 0]);
  // An event the server takes whole: its fields are the server's own.
  const event = { type: 'quote_summary', summary: s };
  expect(Object.keys(event).filter((k) => ![...COMMON, ...EVENT_FIELDS.quote_summary].includes(k))).toEqual([]);
  // Practice pages only: nothing to send.
  const onlyPractice = summary();
  onlyPractice.carriers = onlyPractice.carriers.filter((c) => c.practice);
  expect(summaryEvent(onlyPractice)).toBe(null);
});

test('Save summary saves the file and logs the summary once, and says both', () => {
  globalThis.document = /** @type {any} */ ({ createElement: () => ({ click() {} }) });
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
  state.summary = { summary: summary(), saved: null };
  saveSummary();
  expect(logged.map((e) => e.type)).toEqual(['quote_summary']);
  expect(SUMMARY_SHAPE(logged[0].summary)).toBe(true);
  expect(state.summary.saved).toMatch(/^Saved quote-summary-Acme-Hauling-2026-11-07-15-04\.html to Downloads\..* A copy goes to TNI with this quote’s usage log\.$/);
});
