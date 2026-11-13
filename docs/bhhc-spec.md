# Spec: adding BHHC (Berkshire Hathaway Homestate Companies)

Status: **planned (pre-recon)**, written 2026-11-13 against `main` (`932471db`) and reviewed against the code the same day. **Line references point to `932471db`**; `main` has moved since (e.g. `e528907d`). The gates this spec relies on are unchanged there, but line numbers are not, so re-pin them when Phase 1 starts. Nothing BHHC-related exists in the repository or `layouts/` yet: no branch, stub, captures, fixtures, or rules. Public sources put BHHC's commercial-auto agent login and rater at `portal.bhhomestate.com` (see Phase 0); the live walk in Phase 0 confirms it and any frame origins before Phase 1. Open questions for the maintainer and TNI are listed at the end.

### v1 scope

BHHC's small-risk rater, **Breeze**, gives indications for 1–10 power units across many classes, is not offered in every state (AL and LA domiciles are ineligible), and routes fleets of 11+ units to BHHC's fleet team outside the rater ([BHHC rater info](https://bhhc.com/commercial-auto/auto-rater-info)). v1 targets **Breeze only, 1–10 power units**; the fleet path is out of scope. The extension never blocks on eligibility. TNI has decided (2026-11-13) that the agent is **warned** before quoting when an intake falls outside Breeze:
- **Power units:** each intake vehicle counts as one power unit; trailers are separate units in the intake and are not counted. More than 10 vehicles → warning.
- **Domicile:** the state of the intake's **garaging address** (TNI, 2026-11-13); an ineligible one (AL, LA, or a state Breeze does not offer) → warning.
- The warning is a `check`-level intake warning shown only on BHHC's site, modelled on `prior.carrier-is-quoted` ([src/normalize.js](../src/normalize.js#L1236-L1239)). It warns and never blocks. It lands with the first BHHC rules, and its state list comes from what recon shows Breeze accepts. If Breeze shows its own ineligibility screen, that screen is also the carrier's `stopped` screen (finding #6).

## Goal

Support commercial-auto quoting on **BHHC** (`id: 'bhhc'`, Berkshire Hathaway Homestate Companies) from a TNI Commercial Insurance Quote Application PDF, following the repository's **locked-down recon stub → live multi-scenario capture & recording → privacy-scrubbed offline mock/replay → provenance-verified rules** pipeline ([new-carrier.md](new-carrier.md)).

### Non-negotiable invariants

1. **Zero invented answers.** Distinguish missing information (`null` / unfilled), explicit `No`, and not applicable ([intake-and-rules.md](intake-and-rules.md)). Every rule that computes an answer declares a valid `source` from `SOURCES` in [plan.js](../src/plan.js): `intake`, `derived`, `standard`, `fact`, or `attestation`.
2. **No `standard` rules until TNI confirms them.** Until TNI explicitly records BHHC standards, BHHC ships with **zero** `source: 'standard'` rules and **no** `supportedClasses` (matching GEICO prior to 2026-10-21): every question the intake does not answer is left to the agent or handed to Luna as a bounded choice.
3. **Uncollected client facts and attestations stay manual.** Rules for client facts or legal attestations the intake does not collect carry `source: 'fact'` or `'attestation'` and a `note`. That source is what makes the step `manualOnly: true` (never filled and never sent to Luna); a `clientFact` rule is also manual-only when the intake has no answer ([plan.js](../src/plan.js#L18-L22)). Omitting `value` alone does not.
4. **Agent authority, retention, and hard stops.** Agent manual edits persist by field key ([field-key.js](../src/content/field-key.js)) and are never overwritten. Fills stop strictly before ordering MVR/CLUE reports, entering payment/bank details, signing, binding, purchasing, or submitting (`stopPages`, `stopSteps`, `stopButtons`, `agentPages`, `warnPages`).
5. **Raw captures stay local; committed fixtures are scrubbed.** Raw HTML, PDFs, `Alt+Shift+C` captures, and developer recordings stay in gitignored `layouts/bhhc/` and `layouts/recordings/` (enforced by [consistency.test.mjs](../test/consistency.test.mjs)). Any committed fixture under `test/fixtures/bhhc/` (or `test/replay/`) is built by a deterministic scrubber script that aborts without writing on any `findPii` or session-token hit ([privacy.mjs](../scripts/lib/privacy.mjs)).

---

## How the current architecture behaves on a new carrier

Understanding these mechanics avoids accidental live fills, unredacted telemetry, or broken tests during reconnaissance:

- **Dynamic script injection (no static `content_scripts`).** [manifest.json](../manifest.json) declares no `content_scripts`. The side panel injects scripts on demand with `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, ... })`:
  - Fills and manual layout captures use `injectKit` ([sidepanel/panel/fill.js](../sidepanel/panel/fill.js#L40-L47)).
  - Usage, field-change, and automatic layout watching use `ensureRecorder` ([sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L36-L50)).
  - Both activate as soon as `carrierForUrl(url)` ([src/carriers.js](../src/carriers.js#L73-L82)) matches the **tab's top-level hostname** against `hosts` **and** `manifest.json` `host_permissions` grants access to that frame's origin. So `hosts` decides which *tabs* are rater tabs, and `host_permissions` decides which *frames* inside them are injected. A cross-origin rater frame needs only a `host_permissions` entry; adding its domain to `hosts` would also turn any top-level tab on that domain into a BHHC tab. Frames whose origin is missing from `host_permissions` are skipped (silently for the recorder, [usage.js](../sidepanel/panel/usage.js#L49)).
- **`pageAdapter` is optional.** Without `carrier.pageAdapter` ([types.js](../types.js#L331)), the kit treats the page as standard HTML in Chrome's `ISOLATED` world, and [field-key.js](../src/content/field-key.js#L37-L60) falls back to `name` → `id` → `dom-v1:` structural path. That is sufficient for recon and for any plain-DOM carrier whose `name`/`id` attributes are already stable.
- **`autoFillUrl` and `layoutUrl` control both safety and privacy:**
  - `onQuotePage()` ([sidepanel/panel/coordinator.js](../sidepanel/panel/coordinator.js#L39)) evaluates `!carrier.autoFillUrl || carrier.autoFillUrl.test(url)`. **Trap:** omitting `autoFillUrl` makes `onQuotePage()` return `true` on *every* BHHC URL (including login, agent dashboard, and search). If automatic fill is enabled or Fill is pressed, unknown choice fields are passed to `runAssist` ([sidepanel/panel/assistant.js](../sidepanel/panel/assistant.js#L295-L325)), while `rulebookFor('bhhc')` returns `[]` until `CARRIER_PARTS.bhhc` exists ([src/ai/tni-rules.js](../src/ai/tni-rules.js#L37-L41)).
  - `scheduleLayout()` ([sidepanel/panel/coordinator.js](../sidepanel/panel/coordinator.js#L621-L626)) checks `const quotePages = carrier.layoutUrl ?? carrier.autoFillUrl` and exits unless `quotePages?.test(url)` matches, preventing background `page_layout` uploads from portal/search pages whose text may contain other clients' names not covered by the loaded intake's redaction terms.
  - **Consequence for Phase 1:** setting `autoFillUrl: /$^/` (and leaving `layoutUrl` unset) on the recon stub forces **both** `onQuotePage()` and `scheduleLayout()` to `false` on every page in code, which blocks every fill, `runAssist` call, and `page_layout` upload. Manual `Alt+Shift+C` ([sidepanel/panel/fill.js](../sidepanel/panel/fill.js#L1323-L1332), download only) and Developer `Record` ([sidepanel/panel/dev-recording.js](../sidepanel/panel/dev-recording.js#L34-L36)) continue to work whenever a carrier and intake PDF are loaded. **It does not block usage events** (next bullet but two).
  - Practice pages (`PRACTICE`, localhost) set `autoFillUrl` to `null`, so `/test/fixtures/bhhc/` pages bypass the stub's guard. That is intended for the offline harness.
- **What each capture tool actually records today:**
  - **Developer Recording (`Record`, unpacked builds only, [developer-recording.md](developer-recording.md)):** records light-DOM `burst` mutations (with newly drawn questions), `request` timings, and kit waits into `layouts/recordings/recording-<id>.zip` (analysed with `npm run recording`). It stays bound to the tab it started on, cannot observe closed/open shadow-root mutation bursts, and **does not** save HTML snapshots, screenshots, or per-moment layouts.
  - **`Capture page layout` (`Alt+Shift+C` or Settings button):** captures redacted control metadata, labels, current values, and dropdown options as JSON into `Downloads` (grouped by the panel's **Scenario** box and diffed with `npm run captures`). Note: if the Chrome Web Store extension is installed in the same profile, Chrome usually keeps `Alt+Shift+C` bound to the store copy; use an isolated profile, `chrome://extensions/shortcuts`, or the Settings button.
  - **Manual `Ctrl+S` ("Web Page, Complete"):** required at each step/modal to save raw HTML into `layouts/bhhc/` for offline fixture/mock construction; saved HTML carries live session/CSRF tokens and client text that the fixture builder must scrub.
- **Recon usage events reach the server unless uploads are off.** `ensureRecorder` runs on every matched-carrier tab once an intake is loaded ([sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L36-L50)), and `onRecorderMessage` logs `page_view` and `field_change` events ([L58-L95](../sidepanel/panel/usage.js#L58-L95)) **without** checking `onQuotePage()` or `autoFillUrl`, so the recon stub still uploads them from BHHC portal and search pages. Text changes upload no value ([src/usage.js](../src/usage.js#L349-L357)); choice changes upload redacted from/to values. The collection server only drops `carrier === 'test'` ([server/index.mjs](../server/index.mjs#L305-L307)). Phase 1 does **not** gate this in code: gating `ensureRecorder` would break `Record` (it also carries `trace.js`), and gating the `log` closure on `layoutUrl ?? autoFillUrl` would drop the existing carriers' portal `page_view` events. The Phase 2 profile procedure is therefore mandatory. A hard guarantee would be an explicit `recon` flag on `CarrierConfig`, honoured where `log` skips practice pages ([usage.js](../sidepanel/panel/usage.js#L60)), in its own PR before BHHC.
- **Chrome Web Store permission warning.** Chrome disables an updated store extension on every agent's machine until they accept a new required permission's warning, so a new required host permission disables **all** carriers until accepted. No test stops a new required host from reaching a store package. BHHC uses a required entry like the other carriers (maintainer's decision), so the release that adds it is announced to agents.

---

## Phased execution plan

### Phase 0: Scope and pre-recon inputs

Before touching code or running a live quote:

1. **Walk the topology with DevTools and no extension loaded:** sign in at `portal.bhhomestate.com` and open Breeze, noting the top-level URL of every step and the origin of every frame (DevTools → Application → Frames). Known BHHC hosts that are **not** the commercial-auto rater: `agency.bhhc.com` (workers comp login), `myp.bhhc.com` and `policyholder.bhhc.com` (policyholders), `expresspay.bhhc.com` and `quickpay.bhhc.com` (payments). `bhhc.appulate.com` (Appulate vendor sign-in) exists, but its role is unconfirmed; it is a candidate frame origin.
2. **Confirm initial supported scope ([new-carrier.md](new-carrier.md#L7-L8)):** v1 is bounded to Breeze, 1–10 power units (see v1 scope). Within that: initial states, target business classes (BHHC's appetite covers both for-hire trucking and business auto), single vs multi-vehicle/trailer/driver support, and requested coverages (auto liability, UM/UIM, Med Pay, PIP, comp/coll, cargo, GL, trailer interchange, NTL).
3. **Collect TNI policy answers** (see Open Questions below): whether BHHC starts intake-only or has approved TNI standards, and how BHHC appears on intakes as a prior insurer (`CARRIER_NAMES`).

### Phase 1: Locked-down recon stub (task branch, unpacked build)

Create a task branch from `origin/main` in the main checkout and wire the smallest stub that passes tests and unlocks `Alt+Shift+C` + `Record` without risking fills:

1. **[manifest.json](../manifest.json):** add the exact portal origin `"https://portal.bhhomestate.com/*"` to `host_permissions`. No `*.bhhomestate.com` and no `bhhc.com`: a wildcard would make the workers comp login and the payment sites rater tabs and inject the recorder into all their frames. If the Phase 0 walk shows a cross-origin rater frame, add **that exact origin** (e.g. `https://bhhc.appulate.com/*`, never `*.appulate.com`) to `host_permissions` only. Add it to `hosts` only if the rater opens as a top-level tab there. A frame missed during recon is cheap: it shows as 0 fields and no trace events, and is fixed by one manifest line and a reload. Leave `description` unchanged during recon (currently 122 of 132 allowed characters, [consistency.test.mjs](../test/consistency.test.mjs#L170)).
2. **[src/carriers.js](../src/carriers.js):** add an **inline** entry in `CARRIERS` ([L52-L63](../src/carriers.js#L52-L63)), not a separate `src/carriers/bhhc.js` file yet. An inline entry adds no import, so `RULE_FILES` and the rulebook part stay untouched until the first rule:
   ```js
   {
     id: 'bhhc',
     name: 'BHHC',
     hosts: [/^portal\.bhhomestate\.com$/i], // confirmed in the Phase 0 walk
     autoFillUrl: /$^/, // blocks auto-fill & background page_layout during recon
     useGenericRules: false, // prevents generic label rules in rules.js from filling BHHC
     rules: [],
   },
   ```
3. **Test behavior on this stub (`npm test && npm run typecheck && npm run package`):**
   - `test/consistency.test.mjs`: **passes** once `hosts` matches `manifest.json` `host_permissions` ([L159-L166](../test/consistency.test.mjs#L159-L166); an exact host is accepted).
   - `test/rulebook.test.mjs`: **passes** because `RULE_CARRIERS` filters on `c.rules.length` ([L13](../test/rulebook.test.mjs#L13)). **Do not** add `CARRIER_PARTS.bhhc` yet: [L22-L24](../test/rulebook.test.mjs#L22-L24) asserts `"every carrier with rules has a rulebook part, and nothing else does"`.
   - `test/resolution.test.mjs`: **passes**; it builds plans for every carrier, and the stub's plan is simply empty.
   - `test/concepts.test.mjs`: **passes** (`RULE_SETS` filters on `rules.length`).
   - `test/usage.test.mjs`: **passes** because the stub is inline in `src/carriers.js` rather than an unlisted module import (`RULE_FILES`).
   - `test/provenance.test.mjs`: **passes** (`RULE_CARRIERS` is explicit).
   - Output: unpacked extension in `dist/tni-rater-autofill/`.
4. The BHHC host is a required `host_permissions` entry (maintainer's decision). Merging it means the next store release shows agents Chrome's new-site prompt, so the branch merges only when that release is planned and announced. Editing `src/carriers.js` also changes the rules fingerprint for every carrier on that build, which is harmless on a branch.
5. The recon-stub pattern goes into [new-carrier.md](new-carrier.md) ("Capture the behavior") only when a stub actually lands on `main`.

### Phase 2: Live recon across 2–3 scenarios

Using an **isolated Chrome profile** (never the profile holding live agent settings, API keys, or queued logs, per `verify-tni-rater`):

1. **Configure the unpacked panel before opening BHHC (all steps mandatory):**
   - Turn **AI suggestions** off.
   - Turn **automatic fills** off ("fill pages when they open" and automatic follow-ups) and do **not** press Fill.
   - Turn **Settings → Advanced → Developer mode** on.
   - **Clear Settings → Server** in this throwaway profile and never set it again there. A blank server means no upload ([sidepanel/usage-log.js](../sidepanel/usage-log.js#L135-L139)), but events stay queued and upload as soon as a server is set ([L190-L191](../sidepanel/usage-log.js#L190-L191)). This is the only control on the `page_view` / `field_change` gap described above.
   - **Mark the intake as a test run** ([sidepanel/panel/intake.js](../sidepanel/panel/intake.js#L71)) so reviews leave the session out ([scripts/lib/signals.mjs](../scripts/lib/signals.mjs#L154-L157)).
   - Load a sample or real TNI intake PDF **only after signing in** to the portal. It is required both to enable `Capture page layout` / `Record` and to populate client redaction terms, and `ensureRecorder` needs it, so loading it later keeps the recorder off the login page.
2. **Walk through 2–3 distinct quote scenarios up to the rate/proposal page** (e.g. for-hire trucker with USDOT/filings + trailer + cargo vs local business auto without filings; multi-vehicle/driver), **stopping strictly before** MVR/CLUE orders, payment, signatures, or bind/submit:
   - Start **Record** on the quote tab itself (if BHHC launches the quote in a new tab from a portal gateway, start `Record` after the quote tab opens).
   - Set a clear **Scenario** name in the panel and capture with **Alt+Shift+C** before and after toggling each branch question (USDOT/filings, radius, cargo, GL, trailer interchange, additional insured/waiver, etc.).
   - Save raw HTML (`Ctrl+S`, "Web Page, Complete") at each step and modal.
   - Move downloaded layout JSONs and saved HTML into `layouts/bhhc/` and recordings into `layouts/recordings/`.
   - Run `npm run captures` and `npm run recording` locally to inspect branch diffs, dropdown option lists, network waits, and mutation bursts.
3. **Lock in six technical findings before writing rules:**

| # | Question to settle | Code surface it decides |
| --- | --- | --- |
| 1 | **URL & iframe topology**: exact gateway vs quote URLs and any cross-origin frames | Top-level rater hosts → `hosts` + `host_permissions`; frame-only origins → `host_permissions` only; quote-page paths → `autoFillUrl`, `layoutUrl` |
| 2 | **Stable field keys across redraws**: data-model attribute, `name`, or ID stem stripped of render counters/UUIDs (like GEICO's `Id_<Name>_<n>`) | `shared.keys` in `src/content/carriers/bhhc.js` (or default [field-key.js](../src/content/field-key.js) if plain stable `name`/`id`). **Must be final before the first live fill** so saved agent corrections never orphan |
| 3 | **World & widget model**: plain HTML (`ISOLATED`), open Shadow DOM / custom elements (`components` prefix), React discrete-event buttons (`pressInPage: true`), or page-JS widgets like ExtJS (`world: 'MAIN'`) | `world`, `pageAdapter` (`components`, `selectors.busy`), action `pressInPage` ([browser-filling.md](browser-filling.md); note `isBeat` in [src/kit/adapter.js](../src/kit/adapter.js#L179) is already generic) |
| 4 | **Page vs single-URL step routing**: distinct URLs/query params (`pageOf` in [sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L23-L30)) vs single-URL SPA (`layoutSteps` via headings like AmWINS or progress bar + `document.title` like GEICO) | `layoutSteps`, `quoteSteps`, rule/action `steps`, `newQuestionsOnlySteps`, `keepTakenBack` |
| 5 | **Repeated vehicles, trailers & drivers**: all rows on one screen (`rowSections` + `witness: { selector, path }` by VIN/identity like AmWINS) vs one unit form at a time (`vehicleSteps` / `driverSteps` + `whenShown` / `unlessShown` with `unit` like GEICO) | Unit rules, `unitForm` / `unitHeld`, and lookup/add-unit helper `actions` with `steps`, `within`, and `verify` (`'revealed'`, `{ appears }`, or `{ page }`) |
| 6 | **Hard stop screens & premium format**: exact pages/steps/buttons for MVR/CLUE, payment, carrier referral/knockout (`stopped: true`), Breeze's own ineligibility screen for 11+ units or ineligible states (if it shows one, it is the carrier's `stopped` screen; the extension invents none), Breeze's **bind approved quotes** button, and **loss-run upload** (agent-only); plus where and how BHHC prints total/term/installment premiums | `stopPages`, `stopSteps`, `stopButtons`, `agentPages`, `warnPages`, and [src/premium.js](../src/premium.js) (`PREMIUM_PAGES`, `readPremium`) |

### Phase 3: Scrubbed offline harness, optional page adapter, and carrier rules

1. **Offline fixture or replay (`test/fixtures/bhhc/` + `scripts/bhhc-mock.mjs`, or `test/replay/`):**
   - Choose the harness style that matches finding #4:
     - **Client-rendered / SPA or self-contained step templates (GEICO/AmWINS style):** write `scripts/bhhc-fixture.mjs` (modeled on [scripts/geico-fixture.mjs](../scripts/geico-fixture.mjs)) to build `test/fixtures/bhhc/` from `layouts/bhhc/`, stripping scripts, session tokens, CSRF nonces, and client values, and aborting without writing if `findPii` ([scripts/lib/privacy.mjs](../scripts/lib/privacy.mjs)) reports any hit. Pair with Playwright harness `scripts/bhhc-mock.mjs` (`"mock:bhhc": "node scripts/bhhc-mock.mjs"` in `package.json`).
     - **Server-backed postback pages (Progressive style):** build scrubbed layout replays and expected behavior checks.
   - Register `/test/fixtures/bhhc/` in `PRACTICE` ([src/carriers.js](../src/carriers.js#L67-L71)) and add `bhhc` to `CARRIERS` in [preview/preview.js](../preview/preview.js#L13-L17) so `npm run preview` loads BHHC offline.
2. **Page adapter (`src/content/carriers/bhhc.js` — create only if needed):**
   - Follow [new-carrier.md](new-carrier.md#L17): start from the smallest adapter that works, and create **none** if plain DOM + default `field-key.js` keys suffice.
   - If BHHC requires custom `keys`, `selectors.busy`, `components`, or SPA step reading, add a classic IIFE script at `src/content/carriers/bhhc.js` (`globalThis.__raterAdapter = { carrier: 'bhhc', shared }`, typed via `/** @import { PageAdapterShared } from '../../../types.js' */`) and reference it in `bhhc.pageAdapter`. Keep `src/kit/` completely carrier-agnostic (`src/` is copied automatically by `PACKAGED` in [scripts/lib/package.mjs](../scripts/lib/package.mjs#L35)).
3. **Carrier module (`src/carriers/bhhc.js`):**
   - Start with `// @ts-check` and `/** @type {CarrierConfig} */` (typing rule-builder functions `@returns {CarrierRule[]}` and `.map(...)` callbacks `@returns {CarrierRule}`; declare any new cross-boundary option in [types.js](../types.js)).
   - Replace the inline stub in `src/carriers.js` with `import { bhhc } from './carriers/bhhc.js'`.
   - Keep `useGenericRules: false`; scope `autoFillUrl` and `layoutUrl` strictly to BHHC quote pages; configure `stopPages`, `stopSteps`, `stopButtons`, and observed `quoteSteps`.
   - Reuse shared helpers in `src/answers/`, `src/standards.js`, and `src/util.js`.
   - Map confirmed `intake` and exact `derived` rules, plus `fact` / `attestation` hand-offs with `note` (`manualOnly`). Note: [test/provenance.test.mjs](../test/provenance.test.mjs#L95) asserts `facts > 0` for every carrier in `RULE_CARRIERS`, so at least one `fact` or `attestation` rule must apply on `RECORDS()`. That rule must be a real hand-off seen on Breeze during recon, never one written only to pass the test.
   - `supportedClasses` stays unset until TNI names BHHC classes.
   - Add `CARRIER_NAMES.bhhc` ([src/util.js](../src/util.js#L163-L196)) with the first rules, not with the stub: an entry immediately makes `quotedCarriersOf` raise the `prior.carrier-is-quoted` check for every intake naming BHHC ([util.js](../src/util.js#L223-L225)), which TNI wants (2026-11-13). Add a test that an intake naming Berkshire Hathaway Homestate gets the check, and that GUARD, BH Specialty, GEICO, and the member companies do not. Proposed shape (`word` is mandatory, because `sameCarrier` calls `editDistance` on it unguarded):
     ```js
     bhhc: { name: 'BHHC', word: 'bhhc', words: [['berkshire', 'hathaway', 'homestate'], ['berkshire', 'hathaway', 'home', 'state'], ['bh', 'homestate']] },
     ```
     Never use `homestate` as `word`: at nine letters it allows two typos, and a bare "Homestate" can mean other insurers. Never match bare `berkshire`, `hathaway`, or `cypress`. TNI decided (2026-11-13) that only Berkshire Hathaway Homestate names count: member companies (Cypress, Oak River, Redwood Fire & Casualty, BHHC Special Risks) are **not** BHHC on an intake and are never added. Tests: `test/normalize.test.mjs`, `test/intake-regressions.test.mjs`, `test/sidepanel-safety.test.mjs`.
   - Every rule names its `concept` from [src/concepts.js](../src/concepts.js) (adding new catalog IDs only for genuinely new concepts, then running `npm run concepts` to regenerate [docs/concepts.md](concepts.md)).
4. **Luna rulebook part (`src/ai/rulebook/bhhc.js`):**
   - Add `src/ai/rulebook/bhhc.js` in the **same commit** as the first rule in `src/carriers/bhhc.js` and register it in `CARRIER_PARTS` in [src/ai/tni-rules.js](../src/ai/tni-rules.js#L26).
   - Must export a non-empty `title` and at least one section with `heading` and `rules` whose IDs match `^bhhc\.[a-z0-9]+(?:-[a-z0-9]+)*$`, valid `kind` (`'intake'`, `'agent'`, `'workflow'`, or `'standard'`), and single-line `text` > 10 chars ([test/rulebook.test.mjs](../test/rulebook.test.mjs#L26-L40)). Do not write `(standard)` or `(TNI standard)` in non-`standard` entries ([L39](../test/rulebook.test.mjs#L39)).

### Phase 4: Complete repository contract, pilot verification, and rollout

Every place in the repository that enumerates carriers or enforces cross-cutting contracts must be updated in lockstep:

| Area | File | What to add / update | Enforced by / notes |
| --- | --- | --- | --- |
| Manifest hosts | [manifest.json](../manifest.json) | BHHC `host_permissions` (required, like the other carriers); update `description` when releasing to store (≤ 132 chars; it reads "Progressive, AmWINS and GEICO", so it needs rewording, and adding BHHC brings 122 → about 128 chars) | [test/consistency.test.mjs](../test/consistency.test.mjs#L159-L170) |
| Carrier registry | [src/carriers.js](../src/carriers.js#L52-L71) | `bhhc` in `CARRIERS`; `/test/fixtures/bhhc/` in `PRACTICE` | [test/consistency.test.mjs](../test/consistency.test.mjs#L159-L166) |
| Committed fixtures privacy | `test/fixtures/bhhc/` | Scrubbed fixtures only; a fixture-privacy test like [test/geico-fixture.test.mjs](../test/geico-fixture.test.mjs) | [test/consistency.test.mjs](../test/consistency.test.mjs#L182-L206) (`findPii` over fixtures, no tracked `layouts/`) |
| Rules fingerprint | [src/usage.js](../src/usage.js#L392) | `'src/carriers/bhhc.js'` (and any new helper modules it imports) in `RULE_FILES` | [test/usage.test.mjs](../test/usage.test.mjs#L294-L303) |
| Concept catalog | [src/concepts.js](../src/concepts.js), [docs/concepts.md](concepts.md) | `concept` on every rule; new IDs if needed; run `npm run concepts` | [test/concepts.test.mjs](../test/concepts.test.mjs) |
| AI rulebook | `src/ai/rulebook/bhhc.js`, [src/ai/tni-rules.js](../src/ai/tni-rules.js#L26) | BHHC rulebook part registered in `CARRIER_PARTS` (add with first rule, never on empty stub) | [test/rulebook.test.mjs](../test/rulebook.test.mjs#L22-L40) |
| Provenance & intake coverage | [test/provenance.test.mjs](../test/provenance.test.mjs#L16-L17), [L113-L170](../test/provenance.test.mjs#L113-L170) | Add `bhhc` to `RULE_CARRIERS`, `SOURCE.bhhc`, and `NOT_MAPPED.bhhc` (with reason per unmapped intake leaf). Add to `STANDARD_CARRIERS` **only** once TNI standards exist | `npm test` (`facts > 0`; `standards === 0` until in `STANDARD_CARRIERS`) |
| Prior-carrier match | [src/util.js](../src/util.js#L163-L196) | `CARRIER_NAMES.bhhc` with the first rules, in the shape given in Phase 3 (must **not** match bare `"berkshire"`, which collides with Berkshire Hathaway GUARD, BH Specialty, and GEICO entities) | [test/normalize.test.mjs](../test/normalize.test.mjs), [test/intake-regressions.test.mjs](../test/intake-regressions.test.mjs), [test/sidepanel-safety.test.mjs](../test/sidepanel-safety.test.mjs) |
| Premium logging | [src/premium.js](../src/premium.js#L29) | `PREMIUM_PAGES.bhhc` and a BHHC pattern in `readPremium` if `ANY` misses term/installments | `test/premium.test.mjs` |
| Helper & hook tests | [test/progressive.test.mjs](../test/progressive.test.mjs#L322), [test/plan-hooks.test.mjs](../test/plan-hooks.test.mjs#L17) | Add `bhhc` to hardcoded carrier arrays checking action regex compilation and plan-hook isolation | `npm test` |
| Standards & agent defaults *(only after TNI sets BHHC standards)* | [src/agent-defaults/registry.js](../src/agent-defaults/registry.js), [test/standards.test.mjs](../test/standards.test.mjs#L11), [test/std-metadata.test.mjs](../test/std-metadata.test.mjs#L14), [test/agent-defaults.test.mjs](../test/agent-defaults.test.mjs#L26) | `std` metadata on BHHC shared-standard rules, `choices.bhhc` (and `choices.all` intersection + `dependents`), plus test carrier lists | `npm test` |
| Local preview & scripts | [preview/preview.js](../preview/preview.js#L13-L17), [package.json](../package.json) | `bhhc` entry in `preview.js` `CARRIERS`; `"mock:bhhc"` script | `npm run preview`, `npm run mock:bhhc` |
| CI workflows | [.github/workflows/checks.yml](../.github/workflows/checks.yml#L80-L90), [.github/workflows/windows-smoke.yml](../.github/workflows/windows-smoke.yml#L60-L64) | Add `BHHC mock` (`npm run mock:bhhc`) to both Ubuntu PR matrix and Windows smoke workflow | GitHub Checks |
| Panel logo & rater list | `display` on the carrier (on newer `main`, `RATERS` in `src/carriers.js` lists carriers with a `display`), `sidepanel/assets/raters/` (+ `SOURCES.md`) | BHHC `display` and logo asset with its source, added at release, not on the recon stub, so the panel does not offer BHHC to agents before it is ready | Not enforced |
| Review & coverage scripts | [scripts/lib/signals.mjs](../scripts/lib/signals.mjs#L45-L46), [scripts/lib/answer-key.mjs](../scripts/lib/answer-key.mjs), [scripts/lib/daily.mjs](../scripts/lib/daily.mjs#L44-L46), [scripts/coverage.mjs](../scripts/coverage.mjs#L19), [scripts/intake-mocks.mjs](../scripts/intake-mocks.mjs) | Breeze "quote finished" step regex (weekly signals), which pages count for the answer key, BHHC fixture in the `MOCK` / `MOCKS` drift maps, and (optional) intake-mock carrier ids | Not enforced; without them weekly reviews cannot tell a BHHC quote reached its last step, and drift alerts skip BHHC |
| Server & store docs | [server/dashboard.mjs](../server/dashboard.mjs#L203), [server/privacy.html](../server/privacy.html#L8), [docs/chrome-web-store.md](chrome-web-store.md#L48-L56) (host justification at L49, listing bullet near L116), [README.md](../README.md) (carrier lists on several lines and the mock sections), [docs/testing.md](testing.md), [docs/new-carrier.md](new-carrier.md), [docs/intake-and-rules.md](intake-and-rules.md) | Display name `bhhc: 'BHHC'`, privacy policy carrier list, host justification & listing bullet, commands/docs tables | **Not enforced by any test**: keep in sync by hand. ([L208-L213](../test/consistency.test.mjs#L208-L213) only checks that `npm run` commands named in docs exist.) |

---

## Risk analysis

| # | Risk | Impact | Mitigation in this spec |
| --- | --- | --- | --- |
| R1 | Recon stub triggers automatic fills, Luna requests, or background `page_layout` uploads on BHHC login/dashboard pages | High: unwanted clicks or unredacted portal text logged | Stub sets `autoFillUrl: /$^/` (and omits `layoutUrl`), turning off `onQuotePage()` and `scheduleLayout()` in code; AI and auto-fill also turned off in isolated recon profile |
| R1b | Recorder still uploads `page_view` / `field_change` events from portal and search pages under the stub | Low–medium: redacted labels and choice values from non-quote pages on the dashboard | Mandatory Phase 2 profile steps (server cleared and never restored, test-run intake, intake loaded after sign-in); optional `recon` flag PR for a code guarantee |
| R2 | Field keys change after agents start using BHHC, orphaning saved manual edits and answer-retention protections | High: agent corrections overwritten on redraw | Inspect redraw behavior in Phase 2 and lock `shared.keys` before the first live fill; never rename existing keys afterward |
| R3 | Cross-origin iframe rater is silently skipped by `executeScript({ allFrames: true })` | High: extension sees outer shell only, 0 fields | Walk frame origins in DevTools in Phase 0 and add any vendor rater origin, exactly, to `manifest.json` `host_permissions` only (not `hosts`, which would make top-level tabs on that domain BHHC tabs) |
| R4 | `"Berkshire"` in `CARRIER_NAMES` matches Berkshire Hathaway GUARD, BH Specialty, or GEICO affiliates as "same carrier" | Medium: false same-carrier warning or wrong workflow branch | `word: 'bhhc'` plus the multi-word sets in Phase 3 (or TNI's exact confirmed list); never `"berkshire"`, `"homestate"`, or `"cypress"` alone; added with the first rules, not the stub |
| R5 | New required host permission in a Chrome Web Store update disables installed copies, and every carrier, for all agents until accepted | Medium: pilot interruption on release day | Required entry like the other carriers (maintainer's decision); merge only when the store release is planned, and announce the one-click acceptance to agents |
| R6 | Raw `Ctrl+S` pages leak session tokens, agency codes, or client PII into git | High: privacy/credential leak | Save raw captures only in gitignored `layouts/`; fixture builder aborts without writing on any `findPii` or token hit; `consistency.test.mjs` scans all committed fixtures and checks `git ls-files layouts` |
| R7 | Single recon quote misses conditional branches or infers wrong applicability | Medium: wrong fill on adjacent business class/state | Define scope upfront, capture 2–3 scenarios with before/after `Alt+Shift+C` toggles, leave unverified branches to the agent, and run supervised live pilot before enabling auto-fill |

---

## Verification gate

Before considering initial BHHC support ready for supervised live pilot:

1. `npm run lint`, `npm run typecheck`, `npm test`, and `npm run package` all pass cleanly.
2. `npm run mock:bhhc` exercises the packaged/built kit end-to-end across supported steps, verifying:
   - expected `intake` and `derived` fills and answer retention across redraws;
   - repeated vehicle/trailer/driver identity (`witness` or `unitForm` / `unitHeld`);
   - manual corrections preserved on re-fill;
   - `fact` and `attestation` fields left unfilled with agent notes (`manualOnly`);
   - nearby negative/exception cases where a rule must **not** apply;
   - hard stops (`stopPages` / `stopSteps` / `stopButtons`) halting before MVR/CLUE, payment, referral, or bind/submit.
3. Supervised live BHHC quote verified by the maintainer on the real portal (`verify-tni-rater` / `lutfy-mode`: mock success does not prove live backend acceptance), followed by `npm run recording` and `npm run coverage` review.

---

## Open questions

### Decided by the maintainer (2026-11-13)
- **Store host permission:** BHHC goes into required `host_permissions`, like GEICO, AmWINS, and Progressive. No permission UI or code is needed. The store release that adds it makes Chrome pause the extension on each agent's computer until they accept the new site once, so that release is announced to agents with the one-click step.

### For the maintainer
1. **Portal topology (Phase 0 walk):** Public sources give `portal.bhhomestate.com` as the commercial-auto login. Does Breeze stay on that host, open another top-level host, or load in a cross-origin frame (possibly `bhhc.appulate.com`)?
2. **Recon guarantee:** Is the mandatory profile procedure enough for the usage-event gap (R1b), or should a `recon` flag on `CarrierConfig` land as its own PR first?

### For TNI (needed before `standard` rules or `CARRIER_NAMES` land; does not block Phases 1–2)
3. **Initial scope within Breeze:** Which states, business classes (for-hire trucking, business auto, or both), and coverages should BHHC v1 target?
4. **TNI standards on BHHC:** Should BHHC launch **intake-only** first (`standards === 0`, every non-intake question left to the agent/Luna, as GEICO originally did), or do TNI's shared coverage/workflow standards apply right away?
Decided by TNI (2026-11-13):
- Eligibility warning: yes.
- Power units: each vehicle counts as one.
- Domicile: the garaging address's state.
- Member companies do not count as BHHC; only Berkshire Hathaway Homestate names do.
- Same-carrier warning: yes. When the intake names Berkshire Hathaway Homestate as the current commercial auto insurer, the existing `prior.carrier-is-quoted` red check ("may be declined or routed") shows on BHHC's site. Filling still goes on. Adding `CARRIER_NAMES.bhhc` with the first rules is what turns it on.
