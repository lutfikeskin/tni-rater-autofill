import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { drawRow } from '../../sidepanel/panel/fill.js';
import { ReportRows, mountRows } from '../../sidepanel/panel/report-view.jsx';
import { answerRecord, needRecord, reopenRow, setHead, settleRow, showLive } from '../../sidepanel/panel/report-rows.js';

// The report's rows in React (React PR 4b, 2026-11-01): the panel changes a row's record and drawRow
// has the list draw that row again. What each change says is checked on the records by the safety
// tests (markDone, checkItems, answeredOnPage, agentAnswer, renderAi); here, that the row on screen
// says it, that a part that didn't change isn't drawn again, and what each button asks the panel to
// do (rowActs in fill.js: the safety tests check markRow, showRow and seeRow).

beforeEach(() => { storeState({ rowsDrawn: 0 }); });
afterEach(cleanup);

const ctx = { tabId: 1, page: 'Quote', carrier: { id: 'progressive' } };
const radio = { key: 'k1', label: 'Hauls hazardous materials', controlKind: 'radio', options: ['Yes', 'No'], current: 'Yes', why: 'Not on the intake.' };
// What the panel's buttons were asked to do, and the nodes and AI slots the rows gave it.
const acts = () => {
  const calls = [];
  const nodes = new Map();
  const slots = new Map();
  const call = (name) => (...args) => { calls.push([name, ...args]); };
  return { calls, nodes, slots, act: { toggleRow: call('toggleRow'), markRow: call('markRow'), showRow: call('showRow'), pickRow: call('pickRow'), changeRow: call('changeRow'), seeRow: call('seeRow'),
    node: (rec, el) => { if (el) nodes.set(rec, el); else nodes.delete(rec); }, slot: (rec, el) => { if (el) slots.set(rec, el); else slots.delete(rec); } } };
};
const draw = (list) => {
  const t = acts();
  const entry = { list };
  render(<ReportRows entry={entry} ctx={ctx} act={t.act} />);
  return { ...t, entry, node: (rec) => t.nodes.get(rec) };
};
const redraw = (rec) => act(() => drawRow(rec));
const said = (node) => [node.className, node.querySelector('.row-icon').textContent, node.querySelector('.row-value').textContent,
  node.querySelector('.row-head .tag')?.textContent ?? null];
const drawNeed = (x = radio) => {
  const rec = needRecord(x, ctx.carrier, ctx.page, true);
  const t = draw([rec]);
  return { ...t, rec, node: t.node(rec) };
};

test('an item settled and opened again says so on its row: its head, its note with Undo, its Mark done', () => {
  const { rec, node } = drawNeed();
  expect(said(node)).toEqual(['row need open', '?', 'Needs your answer', null]);
  const note = node.querySelector('.need-note');
  expect([note.hidden, node.querySelector('.mark-done').hidden]).toEqual([true, false]);
  let undone = 0;
  settleRow(rec, 'marked', () => { undone++; });
  redraw(rec);
  expect(said(node)).toEqual(['row need open resolved', '✓', 'Marked done', 'You']);
  expect([note.hidden, note.textContent, node.querySelector('.mark-done').hidden]).toEqual([false, '✓ Marked done: won’t be filled or waited on.Undo', true]);
  note.querySelector('button').click();
  expect(undone).toBe(1);
  reopenRow(rec);
  redraw(rec);
  expect(said(node)).toEqual(['row need open', '?', 'Needs your answer', null]);
  expect([note.hidden, note.textContent, node.querySelector('.mark-done').hidden]).toEqual([true, '', false]);
  // Settled by the AI: the row says so; Mark done stays (the agent's own settling hides it).
  Object.assign(rec, { settled: 'ai' });
  setHead(rec, { icon: '✓', value: 'No', tag: { kind: 'ai', text: 'AI · you chose' } });
  redraw(rec);
  expect([said(node)[3], node.querySelector('.mark-done').hidden]).toEqual(['AI · you chose', false]);
});

