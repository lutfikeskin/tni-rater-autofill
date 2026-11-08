import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(new URL(f, root), 'utf8'));

// Audit 2026-11-07, QA-08, and the maintainer's decision: every JavaScript file is type-checked, the
// panel's .jsx with React's types; a file that doesn't pass yet says so, and why, on its first line.
test('every JavaScript file is type-checked, and each one left out says why', (t) => {
  const ext = json('tsconfig.json');
  const node = json('tsconfig.node.json');
  assert.equal(ext.compilerOptions.checkJs, true, 'tsconfig.json checks JavaScript');
  assert.notEqual(node.compilerOptions?.checkJs, false, 'tsconfig.node.json doesn\'t turn it off');
  const pkg = json('package.json');
  for (const types of ['@types/react', '@types/react-dom']) assert.ok(pkg.devDependencies[types], `${types}, for the .jsx`);
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z', '*.js', '*.mjs', '*.jsx'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    t.skip('git is not available here');
    return;
  }
  const unexplained = files.filter((f) => {
    const lines = fs.readFileSync(new URL(f, root), 'utf8').split('\n', 3);
    const first = lines[0].startsWith('#!') ? lines[1] : lines[0];
    return /@ts-nocheck/.test(first) && !/^\/\/ @ts-nocheck -- \S/.test(first);
  });
  assert.deepEqual(unexplained, [], 'a file left out says why: // @ts-nocheck -- <why>');
  for (const f of ['lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/fflate.mjs']) {
    assert.match(fs.readFileSync(new URL(f, root), 'utf8').split('\n', 1)[0], /^\/\/ @ts-nocheck -- vendored/, f);
  }
});
