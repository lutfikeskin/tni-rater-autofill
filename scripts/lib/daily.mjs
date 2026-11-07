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

// Alerts: what in the period's events needs the maintainer before the weekly review (audit
// 2026-11-07, LEARN-16), said in a section of the daily comment (the maintainer, 2026-11-07: no
// webhook). Test runs are left out (review.mjs passes the agents' events only). The thresholds are
// proposed, for the maintainer to tune:
export const ALERTS = {
  // A carrier page that reads as changed (a fill_run's pageChanged, or a known question renamed) on
  // at least this many installs: one agent's odd quote is noise, two agents' a redesign.
  pageChangeInstalls: 2,
  // The newest build in the period failing more fields per 100 filled than the build before it, by
  // at least this many points, with at least minFilled fields filled on each.
  failedRiseBy: 3,
  minFilled: 200,
  // The share of the period's sessions with a crash (client_error), with at least minSessions.
  crashShare: 0.02,
  minSessions: 20,
  // Events the panels lost before uploading them (usage_lost), in all.
  lostEvents: 50,
};

// The alerts in `events` (the period's, test runs left out), each { kind, ... } as commentBody says it.
export function alerts(events, limits = ALERTS) {
  const out = [];
  // fill_run events of a fill (not a stop page's, which fills nothing).
  const runs = events.filter((e) => e.type === 'fill_run' && e.auto !== 'stop');
  const changed = new Map();
  for (const e of runs) {
    if (!(e.pageChanged === true || (Array.isArray(e.renamed) && e.renamed.length > 0))) continue;
    const key = JSON.stringify([e.carrier ?? null, e.page ?? null]);
    const c = changed.get(key) ?? { kind: 'page-changed', carrier: e.carrier ?? null, page: e.page ?? null, installs: new Set(), runs: 0 };
    if (e.install) c.installs.add(e.install);
    c.runs++;
    changed.set(key, c);
  }
  for (const c of changed.values()) if (c.installs.size >= limits.pageChangeInstalls) out.push({ ...c, installs: c.installs.size });
  // Builds by version (then by when first seen): the newest against the one before it.
  const builds = new Map();
  for (const e of runs) {
    const build = `${e.v ?? '?'}${e.channel ? ` ${e.channel}` : ''}${e.commit ? ` ${e.commit}` : ''}`;
    const b = builds.get(build) ?? { build, v: String(e.v ?? ''), first: e.t ?? '', filled: 0, failed: 0 };
    b.filled += Number(e.filled) || 0;
    b.failed += Number(e.failed) || 0;
    if ((e.t ?? '') < b.first) b.first = e.t;
    builds.set(build, b);
  }
  const version = (v) => v.split('.').map((n) => Number(n) || 0);
  const newer = (a, b) => { const x = version(a.v), y = version(b.v); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return a.first.localeCompare(b.first); };
  const [latest, before] = [...builds.values()].filter((b) => b.filled >= limits.minFilled).sort((a, b) => newer(b, a));
  if (latest && before) {
    const rate = (b) => Math.round((b.failed / b.filled) * 1000) / 10;
    if (rate(latest) - rate(before) >= limits.failedRiseBy) out.push({ kind: 'failed-rise', build: latest.build, rate: rate(latest), before: before.build, beforeRate: rate(before) });
  }
  const sessions = new Set(events.map((e) => e.session).filter(Boolean));
  const crashed = new Set(events.filter((e) => e.type === 'client_error').map((e) => e.session).filter(Boolean));
  if (sessions.size >= limits.minSessions && crashed.size / sessions.size >= limits.crashShare) out.push({ kind: 'crashes', crashed: crashed.size, sessions: sessions.size });
  const lost = events.filter((e) => e.type === 'usage_lost').reduce((n, e) => n + (Number(e.count) || 0), 0);
  if (lost >= limits.lostEvents) out.push({ kind: 'lost', count: lost });
  return out;
}

