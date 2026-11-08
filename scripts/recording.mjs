#!/usr/bin/env node
// A developer recording as a story (docs/developer-recording.md): the pages and steps with their
// times, then each step's actions. Reads the zip the panel saved, or its unzipped folder, and writes
// reviews/recording-<id>.md (kept out of git), or the file --out names, with its numbers as data
// beside it (reviews/recording-<id>.summary.json, or the --out file's name with .summary.json).
// With --compare, two recordings of one quote side by side instead: what A answered that B didn't,
// the buttons, the waits by kind and the totals (reviews/recording-compare-<a>-vs-<b>.md).
//
//   npm run recording -- layouts/recordings/recording-<id>.zip [--out file.md]
//   npm run recording -- --compare <a zip or folder> <b zip or folder> [--out file.md]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, compareReport, readRecording, recordingReport, recordingSummary } from './lib/recording.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { source, out, compare } = cliArgs(process.argv.slice(2));
if (compare) {
  if (compare.length !== 2) {
    console.error('Usage: npm run recording -- --compare <a recording> <b recording> [--out file.md]');
    process.exit(1);
  }
  const [a, b] = compare.map((s) => recordingSummary(readRecording(s)));
  const file = out ?? path.join(root, 'reviews', `recording-compare-${a.id}-vs-${b.id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, compareReport(a, b));
  console.log(`${a.id} vs ${b.id} → ${path.relative(process.cwd(), file)}`);
  process.exit(0);
}
if (!source) {
  console.error('Usage: npm run recording -- <recording zip or folder> [--out file.md], or --compare <a> <b>');
  process.exit(1);
}
const recording = readRecording(source);
const file = out ?? path.join(root, 'reviews', `recording-${recording.manifest.id}.md`);
const summaryFile = file.replace(/(\.md)?$/, '.summary.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, recordingReport(recording));
fs.writeFileSync(summaryFile, `${JSON.stringify(recordingSummary(recording), null, 2)}\n`);
console.log(`${recording.events.length} events → ${path.relative(process.cwd(), file)} and ${path.relative(process.cwd(), summaryFile)}`);
