// What a period's usage events say that the review (scripts/review.mjs) doesn't show: which builds
// logged them, how far quotes got, what was left to the agent and why, what held Continue, fill
// errors, signs the carrier changed a page, fields the server dropped, the AI assistant by build,
// and each problem report with its build and what the fill was doing around it.
//
// A reporter only: counts and lists, no suggestions (learn.mjs owns those). For the weekly review
// (.claude/skills/weekly-review), where "which build" tells a problem already fixed from a live one.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { quoteSessions } from './events.mjs';
import { receivedAt } from './daily.mjs';

// Numbers and quoted values masked, so one problem across vehicles, amounts and options counts once.
export const mask = (s) => String(s ?? '').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
// Actions the extension must never take itself: every word of pagekit's NEVER_ADVANCE (a test keeps
// them in step), plus `sign` for signing. "Save & Continue" is not one, as in pagekit, which reads it as Continue.
export const RESTRICTED = /\b(finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out|order|sign)\b/i;
export const isRestricted = (action) => RESTRICTED.test(action.replace(/^(helper|advance) /, '').replace(/^"?save\s*(?:&|and)\s*continue"?$/i, 'continue'));
const tally = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
const build = (e) => `${e.v ?? '?'} ${e.channel ?? '?'}`;
const where = (e) => `${e.carrier ?? '?'} ${e.page ?? '?'}${e.step ? ` › ${mask(e.step)}` : ''}`;
// Compare versions numerically ("0.9.10" after "0.9.9").
const byVersion = (a, b) => {
  const pa = String(a).split(/[.\s]/).map(Number);
  const pb = String(b).split(/[.\s]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return String(a).localeCompare(String(b));
};

// The page (or one-address application step) where a quote is done, per carrier: Progressive's
// quote summary, print confirmation or the printed quote PDF, AmWINS' last application step
// (Underwriting) or its submission notice. A heuristic for the weekly numbers, not a carrier's
// definition. A printed quote is done (TNI, 2026-10-20): Print/Send opens the PDF in a tab the
// panel then follows, so the confirmation page in the quote tab may not be logged after it. The
// panel's own page strip (a carrier's `quoteSteps`) is a separate list.
export const FINAL = {
  progressive: /^(Quote|PrintEmailFaxConfirm|\/Express\/PDFHandler\.ashx)$/i,
  amwins: /› (Underwriting|Thank you for the submission)/,
};
// The agent's own click that ends a quote, on the page it is made: Progressive's Print/Send (the
// agent's since 2026-10-07; logged in the quote tab, whether or not the PDF's page is).
export const FINAL_CLICK = {
  progressive: { page: /^PrintEmailFax$/, text: /^print\s*\/\s*send$/i },
};
const finalClick = (e) => e.type === 'agent_click' && !!FINAL_CLICK[e.carrier]?.page.test(e.page) && FINAL_CLICK[e.carrier].text.test(String(e.text ?? '').trim());
// A carrier's login page reached in the middle of a quote: the carrier's session ran out.
const LOGIN = /\/(auth\/)?login\b|\/login\//i;

// A test run: an intake the agent marked as a test (`test` on intake_loaded), or one of the
// fingerprints the reviewer listed (`testIntakes`, full or leading hex).
export const MIN_TEST_PREFIX = 8;
const isTest = (e, testIntakes) => e.test === true || (!!e.intakeId && [...testIntakes].some((id) => String(e.intakeId).toLowerCase().startsWith(id)));
// A short or non-hex line would match unrelated quotes: refused rather than hiding them.
const badFingerprints = (list) => list.filter((x) => x.length < MIN_TEST_PREFIX || !/^[0-9a-f]+$/.test(x));
const tooShort = (bad) => `Test fingerprints need at least ${MIN_TEST_PREFIX} hex characters: ${bad.join(', ')}`;

// What the reports say without a local list (a git worktree, CI or another computer has no
// reviews/test-intakes.txt).
export const NO_TEST_LIST = 'No test-run list: the maintainer\'s test quotes are counted as agents\' work (fixture intakes and intakes marked as a test are still left out). Pass --tests <file>; from a git worktree, the main checkout\'s reviews/test-intakes.txt.';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Intake PDFs that are tests wherever the review runs: the committed fixtures and the generated
// synthetic intakes. Not client data, so their fingerprints need no local list.
const FIXTURE_PDFS = ['test/fixtures', 'dist/synthetic-intakes/pdfs'];
const pdfsIn = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => path.join(e.parentPath, e.name))
  : []);

