---
name: apply-review-fixes
description: Implement and verify the TNI Rater Autofill fixes a maintainer approved from a weekly review (items like W42-03 in the weekly-review ledger issue or a reviews/weekly-*.md brief) - reproduce each with a test, fix the responsible layer, run the affected checks, compare answers before and after, open a PR per coherent change, and update the ledger with what to watch. Use when asked to fix, implement or ship approved review items. It does not merge, release or deploy unless asked.
---

# Applying approved review fixes

The outcome is one pull request per coherent change, each reproducing its problem in a test, fixing it in the layer that owns it, showing which answers changed and why, and naming the signature the next weekly review checks. Release to agents is a separate, explicit step.

Read `CLAUDE.md` (identical to `AGENTS.md`) first and follow it: task branch, scope, documents to update, and the restrictions on binding, purchasing, submitting, ordering reports and signing.

## 0. Know exactly what was approved

- The items come from the maintainer: IDs from the open GitHub issue labelled `weekly-review` (`gh issue view <n>`) or from the chat, with the brief `reviews/weekly-<date>.md` when it is on this computer.
- Implement **Fix** items, and **Decide** items only with the maintainer's recorded answer, applied exactly as given. A Capture, Watch or Drop item is not implemented; an item whose cause turns out different from the brief goes back to the maintainer before changing course.
- Nothing about an insurance answer is inferred here. If a fix needs an answer the maintainer hasn't given (a client fact, a coverage default, an applicability rule), stop that item and ask.

## 1. Group and branch

```bash
git switch main && git pull --ff-only && git status --short   # clean tree; in a worktree: git fetch origin main, branch from origin/main
npm ci                                                        # when package-lock.json changed
```

One branch and PR per root cause or layer: two items with one cause share a PR; unrelated items don't. Branch names: `codex/<topic>` for Codex, `claude/<topic>` for Claude, as `CLAUDE.md` says.

Before changing anything, record where `main` stands:

```bash
npm test
npm run e2e -- --fixtures                        # Progressive layout replays; must match test/e2e-baseline.json
npm run benchmark -- --intakes <folder> --save reviews/benchmark-base.json   # only if the maintainer gave the PDF folder
```

When TNI's answer key exists (`layouts/answer-key/key.json`, its PDFs in `layouts/intakes`), add `--key layouts/answer-key/key.json` to that benchmark run (and `--intakes layouts/intakes` if the folder given doesn't hold them), so step 3 can compare the key's score.

The usage data, `reviews/` and `layouts/` are ignored, so a worktree (`.claude/worktrees/<name>`) has none of them: they are in the main checkout folder, the first line of `git worktree list`. From a worktree, pass their paths (`node scripts/benchmark.mjs <main>/server-data --intakes <folder> --save <main>/reviews/benchmark-base.json`), and read raw captures from `<main>/layouts/`.

A check that already fails on `main` is reported as such, not fixed silently inside an unrelated item.

## 2. Fix each item

Follow `docs/corrections.md` for every item, and read the document for its layer from the table in `CLAUDE.md` (intake and rules, browser filling, AI assistance, learning, hosting).

1. **Restate it** as expected versus actual for its scenario: carrier, page, state or product, entity (which vehicle, driver or trailer), and the build it was seen on. Separate a one-client correction from a reusable rule.
2. **Reproduce it first** with the smallest test that fails for the right reason: a unit test in the matching file (`test/progressive.test.mjs`, `test/geico.test.mjs`, `test/normalize.test.mjs`, `test/pagekit.test.mjs`, `test/learn.test.mjs`, …), a scrubbed fixture (`test/fixtures/`; GEICO's `quote.html` is rebuilt by `node scripts/geico-fixture.mjs`, which reads the raw pages from `layouts/geico`, the main checkout's from a worktree, and writes nothing on a privacy finding), or a synthetic intake. Never commit a raw carrier page, a client PDF or a client value; raw evidence stays in ignored `layouts/`.
3. **Fix the layer that owns the cause**, keeping its contracts:
   - a rule declares its answer's `source`; facts and attestations stay the agent's (`test/provenance.test.mjs`);
   - exact mappings and calculations stay in code; the model only resolves a bounded choice; a standard represented in `src/ai/tni-rules.js` changes there too;
   - agent edits stay protected, review stops and retained-value checks stay, and `NEVER_CLICK` / `NEVER_ADVANCE` are never widened to make a flow pass;
   - an answer the maintainer decided carries its source and date in a comment, as existing rules do (`(TNI, 2026-10-09)`), and becomes a test case that fails if the answer changes;
   - a usage server change that accepts new event fields is deployed before the extension that sends them (`docs/hosting.md`).
