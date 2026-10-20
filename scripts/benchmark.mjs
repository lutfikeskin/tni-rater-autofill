#!/usr/bin/env node
// Replay benchmark: would today's rules give the answers agents left in recorded quotes?
//
//   npm run benchmark -- --intakes <folder with intake PDFs> [--intakes <another>] [--key key.json] [--save run.json] [--against earlier.json]
//   node scripts/benchmark.mjs server-data --intakes ~/Downloads --save reviews/benchmark-main.json
//   npm run benchmark -- --intakes layouts/intakes --key layouts/answer-key/key.json
//
// Each recorded quote whose intake PDF is in one of the folders (matched by the PDF's SHA-256, as
// the extension fingerprints it) is replayed through today's rules without a browser; see
// scripts/lib/benchmark.mjs for how answers are paired and compared. Writes
// reviews/benchmark-<date>.md (ignored: it holds the quotes' question answers). --save keeps the
// per-answer results; --against compares this run with a saved one, listing the answers a rule
// change fixed or broke on the same quotes. --key scores today's rules (and, apart, the agents'
// final answers) against TNI's answer key for the quotes it covers (scripts/lib/answer-key.mjs;
// `npm run key:sheet` makes one): right, wrong, missed, invented. Nothing here prints the intakes'
// values: the report shows choices, never typed text.

