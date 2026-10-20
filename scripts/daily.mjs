#!/usr/bin/env node
// The daily review on this computer: what .github/workflows/daily-review.yml does on GitHub, for
// when Actions can't run it (docs/hosting.md). Checks the usage server, downloads the log, reviews
// the events received since the last run here, and comments on the open daily-review issue when
// something is new (scripts/daily-issue.mjs post, scripts/lib/daily.mjs).
//
//   npm run daily                                  # a dry run: prints the comment, posts nothing
//   npm run daily -- --post                        # posts it, since the last run here
//   npm run daily -- --post --since <ISO time>     # the first real run here, or a period again
//   npm run daily -- [--since …] [--no-pull] [--data some/server-data]
//       --no-pull reads the data as it is (dry runs only: a real run's window ends at its download)
//
// Without --post nothing is posted and the state is kept: a real post is asked for, never a default.
// --post runs only in the main checkout (not a linked worktree), on the default branch, level with
// origin: the review uses the merged rules, and one state says where the next run starts.
//
// Where the last real run stopped is reviews/daily/state.json (git-ignored, like the reviews): when
// its download began, written whole, and only once its post step succeeded (a comment, or nothing
// new to say). A run that fails leaves it, so the next one reviews the period again. Without it and
// without --since the run stops: never a guessed start (scripts/daily-issue.mjs). The review, the
// summary, the comment and a log of every run (daily.log) are in reviews/daily/ too. The decisions
// are scripts/lib/daily-run.mjs (tested).

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDaily } from './lib/daily-run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--data');
const data = path.resolve(i >= 0 ? args[i + 1] : path.join(root, 'server-data'));

const step = (script, scriptArgs) => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
};
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const gitInfo = ({ fetch }) => {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD') ?? '';
  const defaultBranch = process.env.DEFAULT_BRANCH || (git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? '').replace(/^origin\//, '') || 'main';
  // A linked worktree has its own git dir, under the main checkout's .git/worktrees.
  const gitDir = git('rev-parse', '--absolute-git-dir');
  const common = git('rev-parse', '--git-common-dir');
  const worktree = Boolean(gitDir && common) && path.resolve(gitDir) !== path.resolve(root, common);
  const info = { branch, defaultBranch, worktree, fetched: false, ahead: 0, behind: 0 };
  if (fetch && !worktree && branch === defaultBranch) {
    const counts = git('fetch', '--quiet', 'origin', defaultBranch) === null ? null : git('rev-list', '--left-right', '--count', `HEAD...origin/${defaultBranch}`);
    if (counts) Object.assign(info, { fetched: true, ...Object.fromEntries(counts.split(/\s+/).map(Number).map((n, k) => [k ? 'behind' : 'ahead', n])) });
  }
  return info;
};

process.exitCode = runDaily({ root, args, data }, { step, gitInfo });
