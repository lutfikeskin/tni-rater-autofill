#!/usr/bin/env node
// Manual captures (Capture page layout, Alt+Shift+C) read as a story per scenario: each capture in
// order, the page and step it was on, the note taken with it, and what changed since the previous
// capture of that scenario on the same page: questions that appeared or went away, choice lists
// and required flags that changed, and the picks that changed. For writing carrier rules and mock
// pages from a series like "answer Yes, capture; answer No, capture". What it lists was seen in
// those captures; it isn't the carrier's rule. Reads capture files (version 2) from the folders
// given (default layouts/, kept out of git) and writes reviews/captures-<date>.md.
//
//   node scripts/captures.mjs layouts [more folders or files...]

import fs from 'node:fs';
import path from 'node:path';
import { diff } from './lib/transitions.mjs';
import { fieldId } from './lib/conditions.mjs';

export function readCaptures(paths) {
  const files = [];
  const walk = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else if (/^capture-.*\.json$/.test(path.basename(p))) files.push(p);
  };
  paths.forEach(walk);
  return files.flatMap((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data.kind === 'page-capture' && data.version >= 2 ? [{ ...data, file }] : [];
    } catch { return []; }
  });
}

// A capture as a layout: its controls from every frame.
const asLayout = (c) => ({ fields: c.frames.flatMap((f) => f.controls ?? []) });
const label = (f) => f.label ?? f.q ?? '';

function picksChanged(before, after) {
  const picks = (c) => {
    const m = new Map();
    for (const f of asLayout(c).fields) { const id = fieldId(f); if (id !== null && f.selected) m.set(id, f); }
    return m;
  };
  const a = picks(before);
  const b = picks(after);
  return [...b].filter(([id, f]) => a.has(id) && a.get(id).selected !== f.selected)
    .map(([id, f]) => `${label(f)}: ${a.get(id).selected} → ${f.selected}`);
}

export function captureStory(captures) {
  const scenarios = new Map();
  for (const c of captures) {
    const key = `${c.carrier} · ${c.scenario}`;
    scenarios.set(key, [...(scenarios.get(key) ?? []), c]);
  }
  const md = [];
  for (const [key, list] of [...scenarios].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.n - b.n || a.capturedAt.localeCompare(b.capturedAt));
    md.push(`## ${key}`, '');
    let previous = null;
    for (const c of list) {
      const where = `${c.page}${c.step ? ` › ${c.step}` : ''}${c.view ? ` (${c.view})` : ''}`;
      const fields = asLayout(c).fields.length;
      md.push(`### ${c.n}. ${where}${c.note ? ` — ${c.note}` : ''}`, '', `${fields} question${fields === 1 ? '' : 's'}, ${c.capturedAt}.`);
      const top = c.frames.find((f) => f.isTopFrame);
      for (const list of top?.openLists ?? []) md.push(`- Open list${list.label ? ` for **${list.label}**` : ''}: ${list.options.join(' · ')}${list.optionsTruncated ? ' …' : ''}`);
      for (const m of top?.messages ?? []) md.push(`- Message: ${m}`);
      if (previous && previous.page === c.page && previous.step === c.step) {
        const d = diff(asLayout(previous), asLayout(c));
        const lines = [
          ...picksChanged(previous, c).map((x) => `- Answer: ${x}`),
          ...d.appeared.map((x) => `- Appeared: ${x}`), ...d.removed.map((x) => `- Went away: ${x}`),
          ...d.options.map((o) => `- Choices of ${o.question}: ${[...o.added.map((x) => `+${x}`), ...o.removed.map((x) => `−${x}`)].join(' ')}`),
          ...d.required.map((r) => `- ${r.question}: ${r.required ? 'now required' : 'no longer required'}`),
        ];
        md.push('', lines.length ? `Since capture ${previous.n}:` : `Same questions as capture ${previous.n}.`, ...lines);
      } else if (previous) {
        md.push('', `Another page than capture ${previous.n} (${previous.page}${previous.step ? ` › ${previous.step}` : ''}).`);
      }
      md.push('');
      previous = c;
    }
  }
  return md;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const inputs = process.argv.slice(2).length ? process.argv.slice(2) : ['layouts'];
  const captures = readCaptures(inputs.filter((p) => fs.existsSync(p)));
  const md = [`# Manual captures (${new Date().toISOString().slice(0, 10)})`, '',
    'Each scenario in the order captured. Changes are between consecutive captures of the same page; they were seen, not proven.', '',
    ...(captures.length ? captureStory(captures) : ['No captures (version 2) found. Take some with Capture page layout or Alt+Shift+C, then move them to layouts/.', ''])];
  const out = path.join('reviews', `captures-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${md.join('\n')}\n`);
  console.log(`${out}: ${captures.length} capture(s) in ${new Set(captures.map((c) => `${c.carrier}|${c.scenario}`)).size} scenario(s)`);
}
