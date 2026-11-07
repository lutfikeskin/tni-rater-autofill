#!/usr/bin/env node
// @ts-check
// Deploys the usage server to Railway from the default branch as merged, never from whatever the
// working tree holds (audit 2026-11-07, SRV-10; docs/hosting.md). It refuses unless this checkout
// is origin/<default> after a fetch and the files the image is built from are committed; then it
// runs `railway up --service usage-server --ci` and waits for /v1/health to name this checkout's
// server (scripts/server-check.mjs's check).
//
//   npm run deploy:server               # check, deploy, then wait for the deployed server
//   npm run deploy:server -- --dry-run  # check only: says whether it would deploy

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageFiles, deployProblem } from './lib/deploy.mjs';
import { serverUrl, checkServer } from './lib/central.mjs';
import { SERVER_HASH } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
/** @param {...string} a */
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

const defaultBranch = (git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? '').replace(/^origin\//, '') || 'main';
const fetched = git('fetch', '--quiet', 'origin', defaultBranch) !== null;
const files = imageFiles(fs.readFileSync(path.join(root, 'server', 'Dockerfile'), 'utf8'));
const status = git('status', '--porcelain', '--untracked-files=all', '--', ...files);
const facts = {
  fetched: fetched && status !== null,
  head: git('rev-parse', 'HEAD'),
  upstream: git('rev-parse', `origin/${defaultBranch}`),
  defaultBranch,
  dirty: (status ?? '').split('\n').filter(Boolean).map((l) => l.slice(3)),
};
const problem = deployProblem(facts);
if (problem) {
  console.error(`deploy:server: not deploying: ${problem}.`);
  process.exit(1);
}
console.log(`deploy:server: ${facts.head?.slice(0, 7)} is origin/${defaultBranch}; the image's files are committed (server ${SERVER_HASH}).`);
if (dryRun) process.exit(0);

// Railway's CLI, signed in and linked to the project (docs/hosting.md). --ci streams the build and
// exits non-zero when the deployment fails.
const up = spawnSync('railway', ['up', '--service', 'usage-server', '--ci'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (up.status !== 0) {
  console.error(`deploy:server: railway up failed (${up.error ? up.error.message : `exit ${up.status}`}); the previous deployment keeps serving.`);
  process.exit(1);
}
// The new deployment takes over a little after its build: wait for it to answer with this server.
const base = serverUrl();
for (let i = 0; i < 30; i++) {
  const r = await checkServer(base, SERVER_HASH);
  if (r.status === 'same') {
    console.log(`deploy:server: ${base} runs this repository's server (${SERVER_HASH}).`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
console.error(`deploy:server: after 5 minutes ${base} still doesn't run ${SERVER_HASH}: check the deployment in Railway, then node scripts/server-check.mjs.`);
process.exit(1);
