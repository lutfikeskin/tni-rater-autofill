#!/usr/bin/env node
// Step 2 of the weekly review (.claude/skills/weekly-review), done by code: reads the open
// `weekly-review` ledger issue, finds each item's PRs and merge commits, which builds that logged the
// period contain each fix, and counts each item's signature on those builds' events, proposing
// verified / recurred / not exercised. Also sets this period's weekly numbers against the ledger's.
//
//   npm run ledger -- --since 2026-10-13                      # server-data, the open ledger issue
//   node scripts/ledger.mjs <server-data> [more logs...] [--ledger 86 | --ledger body.md] [--since <date> | --last <n>]
//       [--tests reviews/test-intakes.txt] [--main origin/main] [--repo owner/name] [--out file.md] [--json]
//
// --since defaults to the end of the ledger's period (its title's second date); --last <n> starts at
// the newest n quotes instead (a spot review). Read only: it asks gh and git, and never edits the
// issue. Writes reviews/ledger-<date>.md (git-ignored).
//
// In a worktree, the usage data, reviews/ and the test-intake list live in the main checkout: pass
// their paths (`node scripts/ledger.mjs ../../../server-data --tests ../../../reviews/test-intakes.txt`).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEvents, quoteSessions } from './lib/events.mjs';
import { receivedAt } from './lib/daily.mjs';
import { signals, testSessionsOf } from './lib/signals.mjs';
import { buildContains, buildKey, buildName, fixOf, gitReader, inPeriod, judgeItem, markdown, parseLedger, weeklyRows } from './lib/ledger.mjs';

const args = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
  return args[i + 1];
};
const valued = new Set(['--ledger', '--since', '--last', '--tests', '--main', '--repo', '--out']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
for (const p of inputs) if (!fs.existsSync(p)) fail(`No usage data at ${p}. Run npm run pull first, or pass the folder (in a worktree, the main checkout's server-data).`);

const repo = opt('repo');
// One retry: a dropped connection shouldn't end a run of twenty lookups.
const gh = (...a) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('gh', [...a, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (attempt < 2) continue;
      fail(`gh ${a.slice(0, 2).join(' ')} failed: ${String(err.stderr || err.message).split('\n')[0]} (is gh installed and signed in?)`);
    }
  }
};
const notes = [];

