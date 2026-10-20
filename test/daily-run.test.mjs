import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDaily, fileTag, pullStart, writeState, readState } from '../scripts/lib/daily-run.mjs';

// npm run daily (scripts/daily.mjs) on a temporary folder: its scripts and git are stand-ins, so
// nothing is downloaded or posted. Review of PR #105.
const NOW = new Date('2026-10-20T06:00:00Z');
function setup({ git = {}, results = {}, state, lockMinutes, days = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-daily-run-'));
  const dir = path.join(root, 'reviews', 'daily');
  const data = path.join(root, 'server-data');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(data, 'events'), { recursive: true });
  for (const d of days) fs.writeFileSync(path.join(data, 'events', `${d}.jsonl`), '');
  const stateFile = path.join(dir, 'state.json');
  if (state !== undefined) fs.writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state));
  const lockFile = path.join(dir, 'run.lock');
  if (lockMinutes != null) {
    fs.writeFileSync(lockFile, '1');
    const t = (NOW.getTime() - lockMinutes * 60000) / 1000;
    fs.utimesSync(lockFile, t, t);
  }
  const calls = [];
  const errors = [];
  const step = (script, args) => {
    calls.push({ script, args });
    return results[script] ?? { ok: true, stdout: script === 'server-check.mjs' ? 'server: same · The usage server runs this repository\'s server.' : '', output: '' };
  };
  const gitInfo = () => ({ branch: 'main', defaultBranch: 'main', worktree: false, fetched: true, ahead: 0, behind: 0, ...git });
  const run = (args) => runDaily({ root, args, data }, { step, gitInfo, now: () => NOW, out: () => {}, err: (s) => errors.push(s) });
  const posts = () => calls.filter((c) => c.script === 'daily-issue.mjs');
  return { dir, data, stateFile, lockFile, calls, errors, run, posts, state: () => fs.readFileSync(stateFile, 'utf8') };
}
const START = { since: '2026-10-19T06:00:00.000Z' };

test('daily run: a dry run posts nothing and keeps the state; a real one writes it only after its post', () => {
  const dry = setup({ state: START });
  assert.equal(dry.run([]), 0);
  assert.deepEqual(dry.calls.map((c) => c.script), ['server-check.mjs', 'logs-pull.mjs', 'review.mjs', 'daily-issue.mjs']);
  assert.ok(!dry.posts()[0].args.includes('--post'));
  assert.equal(JSON.parse(dry.state()).since, START.since, 'a dry run never moves the start');

  const real = setup({ state: START });
  assert.equal(real.run(['--post']), 0);
  assert.ok(real.posts()[0].args.includes('--post'));
  assert.equal(JSON.parse(real.state()).since, NOW.toISOString(), 'the next run starts at this one\'s download');
  assert.deepEqual(fs.readdirSync(real.dir).filter((f) => f.endsWith('.tmp')), [], 'written whole, through a temporary file');
  assert.ok(!fs.existsSync(real.lockFile), 'the lock is let go');

  const unposted = setup({ state: START, results: { 'daily-issue.mjs': { ok: false, stdout: '', output: 'gh: not signed in' } } });
  assert.equal(unposted.run(['--post']), 1);
  assert.equal(JSON.parse(unposted.state()).since, START.since, 'a post that failed: the period again next time');

  const broken = setup({ state: START, results: { 'review.mjs': { ok: false, stdout: '', output: 'boom' } } });
  assert.equal(broken.run(['--post']), 1);
  assert.deepEqual(broken.posts().map((c) => c.args.slice(0, 4)), [['post', '--failed', '--failed-step', 'review']]);
  assert.ok(broken.posts()[0].args.includes('--post'));
  assert.equal(JSON.parse(broken.state()).since, START.since);
});

