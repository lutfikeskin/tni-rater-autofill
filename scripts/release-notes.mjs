#!/usr/bin/env node
// @ts-check
// A version's release: the commit on main that set manifest.json to it, and its notes (the pull
// requests merged since the version before it). .github/workflows/release-tag.yml tags it
// v<version> and makes a GitHub Release from these; run here, it changes nothing.
//
//   node scripts/release-notes.mjs [--version 0.9.32] [--ref origin/main] [--out notes.md]
//
// Prints version=, tag=, target= and previous= lines (the workflow appends them to $GITHUB_OUTPUT);
// the notes go to --out, else after them. Without --version: manifest.json's. Exits 1 when main
// never had that version.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/ledger.mjs';
import { LOG_FORMAT, parseLog, releaseNotes, releaseOf } from './lib/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
/** @param {string} name */
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
/** @param {...string} a */
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

const version = arg('--version') || JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const ref = arg('--ref') || 'HEAD';
const release = releaseOf(git, version, ref);
if (!release) {
  console.error(`release-notes: ${ref} never had manifest.json version ${version}.`);
  process.exit(1);
}
const commits = release.previousTarget ? parseLog(git('log', '--first-parent', `--format=${LOG_FORMAT}`, `${release.previousTarget}..${release.target}`) ?? '') : [];
const notes = releaseNotes({ version, previous: release.previous, commits });
console.log(`version=${version}\ntag=v${version}\ntarget=${release.target}\nprevious=${release.previous ? `v${release.previous}` : ''}`);
const out = arg('--out');
if (out) fs.writeFileSync(out, notes);
else console.log(`\n${notes}`);
