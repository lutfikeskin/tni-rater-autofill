// The daily review on this computer (scripts/daily.mjs): what refuses a real post, the lock, the
// state, where the download starts, and the run itself. The scripts it runs and what git says are
// passed in (`step`, `gitInfo`), so the tests run it on a temporary folder.

import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;

// Why this run may not post, or null. Dry runs (no --post) may run anywhere. A real one reviews with
// the merged rules and scripts, and keeps the one state the next real run starts from.
export function refusal({ post, pull, branch, defaultBranch, worktree, fetched, ahead = 0, behind = 0 }) {
  if (!post) return null;
  if (!pull) return '--no-pull is for dry runs (no --post): a real run reviews up to its own download.';
  if (worktree) return 'Not posting from a linked worktree: its state and lock are its own, so it could post a window the main checkout posts too. Run npm run daily -- --post in the main checkout.';
  if (branch !== defaultBranch) return `Not posting from ${branch || 'a detached HEAD'}: the review would use that branch's rules and scripts. In the main checkout: git switch ${defaultBranch}, git pull, then npm run daily -- --post.`;
  if (!fetched) return `Not posting: couldn't fetch origin/${defaultBranch} to check this checkout is current. Check the network and git's sign-in, then run again.`;
  if (behind || ahead) return `Not posting: ${defaultBranch} is ${behind} commit(s) behind and ${ahead} ahead of origin/${defaultBranch}. git pull (and push or drop the local commits), then run again.`;
  return null;
}

// One run at a time: each starts where the last stopped and posts to one issue. A lock left by a
// run that died is taken over after an hour.
export const LOCK_MINUTES = 60;
export function takeLock(file, now = Date.now()) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const minutes = (now - fs.statSync(file).mtimeMs) / 60000;
    if (minutes < LOCK_MINUTES) return { ok: false, minutes };
    fs.writeFileSync(file, String(process.pid));
    return { ok: true, tookOver: Math.round(minutes) };
  }
}

// Where the last real run stopped: null when there is none; unreadable or without a start, throws
// (the run says so on the issue rather than stop silently).
export function readState(file) {
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Number.isNaN(Date.parse(state?.since))) throw new Error('it has no start time');
  return state;
}
// Whole or not at all: a run stopped while writing leaves the previous state.
export function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

// Where the download starts: the day before the window, as the server exports whole days and
// logs-pull replaces only the days it downloads, when the local copy has an earlier day. Else
// everything (null): a fresh copy needs the history to tell which questions are new.
export function pullStart(since, data) {
  const day = new Date(Date.parse(since) - DAY).toISOString().slice(0, 10);
  const dir = path.join(data, 'events');
  const older = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < day);
  return older ? day : null;
}

// The run's files, by UTC day and minute: a retry the same day keeps the failed run's.
export const fileTag = (now, dryRun) => `${now.toISOString().slice(0, 16).replace('T', '-').replace(':', '')}${dryRun ? '-dry-run' : ''}`;

