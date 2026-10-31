#!/usr/bin/env node
// Builds the zip uploaded to the Chrome Web Store: only what the extension runs (no tests,
// captures, layouts, server or review scripts).
//
//   npm run package        -> dist/tni-rater-autofill-<version>.zip, and the same files unpacked
//                             in dist/tni-rater-autofill/ (for Load unpacked)
//
// Both carry the side panel built by Vite (vite.config.js) in place of its source files, and the
// page scripts stamped with their build (scripts/lib/package.mjs). The unpacked copy also gets a
// fixed extension ID, so its settings survive removing and loading it again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildPanel } from 'vite';
import { zipDirectory } from './lib/zip.mjs';
import { STAMPED, buildId, stampBuild, devManifest, bundledPanelFile, PACKAGED } from './lib/package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = PACKAGED;

// Every file the manifest names must be in the package.
const named = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons ?? {})].filter(Boolean);
for (const f of named) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`manifest names ${f}, which doesn't exist`);
  if (!INCLUDE.some((p) => f === p || f.startsWith(`${p}/`))) throw new Error(`manifest names ${f}, which isn't packaged`);
}

const copy = async (to, channel) => {
  fs.rmSync(to, { recursive: true, force: true });
  const keep = (src) => !src.endsWith('.DS_Store') && !bundledPanelFile(path.relative(root, src));
  for (const p of INCLUDE) fs.cpSync(path.join(root, p), path.join(to, p), { recursive: true, filter: keep });
  const build = buildId(STAMPED.map((f) => fs.readFileSync(path.join(root, f), 'utf8')));
  for (const f of STAMPED) fs.writeFileSync(path.join(to, f), stampBuild(fs.readFileSync(path.join(to, f), 'utf8'), build));
  // The panel, bundled (vite.config.js), stamped with which copy logs the usage events (the build's
  // mode), from which commit.
  await buildPanel({
    configFile: path.join(root, 'vite.config.js'),
    mode: channel,
    logLevel: 'warn',
    build: { outDir: path.join(to, 'sidepanel') },
  });
};

// The store zip, from a staged copy: the files as they are but the built panel, with the page
// scripts stamped.
const out = path.join(root, 'dist', `tni-rater-autofill-${manifest.version}.zip`);
const stage = path.join(root, 'dist', '.stage');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
await copy(stage, 'store');
fs.writeFileSync(out, zipDirectory(stage));
fs.rmSync(stage, { recursive: true, force: true });
// The unpacked copy (Load unpacked in chrome://extensions): the same, plus the fixed ID.
const unpacked = path.join(root, 'dist', 'tni-rater-autofill');
await copy(unpacked, 'unpacked');
fs.writeFileSync(path.join(unpacked, 'manifest.json'), `${JSON.stringify(devManifest(manifest), null, 2)}\n`);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${path.relative(root, out)}  (${kb} KB, version ${manifest.version})`);
