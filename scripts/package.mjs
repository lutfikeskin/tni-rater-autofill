#!/usr/bin/env node
// Builds the zip uploaded to the Chrome Web Store: only what the extension runs (no tests,
// captures, layouts, server or review scripts).
//
//   npm run package        -> dist/tni-rater-autofill-<version>.zip, and the same files unpacked
//                             in dist/tni-rater-autofill/ (for Load unpacked)
//   npm run package -- --label test-build
//                          -> dist/tni-rater-autofill-<version>-test-build-<commit>.zip (zipName)
//
// Both carry the side panel built by Vite (vite.config.js) in place of its source files, the fill
// engine built from src/kit/ (scripts/lib/kit.mjs) at src/content/pagekit.js, and the page scripts
// stamped with their build (scripts/lib/package.mjs), and THIRD_PARTY_NOTICES.txt: the licences of
// the other people's code they carry. The store zip leaves the source maps out; they go in
// dist/tni-rater-autofill-<version>-sourcemaps.zip beside it. The unpacked copy keeps its maps and
// also gets a fixed extension ID, so its settings survive removing and loading it again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildPanel } from 'vite';
import { zipDirectory } from './lib/zip.mjs';
import { STAMPED, buildId, stampBuild, devManifest, storeManifest, bundledPanelFile, kitSourceFile, PACKAGED, packagedCommit, zipName, mapsZipName, withoutMapUrl, noticesPlugin, packageOf, thirdPartyNotices, NOTICES_FILE } from './lib/package.mjs';
import { buildKit, KIT_OUTPUT } from './lib/kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = PACKAGED;

// Every file the manifest names must be in the package.
const named = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons ?? {})].filter(Boolean);
for (const f of named) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`manifest names ${f}, which doesn't exist`);
  if (!INCLUDE.some((p) => f === p || f.startsWith(`${p}/`))) throw new Error(`manifest names ${f}, which isn't packaged`);
}

// The fill engine, built from src/kit/ once for both copies (scripts/lib/kit.mjs).
const kit = await buildKit();

const copy = async (to, channel) => {
  fs.rmSync(to, { recursive: true, force: true });
  const keep = (src) => !src.endsWith('.DS_Store') && !bundledPanelFile(path.relative(root, src)) && !kitSourceFile(path.relative(root, src));
  for (const p of INCLUDE) fs.cpSync(path.join(root, p), path.join(to, p), { recursive: true, filter: keep });
  const build = buildId([...STAMPED.map((f) => fs.readFileSync(path.join(root, f), 'utf8')), kit.code]);
  for (const f of STAMPED) fs.writeFileSync(path.join(to, f), stampBuild(fs.readFileSync(path.join(to, f), 'utf8'), build));
  fs.writeFileSync(path.join(to, KIT_OUTPUT), stampBuild(channel === 'store' ? withoutMapUrl(kit.code) : kit.code, build));
  fs.writeFileSync(path.join(to, `${KIT_OUTPUT}.map`), kit.map);
  // The panel, bundled (vite.config.js), stamped with which copy logs the usage events (the build's
  // mode), from which commit; with the packages it took in, for the notices.
  const found = new Set(JSON.parse(kit.map).sources.map(packageOf).filter(Boolean));
  await buildPanel({
    configFile: path.join(root, 'vite.config.js'),
    mode: channel,
    logLevel: 'warn',
    build: { outDir: path.join(to, 'sidepanel') },
    plugins: [noticesPlugin(found)],
  });
  fs.writeFileSync(path.join(to, NOTICES_FILE), thirdPartyNotices(root, [...found]));
};

// Moves the source maps out of a copy into their own folder, at the same paths.
const moveMaps = (from, to) => {
  for (const entry of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.map')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const dest = path.join(to, path.relative(from, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
  }
};

// The store zip, from a staged copy: the files as they are but the built panel, with the page
// scripts stamped.
const at = process.argv.indexOf('--label');
const label = at >= 0 ? process.argv[at + 1] ?? '' : null;
const out = path.join(root, 'dist', zipName(manifest.version, label == null ? {} : { label, commit: packagedCommit(root) }));
const maps = mapsZipName(out);
const stage = path.join(root, 'dist', '.stage');
const stageMaps = path.join(root, 'dist', '.stage-maps');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
fs.rmSync(maps, { force: true });
fs.rmSync(stageMaps, { recursive: true, force: true });
await copy(stage, 'store');
// Without the developer copy's shortcuts (storeManifest).
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(storeManifest(manifest), null, 2)}\n`);
moveMaps(stage, stageMaps);
fs.writeFileSync(out, zipDirectory(stage));
fs.writeFileSync(maps, zipDirectory(stageMaps));
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(stageMaps, { recursive: true, force: true });
// The unpacked copy (Load unpacked in chrome://extensions): the same, plus the fixed ID.
const unpacked = path.join(root, 'dist', 'tni-rater-autofill');
await copy(unpacked, 'unpacked');
fs.writeFileSync(path.join(unpacked, 'manifest.json'), `${JSON.stringify(devManifest(manifest), null, 2)}\n`);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${path.relative(root, out)}  (${kb} KB, version ${manifest.version}); its source maps in ${path.relative(root, maps)}`);
