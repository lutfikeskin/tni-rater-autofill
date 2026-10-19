import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { CARRIERS } from '../src/carriers.js';
import { benchmark, changeKind, choiceVerdict, compareRuns, summarize, textVerdict } from '../scripts/lib/benchmark.mjs';

const raw = await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake.pdf', import.meta.url))));
const { record } = normalizeIntake(raw, { today: new Date('2026-10-05') });
const COMP = 'Does the customer need Comprehensive or Collision coverage to protect this vehicle in an accident or loss?';

// Quotes of the fake sample intake: what autofill filled and what the agent left.
function quotes() {
  const events = [];
  let t = Date.parse('2026-10-05T12:00:00Z');
  const e = (session, x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), session, intakeId: session === 'gone' ? 'other' : 'sample', carrier: 'progressive', ...x });
  for (const s of ['kept', 'fixed', 'gone']) {
    e(s, { type: 'intake_loaded', carrier: undefined, state: 'MD', businessClass: 'Expediter' });
    e(s, { type: 'fill_field', page: 'AddVehicle', view: 't1:v0', q: '2CCC', key: 'ref:RiskInput.CompCollIndicator', label: COMP, controlKind: 'radio', result: 'filled', path: 'progressive.q2CCC', shown: 'Yes' });
    // A question no rule knows, which the agent answers.
    e(s, { type: 'field_change', page: 'AddDriver', view: 't1:d0', q: '9Z01', key: '9Z01', label: 'Favorite color', kind: 'select', by: 'agent', from: null, to: 'Blue' });
    // The driver's date of birth, typed by the agent: it matched the intake's.
    e(s, { type: 'field_change', page: 'AddDriver', view: 't1:d0', q: '28A0', key: '28A0', label: 'Date of Birth', kind: 'text', by: 'agent', change: 'entered', matchesIntake: ['drivers[0].dob'] });
  }
  e('fixed', { type: 'field_change', page: 'AddVehicle', view: 't1:v0', q: '2CCC', key: 'ref:RiskInput.CompCollIndicator', label: COMP, kind: 'radio', by: 'agent', autofilled: 'progressive.q2CCC', vsAutofill: 'different', from: 'Yes', to: 'No' });
  return events;
}

test('benchmark replays quotes whose intake PDF is known and compares today\'s rules with their answers', () => {
  const run = benchmark(quotes(), { carriers: CARRIERS, raws: new Map([['sample', raw]]) });
  assert.equal(run.quotes, 3);
  assert.equal(run.replayed, 2);
  assert.deepEqual(run.missing, ['other']);
  const of = (session, label) => run.rows.find((r) => r.session === session && r.label === label);
  // Autofill the agent kept, which today's standard still gives.
  assert.equal(of('kept', COMP).group, 'kept');
  assert.equal(of('kept', COMP).result, 'agree');
  assert.equal(of('kept', COMP).today, 'Yes');
  // The agent's correction, which today's rule still doesn't give.
  assert.equal(of('fixed', COMP).group, 'corrected');
  assert.equal(of('fixed', COMP).result, 'differ');
  assert.equal(of('fixed', COMP).answer, 'No');
  // A question no rule claims stays the agent's.
  assert.equal(of('kept', 'Favorite color').result, 'left');
  // Typed text is compared through the intake fields it matched, never its value.
  assert.equal(of('kept', 'Date of Birth').group, 'agent');
  assert.equal(of('kept', 'Date of Birth').result, 'agree');
  const sum = summarize(run.rows);
  assert.deepEqual([sum.kept.total, sum.kept.agree], [1, 1]);
  assert.deepEqual([sum.corrected.total, sum.corrected.differ], [1, 1]);
  assert.deepEqual([sum.agent.total, sum.agent.agree, sum.agent.left], [4, 2, 2]);
});

test('choiceVerdict follows the fill engine\'s exact, yes/no, state and dollar tiers', () => {
  assert.equal(choiceVerdict({ kind: 'bool', value: true }, 'Yes'), 'agree');
  assert.equal(choiceVerdict({ kind: 'bool', value: false }, 'checked'), 'differ');
  assert.equal(choiceVerdict({ kind: 'state', value: 'NJ' }, 'New Jersey'), 'agree');
  assert.equal(choiceVerdict({ kind: 'choice', value: '$1M CSL' }, '$1,000,000 combined single limit'), 'agree');
  assert.equal(choiceVerdict({ kind: 'choice', value: '$100k CSL' }, '$25k/$50k'), 'differ');
  assert.equal(choiceVerdict({ kind: 'choice', value: 'Business Only' }, 'Personal Use'), 'differ');
  // Picks that depend on the page's options can't be judged without them.
  assert.equal(choiceVerdict({ kind: 'int', value: 800 }, 'More than 500 miles'), 'unsure');
  assert.equal(choiceVerdict({ kind: 'pick-not', value: { not: 'different' } }, 'Main St (USDOT Address)'), 'unsure');
  assert.equal(choiceVerdict({ kind: 'choice', value: 'Trucking' }, 'Trucking - all classes'), 'unsure');
});

