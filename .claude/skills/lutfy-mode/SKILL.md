---
name: lutfy-mode
description: >-
  Lutfy's working conventions for TNI Rater Autofill: investigate before
  editing, live-verify fills, match models to the job, and encode repeated
  workflows as skills. Use for Lutfy, /lutfy-mode, or requests to work in
  this style.
disable-model-invocation: true
---

# Lutfy mode

Project rules live in `AGENTS.md`, which is identical to `CLAUDE.md`. Follow that file. This skill is how to work with the human on top of it.

Use "the user" in this file, not a first name.

## Understand first

Read the matching document or skill in the `AGENTS.md` table before changing that system. Do not load every document.

When the user asks what you think, whether something is hard, or to investigate, answer and propose. Do not edit until they say to.

A live-run problem starts from their recording, usage log, or the quote they just ran. Report what happened and what the agent corrected. Wait for a yes before changing fill behavior.

[weekly-review](../weekly-review/SKILL.md) proposes. It does not implement. Build only items they accepted. Do not count the user's own test quotes as agents' work. Ask when a run looks like theirs, and keep `reviews/test-intakes.txt` current.

Do not invent client facts or insurance answers. Missing, explicit No, and not applicable are different. A TNI standard recorded in [Intake and rules](../../../docs/intake-and-rules.md) may fill a blank the intake does not answer. Any other fill without intake support is invented. An ambiguous owner, name, or business-type match warns and leaves the field empty.

When the user states a TNI answer, encode it as a `standard` rule in that document and in code. Rewrite a conflicting rule. Do not stack a second one on top. Decide each concept once for every carrier. Prefer a class-level guard over a per-page patch.

Keep the current behavior when the user says it is fine. Drop a side task they abandon.

The implementation must not conflict with other rules, methods or implementations we had.

When you need a product or TNI decision from the user, ask one question at a time, in Turkish, with the recommended answer first. Recap in Turkish when they ask. Keep the recap as before and after.

## Review and verify

Done for a code change means the related tests passed, and the claim was proven on the same surface that showed the bug.

- `npm test` on code changes. `npm run typecheck` when types or behavior docs changed.
- The pull request's GitHub Checks are the gate: every `npm run ci` step runs there for each PR. Push, then watch them (`gh pr checks <n>`), and report their result. Do not run `npm run ci` locally before pushing; use it only to debug a failing job, and say so when you do.
- A skill, doc, or asset-only change needs no local checks beyond the ones it touches; its PR's Checks still run.
- Reproduce a fill or UI bug on the real page first. Prove the fix the same way.
- For panel or page changes, exercise the flow in a real browser. A screenshot is not verification.
- When they will live-test, give a loadable build from `npm run package`. State its version, the base commit, and whether it includes latest `main`.
- If behavior, commands, or data that a document describes changed, update that document in the same PR.

A green unit suite does not prove a carrier quote. Live carrier acceptance is unverified until they ran it, or you did on the live site.

## Subagents

Match the model to the job. Stronger for judgment and review. Faster for mechanical exploration.

Do not spawn a subagent for a lookup the parent can grep in one shot.

When they name a Cursor model on `/ship-pr`, use that model. Follow [ship-pr](../ship-pr/SKILL.md). A look-only review is [pr-review](../../../.bb/skills/pr-review/SKILL.md). Run Claude's review and the Cursor `/thermos` pass together, then compare before editing.

Push back on review scope creep. A suggestion outside what the PR set out to do is not a finding for this PR. Prefer the smallest change that removes the cause.

When they parallelize PR fixes, give each named PR one subagent of the model they named, on that PR's existing branch. Brief it fully. Review its diff yourself.

## Skills

If the same workflow instruction would otherwise be repeated, propose a skill or an enforcing hook. Land it as its own change when they agree.

When a review skill lands, update the related skill so the steps stay shared. Do not paste another skill's body here.

## Process

Work on a task branch in the main checkout, not a new git worktree. Create the branch from an explicit base, usually `origin/main`. Check `git status` and recent commits before committing.

Stage files by explicit path. Never `git add -A` or `git add .`. Leave the user's untracked files alone.

The exception is parallel named subagents, which may use an isolation worktree. Remove that worktree and its empty branch after the PR is pushed. Leave other sessions' worktrees alone.

Push, open a PR, merge, bump the version, cut a release, or deploy only when they ask for that step. "Merge if clean" and "I approve your decisions" apply to that PR only. Ask again for the next one.

Follow [Corrections](../../../docs/corrections.md) for a reported wrong answer or failed fill. Follow [Testing](../../../docs/testing.md) for what each check covers.
