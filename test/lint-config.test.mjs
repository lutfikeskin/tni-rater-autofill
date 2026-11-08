// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OXLINT = path.join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint');

// Audit 2026-11-07, QA-12: `npm run lint` linted the whole working directory, other tools' scratch
// folders included (.agents/, .cursor/, a session's worktrees under .claude/worktrees/), so a clean
// checkout with them failed locally while CI passed. The config leaves them out; the project's own
// files, .claude's tracked scripts among them, are still linted.
test('lint leaves other tools\' folders and built output alone, and still lints the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-config-'));
  try {
    fs.copyFileSync(path.join(ROOT, '.oxlintrc.json'), path.join(dir, '.oxlintrc.json'));
    const bad = 'export const x = notDefinedAnywhere;\n';
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
    for (const file of ['.agents/teamwork/a.mjs', '.cursor/b.mjs', '.claude/worktrees/w/src/c.js', 'dist/d.js', 'layouts/e.mjs']) write(file, bad);
    write('src/ok.js', 'export const y = 1;\n');
    const run = () => spawnSync(process.execPath, [OXLINT, '-c', '.oxlintrc.json'], { cwd: dir, encoding: 'utf8' });
    const clean = run();
    assert.equal(clean.status, 0, `nothing but the project linted:\n${clean.stdout}${clean.stderr}`);
    write('.claude/skills/s/scripts/f.mjs', bad);
    assert.notEqual(run().status, 0, '.claude\'s own scripts are still linted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
