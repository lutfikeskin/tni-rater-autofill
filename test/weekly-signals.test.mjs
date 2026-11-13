import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NO_TEST_LIST, RESTRICTED, isRestricted, markdown, mask, readTestList, signals, testSessionsOf } from '../scripts/lib/signals.mjs';

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
  e('new', '0.9.9', { type: 'fill_field', page: 'CoveragesRates', q: '9B', label: 'Liability limit', result: 'failed', code: 'option.no-match', reason: 'no option matches "$1M CSL"' });
  // A build before codes: by its text.
  e('old', '0.9.8', { type: 'fill_field', page: 'CoveragesRates', q: '9B', label: 'Liability limit', result: 'failed', reason: 'no option matches "$2M CSL"' });
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
  // By code (LEARN-09), so rewording a message doesn't split a row; a build before codes by its text.
  assert.deepEqual(s.failed, [['progressive CoveragesRates: "Liability limit" · option.no-match', 1], ['progressive CoveragesRates: "Liability limit" · no option matches "…"', 1]]);
  assert.deepEqual(s.failedCodes, [['option.no-match', 1], ['no code: no option matches "…"', 1]]);
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

// W43-05 (TNI, 2026-10-20: a printed quote is done). The agent's Print/Send opened the quote PDF in
// a tab the panel followed, and the quote was counted as "stopped at /Express/PDFHandler.ashx".
const at = (n) => new Date(Date.parse('2026-10-06T12:30:00Z') + n * 1000).toISOString();
const later = (n, x) => ({ id: `later${n}`, t: at(n), receivedAt: at(n), session: 'new', v: '0.9.9', carrier: 'progressive', ...x });
const printFlow = [later(1, { type: 'page_view', page: 'PrintEmailFax', from: 'CoveragesRates' }), later(2, { type: 'agent_click', page: 'PrintEmailFax', text: 'Print/Send' })];

test('a printed Progressive quote is done: its PDF page or the agent\'s Print/Send', () => {
  const run = (extra) => signals([...week(), ...extra], { since: '2026-10-06' });
  // The PDF's page, in either case of its path.
  for (const page of ['/Express/PDFHandler.ashx', '/express/pdfhandler.ashx']) {
    const s = run([...printFlow, later(3, { type: 'page_view', page, from: null })]);
    assert.equal(s.outcomes.progressive.done, 1, page);
    assert.ok(!s.outcomes.progressive.stopped.some(([p]) => /pdfhandler/i.test(p)), page);
    assert.equal(s.kpis.donePercent, 50, page);
    assert.equal(s.kpis.medianMinutesDone, 30, page);
  }
  // The Print/Send click with no PDF page logged (another window, a download).
  assert.equal(run(printFlow).outcomes.progressive.done, 1);
  // The Print page without the click: stopped there.
  const s = run(printFlow.slice(0, 1));
  assert.equal(s.outcomes.progressive.done, 0);
  assert.ok(s.outcomes.progressive.stopped.some(([p, n]) => p === 'PrintEmailFax' && n === 1));
});

test("a final page or click before the quote's own fill is not its end", () => {
  const events = week();
  const next = (n, x) => ({ id: `next${n}`, t: at(n), receivedAt: at(n), session: 'next', v: '0.9.9', carrier: 'progressive', ...x });
  // The panel opened on the previous client's PDF and confirmation; this quote then stopped on its
  // first page.
  events.push(next(1, { type: 'intake_loaded', carrier: undefined }), next(2, { type: 'page_view', page: '/Express/PDFHandler.ashx', from: null }),
    next(3, { type: 'page_view', page: 'PrintEmailFaxConfirm', from: null }), next(4, { type: 'agent_click', page: 'PrintEmailFax', text: 'Print/Send' }),
    next(5, { type: 'page_view', page: 'BusinessOwnerInfo', from: null }), next(6, { type: 'fill_run', page: 'BusinessOwnerInfo', blockers: 1, blockerList: [] }),
    // Another carrier's Print/Send is not Progressive's end.
    next(7, { carrier: 'amwins', type: 'fill_run', page: '/application', step: 'Vehicles', blockers: 0, blockerList: [] }),
    next(8, { carrier: 'amwins', type: 'agent_click', page: 'PrintEmailFax', text: 'Print/Send' }));
  const s = signals(events, { since: '2026-10-06' });
  assert.equal(s.outcomes.progressive.quotes, 3);
  assert.equal(s.outcomes.progressive.done, 0);
  assert.ok(s.outcomes.progressive.stopped.some(([p, n]) => p === 'BusinessOwnerInfo' && n === 1));
  assert.equal(s.outcomes.amwins.done, 0);
});

