---
name: pr-review
description: Review a GitHub pull request of TNI Rater Autofill - read the PR and its changed files, run the focused checks docs/testing.md names for them, and report blocking findings first, then should-fix items, the checks with their results, and what wasn't verified. When the user asks for a Cursor or /thermos second opinion, start a Cursor child thread that runs /thermos on the same PR while you run your own code review, then verify both reviews' findings and merge them. Use for "review PR 161", "review my PR", "is this PR ready to merge". It doesn't fix, push, merge or comment on GitHub: fixing and getting the PR ready to merge is the ship-pr skill's, which takes this report as one of its reviews.
---

# Reviewing a pull request

The outcome is one report per PR: a verdict, the blocking findings first, then what should be fixed, the questions only the maintainer can answer, the checks run with their results, and what remains unverified. Every finding in it was checked against the code; a claim from either review that didn't hold up is dropped and listed as dropped. The thread running this skill (Opus 5.5 in Claude Code) is the main agent and owns the verdict; a Cursor child is a second opinion.

Read `CLAUDE.md` (identical to `AGENTS.md`) first: its working rules are what a PR here is judged against.

## 1. Pin down the PR

```bash
gh pr view <n> --json number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,body
gh pr diff <n> --name-only
```

- No number given: the PR of the current branch (`gh pr view`); ask when several PRs could be meant. Several PRs: each gets its own checkout, checks, Cursor child and section of the report.
- Read the body: what it says it changes, which documents it says it updated, and which checks it says it ran. These are claims to verify, not evidence.
- Say so up front when the PR is a draft, closed or merged, or its head moved during the review (compare `headRefOid` again before reporting).

## 2. Get the PR head on disk without touching anyone's work

Never switch branches, stash, reset or clean in the main checkout or an existing worktree: the user and other threads work there, and the untracked files there are the user's.

```bash
git fetch origin "pull/<n>/head" "<base>"
git worktree list                     # a checkout already at headRefOid with a clean `git status --short` can be reused
git worktree add --detach ".claude/worktrees/pr-<n>" <headRefOid>   # otherwise, one review checkout
```

A review checkout under `.claude/worktrees/` resolves the main checkout's `node_modules`. When the PR changes `package.json` or `package-lock.json`, run `npm ci` in the review checkout (it gets its own) or report the dependency's checks as not run. Work from the review checkout with absolute paths from here on, so every file read and test run is the PR's version.

## 3. Start the Cursor /thermos child (only when the user asked for it)

Start it before your own review so both run at once. A Cursor thread on this machine advertises no slash commands to bb, so `/thermos` may not run as a command there (on PR 160 the child guessed a rubric path and ran the code-quality pass only); the prompt gives it the plugin's skill files to follow instead.

```bash
THERMOS=$(ls -dt "$HOME"/.cursor/plugins/cache/cursor-public/thermos/*/skills 2>/dev/null | head -1)
cygpath -w "$THERMOS"                 # the Windows path the prompt names; empty means Cursor's Thermos plugin isn't installed
```

If it is empty, tell the user and continue with your own review alone. Otherwise write the prompt to `$BB_THREAD_STORAGE/pr-<n>-thermos-prompt.md`, filling in the brackets:

```markdown
Run /thermos on PR #<n> (<url>, "<title>", `<head>` into `<base>`).

This workspace is checked out at the PR head (<headRefOid>); the changes to review are `git diff origin/<base>...HEAD`.

If /thermos doesn't run as a command here, follow `<THERMOS>\thermos\SKILL.md` yourself. It runs two passes, each with its own rubric beside it: `<THERMOS>\thermo-nuclear-review\SKILL.md` (bugs, breakage, security) and `<THERMOS>\thermo-nuclear-code-quality-review\SKILL.md` (maintainability). Run both passes, with these files as the rubrics and no other copy; if you can't start subagents, run them one after the other.

The project's rules are in CLAUDE.md (identical to AGENTS.md) at the repository root. Read them before judging a finding: an answer the intake doesn't support is invented unless it is a TNI standard rule, and agent corrections, review blockers and the restrictions on submitting, binding and signing must hold.

This is a review only. Don't edit files, commit, push, switch branches, or comment on GitHub. You may run a single test file (`node --test test/<file>`) to confirm a finding; don't run `npm run package`, `e2e`, `mock:*` or `ci`: your parent runs those in this same checkout. Your parent is reviewing the same PR and will verify and merge both reviews.

In your final response, list the findings most severe first, each with:
- file:line
- severity: blocker (breaks behavior, gives a wrong or invented insurance answer, leaks data or credentials, opens a security hole) / should fix / nit
- what is wrong, and a concrete scenario where it breaks
- which pass found it (correctness or code quality) and how confident you are

End with the thermos approval verdict in one line. If a pass finds nothing, say so plainly.
```

```bash
bb thread spawn --project "$BB_PROJECT_ID" --parent-self --provider acp-cursor \
  --environment "<review checkout, Windows path>" \
  --title "Cursor /thermos review of PR <n>" \
  --prompt-file "$BB_THREAD_STORAGE/pr-<n>-thermos-prompt.md"
```

Cursor's default model unless the user named one (`--model`; `bb provider models acp-cursor` lists them). Tell the user the child is running as `@thread:<id>` in one line, and go on without waiting.

## 4. Your own review

