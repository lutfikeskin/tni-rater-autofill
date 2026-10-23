---
name: ship-pr
description: Take named TNI Rater Autofill pull requests to ready-to-merge - review only their diffs (with the Claude GitHub review, a pr-review report, and any Cursor or second-session reviews), verify each finding against the code, fix the real ones with tests that fail on the old code, run the full local CI, push, post a review comment, and hand back a verified / not-verified checklist. Use when asked to fix a PR's review findings or get PRs ready to merge; a review that only reports, with or without a Cursor /thermos second opinion, is the pr-review skill's. It never merges, bumps the version, releases or deploys until the maintainer confirms that step in chat.
---

# Getting a pull request ready to merge

The outcome is each named PR with its real findings fixed and proven, the full local CI green on what was pushed, a review comment on the PR saying what was verified, and a checklist for the maintainer. Then stop: **merging waits for the maintainer's confirmation in chat**, given for that PR after the checklist. A request like "fix and merge" still stops at the checklist the first time; the maintainer confirms after reading it.

Read `CLAUDE.md` (identical to `AGENTS.md`) first and follow it: scope, client data, the documents to update, and the restrictions on binding, purchasing, submitting, ordering reports and signing. Approved weekly-review items (`W42-03`) go through the apply-review-fixes skill instead; this skill is for PRs.

## 0. Scope

- Work only on the PRs the maintainer named. For "the related PRs" or "the rest", list the candidates (`gh pr list --state open --json number,title,headRefName,baseRefName`) with one line each on why they're related, and wait for the maintainer to pick. Never pull in another carrier's or another project's PR on your own.
- Stacked PRs: note each one's base; fix from the bottom of the stack up and rebase the children after each push.
- Work on a branch in the main checkout, not a new worktree. Leave the maintainer's untracked files alone. If tracked files have uncommitted changes that aren't yours, stop and ask before switching branches.

```bash
gh pr checkout <n>
git status --short          # no tracked changes before you start
```

## 1. Review the diff

- Read the PR: `gh pr view <n> --json title,body,baseRefName` and `gh pr diff <n>`. Review only that diff and the code it calls.
- Collect the other reviews: the Claude GitHub review and any Cursor or second-session reviews (`gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments`, `gh pr view <n> --comments`). Skip resolved threads.
- A pr-review report on the PR (in the chat, or the `pr-<n>-review.md` its thread saved) is one of them, with its Cursor child's answer. Its findings were verified at the head it names: at that same head, carry its verdicts into step 2; at a later one, verify them again.
- When the maintainer asks for a Cursor or `/thermos` second opinion that no pr-review report already holds, start the Cursor child as step 3 of pr-review (`.bb/skills/pr-review/SKILL.md`) says, with this checkout as its `--environment`, and wait for its whole answer (`bb thread output <id>`) before step 2: no file changes while it reads.
- Add your own independent pass: the code-review skill or a subagent given the diff, not your conclusions.
- Look especially for:
  - a filled field treated as a correct answer, or an invented client fact or insurance answer (one the intake doesn't support, unless it is a `standard` rule `docs/intake-and-rules.md` records as TNI's), and missing information, an explicit No and not applicable treated as one;
  - agent edits, retained-value checks or review blockers weakened, `NEVER_CLICK` / `NEVER_ADVANCE` widened, or anything that binds, purchases, submits, orders reports or signs;
  - client data in code, fixtures or the PR body, credentials in code or logs, or raw carrier HTML or PDFs outside the ignored `layouts/`;
  - an exact mapping or calculation handed to the model, or provider request validation, manual review or safe failure removed;
  - a carrier option, plan step, report or event field not declared in `types.js`;
  - POSIX-only code (Windows is the main platform);
  - documents left stale, or `AGENTS.md` and `CLAUDE.md` no longer identical;
  - a test loosened, skipped or rewritten to mirror the change, or a baseline accepted (`npm run e2e -- --update`) without the changed pages explained;
  - lint turned off instead of fixed: a new `oxlint-disable` comment without `-- <why>` or with a reason that doesn't hold, or `.oxlintrc.json` rules weakened or files added to its `ignorePatterns`.

