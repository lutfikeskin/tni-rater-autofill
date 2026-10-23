#!/usr/bin/env node
// The pull-request checks (checks.yml, windows-smoke.yml) on this computer, in the same order,
// before a push spends paid GitHub minutes on them. Stops at the first failure.
//
//   npm run ci           -> lint, type check, unit tests, package, store ZIP check, packaged-extension
//                           E2E with the replay server, AmWINS (normal and reversed), GEICO mock,
//                           Progressive fixture replays, Luna mock
//   npm run ci -- --quick -> lint, type check, unit tests and package only (checks.yml)
//
// Uses the installed node_modules (no `npm ci`) and Playwright's Chromium (`npx playwright install
// chromium` once). A replay server already serving port 8792 is used as it is; otherwise one is
// started for the E2E step and stopped after it, as in CI.
//
// A pass with no uncommitted changes to tracked files is remembered for HEAD, so the pre-push hook
// (.githooks/pre-push) doesn't run the same checks again before that commit is pushed.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const started = Date.now();

function run(label, args) {
  console.log(`\n=== ${label}: npm ${args.join(' ')}`);
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${label} failed`);
}

// Thrown, so a replay server this script started is stopped on the way out.
function fail(msg) {
  throw new Error(msg);
}

// What windows-smoke.yml checks in the store ZIP: no development key, the source's version, and
// the side panel it names.
function checkStoreZip() {
  console.log('\n=== Store ZIP');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = unzipSync(fs.readFileSync(path.join(root, 'dist', `tni-rater-autofill-${version}.zip`)));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.key) fail('the store ZIP must not contain the development key');
  if (manifest.version !== version) fail('store version does not match source');
  if (!files[manifest.side_panel?.default_path]) fail('missing side panel');
  console.log(`OK: ${version}, no key, side panel present.`);
}

const REPLAY = 'http://127.0.0.1:8792/test/fixtures/amwins/application.html';
const serving = () => fetch(REPLAY, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

async function withReplay(fn) {
  if (await serving()) return fn();
  const server = spawn(process.execPath, ['scripts/replay.mjs'], { cwd: root, stdio: 'ignore' });
  try {
    for (let i = 0; !(await serving()); i++) {
      if (server.exitCode != null) fail('the replay server exited before becoming ready');
      if (i >= 30) fail('the replay server did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return fn();
  } finally {
    server.kill();
  }
}

try {
  run('Lint', ['run', 'lint']);
  run('Type check', ['run', 'typecheck']);
  run('Unit tests', ['test']);
  run('Package', ['run', 'package']);
  if (!quick) {
    checkStoreZip();
    await withReplay(() => run('Packaged extension', ['run', 'e2e:extension']));
    run('AmWINS mock', ['run', 'mock:amwins']);
    run('AmWINS mock, reversed', ['run', 'mock:amwins', '--', '--reversed']);
    run('GEICO mock', ['run', 'mock:geico']);
    run('Progressive fixtures', ['run', 'e2e', '--', '--fixtures']);
    run('Luna mock', ['run', 'mock:luna']);
  }
} catch (e) {
  console.error(`\nLocal CI: ${e.message}.`);
  process.exit(1);
}
console.log(`\nLocal CI: all ${quick ? 'quick ' : ''}checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
if (git('status', '--porcelain', '--untracked-files=no').stdout === '') {
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const stamp = path.resolve(root, git('rev-parse', '--git-path', 'tni-ci-passed').stdout.trim());
  if (head) fs.writeFileSync(stamp, `${head} ${quick ? 'quick' : 'full'}\n`);
}
