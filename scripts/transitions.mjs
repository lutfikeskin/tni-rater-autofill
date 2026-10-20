#!/usr/bin/env node
// When questions show, from the layouts agents' extensions record, as a review report:
//  - conditions: a question that shows only after a certain answer, with how often each side
//    was seen (scripts/lib/conditions.mjs), and the follow-ups whose condition is still unknown;
//  - not seen yet: answers of those triggers no layout has shown, a checklist for the next
//    recordings ("try Hauls hazmat? = No on Operations");
//  - transitions: what changed on a page right after an answer, counted across quotes
//    (scripts/lib/transitions.mjs).
// Observations from the recordings gathered, not the carrier's rules. Reports go to
// reviews/transitions-<date>.md (git-ignored: built from usage logs, review before sharing), or
// the file --out names (scripts/review.mjs puts it next to its own report).
//
//   node scripts/transitions.mjs server-data [more logs...] [--out file.md]

import fs from 'node:fs';
import path from 'node:path';
import { loadEvents } from './lib/events.mjs';
import { buildLayouts } from './lib/layouts.mjs';
import { layoutTransitions, summarizeTransitions } from './lib/transitions.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const inputs = outIdx >= 0 ? args.filter((_, i) => i !== outIdx && i !== outIdx + 1) : args;
if (!inputs.length || (outIdx >= 0 && !args[outIdx + 1])) {
  console.error('usage: node scripts/transitions.mjs <server-data folder | usage logs>... [--out file.md]');
  process.exit(1);
}

const events = loadEvents(inputs);
const layouts = buildLayouts(events);
const transitions = summarizeTransitions(layoutTransitions(events));
const md = [];
const p = (...lines) => md.push(...lines);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

p(`# When questions show (${new Date().toISOString().slice(0, 10)})`, '',
  'From page layouts recorded since 0.9.5. A condition is kept only when every layout of the page agrees with it; both counts are layouts. These are observations, not the carrier\'s rules.', '');

let conditions = 0, unknown = 0, unseen = 0;
const checklist = [];
for (const { key, layout } of layouts) {
  const rows = [];
  const pending = [];
  for (const [page, pg] of Object.entries(layout.pages)) {
    const open = pg.fields.filter((f) => f.condition === 'unknown').length;
    unknown += open;
    if (open) pending.push(`${page} (${open})`);
    for (const f of pg.fields.filter((x) => x.showWhen)) {
      conditions++;
      const w = f.showWhen;
      rows.push(`| ${cell(page)} | ${cell(f.caption)} | ${cell(w.caption)} is ${w.is.map(cell).join(' or ')} | ${w.seen.shown} / ${w.seen.hidden} |`);
      for (const v of w.unseen ?? []) { unseen++; checklist.push(`- ${key}, ${page}: set **${w.caption}** to **${v}** and see whether **${f.caption}** shows.`); }
    }
  }
  if (!rows.length && !pending.length) continue;
  p(`## ${key} (${layout.generated.quotes} quote${layout.generated.quotes === 1 ? '' : 's'})`, '');
  if (rows.length) p('| Page | Question | Shows when | Layouts shown / hidden |', '| --- | --- | --- | --- |', ...rows, '');
  // Too many to list one by one while the recordings are few; they shrink as layouts collect.
  if (pending.length) p(`Shows only sometimes, condition not known yet: ${pending.join(', ')}.`, '');
}
if (!conditions && !unknown) p('No follow-up questions in these layouts yet: a condition needs layouts of a page with the question both showing and hidden.', '');

p('## Not seen yet', '', checklist.length
  ? 'Answers of a trigger that no layout has shown. Trying them in the next recordings shows whether the follow-up appears.'
  : 'Nothing: every answer of the triggers above has been seen.', '', ...checklist, '');

p('## What changed after an answer', '', transitions.length
  ? 'Two layouts of a page in a row with only answers on that page changed between them. "fill" is the extension\'s own answer.'
  : 'No transitions yet.', '');
if (transitions.length) {
  p('| Page | After | Changed | Quotes | States |', '| --- | --- | --- | --- | --- |');
  for (const t of transitions) p(`| ${cell(t.page)} | ${cell(t.cause)} | ${cell(t.effect)} | ${t.quotes} | ${t.states.join(', ')} |`);
  p('');
}

const out = outIdx >= 0 ? args[outIdx + 1] : path.join('reviews', `transitions-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${md.join('\n')}\n`);
console.log(`${out}: ${conditions} condition(s), ${unknown} unknown, ${unseen} answer(s) not seen yet, ${transitions.length} transition(s)`);
