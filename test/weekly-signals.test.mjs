import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, mask, signals } from '../scripts/lib/signals.mjs';

// Two quotes on two builds: what each left, held and reported.
function week() {
  const events = [];
  let t = Date.parse('2026-10-06T12:00:00Z');
  const e = (session, v, x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), receivedAt: new Date(t).toISOString(), session, v, agent: 'AB', carrier: 'progressive', ...x });
  e('old', '0.9.8', { type: 'intake_loaded', carrier: undefined, state: 'MD' });
  e('new', '0.9.9', { type: 'intake_loaded', carrier: undefined, state: 'FL', channel: 'store', commit: 'abc1234' });
  for (const [s, v] of [['old', '0.9.8'], ['new', '0.9.9']]) {
    e(s, v, { type: 'page_view', page: 'BusinessOwnerInfo' });
    // The same unfamiliar question in two fill runs of one page counts once.
    for (let i = 0; i < 2; i++) e(s, v, { type: 'fill_field', page: 'BusinessOwnerInfo', q: '1A', key: 'ref:X.Agent', label: 'Agent Code', result: 'unfamiliar' });
    e(s, v, { type: 'fill_run', page: 'BusinessOwnerInfo', blockers: 1, blockerList: ['unfamiliar: Agent Code'], clicked: ['verifyDot'], advanced: null });
    e(s, v, { type: 'page_view', page: 'CoveragesRates', from: 'BusinessOwnerInfo' });
  }
  e('new', '0.9.9', { type: 'fill_field', page: 'CoveragesRates', q: '9B', label: 'Liability limit', result: 'failed', reason: 'no option matches "$1M CSL"' });
  e('new', '0.9.9', { type: 'fill_run', page: 'CoveragesRates', blockers: 0, blockerList: [], clicked: ['billPlan'], advanced: 'Continue', reworded: 1, pageChanged: true });
  e('old', '0.9.8', { type: 'ai_suggest', error: 'The page or intake changed. Run Fill again for fresh suggestions.' });
  e('new', '0.9.9', { type: 'ai_suggest', ms: 900 });
  e('new', '0.9.9', { type: 'ai_decision', decision: 'accepted' });
  e('new', '0.9.9', { type: 'fill_error', page: 'CoveragesRates', error: 'stale: intake changed during the fill' });
  e('new', '0.9.9', { type: 'fill_field', page: 'CoveragesRates', q: '9C', label: 'Cargo', result: 'noData', dropped: ['run', 'step'] });
  e('new', '0.9.9', { type: 'problem_report', page: 'BusinessOwnerInfo', text: 'Agent Code was left empty', channel: 'store', commit: 'abc1234' });
  // Before the period: not counted.
  events.unshift({ id: 'early', t: '2026-09-01T00:00:00Z', receivedAt: '2026-09-01T00:00:00Z', session: 'x', type: 'problem_report', text: 'old', carrier: 'progressive', page: 'Quote' });
  return events;
}

