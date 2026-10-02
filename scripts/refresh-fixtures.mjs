#!/usr/bin/env node
// Copies the per-state Progressive layouts built from the usage log (npm run layouts ->
// captures/progressive/generated/) into test/fixtures/progressive/, which is committed so the
// replay regression run (npm run e2e -- --fixtures) runs in CI too. Refuses any layout that
// matches a client-data pattern (scripts/lib/privacy.mjs).
//
//   npm run layouts && npm run fixtures:progressive
//   then: npm run e2e -- --update   (accept the new fixtures' results into the baseline)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPii } from './lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'captures/progressive/generated');
const to = path.join(root, 'test/fixtures/progressive');
if (!fs.existsSync(from)) { console.error('No generated layouts: run npm run layouts first.'); process.exit(1); }
fs.mkdirSync(to, { recursive: true });
let refused = 0;
for (const f of fs.readdirSync(from).filter((n) => n.endsWith('.json')).sort()) {
  const text = fs.readFileSync(path.join(from, f), 'utf8');
  const hits = findPii(text);
  if (hits.length) {
    refused++;
    console.error(`${f}: refused, looks like client data: ${hits.slice(0, 5).map((h) => `${h.kind} "${h.match}"`).join(', ')}`);
    continue;
  }
  fs.writeFileSync(path.join(to, f), text);
  console.log(`${f} -> test/fixtures/progressive/`);
}
process.exit(refused ? 1 : 0);
