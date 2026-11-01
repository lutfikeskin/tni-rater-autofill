# GEICO adapter: handoff to local Claude Code (2026-10-20)

Paste into local Claude Code, started in the repo folder: **"Read layouts/geico/claude-handoff/HANDOFF.md and continue the GEICO adapter."**

## Goal

Add GEICO commercial auto support to TNI Rater Autofill the way AmWINS was added (`docs/new-carrier.md`): a `src/carriers/geico.js` adapter, a scrubbed saved-page mock with a runner, tests, and docs, all in one draft PR. The maintainer (Ayaz) reviews and merges. Scope is the captured scenario: Nebraska, ZIP 68661, a client with no USDOT number. Don't release or bump the version.

## Before you start

1. The local checkout is on `claude/release-0.9.10`, which is behind `main` (now 0.9.13). Run `git fetch origin && git checkout -b claude/geico-adapter origin/main`, then `npm ci` and `npm test` (773 tests pass on main). Windows notes: `docs/windows-development.md`.
2. Follow `CLAUDE.md`. The rules that matter most here:
   - Don't invent answers. A TNI standard counts only if `docs/intake-and-rules.md` records it, and a standard recorded for Progressive or AmWINS is not GEICO's until Ayaz says so.
   - Target controls by the carrier's stable names.
   - Never automate bind, purchase, final submit, MVR/CLUE ordering, or signing.
   - Update the docs in the same PR.

## Evidence (all in ignored `layouts/geico/`; raw, never commit)

- `NE-no-dot/*.html`: 18 pages saved with Chrome's Save page as. They contain declarative shadow DOM. **They also contain client data and a session token** (`ssotoken` hidden inputs, and `retentionKey` in the Print link), so they are raw material only. Any fixture must be scrubbed and stripped of scripts.
- `json_layouts/capture-geico-unnamed-f519-001…068-quote.json`: 68 Alt+Shift+C captures, all from one run. `node scripts/captures.mjs layouts/geico/json_layouts` writes the story to `reviews/captures-2026-10-20.md`.
- `claude-handoff/contract.md`: **finished**, a 48 KB adapter contract with file:line references. Read it first. It covers the page model, the carrier-object fields, rule syntax, the pagekit changes GEICO needs, repeated entities, why the generic rules are off, tests, the mock, CI, docs, and button classification.
- `claude-handoff/pages.md`: **finished**, an inventory of every control on each saved page, with diffs between variants. Client values and the session token are left out.

## Key facts already established

- **Addresses.** The portal is `gateway2.geico.com`. The quote starts at `sales.geico.com/dashboard?processor=commercialquote…`. Every quote step is the same address, `https://sales.geico.com/quote`, so it is a one-address application like AmWINS: steps are told apart by the progress bar, not by the URL.
- **Steps** (`#progressIndicator gds-progress-bar`): Business Class & USDOT, Business & Owner Info, Vehicles, Drivers & Incidents, Additional Business Info, Quote & Coverages, Final Quote Details, MVR & CLUE, Payment Information. The current step has 0 < value < 100. The adapter should stop before Final Quote Details, and must never act on MVR & CLUE or Payment.
- **Question ids** look like `Id_GiveDepartmentOfTransportationNumberStatus_10683`. The 5-digit number changes on every render, and radio ids add the option index plus `-shadow`. The stable locator is the name part. Today the random number also leaks into recorded keys and labels: the capture report shows the same question "went away / appeared" under a new number. Normalising `Id_<Name>_<digits>` when building keys and labels is a needed general fix; check `src/content/field-key.js`, `pagekit.js`, `scripts/lib/conditions.mjs` (`fieldId`) and `scripts/lib/transitions.mjs`.
- **Widgets.** Controls are GEICO design-system custom elements in open shadow roots (gds-radio-button-group, gds-input-wrapper, gds-currency-input-wrapper, gds-address-auto-complete-wrapper, gds-show-hide), plus select2 selects. pagekit already walks shadow roots (`deepQueryAll`, pagekit.js:52). See contract.md section 3 for what works and what needs changing.
- **The Business & Owner Info step** (business name, ownership type, owner name, DOB, marital status, phone, email, address, coverage start date, owner SSN) appears only in the JSON captures (around capture 004–007), not in the saved HTML. Ayaz will save it on the next run.

## Not finished (stopped to save credits)

1. Intake and TNI standards analysis for GEICO's questions: which intake path answers each question, which recorded standard applies, and which questions stay the agent's. Inputs: `src/schema.js`, `src/normalize.js`, `src/rules.js`, `docs/intake-and-rules.md`, and the progressive.js/amwins.js rules for the same topics.
2. Capture sequence analysis: the step order, which answer opened which question (by stable name), the open dropdown lists, and where the random suffix leaks.
3. Design: a mapping table with one row per question (intake path / derived / recorded standard / agent's note / not applicable), then an adversarial check of each row against the no-invention rule.
4. Implementation: `src/carriers/geico.js`, its registration in `src/carriers.js` (replacing the empty GEICO entry), the general pagekit/field-key fixes, unit tests, a scrubbed `test/fixtures/geico/`, `scripts/geico-mock.mjs` with `npm run mock:geico` and CI wiring like `mock:amwins`, and doc updates (README, docs/new-carrier.md, docs/architecture.md, docs/testing.md, docs/chrome-web-store.md if it lists coverage).
5. A draft PR, with "Before:" and "After:" paragraphs, the documents changed, and the open decisions for Ayaz.

## Open decisions for Ayaz (until answered, these stay the agent's)

- Should Progressive- or AmWINS-scoped TNI standards (for example: no filings, hazmat No, current carrier 1 to 2 years) also apply to GEICO?
- What are GEICO's coverage defaults on Quote & Coverages (liability limit, comp/collision, cargo, hired/non-owned auto, GL, policy term)?

## Captures still needed

A client with a USDOT number, a second state, two vehicles and two drivers, hazmat Yes, filings Yes, and the Business & Owner Info page saved as HTML.