test('signals counts the period by build, quote and reason, never by raw repeats', () => {
  const s = signals(week(), { since: '2026-10-06' });
  assert.equal(s.quotes, 2);
  assert.equal(s.newestVersion, '0.9.9');
  assert.deepEqual(s.builds.map((b) => [b.version, b.channel, b.quotes]), [['0.9.9', '?', 1], ['0.9.9', 'store', 1], ['0.9.8', '?', 1]]);
  assert.deepEqual(s.funnel.progressive.pages.map((p) => [p.page, p.quotes]), [['BusinessOwnerInfo', 2], ['CoveragesRates', 2]]);
  // One unfamiliar question per quote and page, whatever the number of fill runs.
  assert.equal(s.left.unfamiliar.answers, 2);
  assert.equal(s.left.noData.answers, 1);
  assert.deepEqual(s.failed, [['progressive CoveragesRates: "Liability limit" · no option matches "…"', 1]]);
  assert.deepEqual(s.blockers, [['progressive BusinessOwnerInfo: unfamiliar: Agent Code', 2]]);
  assert.equal(s.blockedRuns, 2);
  assert.deepEqual(s.pageChanges.map(([k]) => k).sort(), ['progressive CoveragesRates: 1 known question(s) reworded', 'progressive CoveragesRates: page looked changed']);
  assert.deepEqual(s.restricted, []);
  assert.deepEqual(s.dropped.fields, [['fill_field.run', 1], ['fill_field.step', 1]]);
  assert.deepEqual(s.ai.map((a) => [a.build, a.requests, a.errors.length]), [['0.9.9 ?', 1, 0], ['0.9.8 ?', 1, 1]]);
  assert.equal(s.problems.length, 1);
  assert.equal(s.problems[0].version, '0.9.9');
  assert.equal(s.problems[0].commit, 'abc1234');
  assert.deepEqual(s.problems[0].lastRun.blockers, ['unfamiliar: Agent Code']);
});

test('signals flags a restricted action the extension clicked', () => {
  const events = week();
  events.push({ id: 'x', t: '2026-10-06T13:00:00Z', receivedAt: '2026-10-06T13:00:00Z', session: 'new', v: '0.9.9', carrier: 'amwins', type: 'fill_run', page: '/application', advanced: 'Submit Application', clicked: [] });
  const s = signals(events, { since: '2026-10-06' });
  assert.deepEqual(s.restricted, [['advance "Submit Application"', 1]]);
  assert.match(markdown(s), /Safety finding/);
});

test('mask merges values that only differ in numbers or quoted text', () => {
  assert.equal(mask('unfamiliar: 2021 RAM PROMASTER 2500'), mask('unfamiliar: 2019 RAM PROMASTER 3500'));
  assert.equal(mask('no option matches "$1M CSL"'), 'no option matches "…"');
});

test('signals gives the weekly numbers per quote and how each quote ended', () => {
  const events = week();
  // The newer quote reaches Progressive's final page; the older one stops on Rates.
  events.push({ id: 'q', t: '2026-10-06T12:30:00Z', receivedAt: '2026-10-06T12:30:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'page_view', page: 'Quote', from: 'CoveragesRates' });
  events.push({ id: 'c', t: '2026-10-06T12:31:00Z', receivedAt: '2026-10-06T12:31:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'field_change', page: 'Quote', by: 'agent', autofilled: 'x', vsAutofill: 'different', kind: 'select', from: 'Yes', to: 'No' });
  const s = signals(events, { since: '2026-10-06' });
  assert.equal(s.outcomes.progressive.quotes, 2);
  assert.equal(s.outcomes.progressive.done, 1);
  assert.deepEqual(s.outcomes.progressive.stopped, [['CoveragesRates', 1]]);
  assert.equal(s.kpis.donePercent, 50);
  assert.equal(s.kpis.corrected, 1);
  assert.equal(s.kpis.leftPerQuote.unfamiliar, 1);
  assert.equal(s.kpis.aiErrorPercent, 50);
  assert.equal(s.kpis.restrictedActions, 0);
});

test('signals leaves test runs out: listed fingerprints and intakes marked as a test', () => {
  const events = week();
  events.find((e) => e.session === 'old' && e.type === 'intake_loaded').intakeId = 'abcdef0123';
  const listed = signals(events, { since: '2026-10-06', testIntakes: ['abcdef'] });
  assert.equal(listed.quotes, 1);
  assert.equal(listed.kpis.testRunsLeftOut, 1);
  // A problem report in a test run is still listed, marked as one.
  assert.ok(listed.problems.every((p) => p.session !== 'old' || p.test));
  events.find((e) => e.session === 'new' && e.type === 'intake_loaded').test = true;
  assert.equal(signals(events, { since: '2026-10-06', testIntakes: ['abcdef'] }).quotes, 0);
});