test('what the page shows now is drawn in place: the same choices keep their buttons, others are drawn again', () => {
  const { rec, node } = drawNeed();
  const [yes, no] = node.querySelectorAll('.opt-btn');
  expect([yes.getAttribute('aria-pressed'), node.querySelector('.page-now').textContent]).toEqual(['true', ' On the page now: Yes.']);
  no.focus();
  showLive(rec, { key: 'k1', label: radio.label, current: 'No', options: ['Yes', 'No'] });
  redraw(rec);
  expect([...node.querySelectorAll('.opt-btn')]).toEqual([yes, no]);
  expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed'), node.querySelector('.page-now').textContent]).toEqual(['false', 'true', ' On the page now: No.']);
  expect(document.activeElement).toBe(no);
  // The AI's pick marked among them, and unmarked.
  rec.aiPick = 'Yes';
  redraw(rec);
  expect([yes.classList.contains('ai-pick'), yes.querySelector('.ai-badge')?.textContent]).toEqual([true, 'AI pick']);
  rec.aiPick = null;
  redraw(rec);
  expect([yes.classList.contains('ai-pick'), yes.querySelector('.ai-badge')]).toEqual([false, null]);
  // Other choices on the page now: drawn, the page's pressed.
  showLive(rec, { key: 'k1', label: radio.label, current: 'Maybe', options: ['Yes', 'No', 'Maybe'] });
  redraw(rec);
  expect([...node.querySelectorAll('.opt-btn')].map((b) => [b.dataset.choice, b.getAttribute('aria-pressed')])).toEqual([['Yes', 'false'], ['No', 'false'], ['Maybe', 'true']]);
  // Not shown now (a collapsed card): nothing said of the page.
  showLive(rec, null);
  redraw(rec);
  expect(node.querySelector('.page-now').textContent).toBe('');
});

test('a question gone from the page leaves the list, and comes back; Show on page says where it isn’t', () => {
  const { rec, node } = drawNeed();
  rec.gone = true;
  rec.open = false;
  redraw(rec);
  expect([node.hidden, node.className, node.querySelector('.row-body').hidden, node.querySelector('.row-head').getAttribute('aria-expanded')]).toEqual([true, 'row need gone', true, 'false']);
  rec.gone = false;
  rec.where = 'Not on the page now (it may be in a closed section).';
  redraw(rec);
  const where = node.querySelector('.need-where');
  expect([node.hidden, where.hidden, where.textContent]).toEqual([false, false, rec.where]);
  rec.where = null;
  redraw(rec);
  expect([where.hidden, where.textContent]).toEqual([true, '']);
});

test('an answer says what the page shows now, takes the agent’s tag, and offers Change answer’s choices', () => {
  const rec = answerRecord({ label: 'Hauls hazardous materials', value: 'Yes', answer: true, key: 'k1', field: 'Hauls hazardous materials', standard: true });
  rec.source = { tag: { kind: 'standard', text: 'TNI standard', title: 'A TNI standard answer, not a fact from the intake' }, quiet: null, title: 'TNI standard answer', quote: 'Answer: Yes', place: null };
  const { node: nodeOf, calls } = draw([rec]);
  const node = nodeOf(rec);
  expect(said(node)).toEqual(['row', '✓', 'Yes', 'TNI standard']);
  rec.changed = 'Now on the page: No';
  redraw(rec);
  expect([node.className, node.querySelector('.kv-now').hidden, node.querySelector('.kv-now').textContent]).toEqual(['row changed', false, 'Now on the page: No']);
  rec.change = { x: radio, options: ['Yes', 'No'], current: 'No' };
  redraw(rec);
  expect(node.querySelector('.change-slot .why').textContent).toBe('Pick the answer to put in instead:');
  const choices = [...node.querySelectorAll('.change-slot .opt-btn')];
  expect(choices.map((b) => [b.dataset.choice, b.getAttribute('aria-pressed')])).toEqual([['Yes', 'false'], ['No', 'true']]);
  choices[0].click();
  expect(calls.at(-1)).toEqual(['pickRow', rec, 'Yes', ctx, choices[0]]);
  // Changed by the agent on the page: theirs, the slot closed.
  rec.value = 'No';
  rec.changed = null;
  rec.change = null;
  setHead(rec, { icon: '✓', value: 'No', tag: { kind: 'you', text: 'You', title: 'You changed it on the page: no fill puts it back' } });
  redraw(rec);
  expect(said(node)).toEqual(['row', '✓', 'No', 'You']);
  expect([node.querySelector('.kv-now').hidden, node.querySelector('.change-slot').childElementCount, node.querySelectorAll('.row-head .tag').length]).toEqual([true, 0, 1]);
});

