# TNI Rater Autofill

Chrome MV3 extension for TNI (Truckers National Insurance) agents: reads the client's TNI quote
application PDF and fills commercial auto quotes on carrier portals (Progressive / ForAgentsOnly,
AmWINS Admitted Placement, GEICO), with an optional AI assistant (OpenAI `gpt-6-luna`, the agent's
own key) for questions the rules leave open. Five pilot agents in the US; the maintainer reports
in Turkish or English.

## Layout

- `sidepanel/` the UI (side panel), `usage-log.js` (queue + upload to the usage server)
- `src/content/pagekit.js` the fill engine injected into the rater page (bump `__raterKit.version` on change)
- `src/content/recorder.js` watches the page: agent edits, new fields, page views
- `src/carriers/*.js` per-carrier rules and actions; `src/carriers.js` host → carrier, practice pages
- `src/plan.js` rules → steps; `src/rules.js` generic label rules; `src/normalize.js` intake → record
- `src/ai/` AI assistant (`assist.js`) and TNI's rules text (`tni-rules.js`: keep in sync with carrier rules)
- `server/index.mjs` usage server (Railway), `scripts/` review, pull/push, package, e2e, mock
- `test/fixtures/amwins/` AmWINS mock (saved site + `mock.js` playing the site's own script)

## Commands

```bash
npm test                 # unit tests (node:test)
npm run e2e              # Progressive replay of every recorded layout vs test/e2e-baseline.json
npm run mock:amwins      # AmWINS mock: all five steps, every answer checked
npm run package          # dist/tni-rater-autofill-<version>.zip + dist/tni-rater-autofill/ (unpacked)
npm run e2e:extension    # packaged extension + side panel on the AmWINS mock (needs port 8792 serving the repo)
npm run pull             # agents' usage log from Railway -> server-data/events/
npm run review           # reviews/review-<date>.md: problem reports, AI, speed, rule suggestions, layouts
```

Run `npm test`, `npm run e2e` and `npm run mock:amwins` before every commit that touches rules
or the engine; `npm run e2e:extension` when the side panel flow changes (serve the repo with
`python3 -m http.server 8792 --bind 127.0.0.1` if nothing is on 8792).

## Working on a run ("review the run")

The maintainer runs live quotes and leaves **Report a problem** notes. To review: `npm run pull`
(or read `server-data/events/*.jsonl`), look at the run's `problem_report`, `fill_run`
(blockerList, advanced), `fill_field` (result, reason, timing), `field_change` by the agent and
`ai_suggest`/`ai_decision`. Turn the notes into rules, ask for TNI's standard answer when it isn't
derivable (never guess insurance answers), add tests, bump the version, package, commit, PR.

## Engine facts worth knowing

- **Progressive** (ExtJS + Duck Creek): every answer waits on the server (`serverBacked`), one answer
  per round; questions keyed by Duck Creek ids (`q`). Rules in `progressive.js` cover every question
  seen in the saved FAO quote (IA) and live runs in MD/NC/OH/IN/PA/IA/FL.
- **AmWINS**: one address for all steps; no answer hits the server, so `batch: true` (a round of
  answers at a time); repeating sections targeted by `[data-id=…]`; Save & Continue advances and the
  side panel waits for the questions to change (`watchNextStep`); Submit and the declaration are
  never touched. Import Data → Import Valid Records adds vehicles.
- Rule options beyond the basics: `replace` (our answer beats a lookup's), `trustPage` (lookup wins,
  no "differs" flag), `emptyNote` (page fills it; flag only if empty), `warn` (fill a default, mark
  yellow, hold Continue), `repeatOnReturn` on actions (run again on each arrival at the page).
- Answers the page clears, changes or marks invalid afterwards are given again (at most twice).
- A Continue that doesn't take (page unchanged ~6 s) is clicked once more.
- Never click: bind, buy, submit, save & exit, delete; MVR/CLUE orders, exclusions, signatures,
  payment details stay the agent's (also enforced in the AI never-list).

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
