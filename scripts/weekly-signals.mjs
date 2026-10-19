#!/usr/bin/env node
// The weekly review's signals that scripts/review.mjs doesn't show: builds that logged the period,
// how far quotes got, what was left to the agent and why, what held Continue, fill and layout
// errors, signs of a changed carrier page, fields the server dropped, the AI assistant by build,
// and problem reports with their build and context. See scripts/lib/signals.mjs.
//
//   npm run signals                          # server-data, the last 7 days received
//   node scripts/weekly-signals.mjs server-data [more logs...] [--since 2026-10-06[T06:00]] [--all] [--tests reviews/test-intakes.txt] [--json] [--out file.md]
//
// --tests: a file of intake fingerprints (full or leading hex, at least 8 characters, one per line, # for comments) whose
// quotes are test runs; they, and intakes the agent marked as a test, are left out and counted.
//
// Writes reviews/signals-<date>.md (git-ignored: problem reports are agents' own words).

import fs from 'node:fs';
import path from 'node:path';
import { loadEvents } from './lib/events.mjs';
import { markdown, signals } from './lib/signals.mjs';

const args = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
  return args[i + 1];
};
const valued = new Set(['--since', '--out', '--tests']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
for (const p of inputs) {
  if (!fs.existsSync(p)) { console.error(`No usage data at ${p}. Run npm run pull first, or pass exported logs.`); process.exit(1); }
}
const since = args.includes('--all') ? null : opt('since') ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
if (since && Number.isNaN(Date.parse(since))) fail(`--since ${since} is not a date.`);

const testsOpt = opt('tests');
if (testsOpt && !fs.existsSync(testsOpt)) fail(`--tests ${testsOpt}: no such file.`);
const testFile = testsOpt ?? (fs.existsSync('reviews/test-intakes.txt') ? 'reviews/test-intakes.txt' : null);
const testIntakes = testFile ? fs.readFileSync(testFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : [];
let result;
try { result = signals(loadEvents(inputs), { since, testIntakes }); } catch (err) { fail(`${testFile ?? 'signals'}: ${err.message}`); }
// A fingerprint list that hides many quotes may be hiding real ones.
if (result.kpis.testRunsLeftOut > 3) console.error(`Warning: ${result.kpis.testRunsLeftOut} quotes left out as test runs${testFile ? ` (${testFile})` : ''}. Check the list.`);
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
}
const out = opt('out') ?? path.join('reviews', `signals-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, markdown(result));
console.log(`${out}  (${result.quotes} quotes, ${result.problems.length} problem reports, newest version ${result.newestVersion ?? '?'})`);
