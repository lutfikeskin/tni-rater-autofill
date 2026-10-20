#!/usr/bin/env node
// The review page for TNI's answer key: every question the recorded quotes of the given intakes met,
// grouped so a reviewer decides each answer once (scripts/lib/answer-key.mjs).
//
//   npm run key:sheet -- --intakes <folder of intake PDFs> [--key layouts/answer-key/key.json] [--tests <file>] [--out <file.html>]
//   node scripts/answer-key-sheet.mjs server-data --intakes layouts/intakes
//
// Quotes are paired with today's rules as the benchmark pairs them; test runs are left out as the
// review leaves them out (readTestList in scripts/lib/signals.mjs): intakes marked as a test, the
// fixture and synthetic intake PDFs, and this repository's reviews/test-intakes.txt (wherever the
// script runs from) or --tests <file>. Without a list it warns on stderr and on the sheet; a git
// worktree has none, so pass the main checkout's. --key resumes an existing key: its answers fill
// the page. Writes layouts/answer-key/sheet-<date>.html, which holds the intakes' answers: it stays
// in ignored layouts/. Open it in a browser, decide, and save key.json there
// (layouts/answer-key/key.json).

import fs from 'node:fs';
import path from 'node:path';
import { CARRIERS } from '../src/carriers.js';
import { loadEvents } from './lib/events.mjs';
import { benchmark } from './lib/benchmark.mjs';
import { readIntakes } from './lib/intake-pdfs.mjs';
import { readTestList, testSessionsOf } from './lib/signals.mjs';
import { readKey, sheetHtml, sheetModel } from './lib/answer-key.mjs';

const args = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };
const valued = new Set(['--intakes', '--key', '--tests', '--out']);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fail(`--${name} needs a value.`)] : []));
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
const folders = values('intakes');
if (!folders.length) fail('usage: node scripts/answer-key-sheet.mjs [server-data | usage logs]... --intakes <folder of intake PDFs> [--key key.json] [--tests reviews/test-intakes.txt] [--out sheet.html]');
for (const p of [...inputs, ...folders]) if (!fs.existsSync(p)) fail(`No such folder or file: ${p}`);

let key = null;
if (values('key').length) {
  try { key = readKey(JSON.parse(fs.readFileSync(values('key')[0], 'utf8'))); } catch (err) { fail(`${values('key')[0]}: ${err.message}`); }
}
// The test-run list, as the review reads it. Without one, the maintainer's test quotes would be on
// the sheet as agents' quotes: said on stderr and on the sheet.
let testList;
try { testList = readTestList({ tests: values('tests')[0] ?? null }); } catch (err) { fail(err.message); }
if (testList.warning) console.error(`Warning: ${testList.warning}`);

const events = loadEvents(inputs);
let tests;
try { tests = testSessionsOf(events, testList.intakes); } catch (err) { fail(err.message); }
const raws = await readIntakes(folders, new Set(events.filter((e) => e.type === 'intake_loaded' && e.intakeId && !tests.has(e.session)).map((e) => e.intakeId)));
if (!raws.size) fail(`None of the recorded quotes' intake PDFs (test runs left out) is in ${folders.join(', ')}.`);
const run = benchmark(events, { carriers: CARRIERS, raws, detail: true });
const rows = run.rows.filter((r) => !tests.has(r.session));
const model = { generated: new Date().toISOString(), noTestList: testList.warning, ...sheetModel(rows, { key }) };

const out = values('out')[0] ?? path.join('layouts', 'answer-key', `sheet-${model.generated.slice(0, 10)}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheetHtml(model));

const groups = model.questions.reduce((m, q) => ({ ...m, [q.group]: (m[q.group] ?? 0) + 1 }), {});
const perQuote = model.cells.filter((c) => c.attention.length).length;
console.log(`${model.intakes.length} intakes, ${new Set(rows.map((r) => r.session)).size} recorded quotes (${tests.size} test-run sessions left out; ${run.missing.length} intake PDFs not found).`);
console.log(`To decide: A ${groups.standard ?? 0} standards · B ${(groups.mapping ?? 0) + (groups.derived ?? 0)} intake fields · C ${(groups.agent ?? 0) + (groups.coverage ?? 0)} questions left to the agent and ${perQuote} quote-by-quote answers.`);
if (key) console.log(`Resumed from ${values('key')[0]}: ${Object.keys(key.questions).length} question answers, ${Object.values(key.quotes).reduce((n, q) => n + Object.keys(q).length, 0)} quote answers.`);
console.log(`Sheet: ${out}  (holds client answers: keep it in layouts/)`);
