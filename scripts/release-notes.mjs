#!/usr/bin/env node
// @ts-check
// A version's release: the commit on main that set manifest.json to it, and its notes (the pull
// requests merged since the version before it). .github/workflows/release-tag.yml tags it
// v<version> and makes a GitHub Release from these; run here, it changes nothing.
//
//   node scripts/release-notes.mjs [--version 0.9.32] [--ref origin/main] [--before <sha>] [--out notes.md]
//
// Prints version=, tag=, target= and previous= lines (the workflow appends them to $GITHUB_OUTPUT);
// the notes go to --out, else after them. Without --version: the manifest's at --ref. With
// --before (the push's previous head), a version whose commit was already there prints an empty
// tag=. Exits 1 when the ref never had that version.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/ledger.mjs';
import { LOG_FORMAT, broughtBy, parseLog, releaseNotes, releaseOf } from './lib/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
/** @param {string} name */
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
/** @param {...string} a */
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

const ref = arg('--ref') || 'HEAD';
const version = arg('--version') || JSON.parse(git('show', `${ref}:manifest.json`) ?? fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const release = releaseOf(git, version, ref);
if (!release) {
  console.error(`release-notes: ${ref} never had manifest.json version ${version}.`);
  process.exit(1);
}
// The workflow's push: a version whose commit main already had before it is not tagged (no
// backfill), so `tag=` is empty and the workflow stops.
const before = arg('--before');
if (args.includes('--before') && !broughtBy(git, release.target, before)) {
  console.log(`version=${version}\ntag=\ntarget=${release.target}\nprevious=`);
  console.error(`release-notes: v${version} (${release.target.slice(0, 7)}) was on ${ref} before this push: not tagged.`);
  process.exit(0);
}
const commits = release.previousTarget ? parseLog(git('log', '--first-parent', `--format=${LOG_FORMAT}`, `${release.previousTarget}..${release.target}`) ?? '') : [];
const notes = releaseNotes({ version, previous: release.previous, commits });
console.log(`version=${version}\ntag=v${version}\ntarget=${release.target}\nprevious=${release.previous ? `v${release.previous}` : ''}`);
const out = arg('--out');
if (out) fs.writeFileSync(out, notes);
else console.log(`\n${notes}`);
