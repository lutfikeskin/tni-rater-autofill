#!/usr/bin/env node
// Which lines of the project's own code the node:test files run (audit 2026-11-07, QA-07): Node's
// built-in coverage, no dependency. Not a gate: it says where no test reaches, for a reviewer to read.
//
//   npm run test:coverage   -> the tests as npm test runs them (node:test part), then
//                              coverage/lcov.info (for an editor or a coverage viewer) and
//                              coverage/summary.txt (the per-file table Node prints)
//
// The tests themselves, the vendored lib/ and node_modules are left out. The panel's Vitest files
// aren't in it. (`npm run coverage` is another thing: layout coverage of the usage server's data.)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'coverage');
fs.mkdirSync(out, { recursive: true });

export const COVERAGE_ARGS = [
  '--test', '--experimental-test-coverage',
  '--test-coverage-exclude=test/**', '--test-coverage-exclude=lib/**', '--test-coverage-exclude=node_modules/**',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${path.join('coverage', 'lcov.info')}`,
  'test/*.test.mjs',
];

const child = spawn(process.execPath, COVERAGE_ARGS, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
let text = '';
child.stdout.on('data', (chunk) => { process.stdout.write(chunk); text += chunk; });
child.on('close', (code) => {
  // The table between Node's own markers, without its "ℹ " prefixes.
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => /start of coverage report/.test(l));
  const to = lines.findIndex((l) => /end of coverage report/.test(l));
  const table = from >= 0 && to > from ? lines.slice(from + 1, to).map((l) => l.replace(/^ℹ /, '')).join('\n') : '(no coverage report: the run ended before it)';
  fs.writeFileSync(path.join(out, 'summary.txt'), `${table}\n`);
  console.log(`\ncoverage/lcov.info and coverage/summary.txt written${code ? `; the tests exited ${code}` : ''}.`);
  process.exitCode = code ?? 1;
});
