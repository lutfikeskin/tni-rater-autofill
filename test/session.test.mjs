import test from 'node:test';
import assert from 'node:assert/strict';
import { problemJoin, problemLines, sessionStory } from '../scripts/lib/session.mjs';

// REC-08 (audit 2026-11-07): a problem report had to be joined to its fill by hand, and no command
// told one quote or run as a story.
const at = (s) => `2026-11-07T10:${s}.000Z`;
const events = [
  { id: 'e1', type: 'page_view', session: 's1', agent: 'AA', v: '0.9.32', t: at('00:00'), carrier: 'geico', page: '/quote', step: 'Drivers' },
  { id: 'e2', type: 'fill_run', session: 's1', t: at('00:10'), carrier: 'geico', page: '/quote', run: 'r1', auto: 'page', filled: 5, failed: 1, leftRequired: 1, unknown: 0, ms: 4200, advanced: null, blockerList: ['differs: Zip code'] },
  { id: 'e3', type: 'fill_field', session: 's1', t: at('00:10'), carrier: 'geico', page: '/quote', run: 'r1', result: 'failed', label: 'Zip code', reason: 'the page did not keep the answer; check it' },
  { id: 'e4', type: 'fill_field', session: 's1', t: at('00:10'), carrier: 'geico', page: '/quote', run: 'r1', result: 'filled', label: 'Birth date' },
  { id: 'e5', type: 'page_layout', session: 's1', t: at('00:11'), carrier: 'geico', page: '/quote', reason: 'fill', fields: [{}, {}] },
  { id: 'e6', type: 'problem_report', session: 's1', t: at('01:00'), carrier: 'geico', page: '/quote', run: 'r1', text: 'Zip went blank' },
  { id: 'e7', type: 'page_layout', session: 's1', t: at('01:02'), carrier: 'geico', page: '/quote', reason: 'problem', fields: [{}] },
  { id: 'e8', type: 'page_view', session: 's2', t: at('02:00'), carrier: 'geico', page: '/quote' },
];

test('a problem report is joined to the fill it names, that fill\'s failed and left fields, and its page\'s layouts around it', () => {
  const join = problemJoin(events[5], events);
  assert.equal(join.run?.run, 'r1');
  assert.deepEqual(join.fields.map((f) => f.label), ['Zip code']);
  assert.deepEqual(join.layouts.map((l) => [l.reason, l.after]), [['fill', false], ['problem', true]]);
  const lines = problemLines(join).join('\n');
  assert.match(lines, /Its fill `r1` at 10:00:10 \(page\): 5 filled, 1 failed, 1 left for the agent, 0 unfamiliar; not continued; held by differs: Zip code\./);
  assert.match(lines, /failed: Zip code \(the page did not keep the answer; check it\)/);
  assert.match(lines, /Layouts of its page: 10:00:11 fill, 10:01:02 problem \(after\)\./);
  // Without a run id: the last fill on its page before it, in the same quote.
  assert.equal(problemJoin({ ...events[5], run: undefined }, events).run?.run, 'r1');
  assert.match(problemLines(problemJoin({ ...events[5], run: undefined, page: '/other' }, events)).join('\n'), /No fill on this page/);
});

test('npm run session tells a quote, a fill run or a problem report as a timeline of its quote', () => {
  const report = sessionStory('e6', events);
  assert.match(report, /^# Problem report e6/);
  assert.match(report, /Reported at 10:01:00 on \/quote: Zip went blank/);
  assert.match(report, /\| 10:00:10 \| 10\.0 \| geico \| fill `r1` \(page\): 5 filled, 1 failed, 1 left, 0 unfamiliar in 4\.2 s; not continued; held by differs: Zip code \|/);
  assert.match(report, /\| 10:00:10 \| 0\.0 \| geico \| {3}failed: Zip code \(the page did not keep the answer; check it\) \|/);
  assert.doesNotMatch(report, /Birth date/);
  assert.doesNotMatch(report, /10:02:00/, 'another quote\'s events are not in it');
  assert.match(sessionStory('r1', events), /^# Fill run r1/);
  assert.match(sessionStory('s1', events), /· 6 events\./, 'a filled field is left out');
  assert.equal(sessionStory('nope', events), null);
});
