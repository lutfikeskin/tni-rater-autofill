#!/usr/bin/env node
// Weekly learning report: what the usage logs say the carrier rules should be.
//
//   node scripts/learn-rules.mjs server-data [more logs...] [--min 5] [--threshold 0.9] [--json] [--out report.md]
//
// Proposes rule changes (standard answers, per-state answers, new intake mappings, and rules
// agents keep correcting) with ready-to-paste rule lines for src/carriers/<carrier>.js.
// Review every suggestion before adding it: a consistent answer is not always a correct one.

import fs from 'node:fs';
import { loadEvents } from './lib/events.mjs';
import { learn } from './lib/learn.mjs';
import { CARRIERS } from '../src/carriers.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flags = new Set(['--json']);
const valued = new Set(['--min', '--threshold', '--out']);
const inputs = args.filter((a, i) => !flags.has(a) && !valued.has(a) && !valued.has(args[i - 1]));
if (!inputs.length) {
  console.error('usage: node scripts/learn-rules.mjs <server-data folder | usage logs>... [--min 5] [--threshold 0.9] [--json] [--out file.md]');
  process.exit(1);
}

const events = loadEvents(inputs);
const result = learn(events, { carriers: CARRIERS, minIntakes: Number(opt('min', 5)), threshold: Number(opt('threshold', 0.9)) });

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const { standard, byState, mapping, review, pageAnswer } = result.suggestions;
const lines = [
  `# Rule suggestions from ${result.quotes} quote${result.quotes === 1 ? '' : 's'} of ${result.intakes} intake PDF${result.intakes === 1 ? '' : 's'}`,
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} from ${events.length} events. Minimum ${opt('min', 5)} different intake PDFs per suggestion (quotes of one PDF count once). Review before adding anything.`,
  '',
  `## Standard answers (${standard.length})`,
  'Unmapped questions agents answer the same way nearly every time.',
  '',
  ...standard.flatMap((s) => [
    `- **${s.carrier} ${s.page}${s.field ? ` ${s.field}` : ''}** "${s.label}": "${s.answer}" in ${pct(s.share)} of ${s.answers} (${s.intakes} PDFs)${s.others.length ? ` (also: ${s.others.map((o) => `"${o.value}" ×${o.count}`).join(', ')})` : ''}`,
    `  \`${s.rule}\``,
  ]),
  '',
  `## Answers that depend on the state (${byState.length})`,
  '',
  ...byState.map((s) => `- **${s.carrier} ${s.page}${s.field ? ` ${s.field}` : ''}** "${s.label}": ${s.perState.map((p) => `${p.state} → "${p.value}" (${p.n})`).join('; ')}`),
  '',
  `## New intake mappings (${mapping.length})`,
  'Unmapped text boxes where agents typed the same intake field every time.',
  '',
  ...mapping.flatMap((s) => [
    `- **${s.carrier} ${s.page}${s.field ? ` ${s.field}` : ''}** "${s.label}": matches \`${s.path}\` in ${pct(s.share)} of ${s.answers} (${s.intakes} PDFs)`,
    `  \`${s.rule}\``,
  ]),
  '',
  `## Rules agents keep correcting (${review.length})`,
  '',
  ...review.map((s) => `- **${s.carrier} ${s.page}${s.field ? ` ${s.field}` : ''}** "${s.label}": changed in ${s.corrected} of ${s.filled} answers, ${s.intakes} PDFs (${pct(s.rate)}): ${s.changes.slice(0, 3).map((c) => `${c.value} ×${c.count}`).join('; ')}`),
  '',
  `## Questions agents leave as the page answers them (${pageAnswer.length})`,
  'Left to the agent, who let the page\'s own answer stand when leaving the page and never chose another. Weaker evidence: a default the agents kept, not proof it fits every client. Decide per question: map it from the intake, keep it with the agent (the note line below: known, no longer unfamiliar, still the agent\'s), or leave it as the page has it (`ignore`) only when it is not the client\'s decision.',
  '',
  ...pageAnswer.flatMap((s) => [
    `- **${s.carrier} ${s.page}${s.field ? ` ${s.field}` : ''}** "${s.label}": left as "${s.answer}" in ${pct(s.share)} of ${s.answers} answers (${s.quotes} quotes, ${s.intakes} PDFs)`,
    `  \`${s.rule}\``,
  ]),
  '',
];
const text = lines.join('\n');
if (opt('out')) fs.writeFileSync(opt('out'), text);
console.log(text);
