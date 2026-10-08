import test from 'node:test';
import assert from 'node:assert/strict';
import { windowStart, questionId, uncoveredQuestions, decide, commentBody, receivedAt } from '../scripts/lib/daily.mjs';

// Audit 2026-10-08: the daily review read events by when they were logged, from yesterday: 17 of 95
// problem reports arrived late and were in no review. It now reads what arrived since the last run.
test('daily: the window starts at the last successful run, else a day ago; events by when they arrived', () => {
  const runs = [
    { createdAt: '2026-10-06T06:12:00Z', conclusion: 'success' },
    { createdAt: '2026-10-08T06:30:00Z', conclusion: 'failure' },
    { createdAt: '2026-10-07T06:20:00Z', conclusion: 'success' },
  ];
  assert.equal(windowStart(runs), '2026-10-07T06:20:00Z');
  assert.equal(windowStart([], new Date('2026-10-08T06:00:00Z')), '2026-10-07T06:00:00.000Z');
  assert.equal(receivedAt({ t: '2026-10-05T10:00:00Z', receivedAt: '2026-10-07T09:00:00Z' }), '2026-10-07T09:00:00Z', 'a late upload is in the review it arrived for');
  assert.equal(receivedAt({ t: '2026-10-05T10:00:00Z' }), '2026-10-05T10:00:00Z', 'an exported event: when it was logged');
});

// The 216 "questions without a rule" of 2026-10-08 were 56 questions: counted per Rates row, product
// and number, and rows recorded before names are named after their vehicle.
test('daily: a question is one whatever its row, product or number', () => {
  assert.equal(questionId('progressive', 'CoveragesRates', { ref: 'RiskInput.Comp', caption: '2016 VOLVO VN', kind: 'combo' }), 'progressive|CoveragesRates|ref:RiskInput.Comp');
  assert.equal(questionId('progressive', 'CoveragesRates', { caption: '2016 FREIGHTLINER CASCADIA 125', kind: 'combo' }),
    questionId('progressive', 'CoveragesRates', { caption: '2023 RAM PROMASTER 2500', kind: 'combo' }), 'rows named after a vehicle: one per page and kind');
  assert.notEqual(questionId('progressive', 'X', { caption: 'Hazmat?', kind: 'radio' }), questionId('progressive', 'Y', { caption: 'Hazmat?', kind: 'radio' }));
});

const layout = (id, receivedAt, fields, context = { state: 'MD' }) => ({ id, t: receivedAt, receivedAt, session: id, carrier: 'progressive', type: 'page_layout', page: 'MoreAboutBusiness', context, fields });
test('daily: questions without a rule, and which first showed since the window', () => {
  const old = { q: '9A1', kind: 'radio', label: 'Does the customer haul livestock in a separate trailer?', options: ['Yes', 'No'] };
  const fresh = { q: '9A2', ref: 'RiskInput.NewThing', kind: 'radio', label: 'A question Progressive just added?', options: ['Yes', 'No'] };
  const events = [
    layout('a', '2026-10-06T10:00:00Z', [old]),
    // The same question in another state, and once its name shows: not new.
    layout('b', '2026-10-07T10:00:00Z', [{ ...old, q: '3F0', ref: 'RiskInput.Livestock' }, fresh], { state: 'VA' }),
  ];
  const u = uncoveredQuestions(events, '2026-10-07T00:00:00Z');
  assert.equal(u.total, 2);
  assert.deepEqual(u.new.map((q) => q.ref), ['RiskInput.NewThing']);
  assert.equal(uncoveredQuestions(events, null).new.length, 2, 'no window: all of them');
});

test('daily: the issue hears only about what is new, on the one open issue', () => {
  const open = [{ number: 50, createdAt: '2026-10-08T06:00:00Z' }, { number: 44, createdAt: '2026-10-07T06:00:00Z' }];
  assert.deepEqual(decide({ problems: [], newQuestions: [], server: 'same' }, open), { kind: 'none' });
  assert.deepEqual(decide({ problems: [], newQuestions: [], server: 'skipped' }, open), { kind: 'none' });
  assert.deepEqual(decide({ problems: [{ text: 'x' }], server: 'same' }, open), { kind: 'comment', number: 50 });
  assert.deepEqual(decide({ newQuestions: [{}], server: 'same' }, []), { kind: 'create', title: 'Daily review' });
  assert.equal(decide({ server: 'different' }, open).kind, 'comment', 'a server to redeploy');
  assert.equal(decide({ server: 'unreachable' }, open).kind, 'comment');
  assert.equal(decide({ failed: true, server: 'not checked' }, open).kind, 'comment', 'a failed run');
});

test('daily: the comment lists the new items and links the run', () => {
  const body = commentBody({ since: '2026-10-07T06:20:00Z', problems: [{ t: '2026-10-07T15:04:00Z', agent: 'AY', page: 'CoveragesRates', text: 'UM limit\nwrong' }],
    newQuestions: [{ carrier: 'progressive', page: 'MoreAboutBusiness', ref: 'RiskInput.NewThing', caption: 'A question?', kind: 'radio' }], uncoveredTotal: 56, server: 'same', runUrl: 'https://run' }, '2026-10-08');
  assert.match(body, /^## 2026-10-08: 1 new problem report\(s\), 1 new question\(s\) without a rule, usage server same/);
  assert.match(body, /- 2026-10-07 15:04 · AY · CoveragesRates: UM limit wrong/);
  assert.match(body, /`RiskInput.NewThing` "A question\?" \(radio\)/);
  assert.match(body, /56 different ones in all/);
  assert.match(body, /https:\/\/run/);
  assert.match(commentBody({ failed: true, runUrl: 'https://run', serverNote: 'The usage server could not be checked (ECONNREFUSED).' }, '2026-10-08'), /could not run[\s\S]*https:\/\/run[\s\S]*ECONNREFUSED/);
});