/**
 * The test-run list every review script uses: the fingerprints in `tests` (a file), else in
 * <root>/reviews/test-intakes.txt when there is one, plus the SHA-256 of every PDF under
 * test/fixtures/ and dist/synthetic-intakes/pdfs/. Throws when `tests` is missing or a line
 * isn't at least MIN_TEST_PREFIX hex characters.
 * @param {{tests?: string|null, root?: string}} opts  root: the repository (default this one)
 * @returns {{file: string|null, intakes: string[], warning: string|null}}  file: the list read;
 *   warning: NO_TEST_LIST when there was none, for stderr and the report
 */
export function readTestList({ tests = null, root = REPO } = {}) {
  if (tests && !fs.existsSync(tests)) throw new Error(`--tests ${tests}: no such file.`);
  const fallback = path.join(root, 'reviews', 'test-intakes.txt');
  const file = tests || (fs.existsSync(fallback) ? fallback : null);
  const listed = file ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean) : [];
  const bad = badFingerprints(listed);
  if (bad.length) throw new Error(`${file}: ${tooShort(bad)}`);
  const fixtures = FIXTURE_PDFS.flatMap((dir) => pdfsIn(path.join(root, dir))).map((f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  return { file, intakes: [...new Set([...listed, ...fixtures])], warning: file ? null : NO_TEST_LIST };
}

// The sessions that are test runs: an intake loaded as one (marked before, `test` on
// intake_loaded) or listed (`testIntakes`), and the agent's latest mark in the panel
// (intake_marked: marked, or unmarked after). Shared with the review (scripts/review.mjs).
export function testSessionsOf(all, testIntakes = []) {
  const listed = [...testIntakes].map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const bad = badFingerprints(listed);
  if (bad.length) throw new Error(tooShort(bad));
  const tests = new Set(listed);
  const out = new Set(all.filter((e) => e.type === 'intake_loaded' && e.session && isTest(e, tests)).map((e) => e.session));
  const marks = new Map();
  for (const e of all) if (e.type === 'intake_marked' && e.session) marks.set(e.session, e.test === true);
  for (const [session, test] of marks) (test ? out.add(session) : out.delete(session));
  return out;
}

/**
 * @param {object[]} all  every event (loadEvents), for which sessions are quotes
 * @param {{since?: string|null, top?: number, testIntakes?: Iterable<string>, answerKey?: object|null}} opts  since: ISO
 *   time the server received them from; testIntakes: intake fingerprints whose quotes are tests;
 *   answerKey: today's rules scored against TNI's answer key (answer-key.mjs scoreKey: `total`,
 *   `decided`, `quotes`, `entries`, `proposed`), when one is configured
 */
export function signals(all, { since = null, top: n = 12, testIntakes = [], answerKey = null } = {}) {
  // An unparsable `since` means no period, not an error.
  const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
  const testSessions = testSessionsOf(all, testIntakes);
  const periodAll = from ? all.filter((e) => receivedAt(e) >= from) : all;
  // Test runs are left out of everything below, and counted.
  const events = periodAll.filter((e) => !testSessions.has(e.session));
  const quotes = quoteSessions(all);
  const inPeriod = new Set(events.filter((e) => e.type === 'intake_loaded' && quotes.has(e.session)).map((e) => e.session));

  // Builds: which version and copy (store zip, unpacked, repository files) logged the period's events.
  const builds = new Map();
  for (const e of events) {
    const k = build(e);
    const b = builds.get(k) ?? { version: e.v ?? '?', channel: e.channel ?? '?', commits: new Set(), rules: new Set(), events: 0, quotes: new Set(), agents: new Set(), first: receivedAt(e), last: receivedAt(e) };
    b.events++;
    if (e.commit) b.commits.add(e.commit);
    if (e.rules) b.rules.add(e.rules);
    if (inPeriod.has(e.session)) b.quotes.add(e.session);
    if (e.agent) b.agents.add(e.agent);
    if (receivedAt(e) < b.first) b.first = receivedAt(e);
    if (receivedAt(e) > b.last) b.last = receivedAt(e);
    builds.set(k, b);
  }

  // How far quotes got: per carrier, how many of the period's quotes reached each page (a
  // one-address application's steps as pages; a heading's counts masked), in the order quotes
  // usually reach them (the median of each page's place among a quote's pages on that carrier).
  const funnel = new Map();
  const reached = new Map();
  for (const e of events) {
    if (!inPeriod.has(e.session) || !e.carrier || !e.page || !['page_view', 'fill_run', 'page_layout', 'fill_field'].includes(e.type)) continue;
    const k = `${e.carrier}|${e.page}${e.step ? ` › ${mask(e.step)}` : ''}`;
    const s = reached.get(k) ?? new Map();
    if (!s.has(e.session)) s.set(e.session, Date.parse(e.t));
    reached.set(k, s);
  }
  const visits = new Map();
  for (const [k, s] of reached) {
    const carrier = k.split('|')[0];
    for (const [session, t] of s) {
      const v = visits.get(`${carrier}|${session}`) ?? [];
      v.push([k, t]);
      visits.set(`${carrier}|${session}`, v);
    }
  }
  const place = new Map();
  const onCarrier = new Map();
  for (const [cs, v] of visits) {
    tally(onCarrier, cs.split('|')[0]);
    v.sort((a, b) => a[1] - b[1]).forEach(([k], i) => place.set(`${k}|${cs.split('|')[1]}`, i));
  }
  for (const [k, s] of reached) {
    const [carrier, page] = k.split('|');
    const ranks = [...s.keys()].map((session) => place.get(`${k}|${session}`)).sort((a, b) => a - b);
    const list = funnel.get(carrier) ?? { quotes: onCarrier.get(carrier) ?? 0, pages: [] };
    list.pages.push({ page, quotes: s.size, rank: ranks[Math.floor(ranks.length / 2)] });
    funnel.set(carrier, list);
  }
  for (const list of funnel.values()) list.pages.sort((a, b) => a.rank - b.rank || b.quotes - a.quotes);

  // Left to the agent: each question once per quote, page and unit (fills repeat on a page).
  const left = new Map();
  const leftQuestions = new Map();
  const failed = new Map();
  for (const e of events) {
    if (e.type !== 'fill_field' || ['filled', 'kept'].includes(e.result)) continue;
    const once = `${e.session}|${e.page}|${e.view ?? ''}|${e.key ?? e.q ?? ''}|${e.label ?? ''}`;
    const r = left.get(e.result) ?? new Set();
    if (r.has(once)) continue;
    r.add(once);
    left.set(e.result, r);
    const q = leftQuestions.get(e.result) ?? new Map();
    tally(q, `${where(e)}: "${mask(e.label)}"`);
    leftQuestions.set(e.result, q);
    if (e.result === 'failed') tally(failed, `${where(e)}: "${mask(e.label)}" · ${mask(e.reason)}`);
  }

  // What held Continue (fill_run blockerList), per quote.
  const blockers = new Map();
  for (const e of events) {
    if (e.type !== 'fill_run') continue;
    for (const b of new Set((e.blockerList ?? []).map((x) => `${e.carrier} ${e.page}: ${mask(typeof x === 'string' ? x : JSON.stringify(x))}`))) {
      const s = blockers.get(b) ?? new Set();
      s.add(e.session);
      blockers.set(b, s);
    }
  }

  const runs = events.filter((e) => e.type === 'fill_run');
  // Software defects show in test runs too: page changes, the extension's clicks, errors, dropped
  // fields and problem reports count every run of the period, a test run's marked as one.
  const allRuns = periodAll.filter((e) => e.type === 'fill_run');
  const changed = new Map();
  for (const r of allRuns) {
    if (r.pageChanged) tally(changed, `${r.carrier} ${r.page}: page looked changed`);
    if (r.reworded > 0) tally(changed, `${r.carrier} ${r.page}: ${r.reworded} known question(s) reworded`);
    for (const name of r.renamed ?? []) tally(changed, `${r.carrier} ${r.page}: renamed ${mask(typeof name === 'string' ? name : JSON.stringify(name))}`);
  }

  // What the extension itself clicked: helpers (`clicked`) and continuation (`advanced`). Any that
  // reads as a restricted action (submit, bind, buy, …) is a safety finding; expected none.
  const actions = new Map();
  for (const r of allRuns) {
    for (const c of r.clicked ?? []) tally(actions, `helper ${String(typeof c === 'string' ? c : JSON.stringify(c)).replace(/:\d+$/, '')}`);
    if (r.advanced) tally(actions, `advance "${typeof r.advanced === 'string' ? r.advanced : JSON.stringify(r.advanced)}"`);
  }
  const restricted = [...actions].filter(([a]) => isRestricted(a));

  const fillErrors = new Map();
  for (const e of periodAll.filter((x) => x.type === 'fill_error')) tally(fillErrors, `${build(e)} · ${where(e)}: ${mask(e.error)}`);
  const layoutErrors = new Map();
  for (const e of periodAll.filter((x) => x.type === 'layout_error')) tally(layoutErrors, `${build(e)} · ${where(e)}: ${mask(e.error ?? e.kind)}`);

  const dropped = new Map();
  let droppedLast = null;
  for (const e of periodAll.filter((x) => x.dropped?.length)) {
    for (const f of e.dropped) tally(dropped, `${e.type}.${f}`);
    if (!droppedLast || receivedAt(e) > droppedLast) droppedLast = receivedAt(e);
  }

  // The AI assistant per build: requests, errors (by text) and decisions.
  const ai = new Map();
  for (const e of events.filter((x) => x.type === 'ai_suggest' || x.type === 'ai_decision')) {
    const a = ai.get(build(e)) ?? { requests: 0, errors: new Map(), decisions: new Map() };
    if (e.type === 'ai_suggest') {
      a.requests++;
      if (e.error) tally(a.errors, mask(e.error));
    } else tally(a.decisions, e.decision ?? '?');
    ai.set(build(e), a);
  }

  // Problem reports with their build and the fill around them (5 minutes either side, same quote).
  const near = (r, e) => e.session === r.session && Math.abs(Date.parse(e.t) - Date.parse(r.t)) <= 5 * 60 * 1000;
  const problems = periodAll.filter((e) => e.type === 'problem_report').map((r) => {
    const around = all.filter((e) => near(r, e));
    // The fill the report names (`run`, since the panel sends it), else the last one on its page.
    const lastRun = (r.run && all.find((e) => e.type === 'fill_run' && e.run === r.run)) ?? around.filter((e) => e.type === 'fill_run' && e.page === r.page && e.t <= r.t).at(-1);
    return {
      t: r.t, test: testSessions.has(r.session), agent: r.agent ?? null, view: r.view ?? null, run: r.run ?? null, version: r.v ?? null, channel: r.channel ?? null, commit: r.commit ?? null, carrier: r.carrier ?? null, page: r.page ?? null, session: r.session ?? null,
      text: String(r.text ?? '').trim(),
      fillRuns: around.filter((e) => e.type === 'fill_run').length,
      fillErrors: around.filter((e) => e.type === 'fill_error').map((e) => mask(e.error)),
      lastRun: lastRun ? { blockers: (lastRun.blockerList ?? []).map((x) => mask(typeof x === 'string' ? x : JSON.stringify(x))), advanced: lastRun.advanced ?? null, filled: lastRun.filled ?? null, unknown: lastRun.unknown ?? null } : null,
    };
  });

  // How each quote ended on each carrier it went to: done (its final page or final click, after
  // this quote's own fill there), declined (the carrier stopped it), or stopped at its last page;
  // with its minutes from first to last carrier event, and whether the carrier's login came up in
  // the middle (its session ran out).
  const perQuote = new Map();
  for (const e of events) {
    if (!inPeriod.has(e.session) || !e.carrier || !e.page) continue;
    const k = `${e.carrier}|${e.session}`;
    const q = perQuote.get(k) ?? { carrier: e.carrier, session: e.session, first: Date.parse(e.t), last: Date.parse(e.t), lastPage: null, done: false, declined: false, logins: 0, seenWork: false };
    const t = Date.parse(e.t);
    q.first = Math.min(q.first, t);
    q.last = Math.max(q.last, t);
    const page = `${e.page}${e.step ? ` › ${mask(e.step)}` : ''}`;
    if (['page_view', 'fill_run', 'page_layout', 'fill_field', 'field_change'].includes(e.type)) q.lastPage = page;
    if (e.type === 'fill_run') q.seenWork = true;
    // Only after this quote's own fill: the page the panel opens on may be the previous client's
    // confirmation, or an old quote the agent reopened.
    if (q.seenWork && (FINAL[e.carrier]?.test(page) || FINAL[e.carrier]?.test(e.page) || finalClick(e))) q.done = true;
    if (e.type === 'fill_run' && (e.blockerList ?? []).some((b) => /^stop:/.test(String(b)))) q.declined = true;
    if (e.type === 'page_view' && LOGIN.test(e.page) && q.seenWork) q.logins++;
    perQuote.set(k, q);
  }
  const outcomes = {};
  for (const q of perQuote.values()) {
    const o = (outcomes[q.carrier] ??= { quotes: 0, done: 0, declined: 0, stopped: new Map(), minutes: [], loginInterrupted: 0 });
    o.quotes++;
    if (q.done) { o.done++; o.minutes.push((q.last - q.first) / 60000); } else if (q.declined) o.declined++; else tally(o.stopped, q.lastPage ?? '?');
    if (q.logins) o.loginInterrupted++;
  }
  const med = (list) => { const x = [...list].sort((a, b) => a - b); return x.length ? Math.round(x[Math.floor(x.length / 2)]) : null; };
  for (const o of Object.values(outcomes)) { o.medianMinutesDone = med(o.minutes); delete o.minutes; o.stopped = top(o.stopped, 8); }

  // The fixed weekly numbers (the brief tracks them week over week): per quote, so a quote filled
  // twenty times counts once.
  const filledOnce = new Set(events.filter((e) => e.type === 'fill_field' && e.result === 'filled').map((e) => `${e.session}|${e.page}|${e.view ?? ''}|${e.key ?? e.q ?? ''}|${e.label ?? ''}`));
  const agentChanges = events.filter((e) => e.type === 'field_change' && e.by === 'agent' && e.autofilled);
  const corrected = agentChanges.filter((e) => e.vsAutofill === 'different' || e.vsAutofill === 'cleared').length;
  const reformatted = agentChanges.filter((e) => e.vsAutofill === 'format').length;
  const asks = events.filter((e) => e.type === 'ai_suggest');
  const per = (x, q) => (q ? Math.round((x / q) * 10) / 10 : null);
  const allDone = Object.values(outcomes).reduce((a, o) => a + o.done, 0);
  const carrierQuotes = Object.values(outcomes).reduce((a, o) => a + o.quotes, 0);
  const kpis = {
    quotes: inPeriod.size,
    carrierQuotes,
    testRunsLeftOut: new Set(periodAll.filter((e) => e.type === 'intake_loaded' && testSessions.has(e.session) && quotes.has(e.session)).map((e) => e.session)).size,
    filledPerQuote: per(filledOnce.size, inPeriod.size),
    correctedPer100Filled: filledOnce.size ? Math.round((corrected / filledOnce.size) * 1000) / 10 : null,
    corrected,
    reformatted,
    leftPerQuote: Object.fromEntries([...left].map(([r, s2]) => [r, per(s2.size, inPeriod.size)])),
    donePercent: carrierQuotes ? Math.round((allDone / carrierQuotes) * 100) : null,
    medianMinutesDone: med([...perQuote.values()].filter((q) => q.done).map((q) => (q.last - q.first) / 60000)),
    problemReportsPer10Quotes: per(events.filter((e) => e.type === 'problem_report').length * 10, inPeriod.size),
    problemReportsInTestRuns: periodAll.filter((e) => e.type === 'problem_report' && testSessions.has(e.session)).length,
    aiRequests: asks.length,
    aiErrorPercent: asks.length ? Math.round((asks.filter((a) => a.error).length / asks.length) * 100) : null,
    restrictedActions: [...actions].filter(([a]) => isRestricted(a)).reduce((x, [, c]) => x + c, 0),
    // Not the period's: today's rules on the keyed quotes, whenever they were recorded.
    // All keyed answers, and those the reviewer decided (not confirmed as proposed) apart.
    answerKey: answerKey ? { quotes: answerKey.quotes, entries: answerKey.entries, proposed: answerKey.proposed, all: keyCounts(answerKey.total), decided: keyCounts(answerKey.decided) } : null,
  };

  // Crashes in the panel (client_error), by build and message; test runs too.
  const crashes = new Map();
  for (const e of periodAll.filter((x) => x.type === 'client_error')) tally(crashes, `${build(e)} · ${mask(e.error)}${e.stack?.[0] ? ` @ ${e.stack[0]}` : ''}`);

  // The settings in force for each quote: its last agent_settings; how many quotes had each on.
  const lastSettings = new Map();
  for (const e of events) if (e.type === 'agent_settings' && inPeriod.has(e.session) && e.values) lastSettings.set(e.session, e.values);
  const settingsOn = new Map();
  for (const v of lastSettings.values()) for (const [k, x] of Object.entries(v)) tally(settingsOn, typeof x === 'boolean' ? (x ? `${k} on` : `${k} off`) : `${k}: ${x}`);

  // Buttons the agents clicked themselves, per quote; checks they dismissed; where answers came from.
  const clicks = new Map();
  for (const e of events.filter((x) => x.type === 'agent_click')) {
    const k = `${e.carrier} ${e.page}${e.step ? ` › ${e.step}` : ''}: "${mask(e.text)}"`;
    (clicks.get(k) ?? clicks.set(k, new Set()).get(k)).add(e.session);
  }
  const dismissed = new Map();
  for (const e of events.filter((x) => x.type === 'check_dismissed')) {
    const k = `${e.carrier} ${e.page}: "${mask(e.label)}" (${e.mark ?? '?'})`;
    (dismissed.get(k) ?? dismissed.set(k, new Set()).get(k)).add(e.session);
  }
  const sources = new Map();
  const sourceOnce = new Set();
  for (const e of events.filter((x) => x.type === 'fill_field' && x.result === 'filled' && x.source)) {
    const once = `${e.session}|${e.page}|${e.view ?? ''}|${e.key ?? e.q ?? ''}`;
    if (sourceOnce.has(once)) continue;
    sourceOnce.add(once);
    tally(sources, `${e.source}${e.review ? ' (review mode)' : ''}`);
  }
  const platforms = new Map();
  for (const e of events.filter((x) => x.type === 'intake_loaded' && inPeriod.has(x.session) && x.platform)) tally(platforms, `${e.platform.os ?? '?'} · Chrome ${e.platform.chrome ?? '?'}`);

  // Events lost on the way: what a computer's log dropped (usage_lost), and gaps in each install's
  // numbers (`seq`) among the events received.
  const lostLocally = periodAll.filter((e) => e.type === 'usage_lost').reduce((x, e) => x + (Number(e.count) || 0), 0);
  // Gaps are found over every event received, but counted only when the event after the gap
  // falls in the period, so an old gap does not come back every week.
  const bySeq = new Map();
  for (const e of all) {
    if (!e.install || !Number.isSafeInteger(e.seq)) continue;
    const seqs = bySeq.get(e.install) ?? bySeq.set(e.install, new Map()).get(e.install);
    const at = receivedAt(e);
    if (!seqs.has(e.seq) || at < seqs.get(e.seq)) seqs.set(e.seq, at);
  }
  let missing = 0;
  for (const seqs of bySeq.values()) {
    const sorted = [...seqs].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) if (!from || sorted[i][1] >= from) missing += sorted[i][0] - sorted[i - 1][0] - 1;
  }

  const versions = [...new Set([...builds.values()].map((b) => b.version))].sort(byVersion);
  return {
    since: from,
    events: events.length,
    quotes: inPeriod.size,
    newestVersion: versions.at(-1) ?? null,
    builds: [...builds.values()].sort((a, b) => byVersion(b.version, a.version) || b.events - a.events)
      .map((b) => ({ ...b, commits: [...b.commits].sort(), rules: [...b.rules].sort(), quotes: b.quotes.size, agents: [...b.agents].sort() })),
    kpis,
    outcomes,
    funnel: Object.fromEntries([...funnel].map(([c, list]) => [c, { quotes: list.quotes, pages: list.pages.slice(0, 25) }])),
    left: Object.fromEntries([...left].map(([result, s]) => [result, { answers: s.size, top: top(leftQuestions.get(result), n) }])),
    failed: top(failed, n),
    blockers: [...blockers].map(([b, s]) => [b, s.size]).sort((a, b) => b[1] - a[1]).slice(0, n),
    blockedRuns: runs.filter((r) => r.blockers > 0).length,
    runs: runs.length,
    pageChanges: top(changed, n),
    actions: top(actions, 40),
    restricted,
    fillErrors: top(fillErrors, n),
    layoutErrors: top(layoutErrors, n),
    dropped: { fields: top(dropped, n), last: droppedLast },
    ai: [...ai].sort((a, b) => byVersion(b[0], a[0])).map(([b, a]) => ({ build: b, requests: a.requests, errors: top(a.errors, 5), decisions: Object.fromEntries(a.decisions) })),
    problems,
    crashes: top(crashes, n),
    settings: { quotes: lastSettings.size, on: top(settingsOn, 30) },
    agentClicks: [...clicks].map(([k, s2]) => [k, s2.size]).sort((a, b) => b[1] - a[1]).slice(0, n),
    dismissed: [...dismissed].map(([k, s2]) => [k, s2.size]).sort((a, b) => b[1] - a[1]).slice(0, n),
    sources: top(sources, 10),
    platforms: top(platforms, 10),
    lost: { locally: lostLocally, installs: bySeq.size, missingInSeq: missing },
  };
}

