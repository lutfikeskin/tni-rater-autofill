#!/usr/bin/env node
// One weekly review instead of three commands: usage summary, rule suggestions, page layouts,
// plus what the AI assistant did and the agents' problem reports, in one Markdown file.
//
//   npm run review                              # server-data, since the last review
//   node scripts/review.mjs server-data [more logs...] [--since 2026-10-01[T06:00]] [--all] [--out file.md] [--summary file.json]
//
// "Since" defaults to the date of the newest file in reviews/, so each review shows what's new. It
// is when the server received the events (when logged, for exported ones): one uploaded a day late
// is in the next review, not lost between two. --summary writes what's new (problem reports,
// questions without a rule) for the daily review's issue (scripts/daily-issue.mjs).
// Rule suggestions and layouts always use all the data (they need many quotes).
// Reports go to reviews/review-<date>.md (git-ignored, like generated layouts: review first).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEvents, quoteSessions } from './lib/events.mjs';
import { loadLayouts, report as coverageReport } from './coverage.mjs';
import { receivedAt, uncoveredQuestions } from './lib/daily.mjs';
import { questionOf } from './lib/learn.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const valued = new Set(['--since', '--out', '--summary']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
for (const p of inputs) {
  if (!fs.existsSync(p)) { console.error(`No usage data at ${p}. Start the server (npm run server) or pass exported logs.`); process.exit(1); }
}

const today = new Date().toISOString().slice(0, 10);
const reviewsDir = path.join(root, 'reviews');
const previous = fs.existsSync(reviewsDir)
  ? fs.readdirSync(reviewsDir).map((f) => f.match(/^review-(\d{4}-\d{2}-\d{2})\.md$/)?.[1]).filter((d) => d && d < today).sort().at(-1)
  : null;
const since = args.includes('--all') ? null : opt('since') ?? previous ?? null;
const out = opt('out') ?? path.join(reviewsDir, `review-${today}.md`);

const all = loadEvents(inputs);
// Compared as full ISO times: gh's run times have no milliseconds, the server's receipts do.
const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : since;
const recent = from ? all.filter((e) => receivedAt(e) >= from) : all;

