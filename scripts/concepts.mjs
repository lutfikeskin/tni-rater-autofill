#!/usr/bin/env node
// @ts-check
// Writes docs/concepts.md, the concept × carrier matrix (scripts/lib/concepts.mjs), from
// src/concepts.js and every carrier rule's `concept`.
//
//   npm run concepts            # writes docs/concepts.md
//   npm run concepts -- --check # exits 1 when docs/concepts.md is not current

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conceptMarkdown } from './lib/concepts.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'concepts.md');
const text = conceptMarkdown();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('docs/concepts.md is not current: run npm run concepts');
    process.exit(1);
  }
  console.log('docs/concepts.md is current');
} else {
  fs.writeFileSync(file, text);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
