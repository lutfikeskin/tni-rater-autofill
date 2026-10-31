import { afterEach, expect, test } from 'vitest';
import { answerRow, drawRow, needRow } from '../../sidepanel/panel/fill.js';
import { answerRecord, needRecord, reopenRow, setHead, settleRow, showLive } from '../../sidepanel/panel/report-rows.js';

// The report's rows as data (React PR 4a, 2026-10-31): the panel changes a row's record and drawRow
// draws the change on the row it drew, in place. What each change says is checked on the records by
// the safety tests (markDone, checkItems, answeredOnPage, agentAnswer, renderAi); here, that the row
// on screen says it, and that a part that didn't change isn't drawn again.

afterEach(() => { document.body.replaceChildren(); });

const ctx = { tabId: 1, page: 'Quote', carrier: { id: 'progressive' } };
const radio = { key: 'k1', label: 'Hauls hazardous materials', controlKind: 'radio', options: ['Yes', 'No'], current: 'Yes', why: 'Not on the intake.' };
const said = (node) => [node.className, node.querySelector('.row-icon').textContent, node.querySelector('.row-value').textContent,
  node.querySelector('.row-head .tag')?.textContent ?? null];
const drawNeed = (x = radio) => {
  const rec = needRecord(x, ctx.carrier, ctx.page, true);
  const node = needRow(rec, ctx);
  document.body.append(node);
  return { rec, node };
};

test('an item settled and opened again says so on its row: its head, its note with Undo, its Mark done', () => {
  const { rec, node } = drawNeed();
  expect(said(node)).toEqual(['row need open', '?', 'Needs your answer', null]);
  const note = node.querySelector('.need-note');
  expect([note.hidden, node.querySelector('.mark-done').hidden]).toEqual([true, false]);
  let undone = 0;
  settleRow(rec, 'marked', () => { undone++; });
  drawRow(rec);
  expect(said(node)).toEqual(['row need open resolved', '✓', 'Marked done', 'You']);
  expect([note.hidden, note.textContent, node.querySelector('.mark-done').hidden]).toEqual([false, '✓ Marked done: won’t be filled or waited on.Undo', true]);
  note.querySelector('button').click();
  expect(undone).toBe(1);
  reopenRow(rec);
  drawRow(rec);
  expect(said(node)).toEqual(['row need open', '?', 'Needs your answer', null]);
  expect([note.hidden, note.textContent, node.querySelector('.mark-done').hidden]).toEqual([true, '', false]);
  // Settled by the AI: the row says so; Mark done stays (the agent's own settling hides it).
  Object.assign(rec, { settled: 'ai' });
  setHead(rec, { icon: '✓', value: 'No', tag: { kind: 'ai', text: 'AI · you chose' } });
  drawRow(rec);
  expect([said(node)[3], node.querySelector('.mark-done').hidden]).toEqual(['AI · you chose', false]);
});

test('what the page shows now is drawn in place: the same choices keep their buttons, others are drawn again', () => {
  const { rec, node } = drawNeed();
  const [yes, no] = node.querySelectorAll('.opt-btn');
  expect([yes.getAttribute('aria-pressed'), node.querySelector('.page-now').textContent]).toEqual(['true', ' On the page now: Yes.']);
  no.focus();
  showLive(rec, { key: 'k1', label: radio.label, current: 'No', options: ['Yes', 'No'] });
  drawRow(rec);
  expect([...node.querySelectorAll('.opt-btn')]).toEqual([yes, no]);
  expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed'), node.querySelector('.page-now').textContent]).toEqual(['false', 'true', ' On the page now: No.']);
  expect(document.activeElement).toBe(no);
  // The AI's pick marked among them, and unmarked.
  rec.aiPick = 'Yes';
  drawRow(rec);
  expect([yes.classList.contains('ai-pick'), yes.querySelector('.ai-badge')?.textContent]).toEqual([true, 'AI pick']);
  rec.aiPick = null;
  drawRow(rec);
  expect([yes.classList.contains('ai-pick'), yes.querySelector('.ai-badge')]).toEqual([false, null]);
  // Other choices on the page now: drawn again, the page's pressed.
  showLive(rec, { key: 'k1', label: radio.label, current: 'Maybe', options: ['Yes', 'No', 'Maybe'] });
  drawRow(rec);
  expect([...node.querySelectorAll('.opt-btn')].map((b) => [b.dataset.choice, b.getAttribute('aria-pressed')])).toEqual([['Yes', 'false'], ['No', 'false'], ['Maybe', 'true']]);
  // Not shown now (a collapsed card): nothing said of the page.
  showLive(rec, null);
  drawRow(rec);
  expect(node.querySelector('.page-now').textContent).toBe('');
});

test('a question gone from the page leaves the list, and comes back; Show on page says where it isn’t', () => {
  const { rec, node } = drawNeed();
  rec.gone = true;
  rec.open = false;
  drawRow(rec);
  expect([node.hidden, node.className, node.querySelector('.row-body').hidden, node.querySelector('.row-head').getAttribute('aria-expanded')]).toEqual([true, 'row need gone', true, 'false']);
  rec.gone = false;
  rec.where = 'Not on the page now (it may be in a closed section).';
  drawRow(rec);
  const where = node.querySelector('.need-where');
  expect([node.hidden, where.hidden, where.textContent]).toEqual([false, false, rec.where]);
  rec.where = null;
  drawRow(rec);
  expect([where.hidden, where.textContent]).toEqual([true, '']);
});

test('an answer says what the page shows now, takes the agent’s tag, and offers Change answer’s choices', () => {
  const rec = answerRecord({ label: 'Hauls hazardous materials', value: 'Yes', answer: true, key: 'k1', field: 'Hauls hazardous materials', standard: true });
  const node = answerRow(rec, ctx);
  document.body.append(node);
  expect(said(node)).toEqual(['row', '✓', 'Yes', 'TNI standard']);
  rec.changed = 'Now on the page: No';
  drawRow(rec);
  expect([node.className, node.querySelector('.kv-now').hidden, node.querySelector('.kv-now').textContent]).toEqual(['row changed', false, 'Now on the page: No']);
  rec.change = { x: radio, options: ['Yes', 'No'], current: 'No' };
  drawRow(rec);
  expect([...node.querySelectorAll('.change-slot .opt-btn')].map((b) => [b.dataset.choice, b.getAttribute('aria-pressed')])).toEqual([['Yes', 'false'], ['No', 'true']]);
  // Changed by the agent on the page: theirs, the slot closed.
  rec.value = 'No';
  rec.changed = null;
  rec.change = null;
  setHead(rec, { icon: '✓', value: 'No', tag: { kind: 'you', text: 'You', title: 'You changed it on the page: no fill puts it back' } });
  drawRow(rec);
  expect(said(node)).toEqual(['row', '✓', 'No', 'You']);
  expect([node.querySelector('.kv-now').hidden, node.querySelector('.change-slot').childElementCount, node.querySelectorAll('.row-head .tag').length]).toEqual([true, 0, 1]);
});
