#!/usr/bin/env node
// Builds carrier page layouts, per state and product, from the page_layout events agents'
// extensions record. Output goes to captures/<carrier>/generated/<carrier>_<state>_<class>_<vehicles>.json
// and can be opened on the replay test page (test/replay/).
//
//   node scripts/build-layouts.mjs server-data [more logs...] [--out captures]

import fs from 'node:fs';
import path from 'node:path';
import { loadEvents } from './lib/events.mjs';
import { buildLayouts } from './lib/layouts.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'captures';
const inputs = outIdx >= 0 ? args.filter((_, i) => i !== outIdx && i !== outIdx + 1) : args;
if (!inputs.length) {
  console.error('usage: node scripts/build-layouts.mjs <server-data folder | usage logs>... [--out captures]');
  process.exit(1);
}

const layouts = buildLayouts(loadEvents(inputs));
if (!layouts.length) console.log('No page layouts in these logs yet (they are recorded after each Fill).');
for (const { key, layout } of layouts) {
  const dir = path.join(outDir, layout.carrier, 'generated');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 1)}\n`);
  const pages = Object.entries(layout.pages);
  console.log(`${file}: ${pages.length} pages, ${pages.reduce((n, [, p]) => n + p.fields.length, 0)} questions, from ${layout.generated.quotes} quote(s)`);
}
