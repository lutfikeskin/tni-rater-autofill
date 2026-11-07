import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { imageFiles, deployProblem, dirtyFiles, waitForSame } from '../scripts/lib/deploy.mjs';

// Audit 2026-11-07, SRV-10: `railway up` uploads the working tree as it is, on whatever branch the
// shared checkout is on, committed or not. `npm run deploy:server` deploys only main as merged.
test('the files the server image is built from are the Dockerfile\'s COPY sources, and the Dockerfile', () => {
  const docker = 'FROM node:22-alpine\nWORKDIR /app\nCOPY server/index.mjs server/dashboard.mjs server/\nCOPY --chown=node src/usage-schema.js src/\nCMD ["node"]\n';
  assert.deepEqual(imageFiles(docker), ['server/Dockerfile', 'server/index.mjs', 'server/dashboard.mjs', 'src/usage-schema.js']);
  const real = imageFiles(fs.readFileSync(new URL('../server/Dockerfile', import.meta.url), 'utf8'));
  assert.ok(real.includes('server/index.mjs'), 'the real Dockerfile copies the server');
  for (const f of real) assert.ok(fs.existsSync(new URL(`../${f}`, import.meta.url)), `${f} exists`);
});

// The review of #426: git's porcelain line starts with a space for a change not staged (` M`), so
// the file name is what follows the two status letters and their space, read from the whole output.
test('the dirty files are read from git status --porcelain as it prints them', () => {
  assert.deepEqual(dirtyFiles(' M server/index.mjs\n?? server/new.mjs\nM  server/Dockerfile\nR  server/a.mjs -> server/b.mjs\n'),
    ['server/index.mjs', 'server/new.mjs', 'server/Dockerfile', 'server/b.mjs']);
  assert.deepEqual(dirtyFiles(''), []);
});

// The maintainer, 2026-11-07: a merge to main that changes what the image is built from deploys it,
// with a RAILWAY_TOKEN secret; without that secret the job says so and succeeds, deploying nothing.
test('the deploy workflow runs on main for every file the image is built from, and skips without its secret', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-server.yml', import.meta.url), 'utf8');
  const paths = [...(/^ {4}paths:\n((?: {6}- .*\n)+)/m.exec(workflow)?.[1] ?? '').matchAll(/- '?([^'\n]+)'?/g)].map((m) => m[1]);
  assert.ok(/^ {2}push:\n {4}branches: \[main\]/m.test(workflow), 'on pushes to main only');
  for (const f of imageFiles(fs.readFileSync(new URL('../server/Dockerfile', import.meta.url), 'utf8'))) {
    assert.ok(paths.some((p) => p === f || (p.endsWith('/**') && f.startsWith(p.slice(0, -2)))), `a change to ${f} deploys`);
  }
  assert.ok(paths.includes('.railwayignore'), 'and to what the upload leaves out');
  assert.match(workflow, /RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_TOKEN \}\}/);
  // Every step after the check runs only when the secret is there.
  const steps = workflow.split(/\n {6}- /).slice(1);
  const check = steps.findIndex((s) => /id: token/.test(s));
  assert.ok(check >= 0, 'a step checks for the secret');
  for (const s of steps.slice(check + 1)) assert.match(s, /if: steps\.token\.outputs\.present == 'true'/, s.split('\n')[0]);
  assert.match(workflow, /node scripts\/deploy-server\.mjs/, 'the same checks and wait as npm run deploy:server');
  assert.match(workflow, /ref: main\n/, 'main as it is when the job starts: the script refuses any other commit');
});

test('a deploy goes ahead only from the default branch as merged, with the image\'s files committed', () => {
  const ok = { fetched: true, head: 'abc', upstream: 'abc', defaultBranch: 'main', dirty: [] };
  assert.equal(deployProblem(ok), null);
  assert.match(deployProblem({ ...ok, fetched: false }), /could not fetch origin\/main/);
  assert.match(deployProblem({ ...ok, head: 'def' }), /not origin\/main as merged/);
  assert.match(deployProblem({ ...ok, upstream: null }), /could not fetch origin\/main/);
  assert.match(deployProblem({ ...ok, dirty: ['server/index.mjs'] }), /uncommitted changes to what the image is built from: server\/index\.mjs/);
  assert.match(deployProblem({ ...ok, defaultBranch: 'trunk', head: 'x', upstream: 'y' }), /origin\/trunk/);
});

// The review of #426: the wait for the deployed server has one deadline, a stalled health request
// included: it is aborted when the deadline passes, and the wait answers then.
test('the wait for the deployed server keeps one deadline, aborting a stalled health request', async () => {
  let signal;
  const started = Date.now();
  const stalled = await waitForSame((s) => { signal = s; return new Promise(() => {}); }, { deadlineMs: 50, intervalMs: 10 });
  assert.equal(stalled, false);
  assert.ok(Date.now() - started < 1000, 'answered at the deadline, not after the stalled request');
  assert.equal(signal.aborted, true, 'the stalled request was aborted');
  const answers = ['different', 'different', 'same'];
  let asked = 0;
  assert.equal(await waitForSame(async () => ({ status: answers[asked++] }), { deadlineMs: 1000, intervalMs: 1 }), true);
  assert.equal(asked, 3);
  assert.equal(await waitForSame(async () => ({ status: 'different' }), { deadlineMs: 30, intervalMs: 5 }), false);
});
