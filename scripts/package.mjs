#!/usr/bin/env node
// Builds the zip uploaded to the Chrome Web Store: only what the extension runs (no tests,
// captures, layouts, server or review scripts).
//
//   npm run package        -> dist/tni-rater-autofill-<version>.zip, and the same files unpacked
//                             in dist/tni-rater-autofill/ (for Load unpacked)
//
// Both carry the page scripts stamped with their build (scripts/lib/package.mjs). The unpacked
// copy also gets a fixed extension ID, so its settings survive removing and loading it again.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAMPED, buildId, stampBuild, devManifest } from './lib/package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = ['manifest.json', 'background.js', 'icons', 'lib', 'sidepanel', 'src'];

// Every file the manifest names must be in the package.
const named = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons ?? {})].filter(Boolean);
for (const f of named) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`manifest names ${f}, which doesn't exist`);
  if (!INCLUDE.some((p) => f === p || f.startsWith(`${p}/`))) throw new Error(`manifest names ${f}, which isn't packaged`);
}

const copy = (to) => {
  fs.rmSync(to, { recursive: true, force: true });
  for (const p of INCLUDE) fs.cpSync(path.join(root, p), path.join(to, p), { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
  const build = buildId(STAMPED.map((f) => fs.readFileSync(path.join(root, f), 'utf8')));
  for (const f of STAMPED) fs.writeFileSync(path.join(to, f), stampBuild(fs.readFileSync(path.join(to, f), 'utf8'), build));
};

// The store zip, from a staged copy: the files as they are, with the page scripts stamped.
const out = path.join(root, 'dist', `tni-rater-autofill-${manifest.version}.zip`);
const stage = path.join(root, 'dist', '.stage');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
copy(stage);
execFileSync('zip', ['-rq', '-X', out, ...INCLUDE, '-x', '*.DS_Store'], { cwd: stage, stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
// The unpacked copy (Load unpacked in chrome://extensions): the same, plus the fixed ID.
const unpacked = path.join(root, 'dist', 'tni-rater-autofill');
copy(unpacked);
fs.writeFileSync(path.join(unpacked, 'manifest.json'), `${JSON.stringify(devManifest(manifest), null, 2)}\n`);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${path.relative(root, out)}  (${kb} KB, version ${manifest.version})`);
