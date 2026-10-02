#!/usr/bin/env node
// Builds the zip uploaded to the Chrome Web Store: only what the extension runs (no tests,
// captures, layouts, server or review scripts).
//
//   npm run package        -> dist/tni-rater-autofill-<version>.zip, and the same files unpacked
//                             in dist/tni-rater-autofill/ (for Load unpacked)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = ['manifest.json', 'background.js', 'icons', 'lib', 'sidepanel', 'src'];

// Every file the manifest names must be in the package.
const named = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons ?? {})].filter(Boolean);
for (const f of named) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`manifest names ${f}, which doesn't exist`);
  if (!INCLUDE.some((p) => f === p || f.startsWith(`${p}/`))) throw new Error(`manifest names ${f}, which isn't packaged`);
}

const out = path.join(root, 'dist', `tni-rater-autofill-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-rq', '-X', out, ...INCLUDE, '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
// The unpacked copy (Load unpacked in chrome://extensions) is rebuilt from the same files.
const unpacked = path.join(root, 'dist', 'tni-rater-autofill');
fs.rmSync(unpacked, { recursive: true, force: true });
for (const p of INCLUDE) fs.cpSync(path.join(root, p), path.join(unpacked, p), { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${path.relative(root, out)}  (${kb} KB, version ${manifest.version})`);