// The ledger: an issue number, a saved Markdown body, or the open weekly-review issue.
const ledgerOpt = opt('ledger');
let issue;
if (ledgerOpt && !/^#?\d+$/.test(ledgerOpt)) {
  if (!fs.existsSync(ledgerOpt)) fail(`--ledger ${ledgerOpt}: no such file (or give the issue number).`);
  const body = fs.readFileSync(ledgerOpt, 'utf8');
  issue = { number: null, title: /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? path.basename(ledgerOpt), body, comments: [] };
} else {
  let number = ledgerOpt?.replace('#', '');
  if (!number) {
    const open = JSON.parse(gh('issue', 'list', '--label', 'weekly-review', '--state', 'open', '--json', 'number,title', '--limit', '10'));
    if (!open.length) fail('No open weekly-review issue. Pass --ledger <number> or a saved body.');
    open.sort((a, b) => b.number - a.number);
    if (open.length > 1) notes.push(`${open.length} open weekly-review issues (${open.map((x) => `#${x.number}`).join(', ')}); read #${open[0].number}. Close the older ones.`);
    number = String(open[0].number);
  }
  const x = JSON.parse(gh('issue', 'view', number, '--json', 'number,title,body,comments'));
  issue = { number: x.number, title: x.title, body: x.body, comments: (x.comments ?? []).map((c) => c.body) };
}
const ledger = parseLedger(issue.body, { title: issue.title, comments: issue.comments });
if (!ledger.items.length) notes.push('No item lines found (`- [ ] W42-03 · S2 · Fix · <title> · … · signature: …`).');

const all = loadEvents(inputs);
let since = opt('since');
const last = opt('last');
if (last) {
  const k = Number(last);
  if (!Number.isInteger(k) || k < 1) fail('--last needs a number of quotes.');
  const quotes = quoteSessions(all);
  const started = new Map();
  for (const e of all) if (e.type === 'intake_loaded' && quotes.has(e.session) && !started.has(e.session)) started.set(e.session, receivedAt(e));
  const newest = [...started.values()].sort().slice(-k);
  if (!newest.length) fail('No quotes in the data.');
  since = newest[0];
  notes.push(`The newest ${newest.length} quotes: received since ${since.slice(0, 16).replace('T', ' ')} UTC (pass the same --since to npm run signals).`);
}
since ??= ledger.period?.to ?? null;
if (!since) fail('No period: pass --since <date> (or --last <n>); the ledger title names none.');
if (Number.isNaN(Date.parse(since))) fail(`--since ${since} is not a date.`);
since = new Date(since).toISOString();

const testsOpt = opt('tests');
if (testsOpt && !fs.existsSync(testsOpt)) fail(`--tests ${testsOpt}: no such file.`);
const testFile = testsOpt ?? (fs.existsSync('reviews/test-intakes.txt') ? 'reviews/test-intakes.txt' : null);
if (!testFile) notes.push('No test-intake list (reviews/test-intakes.txt, or --tests): test runs are counted as quotes.');
const testIntakes = testFile ? fs.readFileSync(testFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : [];
const testSessions = testSessionsOf(all, testIntakes);
const period = inPeriod(all, since);

// git: the main branch the fixes merged into, as this clone knows it.
const git = gitReader(process.cwd(), opt('main') ?? 'origin/main');
if (!git.resolve(git.main)) {
  const fallback = gitReader(process.cwd(), 'main');
  if (!fallback.resolve('main')) fail(`No ${git.main} or main in this clone.`);
  notes.push(`${git.main} not found; used main (run git fetch for merges since).`);
  Object.assign(git, fallback);
}

// Each item's PRs: those the line names and those naming the ID (gh's search, then the ID checked
// in the title or body), with their merge commits.
const PR_FIELDS = 'number,title,body,state,mergeCommit,baseRefName';
for (const item of ledger.items) {
  if (item.ticked || /\bdropped\b|\bdeferred\b|\bnot approved\b/i.test(item.decision)) continue;
  const found = JSON.parse(gh('pr', 'list', '--state', 'all', '--search', `${item.id} in:title,body`, '--json', PR_FIELDS, '--limit', '30'));
  const byNumber = new Map(found.filter((p) => new RegExp(`\\b${item.id}\\b`).test(`${p.title}\n${p.body}`)).map((p) => [p.number, p]));
  for (const nr of item.prs) if (!byNumber.has(nr)) byNumber.set(nr, JSON.parse(gh('pr', 'view', String(nr), '--json', PR_FIELDS)));
  item.prDetails = [...byNumber.values()].sort((a, b) => a.number - b.number).map((p) => {
    const merge = p.mergeCommit?.oid ?? null;
    const onMain = p.state === 'MERGED' && merge ? git.onMain(merge) : false;
    if (p.state === 'MERGED' && merge && onMain === null) notes.push(`${item.id}: #${p.number}'s merge commit ${merge.slice(0, 7)} isn't in this clone (git fetch).`);
    return { number: p.number, title: p.title, state: p.state, base: p.baseRefName, mergeCommit: merge, onMain: onMain === true };
  });
  const commits = item.prDetails.filter((p) => p.onMain).map((p) => p.mergeCommit);
  if (item.merged) {
    const c = git.resolve(item.merged);
    if (c && git.onMain(c)) commits.push(c);
    else notes.push(`${item.id}: "merged ${item.merged}" isn't a commit on ${git.main} in this clone.`);
  }
  item.fix = fixOf([...new Set(commits)], git);
}

// Whether each build that logged the period contains each item's fix (cached per build).
const containsOf = new Map();
const contains = (item) => {
  const memo = new Map();
  const f = (e) => {
    const k = buildKey(e);
    if (!memo.has(k)) memo.set(k, buildContains({ version: e.v, commit: e.commit }, item.fix, git));
    return memo.get(k);
  };
  containsOf.set(item.id, f);
  return f;
};
const items = ledger.items.map((item) => judgeItem(item, period, contains(item), testSessions));

// The period's builds, with the merged fixes each carries.
const quotes = quoteSessions(all);
const builds = new Map();
for (const e of period) {
  const k = buildKey(e);
  const b = builds.get(k) ?? builds.set(k, { name: buildName(e), sample: e, sessions: new Set() }).get(k);
  if (quotes.has(e.session)) b.sessions.add(e.session);
  if (e.commit && !git.resolve(String(e.commit).replace(/\+dirty$/, ''))) b.unknownCommit = true;
}
const fixed = ledger.items.filter((x) => x.fix);
const buildRows = [...builds.values()].map((b) => {
  const by = { yes: [], no: [], unknown: [] };
  for (const x of fixed) by[containsOf.get(x.id)(b.sample)].push(x.id);
  const list = (ids) => (ids.length === fixed.length ? `all ${fixed.length}` : ids.join(', '));
  let fixes = by.yes.length ? list(by.yes) : by.unknown.length ? '' : 'none';
  if (by.unknown.length) fixes += `${fixes ? '; ' : ''}can't tell: ${list(by.unknown)}`;
  if (b.unknownCommit) fixes += ' (commit not in this clone: placed by version)';
  return { name: b.name, quotes: b.sessions.size, fixes };
}).sort((a, b) => b.quotes - a.quotes);

const free = items.filter((x) => x.free).map((x) => x.id);
if (free.length) notes.push(`Free-text signatures (${free.join(', ')}): rewrite them as \`expect …\` or \`symptom …\` to count them exactly.`);
const kpis = signals(all, { since, testIntakes }).kpis;
const result = {
  ledger: { number: issue.number, title: ledger.title, week: ledger.week, period: ledger.period },
  since,
  quotes: kpis.quotes,
  testRunsLeftOut: kpis.testRunsLeftOut,
  items,
  weekly: weeklyRows(kpis, ledger.numbers),
  builds: buildRows,
  notes,
};
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
}
const out = opt('out') ?? path.join('reviews', `ledger-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, markdown(result));
const count = (s) => items.filter((x) => x.status === s).length;
console.log(`${out}  (${items.length} items: ${count('verified')} verified, ${count('recurred')} recurred, ${count('not exercised')} not exercised, ${count('still open')} still open; ${kpis.quotes} quotes)`);
