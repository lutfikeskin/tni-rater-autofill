import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowStart, lastSuccess, DOWNLOAD_STEP, questionId, uncoveredQuestions, decide, commentBody, receivedAt, quietStretch, QUIET_HOURS, lastReceipts } from '../scripts/lib/daily.mjs';
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

// Audit 2026-10-19: no events arrived from 2026-10-11 to 10-18 and every run said nothing, so a week
// without quotes and uploads that broke looked the same. Two days without one is said, once.
test('daily: two days without events is said once, by the run whose window holds the two-day mark', () => {
  const lastReceived = '2026-10-10T18:00:00.000Z';
  const run = (since, until) => decide({ problems: [], newQuestions: [], server: 'same', lastReceived, since, until }, [{ number: 50, createdAt: '2026-10-08T06:00:00Z' }]).kind;
  assert.equal(run('2026-10-11T06:00:00Z', '2026-10-12T06:00:00Z'), 'none', '36 hours: not yet');
  assert.equal(run('2026-10-12T06:00:00Z', '2026-10-13T06:00:00Z'), 'comment', 'reached two days in this window');
  assert.equal(run('2026-10-13T06:00:00Z', '2026-10-14T06:00:00Z'), 'none', 'said already: not every day of it');
  assert.equal(run('2026-10-18T06:00:00Z', '2026-10-19T06:00:00Z'), 'none');
  assert.equal(run('2026-10-08T06:00:00Z', '2026-10-19T06:00:00Z'), 'comment', 'a run after days off');
  assert.equal(decide({ lastReceived: '2026-10-19T05:00:00Z', since: '2026-10-18T06:00:00Z', until: '2026-10-19T06:00:00Z' }, []).kind, 'none', 'events today');
  assert.equal(decide({ lastReceived, since: '2026-10-12T06:00:00Z' }, [], new Date('2026-10-13T06:00:00Z')).kind, 'create', 'without `until`: now');
  assert.equal(decide({ lastReceived: null, since: '2026-10-12T06:00:00Z', until: '2026-10-13T06:00:00Z' }, []).kind, 'create', 'an empty log');
  assert.equal(decide({ since: '2026-10-12T06:00:00Z', until: '2026-10-13T06:00:00Z' }, []).kind, 'none', 'not known (an older summary): no heartbeat');
  assert.equal(quietStretch({ lastReceived, since: '2026-10-12T06:00:00Z', until: '2026-10-13T06:00:00Z' }).days, 2);
  assert.equal(QUIET_HOURS, 48);

  const body = commentBody({ since: '2026-10-12T06:00:00Z', lastReceived, until: '2026-10-13T06:00:00Z', server: 'same', review: 'reviews/daily/review-2026-10-13.md' }, '2026-10-13');
  assert.match(body, /^## 2026-10-13: 0 new problem report\(s\), 0 new question\(s\) without a rule, usage server same, no events since 2026-10-10/);
  assert.match(body, /No events received for 2 day\(s\):\*\* the last arrived 2026-10-10 18:00 UTC/);
  assert.match(body, /The whole review is `reviews\/daily\/review-2026-10-13\.md` on the computer that ran it/);
  assert.doesNotMatch(commentBody({ since: '2026-10-13T06:00:00Z', lastReceived, until: '2026-10-14T06:00:00Z', problems: [{ text: 'x' }] }), /no events/i, 'said already');
  assert.match(commentBody({ since: 's', lastReceived: null, until: '2026-10-13T06:00:00Z' }), /no events at all/);
});

// Review of PR #105: the maintainer's own test uploads restarted the two days while agents' had stopped.
test('daily: the heartbeat leaves test runs out, and keeps the last receipt of each install', () => {
  const events = [
    { session: 'a', install: 'i1', agent: 'AY', receivedAt: '2026-10-10T14:25:00Z' },
    { session: 'a', install: 'i1', agent: 'AY', receivedAt: '2026-10-09T10:00:00Z' },
    { session: 'b', install: 'i2', agent: 'AD', receivedAt: '2026-10-08T10:00:00Z' },
    { session: 'test', install: 'i3', agent: 'LK', receivedAt: '2026-10-18T10:00:00Z' },
  ];
  assert.deepEqual(lastReceipts(events, new Set(['test'])), {
    lastReceived: '2026-10-10T14:25:00Z',
    lastReceivedByInstall: { i1: { agent: 'AY', last: '2026-10-10T14:25:00Z' }, i2: { agent: 'AD', last: '2026-10-08T10:00:00Z' } },
  });
  assert.equal(lastReceipts(events).lastReceived, '2026-10-18T10:00:00Z', 'no test runs known: all of them');
  assert.equal(lastReceipts([]).lastReceived, null);
});

test('daily: a run on this computer says where its review and log are', () => {
  // 2026-10-20 on #50: "usage server skipped" with no reason read like a failure.
  assert.match(commentBody({ since: 's', problems: [{ text: 'x' }], server: 'skipped', serverNote: 'run on claude/x, not the default branch', review: 'r.md' }, '2026-10-20'),
    /^## 2026-10-20: 1 new problem report\(s\), 0 new question\(s\) without a rule, usage server not checked \(run on claude\/x, not the default branch\)\n/);
  // Posting is asked for: the workflow's two posts say --post, or GitHub would only print them.
  const workflow = fs.readFileSync(new URL('../.github/workflows/daily-review.yml', import.meta.url), 'utf8');
  const posts = workflow.split('\n').filter((l) => l.includes('daily-issue.mjs post'));
  assert.equal(posts.length, 2);
  for (const l of posts) assert.match(l, / --post( |$)/);
  assert.match(commentBody({ failed: true, failedStep: 'download', log: 'reviews/daily/daily.log', serverNote: 'The usage server could not be checked (ECONNREFUSED).' }, '2026-10-19'),
    /could not run\n\nIt stopped at the download: its log is `reviews\/daily\/daily\.log` on the computer that ran it\.\n\nThe usage server could not be checked/);
  const many = Array.from({ length: 50 }, (_, i) => ({ carrier: 'progressive', page: 'P', caption: 'x'.repeat(2000) + i }));
  assert.match(commentBody({ since: 's', newQuestions: many, review: 'reviews/daily/review-2026-10-19.md' }), /the whole list is in the review: reviews\/daily\/review-2026-10-19\.md\)$/);
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

test('a problem report in the daily comment names the build that logged it, and a test run as one', () => {
  const body = commentBody({ since: '2026-10-07T06:20:00Z', problems: [
    { t: '2026-10-07T15:04:00Z', agent: 'AY', page: 'CoveragesRates', build: '0.9.8', text: 'Print not clicked' },
    { t: '2026-10-08T15:04:00Z', agent: 'AY', page: 'Quote', build: '0.9.9 unpacked cfae2bf933', test: true, text: 'trying something' },
  ] }, '2026-10-08');
  assert.match(body, /- 2026-10-07 15:04 · AY · 0\.9\.8 · CoveragesRates: Print not clicked/);
  assert.match(body, /- 2026-10-08 15:04 · AY · 0\.9\.9 unpacked cfae2bf933 · test run · Quote: trying something/);
});
