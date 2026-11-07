#!/usr/bin/env node
// Offline rule proposals for the weekly review: the questions agents are left to answer again and
// again with no rule suggestion, each with a proposal Luna drafts (scripts/lib/proposals.mjs) and
// its agreement with the agents' final answers. For the maintainer to decide; nothing is applied.
//
//   node scripts/rule-proposals.mjs server-data [more logs...] [--min 5] [--threshold 0.9] [--tests reviews/test-intakes.txt] [--max 20] [--out reviews/rule-proposals-<date>.md] [--json]
//   OPENAI_API_KEY=... node scripts/rule-proposals.mjs server-data --live
//
// Without --live it lists the candidates only, and sends nothing. With it, one request per
// candidate (at most --max) goes to OpenAI with the key in OPENAI_API_KEY. Test runs are left out,
// as in learn-rules.mjs.

import fs from 'node:fs';
import { loadEvents } from './lib/events.mjs';
import { learn } from './lib/learn.mjs';
import { proposeRules, proposalsMarkdown } from './lib/proposals.mjs';
import { readTestList, learnerTestRuns } from './lib/signals.mjs';
import { CARRIERS } from '../src/carriers.js';

const args = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
const flags = new Set(['--json', '--live']);
const valued = new Set(['--min', '--threshold', '--out', '--tests', '--max']);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
  return args[i + 1];
};
const unknown = args.find((a) => a.startsWith('--') && !flags.has(a) && !valued.has(a));
if (unknown) fail(`Unknown option ${unknown}.`);
const inputs = args.filter((a, i) => !flags.has(a) && !valued.has(a) && !valued.has(args[i - 1]));
if (!inputs.length) fail('usage: node scripts/rule-proposals.mjs <server-data folder | usage logs>... [--min 5] [--threshold 0.9] [--tests file] [--max 20] [--live] [--json] [--out file.md]');
const number = (name, fallback) => {
  const n = Number(opt(name, fallback));
  if (!Number.isInteger(n) || n < 1) fail(`--${name} needs a whole number of at least 1.`);
  return n;
};
const minIntakes = number('min', 5), max = number('max', 20);
const threshold = Number(opt('threshold', 0.9));
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) fail('--threshold needs a share above 0 and at most 1, such as 0.9.');
const live = args.includes('--live');
const apiKey = process.env.OPENAI_API_KEY;
if (live && !apiKey) fail('Missing OPENAI_API_KEY: drafting proposals is opt-in and needs that environment variable.');

let testList;
try { testList = readTestList({ tests: opt('tests', null) }); } catch (err) { fail(err.message); }
if (testList.warning) console.error(`Warning: ${testList.warning}`);
const events = loadEvents(inputs);
const result = learn(events, { carriers: CARRIERS, minIntakes, threshold, excludeSessions: learnerTestRuns(events, testList.intakes) });
const candidates = result.undecided;
const drafted = live ? await proposeRules(candidates, { apiKey, max }) : null;

if (args.includes('--json')) {
  console.log(JSON.stringify({ quotes: result.quotes, intakes: result.intakes, testRunsLeftOut: result.testRunsLeftOut, candidates,
    drafted: drafted && { ...drafted, results: drafted.results.map(({ candidate, ...r }) => ({ question: candidate, ...r })) } }, null, 2));
  process.exit(0);
}
const text = proposalsMarkdown(candidates, drafted, { quotes: result.quotes, intakes: result.intakes, minIntakes, testRunsLeftOut: result.testRunsLeftOut });
const out = opt('out', null);
if (out) fs.writeFileSync(out, text);
console.log(text);
