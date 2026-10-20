#!/usr/bin/env node
// The daily review on this computer: what .github/workflows/daily-review.yml does on GitHub, for
// when Actions can't run it (docs/hosting.md). Checks the usage server, downloads the log, reviews
// the events received since the last run here, and comments on the open daily-review issue when
// something is new (scripts/daily-issue.mjs post, scripts/lib/daily.mjs).
//
//   npm run daily                                  # since the last run here
//   npm run daily -- --since 2026-10-19T06:00      # the first run here, or a period again
//   npm run daily -- --dry-run [--no-pull] [--data some/server-data]
//       prints the comment instead of posting it and keeps where the next run starts; --no-pull
//       reads the data as it is (dry runs only: a real run's window ends at its download)
//
// Where the last run stopped is reviews/daily/state.json (git-ignored, like the reviews): when its
// download began, written only once its post step succeeded (a comment, or nothing new to say). A
// run that fails leaves it, so the next one reviews the period again. Without it and without
// --since the run stops: never a guessed start (scripts/daily-issue.mjs). The review, the summary,
// the comment and a log of every run (daily.log) are in reviews/daily/ too.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run');
const pull = !args.includes('--no-pull');
const data = path.resolve(opt('data') ?? path.join(root, 'server-data'));
const dir = path.join(root, 'reviews', 'daily');
const rel = (f) => (path.relative(root, f).startsWith('..') ? f : path.relative(root, f).split(path.sep).join('/'));
const stateFile = path.join(dir, 'state.json');
const logFile = path.join(dir, 'daily.log');

if (!pull && !dryRun) { console.error('--no-pull is for dry runs: a real run reviews up to its own download.'); process.exit(1); }
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const since = opt('since') ?? state?.since ?? null;
if (!since) {
  console.error(`No previous run here (${rel(stateFile)}): pass where this one starts, --since <date or ISO time>, for example when the last daily review that commented began.`);
  process.exit(1);
}
if (Number.isNaN(Date.parse(since))) { console.error(`--since ${since}: not a date or an ISO time.`); process.exit(1); }

// One at a time, as the workflow: each run starts where the last stopped and posts to one issue. A
// lock left by a run that died is taken over after an hour.
fs.mkdirSync(dir, { recursive: true });
const lock = path.join(dir, 'run.lock');
try {
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
} catch {
  const minutes = (Date.now() - fs.statSync(lock).mtimeMs) / 60000;
  if (minutes < 60) { console.error(`Another npm run daily is running (${rel(lock)}, ${Math.round(minutes)} min old).`); process.exit(1); }
  fs.writeFileSync(lock, String(process.pid));
}
process.on('exit', () => { try { fs.unlinkSync(lock); } catch { /* gone */ } });

const log = (s) => {
  console.log(s);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`);
};
const step = (script, scriptArgs) => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim();
  if (output) log(output);
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
};
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

const tag = new Date().toISOString().slice(0, 10) + (dryRun ? '-dry-run' : '');
const review = path.join(dir, `review-${tag}.md`);
const summary = path.join(dir, `summary-${tag}.json`);
const serverMd = path.join(dir, `server-check-${tag}.md`);
const comment = path.join(dir, `comment-${tag}.md`);
const posting = dryRun ? ['--dry-run'] : [];

log(`npm run daily${dryRun ? ' (dry run)' : ''}: events received since ${since}, from ${rel(data)}`);

// First, so a server that is down is still reported (the download would stop the run). Only the
// default branch is what's deployed: a checkout on another branch doesn't compare.
const server = { status: 'not checked', note: '' };
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const defaultBranch = process.env.DEFAULT_BRANCH || git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '') || 'main';
if (branch !== defaultBranch) {
  Object.assign(server, { status: 'skipped', note: `run on ${branch || 'an unknown branch'}, not the default branch` });
  log(`server: skipped · ${server.note}`);
} else {
  fs.rmSync(serverMd, { force: true });
  const m = step('server-check.mjs', ['--md', serverMd]).stdout.match(/^server: ([a-z]+) · (.*)$/m);
  if (m) Object.assign(server, { status: m[1], note: m[2] });
}

// The download or the review failed (the usage server down, a broken script): say so on the issue,
// with what the server check found.
const failed = (what) => {
  log(`${what} failed: saying so on the daily-review issue`);
  if (!step('daily-issue.mjs', ['post', '--failed', '--failed-step', what, '--server', server.status, '--server-note', server.note, '--log', rel(logFile), '--out', comment, ...posting]).ok) log('...and could not say so (above)');
  process.exit(1);
};

const until = new Date().toISOString();
if (pull) {
  if (!step('logs-pull.mjs', ['--out', data]).ok) failed('download');
} else {
  log(`not downloading: reading ${data} as it is`);
}
if (!step('review.mjs', [data, '--since', since, '--out', review, '--summary', summary]).ok) failed('review');
if (fs.existsSync(serverMd)) {
  fs.appendFileSync(review, fs.readFileSync(serverMd, 'utf8'));
  fs.rmSync(serverMd);
}

if (!step('daily-issue.mjs', ['post', '--summary', summary, '--server', server.status, '--server-note', server.note, '--review', rel(review), '--until', until, '--out', comment, ...posting]).ok) {
  log(`could not post: the next run reviews from ${since} again`);
  process.exit(1);
}
if (dryRun) {
  log(`dry run: nothing posted, ${rel(stateFile)} unchanged`);
} else {
  fs.writeFileSync(stateFile, `${JSON.stringify({ since: until, ranAt: new Date().toISOString(), review: rel(review) }, null, 1)}\n`);
  log(`done: the next run starts at ${until}`);
}
