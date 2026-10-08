import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowStart, lastSuccess, DOWNLOAD_STEP, questionId, uncoveredQuestions, decide, commentBody, receivedAt } from '../scripts/lib/daily.mjs';
import { loadEvents } from '../scripts/lib/events.mjs';

// Audit 2026-10-08: the daily review read events by when they were logged, from yesterday: 17 of 95
// problem reports arrived late and were in no review. It now reads what arrived since the last run.
test('daily: the window starts at the last successful run, else a day ago; events by when they arrived', () => {
  const runs = [
    { createdAt: '2026-10-06T06:12:00Z', conclusion: 'success' },
    { createdAt: '2026-10-08T06:30:00Z', conclusion: 'failure' },
    { createdAt: '2026-10-07T06:20:00Z', conclusion: 'success' },
  ];
  const last = lastSuccess(runs);
  assert.equal(last.createdAt, '2026-10-07T06:20:00Z');
  // Codex on PR #52: from when that run began downloading (it may have waited hours after being created).
  const steps = [{ name: 'Check the usage server', startedAt: '2026-10-07T09:40:00Z' }, { name: DOWNLOAD_STEP, startedAt: '2026-10-07T09:40:02Z' }];
  assert.equal(windowStart({ ...last, startedAt: '2026-10-07T09:39:50Z' }, steps), '2026-10-07T09:40:02Z');
  assert.equal(windowStart({ ...last, startedAt: '2026-10-07T09:39:50Z' }, []), '2026-10-07T09:39:50Z', 'without its steps: when it started');
  assert.equal(windowStart(null, [], new Date('2026-10-08T06:00:00Z')), '2026-10-07T06:00:00.000Z', 'no run: a day ago');
  const workflow = fs.readFileSync(new URL('../.github/workflows/daily-review.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes(`- name: ${DOWNLOAD_STEP}`), 'the workflow still names its download step so');
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

// Codex on PR #52: AmWINS fields the mock lacks still alert; a long window's comment fits GitHub; an
// event read from the server and from an export keeps when the server received it.
test('daily: AmWINS drift alerts, the comment stays under GitHub\'s limit, receipts survive a merge', () => {
  const amwins = (id, receivedAt, fields) => ({ id, t: receivedAt, receivedAt, session: id, carrier: 'amwins', type: 'page_layout', page: '/application/businessauto', step: 'Drivers', context: { state: 'NJ' }, fields });
  // A field whose label a rule claims, with an id the committed mock doesn't have.
  const drift = { id: 'brandNewDriverField', kind: 'text', label: 'Owner Date of Birth' };
  const u = uncoveredQuestions([amwins('x', '2026-10-08T10:00:00Z', [drift])], '2026-10-08T00:00:00Z');
  assert.equal(u.new.length, 1);
  assert.equal(u.new[0].notInMock, true);
  assert.match(commentBody({ since: 's', newQuestions: u.new, server: 'same', runUrl: 'u' }), /has a rule; not in the AmWINS mock/);
  const many = Array.from({ length: 200 }, (_, i) => ({ t: '2026-10-08T10:00:00Z', agent: 'AY', page: 'P', text: 'x'.repeat(1000) + i }));
  const body = commentBody({ since: 's', problems: many, server: 'same', runUrl: 'https://run' });
  assert.ok(body.length <= 61_000, `${body.length} characters`);
  assert.match(body, /and 140 more \(in the review\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-daily-'));
  fs.mkdirSync(path.join(dir, 'events'));
  fs.writeFileSync(path.join(dir, 'events', '2026-10-08.jsonl'), JSON.stringify({ id: 'e1', t: '2026-10-05T10:00:00Z', receivedAt: '2026-10-08T09:00:00Z', type: 'problem_report' }) + '\n');
  fs.writeFileSync(path.join(dir, 'export.json'), JSON.stringify({ kind: 'usage-log', events: [{ id: 'e1', t: '2026-10-05T10:00:00Z', type: 'problem_report' }] }));
  const [e] = loadEvents([path.join(dir, 'events'), path.join(dir, 'export.json')]);
  assert.equal(e.receivedAt, '2026-10-08T09:00:00Z');
});

// Codex on PR #52: AmWINS layouts named their step from 0.9.6 on, and a step heading can carry
// counts; a field seen before under the bare page is not new. And the workflow runs one at a time.
test('daily: a field seen before steps had names is not new under its step', () => {
  const amwins = (id, receivedAt, step, fields) => ({ id, t: receivedAt, receivedAt, session: id, carrier: 'amwins', type: 'page_layout', page: '/application/businessauto', step, context: { state: 'NJ' }, fields });
  const field = { id: 'permanentlyAttachedEquipment_2_0_', kind: 'radio', label: 'permanently attached equipment 2', options: ['Yes', 'No'] };
  const events = [amwins('a', '2026-10-05T20:39:00Z', undefined, [field]), amwins('b', '2026-10-07T15:42:00Z', 'Vehicles', [field])];
  assert.equal(uncoveredQuestions(events, '2026-10-07T12:00:00Z').new.length, 0);
  assert.equal(questionId('amwins', '/commerciallines › My Incomplete Submissions 3', { kind: 'combo', caption: 'Please select a Risk State:' }),
    questionId('amwins', '/commerciallines › My Incomplete Submissions 4', { kind: 'combo', caption: 'Please select a Risk State:' }));
  const workflow = fs.readFileSync(new URL('../.github/workflows/daily-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /concurrency:\s*\n\s*group: daily-review\s*\n\s*cancel-in-progress: false/);
});
