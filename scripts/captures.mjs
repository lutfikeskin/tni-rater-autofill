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
import { fileURLToPath } from 'node:url';
import { diff } from './lib/transitions.mjs';
import { fieldId } from './lib/conditions.mjs';

// Capture files that couldn't be read are returned too, so the report names them instead of
// quietly comparing the captures on either side as if no step were missing.
export function readCaptures(paths) {
  const files = [];
  const walk = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else if (/^capture-.*\.json$/.test(path.basename(p))) files.push(p);
  };
  paths.forEach(walk);
  const captures = [];
  const unreadable = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { unreadable.push({ file, error: String(e.message).slice(0, 120) }); continue; }
    if (data?.kind !== 'page-capture' || !(data.version >= 2)) continue; // version 1 captures: no scenario
    if (!Array.isArray(data.frames) || typeof data.capturedAt !== 'string') { unreadable.push({ file, error: 'not a complete capture' }); continue; }
    captures.push({ ...data, file });
  }
  return { captures, unreadable };
}

// A capture as a layout: its controls from every frame.
const asLayout = (c) => ({ fields: c.frames.flatMap((f) => f.controls ?? []) });
const label = (f) => f.label ?? f.q ?? '';

// Picks of choice questions, unanswered ones included (an answer chosen from nothing is a change).
// A question repeated on the page (a row per vehicle) can't be matched row to row: left out.
function picksChanged(before, after) {
  const picks = (c) => {
    const m = new Map();
    const repeated = new Set();
    for (const f of asLayout(c).fields) {
      const id = fieldId(f);
      if (id === null || f.kind === 'text' || f.selected === undefined) continue;
      if (m.has(id)) repeated.add(id);
      m.set(id, f);
    }
    for (const id of repeated) m.delete(id);
    return { m, repeated };
  };
  const a = picks(before);
  const b = picks(after);
  const shown = (v) => (v ? v : '∅');
  // The same answer whatever its spacing or case (a redraw can change only that).
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [...b.m].filter(([id, f]) => a.m.has(id) && !a.repeated.has(id) && norm(a.m.get(id).selected) !== norm(f.selected))
    .map(([id, f]) => `${label(f)}: ${shown(a.m.get(id).selected)} → ${shown(f.selected)}`);
}

export function captureStory(captures) {
  const scenarios = new Map();
  for (const c of captures) {
    // Per quote too: two clients' scenarios redacted to the same name are two scenarios.
    const key = `${c.carrier} · ${c.scenario}${c.quote ? ` (quote ${c.quote.slice(0, 4)})` : ''}`;
    scenarios.set(key, [...(scenarios.get(key) ?? []), c]);
  }
  const md = [];
  for (const [key, list] of [...scenarios].sort(([a], [b]) => a.localeCompare(b))) {
    // In the order taken: numbers can repeat when a scenario's name is used again.
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.n - b.n);
    md.push(`## ${key}`, '');
    // Each capture is compared with the last one of the same page, step, view (tab and vehicle)
    // and intake context (state, product, coverages): a scenario name used again for another
    // intake, or a detour to another vehicle, never pairs unlike pages.
    const lastOf = new Map();
    const sameAs = (c) => JSON.stringify([c.page, c.step ?? null, c.view ?? null, c.context ?? null]);
    let previous = null;
    for (const c of list) {
      const where = `${c.page}${c.step ? ` › ${c.step}` : ''}${c.view ? ` (${c.view})` : ''}`;
      const fields = asLayout(c).fields.length;
      md.push(`### ${c.n}. ${where}${c.note ? ` — ${c.note}` : ''}`, '', `${fields} question${fields === 1 ? '' : 's'}, ${c.capturedAt}.`);
      // Every frame's lists and messages (a carrier's form may sit in a frame), its frame named.
      for (const frame of c.frames) {
        const where = frame.isTopFrame ? '' : ` (frame ${frame.frame ?? '?'})`;
        for (const list of frame.openLists ?? []) {
          md.push(`- Open list${list.label ? ` for **${list.label}**` : ''}${where}: ${list.options.length ? `${list.options.join(' · ')}${list.optionsTruncated ? ' …' : ''}` : '(choices not kept)'}`);
        }
        for (const m of frame.messages ?? []) md.push(`- Message${where}: ${m}`);
      }
      const before = lastOf.get(sameAs(c));
      if (before) {
        const d = diff(asLayout(before), asLayout(c));
        const lines = [
          ...picksChanged(before, c).map((x) => `- Answer: ${x}`),
          ...d.appeared.map((x) => `- Appeared: ${x}`), ...d.removed.map((x) => `- Went away: ${x}`),
          ...d.options.map((o) => `- Choices of ${o.question}: ${[...o.added.map((x) => `+${x}`), ...o.removed.map((x) => `−${x}`)].join(' ')}`),
          ...d.required.map((r) => `- ${r.question}: ${r.required ? 'now required' : 'no longer required'}`),
        ];
        md.push('', lines.length ? `Since capture ${before.n}:` : `Same questions as capture ${before.n}.`, ...lines);
      } else if (previous) {
        md.push('', 'First capture of this page, step, view and intake in the scenario: nothing to compare with.');
      }
      md.push('');
      lastOf.set(sameAs(c), c);
      previous = c;
    }
  }
  return md;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2).length ? process.argv.slice(2) : ['layouts'];
  const { captures, unreadable } = readCaptures(inputs.filter((p) => fs.existsSync(p)));
  const md = [`# Manual captures (${new Date().toISOString().slice(0, 10)})`, '',
    'Each scenario in the order captured. Changes are between consecutive captures of the same page; they were seen, not proven.', '',
    ...(unreadable.length ? ['**Not read** (a step may be missing from the stories below):', ...unreadable.map((u) => `- ${u.file}: ${u.error}`), ''] : []),
    ...(captures.length ? captureStory(captures) : ['No captures (version 2) found. Take some with Capture page layout or Alt+Shift+C, then move them to layouts/.', ''])];
  const out = path.join('reviews', `captures-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${md.join('\n')}\n`);
  console.log(`${out}: ${captures.length} capture(s) in ${new Set(captures.map((c) => `${c.carrier}|${c.scenario}|${c.quote}`)).size} scenario(s)${unreadable.length ? `, ${unreadable.length} file(s) not read` : ''}`);
  if (unreadable.length) process.exitCode = 1;
}
