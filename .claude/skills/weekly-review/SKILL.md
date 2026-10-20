---
name: weekly-review
description: Review a period of TNI Rater Autofill agents' live runs (usage logs, problem reports, agent edits and corrections, fill failures, AI suggestions, new questions, options and layouts), check whether last period's fixes held, and produce a prioritized decision brief with questions for the maintainer. Use when asked to review the week or the last few runs, summarize what agents ran into, or decide what to fix next. It changes no code; approved items go to the apply-review-fixes skill.
---

# Weekly review of agent runs

The outcome is a decision brief: what happened, which earlier fixes held, what to change (with evidence, layer, severity and size), and which insurance or workflow questions only the maintainer can answer. The maintainer decides; this skill never implements, releases or deploys.

Read `CLAUDE.md` (identical to `AGENTS.md`) first. Its working rules apply throughout: do not invent client facts or insurance answers; missing information, an explicit No and not applicable are three different things; a filled field or an accepted carrier value does not prove an answer correct.

## Rules for this review

- **Client data stays local.** Logs, problem reports and the reports built from them stay in ignored `server-data/` and `reviews/`. Anything posted to GitHub or written in chat names questions, pages, codes, counts and builds, never a client's name, address, VIN, phone, email, DOT/MC number or date of birth.
- **Evidence is not authorization.** Agents' majority answers, learner suggestions, AI acceptance rates and page defaults are candidates, never a reason to add a default. A rule that answers a client fact or a TNI decision needs the maintainer's answer (a "Decide" item below).
- **Build before blame.** Every finding names the builds it was seen on. A problem seen only on builds older than a fix is "Watch", not "Fix".
- **Count quotes, not events.** Fill runs repeat on a page; one quote re-run twenty times is one quote. Use the per-quote counts the reports give.
- **Leave test runs out.** Quotes of fixture, synthetic or the maintainer's test intakes are not agents' work. `npm run signals` and `npm run review` leave out intakes marked as a test (`test: true` on `intake_loaded`, when the panel sends it), the PDFs under `test/fixtures/` and `dist/synthetic-intakes/pdfs/` (by SHA-256, on any computer), and the fingerprints listed in `reviews/test-intakes.txt` (local, ignored; one per line), or the list `--tests <file>` names. A report that says **No test-run list** counted the maintainer's own test quotes as agents' work: run it again with `--tests`. When a new intake looks like a test (quoted many times in a day, a fixture's name in the review), ask the maintainer and add it to the list.
- **Few quotes, no trend.** Every weekly number is per quote; show each period's quote count beside it, and call no trend when either period has fewer than about 10 quotes.
- **Local data is in the main checkout.** `server-data/`, `reviews/` (with `reviews/test-intakes.txt`) and `layouts/` are ignored, so a worktree (`.claude/worktrees/<name>`) has none of them; they are in the main checkout folder, the first line of `git worktree list`. From a worktree, pass their paths: `npm run pull -- --out <main>/server-data`, `node scripts/weekly-signals.mjs <main>/server-data --tests <main>/reviews/test-intakes.txt --out <main>/reviews/signals-<date>.md`, and the same data path, `--tests` and `--out` for `scripts/review.mjs`, `scripts/ledger.mjs` and `scripts/benchmark.mjs`. Without `--since`, `scripts/review.mjs` starts from the last review in `reviews/` of the checkout it runs in, so from a worktree pass `--since` too.

## 1. Set up the period

```bash
git switch main && git pull --ff-only    # in a worktree: git fetch origin main, and work from origin/main
npm ci                    # only when package-lock.json changed
npm run pull              # needs the admin token (~/.config/tni-rater/admin-token or RATER_ADMIN_TOKEN); if it's missing, ask
```

Make sure `reviews/test-intakes.txt` lists the maintainer's test intakes (`shasum -a 256 <pdf>`); the PDFs in `test/fixtures/` and `dist/synthetic-intakes/pdfs/` are left out without it. Working from a git worktree, pass the main checkout's paths to the commands below, as **Local data is in the main checkout** says.

The period starts where the last weekly review ended: the date in the title of the newest GitHub issue labelled `weekly-review` (`gh issue list --label weekly-review --state all --limit 1`), else the newest `reviews/weekly-*.md`, else 7 days ago. Use the same `--since` for every command below. Name this review by the ISO week of its last day: `W<week>` (for example `W42`); its items are `W42-01`, `W42-02`, …

## 2. Close the loop on earlier decisions

```bash
npm run ledger -- --since <since>        # reviews/ledger-<date>.md; --ledger <n> for another issue than the open one
```

It reads the open `weekly-review` issue (the ledger, step 7) through `gh` and changes nothing. For each item it finds the PRs (those its line names, and those whose title names its ID) and their merge commits, then which builds that logged the period contain the fix: a build with a `commit` (since 0.9.9; `+dirty`: uncommitted changes on top) when the fix's merge commit is its ancestor, else one whose version is at least the first `manifest.json` version after the fix. It counts the item's signature on those builds' events, per quote, and proposes:

- **verified**: on a build with the fix, the expected event was there, or the scenario ran without the symptom;
- **recurred**: the symptom on a build with the fix, or the expected event missing where it should be: reopen it as a new item at its old severity or higher;
- **not exercised**: no build with the fix reached it: keep watching. Merged to `main` is not released; agents on the Web Store get a fix only after a store release (`docs/chrome-web-store.md`).

These are proposals from counts: read each item's evidence, and check by hand the ones it marks so: no signature, a signature it couldn't read, a free-text one (it shows the counts of the events the text names, as information only), or a failed PR lookup. A **(test runs only)** status rests only on test runs: no agent's quote has shown it yet. Its "Last period's decisions" table and its weekly numbers beside the ledger's go into the brief.

Also read the comments on the open `daily-review` issue since the period start (`gh issue list --label daily-review --state open`, then `gh issue view <n> --comments`).

## 3. Gather the evidence

```bash
npm run signals -- --since <since> [--tests <list>]                                 # reviews/signals-<date>.md: compact, read this first
npm run review -- --since <since> [--tests <list>] --out reviews/review-<date>.md   # the full review: AI, problem reports, coverage, learner suggestions, layouts
```

Both warn on stderr, and say so in the report, when they find no test-run list. Written anywhere in `reviews/` as above, the review also refreshes `reviews/transitions-<date>.md`, `reviews/captures-<date>.md` and the generated layouts in `captures/<carrier>/generated/`. With `--out` anywhere else, those go next to that file instead.

If the maintainer has given a folder with the intake PDFs, also replay the recorded quotes through today's rules:

```bash
npm run benchmark -- --intakes <folder> --save reviews/benchmark-<date>.json [--against reviews/benchmark-<last>.json]
```

Read `reviews/signals-<date>.md` whole; its "Weekly numbers" are the ones the brief tracks week over week (save them: `npm run signals -- --since <since> --json > reviews/signals-<date>.json`). Read the review's sections as each finding needs them; don't paste either report into chat. Where a count needs explaining, query the events directly (`loadEvents` in `scripts/lib/events.mjs`), still counting per quote.

## 4. Collect findings, source by source

Go through every source; a finding can come from several. Use `references/triage.md` for what each source usually means and which layer owns it.

1. **Safety** (signals: restricted actions; review: problem reports). Any restricted action by the extension, an answer written on another client's quote (`fill_error` stale), an agent's edit overwritten, Continue clicked with a question open, client data where it shouldn't be.
2. **Problem reports.** Every one, individually, with the build and the fill around it from the signals report.
3. **Agent corrections.** The review's "Autofilled answers the agent corrected", "Rules agents keep correcting" and the summary's "Autofill answers agents changed"; answers put back after the page changed them (answer retention).
4. **Fill failures** by reason (signals): "no option matches" (the carrier's options changed, or a rule's value isn't offered), "the page did not keep the answer", "marks this answer invalid".
5. **Left to the agent and what held Continue** (signals): `unfamiliar` (no rule: a missing rule or a changed page), `leftRequired`, `noData` (the intake has no answer: a fact, or an intake gap), blockers by quotes held.
6. **Carrier changes.** "New questions without a rule" and rule coverage (review), signs of a changed page (signals), new follow-ups and unseen answers (review: when questions show), manual captures.
7. **AI assistant** (signals by build; review per question). Error rates by build, dismissed or rejected suggestions, questions the AI keeps answering.
8. **Intake.** Warning codes and the intake fields agents corrected in the panel (review: usage summary).
9. **Where quotes stopped** (signals: how far quotes got). A page most quotes reach but few leave is a finding; speed only when agents complain about it.
10. **Learner suggestions** (review: rule suggestions). Each is a candidate needing a decision, never a ready rule.
11. **Infrastructure.** Fields the server dropped, a deployed server that isn't this repository's, daily review runs that failed.

## 5. Triage each finding

For each, record:

- **Builds** where it was seen, and whether `main` already changed the area since (`git log --oneline <oldest build commit>..main -- <files>` and the PRs merged since). Fixed on `main` but not released: **Watch** after the release.
- **Root cause and layer**, from the table in `docs/corrections.md` (intake reading, mapping or row, scoped rule, browser execution, AI, missing fact or TNI decision) plus the panel/report UI. Merge findings with one cause into one item.
- **Severity**:
  - **S1**: wrong answer entered without a review stop, a restricted action, an answer on another client's quote, an agent's edit lost, client data exposed.
  - **S2**: quote stuck or abandoned; a wrong answer the agent had to catch and correct.
  - **S3**: extra agent work (unfamiliar, noData, a helper the agent clicked by hand) or a misleading panel message.
  - **S4**: cosmetic, wording, speed.
- **Type**:
  - **Fix**: the cause is clear and the change is code (or a rule from an answer the maintainer already gave).
  - **Decide**: needs a TNI insurance or workflow answer. Write the question with its options, the evidence for each, and what stays the agent's meanwhile.
  - **Capture**: needs a live layout or before/after captures (`npm run captures`, `docs/new-carrier.md`). Say which page, scenario and answer to change.
  - **Watch**: already fixed or too little data; give the signature to check next week.
  - **Drop**: intended behavior or noise; say why (for example an attestation the agent must answer).
- **Size** (S, M, L) and **reach**: carriers, states, pages, quotes affected.

## 6. Write the brief and ask for decisions

Write `reviews/weekly-<date>.md` from `references/brief-template.md`. It opens with **For you**, in plain language for the maintainer, who is not reading code: what agents ran into this week, what is broken, what got better, and what you need from them. Then the weekly numbers against last week (the ledger report's table, with each period's quote count), then the details. Order findings by severity, then quotes affected. Keep evidence to counts, builds, pages, questions and short masked quotes of agents' reports.

Every Decide question carries your **recommendation** and **what happens if it isn't answered** (it stays the agent's question; nothing is defaulted). Every Fix item says in one line what the agent will notice when it ships.

Deliver it where the maintainer reads: send the brief as a file (in the Claude app, `SendUserFile`), not only a path. In chat, give the **For you** part, the S1/S2 items and the Decide questions, then ask item by item: approve (Fix), answer (Decide), defer or drop. Asking with a structured question (for example `AskUserQuestion`, several items per question) is easiest on a phone. Don't start fixing.

## 7. Record the decisions (the ledger)

After the maintainer has answered, keep the ledger as a GitHub issue so it survives machines and assistants. It holds IDs, titles, severity, type, decision and signatures, never client data.

- **The issue body is the ledger.** An item's state lives on its line in the body: tick and update lines in place (`gh issue view <n> --json body --jq .body > <file>`, edit the file, `gh issue edit <n> --body-file <file>`) and add new items there. Comments are history (a copy of the brief, a spot review); a line only in a comment is not in the ledger, and `npm run ledger` flags it.
- Create the label once if missing: `gh label create weekly-review --description "Weekly review ledger" --color 0E8A16`.
- Open `Weekly review W<week> (<since> – <date>)` with the label. Its body: the period, the **weekly numbers** table (this period's column from the ledger report, quotes first; it is how next week compares, on any machine), and one checklist line per item:

  ``- [ ] W42-03 · S2 · Fix · <title> · approved · PR #77 · signature: `symptom fill_field page=CoveragesRates result=failed reason~"no option matches"` ``

  Fields are separated by ` · `: ID, severity, type, title, the decision (`approved`, `question: …`, `answer: … (TNI, <date>)`, `awaiting approval`, `dropped`, `deferred`), then `PR #n`, the status the fix skill keeps (`PR open`, `merged <commit>`, `released in <version>`), and the signature last. Add each Decide item's question and the maintainer's answer with its date.
- **Write signatures so `npm run ledger` can count them**: `expect` (the fix makes this event appear) or `symptom` (this event is the problem), an event type or `*`, then conditions `field=value`, `field!=value`, `field~text` (case-insensitive, or `~/regex/`), `field>n`, `field<n`, `field=*` (present), `field!=*` (absent). A field must be one the collection server keeps for that event type (`COMMON` and `EVENT_FIELDS` in `server/index.mjs`; for `*`, any of them), else the signature isn't read: a condition on a field the events never carry never matches, and a symptom would pass as verified. Fields may be dotted under a kept one (`platform.os`); a value with spaces goes in double quotes. `when <event> <conditions>` names the scenario that must have run for the item to be exercised; a symptom without one uses its own event on the same carrier, page, step and question. Several patterns: each in its own backticks. For example `symptom fill_field key=ref:USDOTInput.ConfirmInformation result=noData`, `expect agent_settings when intake_loaded`, `symptom page_view page=/application/commercialproperty when page_view carrier=amwins`. Free text is accepted but never judged (`npm run ledger` lists it to check by hand, with the counts of the event types it names in backticks); a signature only a person can check (a line of a report, a sequence of events, a value the events don't carry) stays free text.
- Closing the loop (step 2): tick a verified item (`- [x]`, adding `verified <date> on <build>`), leave a not-exercised one open, and reopen a recurred one as a new item that names the old ID.
- Carry items still open from the previous ledger into the new one (same ID), then close the previous issue with a link to the new one.

Ask before the first post: the ledger is a GitHub issue in the maintainer's private repository.

Hand over: approved items go to the `apply-review-fixes` skill with their IDs.

## Spot review: the last few runs

For "review my last N runs" (or "the quote I just ran"), a short check instead of the week:

1. `npm run ledger -- --last <n>`: it prints the window those quotes were received in and judges the ledger's items on them.
2. `npm run signals -- --since <that time>`: the builds, how each quote ended, what was left to the agent, what held Continue, the extension's clicks, crashes, AI errors, lost events and problem reports.
3. Write `reviews/last-runs-<date>.md`: the runs (carrier, build, how far, minutes); safety (restricted actions, crashes, AI errors, lost events); the ledger items these runs verified, left not exercised or showed recurring; and new findings, triaged as in step 5 and numbered in the coming weekly review's series (`W43-01` after a W42 ledger), after any IDs it already has. No weekly numbers or trends: a few quotes call none.
4. Ask the maintainer item by item as in step 6. After they answer, update the ledger body (step 7): add the new items, tick the verified ones. Then post the summary as a comment on the ledger (`Spot review: the last <n> runs (<window> UTC)`): IDs, builds and counts, no client data. The comment is history; the body holds the state.