// What the run says on its issue: nothing when nothing is new and the server is the repository's;
// else a comment on the open daily-review issue, or a new one when none is open.
export function decide(facts, openIssues = [], now = new Date()) {
  const { problems = [], newQuestions = [], alerts: raised = [], server = 'same', failed = false } = facts;
  const something = failed || problems.length > 0 || newQuestions.length > 0 || raised.length > 0 || !['same', 'skipped'].includes(server) || quietStretch(facts, now) != null;
  if (!something) return { kind: 'none' };
  const open = [...openIssues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  return open ? { kind: 'comment', number: open.number } : { kind: 'create', title: 'Daily review' };
}

// The comment: only what is new, with where the whole review is: the review file on the computer
// that ran `npm run daily` (scripts/daily.mjs), and the usage server's dashboard. The repository is
// public, so a problem report's own text (an agent's free text: client names, VINs, phones) is never
// in the comment: only when, who, which build and which page (audit 2026-11-07, SRV-02/ORG-01).
export function commentBody(facts, today = new Date().toISOString().slice(0, 10)) {
  const { since, problems = [], newQuestions = [], alerts: raised = [], uncoveredTotal = null, server = 'same', serverNote = '', failed = false, runUrl = '', review = '', log = '', failedStep = '' } = facts;
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
  lines.push(`## ${today}: ${raised.length ? `${raised.length} alert(s), ` : ''}${problems.length} new problem report(s), ${newQuestions.length} new question(s) without a rule, usage server ${serverSays}${quiet ? `, ${lastDay ? `no events since ${lastDay}` : 'no events at all'}` : ''}`, '');
  lines.push(`Events received since ${since}. ${runUrl ? `The run: ${runUrl}.` : `The whole review is \`${review}\` on the computer that ran it.`}${problems.length ? ` Problem reports' texts are not posted here (this repository is public): read them on the usage server's dashboard (with "Include test runs" for one marked test run), or rebuild this review on your computer with ${rebuild(since)}.` : ''}`, '');
  if (quiet) {
    lines.push(lastDay
      ? `**No events received for ${quiet.days} day(s):** the last arrived ${quiet.last.slice(0, 16).replace('T', ' ')} UTC. Either no agent ran a quote, or uploads stopped (the extension, its upload token, or the usage server). Said once until events arrive again.`
      : '**The usage log has no events at all:** the server is new or was emptied, or the download read another one.', '');
  }
  if (server !== 'same' && server !== 'skipped' && serverNote) lines.push(`**Usage server:** ${serverNote}`, '');
  // Alerts first (alerts()): a carrier's text in them is posted as the rest of the log's text is.
  if (raised.length) {
    lines.push('### Alerts', '');
    for (const a of raised) lines.push(`- ${alertLine(a)}`);
    lines.push('', 'Thresholds: `ALERTS` in scripts/lib/daily.mjs.', '');
  }
  if (problems.length) {
    lines.push('### Problem reports', '');
    // With the build that logged it (a report from a build older than a fix may already be done).
    for (const p of problems.slice(0, MAX_PROBLEMS)) lines.push(`- ${minute(p.t)} · ${untrusted(p.agent, 12)}${p.build ? ` · ${untrusted(p.build, 40)}` : ''}${p.test ? ' · test run' : ''} · ${untrusted(p.page)}`);
    if (problems.length > MAX_PROBLEMS) lines.push(`- … and ${problems.length - MAX_PROBLEMS} more (in the review)`);
    lines.push('');
  }
  if (newQuestions.length) {
    lines.push(`### New questions without a rule${uncoveredTotal != null ? ` (${uncoveredTotal} different ones in all)` : ''}`, '');
    for (const q of newQuestions.slice(0, 50)) lines.push(`- ${untrusted(q.carrier, 20)} ${untrusted(q.page)}: ${q.ref ? `${untrusted(q.ref)} ` : ''}${untrusted(q.caption, 200)}${q.kind ? ` (${untrusted(q.kind, 40)})` : ''}${q.notInMock ? ' (has a rule; not in the AmWINS mock)' : ''}`);
    if (newQuestions.length > 50) lines.push(`- … and ${newQuestions.length - 50} more (in the review)`);
    lines.push('');
  }
  // GitHub refuses a comment over 65,536 characters: a window with many reports says the rest is in
  // the review rather than failing to say anything (Codex on PR #52).
  const body = lines.join('\n');
  return body.length <= MAX_COMMENT ? body : `${body.slice(0, MAX_COMMENT)}\n\n… (cut here: the whole list is in the review: ${runUrl ? `rebuild it with ${rebuild(since)}` : review})`;
}
// One alert, as the comment says it: numbers as numbers, every text from the log through untrusted.
function alertLine(a) {
  if (a.kind === 'page-changed') return `${untrusted(a.carrier, 20)} ${untrusted(a.page)} reads as changed for ${a.installs} installs (${a.runs} fills): the carrier may have redesigned it. Check its layout before agents meet it all day.`;
  if (a.kind === 'failed-rise') return `Build ${untrusted(a.build, 40)} failed ${a.rate} fields per 100 filled, up from ${a.beforeRate} on ${untrusted(a.before, 40)}.`;
  if (a.kind === 'crashes') return `${a.crashed} of ${a.sessions} sessions (${Math.round((a.crashed / a.sessions) * 1000) / 10}%) had a crash (client_error).`;
  if (a.kind === 'lost') return `${a.count} events were lost before upload (usage_lost).`;
  return untrusted(a.kind, 40);
}
// The run keeps no review (the repository is public): the command that rebuilds this window's on the
// maintainer's computer, a dry run that posts nothing (scripts/daily.mjs).
const rebuild = (since) => `\`npm run daily -- --since ${since}\` (a dry run: it posts nothing)`;
const MAX_PROBLEMS = 60;
// Text from the usage log, which anyone with the extension's upload token can write (audit
// 2026-11-07, SRV-04): an agent's initials, a page, a carrier, a question's caption and data-model
// name. Posted as an inline code span (no markdown, link or image), with its backticks and line
// breaks taken out, every @ broken by a zero-width space (no one is mentioned, and the comment never
// holds the at-mention that starts the Claude workflow when the maintainer's own login posts it),
// and bounded. A build and a question's kind are posted the same way.
export function untrusted(v, max = 120) {
  const s = String(v ?? '').replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, max).replace(/@/g, '@​');
  return `\`${s || '?'}\``;
}
// An event's time to the minute, written only when it is one (digits, a dash and a colon can't
// make a link or a mention) on the calendar and the clock; anything else is `?`.
const minute = (t) => {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(String(t ?? ''));
  const ms = m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : NaN;
  const real = m && !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(`${m[1]}T${m[2]}`);
  return real ? `${m[1]} ${m[2]}` : '?';
};
const MAX_COMMENT = 60_000;
