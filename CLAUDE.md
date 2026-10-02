# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TNI Rater Autofill: a Chrome MV3 extension (side panel) that reads a client's TNI Commercial Insurance Quote Application PDF and fills commercial-auto quotes on carrier agent portals (Progressive ForAgentsOnly, AmWINS Admitted Placement; GEICO is generic-only). An optional AI assistant (OpenAI Responses API, the agent's own key, default model `gpt-6-luna`) suggests answers for questions the rules leave open. No build step: plain ES modules loaded straight from the repo.

## Commands

```bash
npm install
npm test                                   # node:test, all test/*.test.mjs
node --test test/pagekit.test.mjs          # one file
node --test --test-name-pattern="batch mode" test/pagekit.test.mjs   # one test
npm run mock:amwins                        # AmWINS end to end on the saved-site mock (Playwright)
npm run package                            # dist/tni-rater-autofill-<version>.zip AND dist/tni-rater-autofill/ (Load unpacked)
npm run e2e:extension                      # packaged extension + side panel on the AmWINS mock; needs `npm run package` and a server on :8792
npm run replay                             # python http.server on :8792 (replay page, AmWINS mock)
npm run e2e                                # Progressive replay regression vs test/e2e-baseline.json (--update to accept)
npm run server                             # local usage server (testing), 127.0.0.1:8787 -> server-data/events/*.jsonl
npm run pull                               # agents' usage log from the central server (Railway) -> server-data/events/
npm run push-logs -- <folder|file>         # upload a local/exported log to the central server (dedup by id)
npm run review                             # reviews/review-<date>.md from server-data (problems, AI, Speed, rule suggestions, layouts)
npm run layouts                            # per-state Progressive layouts -> captures/progressive/generated/ (git-ignored; e2e uses them)
npx playwright install chromium            # once, for mock/e2e scripts
```

CI (`.github/workflows/checks.yml`) runs `npm test`, `mock:amwins`, `package`, and `e2e:extension`. `npm run e2e` is local-only (it needs layouts built from local usage logs).

Release habit: bump `version` in both `manifest.json` and `package.json` for every shipped change (the Web Store refuses a repeated version), run the suites, `npm run package`.

## Architecture

