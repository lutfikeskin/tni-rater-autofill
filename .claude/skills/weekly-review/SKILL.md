---
name: weekly-review
description: Review a period of TNI Rater Autofill agents' live runs (usage logs, problem reports, agent edits and corrections, fill failures, AI suggestions, new questions, options and layouts), check whether last period's fixes held, and produce a prioritized decision brief with questions for the maintainer. Use when asked to review the week, summarize what agents ran into, or decide what to fix next. It changes no code; approved items go to the apply-review-fixes skill.
---

# Weekly review of agent runs

The outcome is a decision brief: what happened, which earlier fixes held, what to change (with evidence, layer, severity and size), and which insurance or workflow questions only the maintainer can answer. The maintainer decides; this skill never implements, releases or deploys.

Read `CLAUDE.md` (identical to `AGENTS.md`) first. Its working rules apply throughout: do not invent client facts or insurance answers; missing information, an explicit No and not applicable are three different things; a filled field or an accepted carrier value does not prove an answer correct.

## Rules for this review

- **Client data stays local.** Logs, problem reports and the reports built from them stay in ignored `server-data/` and `reviews/`. Anything posted to GitHub or written in chat names questions, pages, codes, counts and builds, never a client's name, address, VIN, phone, email, DOT/MC number or date of birth.
- **Evidence is not authorization.** Agents' majority answers, learner suggestions, AI acceptance rates and page defaults are candidates, never a reason to add a default. A rule that answers a client fact or a TNI decision needs the maintainer's answer (a "Decide" item below).
- **Build before blame.** Every finding names the builds it was seen on. A problem seen only on builds older than a fix is "Watch", not "Fix".
- **Count quotes, not events.** Fill runs repeat on a page; one quote re-run twenty times is one quote. Use the per-quote counts the reports give.
- **Leave test runs out.** Quotes of fixture, synthetic or the maintainer's test intakes are not agents' work. `npm run signals` leaves out intakes marked as a test (`test: true` on `intake_loaded`, when the panel sends it) and the fingerprints listed in `reviews/test-intakes.txt` (local, ignored; one per line). When a new intake looks like a test (quoted many times in a day, a fixture's name in the review), ask the maintainer and add it to the list.

## 1. Set up the period

```bash
git switch main && git pull --ff-only
npm ci                    # only when package-lock.json changed
npm run pull              # needs the admin token (~/.config/tni-rater/admin-token or RATER_ADMIN_TOKEN); if it's missing, ask
```

Make sure `reviews/test-intakes.txt` lists the test intakes: the SHA-256 of every PDF in `test/fixtures/`, `dist/synthetic-intakes/pdfs/` and the maintainer's test intakes (`shasum -a 256 <pdf>`).

The period starts where the last weekly review ended: the date in the title of the newest GitHub issue labelled `weekly-review` (`gh issue list --label weekly-review --state all --limit 1`), else the newest `reviews/weekly-*.md`, else 7 days ago. Use the same `--since` for every command below. Name this review by the ISO week of its last day: `W<week>` (for example `W42`); its items are `W42-01`, `W42-02`, …

## 2. Close the loop on earlier decisions

Read the open `weekly-review` issue (the ledger, step 7). For each item that is merged or released:

1. Find the builds that contain the fix. Events carry `v` (version), `channel` (`store`, `unpacked`, `source`) and, since 0.9.9, `commit` (`+dirty`: uncommitted changes on top). A build contains fix commit `F` when `git merge-base --is-ancestor F <commit>` succeeds. A build with a version only contains it when its version is at least the first `manifest.json` version after `F` (`git log --format='%h %s' F..main -- manifest.json`). Agents on the Web Store get a fix only after a store release (`docs/chrome-web-store.md`); merged to `main` is not released.
2. Look for the item's signature (the event, field, page and result recorded in the ledger) in this period's events from those builds.
3. Mark it **verified** (the scenario ran on a fixed build without the symptom), **recurred** (the symptom on a fixed build: reopen as a new item at its old severity or higher), or **not exercised** (no fixed build reached the scenario: keep watching).

Also read the comments on the open `daily-review` issue since the period start (`gh issue list --label daily-review --state open`, then `gh issue view <n> --comments`).

## 3. Gather the evidence

```bash
npm run signals -- --since <since>                                    # reviews/signals-<date>.md: compact, read this first
npm run review -- --since <since> --out reviews/review-<date>.md      # the full review: AI, problem reports, coverage, learner suggestions, layouts
```

If `scripts/benchmark.mjs` exists and the maintainer has given a folder with the intake PDFs, also replay the recorded quotes through today's rules:

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

Write `reviews/weekly-<date>.md` from `references/brief-template.md`. It opens with **For you**, in plain language for the maintainer, who is not reading code: what agents ran into this week, what is broken, what got better, and what you need from them. Then the weekly numbers against last week (from the previous ledger issue), then the details. Order findings by severity, then quotes affected. Keep evidence to counts, builds, pages, questions and short masked quotes of agents' reports.

Every Decide question carries your **recommendation** and **what happens if it isn't answered** (it stays the agent's question; nothing is defaulted). Every Fix item says in one line what the agent will notice when it ships.

Deliver it where the maintainer reads: send the brief as a file (in the Claude app, `SendUserFile`), not only a path. In chat, give the **For you** part, the S1/S2 items and the Decide questions, then ask item by item: approve (Fix), answer (Decide), defer or drop. Asking with a structured question (for example `AskUserQuestion`, several items per question) is easiest on a phone. Don't start fixing.

## 7. Record the decisions (the ledger)

After the maintainer has answered, keep the ledger as a GitHub issue so it survives machines and assistants. It holds IDs, titles, severity, type, decision and signatures, never client data.

- Create the label once if missing: `gh label create weekly-review --description "Weekly review ledger" --color 0E8A16`.
- Open `Weekly review W<week> (<since> – <date>)` with the label. Its body: the period, the **weekly numbers** table from the signals report (it is how next week compares, on any machine), and one checklist line per item: `- [ ] W42-03 · S2 · Fix · <title> · decision: approved · signature: fill_field failed "no option matches" on progressive CoveragesRates "Bodily Injury…"`. Add each Decide item's question and the maintainer's answer with its date.
- Carry items still open from the previous ledger into the new one (same ID), then close the previous issue with a link to the new one.

Ask before the first post: the ledger is a GitHub issue in the maintainer's private repository.

Hand over: approved items go to the `apply-review-fixes` skill with their IDs.
