#!/usr/bin/env node
// A developer recording as a story (docs/developer-recording.md): the pages and steps with their
// times, then each step's actions. Reads the zip the panel saved, or its unzipped folder, and writes
// reviews/recording-<id>.md (kept out of git), or the file --out names.
//
//   npm run recording -- layouts/recordings/recording-<id>.zip [--out file.md]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, readRecording, recordingReport } from './lib/recording.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { source, out } = cliArgs(process.argv.slice(2));
if (!source) {
  console.error('Usage: npm run recording -- <recording zip or folder> [--out file.md]');
  process.exit(1);
}
const recording = readRecording(source);
const file = out ?? path.join(root, 'reviews', `recording-${recording.manifest.id}.md`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, recordingReport(recording));
console.log(`${recording.events.length} events → ${path.relative(process.cwd(), file)}`);