4. **Add the nearby counterexample** when the change alters where a rule applies: the state, class, vehicle type, entity or answer where it must not apply.

## 3. Verify

Run `npm test` and the checks the `docs/testing.md` table lists for the layers touched:

| Touched | Checks |
| --- | --- |
| Intake reading or normalizing | `test/normalize.test.mjs`, `test/intake-regressions.test.mjs` |
| Progressive rules or page execution | `test/progressive.test.mjs`, `test/pagekit.test.mjs`, `npm run e2e -- --fixtures` (and `-- --renumber` for matching changes) |
| AmWINS rules or flow | `npm run mock:amwins` |
| GEICO rules or quote flow | `test/geico.test.mjs`, `test/geico-fixture.test.mjs`, the GEICO tests in `test/pagekit.test.mjs`, `test/recorder.test.mjs` and `test/sidepanel-safety.test.mjs`, `npm run mock:geico` |
| Panel or packaged behavior | `test/sidepanel-safety.test.mjs`, then `npm run package`, `npm run replay` (port 8792) and `npm run e2e:extension` |
| AI validation, approval, caching | `test/luna.test.mjs`, `test/ai-eval.test.mjs`, `npm run mock:luna` (after `npm run package`) |
| Events, learning, reports, server | the matching `usage`, `usage-log`, `learn`, `coverage`, `signals`, `server`, `consistency` tests |

Then compare answers on the same inputs:

- **E2E baseline**: when a replay page's outcome changes, read the report (`reviews/e2e-<date>.md`) and explain every changed page in the PR. Accept it with `npm run e2e -- --update` only when each change is the intended one; never to turn a failure green.
- **Benchmark** (when it ran in step 1): `npm run benchmark -- --intakes <folder> --against reviews/benchmark-base.json`. Every "now differs" and "handed to the agent" change is either the intended effect, listed in the PR, or a regression to fix before the PR.
- **TNI's answer key** (when `layouts/answer-key/key.json` exists): run the base in step 1 and the branch both with `--key layouts/answer-key/key.json` (PDFs in `layouts/intakes`). Compare "Against TNI's answer key" before and after, both tables (every keyed answer, and the reviewer's decided answers: entries confirmed as proposed agree with the old rules by construction, so the decided table is the evidence), and read "Answer key compared with …": invented must stay 0, and every keyed answer that became wrong or missed is a regression to fix before the PR unless the maintainer decided the key's answer changes, in which case update the key with `npm run key:sheet -- --key` and say so. Put the counts in the PR (right, wrong, missed, invented, all and decided, before → after), never the key's values: it holds client answers.

Re-read the diff against the item before opening the PR: does it fix the cause the evidence shows, and only that? Run a code review pass when one is available.

## 4. Documents, PR and ledger

- Update every document that describes the changed behavior, command or data (`CLAUDE.md` rule), and keep `AGENTS.md` and `CLAUDE.md` identical if either changes.
- Open the PR against `main`, its title ending with the item IDs (`… (W42-03)`, `… (W42-06, W42-10)`): `npm run ledger` finds an item's PR by its title or by the `PR #<n>` on its ledger line, never by a mention in a body. Body: the item IDs and the ledger issue (`Refs #<n>`); expected versus actual for each item; the reproducing test; the checks run, with results; the e2e and benchmark changes, each explained; the documents changed (or why none); and **Watch next week**: each item's signature in the ledger's structured form (event type, page, field and value). No client data in the PR.
- Update the ledger issue's body, in place: the body is the ledger, comments are history (`gh issue view <n> --json body --jq .body > <file>`, edit the item's line, `gh issue edit <n> --body-file <file>`). Each item's line gets `PR #<n>` and the status `PR open`; after the maintainer merges, `merged <commit>`; after a store release, `released in <version>`. Write its signature in the structured form the weekly-review skill describes (step 7: `symptom …` or `expect …`), so `npm run ledger` counts it on builds that contain the fix next week. An item found only in a comment moves into the body.
- Don't merge, bump the version, package for the store, upload or deploy unless the maintainer asks; `docs/chrome-web-store.md` and `docs/hosting.md` cover those steps. Say plainly that merged to `main` is not yet with the agents.

## 5. Report back

For each item: fixed or not, what was exercised (unit, replay, mock, packaged extension), what changed in answers, what remains live-only (a carrier's server acceptance, a real lookup), and the signature to watch. Items stopped for a missing decision are listed with the question.