// The existing review scripts, on the period's events (summary) or all events (learn, layouts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-review-'));
const recentFile = path.join(tmp, 'recent.jsonl');
fs.writeFileSync(recentFile, recent.map((e) => JSON.stringify(e)).join('\n') + '\n');
const run = (script, scriptArgs) => {
  try {
    return execFileSync(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // A script that reports a problem through its exit code (captures.mjs: a file not read) still
    // printed its result.
    if (String(e.stdout ?? '').trim()) return `${String(e.stdout).trim()} (exit ${e.status})`;
    return `(${script} failed: ${String(e.stderr || e.message).trim().split('\n')[0]})`;
  }
};
const summary = recent.length ? run('summarize-usage.mjs', [recentFile]) : '(no events in this period)';
const learn = run('learn-rules.mjs', inputs).replace(/^# /m, '### ');
const layouts = run('build-layouts.mjs', inputs);
const transitions = run('transitions.mjs', inputs);
// Manual captures kept in layouts/ (developer captures; not in the usage log).
const captures = fs.existsSync(path.join(root, 'layouts')) ? run('captures.mjs', [path.join(root, 'layouts')]) : '(no layouts/ folder)';
fs.rmSync(tmp, { recursive: true, force: true });

// --- Numbers for the top of the report ------------------------------------------------------
// Quotes: intakes loaded in this period that went to a carrier's page (whenever they did).
const quoting = quoteSessions(all);
const quotes = new Set(recent.filter((e) => e.type === 'intake_loaded' && quoting.has(e.session)).map((e) => e.session));
const agents = [...new Set(recent.map((e) => e.agent).filter(Boolean))];
const states = count(recent.filter((e) => e.type === 'intake_loaded' && quoting.has(e.session)).map((e) => e.state ?? '?'));
const fills = recent.filter((e) => e.type === 'fill_run');
const sum = (list, k) => list.reduce((n, e) => n + (Number(e[k]) || 0), 0);
const filled = sum(fills, 'filled');
const leftover = sum(fills, 'unknown') + sum(fills, 'failed') + sum(fills, 'noData') + sum(fills, 'leftRequired');
const corrections = recent.filter((e) => e.type === 'field_change' && e.by === 'agent' && e.autofilled).length;

// --- AI assistant -----------------------------------------------------------------------------
const asks = recent.filter((e) => e.type === 'ai_suggest');
const decisions = recent.filter((e) => e.type === 'ai_decision');
// One row per question, whatever its number (Progressive renumbered them on 2026-10-07), named
// by its page and text.
const questionKey = questionOf(all);
const byQuestion = new Map();
for (const d of decisions) {
  const key = questionKey(d);
  const row = byQuestion.get(key) ?? { name: `${d.page ?? '?'} "${d.label ?? ''}"`, accepted: 0, dismissed: 0, auto: 0, approved: 0, rejected: 0, failed: 0, choices: new Map() };
  row[d.decision] = (row[d.decision] ?? 0) + 1;
  if (d.choice && d.decision !== 'dismissed' && d.decision !== 'rejected') row.choices.set(d.choice, (row.choices.get(d.choice) ?? 0) + 1);
  byQuestion.set(key, row);
}
const aiRows = [...byQuestion.entries()]
  .map(([key, r]) => ({ key, ...r, yes: r.accepted + r.approved, no: r.dismissed + r.rejected }))
  .sort((a, b) => (b.yes + b.no) - (a.yes + a.no));

const problems = recent.filter((e) => e.type === 'problem_report');
// Questions without a rule: different ones (a question per page, whatever its number, row or
// product), and the ones first seen in this period.
const uncovered = uncoveredQuestions(all, from);

// --- Report -----------------------------------------------------------------------------------
const lines = [];
const p = (...x) => lines.push(...x);
p(`# Rater Autofill review ${today}`, '');
p(`Period: ${since ? `since ${since}` : 'all data'} · ${recent.length} events (${all.length} in total) · ${quotes.size} quotes · agents: ${agents.join(', ') || '—'}`, '');
p('## At a glance', '');
p('| | |', '| --- | --- |');
p(`| Quotes started | ${quotes.size}${Object.keys(states).length ? ` (${Object.entries(states).map(([s, n]) => `${s} ${n}`).join(', ')})` : ''} |`);
p(`| Fields filled by the rules | ${filled} |`);
p(`| Fields left for the agent (yellow/red/amber) | ${leftover} |`);
p(`| Autofilled answers the agent changed | ${corrections} |`);
p(`| AI requests | ${asks.length}${asks.length ? ` (${asks.filter((a) => a.error).length} errors, median ${median(asks.filter((a) => !a.error).map((a) => a.ms))} ms)` : ''} |`);
p(`| AI suggestions acted on | ${decisions.length}: ${['accepted', 'approved', 'auto', 'dismissed', 'rejected', 'failed'].map((k) => `${k} ${decisions.filter((d) => d.decision === k).length}`).join(', ')} |`);
p(`| Problem reports | ${problems.length} |`);
p(`| Questions without a rule | ${uncovered.total} different, ${since ? `${uncovered.new.length} new in this period` : 'all data'} |`, '');

p('## AI assistant', '');
if (!asks.length && !decisions.length) p('No AI activity in this period (or the usage server was too old to accept AI events).', '');
else {
  const errors = count(asks.filter((a) => a.error).map((a) => a.error));
  if (Object.keys(errors).length) p('Errors:', ...Object.entries(errors).map(([m, n]) => `- ${n}× ${m}`), '');
  const tokensIn = sum(asks, 'tokensIn');
  const tokensOut = sum(asks, 'tokensOut');
  if (tokensIn || tokensOut) p(`Tokens: ${tokensIn.toLocaleString()} in (${sum(asks, 'cached').toLocaleString()} cached), ${tokensOut.toLocaleString()} out.`, '');
  if (aiRows.length) {
    p('Per question: agreed = accepted + approved, disagreed = dismissed + rejected. A question the AI keeps getting right is a candidate for a plain TNI rule; one it keeps getting wrong needs a rule or a better prompt.', '');
    p('| Question | Agreed | Disagreed | Auto | Failed | AI chose |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of aiRows) {
      const chose = [...r.choices.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n}`).join('; ');
      p(`| ${r.name.replace(/\|/g, '/')} | ${r.yes} | ${r.no} | ${r.auto} | ${r.failed} | ${chose.replace(/\|/g, '/')} |`);
    }
    p('');
  }
}

// --- Speed: how long each answer takes, and which answers change nothing else ---------------
p('## Speed', '');
const timed = recent.filter((e) => e.type === 'fill_field' && e.result === 'filled' && e.timing);
if (!timed.length) p('No timing yet (recorded from version 0.3.5 on).', '');
else {
  const byQ = new Map();
  for (const e of timed) {
    const key = questionKey(e);
    const row = byQ.get(key) ?? { name: `${e.carrier} ${e.page} "${e.label ?? ''}"`, page: e.page, n: 0, ms: [], settle: [], ajax: 0, effects: 0, revealed: 0, removed: 0, changed: 0 };
    row.n++; row.ms.push(e.timing.ms); row.settle.push(e.timing.settleMs);
    if (e.timing.ajax > 0) row.ajax++;
    if (e.timing.revealed || e.timing.removed || e.timing.changed) row.effects++;
    row.revealed += e.timing.revealed; row.removed += e.timing.removed; row.changed += e.timing.changed;
    byQ.set(key, row);
  }
  const rows = [...byQ.entries()].map(([key, r]) => ({ key, ...r, med: median(r.ms) }));
  const pages = new Map();
  for (const r of rows) {
    const x = pages.get(r.page) ?? { answers: 0, ms: 0, free: 0, freeMs: 0 };
    x.answers++; x.ms += r.med;
    if (!r.effects) { x.free++; x.freeMs += r.med; }
    pages.set(r.page, x);
  }
  p('Per page: time spent waiting on answers (median per answer, summed), and how much of it is answers that never changed anything else on the page (candidates for answering together).', '');
  p('| Page | Answers | Time on answers | Independent answers | Their time |', '| --- | --- | --- | --- | --- |');
  for (const [page, x] of [...pages.entries()].sort((a, b) => b[1].ms - a[1].ms)) p(`| ${page} | ${x.answers} | ${(x.ms / 1000).toFixed(1)} s | ${x.free} | ${(x.freeMs / 1000).toFixed(1)} s |`);
  p('', 'Per question (slowest first). Independent = never revealed, removed or changed another question in any quote so far.', '');
  p('| Question | Seen | Median ms | Server request | Independent | Side effects (revealed/removed/changed) |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of rows.sort((a, b) => b.med - a.med)) p(`| ${r.name.replace(/\|/g, '/')} | ${r.n} | ${r.med} | ${r.ajax}/${r.n} | ${r.effects ? 'no' : 'yes'} | ${r.effects ? `${r.revealed}/${r.removed}/${r.changed}` : '—'} |`);
  p('');
}

p('## Problem reports', '');
if (!problems.length) p('None.', '');
else p(...problems.map((e) => `- ${e.t?.slice(0, 16).replace('T', ' ')} · ${e.agent ?? '?'} · ${e.page ?? '?'}: ${String(e.text ?? '').trim().replace(/\n+/g, '\n  ')}`), '');

// Questions met on live pages that no rule claims (or, for AmWINS, that the mock lacks).
const { markdown: coverageMd } = coverageReport(loadLayouts(inputs));
if (since) {
  p('## New questions without a rule', '', 'First seen on a live page in this period (never in a layout received before it, in any state or product).', '');
  p(...(uncovered.new.length ? uncovered.new.map((q) => `- ${q.carrier} ${q.page}: ${q.ref ? `\`${q.ref}\` ` : ''}"${q.caption}"${q.kind ? ` (${q.kind})` : ''}`) : ['None.']), '');
}
p('## Rule coverage of live pages (all data)', '', 'Questions agents met that no rule claims are left to them as "unfamiliar": a missing TNI rule, or the carrier changed its page. "Not in the mock" means the AmWINS page has a field the mock lacks.', '', coverageMd || 'No layouts yet.', '');
p('## Rule suggestions (all data)', '', learn, '');
p('## Usage summary (this period)', '', '```', summary, '```', '');
p('## Page layouts (all data)', '', 'Open these on the replay page (`npm run replay`, then the Layout box) to see what fills on each state/product.', '', '```', layouts, '```', '');
p('## Manual captures (layouts/)', '', 'Each scenario captured by hand, in order, with what changed between captures of the same page: the report named here.', '', '```', captures, '```', '');
p('## When questions show (all data)', '', 'Conditions seen in the layouts, answers not tried yet (a checklist for recordings) and what changed after an answer: the report named here.', '', '```', transitions, '```', '');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
if (opt('summary')) {
  fs.writeFileSync(opt('summary'), JSON.stringify({
    since,
    problems: problems.map((e) => ({ t: e.t, receivedAt: e.receivedAt ?? null, agent: e.agent ?? null, page: e.page ?? null, text: e.text ?? '' })),
    newQuestions: uncovered.new,
    uncoveredTotal: uncovered.total,
  }, null, 1));
}
console.log(`${path.relative(process.cwd(), out)}  (${since ? `since ${since}` : 'all data'}: ${quotes.size} quotes, ${decisions.length} AI decisions, ${problems.length} problem reports)`);

function count(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function median(list) {
  const s = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : '—';
}
