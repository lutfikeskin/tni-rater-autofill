// The daily review's window and its issue (.github/workflows/daily-review.yml): what arrived since
// the last run, which questions without a rule are new, and whether to say anything.

import { buildLayouts } from './layouts.mjs';
import { coverage } from './coverage.mjs';
import { CARRIERS } from '../../src/carriers.js';

// When the server received an event (events exported from a panel have no receipt: when logged).
// A review of what arrived since the last one misses nothing uploaded late.
export const receivedAt = (e) => e.receivedAt ?? e.t ?? '';

// Where a review starts: the last successful run on the default branch (`gh run list` rows), else
// a day ago. Its events were downloaded after it started, so one received meanwhile shows twice at
// worst, never not at all.
export function windowStart(runs, now = new Date()) {
  const last = (runs ?? []).filter((r) => r.conclusion === 'success' && r.createdAt).map((r) => r.createdAt).sort().at(-1);
  return last ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
}

// One question of a carrier page, whatever its number, row or product: its data-model name, else
// its kind and text. Rows recorded before names that are named after a vehicle ("2016 FREIGHTLINER
// CASCADIA 125") don't say which question they are: one per page and kind.
const VEHICLE = /^(19|20)\d{2}\s+\S/;
const text = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export function questionId(carrier, page, f) {
  if (f.ref) return `${carrier}|${page}|ref:${f.ref}`;
  return `${carrier}|${page}|${f.kind ?? ''}:${VEHICLE.test(text(f.caption)) ? '<vehicle row>' : text(f.caption)}`;
}

// Questions met on live pages: every one, and the ones no rule claims (coverage.mjs), by questionId.
function questions(events) {
  const seen = new Set();
  const uncovered = new Map();
  for (const { layout } of buildLayouts(events)) {
    // As the coverage report: not the test carrier's pages.
    const carrier = CARRIERS.find((c) => c.id === layout.carrier && c.id !== 'test');
    if (!carrier) continue;
    for (const p of coverage(layout, carrier).pages) {
      for (const r of p.rows) {
        const id = questionId(layout.carrier, p.page, r);
        // By its text too: a question recorded before names is the same one once its name shows.
        seen.add(id).add(questionId(layout.carrier, p.page, { ...r, ref: null }));
        if (r.status === 'none' && !uncovered.has(id)) uncovered.set(id, { carrier: layout.carrier, page: p.page, caption: r.caption ?? '', ref: r.ref ?? null, kind: r.kind ?? null });
      }
    }
  }
  // A question recorded by its text in one product and by its name in another is one.
  for (const q of [...uncovered.values()].filter((x) => x.ref)) uncovered.delete(questionId(q.carrier, q.page, { ...q, ref: null }));
  return { seen, uncovered };
}

// Questions without a rule: how many different ones, and which first showed in a layout received
// since `since` (never in one before, in any state or product).
export function uncoveredQuestions(events, since) {
  const now = questions(events);
  const before = since ? questions(events.filter((e) => receivedAt(e) < since)).seen : new Set();
  const known = (q) => before.has(questionId(q.carrier, q.page, q)) || before.has(questionId(q.carrier, q.page, { ...q, ref: null }));
  return { total: now.uncovered.size, new: [...now.uncovered.values()].filter((q) => !known(q)) };
}

// What the run says on its issue: nothing when nothing is new and the server is the repository's;
// else a comment on the open daily-review issue, or a new one when none is open.
export function decide({ problems = [], newQuestions = [], server = 'same', failed = false }, openIssues = []) {
  const something = failed || problems.length > 0 || newQuestions.length > 0 || !['same', 'skipped'].includes(server);
  if (!something) return { kind: 'none' };
  const open = [...openIssues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  return open ? { kind: 'comment', number: open.number } : { kind: 'create', title: 'Daily review' };
}

// The comment: only what is new, with links to the run (its summary has the whole review).
export function commentBody({ since, problems = [], newQuestions = [], uncoveredTotal = null, server = 'same', serverNote = '', failed = false, runUrl = '' }, today = new Date().toISOString().slice(0, 10)) {
  const lines = [];
  if (failed) {
    lines.push(`## ${today}: the daily review could not run`, '', `See the run: ${runUrl}`, '');
    if (serverNote) lines.push(serverNote, '');
    return lines.join('\n');
  }
  lines.push(`## ${today}: ${problems.length} new problem report(s), ${newQuestions.length} new question(s) without a rule, usage server ${server}`, '');
  lines.push(`Events received since ${since}. The whole review is in the run summary and its artifact: ${runUrl}`, '');
  if (server !== 'same' && server !== 'skipped' && serverNote) lines.push(`**Usage server:** ${serverNote}`, '');
  if (problems.length) {
    lines.push('### Problem reports', '');
    for (const p of problems) lines.push(`- ${String(p.t ?? '').slice(0, 16).replace('T', ' ')} · ${p.agent ?? '?'} · ${p.page ?? '?'}: ${String(p.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 500)}`);
    lines.push('');
  }
  if (newQuestions.length) {
    lines.push(`### New questions without a rule${uncoveredTotal != null ? ` (${uncoveredTotal} different ones in all)` : ''}`, '');
    for (const q of newQuestions.slice(0, 50)) lines.push(`- ${q.carrier} ${q.page}: ${q.ref ? `\`${q.ref}\` ` : ''}"${q.caption}"${q.kind ? ` (${q.kind})` : ''}`);
    if (newQuestions.length > 50) lines.push(`- … and ${newQuestions.length - 50} more (in the review)`);
    lines.push('');
  }
  return lines.join('\n');
}
