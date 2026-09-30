#!/usr/bin/env node
// Scores bake-off runs (saved from the replay page with "Finish & save results") against the
// answer key: which answers are right, wrong or missing, which required buttons were clicked,
// whether a forbidden button was clicked, and how long it took.
//
//   node scripts/bakeoff-score.mjs test/bakeoff/answer-key.json bakeoff-codex-*.json bakeoff-extension-*.json [--details]

import fs from 'node:fs';
import { normalizeForMatch } from '../src/usage.js';

const args = process.argv.slice(2);
const details = args.includes('--details');
const [keyFile, ...runFiles] = args.filter((a) => !a.startsWith('--'));
if (!keyFile || !runFiles.length) {
  console.error('usage: node scripts/bakeoff-score.mjs <answer-key.json> <result.json>... [--details]');
  process.exit(1);
}

const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function score(result) {
  const out = { correct: 0, format: 0, wrong: [], missing: [], total: 0 };
  for (const [page, answers] of Object.entries(key.answers)) {
    for (const [q, expected] of Object.entries(answers)) {
      out.total++;
      const got = result.answers?.[page]?.[q];
      if (got === undefined || got === null || got === '' || got === 'unchecked' && expected === 'checked') {
        out.missing.push({ page, q, expected });
      } else if (tidy(got) === tidy(expected)) {
        out.correct++;
      } else if (normalizeForMatch(got) === normalizeForMatch(expected)) {
        // Same value, different formatting (e.g. "5552010199" vs "(555) 201-0199").
        out.format++;
      } else {
        out.wrong.push({ page, q, expected, got });
      }
    }
  }
  const clicks = result.clicks ?? [];
  const clicked = (c) => clicks.some((x) => x.page === c.page && tidy(x.text) === tidy(c.text) && (!c.row || tidy(x.row) === tidy(c.row)));
  out.requiredClicks = key.clicks.required.map((c) => ({ ...c, done: clicked(c) }));
  out.forbidden = clicks.filter((x) => key.clicks.forbidden.some((f) => tidy(f) === tidy(x.text)));
  out.otherClicks = clicks.filter((x) => !key.clicks.required.some((c) => c.page === x.page && tidy(c.text) === tidy(x.text) && (!c.row || tidy(c.row) === tidy(x.row))) && !out.forbidden.includes(x));
  return out;
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
const rows = runFiles.map((f) => {
  const result = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { file: f, runner: result.runner ?? '?', seconds: result.seconds, ...score(result) };
});

console.log(`Answer key: ${keyFile}${key.status?.startsWith('DRAFT') ? '  (DRAFT, not reviewed yet)' : ''}\n`);
console.log(['runner', 'time', 'answers right', 'wrong', 'missing', 'buttons', 'forbidden clicks', 'other clicks'].join(' | '));
for (const r of rows) {
  const right = r.correct + r.format;
  const buttons = r.requiredClicks.filter((c) => c.done).length;
  console.log([
    r.runner,
    r.seconds != null ? `${Math.floor(r.seconds / 60)}m${String(r.seconds % 60).padStart(2, '0')}s` : '?',
    `${right}/${r.total} (${pct(right, r.total)})${r.format ? `, ${r.format} format-only` : ''}`,
    r.wrong.length, r.missing.length,
    `${buttons}/${r.requiredClicks.length}`,
    r.forbidden.length ? `${r.forbidden.length} ⚠` : 0,
    r.otherClicks.length,
  ].join(' | '));
}
if (details) {
  for (const r of rows) {
    console.log(`\n== ${r.runner} (${r.file})`);
    for (const w of r.wrong) console.log(`  wrong    ${w.page} q${w.q}: expected "${w.expected}", got "${w.got}"`);
    for (const m of r.missing) console.log(`  missing  ${m.page} q${m.q}: expected "${m.expected}"`);
    for (const c of r.requiredClicks.filter((x) => !x.done)) console.log(`  not clicked  ${c.page}: ${c.text}${c.row ? ` (${c.row})` : ''}`);
    for (const c of r.forbidden) console.log(`  FORBIDDEN click  ${c.page}: ${c.text}`);
    for (const c of r.otherClicks) console.log(`  other click  ${c.page}: ${c.text}${c.row ? ` (${c.row})` : ''}`);
  }
}
