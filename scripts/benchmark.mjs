#!/usr/bin/env node
// Replay benchmark: would today's rules give the answers agents left in recorded quotes?
//
//   npm run benchmark -- --intakes <folder with intake PDFs> [--intakes <another>] [--save run.json] [--against earlier.json]
//   node scripts/benchmark.mjs server-data --intakes ~/Downloads --save reviews/benchmark-main.json
//
// Each recorded quote whose intake PDF is in one of the folders (matched by the PDF's SHA-256, as
// the extension fingerprints it) is replayed through today's rules without a browser; see
// scripts/lib/benchmark.mjs for how answers are paired and compared. Writes
// reviews/benchmark-<date>.md (ignored: it holds the quotes' question answers). --save keeps the
// per-answer results; --against compares this run with a saved one, listing the answers a rule
// change fixed or broke on the same quotes. Nothing here reads or prints the intakes' values.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { CARRIERS } from '../src/carriers.js';
import { loadEvents } from './lib/events.mjs';
import { benchmark, byQuestion, CHANGES, compareRuns, summarize } from './lib/benchmark.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--intakes', '--save', '--against', '--out']);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const inputs = args.filter((a, i) => !valued.has(a) && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
const folders = values('intakes');
if (!folders.length) {
  console.error('usage: node scripts/benchmark.mjs [server-data | usage logs]... --intakes <folder of intake PDFs> [--save run.json] [--against earlier.json] [--out report.md]');
  process.exit(1);
}

function* pdfs(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules') yield* pdfs(full, depth + 1);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) yield full;
  }
}

const events = loadEvents(inputs);
const wanted = new Set(events.filter((e) => e.type === 'intake_loaded' && e.intakeId).map((e) => e.intakeId));
const raws = new Map();
for (const folder of folders) {
  for (const file of pdfs(folder)) {
    const bytes = fs.readFileSync(file);
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!wanted.has(id) || raws.has(id)) continue;
    try { raws.set(id, await readIntakeFields(pdfjs, new Uint8Array(bytes))); } catch { /* not a readable intake */ }
  }
}

const run = benchmark(events, { carriers: CARRIERS, raws });
const { rows } = run;
const sum = summarize(rows);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
const intakes = new Set(rows.map((r) => r.intakeId)).size;
const where = (q) => `${q.carrier} ${q.page}${q.step ? ` › ${q.step}` : ''}`;
const label = (q) => String(q.label ?? '').replace(/\|/g, '/').slice(0, 90);
const pairs = (q) => q.pairs.slice(0, 3).map(([p, n]) => `${p}${n > 1 ? ` (${n})` : ''}`).join('; ');

const GROUPS = [
  ['kept', 'Autofilled, agent kept it', 'agree: still right · **differ: today would change an answer agents kept** · blank/left: today leaves it to the agent'],
  ['corrected', 'Autofilled, agent corrected it', '**agree: today recovers the agent\'s answer** · differ: still not the agent\'s · left: now the agent\'s'],
  ['agent', 'Answered by the agent', 'agree: today fills what the agent chose · **differ: today would fill something else** · left: still the agent\'s'],
  ['page', 'The page\'s answer (left by the agent)', 'weaker evidence: a default nobody chose · differ: today would replace it'],
];
const lines = [
  `# Replay benchmark: today's rules on ${run.replayed} recorded quote${run.replayed === 1 ? '' : 's'} (${intakes} intake PDF${intakes === 1 ? '' : 's'})`,
  '',
  `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from ${inputs.join(', ')}. ${run.quotes} quotes recorded; ${run.quotes - run.replayed} without their intake PDF in the given folders (${run.missing.length} PDF${run.missing.length === 1 ? '' : 's'} not found).`,
  '',
  '**Limits.** The agent\'s final answer stands in for the right one: a correction can be a legitimate exception for that client, and an answer agents kept is not proven correct. Choices are compared on pagekit\'s exact, yes/no, state and dollar-amount tiers; a pick that depends on the page\'s options is `unsure`. Text is compared through the intake fields the agent\'s typed text matched, never the text itself. A field recorded before data-model names may pair through the rule path that filled it. The intake is read again from the PDF: corrections the agent made in the panel are not replayed (answers from such quotes are marked). This shows agreement with past agents, not live accuracy.',
  '',
  '## Summary',
  '',
  '| Quote\'s answer | Answers | Agree | Differ | Unsure | Blank today | Agent\'s today | How to read it |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...GROUPS.filter(([g]) => sum[g]).map(([g, name, read]) => {
    const s = sum[g];
    return `| ${name} | ${s.total} | ${s.agree} (${pct(s.agree, s.total)}) | ${s.differ} | ${s.unsure} | ${s.blank} | ${s.left} | ${read} |`;
  }),
  '',
  `Unsure, by reason: ${Object.entries(rows.filter((r) => r.result === 'unsure').reduce((m, r) => ({ ...m, [r.reason ?? 'other']: (m[r.reason ?? 'other'] ?? 0) + 1 }), {})).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. ${rows.filter((r) => r.result === 'unknown').length} recorded answers had no final value to compare (a question left alone, or an event too old to say).`,
  '',
];