import fs from 'node:fs';
import path from 'node:path';
import { CARRIERS } from '../src/carriers.js';
import { loadEvents } from './lib/events.mjs';
import { benchmark, byQuestion, CHANGES, compareRuns, summarize } from './lib/benchmark.mjs';
import { readIntakes } from './lib/intake-pdfs.mjs';
import { compareKey, keyByQuestion, readKey, rightPercent, scoreKey } from './lib/answer-key.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--intakes', '--save', '--against', '--out', '--key']);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const inputs = args.filter((a, i) => !valued.has(a) && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
const folders = values('intakes');
if (!folders.length) {
  console.error('usage: node scripts/benchmark.mjs [server-data | usage logs]... --intakes <folder of intake PDFs> [--key key.json] [--save run.json] [--against earlier.json] [--out report.md]');
  process.exit(1);
}
const keyFile = values('key')[0] ?? null;
let key = null;
if (keyFile) {
  try { key = readKey(JSON.parse(fs.readFileSync(keyFile, 'utf8'))); } catch (err) { console.error(`${keyFile}: ${err.message}`); process.exit(1); }
}

const events = loadEvents(inputs);
const raws = await readIntakes(folders, new Set(events.filter((e) => e.type === 'intake_loaded' && e.intakeId).map((e) => e.intakeId)));

const run = benchmark(events, { carriers: CARRIERS, raws, detail: !!keyFile });
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

// TNI's answer key: what a reviewer at TNI decided for these quotes, in place of the agents' answers.
const keyed = key ? scoreKey(rows, key) : null;
if (keyed) {
  const notFound = Object.keys(key.quotes).filter((i) => !raws.has(i)).length;
  const keyLine = (name, c) => `| ${name} | ${c.cells} | ${c.right} (${pct(c.right, c.right + c.wrong + c.missed + c.invented)}) | ${c.wrong} | ${c.missed} | **${c.invented}** | ${c.unsure} | ${c.unkeyed} | ${c.agents.right} · ${c.agents.wrong} · ${c.agents.unsure} |`;
  lines.push('## Against TNI\'s answer key', '',
    `${path.basename(keyFile)}: ${Object.keys(key.quotes).length} intakes keyed, ${keyed.quotes} with recorded quotes here${notFound ? ` (${notFound} keyed intake PDF${notFound === 1 ? '' : 's'} not in the given folders)` : ''}. One answer per quote, question and unit (vehicle, driver, trailer, Rates row): an intake's latest quote on each carrier.`, '',
    '**How to read it.** right: today\'s rules give the key\'s answer, or leave to the agent what the key says is the agent\'s, not applicable, or blank on the intake · wrong: another answer · missed: left to the agent though the key has an answer · **invented: filled where the key says the agent\'s or not applicable (must be 0)** · unsure: the pairing or the page\'s options can\'t tell · not keyed: no answer in the key yet. Right % is of the answers judged (right, wrong, missed, invented). Agents: their final answers where the key has one (right · wrong · unsure); typed text is judged only through the intake fields it matched.', '',
    '| Carrier | Answers | Right | Wrong | Missed | Invented | Unsure | Not keyed | Agents right · wrong · unsure |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(keyed.byCarrier).sort().map(([c, x]) => keyLine(c, x)),
    keyLine('**All**', keyed.total), '');
  const keySection = (title, note, list) => {
    lines.push(`### ${title}`, '', note, '');
    if (!list.length) { lines.push('None.', ''); return; }
    lines.push('| Question | Where | Answers | Intakes | Today\'s rule (source) | Key · today |', '| --- | --- | --- | --- | --- | --- |');
    for (const q of list.slice(0, 40)) lines.push(`| ${label(q)} | ${where(q)} | ${q.cells} | ${q.intakes} | ${String(q.rule ?? '').slice(0, 60)}${q.source ? ` (${q.source})` : ''} | ${pairs(q)} |`);
    if (list.length > 40) lines.push(`| … ${list.length - 40} more | | | | | |`);
    lines.push('');
  };
  keySection('Invented', 'Today\'s rules fill an answer the key says is the agent\'s (a client fact, an attestation, or blank on the intake) or not applicable. Each one is a finding.', keyByQuestion(keyed.scored, 'invented'));
  keySection('Wrong', 'Today\'s rules give another answer than the key\'s.', keyByQuestion(keyed.scored, 'wrong'));
  keySection('Missed', 'Left to the agent, though the key has an answer (from the intake or a TNI standard).', keyByQuestion(keyed.scored, 'missed'));
}

// A keyed answer as --save keeps it: its quote, question and unit, where, and the results; no values.
const keyRow = (s) => ({ id: s.id, question: s.question, carrier: s.row.carrier, page: s.row.page, ...(s.row.step ? { step: s.row.step } : {}), label: s.row.label, key: s.result, agentKey: s.agent });

if (values('against').length) {
  const saved = JSON.parse(fs.readFileSync(values('against')[0], 'utf8'));
  const before = saved.rows ?? [];
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
  // The key's results on the same quotes, when both runs were scored against a key.
  if (keyed && saved.key) {
    const moved = compareKey(saved.key, keyed.scored.map(keyRow));
    const kinds = new Map();
    for (const r of moved) kinds.set(`${r.wasKey} → ${r.key}`, (kinds.get(`${r.wasKey} → ${r.key}`) ?? 0) + 1);
    lines.push(`## Answer key compared with ${path.basename(values('against')[0])}`, '',
      `${moved.length} keyed answers changed result on the same quotes${moved.length ? `: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}. A change to wrong, missed or invented is a regression unless the PR says why.`, '');
    if (moved.length) {
      const groups = new Map();
      for (const r of moved) {
        const k = `${r.wasKey} → ${r.key}|${r.question}`;
        groups.set(k, { ...r, change: `${r.wasKey} → ${r.key}`, n: (groups.get(k)?.n ?? 0) + 1 });
      }
      lines.push('| Before → now | Question | Where | Answers |', '| --- | --- | --- | --- |');
      for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) lines.push(`| ${g.change} | ${label(g)} | ${where(g)} | ${g.n} |`);
      lines.push('');
    }
  } else if (keyed) lines.push(`(${path.basename(values('against')[0])} was saved without --key: no answer-key comparison.)`, '');
}

const out = values('out')[0] ?? path.join('reviews', `benchmark-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
if (values('save').length) {
  fs.mkdirSync(path.dirname(values('save')[0]), { recursive: true });
  fs.writeFileSync(values('save')[0], JSON.stringify({ kind: 'benchmark-run', generated: new Date().toISOString(), rows, ...(keyed ? { key: keyed.scored.map(keyRow) } : {}) }, null, 1));
}
console.log(lines.slice(0, 16).join('\n'));
if (keyed) {
  const t = keyed.total;
  console.log(`\nAgainst TNI's answer key (${keyed.quotes} quotes, ${t.cells} answers): ${t.right} right (${rightPercent(t) ?? '–'}%), ${t.wrong} wrong, ${t.missed} missed, ${t.invented} invented (must be 0), ${t.unsure} unsure, ${t.unkeyed} not keyed.`);
}
console.log(`\nReport: ${out}${values('save').length ? `\nSaved run: ${values('save')[0]}` : ''}`);