const keyCounts = (t) => Object.fromEntries(['cells', 'right', 'wrong', 'missed', 'invented', 'unsure', 'unkeyed'].map((x) => [x, t[x]]));

// The answer key's weekly number: of the keyed answers judged, the share today's rules get right,
// for every keyed answer and for the reviewer's decided ones (a proposal agrees with the rules by
// construction), with how many entries were accepted as proposed.
const keyLine = (a) => {
  const part = (c) => {
    const judged = c.right + c.wrong + c.missed + c.invented;
    return `${judged ? Math.round((c.right / judged) * 100) : '—'}% · ${c.wrong} · ${c.missed} · ${c.invented}`;
  };
  return `| Today's rules against TNI's answer key (${a.quotes} keyed intake${a.quotes === 1 ? '' : 's'}, their quotes of any date): right · wrong · missed · invented (must be 0), all answers / decided by the reviewer; entries accepted as proposed | ${part(a.all)} / ${part(a.decided)}; ${a.proposed} of ${a.entries} |`;
};

// The same as Markdown, for the weekly brief. noTestList: no test-run list was found.
export function markdown(s, { noTestList = false } = {}) {
  const L = [];
  const list = (rows, unit = '') => (rows.length ? rows.map(([k, v]) => `- ${v}${unit} · ${k}`) : ['None.']);
  L.push(`# Weekly signals ${s.since ? `since ${s.since.slice(0, 16).replace('T', ' ')} UTC` : '(all data)'}`, '');
  L.push(`${s.events} events · ${s.quotes} quotes · ${s.runs} fill runs (${s.blockedRuns} ended with something holding Continue). Newest version seen: ${s.newestVersion ?? '?'}.${s.kpis.testRunsLeftOut ? ` ${s.kpis.testRunsLeftOut} test run(s) left out.` : ''}`, '');
  if (noTestList) L.push(`**${NO_TEST_LIST}**`, '');
  const k = s.kpis;
  L.push('## Weekly numbers', '', 'Per quote (a quote re-filled many times counts once). Track these week over week.', '', '| Number | Value |', '| --- | --- |',
    `| Quotes (on any carrier · per carrier) | ${k.quotes} · ${k.carrierQuotes} |`,
    `| Quotes done (reached the carrier's final page or printed) | ${k.donePercent ?? '—'}% |`,
    `| Median minutes for a done quote | ${k.medianMinutesDone ?? '—'} |`,
    `| Answers filled by the rules, per quote | ${k.filledPerQuote ?? '—'} |`,
    `| Autofilled answers the agent corrected, per 100 filled (another value or cleared; reformatted apart: ${k.reformatted}) | ${k.correctedPer100Filled ?? '—'} (${k.corrected}) |`,
    `| Left to the agent per quote: ${Object.keys(k.leftPerQuote).join(' / ') || '—'} | ${Object.values(k.leftPerQuote).join(' / ') || '—'} |`,
    `| Problem reports per 10 quotes (plus ${k.problemReportsInTestRuns} in test runs) | ${k.problemReportsPer10Quotes ?? '—'} |`,
    `| AI requests · error rate | ${k.aiRequests} · ${k.aiErrorPercent ?? '—'}% |`,
    `| Restricted actions by the extension (must be 0) | ${k.restrictedActions} |`,
    ...(k.answerKey ? [keyLine(k.answerKey)] : []), '');
  L.push('## Builds', '', 'Which version and copy logged the period (store: Web Store zip, unpacked: the development package, source: repository files). A problem seen only on older builds may already be fixed.', '');
  L.push('| Version | Channel | Commits | Rule sets | Quotes | Events | Agents | First – last received |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const b of s.builds) L.push(`| ${b.version} | ${b.channel} | ${b.commits.join(', ') || '—'} | ${b.rules.join(', ') || '—'} | ${b.quotes} | ${b.events} | ${b.agents.join(', ') || '—'} | ${b.first.slice(0, 10)} – ${b.last.slice(0, 10)} |`);
  L.push('', '## How far quotes got', '', 'Quotes of the period that reached each page, in the order quotes usually reach them. A page few quotes reach late in the flow is where quotes stopped (finished elsewhere, or abandoned).', '');
  for (const [carrier, f] of Object.entries(s.funnel)) {
    L.push(`**${carrier}** (${f.quotes} quotes)`, '', '| Page | Quotes |', '| --- | --- |', ...f.pages.map((p) => `| ${p.page} | ${p.quotes} |`), '');
  }
  L.push('## How quotes ended', '', 'Per carrier a quote went to: done (its final page or Progressive\'s Print/Send, after the quote\'s own fill), declined by the carrier, or stopped at its last page (finished elsewhere, abandoned, or still open). A login in the middle means the carrier\'s session ran out.', '');
  for (const [carrier, o] of Object.entries(s.outcomes)) {
    L.push(`**${carrier}**: ${o.quotes} quotes · ${o.done} done (median ${o.medianMinutesDone ?? '—'} min) · ${o.declined} declined · ${o.loginInterrupted} interrupted by a login`, '', ...(o.stopped.length ? o.stopped.map(([p, c]) => `- stopped at ${p}: ${c}`) : []), '');
  }
  L.push('## Left to the agent', '', 'Each question counted once per quote, page and unit. unfamiliar: no rule; leftRequired: required and unanswered; noData: the intake has no answer; failed: the fill could not set it.', '');
  for (const [result, x] of Object.entries(s.left)) L.push(`**${result}**: ${x.answers}`, '', ...list(x.top), '');
  L.push('## Fill failures by reason', '', ...list(s.failed), '');
  L.push('## What held Continue', '', `Blockers at the end of fill runs, by the number of quotes they held.`, '', ...list(s.blockers, ' quotes'), '');
  L.push('## Restricted actions by the extension', '', s.restricted.length ? '**Safety finding: the extension clicked something that reads as a restricted action.**' : 'None: every click the extension made was a helper or a continuation.', ...(s.restricted.length ? list(s.restricted, ' runs') : []), '', `Its clicks: ${s.actions.map(([a, c]) => `${a} ×${c}`).join(', ') || 'none'}.`, '');
  L.push('## Signs a carrier changed a page', '', ...list(s.pageChanges, ' runs'), '');
  L.push('## Panel crashes', '', 'Errors nothing in the panel caught (client_error), by build; test runs included. Each one is a finding.', '', ...list(s.crashes), '');
  L.push('## Settings in force', '', `The last agent_settings of each quote (${s.settings.quotes} quotes reported one).`, '', ...list(s.settings.on, ' quotes'), '');
  L.push('## Buttons agents clicked themselves', '', 'By the number of quotes: a helper the extension has (Recalculate, Print, Lookup VIN) clicked by hand is one it didn\'t do.', '', ...list(s.agentClicks, ' quotes'), '');
  L.push('## Checks agents dismissed', '', 'Needs-you items waved through with ×, by the number of quotes.', '', ...list(s.dismissed, ' quotes'), '');
  L.push('## Where filled answers came from', '', ...list(s.sources), '');
  L.push('## Platforms', '', ...list(s.platforms, ' quotes'), '');
  L.push('## Events lost on the way', '', `${s.lost.locally} dropped by full logs on agents' computers (usage_lost); ${s.lost.missingInSeq} missing from the numbering of ${s.lost.installs} install(s) (events never received, or not yet).`, '');
  L.push('## Fill errors', '', ...list(s.fillErrors), '', '## Layout errors', '', ...list(s.layoutErrors), '');
  L.push('## Fields the usage server dropped', '', s.dropped.fields.length ? `Last on ${s.dropped.last?.slice(0, 16).replace('T', ' ')} UTC (a server older than the extension; see docs/hosting.md).` : '', ...list(s.dropped.fields), '');
  L.push('## AI assistant by build', '');
  if (!s.ai.length) L.push('No AI activity.', '');
  for (const a of s.ai) L.push(`- ${a.build}: ${a.requests} requests, ${a.errors.reduce((n, [, c]) => n + c, 0)} errors${a.errors.length ? ` (${a.errors.map(([m, c]) => `${c}× ${m}`).join('; ')})` : ''}; decisions ${Object.entries(a.decisions).map(([d, c]) => `${d} ${c}`).join(', ') || 'none'}`);
  L.push('', '## Problem reports', '', 'With the build that logged each and the fill around it (same quote, 5 minutes either side). Check the build against the fixes made since before treating one as open.', '');
  if (!s.problems.length) L.push('None.');
  s.problems.forEach((p, i) => {
    L.push(`${i + 1}. ${p.t.slice(0, 16).replace('T', ' ')}${p.test ? ' · test run' : ''}${p.view ? ` · ${p.view}` : ''} · ${p.agent ?? '?'} · ${p.version ?? '?'} ${p.channel ?? ''}${p.commit ? ` ${p.commit}` : ''} · ${p.carrier ?? '?'} ${p.page ?? '?'}`);
    L.push(`   > ${p.text.replace(/\n+/g, '\n   > ')}`);
    const run = p.lastRun ? `last fill here: ${p.lastRun.filled ?? '?'} filled, ${p.lastRun.unknown ?? '?'} unfamiliar, ${p.lastRun.advanced ? 'continued' : 'did not continue'}${p.lastRun.blockers.length ? `; held by ${p.lastRun.blockers.slice(0, 4).join('; ')}` : ''}` : 'no fill on this page just before';
    L.push(`   Around it: ${p.fillRuns} fill runs; ${run}${p.fillErrors.length ? `; fill errors: ${p.fillErrors.join('; ')}` : ''}.`);
  });
  L.push('');
  return L.join('\n');
}