const section = (title, note, list, extra = () => '') => {
  lines.push(`## ${title}`, '', note, '');
  if (!list.length) { lines.push('None.', ''); return; }
  lines.push('| Question | Where | Answers | Intakes | Today\'s rule | Today → agent |', '| --- | --- | --- | --- | --- | --- |');
  for (const q of list.slice(0, 40)) lines.push(`| ${label(q)}${q.edited ? ` (${q.edited} from quotes with an edited intake)` : ''} | ${where(q)} | ${q.answers} | ${q.intakes} | ${String(q.rule ?? '').slice(0, 60)} | ${pairs(q)}${extra(q)} |`);
  if (list.length > 40) lines.push(`| … ${list.length - 40} more | | | | | |`);
  lines.push('');
};
const of = (group, result) => byQuestion(rows.filter((r) => r.group === group && r.result === result));
section('Would change answers agents kept', 'Autofilled answers the agent left as they were, which today\'s rules would answer differently: a rule change since, or a normalization change. Check each before release.', of('kept', 'differ'));
section('Would differ from the agent\'s own answer', 'Questions the agent answered (not autofilled) that today\'s rules now fill with something else.', of('agent', 'differ'));
section('Recovered corrections', 'Autofilled answers agents corrected that today\'s rules now give as the agent did.', of('corrected', 'agree'));
section('Still corrected', 'Answers agents corrected that today\'s rules still give differently. A correction can be a client\'s exception: see [corrections](../docs/corrections.md) before changing a rule.', of('corrected', 'differ'));
section('Newly automated', 'Questions the agent answered that today\'s rules fill the same way.', of('agent', 'agree'));
section('Lost answers', 'Autofilled answers agents kept that today\'s rules leave blank or to the agent.', byQuestion(rows.filter((r) => r.group === 'kept' && (r.result === 'blank' || r.result === 'left'))));

if (values('against').length) {
  const before = JSON.parse(fs.readFileSync(values('against')[0], 'utf8')).rows ?? [];
  const changed = compareRuns(before, rows);
  const count = (kind) => changed.filter((r) => r.change === kind).length;
  lines.push(`## Compared with ${path.basename(values('against')[0])}`, '',
    `${changed.length} answers changed result on the same quotes: ${CHANGES.map(([kind, name]) => `${count(kind)} ${name}`).join(', ')}.`, '');
  if (changed.length) {
    lines.push('| Change | Question | Where | Answers | Intakes | Before → now (agent\'s answer) |', '| --- | --- | --- | --- | --- | --- |');
    for (const [kind, name] of CHANGES) {
      const groups = new Map();
      for (const r of changed.filter((x) => x.change === kind)) {
        const g = groups.get(r.question) ?? { ...r, answers: 0, intakes: new Set(), pairs: new Map() };
        g.answers++;
        g.intakes.add(r.intakeId);
        const pair = `${r.was}${r.wasToday != null ? ` ${r.wasToday}` : ''} → ${r.result}${r.today != null ? ` ${r.today}` : ''}${r.answer != null ? ` (${r.answer})` : ''}`;
        g.pairs.set(pair, (g.pairs.get(pair) ?? 0) + 1);
        groups.set(r.question, g);
      }
      for (const g of [...groups.values()].sort((a, b) => b.intakes.size - a.intakes.size || b.answers - a.answers)) {
        lines.push(`| ${name} | ${label(g)} | ${where(g)} | ${g.answers} | ${g.intakes.size} | ${[...g.pairs].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([p, n]) => `${p}${n > 1 ? ` ×${n}` : ''}`).join('; ')} |`);
      }
    }
    lines.push('');
  }
}

const out = values('out')[0] ?? path.join('reviews', `benchmark-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
if (values('save').length) {
  fs.mkdirSync(path.dirname(values('save')[0]), { recursive: true });
  fs.writeFileSync(values('save')[0], JSON.stringify({ kind: 'benchmark-run', generated: new Date().toISOString(), rows }, null, 1));
}
console.log(lines.slice(0, 16).join('\n'));
console.log(`\nReport: ${out}${values('save').length ? `\nSaved run: ${values('save')[0]}` : ''}`);