// From the safety tests 'each item left for the agent has a labelled Mark done bound to its field and
// page' and 'each item with a field has a labelled Show on page …' (React PR 4b): the buttons, their
// labels, and what they ask the panel, on the report's own tab and page.
test('an item’s Mark done and Show on page are labelled with it and ask the panel for it on the report’s page', () => {
  const field = needRecord({ ...radio, controlKind: 'text' }, ctx.carrier, ctx.page, false);
  // A helper's reminder the carrier marks markable (its `action`), and one with neither.
  const reminder = needRecord({ key: null, action: 'ntlRates', label: 'Non-trucking liability', why: 'Add it on the page.' }, ctx.carrier, ctx.page, false);
  const helper = needRecord({ key: null, label: 'Helper', why: 'Click it yourself.' }, ctx.carrier, ctx.page, false);
  const { node, calls } = draw([field, reminder, helper]);
  const mark = (rec) => node(rec).querySelector('.mark-done');
  const show = (rec) => node(rec).querySelector('.show-on-page');
  expect([field, reminder, helper].map((rec) => mark(rec)?.getAttribute('aria-label') ?? null))
    .toEqual(['Mark done: Hauls hazardous materials', 'Mark done: Non-trucking liability', null]);
  expect([mark(field).textContent, mark(field).title, mark(reminder).title]).toEqual(['Mark done',
    'You answered it, or it stays as the page has it: the panel won’t fill it or wait on it on this page', 'You did it on the page: the panel stops waiting on it for this quote']);
  expect([field, reminder, helper].map((rec) => show(rec)?.getAttribute('aria-label') ?? null)).toEqual(['Show on page: Hauls hazardous materials', null, null]);
  expect([show(field).textContent, show(field).title]).toEqual(['Show on page', 'Scroll the carrier page to this question and flash its mark']);
  // Not pickable: each says where to answer it.
  expect([field, reminder, helper].map((rec) => node(rec).querySelector('.row-say').textContent))
    .toEqual(['Answer it on the page, then mark it done.', 'Answer it on the page, then mark it done.', 'Do it on the rater page.']);
  mark(field).click();
  mark(reminder).click();
  show(field).click();
  node(helper).querySelector('.row-head').click();
  expect(calls).toEqual([['markRow', field, ctx], ['markRow', reminder, ctx], ['showRow', field, ctx], ['toggleRow', helper]]);
  // Closed rows: their bodies hidden, their heads saying so.
  expect([field, helper].map((rec) => [node(rec).querySelector('.row-body').hidden, node(rec).querySelector('.row-head').getAttribute('aria-expanded')])).toEqual([[true, 'false'], [true, 'false']]);
});

