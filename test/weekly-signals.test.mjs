import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RESTRICTED, isRestricted, markdown, mask, signals, testSessionsOf } from '../scripts/lib/signals.mjs';

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
  events.find((e) => e.session === 'old' && e.type === 'intake_loaded').intakeId = 'ABCDEF0123';
  // Uppercase ids match too, and a listed prefix may be in either case.
  const listed = signals(events, { since: '2026-10-06', testIntakes: ['ABCDEF01'] });
  assert.equal(listed.quotes, 1);
  assert.equal(listed.kpis.testRunsLeftOut, 1);
  // A problem report in a test run is still listed, marked as one.
  assert.ok(listed.problems.every((p) => p.session !== 'old' || p.test));
  events.find((e) => e.session === 'new' && e.type === 'intake_loaded').test = true;
  assert.equal(signals(events, { since: '2026-10-06', testIntakes: ['abcdef01'] }).quotes, 0);
});

test('a test fingerprint shorter than 8 hex characters, or not hex, is refused rather than hiding quotes', () => {
  for (const bad of ['a', 'abcdef', 'not-a-hex-id-at-all']) {
    assert.throws(() => signals(week(), { since: '2026-10-06', testIntakes: [bad] }), /at least 8 hex/);
  }
});

test('RESTRICTED covers every word of pagekit NEVER_ADVANCE, and Save & Continue is not one', () => {
  const src = fs.readFileSync(new URL('../src/content/pagekit.js', import.meta.url), 'utf8');
  const words = src.match(/const NEVER_ADVANCE = \/\\b\(([^)]+)\)\\b\/i/)[1].split('|');
  assert.ok(words.length >= 10);
  for (const w of words) assert.ok(RESTRICTED.test(w), `RESTRICTED misses "${w}"`);
  assert.ok(isRestricted('advance "Save"'));
  assert.ok(isRestricted('advance "Sign Out"'));
  assert.ok(!isRestricted('advance "Save & Continue"'));
  assert.ok(!isRestricted('advance "Continue"'));
});

const run = (...args) => spawnSync(process.execPath, ['scripts/weekly-signals.mjs', ...args], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });

test('weekly-signals fails loudly on --since without a valid date and on a missing --tests file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-'));
  const log = path.join(dir, 'events.jsonl');
  fs.writeFileSync(log, '');
  try {
    for (const bad of [['--since'], ['--since', 'not-a-date'], ['--since', '--json'], ['--tests', path.join(dir, 'missing.txt')], ['--tests']]) {
      const r = run(log, ...bad);
      assert.equal(r.status, 1, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /needs a value|not a date|no such file/);
    }
    // A too-short fingerprint in the list fails too.
    const list = path.join(dir, 'tests.txt');
    fs.writeFileSync(list, 'a\n');
    fs.writeFileSync(log, JSON.stringify({ id: '1', t: '2026-10-06T12:00:00Z', receivedAt: '2026-10-06T12:00:00Z', session: 's', type: 'intake_loaded' }) + '\n');
    const r = run(log, '--all', '--json', '--tests', list);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at least 8 hex/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seq gaps count only when the later event is in the period; a bad since does not throw', () => {
  const events = week();
  const add = (seq, receivedAt) => events.push({ id: crypto.randomUUID(), t: receivedAt, receivedAt, v: '0.9.9', session: 'new', type: 'page_view', page: 'X', install: 'a', seq });
  add(1, '2026-09-01T10:00:00Z');
  add(5, '2026-09-02T10:00:00Z'); // gap of 3, long before the period
  add(6, '2026-10-06T13:00:00Z');
  add(9, '2026-10-06T13:01:00Z'); // gap of 2, in the period
  assert.equal(signals(events, { since: '2026-10-06' }).lost.missingInSeq, 2);
  assert.equal(signals(events).lost.missingInSeq, 5);
  assert.doesNotThrow(() => signals(events, { since: 'not-a-date' }));
  assert.equal(signals(events, { since: 'not-a-date' }).since, null);
});

test('the agent\'s latest test mark wins, and the new events are digested', () => {
  const events = week();
  const at = (s) => new Date(Date.parse('2026-10-06T12:40:00Z') + s * 1000).toISOString();
  const add = (x) => events.push({ id: crypto.randomUUID(), t: at(events.length), receivedAt: at(events.length), v: '0.9.9', carrier: 'progressive', ...x });
  // Marked as a test, then unmarked: not a test. Marked once: a test.
  add({ session: 'new', type: 'intake_marked', test: true });
  add({ session: 'new', type: 'intake_marked', test: false });
  add({ session: 'old', type: 'intake_marked', test: true });
  const tests = testSessionsOf(events);
  assert.deepEqual([tests.has('new'), tests.has('old')], [false, true]);
  // Crashes, settings, the agent's clicks, dismissed checks, provenance, platform, lost events.
  add({ session: 'new', type: 'client_error', where: 'panel', error: 'Cannot read properties of null', stack: ['sidepanel/sidepanel.js:12:5'] });
  add({ session: 'new', type: 'agent_settings', reason: 'intake', values: { autoAdvance: false, aiOn: true, uploads: 'central' } });
  add({ session: 'new', type: 'agent_click', page: 'CoveragesRates', text: 'Recalculate' });
  add({ session: 'new', type: 'check_dismissed', page: 'AddVehicle', label: 'GVW', mark: 'needs' });
  add({ session: 'new', type: 'fill_field', page: 'AddVehicle', key: '2CCC', result: 'filled', source: 'standard', review: true });
  add({ session: 'new', type: 'usage_lost', count: 4 });
  for (const [seq, install] of [[1, 'a'], [2, 'a'], [5, 'a'], [1, 'b']]) add({ session: 'new', type: 'page_view', page: 'X', seq, install });
  events.find((e) => e.session === 'new' && e.type === 'intake_loaded').platform = { os: 'Windows', chrome: 141 };
  // A report naming its fill run is joined to that run, wherever it was.
  events.find((e) => e.session === 'new' && e.type === 'fill_run' && e.page === 'CoveragesRates').run = 'run-rates-1';
  add({ session: 'new', type: 'problem_report', page: 'BusinessOwnerInfo', text: 'stuck on Rates', run: 'run-rates-1', view: 't1' });
  const s = signals(events, { since: '2026-10-06' });
  assert.equal(s.crashes.length, 1);
  assert.match(s.crashes[0][0], /Cannot read properties of null @ sidepanel\/sidepanel\.js:12:5/);
  assert.deepEqual(s.settings.on.map(([k]) => k).sort(), ['aiOn on', 'autoAdvance off', 'uploads: central']);
  assert.deepEqual(s.agentClicks, [['progressive CoveragesRates: "Recalculate"', 1]]);
  assert.deepEqual(s.dismissed, [['progressive AddVehicle: "GVW" (needs)', 1]]);
  assert.deepEqual(s.sources, [['standard (review mode)', 1]]);
  assert.deepEqual(s.platforms, [['Windows · Chrome 141', 1]]);
  assert.deepEqual(s.lost, { locally: 4, installs: 2, missingInSeq: 2 });
  const report = s.problems.find((p) => p.text === 'stuck on Rates');
  assert.equal(report.run, 'run-rates-1');
  assert.equal(report.lastRun.advanced, 'Continue', 'joined to the run it names, not the last fill on its page');
  assert.match(markdown(s), /## Panel crashes[\s\S]*## Settings in force[\s\S]*## Buttons agents clicked themselves/);
});
