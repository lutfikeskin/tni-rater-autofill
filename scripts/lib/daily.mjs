// The daily review's window and its issue (.github/workflows/daily-review.yml, or npm run daily on
// the maintainer's computer: scripts/daily.mjs): what arrived since the last run, which questions
// without a rule are new, and whether to say anything.

import fs from 'node:fs';
import { buildLayouts } from './layouts.mjs';
import { coverage, idsInHtml } from './coverage.mjs';
import { CARRIERS } from '../../src/carriers.js';

// When the server received an event (events exported from a panel have no receipt: when logged).
// A review of what arrived since the last one misses nothing uploaded late.
export const receivedAt = (e) => e.receivedAt ?? e.t ?? '';

// The run a review continues from: the last successful one on the default branch (`gh run list`).
export const lastSuccess = (runs) => [...(runs ?? [])].filter((r) => r.conclusion === 'success').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1) ?? null;

// Where a review starts: when that run began downloading the log (its steps, `gh run view --json
// jobs`), as its download has every event received before then; a run can wait hours between being
// created and running (Codex on PR #52). Without its steps, when it started; without a run, a day
// ago. An event received while it downloaded shows twice at worst, never not at all.
export const DOWNLOAD_STEP = 'Download the usage log';
export function windowStart(run, steps = [], now = new Date()) {
  if (!run) return new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  return steps.find((s) => s.name === DOWNLOAD_STEP)?.startedAt ?? run.startedAt ?? run.createdAt;
}

// One question of a carrier page, whatever its number, row, product or step: its data-model name,
// else its element id or data-id (AmWINS), else its kind and text. A one-address application's step
// (`page › step`) isn't part of it: layouts before 0.9.6 named none, and a step heading can carry
// counts ("My Incomplete Submissions 3"). Rows recorded before names that are named after a vehicle
// ("2016 FREIGHTLINER CASCADIA 125") don't say which question they are: one per page and kind.
const VEHICLE = /^(19|20)\d{2}\s+\S/;
const text = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export function questionId(carrier, page, f) {
  const base = String(page).split(' › ')[0];
  if (f.ref) return `${carrier}|${base}|ref:${f.ref}`;
  if (f.id) return `${carrier}|${base}|#${f.id}`;
  if (f.dataId) return `${carrier}|${base}|data:${f.dataId}`;
  return `${carrier}|${base}|${f.kind ?? ''}:${VEHICLE.test(text(f.caption)) ? '<vehicle row>' : text(f.caption)}`;
}

// The AmWINS mock's ids: a live field the mock lacks is drift, alerted on like a question without a
// rule, as the coverage report does.
const MOCK = new URL('../../test/fixtures/amwins/application.html', import.meta.url);
let mockIds;
const mockFor = (carrier) => (carrier === 'amwins' ? (mockIds ??= fs.existsSync(MOCK) ? idsInHtml(MOCK) : null) : null);

// Questions met on live pages: every one, and the ones no rule claims or the mock lacks
// (coverage.mjs), by questionId.
function questions(events) {
  const seen = new Set();
  const uncovered = new Map();
  for (const { layout } of buildLayouts(events)) {
    // As the coverage report: not the test carrier's pages.
    const carrier = CARRIERS.find((c) => c.id === layout.carrier && c.id !== 'test');
    if (!carrier) continue;
    for (const p of coverage(layout, carrier, { mockIds: mockFor(carrier.id) }).pages) {
      for (const r of p.rows) {
        const id = questionId(layout.carrier, p.page, r);
        // By its text too: a question recorded before names (or ids) is the same one once they show.
        const byText = questionId(layout.carrier, p.page, { kind: r.kind, caption: r.caption });
        seen.add(id).add(byText);
        if ((r.status === 'none' || r.notInMock) && !uncovered.has(id)) {
          uncovered.set(id, { id, byText, carrier: layout.carrier, page: p.page, caption: r.caption ?? '', ref: r.ref ?? null, kind: r.kind ?? null, ...(r.status === 'none' ? {} : { notInMock: true }) });
        }
      }
    }
  }
  // A question recorded by its text in one product and by its name or id in another is one.
  for (const q of [...uncovered.values()].filter((x) => x.id !== x.byText)) uncovered.delete(q.byText);
  return { seen, uncovered };
}

// Questions without a rule: how many different ones, and which first showed in a layout received
// since `since` (never in one before, in any state or product).
export function uncoveredQuestions(events, since) {
  const now = questions(events);
  const before = since ? questions(events.filter((e) => receivedAt(e) < since)).seen : new Set();
  const known = (q) => before.has(q.id) || before.has(q.byText);
  return { total: now.uncovered.size, new: [...now.uncovered.values()].filter((q) => !known(q)).map(({ id, byText, ...q }) => q) };
}

// No event received for two days: a week without quotes and uploads that broke look the same in a
// review that says nothing (2026-10-11 to 10-18: no events, and no comment). Said once a quiet
// stretch, by the run whose window holds the moment it reached two days: the run before ended
// earlier, the next starts later; a run after days off says it too. `lastReceived`: the newest
// receipt in the whole log, test runs left out (lastReceipts, review.mjs --summary), null when it has none (said by every run:
// an empty or replaced server, not a quiet stretch), absent when not known (no heartbeat). `until`:
// where the window ends, when its download began (else now).
export const QUIET_HOURS = 48;