test('daily run: --post only from the main checkout on the default branch, level with origin', () => {
  const cases = [
    [{}, ['--post', '--no-pull'], /--no-pull is for dry runs/],
    [{ git: { branch: 'claude/release-0.9.10', fetched: false } }, ['--post'], /Not posting from claude\/release-0\.9\.10[\s\S]*git switch main, git pull/],
    [{ git: { worktree: true } }, ['--post'], /linked worktree[\s\S]*main checkout/],
    [{ git: { fetched: false } }, ['--post'], /couldn't fetch origin\/main/],
    [{ git: { behind: 2 } }, ['--post'], /2 commit\(s\) behind and 0 ahead of origin\/main[\s\S]*git pull/],
  ];
  for (const [opts, args, message] of cases) {
    const s = setup({ state: START, ...opts });
    assert.equal(s.run(args), 1, String(message));
    assert.deepEqual(s.calls, [], `${message}: nothing runs`);
    assert.match(s.errors.join('\n'), message);
    assert.match(fs.readFileSync(path.join(s.dir, 'daily.log'), 'utf8'), message, 'and the log says why');
  }
  // A dry run may run anywhere: off the default branch it skips the server check and says why.
  const off = setup({ state: START, git: { branch: 'claude/x', worktree: true, fetched: false } });
  assert.equal(off.run([]), 0);
  assert.ok(!off.calls.some((c) => c.script === 'server-check.mjs'));
  const post = off.posts()[0].args;
  assert.equal(post[post.indexOf('--server') + 1], 'skipped');
  assert.equal(post[post.indexOf('--server-note') + 1], 'run on claude/x, not the default branch');
});

test('daily run: one at a time, a lock left by a dead run taken over after an hour', () => {
  const held = setup({ state: START, lockMinutes: 10 });
  assert.equal(held.run(['--post']), 1);
  assert.deepEqual(held.calls, []);
  assert.match(held.errors.join('\n'), /Another npm run daily is running/);
  assert.ok(fs.existsSync(held.lockFile), 'not its lock to let go');
  const stale = setup({ state: START, lockMinutes: 90 });
  assert.equal(stale.run(['--post']), 0);
  assert.ok(!fs.existsSync(stale.lockFile));
});

test('daily run: an unreadable state is said on the issue, not a silent crash; no start is a plain stop', () => {
  const s = setup({ state: '{"since": "2026-10' });
  assert.equal(s.run(['--post']), 1);
  assert.deepEqual(s.calls.map((c) => c.args.slice(0, 4)), [['post', '--failed', '--failed-step', 'state file (reviews/daily/state.json)']]);
  assert.ok(s.posts()[0].args.includes('--post'));
  assert.throws(() => readState(s.stateFile));
  const none = setup();
  assert.equal(none.run(['--post']), 1);
  assert.deepEqual(none.calls, []);
  assert.match(none.errors.join('\n'), /No previous run here[\s\S]*--since/);
  assert.equal(none.run(['--post', '--since', 'yesterday']), 1);
  assert.match(none.errors.join('\n'), /not a date or an ISO time/);
});

test('daily run: the download starts the day before the window when the local copy has older days', () => {
  const s = setup({ state: START, days: ['2026-10-02', '2026-10-19'] });
  assert.equal(s.run([]), 0);
  assert.deepEqual(s.calls.find((c) => c.script === 'logs-pull.mjs').args, ['--out', s.data, '--since', '2026-10-18']);
  const fresh = setup({ state: START, days: ['2026-10-19'] });
  fresh.run([]);
  assert.deepEqual(fresh.calls.find((c) => c.script === 'logs-pull.mjs').args, ['--out', fresh.data], 'a fresh copy: everything');
  assert.equal(pullStart('2026-10-20T01:12:33Z', s.data), '2026-10-19');
  const noPull = setup({ state: START });
  noPull.run(['--no-pull']);
  assert.ok(!noPull.calls.some((c) => c.script === 'logs-pull.mjs'));
});

test('daily run: its files are named by minute, so a retry the same day keeps the failed run\'s', () => {
  assert.equal(fileTag(new Date('2026-10-20T01:12:33Z'), false), '2026-10-20-0112');
  assert.equal(fileTag(new Date('2026-10-20T01:12:33Z'), true), '2026-10-20-0112-dry-run');
  const s = setup({ state: START });
  s.run(['--post']);
  const review = s.calls.find((c) => c.script === 'review.mjs').args;
  assert.equal(path.basename(review[review.indexOf('--out') + 1]), 'review-2026-10-20-0600.md');
  const file = path.join(s.dir, 'other.json');
  writeState(file, { since: 'x' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { since: 'x' });
});