test('past six choices an item offers a list: the page’s answer chosen, the AI’s pick named, Put it in asks for the one chosen', () => {
  const options = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const { rec, node, calls } = drawNeed({ ...radio, controlKind: 'select', options, current: 'C' });
  const select = node.querySelector('.opt-select select');
  expect([select.value, select.getAttribute('aria-label'), select.options[0].textContent]).toEqual(['C', 'Answer', 'Choose…']);
  rec.aiPick = 'E';
  showLive(rec, { key: 'k1', label: radio.label, current: 'D', options });
  redraw(rec);
  expect([select.value, [...select.options].find((o) => o.value === 'E').textContent]).toEqual(['D', 'E (AI pick)']);
  const put = node.querySelector('.opt-select button');
  select.value = '';
  put.click();
  expect(calls).toEqual([], 'nothing chosen: nothing put in');
  select.value = 'F';
  put.click();
  expect(calls).toEqual([['pickRow', rec, 'F', ctx, put]]);
});

test('an answer’s source, See in intake and Change answer: drawn from its record, asking the panel', () => {
  const rec = answerRecord({ label: 'DOT number', value: '1234567', answer: true, key: 'dot', path: 'amwins.q4' });
  rec.source = { tag: null, quiet: 'From the intake', title: 'Intake, page 2', quote: 'DOT number: 1234567', place: { page: 1 }, seeTitle: 'Show where this came from in the intake' };
  const clicked = answerRecord({ label: 'Clicked', value: 'Rates', kind: 'clicked' });
  clicked.source = { tag: { kind: 'clicked', text: 'Clicked', title: 'Clicked for you' }, quiet: null, title: 'Clicked for you', quote: '“Rates”', place: null };
  const { node, calls } = draw([rec, clicked]);
  const row = node(rec);
  expect([row.querySelector('.sr-only').textContent, row.querySelector('.row-head .tag'), row.querySelector('.src-title').textContent, row.querySelector('.src-quote').textContent])
    .toEqual(['From the intake', null, 'Intake, page 2', 'DOT number: 1234567']);
  const see = row.querySelector('.ghost.src');
  const change = row.querySelector('.ghost.change');
  expect([see.textContent, see.title, change.textContent, change.getAttribute('aria-label')]).toEqual(['See in intake', 'Show where this came from in the intake', 'Change answer', 'Change answer: DOT number']);
  see.click();
  change.click();
  expect(calls).toEqual([['seeRow', rec], ['changeRow', rec, ctx]]);
  // A click: its tag, no actions, no word on the page.
  expect([said(node(clicked)), node(clicked).querySelector('.row-actions'), node(clicked).querySelector('.kv-now')]).toEqual([['row clicked', '✓', 'Rates', 'Clicked'], null, null]);
});

test('the AI’s slot is the AI’s: a row drawn again leaves its card; only the row that changed is drawn', () => {
  const a = needRecord(radio, ctx.carrier, ctx.page, true);
  const b = needRecord({ ...radio, key: 'k2', label: 'Other' }, ctx.carrier, ctx.page, false);
  const { slots, node, entry } = draw([a, b]);
  const card = document.createElement('div');
  card.className = 'ai-card';
  slots.get(a).append(card);
  const head = node(b).querySelector('.row-value');
  a.note = { text: 'Put in.', bad: false, undo: null };
  redraw(a);
  expect(slots.get(a).firstChild).toBe(card);
  expect(node(b).querySelector('.row-value')).toBe(head);
  // A follow-up's answer at the end of the list: drawn with the rest, which stay.
  const added = answerRecord({ label: 'VIN', value: 'X', answer: true, fresh: true });
  added.source = { tag: null, quiet: 'From the intake', title: 'Intake', quote: 'Answer: X', place: null };
  entry.list = [...entry.list, added];
  redraw(added);
  expect([node(added).className, slots.get(a).firstChild]).toEqual(['row fresh', card]);
});

test('mountRows draws a report’s list before it returns, and takes it down', () => {
  const host = document.createElement('div');
  const rec = needRecord(radio, ctx.carrier, ctx.page, true);
  const { act: actions } = acts();
  const unmount = mountRows(host, { list: [rec] }, ctx, actions);
  expect(host.querySelector('.row-label').textContent).toBe('Hauls hazardous materials');
  act(() => unmount());
  expect(host.childElementCount).toBe(0);
});