**Data flow:** PDF → `src/intake.js` (pdf.js form fields; `lib/` is vendored pdf.js because MV3 can't load remote code) → `src/normalize.js` (client record + warnings; "clean formatting, never guess meaning") → `src/plan.js` `buildPlan(record, carrier, active)` turns carrier rules + `src/rules.js` generic label rules into steps → side panel injects `src/content/pagekit.js` into the rater tab (all frames) and calls `__raterKit.fill(plan, options)` → report back to the panel.

**Rules** (`src/carriers/*.js`, registered in `src/carriers.js`): each rule targets a field by `q` (Duck Creek question id, Progressive), `selector` (AmWINS uses ids and `[data-id=…]` for repeating sections), `withOption`, or `label` regex (+`not`); value from `path` or `value(record, active)`. Carrier rules come before generic rules; within a fill, plan order is fill order. Rule options interpreted by `plan.js`/`pagekit.js`: `kind` (bool, choice, int, state, date, money, first-option, pick-not, address-suggest, search-select…), `ignore`, `note` (agent's, never filled), `verifyOnly`, `replace` (overwrite a lookup's value), `trustPage` (lookup wording wins, no "differs" flag), `emptyNote` (page fills it; flag only if empty), `warn` (fill a default but mark yellow and hold Continue), `scope`/`vehicleHint`, `choiceAliases`, `search`, `fallback`. Carrier-level: `actions` (buttons to click: `after`, `afterActions`, `afterPages`, `immediate`, `opener`, `near`, `repeatOnReturn`…), `advance` (the Continue/Save & Continue pattern; Finish/Bind/Submit/Save & Exit are hard-blocked in `pagekit.js` NEVER_CLICK/NEVER_ADVANCE), `world: 'MAIN'` (Progressive: ExtJS components only reachable in the page's JS world), `batch: true` (AmWINS: answers don't hit the server, so a whole round is filled then settled once).

**Fill engine** (`src/content/pagekit.js`, classic script, no imports): rounds of collect controls → `assign()` pairs steps with controls → apply. Server-backed pages (ExtJS detected) do one answer per round and wait for Ajax + DOM quiet; batch pages fill everything visible per round. Answers the page later clears, changes, invalidates or doesn't keep are retried (max twice, `refill`/`retryOnce`), then reported failed. Blockers (unfamiliar, needs you, failed, required, differs, checks, waiting buttons) prevent `advance`. On one-address apps (AmWINS) the panel waits for the on-screen question `signature()` to change after Continue (`watchNextStep` in `sidepanel/sidepanel.js`) and retries a Continue that didn't take once. When changing pagekit's API, bump the `version` in `globalThis.__raterKit`.

**Side panel** (`sidepanel/sidepanel.js`): state (intake in `chrome.storage.session`), Check intake / Fill pages screens, auto follow-up fills driven by the recorder, background-tab pinning (keeps working on the quote tab when another tab is active), AI assist with per-question cache, report rendering. `test/sidepanel-safety.test.mjs` extracts named functions from this file by regex, so keep them as top-level `function` declarations (and avoid unbalanced quotes in comments inside them).

**AI** (`src/ai/assist.js`, `src/ai/tni-rules.js`): strict JSON-schema output with per-field option enums + `__leave__`; code checks that a pick is one of the options and any cited intake path exists; never-list (MVR/CLUE, exclusions, signatures/attestations, payment/SSN, typed IDs). `tni-rules.js` is the human-readable TNI rulebook sent to the model; update it whenever a carrier rule's standard answer changes.

**Usage log**: `src/content/recorder.js` (isolated world, 1.5 s snapshots, agent vs page changes) → panel → `src/usage.js` events (never client data or typed text) → `sidepanel/usage-log.js` queue in `chrome.storage.local`, uploaded every minute → `server/index.mjs` on Railway (allowlisted event types/fields, dedup by id, upload token `RATER_TOKEN`, admin-token export). The extension uploads to the central server by default (`DEFAULT_SERVER`/`DEFAULT_TOKEN` in `sidepanel/usage-log.js`); an agent's own Server setting overrides it. Practice pages (`PRACTICE` in `src/carriers.js`: `test/replay`, `test/mock-progressive`, `test/fixtures/amwins`) get the real carrier's rules but nothing is logged. A new event type or field must be added to the server's `EVENT_FIELDS` or it is rejected.

**Test harnesses**: `test/pagekit.test.mjs` runs the real pagekit in a vm with a small fake DOM/ExtJS (no `isConnected`, minimal selectors: write engine code that tolerates that). `test/replay/` rebuilds Progressive pages as working ExtJS from layout JSON. `test/fixtures/amwins/application.html` is the saved AmWINS application (client data scrubbed) and `mock.js` reimplements the site's own behaviour (app-rel show/hide, Save & Continue, Import Data → Import Valid Records, VIN decoder, Default all No, select2); `scripts/amwins-mock.mjs` holds the expected answers (`EXPECT`).

## Working from live runs

The usual loop: the agent runs a live quote, leaves "Report a problem" notes, says "review the run". Run `npm run pull`, then read `server-data/events/<date>.jsonl` (types: `problem_report`, `fill_run` with `blockerList`/`advanced`, `fill_field` with `result`/`reason`/`timing`, `field_change` by `agent`, `page_layout`, `ai_suggest`/`ai_decision`), encode the notes as carrier rules (and `tni-rules.js`), add tests, run the suites, bump the version, package. Ask for TNI's standard answer when it can't be derived from the intake; never guess insurance answers. Saved carrier pages (HTML/PDF) and captures go under `layouts/`, which is git-ignored because they contain client data; never commit them, and scrub anything derived from them (names, addresses, license numbers, VINs) before it goes into `test/fixtures`.

## Never automated

Bind, buy, finish, submit, Save & Exit, delete; MVR/CLUE orders, driver exclusions, signatures and
declarations, payment and SSN details stay the agent's (pagekit NEVER_CLICK/NEVER_ADVANCE and the
AI never-list).

## Hosting (docs/hosting.md)

- **Extension updates**: Chrome Web Store (private/unlisted). Raise `version` in `manifest.json` and
  `package.json` for every change; `npm run package`; upload the zip.
- **Usage server**: Railway project `tni-rater-autofill`, service `usage-server`
  (https://usage-server-production.up.railway.app), built from `server/Dockerfile`, volume at `/data`.
  Redeploy: `railway up --service usage-server` from the repo root. The extension uploads there by
  default with the built-in upload token (`DEFAULT_SERVER` / `DEFAULT_TOKEN` in
  `sidepanel/usage-log.js`); reading needs the admin token (Railway variable `RATER_ADMIN_TOKEN`,
  repo secret, `~/.config/tni-rater/admin-token`). Never print or commit the admin token.
- **Daily review**: `.github/workflows/daily-review.yml` at 06:00 UTC pulls the log, builds the review
  (artifact + run summary) and opens a `daily-review` issue when agents reported problems.

## Conventions

- Branch per change (`claude/<topic>`), PR to `main`; the maintainer merges unless they approve
  merging for that PR. CI (`.github/workflows/checks.yml`) runs unit tests, the AmWINS mock and the
  extension e2e on every PR.
- Comments explain the why in plain words, matching the surrounding style; user-facing text is
  plain English for agents (no jargon).
- Saved rater pages, PDFs and captures go in `layouts/` (git-ignored: client data). Fixtures that
  are committed must have client details scrubbed (names, addresses, license numbers, VINs).
- Usage events never carry client data (`src/usage.js`, and the server drops unknown fields).