Do step 1 of [ship-pr](../../../.claude/skills/ship-pr/SKILL.md) ("Review the diff"), not its step 0: the review stays in the review checkout, and the Cursor child is the one started above. That is, read the PR and its diff, collect the reviews already on GitHub, run your own independent pass, and look especially for what its list names (invented answers, weakened agent protections, client data, lint turned off and the rest). In Claude Code, the independent pass is the code-review skill on the PR (`/code-review <n>`, at the effort the user gave), run from the review checkout without `--comment` or `--fix`.

## 5. Run the focused checks

Choose them from the table in [Testing](../../../docs/testing.md) ("Choose checks for the change"), row by row for the changed files; that table is the source of truth. A changed test file also runs itself; `types.js` or a file with `// @ts-check` adds `npm run typecheck`; documentation only gets that row's checks and `git diff --check`.

1. A fast signal first: oxlint on the changed JavaScript files (`npm run lint -- <changed .js and .mjs files>`, with the project's `.oxlintrc.json`), then the focused test files (`node --test test/<a>.test.mjs test/<b>.test.mjs`).
2. For any code change, `npm test`; the PR's GitHub Checks run the rest (lint, type check, package, the mocks and replays) on its head: read them with `gh pr checks <n>`.
3. The harnesses the matched rows name (`npm run mock:geico`, `npm run mock:amwins`, `npm run e2e -- --fixtures`, `npm run mock:luna`, `npm run e2e:extension` with `npm run replay` serving port 8792 in a bb terminal).

No local CI run is needed here: GitHub's Checks are the gate. Run one job's command only to reproduce a failing job.

Record each command, its result and its time. A check that can't run here (no Playwright Chromium, no captures or intake PDFs) is reported as not run, with the reason, never as passed. The PR's GitHub check status is evidence only for a run that actually happened.

Before calling a failure the PR's, check whether it fails without the PR: when the failing test or the code it exercises is outside the diff, rerun that one check on the base commit (`git merge-base origin/<base> <headRefOid>`). In a review checkout you created, wait until the Cursor child is done, then `git checkout --detach <merge-base>`, rerun, and `git checkout --detach <headRefOid>`; never switch a checkout you didn't create. A check that fails on the base too is reported as "fails on main too", not as this PR's blocker. Don't fix a failure or update a baseline during the review.

## 6. Verify and merge the reviews

- bb notifies you when the Cursor child finishes, but the notice can be cut short: read its whole answer with `bb thread output <child-id>`. If it isn't done when your own work is, `bb thread wait <child-id> --timeout 20m`; if it fails or times out, report without it and say so.
- Verify every finding from every review as ship-pr's step 2 says: **real** (with the concrete input that goes wrong), **not real** (why the code is already right), or **needs the maintainer** (an insurance answer, client fact or product decision, asked as a question, never guessed). Open the line, trace the scenario, or run the test that would show it. A finding that isn't real is dropped, with why, in the comparison table. Check a suggested fix too: it must pass the checks and follow `CLAUDE.md` (no casts that add parentheses, for one); if it doesn't, keep the problem and drop the fix.
- Merge duplicates; a finding both reviews made carries more weight.
- Classify the real ones:
  - **Blocking**: a check that fails because of the PR; a bug in changed code with a concrete failing scenario; a wrong or invented insurance answer; a weakened agent correction, review blocker or submit, bind or sign restriction; client data or credentials committed or logged; a security hole.
  - **Should fix**: real but not merge-stopping, such as a missing document update or test for new behavior, a lint exception without a reason that holds (blocking when the silenced error is a real bug), and the thermos code-quality findings (structure, file size past 1,000 lines, special-case branching) unless they hide a bug.
  - **Nit**: style and naming.

## 7. Report

Lead with the verdict and the blocking findings. Save the whole report to `$BB_THREAD_STORAGE/pr-<n>-review.md` and link it, so ship-pr can take it up; when it runs long, keep the chat to the verdict, the blockers, the questions and the checks.

```markdown
**PR #<n>, <title>: blocked (<k> blocking findings)** or **no blocking findings**
Head <sha7>. Reviews: Claude code-review, Cursor /thermos (@thread:<id>), and the checks below.

### Blocking
1. `path/file.js:42`: what breaks, in which scenario. Evidence: the test output or the traced path. Found by both / Claude / Cursor; confidence.

### Should fix
...

### Needs the maintainer
1. The question, and the finding it decides.

### Checks
| Check | Result |
| --- | --- |
| `node --test test/geico.test.mjs` | pass, 12 s |
| `npm run mock:geico` | not run: Playwright Chromium isn't installed |

### Claude and Cursor
| Finding | Claude | Cursor | Outcome |
| --- | --- | --- | --- |

### Not verified
Live carrier behavior, a real lookup, the server's acceptance of new fields; GitHub's checks if they didn't run.
```

Nits go last, or as a count the user can ask to see. No client values in the report.

## 8. After the report

- When the user asks to fix the findings or get the PR ready to merge, follow [ship-pr](../../../.claude/skills/ship-pr/SKILL.md) from its step 0, in the main checkout. This report and the Cursor child's answer are reviews it collects in step 1; at the same head it carries their verdicts into its step 2. Ask the Cursor child to re-review the fixes (`bb thread tell <child-id> --message-file -`) only if the user wants that.
- ship-pr posts its own review comment. Post this report to GitHub only when the user asks for that, and show what will be posted first: `gh pr comment <n> --body-file <report>`, without client values.
- Once the user is done with the PR, remove a review checkout you created (`git worktree remove .claude/worktrees/pr-<n>`) and say so. Never remove one you didn't create.