// The run: the server check, the download, the review, the post, then the state (real runs only).
// `step(script, args)` runs scripts/<script> and returns { ok, stdout, output }; `gitInfo({ fetch })`
// returns { branch, defaultBranch, worktree, fetched, ahead, behind }. Returns the exit code.
export function runDaily({ root, args, data }, { step, gitInfo, now = () => new Date(), out = console.log, err = console.error }) {
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const post = args.includes('--post');
  const pull = !args.includes('--no-pull');
  const dir = path.join(root, 'reviews', 'daily');
  const rel = (f) => (path.relative(root, f).startsWith('..') ? f : path.relative(root, f).split(path.sep).join('/'));
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'daily.log');
  const lockFile = path.join(dir, 'run.lock');
  fs.mkdirSync(dir, { recursive: true });
  const write = (s) => fs.appendFileSync(logFile, `[${now().toISOString()}] ${s}\n`);
  const log = (s) => { out(s); write(s); };
  const stop = (s) => { err(s); write(s); return 1; };
  const run = (script, scriptArgs) => {
    const r = step(script, scriptArgs);
    if (r.output) log(r.output);
    return r;
  };

  const git = gitInfo({ fetch: post });
  const refused = refusal({ post, pull, ...git });
  if (refused) return stop(refused);
  const lock = takeLock(lockFile, now().getTime());
  if (!lock.ok) return stop(`Another npm run daily is running (${rel(lockFile)}, ${Math.round(lock.minutes)} min old).`);
  try {
    if (lock.tookOver) log(`took over a lock left ${lock.tookOver} min ago`);
    const tag = fileTag(now(), !post);
    const review = path.join(dir, `review-${tag}.md`);
    const summary = path.join(dir, `summary-${tag}.json`);
    const serverMd = path.join(dir, `server-check-${tag}.md`);
    const comment = path.join(dir, `comment-${tag}.md`);
    const posting = post ? ['--post'] : [];
    const server = { status: 'not checked', note: '' };
    // A step that failed (the state unreadable, the usage server down, a broken script): said on the
    // issue, with what the server check found.
    const failed = (what) => {
      log(`${what} failed: saying so on the daily-review issue${post ? '' : ' (dry run: printed only)'}`);
      if (!run('daily-issue.mjs', ['post', '--failed', '--failed-step', what, '--server', server.status, '--server-note', server.note, '--log', rel(logFile), '--out', comment, ...posting]).ok) log('...and could not say so (above)');
      return 1;
    };

    let state;
    try {
      state = readState(stateFile);
    } catch (e) {
      log(`${rel(stateFile)} can't be read (${String(e.message).split('\n')[0]}): fix it, or delete it and run with --since where the last comment on the issue stopped.`);
      return failed(`state file (${rel(stateFile)})`);
    }
    const since = opt('since') ?? state?.since ?? null;
    if (!since) return stop(`No previous run here (${rel(stateFile)}): pass where this one starts, --since <date or ISO time>, for example where the last comment on the issue stopped.`);
    if (Number.isNaN(Date.parse(since))) return stop(`--since ${since}: not a date or an ISO time.`);
    log(`npm run daily${post ? ' --post' : ' (dry run: no --post)'}: events received since ${since}, from ${rel(data)}`);

    // First, so a server that is down is still reported (the download would stop the run). Only the
    // default branch is what's deployed: a checkout on another branch doesn't compare.
    if (git.branch !== git.defaultBranch) {
      Object.assign(server, { status: 'skipped', note: `run on ${git.branch || 'an unknown branch'}, not the default branch` });
      log(`server: skipped · ${server.note}`);
    } else {
      fs.rmSync(serverMd, { force: true });
      const m = run('server-check.mjs', ['--md', serverMd]).stdout.match(/^server: ([a-z]+) · (.*)$/m);
      if (m) Object.assign(server, { status: m[1], note: m[2] });
    }

    const until = now().toISOString();
    if (pull) {
      const from = pullStart(since, data);
      if (!run('logs-pull.mjs', ['--out', data, ...(from ? ['--since', from] : [])]).ok) return failed('download');
    } else {
      log(`not downloading: reading ${rel(data)} as it is`);
    }
    if (!run('review.mjs', [data, '--since', since, '--out', review, '--summary', summary]).ok) return failed('review');
    if (fs.existsSync(serverMd)) {
      fs.appendFileSync(review, fs.readFileSync(serverMd, 'utf8'));
      fs.rmSync(serverMd);
    }

    if (!run('daily-issue.mjs', ['post', '--summary', summary, '--server', server.status, '--server-note', server.note, '--review', rel(review), '--until', until, '--out', comment, ...posting]).ok) {
      log(`could not post: the next run reviews from ${since} again`);
      return 1;
    }
    if (!post) {
      log(`dry run: nothing posted, ${rel(stateFile)} unchanged`);
      return 0;
    }
    writeState(stateFile, { since: until, ranAt: now().toISOString(), review: rel(review) });
    log(`done: the next run starts at ${until}`);
    return 0;
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
