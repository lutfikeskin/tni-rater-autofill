import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildContains, cellNumber, combine, compareVersions, fixOf, gitReader, judgeItem, markdown, matches,
  parseItemLine, parseLedger, parsePattern, parseSignature, scenarioOf, unknownField, weeklyRows,
} from '../scripts/lib/ledger.mjs';

// ---------- the ledger's text ----------

test('an item line gives its ID, severity, type, title, decision, PRs and signature', () => {
  const x = parseItemLine('- [ ] W42-03 · S2 · Fix · Carrier messages only in manual captures · approved · PR #77 · signature: `page_layout` reason `messages`');
  assert.equal(x.id, 'W42-03');
  assert.equal(x.ticked, false);
  assert.equal(x.severity, 'S2');
  assert.equal(x.type, 'Fix');
  assert.equal(x.title, 'Carrier messages only in manual captures');
  assert.equal(x.decision, 'approved');
  assert.deepEqual(x.prs, [77]);
  assert.equal(x.signature.text, '`page_layout` reason `messages`');

  // A ticked box, "Decide + Fix", bold decision text, a PR stacked on another (only the first is its own).
  const y = parseItemLine('- [x] W42-11 · S3 · Decide + Fix · Review and daily issue disagree · **question: which?** · PR #84 (on #74)');
  assert.equal(y.ticked, true);
  assert.equal(y.type, 'Decide + Fix');
  assert.equal(y.decision, 'question: which?');
  assert.deepEqual(y.prs, [84]);
  assert.equal(y.signature, null);

  // A dropped item without a type or checkbox; status fields the fix skill writes.
  const z = parseItemLine('- W43-04 · S3 · Intake address didn\'t split · **dropped** (written in a wrong format)');
  assert.equal(z.type, null);
  assert.equal(z.title, "Intake address didn't split");
  assert.match(z.decision, /^dropped/);
  const w = parseItemLine('- [ ] W43-05 · S4 · Fix · PDF counted as stopped · approved · PRs #105, #106 · merged 64dd051 · released in 0.9.12 · signature: `symptom page_view page=/Express/PDFHandler.ashx`');
  assert.deepEqual(w.prs, [105, 106]);
  assert.equal(w.merged, '64dd051');
  assert.equal(w.released, '0.9.12');
  assert.equal(w.decision, 'approved');
  assert.equal(w.signature.structured, true);
});

test('headings, table rows and spot-review summaries are not item lines', () => {
  assert.equal(parseItemLine('### W42-13 · S2 · Fix · Required GVW left empty'), null);
  assert.equal(parseItemLine('| W42-01 | S2 | Fix | Data-model names | Usage log |'), null);
  assert.equal(parseItemLine('- W42-01, -03, -05: **verified** (their signatures present)'), null);
});

const BODY = `Ledger for the weekly review.

## Weekly numbers

| Number | W42 |
| --- | --- |
| Quotes (any carrier · per carrier) | 35 · 42 |
| Quotes done (reached the carrier's final page) | 50% (Progressive 12/27, AmWINS 9/15) |
| AI requests · error rate | 46 · 7% (0.9.9: 24 requests, 1 error) |

Builds: 0.9.9 (18 quotes).

## Items

- [ ] W42-01 · S2 · Fix · Keys redacted · approved · PR #75 · signature: \`symptom * key~/\\w\\[client\\]/\`
- [ ] W42-02 · S2 · Fix · Crashes leave no trace · approved · PR #76 · signature: \`client_error\`

### W42-01 · S2 · Fix · Keys redacted (the brief's heading)
`;

