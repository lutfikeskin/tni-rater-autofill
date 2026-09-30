#!/usr/bin/env node
// Turns exported usage logs into a to-do list for improving the extension.
//
//   node scripts/summarize-usage.mjs server-data [rater-usage-*.json ...] [--json]
//
// Sections:
//   intakes      how many, which warning codes come up, which intake fields agents correct
//   corrections  fields the agent changed after autofill (wrong mapping or wrong translation)
//   unmapped     fields the agent filled that autofill didn't, and which intake field the typed
//                value matched on their computer: candidates for new mapping rules
//   failures     fields autofill couldn't set, and why
//   pages        time spent per carrier page, fill runs and results

import { loadEvents } from './lib/events.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node scripts/summarize-usage.mjs <server-data folder | usage-log.json>... [--json]');
  process.exit(1);
}

const events = loadEvents(files);
const tally = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const top = (map, n = 25) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
const fieldName = (e) => `${e.carrier ?? '?'} ${e.page ?? '?'} ${e.q ? `q${e.q} ` : ''}"${e.label ?? ''}"`;

const sessions = new Set(events.map((e) => e.session).filter(Boolean));
const intakes = new Map(); // intakeId -> summary
const warningCodes = new Map();
const warningChecked = new Map();
const intakeEdits = new Map();
const corrections = new Map(); // field -> Map(from->to, count)
const unmapped = new Map(); // field -> Map(matched intake path, count)
const failures = new Map();
const fillRuns = new Map(); // carrier page -> { runs, filled, failed, noData, ms }
const agents = new Map();

for (const e of events) {
  if (e.agent) tally(agents, e.agent);
  switch (e.type) {
    case 'intake_loaded':
      intakes.set(e.intakeId, e);
      break;
    case 'warning_checked':
      if (e.checked) tally(warningChecked, e.code);
      break;
    case 'intake_edit':
      tally(intakeEdits, `${e.path.replace(/\[\d+\]/g, '[]')}${e.warnings?.length ? ` (flagged: ${e.warnings.join(', ')})` : ''}`);
      break;
    case 'fill_run': {
      const k = `${e.carrier} ${e.page}`;
      const r = fillRuns.get(k) ?? { runs: 0, filled: 0, failed: 0, noData: 0, ms: 0 };
      r.runs++; r.filled += e.filled; r.failed += e.failed; r.noData += e.noData; r.ms += e.ms ?? 0;
      fillRuns.set(k, r);
      break;
    }
    case 'fill_field':
      if (e.result === 'failed') tally(failures, `${fieldName(e)} — ${e.reason ?? ''}`);
      break;
    case 'field_change': {
      if (e.by !== 'agent') break;
      const k = fieldName(e);
      if (e.autofilled && e.vsAutofill === 'different') {
        const change = e.kind === 'text' ? `${e.autofilled}: typed value differs` : `${e.autofilled}: "${e.from}" → "${e.to}"`;
        const m = corrections.get(k) ?? new Map();
        tally(m, change);
        corrections.set(k, m);
      } else if (!e.autofilled) {
        const m = unmapped.get(k) ?? new Map();
        const what = e.kind === 'text' ? (e.matchesIntake?.length ? `matches ${e.matchesIntake.join(' / ')}` : 'no intake match') : `chose "${e.to}"`;
        tally(m, what);
        unmapped.set(k, m);
      }
      break;
    }
    default:
  }
}
for (const s of intakes.values()) for (const w of s.warnings ?? []) tally(warningCodes, w.code);

// Time per page: gaps between consecutive page views in a session.
const pageTime = new Map();
const bySession = new Map();
for (const e of events.filter((x) => x.type === 'page_view')) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);
for (const views of bySession.values()) {
  for (let i = 0; i + 1 < views.length; i++) {
    const secs = (Date.parse(views[i + 1].t) - Date.parse(views[i].t)) / 1000;
    if (secs > 0 && secs < 3600) {
      const k = `${views[i].carrier} ${views[i].page}`;
      const p = pageTime.get(k) ?? { visits: 0, secs: 0 };
      p.visits++; p.secs += secs;
      pageTime.set(k, p);
    }
  }
}

const summary = {
  totals: { events: events.length, sessions: sessions.size, intakes: intakes.size, agents: Object.fromEntries(agents) },
  intakeWarnings: top(warningCodes).map(([code, n]) => ({ code, intakes: n, checkedOff: warningChecked.get(code) ?? 0 })),
  intakeEdits: top(intakeEdits).map(([field, n]) => ({ field, n })),
  corrections: [...corrections].map(([field, m]) => ({ field, changes: top(m, 5).map(([c, n]) => `${n}× ${c}`) })),
  unmapped: [...unmapped].map(([field, m]) => ({ field, seen: [...m.values()].reduce((a, b) => a + b, 0), what: top(m, 5).map(([c, n]) => `${n}× ${c}`) }))
    .sort((a, b) => b.seen - a.seen),
  failures: top(failures).map(([what, n]) => ({ what, n })),
  pages: [...new Set([...fillRuns.keys(), ...pageTime.keys()])].map((k) => ({
    page: k,
    avgSeconds: pageTime.get(k) ? Math.round(pageTime.get(k).secs / pageTime.get(k).visits) : null,
    fills: fillRuns.get(k) ?? null,
  })),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const t = summary.totals;
  console.log(`${t.events} events · ${t.sessions} sessions · ${t.intakes} intakes · agents: ${Object.keys(t.agents).join(', ') || '(no initials set)'}\n`);
  const section = (title, rows, line) => {
    console.log(`== ${title} (${rows.length})`);
    for (const r of rows) console.log(`  ${line(r)}`);
    console.log('');
  };
  section('Intake problems (warning code: intakes, checked off)', summary.intakeWarnings, (r) => `${r.code}: ${r.intakes}, ${r.checkedOff}`);
  section('Intake fields agents corrected in the panel', summary.intakeEdits, (r) => `${r.n}× ${r.field}`);
  section('Autofill answers agents changed', summary.corrections, (r) => `${r.field}\n      ${r.changes.join('\n      ')}`);
  section('Fields agents filled that autofill did not (mapping candidates)', summary.unmapped, (r) => `${r.seen}× ${r.field}\n      ${r.what.join('\n      ')}`);
  section('Autofill failures', summary.failures, (r) => `${r.n}× ${r.what}`);
  section('Pages', summary.pages, (r) => `${r.page}: ${r.avgSeconds ?? '?'} s avg${r.fills ? ` · ${r.fills.runs} fills, ${r.fills.filled} filled, ${r.fills.failed} failed, ${r.fills.noData} no data` : ''}`);
}
