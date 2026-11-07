import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { imageFiles, deployProblem, dirtyFiles } from '../scripts/lib/deploy.mjs';

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

test('a deploy goes ahead only from the default branch as merged, with the image\'s files committed', () => {
  const ok = { fetched: true, head: 'abc', upstream: 'abc', defaultBranch: 'main', dirty: [] };
  assert.equal(deployProblem(ok), null);
  assert.match(deployProblem({ ...ok, fetched: false }), /could not fetch origin\/main/);
  assert.match(deployProblem({ ...ok, head: 'def' }), /not origin\/main as merged/);
  assert.match(deployProblem({ ...ok, upstream: null }), /could not fetch origin\/main/);
  assert.match(deployProblem({ ...ok, dirty: ['server/index.mjs'] }), /uncommitted changes to what the image is built from: server\/index\.mjs/);
  assert.match(deployProblem({ ...ok, defaultBranch: 'trunk', head: 'x', upstream: 'y' }), /origin\/trunk/);
});