// GEICO's stop steps log a fill run with a `stop:` blocker, as Progressive's DeclinationNotice does,
// but they follow a rated quote: done, not declined.
test('a GEICO quote that reaches Final Quote Details is done, not declined', () => {
  const geico = (session, n, x) => ({ id: `${session}${n}`, t: at(n), receivedAt: at(n), session, v: '0.9.9', carrier: 'geico', page: '/quote', ...x });
  const events = [...week(),
    geico('g1', 0, { type: 'intake_loaded', carrier: undefined, page: undefined }), geico('g2', 0, { type: 'intake_loaded', carrier: undefined, page: undefined }),
    geico('g1', 1, { type: 'fill_run', step: 'Quote & Coverages', blockers: 0, blockerList: [], clicked: ['recalculate'] }),
    geico('g1', 2, { type: 'fill_run', step: 'Final Quote Details', blockers: 1, blockerList: ['stop: Final Quote Details'], auto: 'stop' }),
    // Stopped on Vehicles: neither done nor declined.
    geico('g2', 3, { type: 'fill_run', step: 'Vehicles', blockers: 1, blockerList: ['unfamiliar: Trailer type'] })];
  const s = signals(events, { since: '2026-10-06' });
  assert.equal(s.outcomes.geico.quotes, 2);
  assert.equal(s.outcomes.geico.done, 1);
  assert.equal(s.outcomes.geico.declined, 0);
  assert.deepEqual(s.outcomes.geico.stopped, [['/quote › Vehicles', 1]]);
  // Progressive's stop page is still a decline.
  const p = signals([...week(), later(1, { type: 'fill_run', page: 'DeclinationNotice', blockers: 1, blockerList: ['stop: DeclinationNotice'], auto: 'stop' })], { since: '2026-10-06' });
  assert.equal(p.outcomes.progressive.declined, 1);
});

// W48-03 (W44-19): 0 of 53 GEICO quotes read as done though about 12 printed the quote proposal
// (/PrintQuote, where TNI's GEICO quote ends), and GEICO's Add USDOT Number screen, which waits on the
// agent's answer, read as the carrier's decline.
test("a GEICO quote that prints its proposal is done; only GEICO's referral is a decline", () => {
  const geico = (session, n, x) => ({ id: `${session}${n}`, t: at(n), receivedAt: at(n), session, v: '0.9.9', carrier: 'geico', page: '/quote', ...x });
  const start = (session) => geico(session, 0, { type: 'intake_loaded', carrier: undefined, page: undefined });
  const events = [...week(), ...['print', 'old', 'usdot', 'referral'].map(start),
    geico('print', 1, { type: 'fill_run', step: 'Quote & Coverages', blockers: 0, blockerList: [], clicked: ['recalculate', 'printProposal'] }),
    geico('print', 2, { type: 'page_view', page: '/PrintQuote' }),
    // A proposal open before this quote's own fill is another quote's.
    geico('old', 1, { type: 'page_view', page: '/PrintQuote' }),
    geico('usdot', 1, { type: 'fill_run', step: 'Business & Owner Info', blockers: 0, blockerList: [] }),
    geico('usdot', 2, { type: 'fill_run', blockers: 1, blockerList: ['stop: USDOT Number'], auto: 'stop' }),
    geico('referral', 1, { type: 'fill_run', step: 'Additional Business Info', blockers: 0, blockerList: [] }),
    geico('referral', 2, { type: 'fill_run', blockers: 1, blockerList: ['stop: GEICO referral'], auto: 'stop' })];
  const { geico: g } = signals(events, { since: '2026-10-06' }).outcomes;
  assert.deepEqual([g.quotes, g.done, g.declined], [4, 1, 1]);
  assert.deepEqual(g.stopped.map(([p]) => p).sort(), ['/PrintQuote', '/quote']);
});