test('the ledger gives its period, weekly numbers and items; comment items only when the body lacks them', () => {
  const comment = '## Spot review\n\n- W42-01, -02: **verified**\n- [ ] W42-02 · S1 · Fix · changed in a comment\n- [ ] W43-01 · S3 · Fix · New item · approved';
  const l = parseLedger(BODY, { title: 'Weekly review W42 (2026-10-06 – 2026-10-13)', comments: [comment] });
  assert.equal(l.week, 'W42');
  assert.deepEqual(l.period, { from: '2026-10-06', to: '2026-10-13' });
  assert.equal(l.numbers.column, 'W42');
  assert.equal(l.numbers.values['Quotes (any carrier · per carrier)'], '35 · 42');
  assert.deepEqual(l.items.map((x) => [x.id, x.severity, !!x.inComment]), [['W42-01', 'S2', false], ['W42-02', 'S2', false], ['W43-01', 'S3', true]]);
});

// ---------- signatures ----------

test('a structured signature names kind, event, conditions and scenario; free text only names events', () => {
  const p = parsePattern('symptom fill_field page=AddDriver result=failed label~"license number" when fill_run page=AddDriver');
  assert.equal(p.kind, 'symptom');
  assert.equal(p.type, 'fill_field');
  assert.deepEqual(p.conds.map((c) => [c.path, c.op, c.value]), [['page', '=', 'AddDriver'], ['result', '=', 'failed'], ['label', '~', 'license number']]);
  assert.deepEqual([p.when.type, p.when.conds.length], ['fill_run', 1]);

  const two = parseSignature('`expect fill_field source=* when fill_field result=filled`; `expect check_dismissed`');
  assert.equal(two.structured, true);
  assert.deepEqual(two.patterns.map((x) => x.type), ['fill_field', 'check_dismissed']);
  assert.equal(parseSignature('expect agent_click; symptom client_error').patterns.length, 2);

  // Free text is never judged: no patterns, only the events it names (unknown types and fields left out).
  const free = parseSignature('`fill_field.source`, `check_dismissed`, `made_up` and `key` with `[client]`');
  assert.equal(free.structured, false);
  assert.deepEqual(free.patterns, []);
  assert.deepEqual(free.named.map((x) => [x.type, x.conds.map((c) => `${c.path}${c.op}${c.value}`).join()]), [['fill_field', 'source=*'], ['check_dismissed', '']]);
  assert.deepEqual(parseSignature('AddVehicle `fill_run` advanced').named.map((x) => x.type), ['fill_run']);
  assert.equal(parseSignature('`key` with `[client]` inside a word').named.length, 0);

  // A malformed pattern is reported, not guessed at.
  assert.match(parseSignature('`symptom fill_field page`').error, /isn't field=value/);
  assert.throws(() => parsePattern('watch fill_field'), /opens with expect or symptom/);
  assert.throws(() => parsePattern('expect fill_run blockers>many'), /compares with a number/);
});

test('a condition on a field the server never keeps for that event is refused, not counted', () => {
  // pageHasValue is a property of a page layout's fields, never of fill_field: such a symptom would
  // never match, and the item would read as verified as soon as the question was filled.
  assert.equal(parseSignature('`symptom fill_field key=ref:RiskInput.PrimaryZIP result=noData pageHasValue=true`').error, 'fill_field has no field pageHasValue');
  assert.equal(parseSignature('`expect * nope=1`').error, 'no event has a field nope');
  assert.equal(parseSignature('`expect made_up`').error, 'no event type made_up');
  assert.equal(parseSignature('`expect fill_field result=filled when intake_loaded result=*`').error, 'intake_loaded has no field result');
  // Common fields, fields the server adds, and dotted paths under a kept field are fine.
  for (const ok of ['expect fill_field session=* receivedAt=* view=t1', 'expect intake_loaded platform.os=win counts.vehicles>2', 'expect * blockerList~GVW']) assert.doesNotThrow(() => parsePattern(ok), ok);
  assert.equal(unknownField('page_layout', 'messages'), null);
  assert.equal(unknownField('fill_run', 'source'), 'fill_run has no field source');
});

test('every example signature in the review skills parses and names kept fields', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['.claude/skills/weekly-review/SKILL.md', '.claude/skills/weekly-review/references/brief-template.md', '.claude/skills/apply-review-fixes/SKILL.md', 'docs/learning.md'];
  const examples = files.flatMap((f) => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/`((?:expect|symptom) [^`]+)`/g)].map((m) => m[1]))
    // Placeholders (`symptom …`, `expect <event> …`) are the grammar, not examples.
    .filter((x) => !/[…<]/.test(x));
  assert.ok(examples.length >= 4, `found ${examples.length} examples`);
  for (const x of examples) assert.doesNotThrow(() => parsePattern(x), x);
});

test('conditions match equality, absence, substrings, regexes, numbers, arrays and dotted fields', () => {
  const e = { type: 'fill_field', page: 'AddDriver', result: 'failed', label: 'License Number', blockers: 2, reason: 'appeared+messages', platform: { os: 'win' }, coverages: ['cargo', 'autoLiability'], key: 'ref:HasContinuousCo[client]ge' };
  const ok = (src) => matches(parsePattern(`expect ${src}`), e);
  assert.ok(ok('fill_field page=AddDriver result=failed'));
  assert.ok(!ok('fill_field page=AddVehicle'));
  assert.ok(ok('* label~license'));
  assert.ok(ok('* reason~messages'));
  assert.ok(ok('* key~/\\w\\[client\\]|\\[client\\]\\w/'));
  assert.ok(ok('* blockers>1') && !ok('* blockers>2') && ok('* blockers<3'));
  assert.ok(ok('* platform.os=win') && ok('* coverages=cargo') && !ok('* coverages=gl'));
  assert.ok(ok('* run!=*') && ok('* label=*') && !ok('* run=*'));
  assert.ok(ok('* result!=filled') && !ok('page_view'));
});

test("a symptom's default scenario is the same event where it happens; an expected event has none", () => {
  const s = scenarioOf(parsePattern('symptom fill_field key=ref:USDOTInput.ConfirmInformation result=noData controlKind=radio'));
  assert.deepEqual([s.type, s.conds.map((c) => c.path)], ['fill_field', ['key']]);
  assert.equal(scenarioOf(parsePattern('expect agent_settings')), null);
  assert.equal(scenarioOf(parsePattern('expect agent_settings when intake_loaded')).type, 'intake_loaded');
});

// ---------- builds and fixes ----------

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.9.10', '0.9.9') > 0);
  assert.equal(compareVersions('0.9.9', '0.9.9'), 0);
  assert.ok(compareVersions('0.9.8', '0.10.0') < 0);
});

// History: a (0.9.9) → F (the fix, still 0.9.9) → b (0.9.10, the release); x is a side branch from a.
const fakeGit = {
  isAncestor: (anc, c) => ({ 'F:b': true, 'F:F': true, 'F:a': false, 'F:x': false, 'G:b': true, 'G:F': false })[`${anc}:${c}`] ?? null,
  versionAt: (c) => ({ F: '0.9.9', G: '0.9.9' })[c] ?? null,
  releaseAfter: (c) => ({ F: '0.9.10', G: '0.9.10' })[c] ?? null,
};

test('a build contains a fix by its commit first, else by its version', () => {
  const fix = fixOf(['F'], fakeGit);
  assert.deepEqual(fix, { commits: ['F'], version: '0.9.9', release: '0.9.10' });
  assert.equal(buildContains({ version: '0.9.10', commit: 'b' }, fix, fakeGit), 'yes');
  assert.equal(buildContains({ version: '0.9.9', commit: 'F+dirty' }, fix, fakeGit), 'yes');
  // The commit wins over the version: a side-branch build numbered like the release lacks the fix.
  assert.equal(buildContains({ version: '0.9.10', commit: 'x' }, fix, fakeGit), 'no');
  assert.equal(buildContains({ version: '0.9.9', commit: 'a' }, fix, fakeGit), 'no');
  // A commit this clone doesn't know, or none: by version.
  assert.equal(buildContains({ version: '0.9.11', commit: 'unknown' }, fix, fakeGit), 'yes');
  assert.equal(buildContains({ version: '0.9.10' }, fix, fakeGit), 'yes');
  assert.equal(buildContains({ version: '0.9.8' }, fix, fakeGit), 'no');
  assert.equal(buildContains({ version: '0.9.9' }, fix, fakeGit), 'unknown');
  assert.equal(buildContains({ version: '?' }, fix, fakeGit), 'unknown');
  // Two fix commits: every one must be in the build.
  const both = fixOf(['F', 'G'], fakeGit);
  assert.equal(buildContains({ version: '0.9.9', commit: 'b' }, both, fakeGit), 'yes');
  assert.equal(buildContains({ version: '0.9.9', commit: 'F' }, both, fakeGit), 'no');
  // Unreleased: only a build with its commit has it.
  const unreleased = fixOf(['F'], { ...fakeGit, releaseAfter: () => null });
  assert.equal(unreleased.release, null);
  assert.equal(buildContains({ version: '0.9.10' }, unreleased, fakeGit), 'unknown');
  assert.equal(buildContains({ version: '0.9.10', commit: 'b' }, unreleased, fakeGit), 'yes');
  assert.equal(buildContains({ version: '0.9.10' }, null, fakeGit), 'no');
});

test('gitReader finds the first release after a fix in a real repository', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) { t.skip('git is not available here'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (version, file, msg) => {
    if (version) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version }));
    if (file) fs.writeFileSync(path.join(dir, file), msg);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const a = commit('0.9.9', null, 'a');
  const docs = commit('0.9.9', 'notes.txt', 'manifest untouched');
  const f = commit(null, 'fix.txt', 'the fix');
  commit(null, 'other.txt', 'unrelated');
  const b = commit('0.9.10', null, 'Release 0.9.10');
  const r = gitReader(dir, 'main');
  assert.equal(r.versionAt(f), '0.9.9');
  assert.equal(r.releaseAfter(f), '0.9.10');
  assert.equal(r.releaseAfter(b), null);
  assert.equal(r.isAncestor(f, b), true);
  assert.equal(r.isAncestor(f, docs), false);
  assert.equal(r.isAncestor(f, 'deadbeefdeadbeef'), null);
  const fix = fixOf([f], r);
  assert.equal(buildContains({ version: '0.9.10', commit: `${b.slice(0, 10)}+dirty` }, fix, r), 'yes');
  assert.equal(buildContains({ version: '0.9.9', commit: a.slice(0, 10) }, fix, r), 'no');
  assert.equal(buildContains({ version: '0.9.10', commit: 'deadbeef00' }, fix, r), 'yes');
  assert.equal(buildContains({ version: '0.9.9', commit: 'deadbeef00' }, fix, r), 'unknown');
});

// ---------- judging the items ----------

// Quotes on a build with the fix (0.9.10) and one without (0.9.9); `fixed` decides by version.
function period() {
  let t = Date.parse('2026-10-14T12:00:00Z');
  const ev = (session, v, x) => ({ id: `${session}-${t}`, t: new Date(t += 1000).toISOString(), session, v, carrier: 'progressive', ...x });
  return [
    ev('new1', '0.9.10', { type: 'intake_loaded', carrier: undefined }),
    ev('new1', '0.9.10', { type: 'agent_settings' }),
    ev('new1', '0.9.10', { type: 'fill_field', page: 'AddDriver', label: 'License number', result: 'filled', source: 'intake' }),
    ev('new2', '0.9.10', { type: 'intake_loaded', carrier: undefined }),
    ev('new2', '0.9.10', { type: 'fill_field', page: 'AddDriver', label: 'License number', result: 'failed', reason: 'invalid' }),
    ev('old', '0.9.9', { type: 'intake_loaded', carrier: undefined }),
    ev('old', '0.9.9', { type: 'fill_field', page: 'AddDriver', label: 'License number', result: 'failed' }),
    ev('old', '0.9.9', { type: 'fill_field', page: 'AddVehicle', label: 'GVW', result: 'leftRequired' }),
  ];
}
const fixed = (e) => (compareVersions(e.v, '0.9.10') >= 0 ? 'yes' : 'no');
const item = (line, extra = {}) => ({ ...parseItemLine(line), fix: { commits: ['abc1234def'], version: '0.9.9', release: '0.9.10' }, prDetails: [{ number: 90, state: 'MERGED', onMain: true, mergeCommit: 'abc1234def' }], ...extra });

test('a symptom on a fixed build recurs; its scenario without it is verified; neither is not exercised', () => {
  const recurred = judgeItem(item('- [ ] W43-03 · S3 · Fix · License · approved · signature: `symptom fill_field page=AddDriver result=failed`'), period(), fixed);
  assert.equal(recurred.status, 'recurred');
  assert.deepEqual([recurred.patterns[0].quotes, recurred.patterns[0].reached, recurred.patterns[0].older], [1, 2, 1]);
  const gvw = judgeItem(item('- [ ] W42-13 · S2 · Fix · GVW · approved · signature: `symptom fill_field page=AddVehicle result=leftRequired`'), period(), fixed);
  assert.equal(gvw.status, 'not exercised');
  assert.equal(gvw.patterns[0].older, 1);
  const verified = judgeItem(item('- [ ] W43-09 · S3 · Fix · License · approved · signature: `symptom fill_field page=AddDriver result=failed reason=format`'), period(), fixed);
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.builds, ['0.9.10 ?']);
  // Only the maintainer's test runs reached it: no plain "verified".
  const onTests = judgeItem(item('- [ ] W43-09 · S3 · Fix · License · approved · signature: `symptom fill_field page=AddDriver result=failed reason=format`'), period(), fixed, new Set(['new1', 'new2']));
  assert.deepEqual([onTests.status, onTests.patterns[0].reachedTests, onTests.patterns[0].testOnly], ['verified (test runs only)', 2, true]);
});

test('an expected event is verified when seen, recurs when missing from its scenario; free text is never judged', () => {
  const seen = judgeItem(item('- [ ] W42-07 · S3 · Fix · Source · approved · signature: `expect fill_field source=*`'), period(), fixed);
  assert.equal(seen.status, 'verified');
  const missing = judgeItem(item('- [ ] W42-05 · S3 · Fix · Settings · approved · signature: `expect agent_settings when intake_loaded`'), period(), fixed);
  assert.equal(missing.status, 'recurred');
  assert.equal(missing.patterns[0].missing, 1);
  // Free text describing a symptom: the named event is on fixed builds (even the failure itself),
  // and still nothing is proposed; the counts are information only.
  const free = judgeItem(item('- [ ] W43-03 · S3 · Fix · License · approved · signature: AddDriver `fill_field` failed on the license number'), period(), fixed);
  assert.equal(free.status, 'check by hand');
  assert.equal(free.patterns, undefined);
  assert.deepEqual(free.named.map((x) => [x.text, x.quotes, x.older]), [['fill_field', 2, 1]]);
  const none = judgeItem(item('- [ ] W42-02 · S2 · Fix · Crashes · approved · signature: `client_error`'), period(), fixed);
  assert.deepEqual([none.status, none.named[0].quotes], ['check by hand', 0]);
  const partly = judgeItem(item('- [ ] W42-07 · S3 · Fix · Both · approved · signature: `expect fill_field source=*`; `expect check_dismissed`'), period(), fixed);
  assert.equal(partly.status, 'verified in part');
  assert.equal(combine(['recurred', 'verified']), 'recurred');
  assert.equal(combine(['verified', 'verified (test runs only)']), 'verified (test runs only)');
  // Seen only in a test run: not plain verified; seen in an agent's quote too: verified.
  const onTest = judgeItem(item('- [ ] W42-07 · S3 · Fix · Source · approved · signature: `expect fill_field source=*`'), period(), fixed, new Set(['new1']));
  assert.deepEqual([onTest.status, onTest.patterns[0].tests], ['verified (test runs only)', 1]);
  const onAgent = judgeItem(item('- [ ] W42-07 · S3 · Fix · Source · approved · signature: `expect fill_field source=*`'), period(), fixed, new Set(['new2']));
  assert.equal(onAgent.status, 'verified');
  // A signature the server's fields can't satisfy is reported, not judged.
  const bad = judgeItem(item('- [ ] W43-02 · S3 · Fix · ZIP · approved · signature: `symptom fill_field result=noData pageHasValue=true`'), period(), fixed);
  assert.deepEqual([bad.status, bad.note], ['check by hand', 'signature not read: fill_field has no field pageHasValue']);
});

test('items without a merged fix stay open; ticked, dropped and deferred ones are not judged', () => {
  const ev = period();
  const open = (line, prDetails = []) => judgeItem({ ...parseItemLine(line), fix: null, prDetails }, ev, fixed);
  assert.deepEqual([open('- [ ] W42-12 · S2 · Decide · Answer key · **question: TNI reviews ~10 intakes?**').status, open('- [ ] W42-12 · S2 · Decide · Answer key · **question: TNI reviews ~10 intakes?**').note], ['still open', 'question unanswered']);
  assert.equal(open('- [ ] W43-01 · S3 · Decide + Fix · USDOT · **answer: Yes**', [{ number: 102, state: 'OPEN' }]).note, '#102 open');
  assert.equal(open('- [ ] W42-13 · S2 · Fix · GVW · **awaiting approval**').note, 'awaiting approval');
  assert.match(open('- [ ] W42-13 · S2 · Fix · GVW · approved', [{ number: 99, state: 'MERGED', onMain: false, base: 'claude/x' }]).note, /#99 merged into claude\/x, not on main/);
  assert.equal(open('- [ ] W42-13 · S2 · Fix · GVW · approved', [{ number: 98, state: 'MERGED', onMain: null, base: 'main' }]).note, "#98's merge commit not in this clone: git fetch");
  // A failed PR lookup may hide the fix: checked by hand, not called open.
  const failed = judgeItem({ ...parseItemLine('- [ ] W42-13 · S2 · Fix · GVW · approved · PR #999'), fix: null, prDetails: [], lookupErrors: ['PR #999: gh pr view: no pull requests found'] }, ev, fixed);
  assert.deepEqual([failed.status, failed.lookup], ['check by hand', 'PR #999: gh pr view: no pull requests found']);
  assert.equal(open('- [x] W42-01 · S2 · Fix · Keys · approved').status, 'ticked');
  assert.equal(open('- W43-04 · S3 · Address · **dropped**').status, 'dropped');
  assert.equal(open('- W43-06 · S4 · Reworded · **not approved; deferred**').status, 'deferred');
  // Merged but no build with it logged the period: not exercised, and why.
  const notYet = judgeItem(item('- [ ] W44-01 · S3 · Fix · Later · approved · signature: `expect agent_click`', { fix: { commits: ['c'], version: '0.9.11', release: null } }), ev, () => 'no');
  assert.equal(notYet.status, 'not exercised');
  assert.match(notYet.note, /in no release yet/);
  const noSig = judgeItem(item('- [ ] W42-11 · S3 · Fix · Review scripts · approved'), ev, fixed);
  assert.deepEqual([noSig.status, noSig.note], ['check by hand', 'no signature']);
});

// ---------- weekly numbers and the report ----------

const kpis = (quotes, x = {}) => ({ quotes, carrierQuotes: quotes + 2, donePercent: 60, medianMinutesDone: 3, filledPerQuote: 40, correctedPer100Filled: 0.5, corrected: 4, leftPerQuote: { unfamiliar: 1, noData: 1 }, problemReportsPer10Quotes: 3, problemReportsInTestRuns: 0, aiRequests: 20, aiErrorPercent: 2, restrictedActions: 0, ...x });

test('weekly numbers sit beside the ledger\'s, with a trend only from 10 quotes in both periods', () => {
  assert.equal(cellNumber('46 · 7% (0.9.9: 24 requests, 1 error)', 1), 7);
  assert.equal(cellNumber('1.7 / 0.9 / 1.5 / 0.3', 'sum'), 4.4);
  assert.equal(cellNumber('50% (Progressive 12/27)'), 50);
  assert.equal(cellNumber('—'), null);
  const prev = parseLedger(BODY).numbers;
  const w = weeklyRows(kpis(37), prev);
  assert.deepEqual([w.column, w.quotes, w.prevQuotes, w.enough], ['W42', 37, 35, true]);
  const row = (label) => w.rows.find((r) => r.label.startsWith(label));
  assert.deepEqual([row('Quotes (').now, row('Quotes (').trend], ['37 · 39', 'up']);
  assert.deepEqual([row('Quotes done').before, row('Quotes done').trend], ['50% (Progressive 12/27, AmWINS 9/15)', 'up (better)']);
  assert.equal(row('AI requests').trend, 'down (better)');
  assert.deepEqual([row('Median minutes').before, row('Median minutes').trend], ['—', '—']);
  assert.equal(row('Left to the agent').now, '1 / 0 / 1 / 0');
  const few = weeklyRows(kpis(6), prev);
  assert.equal(few.enough, false);
  assert.ok(few.rows.filter((r) => r.before !== '—').every((r) => r.trend === 'too few quotes'));
  assert.equal(weeklyRows(kpis(6, { restrictedActions: 1 }), prev).rows.at(-1).trend, 'must be 0');
});

test('the report holds IDs, builds and counts, never an event\'s values', () => {
  const ev = period().map((e) => ({ ...e, label: e.label && 'Ann Example license' }));
  const items = [
    judgeItem(item('- [ ] W43-03 · S3 · Fix · License · approved · signature: `symptom fill_field page=AddDriver result=failed`'), ev, fixed),
    judgeItem({ ...item('- [ ] W42-02 · S2 · Fix · Crashes · approved · signature: `client_error`'), inComment: true }, ev, fixed),
  ];
  const md = markdown({ ledger: { number: 86, title: 'Weekly review W42 (2026-10-06 – 2026-10-13)' }, since: '2026-10-13T00:00:00.000Z', quotes: 3, testRunsLeftOut: 1, items, weekly: weeklyRows(kpis(3), parseLedger(BODY).numbers), builds: [{ name: '0.9.10 store abc1234', quotes: 2, fixes: 'all 2' }], notes: ['A note.'] });
  assert.match(md, /^# Ledger check: Weekly review W42 .* \(#86\)/);
  assert.match(md, /\| W43-03 \| License \| recurred \| #90 → abc1234, first in 0\.9\.10 · fixed builds: 0\.9\.10 \? \(2 quotes\) · `symptom fill_field page=AddDriver result=failed`: 1 of 2 quotes that reached it; 1 on older builds \|/);
  assert.match(md, /\| W42-02\* \| Crashes \| check by hand \| #90 → abc1234, first in 0\.9\.10 · free-text signature; its named events, for information · fixed builds: 0\.9\.10 \? \(2 quotes\) · `client_error` on fixed builds: 0 quotes \|/);
  assert.match(md, /A free-text signature is not judged/);
  assert.match(md, /plus 1 test run the weekly numbers leave out/);
  assert.match(md, /\| Number \| This period \(3 quotes\) \| W42 \(35 quotes\) \| Trend \|/);
  assert.match(md, /No trend called/);
  assert.doesNotMatch(md, /Ann Example/);
});