test('textVerdict needs an intake field to tell typed text apart', () => {
  const dob = { kind: 'date', path: 'drivers[0].dob', value: record.drivers[0].dob };
  assert.equal(textVerdict(dob, { path: 'drivers[0].dob' }, record), 'agree');
  assert.equal(textVerdict(dob, { matches: ['drivers[0].dob'] }, record), 'agree');
  // The agent typed something no intake field holds, and today's value is the intake's.
  assert.equal(textVerdict(dob, { matches: [] }, record), 'differ');
  // Today's value is derived (no intake field holds it either): can't tell.
  assert.equal(textVerdict({ kind: 'text', path: 'progressive.q1', value: 'Zq-derived-77' }, { matches: [] }, record), 'unsure');
});

test('textVerdict does not vouch for a kept answer whose path is generated', () => {
  const derived = { kind: 'text', path: 'progressive.q230', value: 'Zq-derived-77' };
  assert.equal(textVerdict(derived, { path: 'progressive.q230' }, record), 'unsure');
});

// One answer of a lone session, with the layout the quote recorded of its page.
function lone(page, view, ev, fields) {
  const base = { session: 's', intakeId: 'sample', carrier: 'progressive' };
  const events = [
    { id: '1', t: '2026-10-05T12:00:00Z', ...base, type: 'intake_loaded', carrier: undefined, state: 'MD', businessClass: 'Expediter' },
    ...(fields ? [{ id: '2', t: '2026-10-05T12:00:01Z', ...base, type: 'page_layout', page, view, fields }] : []),
    { id: '3', t: '2026-10-05T12:00:02Z', ...base, page, view, q: ev.q, ...ev },
  ];
  return benchmark(events, { carriers: CARRIERS, raws: new Map([['sample', raw]]) }).rows;
}

test('benchmark does not guess which rule claims a repeated question, a vehicle or a removed name', () => {
  // A "City" that repeats on the page needs the page's order: only the rule that filled it pairs it.
  const city = lone('BusinessOwnerInfo', 't1', { type: 'field_change', q: '2B0', key: '2B0', label: 'City', kind: 'text', by: 'agent', change: 'entered', matchesIntake: ['garaging.city'] });
  assert.equal(city[0].result, 'unsure');
  assert.equal(city[0].reason, 'repeated text');
  // An answer of no recorded vehicle can't take vehicle 0's row.
  const miles = lone('AddVehicle', undefined, { type: 'field_change', q: '9A01', key: 'ref:RiskInput.AnnualMiles', label: 'Annual miles', kind: 'text', by: 'agent', change: 'entered', matchesIntake: [] });
  assert.notEqual(miles[0].result, 'agree');
  // A named field no rule claims is the agent's, even if a rule now has the path that once filled it.
  const gone = lone('AddVehicle', 't1:v0', { type: 'field_change', q: '9A02', key: 'ref:Gone.Field', label: 'Gone', kind: 'text', by: 'agent', autofilled: 'drivers[0].dob', vsAutofill: 'same', change: 'entered', matchesIntake: ['drivers[0].dob'] });
  assert.equal(gone[0].status, 'none');
  assert.equal(gone[0].result, 'left');
});

test('benchmark gives a withOption rule the options the quote recorded', () => {
  const doc = { q: '32B0', label: 'Documents', kind: 'select', options: ['Insurance Quote (with all bill plans)', 'Other'] };
  const rows = lone('PrintEmailFax', 't1', { type: 'field_change', q: '32B0', key: '32B0', label: 'Documents', kind: 'select', by: 'agent', from: null, to: 'Insurance Quote (with all bill plans)' }, [doc]);
  assert.equal(rows[0].status, 'value');
  assert.equal(rows[0].result, 'agree');
});

test('compareRuns lists answers whose result changed between two runs of the same quotes', () => {
  const before = [{ id: 'a', result: 'differ', today: 'No' }, { id: 'b', result: 'agree', today: 'Yes' }];
  const after = [{ id: 'a', result: 'agree', today: 'Yes' }, { id: 'b', result: 'agree', today: 'Yes' }, { id: 'c', result: 'differ' }];
  assert.deepEqual(compareRuns(before, after).map((r) => [r.id, r.was, r.result, r.change]), [['a', 'differ', 'agree', 'agrees']]);
  // An answer that agreed, now left to the agent, is more work, not a wrong answer.
  assert.equal(changeKind('agree', 'left'), 'handed');
  assert.equal(changeKind('left', 'differ'), 'differs');
  assert.equal(changeKind('differ', 'blank'), 'withdrawn');
});