## 2. Verify each finding

For every finding from every reviewer, read the code it points to and decide: **real** (with the concrete input that goes wrong), **not real** (why the code is already right), or **needs the maintainer** (an insurance answer, client fact or product decision). Don't fix what you can't show going wrong. Report findings that need the maintainer as questions; don't guess them.

## 3. Fix the real findings

Follow `docs/corrections.md` and the document for the layer (the table in `CLAUDE.md`).

1. **Test first.** Write the smallest test that reproduces the finding. Run it on the PR's code before the fix and see it **fail for the right reason**; keep that output for the report. A finding with no possible test (wording, documentation) says so.
2. **Fix the layer that owns the cause**, not the symptom, and add the nearby counterexample when a rule's reach changes.
3. **Update documents** the change makes stale, in the same PR.
4. Don't touch what the findings didn't name. Report a problem found on `main` as a separate one; don't fold it in.

## 4. Verify

```bash
npm run ci                  # full: lint, type check, unit tests, package, store ZIP, packaged E2E, AmWINS, GEICO, Progressive replays, Luna
```

Run the full set, not `--quick`, even when the change looks local: neighbouring E2E and mock runs are what a narrow change usually breaks. Add the extra comparisons `docs/testing.md` and apply-review-fixes step 3 list for the layers touched: the E2E baseline report, the benchmark, TNI's answer key. A check that already fails on the base branch is reported as such, with its output, and not fixed silently.

A step that didn't run (Playwright missing, port 8792 taken) is a failure, not a pass.

## 5. Push and comment

```bash
git push                                             # the pre-push hook skips the checks npm run ci just passed on this HEAD
git fetch origin && git rev-parse HEAD origin/<branch>   # both the same: the push landed
```

Never push with `--no-verify` unless the maintainer said so; if you did, say so in the report. Whether GitHub Actions ran: `gh pr checks <n>`. Don't dispatch `windows-smoke.yml` (paid minutes; local CI covers it). If Actions didn't run or failed for runner reasons, say so; local CI is the evidence, and the PR is not "CI-verified on GitHub".

Then post one comment on the PR (`gh pr review <n> --comment --body-file <file>`; `--approve` isn't possible on your own PR): the findings and what was decided for each, the tests added (and that each failed before the fix), the local CI result, the GitHub checks state, and what remains unverified. No client data.

## 6. Hand back and wait

Report per PR, then stop:

- **Findings**: real and fixed (test name), not real (why), needs the maintainer (the question).
- **Local CI**: `npm run ci` passed or which step failed; extra comparisons and their results.
- **GitHub**: checks ran and passed / didn't run / failed and why.
- **Verified how**: unit, replay or mock, packaged extension, or live carrier page. Live carrier behaviour (GEICO, Progressive, AmWINS server acceptance) is unverified unless it was run on the live site.
- **Test manually**: exactly what to check on the live site, and the absolute path of a build to load if the maintainer asked for one (`npm run package` in the checkout they'll load; output under `dist/`).
- **Merge order** for stacked or overlapping PRs.

Then ask whether to merge. Do nothing further until the maintainer answers.

## 7. Only after the maintainer confirms

- **Merge** only the PRs confirmed, in the stated order: `gh pr merge <n> --merge` (the repository keeps merge commits). Rebase and re-run `npm run ci` on a child whose base just merged before merging it.
- **Version bump, store package, release or deploy** only when the maintainer asks for that step itself (`docs/chrome-web-store.md`, `docs/hosting.md`). Merged to `main` is not yet with the agents; say so.
- Afterwards, delete the branches you created (`git branch -d`, `git push origin --delete` for those that merged) and leave `main` checked out and up to date. Never delete a branch with commits that aren't merged or pushed elsewhere; list them instead.