test('signals flags a restricted action the extension clicked', () => {
  const events = week();
  events.push({ id: 'x', t: '2026-10-06T13:00:00Z', receivedAt: '2026-10-06T13:00:00Z', session: 'new', v: '0.9.9', carrier: 'amwins', type: 'fill_run', page: '/application', advanced: 'Submit Application', clicked: [] });
  const s = signals(events, { since: '2026-10-06' });
  assert.deepEqual(s.restricted, [['advance "Submit Application"', 1]]);
  assert.match(markdown(s), /Safety finding/);
});

// Audit 2026-11-07, FLOW-12: fills of a hidden tab, with their median time against the others', per
// carrier, to judge whether Chrome's throttling is worth saying in the dock.
test('signals sets fills of a hidden tab against the others on the carrier', () => {
  const events = week();
  const run = (id, over) => ({ id, t: '2026-10-06T13:00:00Z', receivedAt: '2026-10-06T13:00:00Z', session: 'new', v: '0.9.9', carrier: 'geico', type: 'fill_run', page: 'Vehicles', clicked: [], ...over });
  events.push(run('h1', { background: true, hiddenMs: 9000, ms: 30000 }), run('h2', { hiddenMs: 2000, ms: 12000 }), run('v1', { ms: 4000 }), run('v2', { ms: 6000 }), run('s', { auto: 'stop', ms: 0, background: true }));
  const s = signals(events, { since: '2026-10-06' });
  assert.deepEqual(s.hiddenFills.geico, { runs: 4, background: 1, hidden: 2, medianMs: 30000, medianMsOthers: 6000 });
  assert.match(markdown(s), /## Fills of a hidden tab[\s\S]*- geico: 1 in the background, 2 hidden, of 4 runs · median 30000 ms against 6000 ms/);
  assert.equal(s.hiddenFills.progressive, undefined, 'a carrier with no such fill is left out');
});

// Audit 2026-11-07, FLOW-11: the lost-Continue retry rests on no proof that the first click was
// lost: each second click is counted among the extension's clicks, and only one that clicked.
test('signals counts each Continue clicked again after it didn’t take', () => {
  const events = week();
  events.push({ id: 'r', t: '2026-10-06T13:00:00Z', receivedAt: '2026-10-06T13:00:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'fill_run', page: 'Rates', auto: 'page', retried: true, advanced: 'Continue', clicked: [] });
  // A retry fill held before Continue (Let me look first, a blocker) clicked nothing: not counted.
  events.push({ id: 'h', t: '2026-10-06T13:01:00Z', receivedAt: '2026-10-06T13:01:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'fill_run', page: 'Rates', auto: 'page', retried: true, clicked: [], blockers: 1 });
  const s = signals(events, { since: '2026-10-06' });
  assert.deepEqual(s.actions.find(([a]) => a.startsWith('Continue clicked again')), ['Continue clicked again on progressive Rates', 1]);
  assert.match(markdown(s), /Continue clicked again on progressive Rates ×1/);
  assert.deepEqual(s.restricted, []);
  // A page named like a restricted action (Save Quote) isn't one: the click is still checked by its
  // own text (`advanced`), never by the page's name (#404 review).
  events.push({ id: 'q', t: '2026-10-06T13:02:00Z', receivedAt: '2026-10-06T13:02:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'fill_run', page: 'Save Quote', auto: 'page', retried: true, advanced: 'Continue', clicked: [] });
  const named = signals(events, { since: '2026-10-06' });
  assert.deepEqual(named.actions.find(([a]) => a === 'Continue clicked again on progressive Save Quote'), ['Continue clicked again on progressive Save Quote', 1]);
  assert.deepEqual([named.restricted, named.kpis?.restrictedActions ?? 0], [[], 0]);
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
  // The same answer changed again, and then put back: still one corrected answer (W46-07).
  events.push({ id: 'c2', t: '2026-10-06T12:32:00Z', receivedAt: '2026-10-06T12:32:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'field_change', page: 'Quote', by: 'agent', autofilled: 'x', vsAutofill: 'cleared', kind: 'select', from: 'No', to: null });
  events.push({ id: 'c3', t: '2026-10-06T12:33:00Z', receivedAt: '2026-10-06T12:33:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', type: 'field_change', page: 'Quote', by: 'agent', autofilled: 'x', vsAutofill: 'different', kind: 'select', from: null, to: 'No' });
  assert.equal(signals(events, { since: '2026-10-06' }).kpis.corrected, 1);
  assert.equal(s.kpis.leftPerQuote.unfamiliar, 1);
  assert.equal(s.kpis.aiErrorPercent, 50);
  assert.equal(s.kpis.restrictedActions, 0);
});

// Audit 2026-11-07, AI-07: what became of Luna's answers, the questions it left and the rules it cited.
test("signals says how much Luna suggested, what agents kept or changed, what it left and which rules it cited", () => {
  const events = week();
  let t = Date.parse('2026-10-06T13:00:00Z');
  const e = (x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), receivedAt: new Date(t).toISOString(), session: 'new', v: '0.9.9', agent: 'AB', carrier: 'progressive', page: 'Quote', ...x });
  e({ type: 'ai_suggest', items: 8, suggested: 2, leave: 6 });
  e({ type: 'ai_decision', q: '4A', decision: 'auto', ruleIds: ['general.cdl-blank'] });
  e({ type: 'ai_decision', q: '4A', decision: 'approved', ruleIds: ['general.cdl-blank'] });
  e({ type: 'ai_decision', q: '4B', decision: 'accepted', ruleIds: ['progressive.um'] });
  e({ type: 'ai_decision', q: '4C', decision: 'dismissed' });
  // The agent changed 4A afterwards, twice (one answer), and 4B before it was put in (not counted).
  e({ type: 'field_change', q: '4A', by: 'agent', kind: 'radio', from: 'No', to: 'Yes' });
  e({ type: 'field_change', q: '4A', by: 'agent', kind: 'radio', from: 'Yes', to: 'No' });
  events.push({ id: 'early-4b', t: '2026-10-06T12:59:00Z', receivedAt: '2026-10-06T12:59:00Z', session: 'new', v: '0.9.9', carrier: 'progressive', page: 'Quote', type: 'field_change', q: '4B', by: 'agent' });
  for (const why of ['missing', 'missing', 'noSource']) e({ type: 'ai_leave', q: '7Z', label: 'Prior carrier tenure', leaveWhy: why });
  const s = signals(events, { since: '2026-10-06' });
  // 2 of 8 questions suggested (the failed review is left out); 3 of 4 decided kept (week() has one accepted).
  assert.deepEqual([s.kpis.aiSuggestedPercent, s.kpis.aiAcceptedPercent, s.kpis.aiPutIn, s.kpis.aiChangedLater], [25, 75, 2, 1]);
  // CodeRabbit on PR #413: a decision names its view, as field changes do, and is matched within it:
  // a change of the same question for another vehicle isn't a change of Luna's answer.
  e({ type: 'ai_decision', q: '5A', view: 't1:v0', decision: 'accepted' });
  e({ type: 'field_change', q: '5A', view: 't1:v1', by: 'agent', kind: 'radio', from: 'No', to: 'Yes' });
  e({ type: 'ai_decision', q: '5B', view: 't1:v0', decision: 'accepted' });
  e({ type: 'field_change', q: '5B', view: 't1:v0', by: 'agent', kind: 'radio', from: 'No', to: 'Yes' });
  // A decision logged without a view (an older build) matches its page's change in any view.
  e({ type: 'ai_decision', q: '5C', decision: 'auto' });
  e({ type: 'field_change', q: '5C', view: 't1', by: 'agent', kind: 'radio', from: 'No', to: 'Yes' });
  const viewed = signals(events, { since: '2026-10-06' });
  assert.deepEqual([viewed.kpis.aiPutIn, viewed.kpis.aiChangedLater], [5, 3]);
  // CodeRabbit on PR #413: a question without a code (AmWINS, GEICO) is known by its label (masked
  // as the report masks it), on its page and in its view.
  e({ type: 'ai_decision', label: 'Years at "[client]"', view: 't1', decision: 'accepted' });
  e({ type: 'field_change', label: 'Years at "[client]"', view: 't1', by: 'agent', kind: 'select', from: '1', to: '3' });
  e({ type: 'ai_decision', label: 'Any team drivers?', view: 't1', decision: 'auto' });
  e({ type: 'field_change', label: 'Any team drivers? (optional)', view: 't1', by: 'agent', kind: 'radio', from: 'No', to: 'Yes' });
  const labelled = signals(events, { since: '2026-10-06' });
  assert.deepEqual([labelled.kpis.aiPutIn, labelled.kpis.aiChangedLater], [7, 4], 'by label: one matched, another label is another question');
  // The leave tally keeps one label's questions on different pages apart.
  e({ type: 'ai_leave', label: 'Any team drivers?', leaveWhy: 'missing' });
  events.push({ ...events.at(-1), id: 'leave-other-page', page: 'Drivers' });
  assert.deepEqual(signals(events, { since: '2026-10-06' }).aiLeft.filter(([k]) => k.includes('team')).sort(),
    [['progressive · Drivers · Any team drivers? · missing', 1], ['progressive · Quote · Any team drivers? · missing', 1]]);
  assert.deepEqual(s.aiLeft, [['progressive · Quote · 7Z · missing', 2], ['progressive · Quote · 7Z · noSource', 1]]);
  assert.deepEqual(s.aiRules, [['general.cdl-blank · auto', 1], ['general.cdl-blank · approved', 1], ['progressive.um · accepted', 1]]);
  const md = markdown(s);
  assert.match(md, /\| AI: questions suggested · decisions accepted or approved \| 25% · 75% \|/);
  assert.match(md, /\| AI answers put in that the agent changed later \| 1 of 2 \|/);
  assert.match(md, /## Questions Luna left most[\s\S]*- 2 · progressive · Quote · 7Z · missing/);
  assert.match(md, /## TNI rules Luna cited[\s\S]*- 1 · progressive\.um · accepted/);
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

test('RESTRICTED is the fill engine\'s own NEVER_ADVANCE, and Save & Continue is not one', async () => {
  const { NEVER_ADVANCE } = await import('../src/restricted.js');
  assert.equal(RESTRICTED, NEVER_ADVANCE, 'one list (audit 2026-11-07, CARR-13)');
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

// Audit 2026-10-19: run where there is no reviews/test-intakes.txt (a git worktree), the signals
// counted the maintainer's test quotes as agents' work without saying so.
const sha = (data) => createHash('sha256').update(data).digest('hex');
const repo = fileURLToPath(new URL('..', import.meta.url));

// Review of PR #103: one reader of the test-run list for every review script, so they can't
// disagree on where it is; committed fixture PDFs are tests on any computer.
test('readTestList: the repository\'s list or --tests, plus fixture PDFs, checked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-list-'));
  try {
    assert.deepEqual(readTestList({ root }), { file: null, intakes: [], warning: NO_TEST_LIST });
    // Fixture and synthetic intake PDFs, at any depth, are tests without a list.
    fs.mkdirSync(path.join(root, 'test', 'fixtures', 'more'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'synthetic-intakes', 'pdfs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'fixtures', 'more', 'a.pdf'), 'fixture a');
    fs.writeFileSync(path.join(root, 'dist', 'synthetic-intakes', 'pdfs', 'b.PDF'), 'synthetic b');
    fs.writeFileSync(path.join(root, 'test', 'fixtures', 'notes.txt'), 'not an intake');
    const fixtures = readTestList({ root });
    assert.deepEqual(fixtures.intakes.sort(), [sha('fixture a'), sha('synthetic b')].sort());
    assert.equal(fixtures.warning, NO_TEST_LIST, 'fixtures alone are no list: the maintainer\'s own test intakes are missing');
    // The repository's list: comments, blank lines, CRLF and case don't matter.
    fs.mkdirSync(path.join(root, 'reviews'));
    fs.writeFileSync(path.join(root, 'reviews', 'test-intakes.txt'), '# the maintainer\'s\r\nDEADBEEF01  # a test\r\n\r\n');
    const local = readTestList({ root });
    assert.equal(local.file, path.join(root, 'reviews', 'test-intakes.txt'));
    assert.equal(local.warning, null);
    assert.deepEqual(local.intakes.filter((x) => x.length < 64), ['deadbeef01']);
    assert.equal(local.intakes.length, 3);
    // --tests replaces the repository's list; the fixtures stay.
    const other = path.join(root, 'other.txt');
    fs.writeFileSync(other, 'cafebabe\n');
    assert.deepEqual(readTestList({ tests: other, root }).intakes.filter((x) => x.length < 64), ['cafebabe']);
    // Refused: a missing file, a short or non-hex line.
    assert.throws(() => readTestList({ tests: path.join(root, 'missing.txt'), root }), /no such file/);
    fs.writeFileSync(other, 'abc\n');
    assert.throws(() => readTestList({ tests: other, root }), /at least 8 hex/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readTestList reads this repository\'s list and fixtures by default', () => {
  const list = readTestList();
  const local = path.join(repo, 'reviews', 'test-intakes.txt');
  assert.equal(list.file, fs.existsSync(local) ? local : null);
  assert.equal(list.warning, fs.existsSync(local) ? null : NO_TEST_LIST);
  assert.ok(list.intakes.includes(sha(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'sample-intake.pdf')))));
});

// Audit 2026-10-19: run where there was no reviews/test-intakes.txt (a git worktree), the signals
// counted the maintainer's test quotes as agents' work without saying so.
test('weekly-signals reads the repository\'s list wherever it runs, and says when there is none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-'));
  try {
    const at = '2026-10-06T12:00:00Z';
    const quote = (session, intakeId) => [
      { id: `${session}1`, t: at, receivedAt: at, session, type: 'intake_loaded', intakeId },
      { id: `${session}2`, t: at, receivedAt: at, session, carrier: 'progressive', type: 'page_view', page: 'AddVehicle' },
    ];
    const log = path.join(dir, 'events.jsonl');
    fs.writeFileSync(log, [...quote('listed', 'eeeeeeee01'), ...quote('fixture', sha(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'sample-intake.pdf'))))].map((e) => JSON.stringify(e)).join('\n'));
    // A list in the working folder is not the repository's: not read.
    fs.mkdirSync(path.join(dir, 'reviews'));
    fs.writeFileSync(path.join(dir, 'reviews', 'test-intakes.txt'), 'eeeeeeee\n');
    const signalsIn = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'weekly-signals.mjs'), log, '--all', ...args], { encoding: 'utf8', cwd: dir });
    const json = signalsIn('--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).kpis.testRunsLeftOut, 1, 'the fixture quote, on any computer; not the one listed in the working folder');
    const none = signalsIn('--out', path.join(dir, 'none.md'));
    assert.equal(none.status, 0, none.stderr);
    const md = fs.readFileSync(path.join(dir, 'none.md'), 'utf8');
    if (fs.existsSync(path.join(repo, 'reviews', 'test-intakes.txt'))) {
      assert.doesNotMatch(`${none.stderr}${md}`, /No test-run list/, 'the repository\'s list was found');
    } else {
      assert.ok(none.stderr.includes(`Warning: ${NO_TEST_LIST}`));
      assert.ok(md.includes(`**${NO_TEST_LIST}**`));
    }
    const listed = signalsIn('--tests', path.join(dir, 'reviews', 'test-intakes.txt'), '--out', path.join(dir, 'listed.md'));
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(`${listed.stderr}${fs.readFileSync(path.join(dir, 'listed.md'), 'utf8')}`, /No test-run list/);
    assert.match(fs.readFileSync(path.join(dir, 'listed.md'), 'utf8'), /2 test run\(s\) left out/);
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
  assert.match(markdown(s), /## Crashes[\s\S]*## Settings in force[\s\S]*## Buttons agents clicked themselves/);
});

// agent defaults: the defaults each quote was filled with, by quote and agent; a correction of an
// answer the agent's own default filled is counted apart from corrections of TNI's rules.
test('signals list the agents\' own defaults and count corrections of them apart', () => {
  const events = week();
  const at = (i) => ({ t: `2026-10-06T13:0${i}:00Z`, receivedAt: `2026-10-06T13:0${i}:00Z` });
  const base = { v: '0.9.9', carrier: 'progressive', agent: 'AB' };
  events.push(
    { id: 'd1', ...at(0), ...base, session: 'new', type: 'agent_settings', values: {}, defaults: [{ id: 'medPay', value: 2000 }, { id: 'umCsl', value: 'ask', carrier: 'geico' }] },
    { id: 'd2', ...at(0), ...base, session: 'old', type: 'agent_settings', values: {}, defaults: [] },
    { id: 'f1', ...at(1), ...base, session: 'new', type: 'fill_field', page: 'CoveragesRates', q: '1FE4', label: 'Medical Payments', result: 'filled', source: 'agent-default' },
    { id: 'f2', ...at(1), ...base, session: 'new', type: 'fill_field', page: 'CoveragesRates', q: '1FCD', label: 'Comprehensive', result: 'filled', source: 'standard' },
    { id: 'c1', ...at(2), ...base, session: 'new', type: 'field_change', page: 'CoveragesRates', q: '1FE4', label: 'Medical Payments', by: 'agent', autofilled: 'x', vsAutofill: 'different', kind: 'select', from: '$2,000', to: '$5,000' },
    { id: 'c2', ...at(3), ...base, session: 'new', type: 'field_change', page: 'CoveragesRates', q: '1FCD', label: 'Comprehensive', by: 'agent', autofilled: 'x', vsAutofill: 'different', kind: 'select', from: '$1,000', to: '$500' },
  );
  const s = signals(events, { since: '2026-10-06' });
  assert.equal(s.kpis.corrected, 2);
  assert.equal(s.kpis.correctedOwnDefault, 1);
  assert.deepEqual(s.ownDefaults, { quotes: 2, defaults: [
    { text: 'Medical payments: $2,000', quotes: 1, agents: ['AB'] },
    { text: 'Uninsured / underinsured motorist (CSL) (geico): Ask me', quotes: 1, agents: ['AB'] },
  ] });
  const md = markdown(s);
  assert.match(md, /## Agents' own defaults/);
  assert.match(md, /- 1 quotes · Medical payments: \$2,000 · AB/);
  assert.match(md, /1 of them the agent's own default/);
  // A week without them says so.
  assert.match(markdown(signals(week(), { since: '2026-10-06' })), /## Agents' own defaults\n\n.*\n\nNone\./);
});

// A quote of the period whose agent_settings arrived before the period still lists its defaults.
test('signals read a period quote\'s defaults logged before the period', () => {
  const events = week();
  events.push({ id: 'd0', t: '2026-10-05T23:00:00Z', receivedAt: '2026-10-05T23:00:00Z', v: '0.9.9', carrier: 'progressive', agent: 'AB', session: 'new', type: 'agent_settings', values: {}, defaults: [{ id: 'umCsl', value: 300000 }] });
  const s = signals(events, { since: '2026-10-06' });
  assert.deepEqual(s.ownDefaults, { quotes: 1, defaults: [{ text: 'Uninsured / underinsured motorist (CSL): $300,000', quotes: 1, agents: ['AB'] }] });
});
