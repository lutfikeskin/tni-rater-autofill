#!/usr/bin/env node
// The daily review's GitHub side (.github/workflows/daily-review.yml), through the gh CLI:
//
//   node scripts/daily-issue.mjs since
//       prints where the review starts: the last successful run on the default branch, else a day ago
//   node scripts/daily-issue.mjs post --summary review-summary.json --server <same|different|…> \
//       [--server-note text] --run-url <url> [--failed]
//       comments on the open daily-review issue (or opens one) when something is new: problem
//       reports, questions without a rule first seen, a usage server that isn't the repository's,
//       or a run that failed. Nothing new: says nothing.
//
// The decisions are scripts/lib/daily.mjs (tested); this file only asks gh and tells it.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lastSuccess, windowStart, decide, commentBody } from './lib/daily.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });
const LABEL = 'daily-review';

if (args[0] === 'since') {
  let run = null;
  let steps = [];
  try {
    const branch = process.env.DEFAULT_BRANCH || 'main';
    run = lastSuccess(JSON.parse(gh('run', 'list', '--workflow', 'daily-review.yml', '--branch', branch, '--status', 'success', '--limit', '5', '--json', 'databaseId,createdAt,startedAt,conclusion')));
    if (run) steps = JSON.parse(gh('run', 'view', String(run.databaseId), '--json', 'jobs')).jobs.flatMap((j) => j.steps ?? []);
  } catch (e) {
    console.error(`couldn't read the last run (${String(e.message).split('\n')[0]}): ${run ? 'from when it started' : 'a day ago'}`);
  }
  console.log(windowStart(run, steps));
} else if (args[0] === 'post') {
  const failed = args.includes('--failed');
  const file = opt('summary');
  const summary = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const facts = { ...summary, server: opt('server') || 'not checked', serverNote: opt('server-note') ?? '', failed, runUrl: opt('run-url') ?? '' };
  const open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,createdAt'));
  const action = decide(facts, open);
  if (action.kind === 'none') {
    console.log('nothing new: no comment');
  } else {
    fs.writeFileSync('daily-comment.md', commentBody(facts));
    if (action.kind === 'comment') {
      gh('issue', 'comment', String(action.number), '--body-file', 'daily-comment.md');
      console.log(`commented on #${action.number}`);
    } else {
      // The label is how the next run finds the issue: create it when the repository lacks it.
      try { gh('label', 'create', LABEL, '--description', 'Daily usage review', '--force'); } catch { /* exists, or no rights: the create below says */ }
      console.log(gh('issue', 'create', '--title', action.title, '--label', LABEL, '--body-file', 'daily-comment.md').trim());
    }
  }
} else {
  console.error('usage: node scripts/daily-issue.mjs since | post --summary file --server status --run-url url [--server-note text] [--failed]');
  process.exit(1);
}
