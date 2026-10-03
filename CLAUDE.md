# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TNI Rater Autofill: a Chrome MV3 extension (side panel) that reads a client's TNI Commercial Insurance Quote Application PDF and fills commercial-auto quotes on carrier agent portals (Progressive ForAgentsOnly, AmWINS Admitted Placement; GEICO is generic-only). An optional TypeSafe AI Jev assistant (the agent's own per-device key, default model `jev-1.13.0`) recommends answers only for unresolved carrier choice controls. No build step: plain ES modules loaded straight from the repo.

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

**AI** (`src/ai/assist.js`, `src/ai/tni-rules.js`): rule-first TypeSafe AI Jev choice architecture. The request contains only unresolved radio/select/checkbox controls, their current carrier options, the active intake facts and the applicable carrier-scoped TNI rules. Jev can return an exact option or `leave`; it does not generate text or fill typed fields. Code checks the option, evidence source, active driver/vehicle context and a second verification result before an answer can be auto-eligible. Automatic selections are opt-in and still require agent approval before Continue. High confidence and provider probabilities are signals, not measured accuracy; ambiguous or unsupported cases abstain. The never-list (MVR/CLUE, exclusions, signatures/attestations, payment/SSN, typed IDs) remains enforced. The default endpoint is `https://api.typesafe.ai/v1/systemone`, with separate `jevKey` and `jevModel` settings; legacy OpenAI settings are never sent. `tni-rules.js` is the human-readable TNI rulebook sent to Jev; update it whenever a carrier rule's standard answer changes.

**Usage log**: `src/content/recorder.js` (isolated world, 1.5 s snapshots, agent vs page changes) → panel → `src/usage.js` events (never client data or typed text) → `sidepanel/usage-log.js` queue in `chrome.storage.local`, uploaded every minute → `server/index.mjs` on Railway (allowlisted event types/fields, dedup by id, upload token `RATER_TOKEN`, admin-token export). The extension uploads to the central server by default (`DEFAULT_SERVER`/`DEFAULT_TOKEN` in `sidepanel/usage-log.js`); an agent's own Server setting overrides it. Practice pages (`PRACTICE` in `src/carriers.js`: `test/replay`, `test/mock-progressive`, `test/fixtures/amwins`) get the real carrier's rules but nothing is logged. A new event type or field must be added to the server's `EVENT_FIELDS` or it is rejected.

**Test harnesses**: `test/pagekit.test.mjs` runs the real pagekit in a vm with a small fake DOM/ExtJS (no `isConnected`, minimal selectors: write engine code that tolerates that). `test/replay/` rebuilds Progressive pages as working ExtJS from layout JSON. `test/fixtures/amwins/application.html` is the saved AmWINS application (client data scrubbed) and `mock.js` reimplements the site's own behaviour (app-rel show/hide, Save & Continue, Import Data → Import Valid Records, VIN decoder, Default all No, select2); `scripts/amwins-mock.mjs` holds the expected answers (`EXPECT`).

## Working from live runs

The usual loop: the agent runs a live quote, leaves "Report a problem" notes, says "review the run". Run `npm run pull`, then read `server-data/events/<date>.jsonl` (types: `problem_report`, `fill_run` with `blockerList`/`advanced`, `fill_field` with `result`/`reason`/`timing`, `field_change` by `agent`, `page_layout`, `ai_suggest`/`ai_decision`), encode the notes as carrier rules (and `tni-rules.js`), add tests, run the suites, bump the version, package. Ask for TNI's standard answer when it can't be derived from the intake; never guess insurance answers. Saved carrier pages (HTML/PDF) and captures go under `layouts/`, which is git-ignored because they contain client data; never commit them, and scrub anything derived from them (names, addresses, license numbers, VINs) before it goes into `test/fixtures`.

## Keeping it robust (tests and the learning loop)

- `npm test` includes `test/consistency.test.mjs`: every event type the extension sends is accepted
  by the server and no fill-event field is dropped; the manifest allows every carrier host and the
  usage server; manifest and package versions match; committed fixtures/captures hold no client
  data (`scripts/lib/privacy.mjs`); commands named in the docs exist.
- `npm run coverage` (also a section of `npm run review` and the daily review issue): every
  question agents met on live pages, per carrier/state/product, matched against the current rules
  offline. "No rule" = a missing TNI rule or a changed carrier page; for AmWINS "not in the mock"
  = the site has a field `test/fixtures/amwins` lacks. Layouts record element ids / data-ids from
  0.8.1 on, so id-based rules (AmWINS) are checkable.
- Progressive replay in CI: `npm run e2e -- --fixtures` runs the committed per-state layouts in
  `test/fixtures/progressive/`. After new states or rule changes: `npm run pull`, `npm run layouts`,
  `npm run fixtures:progressive` (refuses anything that looks like client data), then
  `npm run e2e -- --update` (the baseline merge keeps entries CI doesn't run).
- AmWINS mock: when the site changes (coverage shows "not in the mock"), save the page again
  (Save page as, into `layouts/`), scrub, update `test/fixtures/amwins/` and `scripts/amwins-mock.mjs` EXPECT.

## Adding a carrier (GEICO is next: generic label rules only so far)

1. Capture pages during a live quote (side panel → Capture page layout, Report a problem notes) and
   save full pages to `layouts/<carrier>-html|pdf` (git-ignored).
2. `src/carriers/<carrier>.js` with rules and actions; register in `src/carriers.js`; add the host
   to `manifest.json` (the consistency test fails otherwise); `world: 'MAIN'` only if widgets live
   in the page's JS; `batch: true` only if answers never wait on the server (check the timing logs).
3. A mock or fixtures: saved-page mock like AmWINS when the page works without its server,
   layout fixtures + replay like Progressive when it doesn't. Add it to CI.
4. A section in `src/ai/tni-rules.js`, tests in `test/`, then `npm run coverage` after the first runs.

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