// The newest receipt in the log (`lastReceived`, null when none) and each install's, with its
// agent. Test runs (`tests`: their sessions, testSessionsOf) are left out: the maintainer's own
// uploads would restart the two days while agents' uploads had stopped.
export function lastReceipts(events, tests = new Set()) {
  let last = '';
  const byInstall = {};
  for (const e of events) {
    if (tests.has(e.session)) continue;
    const r = receivedAt(e);
    if (r > last) last = r;
    if (e.install && r > (byInstall[e.install]?.last ?? '')) byInstall[e.install] = { agent: e.agent ?? null, last: r };
  }
  return { lastReceived: last || null, lastReceivedByInstall: byInstall };
}
export function quietStretch({ lastReceived, since = null, until = null }, now = new Date()) {
  if (lastReceived === undefined) return null;
  const end = Date.parse(until ?? '') || now.getTime();
  if (lastReceived === null) return { last: null, days: null };
  const mark = Date.parse(lastReceived) + QUIET_HOURS * 3600 * 1000;
  if (!(mark <= end)) return null;
  const start = Date.parse(since ?? '');
  if (Number.isFinite(start) && mark <= start) return null;
  return { last: lastReceived, days: Math.floor((end - Date.parse(lastReceived)) / (24 * 3600 * 1000)) };
}

// What the run says on its issue: nothing when nothing is new and the server is the repository's;
// else a comment on the open daily-review issue, or a new one when none is open.
export function decide(facts, openIssues = [], now = new Date()) {
  const { problems = [], newQuestions = [], server = 'same', failed = false } = facts;
  const something = failed || problems.length > 0 || newQuestions.length > 0 || !['same', 'skipped'].includes(server) || quietStretch(facts, now) != null;
  if (!something) return { kind: 'none' };
  const open = [...openIssues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  return open ? { kind: 'comment', number: open.number } : { kind: 'create', title: 'Daily review' };
}

// The comment: only what is new, with where the whole review is: the run (its summary and artifact)
// on GitHub, the review file on the computer that ran `npm run daily` (scripts/daily.mjs).
export function commentBody(facts, today = new Date().toISOString().slice(0, 10)) {
  const { since, problems = [], newQuestions = [], uncoveredTotal = null, server = 'same', serverNote = '', failed = false, runUrl = '', review = '', log = '', failedStep = '' } = facts;
  const lines = [];
  if (failed) {
    lines.push(`## ${today}: the daily review could not run`, '', runUrl ? `See the run: ${runUrl}` : `It stopped${failedStep ? ` at the ${failedStep}` : ''}${log ? `: its log is \`${log}\` on the computer that ran it` : ''}.`, '');
    if (serverNote) lines.push(serverNote, '');
    return lines.join('\n');
  }
  const quiet = quietStretch(facts);
  // A skipped check says why (a run off the default branch): "skipped" alone reads like a failure.
  const serverSays = server === 'skipped' ? `not checked (${serverNote || 'skipped'})` : server;
  const lastDay = quiet?.last ? quiet.last.slice(0, 10) : null;
  lines.push(`## ${today}: ${problems.length} new problem report(s), ${newQuestions.length} new question(s) without a rule, usage server ${serverSays}${quiet ? `, ${lastDay ? `no events since ${lastDay}` : 'no events at all'}` : ''}`, '');
  lines.push(`Events received since ${since}. ${runUrl ? `The whole review is in the run summary and its artifact: ${runUrl}` : `The whole review is \`${review}\` on the computer that ran it.`}`, '');
  if (quiet) {
    lines.push(lastDay
      ? `**No events received for ${quiet.days} day(s):** the last arrived ${quiet.last.slice(0, 16).replace('T', ' ')} UTC. Either no agent ran a quote, or uploads stopped (the extension, its upload token, or the usage server). Said once until events arrive again.`
      : '**The usage log has no events at all:** the server is new or was emptied, or the download read another one.', '');
  }
  if (server !== 'same' && server !== 'skipped' && serverNote) lines.push(`**Usage server:** ${serverNote}`, '');
  if (problems.length) {
    lines.push('### Problem reports', '');
    // With the build that logged it (a report from a build older than a fix may already be done).
    for (const p of problems.slice(0, MAX_PROBLEMS)) lines.push(`- ${String(p.t ?? '').slice(0, 16).replace('T', ' ')} · ${p.agent ?? '?'}${p.build ? ` · ${p.build}` : ''}${p.test ? ' · test run' : ''} · ${p.page ?? '?'}: ${String(p.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 500)}`);
    if (problems.length > MAX_PROBLEMS) lines.push(`- … and ${problems.length - MAX_PROBLEMS} more (in the review)`);
    lines.push('');
  }
  if (newQuestions.length) {
    lines.push(`### New questions without a rule${uncoveredTotal != null ? ` (${uncoveredTotal} different ones in all)` : ''}`, '');
    for (const q of newQuestions.slice(0, 50)) lines.push(`- ${q.carrier} ${q.page}: ${q.ref ? `\`${q.ref}\` ` : ''}"${q.caption}"${q.kind ? ` (${q.kind})` : ''}${q.notInMock ? ' (has a rule; not in the AmWINS mock)' : ''}`);
    if (newQuestions.length > 50) lines.push(`- … and ${newQuestions.length - 50} more (in the review)`);
    lines.push('');
  }
  // GitHub refuses a comment over 65,536 characters: a window with many reports says the rest is in
  // the review rather than failing to say anything (Codex on PR #52).
  const body = lines.join('\n');
  return body.length <= MAX_COMMENT ? body : `${body.slice(0, MAX_COMMENT)}\n\n… (cut here: the whole list is in the review: ${runUrl || review})`;
}
const MAX_PROBLEMS = 60;
const MAX_COMMENT = 60_000;
