# Spec: adding BHHC (Berkshire Hathaway Homestate Companies)

Status: **planned (pre-recon)**, re-pinned 2026-11-19 against `main` (`4ff35564`). Nothing BHHC-related exists in the repository or `layouts/` yet: no branch, stub, captures, fixtures, or rules. Public sources put BHHC's commercial-auto agent login and rater at `portal.bhhomestate.com` (see Phase 0); the live walk in Phase 0 confirms it and any frame origins before Phase 1. Open questions for the maintainer and TNI are listed at the end.

### v1 scope

BHHC's small-risk rater, **Breeze**, gives indications for 1–10 power units across many classes, is not offered in every state (AL and LA domiciles are ineligible), and routes fleets of 11+ units to BHHC's fleet team outside the rater ([BHHC rater info](https://bhhc.com/commercial-auto/auto-rater-info)). v1 targets **Breeze only, 1–10 power units**; the fleet path is out of scope. The extension never blocks on eligibility. TNI has decided (2026-11-13) that the agent is **warned** before quoting when an intake falls outside Breeze:
- **Power units:** each intake vehicle counts as one power unit; trailers are separate units in the intake and are not counted. More than 10 vehicles → warning.
- **Domicile:** the state of the intake's **garaging address** (TNI, 2026-11-13); an ineligible one (AL, LA, or a state Breeze does not offer) → warning.
- The warning is a `check`-level intake warning shown only on BHHC's site, modelled on `prior.carrier-is-quoted` ([src/normalize.js](../src/normalize.js#L1780-L1801)). It warns and never blocks. It lands with the first BHHC rules, and its state list comes from what recon shows Breeze accepts. If Breeze shows its own ineligibility screen, that screen is also the carrier's `stopped` screen (finding #6).

## Goal

Support commercial-auto quoting on **BHHC** (`id: 'bhhc'`, Berkshire Hathaway Homestate Companies) from a TNI Commercial Insurance Quote Application PDF, following the repository's **locked-down recon stub → live multi-scenario capture & recording → privacy-scrubbed offline mock/replay → provenance-verified rules** pipeline ([new-carrier.md](new-carrier.md)).

### Non-negotiable invariants

1. **Zero invented answers.** Distinguish missing information (`null` / unfilled), explicit `No`, and not applicable ([intake-and-rules.md](intake-and-rules.md)). Every rule that computes an answer declares a valid `source` from `SOURCES` in [plan.js](../src/plan.js): `intake`, `derived`, `standard`, `fact`, or `attestation`.
2. **No `standard` rules until TNI confirms them.** Until TNI explicitly records BHHC standards, BHHC ships with **zero** `source: 'standard'` rules and **no** `supportedClasses` (matching GEICO prior to 2026-10-21): every question the intake does not answer is left to the agent or handed to Luna as a bounded choice.
3. **Uncollected client facts and attestations stay manual.** Rules for client facts or legal attestations the intake does not collect carry `source: 'fact'` or `'attestation'` and a `note`. That source is what makes the step `manualOnly: true` (never filled and never sent to Luna); a `clientFact` rule is also manual-only when the intake has no answer ([plan.js](../src/plan.js#L20-L23), [L330](../src/plan.js#L330)). Omitting `value` alone does not.
4. **Agent authority, retention, and hard stops.** Agent manual edits persist by field key ([field-key.js](../src/content/field-key.js)) and are never overwritten. Fills stop strictly before ordering MVR/CLUE reports, entering payment/bank details, signing, binding, purchasing, or submitting (`stopPages`, `stopSteps`, `stopButtons`, `agentPages`, `warnPages`).
5. **Raw captures stay local; committed fixtures are scrubbed.** Raw HTML, PDFs, `Alt+Shift+C` captures, and developer recordings stay in gitignored `layouts/bhhc/` and `layouts/recordings/` (enforced by [consistency.test.mjs](../test/consistency.test.mjs)). Any committed fixture under `test/fixtures/bhhc/` (or `test/replay/`) is built by a deterministic scrubber script that aborts without writing on any `findPii` or session-token hit ([privacy.mjs](../scripts/lib/privacy.mjs)).

---

## How the current architecture behaves on a new carrier

Understanding these mechanics avoids accidental live fills, unredacted telemetry, or broken tests during reconnaissance:

- **Dynamic script injection (no static `content_scripts`).** [manifest.json](../manifest.json) declares no `content_scripts`. The side panel injects scripts on demand with `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, ... })`:
  - Fills and manual layout captures use `injectKit` ([sidepanel/panel/fill.js](../sidepanel/panel/fill.js#L46-L54)).
  - Usage, field-change, and automatic layout watching use `ensureRecorder` ([sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L36-L50)).
  - Both activate as soon as `carrierForUrl(url)` ([src/carriers.js](../src/carriers.js#L96-L106)) matches the **tab's top-level hostname** against `hosts` (and `product`, when an intake is loaded) **and** `manifest.json` `host_permissions` grants access to that frame's origin. So `hosts` decides which *tabs* are rater tabs, and `host_permissions` decides which *frames* inside them are injected. A cross-origin rater frame needs only a `host_permissions` entry; adding its domain to `hosts` would also turn any top-level tab on that domain into a BHHC tab. Frames whose origin is missing from `host_permissions` are skipped (silently for the recorder, [usage.js](../sidepanel/panel/usage.js#L48)).
- **`pageAdapter` is optional.** Without `carrier.pageAdapter` ([types.js](../types.js#L373)), the kit treats the page as standard HTML in Chrome's `ISOLATED` world, and [field-key.js](../src/content/field-key.js#L37-L60) falls back to `name` → `id` → `dom-v1:` structural path. That is sufficient for recon and for any plain-DOM carrier whose `name`/`id` attributes are already stable.
- **`autoFillUrl` and `layoutUrl` control both safety and privacy:**
  - `onQuotePage()` ([sidepanel/panel/coordinator.js](../sidepanel/panel/coordinator.js#L44)) evaluates `!carrier.autoFillUrl || carrier.autoFillUrl.test(url)`. **Trap:** omitting `autoFillUrl` makes `onQuotePage()` return `true` on *every* BHHC URL (including login, agent dashboard, and search). If automatic fill is enabled or Fill is pressed, unknown choice fields are passed to `runAssist` ([sidepanel/panel/assistant.js](../sidepanel/panel/assistant.js#L306-L335)), while `rulebookFor('bhhc')` returns `[]` until `CARRIER_PARTS.bhhc` exists ([src/ai/tni-rules.js](../src/ai/tni-rules.js#L38-L40)).
  - `scheduleLayout()` ([sidepanel/panel/coordinator.js](../sidepanel/panel/coordinator.js#L727-L739)) checks `const quotePages = carrier.layoutUrl ?? carrier.autoFillUrl` and exits unless `quotePages?.test(url)` matches, preventing background `page_layout` uploads from portal/search pages whose text may contain other clients' names not covered by the loaded intake's redaction terms.
  - **Consequence for Phase 1:** setting `autoFillUrl: /$^/` (and leaving `layoutUrl` unset) on the recon stub forces **both** `onQuotePage()` and `scheduleLayout()` to `false` on every page in code, which blocks every fill, `runAssist` call, and `page_layout` upload. Manual `Alt+Shift+C` ([sidepanel/panel/fill.js](../sidepanel/panel/fill.js#L1466-L1472), [L1480-L1542](../sidepanel/panel/fill.js#L1480-L1542), download only) and Developer `Record` ([sidepanel/panel/dev-recording.js](../sidepanel/panel/dev-recording.js#L141-L173)) continue to work whenever a carrier and intake PDF are loaded. **It does not block usage events** (next bullet but two).
  - Practice pages (`PRACTICE`, localhost) set `autoFillUrl` to `null`, so `/test/fixtures/bhhc/` pages bypass the stub's guard. That is intended for the offline harness.
- **What each capture tool actually records today:**
  - **Developer Recording (`Record`, unpacked builds only, [developer-recording.md](developer-recording.md)):** records light-DOM and open shadow-root `burst` mutations (with newly drawn questions), `request` timings, and kit waits into `layouts/recordings/recording-<id>.zip` (analysed with `npm run recording`). It stays bound to the tab it started on, cannot observe closed shadow-root mutation bursts, and **does not** save HTML snapshots, screenshots, or per-moment layouts.
  - **`Capture page layout` (`Alt+Shift+C` or Settings button):** captures redacted control metadata, labels, current values, and dropdown options as JSON into `Downloads` (grouped by the panel's **Scenario** box and diffed with `npm run captures`). Note: if the Chrome Web Store extension is installed in the same profile, Chrome usually keeps `Alt+Shift+C` bound to the store copy; use an isolated profile, `chrome://extensions/shortcuts`, or the Settings button.
  - **Manual `Ctrl+S` ("Web Page, Complete"):** required at each step/modal to save raw HTML into `layouts/bhhc/` for offline fixture/mock construction; saved HTML carries live session/CSRF tokens and client text that the fixture builder must scrub.
- **Recon usage events (`recon: true` flag).** Without a recon gate, `ensureRecorder` runs on every matched-carrier tab once an intake is loaded ([sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L36-L50)), and `onRecorderMessage` logs `page_view` and `field_change` events ([L60-L135](../sidepanel/panel/usage.js#L60-L135)) without checking `onQuotePage()` or `autoFillUrl` (text changes upload no value, [src/usage.js](../src/usage.js#L391-L400); choice changes upload redacted from/to values), while the collection server only drops `carrier === 'test'` ([server/index.mjs](../server/index.mjs#L507)). The profile procedure alone is not enough: a blank Server only queues events locally, and neither the test-run list (which has no `agent:` lines) nor the dashboard (which reads only `RATER_TEST_INTAKES` fingerprints) leaves an unmarked recon session out — a single carrier-stamped event makes a session a BHHC quote. **Plan (decided 2026-11-19):** add a `recon` flag on `CarrierConfig` (on the stub's own branch, `claude/bhhc-recon-stub`, in a separate PR). On a recon carrier, the panel logs no carrier-stamped usage events (`page_view`, `field_change`, `agent_click`, recorder and crash errors), does not count it as a quote page (no automatic fill, no AI), refuses a manual fill with a note, and hides the "Recording usage" footer, while `Record` and `Alt+Shift+C` capture keep working. The BHHC stub sets `recon: true`; it comes off with the first rules (enforced by a test).
- **Chrome Web Store permission warning.** Chrome disables an updated store extension on every agent's machine until they accept a new required permission's warning, so a new required host permission disables **all** carriers until accepted. No test stops a new required host from reaching a store package. BHHC uses a required entry like the other carriers (maintainer's decision), so the release that adds it is announced to agents.

---

## Phased execution plan

### Phase 0: Scope and pre-recon inputs

Before touching code or running a live quote:

1. **Walk the topology with DevTools and no extension loaded:** sign in at `portal.bhhomestate.com` and open Breeze, noting the top-level URL of every step and the origin of every frame (DevTools → Application → Frames). Known BHHC hosts that are **not** the commercial-auto rater: `agency.bhhc.com` (workers comp login), `myp.bhhc.com` and `policyholder.bhhc.com` (policyholders), `expresspay.bhhc.com` and `quickpay.bhhc.com` (payments). `bhhc.appulate.com` (Appulate vendor sign-in) exists, but its role is unconfirmed; it is a candidate frame origin.
2. **Confirm initial supported scope ([new-carrier.md](new-carrier.md#L7-L9)):** v1 is bounded to Breeze, 1–10 power units (see v1 scope). Within that: initial states, target business classes (BHHC's appetite covers both for-hire trucking and business auto), single vs multi-vehicle/trailer/driver support, and requested coverages (auto liability, UM/UIM, Med Pay, PIP, comp/coll, cargo, GL, trailer interchange, NTL).
3. **Collect TNI policy answers** (see Open Questions below): whether BHHC starts intake-only or has approved TNI standards, and how BHHC appears on intakes as a prior insurer (`CARRIER_NAMES`).

### Phase 1: Locked-down recon stub (task branch, unpacked build)

Create a task branch from `origin/main` (e.g. `claude/bhhc-recon-stub`) and wire the smallest stub that passes tests and unlocks `Alt+Shift+C` + `Record` without risking fills or carrier-stamped usage events:

1. **[manifest.json](../manifest.json):** add the exact portal origin `"https://portal.bhhomestate.com/*"` to `host_permissions`. No `*.bhhomestate.com` and no `bhhc.com`: a wildcard would make the workers comp login and the payment sites rater tabs and inject the recorder into all their frames. If the Phase 0 walk shows a cross-origin rater frame, add **that exact origin** (e.g. `https://bhhc.appulate.com/*`, never `*.appulate.com`) to `host_permissions` only. Add it to `hosts` only if the rater opens as a top-level tab there. A frame missed during recon is cheap: it shows as 0 fields and no trace events, and is fixed by one manifest line and a reload. Leave `description` unchanged during recon (currently 122 of 132 allowed characters, [consistency.test.mjs](../test/consistency.test.mjs#L239)).
2. **[src/carriers.js](../src/carriers.js):** add an **inline** entry in `CARRIERS` ([L58-L71](../src/carriers.js#L58-L71)), not a separate `src/carriers/bhhc.js` file yet. An inline entry adds no import, so `RULE_FILES` and the rulebook part stay untouched until the first rule:
   ```js
   {
     id: 'bhhc',
     name: 'BHHC',
     product: 'commercial-auto', // required on every CarrierConfig (src/products.js)
     hosts: [/^portal\.bhhomestate\.com$/i], // confirmed in the Phase 0 walk
     autoFillUrl: /$^/, // blocks auto-fill & background page_layout during recon
     useGenericRules: false, // prevents generic label rules in rules.js from filling BHHC
     recon: true, // suppresses carrier-stamped usage events, fills & AI; removed with the first rules
     rules: [],
   },
   ```
   Omit `display`, `premiumPages`, `pageAdapter`, `advance`, and `quoteSteps` during recon.
3. **[test/plan-hooks.test.mjs](../test/plan-hooks.test.mjs#L133):** add `bhhc: false` to the expected `useGenericRules` map (`{ progressive: false, geico: false, amwins: true, test: true, bhhc: false }`).
4. **Recon flag & `CARRIER_REPORTS`:** the `recon` flag on `CarrierConfig` lands on `claude/bhhc-recon-stub` (separate PR), and updates [test/carrier-reports.test.mjs](../test/carrier-reports.test.mjs#L14-L17) to skip `recon` carriers so the stub needs no `CARRIER_REPORTS` entry (on today's `main` without `recon`, `test/carrier-reports.test.mjs` checks every non-`test` carrier in `CARRIERS`, which would otherwise require a placeholder `bhhc` entry in [scripts/lib/carrier-reports.mjs](../scripts/lib/carrier-reports.mjs#L29-L70)).
5. **Test behavior on this stub (`npm test && npm run typecheck && npm run package`):**
   - `test/consistency.test.mjs`: **passes** once `hosts` matches `manifest.json` `host_permissions` ([L201-L208](../test/consistency.test.mjs#L201-L208); an exact host is accepted).
   - `test/new-carrier.test.mjs` & `test/products.test.mjs`: **pass** once `product: 'commercial-auto'` is declared ([new-carrier.test.mjs](../test/new-carrier.test.mjs#L149-L155), [products.test.mjs](../test/products.test.mjs#L173)); the rules-only and `display` checks skip empty-rules stubs ([new-carrier.test.mjs](../test/new-carrier.test.mjs#L95-L133)).
   - `test/carrier-reports.test.mjs`: **passes** because `recon` carriers are skipped ([L14-L17](../test/carrier-reports.test.mjs#L14-L17)).
   - `test/plan-hooks.test.mjs`: **passes** once `bhhc: false` is added to the `useGenericRules` map ([L133](../test/plan-hooks.test.mjs#L133)).
   - `test/rulebook.test.mjs`: **passes** because `RULE_CARRIERS` filters on `c.rules.length` ([L14](../test/rulebook.test.mjs#L14)). **Do not** add `CARRIER_PARTS.bhhc` yet: [L66-L68](../test/rulebook.test.mjs#L66-L68) asserts `"every carrier with rules has a rulebook part, and nothing else does"`.
   - `test/resolution.test.mjs`: **passes**; it builds plans for every carrier, and the stub's plan is simply empty.
   - `test/concepts.test.mjs`: **passes** (`RULE_SETS` filters on `rules.length`).
   - `test/usage.test.mjs`: **passes** because the stub is inline in `src/carriers.js` rather than an unlisted module import (`RULE_FILES`).
   - `test/provenance.test.mjs`: **passes** because `RULE_CARRIERS = RATERS` ([L18](../test/provenance.test.mjs#L18)), which filters on `c.display` ([src/carriers.js](../src/carriers.js#L84)), and the stub omits `display`.
   - Output: unpacked extension in `dist/tni-rater-autofill/`.
6. The BHHC host is a required `host_permissions` entry (maintainer's decision). Merging it means the next store release shows agents Chrome's new-site prompt, so the branch merges only when that release is planned and announced. Editing `src/carriers.js` also changes the rules fingerprint for every carrier on that build, which is harmless on a branch.
7. The recon-stub pattern goes into [new-carrier.md](new-carrier.md) ("Capture the behavior") only when a stub actually lands on `main`.

### Phase 2: Live recon across 2–3 scenarios

Using an **isolated Chrome profile** (never the profile holding live agent settings, API keys, or queued logs, per `verify-tni-rater`):

1. **Configure the unpacked panel before opening BHHC (all steps mandatory):**
   - Turn **AI suggestions** off.
   - Turn **automatic fills** off ("fill pages when they open" and automatic follow-ups) and do **not** press Fill.
   - Turn **Settings → Advanced → Developer mode** on.
   - **Clear Settings → Server** in this throwaway profile and never set it again there (belt and braces alongside `recon: true`). A blank server means no upload ([sidepanel/usage-log.js](../sidepanel/usage-log.js#L210-L218)), though any queued events would upload if a server were later set ([L284](../sidepanel/usage-log.js#L284)).
   - **Mark the intake as a test run** ([sidepanel/panel/intake.js](../sidepanel/panel/intake.js#L216-L224)) as belt and braces alongside `recon: true`, so reviews leave the session out ([scripts/lib/signals.mjs](../scripts/lib/signals.mjs#L148-L159)).
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
| 3 | **World & widget model**: plain HTML (`ISOLATED`), open Shadow DOM / custom elements (`components` prefix), React discrete-event buttons (`pressInPage: true`), or page-JS widgets like ExtJS (`world: 'MAIN'`) | `world`, `pageAdapter` (`components`, `selectors.busy`), action `pressInPage` ([browser-filling.md](browser-filling.md); note `isBeat` in [src/kit/adapter.js](../src/kit/adapter.js#L183) is already generic) |
| 4 | **Page vs single-URL step routing**: distinct URLs/query params (`pageOf` in [sidepanel/panel/usage.js](../sidepanel/panel/usage.js#L24-L30)) vs single-URL SPA (`layoutSteps` via headings like AmWINS or progress bar + `document.title` like GEICO) | `layoutSteps`, `quoteSteps`, rule/action `steps`, `newQuestionsOnlySteps`, `keepTakenBack` |
| 5 | **Repeated vehicles, trailers & drivers**: all rows on one screen (`rowSections` + `witness: { selector, path }` by VIN/identity like AmWINS) vs one unit form at a time (`vehicleSteps` / `driverSteps` + `whenShown` / `unlessShown` with `unit` like GEICO) | Unit rules, `unitForm` / `unitHeld`, and lookup/add-unit helper `actions` with `steps`, `within`, and `verify` (`'revealed'`, `{ appears }`, or `{ page }`) |
| 6 | **Hard stop screens & premium format**: exact pages/steps/buttons for MVR/CLUE, payment, carrier referral/knockout (`stopped: true`), Breeze's own ineligibility screen for 11+ units or ineligible states (if it shows one, it is the carrier's `stopped` screen; the extension invents none), Breeze's **bind approved quotes** button, and **loss-run upload** (agent-only); plus where and how BHHC prints total/term/installment premiums | `stopPages`, `stopSteps`, `stopButtons`, `agentPages`, `warnPages`, `premiumPages` on `CarrierConfig` ([types.js](../types.js#L379)), and `readPremium` in [src/premium.js](../src/premium.js#L34-L44) |

### Phase 3: Scrubbed offline harness, optional page adapter, and carrier rules

1. **Offline fixture or replay (`test/fixtures/bhhc/` + `scripts/bhhc-mock.mjs`, or `test/replay/`):**
   - Choose the harness style that matches finding #4:
     - **Client-rendered / SPA or self-contained step templates (GEICO/AmWINS style):** write `scripts/bhhc-fixture.mjs` (modeled on [scripts/geico-fixture.mjs](../scripts/geico-fixture.mjs)) to build `test/fixtures/bhhc/` from `layouts/bhhc/`, stripping scripts, session tokens, CSRF nonces, and client values, and aborting without writing if `findPii` ([scripts/lib/privacy.mjs](../scripts/lib/privacy.mjs)) reports any hit. Pair with Playwright harness `scripts/bhhc-mock.mjs` (`"mock:bhhc": "node scripts/bhhc-mock.mjs"` in `package.json`).
     - **Server-backed postback pages (Progressive style):** build scrubbed layout replays and expected behavior checks.
   - Register `/test/fixtures/bhhc/` in `PRACTICE` ([src/carriers.js](../src/carriers.js#L76-L80)) and add `bhhc` to `CARRIERS` in [preview/preview.js](../preview/preview.js#L14-L18) so `npm run preview` loads BHHC offline.
2. **Page adapter (`src/content/carriers/bhhc.js` — create only if needed):**
   - Follow [new-carrier.md](new-carrier.md#L19): start from the smallest adapter that works, and create **none** if plain DOM + default `field-key.js` keys suffice.
   - If BHHC requires custom `keys`, `selectors.busy`, `components`, or SPA step reading, add a classic IIFE script at `src/content/carriers/bhhc.js` (`globalThis.__raterAdapter = { carrier: 'bhhc', shared }`, typed via `/** @import { PageAdapterShared } from '../../../types.js' */`) and reference it in `bhhc.pageAdapter`. Keep `src/kit/` completely carrier-agnostic (`src/` is copied automatically by `PACKAGED` in [scripts/lib/package.mjs](../scripts/lib/package.mjs#L50)).
3. **Carrier module (`src/carriers/bhhc.js`):**
   - Start with `// @ts-check` and `/** @type {CarrierConfig} */` (typing rule-builder functions `@returns {CarrierRule[]}` and `.map(...)` callbacks `@returns {CarrierRule}`; declare any new cross-boundary option in [types.js](../types.js)).
   - Replace the inline stub in `src/carriers.js` with `import { bhhc } from './carriers/bhhc.js'`. Remove `recon: true` when the first rules land (a test enforces that a carrier with rules is not marked `recon`), and add `bhhc` to `CARRIER_REPORTS` ([scripts/lib/carrier-reports.mjs](../scripts/lib/carrier-reports.mjs#L29-L70)).
   - Keep `product: 'commercial-auto'` and `useGenericRules: false`; scope `autoFillUrl` and `layoutUrl` strictly to BHHC quote pages; configure `stopPages`, `stopSteps`, `stopButtons`, `premiumPages`, and observed `quoteSteps`.
   - Reuse shared helpers in `src/answers/`, `src/standards.js`, and `src/util.js`.
   - Map confirmed `intake` and exact `derived` rules, plus `fact` / `attestation` hand-offs with `note` (`manualOnly`). Note: [test/provenance.test.mjs](../test/provenance.test.mjs#L97) asserts `facts > 0` for every carrier in `RULE_CARRIERS` (which is `RATERS`, i.e. carriers with `display`, [L18](../test/provenance.test.mjs#L18)), so at least one `fact` or `attestation` rule must apply on `RECORDS()`. That rule must be a real hand-off seen on Breeze during recon, never one written only to pass the test.
   - `supportedClasses` stays unset until TNI names BHHC classes.
   - Add `CARRIER_NAMES.bhhc` ([src/util.js](../src/util.js#L184-L187)) with the first rules, not with the stub: an entry immediately makes `quotedCarriersOf` raise the `prior.carrier-is-quoted` check for every intake naming BHHC ([util.js](../src/util.js#L244-L246)), which TNI wants (2026-11-13). Add a test that an intake naming Berkshire Hathaway Homestate gets the check, and that GUARD, BH Specialty, GEICO, and the member companies do not. Proposed shape (`word` is mandatory, because `sameCarrier` calls `editDistance` on it unguarded):
     ```js
     bhhc: { name: 'BHHC', word: 'bhhc', words: [['berkshire', 'hathaway', 'homestate'], ['berkshire', 'hathaway', 'home', 'state'], ['bh', 'homestate']] },
     ```
     Never use `homestate` as `word`: at nine letters it allows two typos, and a bare "Homestate" can mean other insurers. Never match bare `berkshire`, `hathaway`, or `cypress`. TNI decided (2026-11-13) that only Berkshire Hathaway Homestate names count: member companies (Cypress, Oak River, Redwood Fire & Casualty, BHHC Special Risks) are **not** BHHC on an intake and are never added. Tests: `test/normalize.test.mjs`, `test/intake-regressions.test.mjs`, `test/sidepanel-safety.test.mjs`.
   - Every rule names its `concept` from [src/concepts.js](../src/concepts.js) (adding new catalog IDs only for genuinely new concepts, then running `npm run concepts` to regenerate [docs/concepts.md](concepts.md)).
4. **Luna rulebook part (`src/ai/rulebook/bhhc.js`):**
   - Add `src/ai/rulebook/bhhc.js` in the **same commit** as the first rule in `src/carriers/bhhc.js` and register it in `CARRIER_PARTS` in [src/ai/tni-rules.js](../src/ai/tni-rules.js#L27).
   - Must export a non-empty `title` and at least one section with `heading` and `rules` whose IDs match `^bhhc\.[a-z0-9]+(?:-[a-z0-9]+)*$`, valid `kind` (`'intake'`, `'agent'`, `'workflow'`, or `'standard'`), and single-line `text` > 10 chars ([test/rulebook.test.mjs](../test/rulebook.test.mjs#L70-L87)). Do not write `(standard)` or `(TNI standard)` in non-`standard` entries ([L83](../test/rulebook.test.mjs#L83)).

### Phase 4: Complete repository contract, pilot verification, and rollout

Every place in the repository that enumerates carriers or enforces cross-cutting contracts must be updated in lockstep:

| Area | File | What to add / update | Enforced by / notes |
| --- | --- | --- | --- |
| Manifest hosts | [manifest.json](../manifest.json) | BHHC `host_permissions` (required, like the other carriers); update `description` when releasing to store (≤ 132 chars; it reads "Progressive, AmWINS and GEICO", so it needs rewording, and adding BHHC brings 122 → about 128 chars) | [test/consistency.test.mjs](../test/consistency.test.mjs#L201-L208), [L239](../test/consistency.test.mjs#L239) |
| Carrier registry | [src/carriers.js](../src/carriers.js#L58-L80) | `bhhc` (with `product: 'commercial-auto'`, `recon` removed) in `CARRIERS`; `/test/fixtures/bhhc/` in `PRACTICE` | [test/consistency.test.mjs](../test/consistency.test.mjs#L201-L208), [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L149-L155), [test/products.test.mjs](../test/products.test.mjs#L173) |
| Committed fixtures privacy | `test/fixtures/bhhc/` | Scrubbed fixtures only; a fixture-privacy test like [test/geico-fixture.test.mjs](../test/geico-fixture.test.mjs) | [test/consistency.test.mjs](../test/consistency.test.mjs#L248-L285) (`findPii` over fixtures, no tracked `layouts/`) |
| Rules fingerprint | [src/usage.js](../src/usage.js#L434) | `'src/carriers/bhhc.js'` (and any new helper modules it imports) in `RULE_FILES` | [test/usage.test.mjs](../test/usage.test.mjs#L427-L443), [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L98) |
| Concept catalog | [src/concepts.js](../src/concepts.js), [docs/concepts.md](concepts.md) | `concept` on every rule; new IDs if needed; run `npm run concepts` | [test/concepts.test.mjs](../test/concepts.test.mjs) |
| AI rulebook | `src/ai/rulebook/bhhc.js`, [src/ai/tni-rules.js](../src/ai/tni-rules.js#L27) | BHHC rulebook part registered in `CARRIER_PARTS` (add with first rule, never on empty stub) | [test/rulebook.test.mjs](../test/rulebook.test.mjs#L66-L87), [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L99) |
| Provenance & intake coverage | [test/provenance.test.mjs](../test/provenance.test.mjs#L18-L19), [L115-L179](../test/provenance.test.mjs#L115-L179) | `RULE_CARRIERS = RATERS` and `SOURCE` derive automatically once BHHC has `display`; add `NOT_MAPPED.bhhc` (with reason per unmapped intake leaf). Because `STANDARD_CARRIERS = RATERS` ([L19](../test/provenance.test.mjs#L19)), exclude `bhhc` from `STANDARD_CARRIERS` while `standards === 0` if BHHC launches intake-only | `npm test` (`facts > 0` at [L97](../test/provenance.test.mjs#L97); `standards === 0` until in `STANDARD_CARRIERS`) |
| Prior-carrier match | [src/util.js](../src/util.js#L184-L187) | `CARRIER_NAMES.bhhc` with the first rules, in the shape given in Phase 3 (must **not** match bare `"berkshire"`, which collides with Berkshire Hathaway GUARD, BH Specialty, and GEICO entities) | [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L103) (or `LEFT_OUT.names`), [test/normalize.test.mjs](../test/normalize.test.mjs), [test/intake-regressions.test.mjs](../test/intake-regressions.test.mjs), [test/sidepanel-safety.test.mjs](../test/sidepanel-safety.test.mjs) |
| Premium logging | `premiumPages` on `CarrierConfig` ([types.js](../types.js#L379)), [src/premium.js](../src/premium.js#L29-L44) | Set `premiumPages` on `bhhc` (read by `premiumHere`, [L29-L30](../src/premium.js#L29-L30)) or add `LEFT_OUT.premiumPages` while unknown; add a BHHC pattern in `readPremium` ([L34-L44](../src/premium.js#L34-L44)) if `ANY` misses term/installments | [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L72), [L104](../test/new-carrier.test.mjs#L104), [test/premium.test.mjs](../test/premium.test.mjs) |
| Helper & hook tests | [test/plan-hooks.test.mjs](../test/plan-hooks.test.mjs#L18), [L133](../test/plan-hooks.test.mjs#L133) | Add `bhhc` to the hardcoded `CARRIERS` array checking plan-hook isolation (`useGenericRules` map at L133 already has `bhhc: false` from Phase 1). Action regex/selector compilation and action/rule reference checks live in [test/carrier-lint.test.mjs](../test/carrier-lint.test.mjs#L106-L113) and loop over `CARRIERS` dynamically | `npm test` |
| Standards & agent defaults | [src/agent-defaults/registry.js](../src/agent-defaults/registry.js), [test/standards.test.mjs](../test/standards.test.mjs#L11), [test/std-metadata.test.mjs](../test/std-metadata.test.mjs#L13), [test/agent-defaults.test.mjs](../test/agent-defaults.test.mjs#L27) | `choices.bhhc` in `REGISTRY` (enforced for every carrier with rules by [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L101)), plus `std` metadata, `choices.all` intersection, `dependents`, and `test/agent-defaults.test.mjs#L27` once TNI sets BHHC standards (`standards.test.mjs` and `std-metadata.test.mjs` loop dynamically over rule carriers / `RATERS`) | `npm test` |
| Local preview & scripts | [preview/preview.js](../preview/preview.js#L14-L18), [package.json](../package.json) | `bhhc` entry in `preview.js` `CARRIERS`; `"mock:bhhc"` script | [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L106) (or `LEFT_OUT.mock`), `npm run preview`, `npm run mock:bhhc` |
| CI workflows | [.github/workflows/checks.yml](../.github/workflows/checks.yml#L90-L95), [.github/workflows/windows-smoke.yml](../.github/workflows/windows-smoke.yml#L74-L76) | Add `BHHC mock` (`npm run mock:bhhc`) to both Ubuntu PR matrix and Windows smoke workflow | GitHub Checks |
| Panel logo & rater list | `display` on the carrier (`RATERS` in [src/carriers.js](../src/carriers.js#L84)), `sidepanel/assets/raters/` (+ `SOURCES.md`) | BHHC `display` (`logo` under `sidepanel/`, `https:` `portalUrl` matching `hosts`, `product`, `classesSaid`) and logo asset with its source, added with rules (omitted on the empty-rules recon stub so the panel does not offer BHHC before it is ready) | Enforced for every carrier with rules by [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L123-L133) |
| Review & coverage scripts | [scripts/lib/carrier-reports.mjs](../scripts/lib/carrier-reports.mjs#L29-L70), [scripts/lib/daily.mjs](../scripts/lib/daily.mjs#L44-L46), [scripts/intake-mocks.mjs](../scripts/intake-mocks.mjs#L29) | Add `bhhc` to `CARRIER_REPORTS` (`signals.mjs`, `answer-key.mjs` via `scripts/lib/events.mjs`, and [scripts/coverage.mjs](../scripts/coverage.mjs#L17-L21) all read it); optionally add BHHC to `daily.mjs` `MOCK` and `intake-mocks.mjs` `RUNNERS` (or `LEFT_OUT.intakeMocks`) | `CARRIER_REPORTS` enforced for every non-`test`, non-`recon` carrier by [test/carrier-reports.test.mjs](../test/carrier-reports.test.mjs#L12-L20); `RUNNERS` enforced by [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L84-L92), [L105](../test/new-carrier.test.mjs#L105) (`daily.mjs` `MOCK` is not enforced) |
| Server & store docs | [server/dashboard.mjs](../server/dashboard.mjs#L209), [server/privacy.html](../server/privacy.html#L8), [docs/chrome-web-store.md](chrome-web-store.md#L54-L58) (host justification at L54–L55, listing bullets at [L179-L181](chrome-web-store.md#L179-L181)), [README.md](../README.md) (carrier lists on several lines and the mock sections), [docs/testing.md](testing.md), [docs/new-carrier.md](new-carrier.md), [docs/intake-and-rules.md](intake-and-rules.md) | Display name `bhhc: 'BHHC'`, privacy policy carrier list, host justification & listing bullet, commands/docs tables | `server/dashboard.mjs` is enforced for every carrier with rules by [test/new-carrier.test.mjs](../test/new-carrier.test.mjs#L100). Privacy policy, store docs, and markdown docs are **not enforced by any test**: keep in sync by hand ([L287-L293](../test/consistency.test.mjs#L287-L293) only checks that `npm run` commands named in `AGENTS.md`, `README.md`, and `docs/hosting.md` exist.) |

---

## Risk analysis

| # | Risk | Impact | Mitigation in this spec |
| --- | --- | --- | --- |
| R1 | Recon stub triggers automatic fills, Luna requests, or background `page_layout` uploads on BHHC login/dashboard pages | High: unwanted clicks or unredacted portal text logged | Stub sets `autoFillUrl: /$^/` (and omits `layoutUrl`), turning off `onQuotePage()` and `scheduleLayout()` in code; AI and auto-fill also turned off in isolated recon profile |
| R1b | Recorder uploads `page_view` / `field_change` / `agent_click` or error events from portal and search pages under the stub | Low–medium: redacted labels and choice values from non-quote pages on the dashboard, and a single carrier-stamped event makes a session a BHHC quote | `recon: true` flag on `CarrierConfig` (landing on `claude/bhhc-recon-stub` in a separate PR) suppresses all carrier-stamped usage events, fills, AI, and the "Recording usage" footer while keeping `Record` and `Alt+Shift+C` working (removed with first rules, enforced by test); Phase 2 keeps test-run mark and blank Server as belt and braces |
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

### Decided (2026-11-19)
- **Recon guarantee (`recon: true`, R1b):** Add a `recon` flag on `CarrierConfig` (on `claude/bhhc-recon-stub` in a separate PR). On a recon carrier, the panel logs no carrier-stamped usage events (`page_view`, `field_change`, `agent_click`, recorder and crash errors), does not count it as a quote page (no automatic fill, no AI), refuses a manual fill with a note, and hides the "Recording usage" footer; `Record` and `Alt+Shift+C` capture keep working. The BHHC stub sets `recon: true` and removes it with the first rules (enforced by a test); `test/carrier-reports.test.mjs` skips recon carriers so the stub needs no `CARRIER_REPORTS` entry. The profile procedure alone wasn't enough because a blank Server only queues events, and neither the test-run list (no `agent:` lines) nor the dashboard (reads only `RATER_TEST_INTAKES` fingerprints) excludes an unmarked recon session — one carrier-stamped event makes a session a BHHC quote. Phase 2 keeps the test-run mark and blank Server as belt and braces.

### For the maintainer
1. **Portal topology (Phase 0 walk):** Public sources give `portal.bhhomestate.com` as the commercial-auto login. Does Breeze stay on that host, open another top-level host, or load in a cross-origin frame (possibly `bhhc.appulate.com`)?

### For TNI (needed before `standard` rules or `CARRIER_NAMES` land; does not block Phases 1–2)
2. **Initial scope within Breeze:** Which states, business classes (for-hire trucking, business auto, or both), and coverages should BHHC v1 target?
3. **TNI standards on BHHC:** Should BHHC launch **intake-only** first (`standards === 0`, every non-intake question left to the agent/Luna, as GEICO originally did), or do TNI's shared coverage/workflow standards apply right away?
Decided by TNI (2026-11-13):
- Eligibility warning: yes.
- Power units: each vehicle counts as one.
- Domicile: the garaging address's state.
- Member companies do not count as BHHC; only Berkshire Hathaway Homestate names do.
- Same-carrier warning: yes. When the intake names Berkshire Hathaway Homestate as the current commercial auto insurer, the existing `prior.carrier-is-quoted` red check ("may be declined or routed") shows on BHHC's site. Filling still goes on. Adding `CARRIER_NAMES.bhhc` with the first rules is what turns it on.
