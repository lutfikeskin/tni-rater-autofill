import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../scripts/lib/ledger.mjs';
import { prTitle, parseLog, releaseNotes, releaseOf, broughtBy, LOG_FORMAT } from '../scripts/lib/release.mjs';

// Audit 2026-11-07, ORG-13: no tag said which commit was which version, and nothing told what
// changed. A version's release is the commit on main that set manifest.json to it.
test('a merge commit reads as its pull request\'s title; a squash merge keeps its subject', () => {
  assert.equal(prTitle({ subject: 'Merge pull request #295 from lutfikeskin/claude/release-0.9.32', body: '\nRelease 0.9.32\n\nmore' }), 'Release 0.9.32 (#295)');
  assert.equal(prTitle({ subject: 'Learner label hygiene (#392)', body: 'details' }), 'Learner label hygiene (#392)');
  assert.equal(prTitle({ subject: 'Merge pull request #7 from x/y', body: '' }), 'Merge pull request #7 from x/y (#7)');
  const log = `a1\x1fFix one (#1)\x1fbody\x1e\nb2\x1fMerge pull request #2 from u/b\x1fTwo's title\n\x1e\n`;
  assert.deepEqual(parseLog(log), [{ sha: 'a1', subject: 'Fix one (#1)', body: 'body' }, { sha: 'b2', subject: 'Merge pull request #2 from u/b', body: "Two's title" }]);
  assert.equal(releaseNotes({ version: '0.9.32', previous: '0.9.31', commits: parseLog(log) }),
    'What changed on main since v0.9.31, by pull request:\n\n- Two\'s title (#2)\n- Fix one (#1)\n', 'oldest first, from git log\'s newest first');
  assert.equal(releaseNotes({ version: '0.1.0', previous: null, commits: [] }), 'The first tagged version.\n');
});

// The reviews of #429: no run on another branch, no manual run (no backfill), main's history only,
// and an existing tag that names another commit fails rather than being released.
test('the release workflow tags only what a push to main brought, from main\'s history', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release-tag.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  // A concurrency group cancels a pending run when the next one queues: the bump's run would be lost.
  assert.doesNotMatch(workflow, /^\s*concurrency:/m, 'neither the workflow nor its job');
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /release-notes\.mjs --ref origin\/main --before "\$BEFORE"/);
  assert.match(workflow, /BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(workflow, /if: steps\.release\.outputs\.tag != ''/);
  assert.match(workflow, /"\$existing" != "\$TARGET"[\s\S]*exit 1/);
});

// Audit 2026-11-07, QA-17: a release named the version and its pull requests, but the zip uploaded
// to the store was built by hand and kept nowhere. The release's second job packages the tagged
// commit and attaches the zip, never replacing one the release has, and uploads nothing to the store.
test('the release workflow attaches the tagged commit\'s packaged zip to its release', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release-tag.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  package:\n'));
  assert.ok(job.length > 20, 'a package job');
  assert.match(workflow, /outputs:\n {6}tag: \$\{\{ steps\.release\.outputs\.tag \}\}\n {6}target: \$\{\{ steps\.release\.outputs\.target \}\}\n {6}version: \$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.match(job, /needs: tag\n {4}if: needs\.tag\.outputs\.tag != ''/);
  assert.match(job, /ref: \$\{\{ needs\.tag\.outputs\.target \}\}/, 'the commit the tag names, not main\'s head');
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /- run: npm ci\n {6}- run: npm run package\n/);
  assert.match(job, /"dist\/tni-rater-autofill-\$VERSION\.zip" "dist\/tni-rater-autofill-\$VERSION-sourcemaps\.zip"/);
  assert.match(job, /gh release upload "\$TAG" "\$zip" --repo "\$GITHUB_REPOSITORY"\n/);
  assert.doesNotMatch(job, /--clobber/, 'an asset the release has is left as it is');
  assert.match(job, /grep -qxF "\$\(basename "\$zip"\)"/);
  assert.doesNotMatch(workflow, /chromewebstore|webstore\/upload|CHROME_|client_secret|refresh_token/i, 'nothing goes to the Chrome Web Store');
  // The zip it attaches is the one npm run package names for the store (scripts/lib/package.mjs).
  assert.match(fs.readFileSync(new URL('../scripts/lib/package.mjs', import.meta.url), 'utf8'), /return `tni-rater-autofill-\$\{version\}\.zip`;/);
});

test('a version\'s release commit is the one on main that set manifest.json to it, with the version before it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-release-'));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  };
  const manifest = (v, extra = '') => fs.writeFileSync(path.join(dir, 'manifest.json'), `{\n  "name": "x",\n  "version": "${v}"${extra}\n}\n`);
  git('init', '-q', '-b', 'main');
  manifest('0.1.0'); git('add', '.'); git('commit', '-q', '-m', 'Release 0.1.0 (#1)');
  const first = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'A change (#2)');
  manifest('0.1.0', ',\n  "permissions": []'); git('add', '.'); git('commit', '-q', '-m', 'The manifest, not its version (#3)');
  manifest('0.1.1', ',\n  "permissions": []'); git('add', '.'); git('commit', '-q', '-m', 'Release 0.1.1 (#4)');
  const second = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'After the release (#5)');
  assert.deepEqual(releaseOf(git, '0.1.0'), { version: '0.1.0', target: first, previous: null, previousTarget: null });
  const r = releaseOf(git, '0.1.1');
  assert.deepEqual(r, { version: '0.1.1', target: second, previous: '0.1.0', previousTarget: first });
  const commits = parseLog(git('log', '--first-parent', `--format=${LOG_FORMAT}`, `${r.previousTarget}..${r.target}`));
  assert.deepEqual(commits.map((c) => c.subject), ['Release 0.1.1 (#4)', 'The manifest, not its version (#3)', 'A change (#2)']);
  assert.equal(releaseOf(git, '9.9.9'), null, 'a version main never had');
  // The maintainer, 2026-11-07: no backfill. A push tags its version only when it brought the
  // release commit: one already on main before the push (its `before`) is left untagged.
  assert.equal(broughtBy(git, second, first), true, 'the push from 0.1.0 brought 0.1.1');
  assert.equal(broughtBy(git, first, first), false);
  assert.equal(broughtBy(git, second, git('rev-parse', 'HEAD').trim()), false, 'a later push that only touched the manifest');
  assert.equal(broughtBy(git, second, '0000000000000000000000000000000000000000'), false, 'no before: nothing is assumed new');
  assert.throws(() => releaseOf(git, '0.1'), /not a version/);
});
