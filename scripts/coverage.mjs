#!/usr/bin/env node
// Which questions agents met on live carrier pages have no rule (and, for AmWINS, aren't in the
// mock): per carrier / state / product, from the usage log or from layout files.
//
//   npm run coverage                         # layouts built from server-data (npm run pull first)
//   node scripts/coverage.mjs <server-data | layout.json | folder>... [--md out.md] [--json]
//
// It's a report (the daily review includes it); exit code 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARRIERS } from '../src/carriers.js';
import { loadEvents } from './lib/events.mjs';
import { buildLayouts } from './lib/layouts.mjs';
import { coverage, idsInHtml } from './lib/coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCKS = { amwins: path.join(root, 'test/fixtures/amwins/application.html') };

export function loadLayouts(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    if (stat.isDirectory() && fs.existsSync(path.join(p, 'events'))) {
      out.push(...buildLayouts(loadEvents([p])));
    } else if (stat.isDirectory()) {
      for (const f of fs.readdirSync(p).filter((n) => n.endsWith('.json'))) out.push({ key: f.replace(/\.json$/, ''), layout: JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')) });
    } else {
      out.push({ key: path.basename(p, '.json'), layout: JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
  }
  return out.filter(({ layout }) => layout?.pages && layout.carrier && layout.carrier !== 'test');
}

export function report(layouts) {
  const lines = [];
  const results = [];
  for (const { key, layout } of layouts) {
    const carrier = CARRIERS.find((c) => c.id === layout.carrier);
    if (!carrier) continue;
    const mockIds = MOCKS[carrier.id] && fs.existsSync(MOCKS[carrier.id]) ? idsInHtml(MOCKS[carrier.id]) : null;
    const r = coverage(layout, carrier, { mockIds });
    results.push({ key, ...r });
    const t = r.totals;
    lines.push(`### ${key} (${r.quotes ?? '?'} quote${r.quotes === 1 ? '' : 's'})`, '',
      `${t.fields} questions: ${t.filled} filled by rules, ${t.ignored} left alone on purpose, ${t.agent} the agent's, ${t.unsure} can't tell offline, **${t.none} with no rule**${mockIds ? `, ${t.notInMock} not in the mock` : ''}.`, '');
    const missing = r.pages.flatMap((p) => p.rows.filter((x) => x.status === 'none').map((x) => `- ${p.page}: ${x.q ? `q${x.q} ` : ''}${x.id ? `#${x.id} ` : x.dataId ? `[data-id=${x.dataId}] ` : ''}"${x.caption}"${x.req ? ' (required)' : ''}${x.cond ? ' (follow-up)' : ''}${x.opts?.length ? ` {${x.opts.slice(0, 6).join(' / ')}}` : ''}`));
    if (missing.length) lines.push('No rule:', ...missing, '');
    const drift = r.pages.flatMap((p) => p.rows.filter((x) => x.notInMock).map((x) => `- ${p.page}: ${x.id ? `#${x.id}` : `[data-id=${x.dataId}]`} "${x.caption}"`));
    if (drift.length) lines.push('Not in the mock (the site changed, or the mock lacks this part):', ...drift, '');
  }
  return { markdown: lines.join('\n'), results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--md');
  if (!inputs.length) inputs.push('server-data');
  const { markdown, results } = report(loadLayouts(inputs));
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 1));
  else console.log(markdown || 'No layouts found.');
  if (opt('md')) fs.writeFileSync(opt('md'), `# Rule coverage of live pages\n\n${markdown}\n`);
}
