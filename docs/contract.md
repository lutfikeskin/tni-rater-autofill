# GEICO adapter contract

What a `src/carriers/geico.js` module, and the small general changes it depends on, must satisfy before GEICO counts as a supported carrier. Line numbers refer to the working tree on branch `claude/project-thread-8fnmsj` (clean, unmodified). No tracked file was changed to write this.

Evidence: the 18 saved pages in the ignored `layouts/geico/NE-no-dot/` (one gateway page, 17 quote pages), read structurally with scratchpad scripts (`scripts/controls.py`, `scripts/summary.py`; no typed values printed). No client value from those pages is reproduced here. The captures still hold client and agent data and a session token (`ssotoken` hidden inputs, `retentionKey` in the Print link), so they are raw material only, never a fixture.

---

## 0. The page model this contract rests on

### Addresses and steps

- Portal: `https://gateway2.geico.com/` (GEICO Gateway.html). It holds the start-quote modal (`#start-quote-zip`, product checkboxes `auto/commercial/cycle/umbrella`, **Start Quote**), a dashboard USDOT lookup box (`#dashboard-usdot`, aria "USDOT number"), and the policy/quote search (`#search-input-id`, type=search).
- Landing: `https://sales.geico.com/dashboard?processor=commercialquote&zip=…&soa=…` (the user's URL). Not captured.
- Every quote step is the one address `https://sales.geico.com/quote`: all 17 quote captures say `saved from url=…sales.geico.com/quote`. Step links are `quote#`. `currentPage()` (pagekit.js:1009) gives `/quote` for every step, so **page names cannot tell steps apart**.
- The step order is shown by `#progressIndicator > gds-progress-bar-group > gds-progress-bar` (nine of them):

  `Business Class & USDOT` · `Business & Owner Info` · `Vehicles` · `Drivers & Incidents` · `Additional Business Info` · `Quote & Coverages` · `Final Quote Details` · `MVR & CLUE` · `Payment Information`

  The current step's bar has `value` strictly between 0 and 100 (`value="50"`) and a light-DOM `<span>Name</span>`. Finished steps have `value="100"` and a light-DOM `<a role="button" href="…/quote#">Name</a>`, which are clickable back-links. Future steps have `value="0"`.
- There is no h1–h3 that names the step. The visible light-DOM headings are "Dashboard" and "Agent Info", plus section and question texts. The `<h3>`s inside `gds-component-header` shadow roots hold only a `<slot>`.

### Coverage of the captures

- Captured: Business Class & USDOT, Vehicles (first-vehicle form, list view, add-unit form, trailer form), Drivers & Incidents (a GEICO-created driver, the list, the Add Driver form), Additional Business Info (two variants), and Quote & Coverages (seven variants, including after Recalculate, with cargo, and with GL).
- Not captured:
  - the Business & Owner Info, Final Quote Details, MVR & CLUE and Payment Information steps;
  - the address suggestion list while open;
  - the select2 dropdown while open;
  - a client with a USDOT number (the folder is `NE-no-dot`);
  - two vehicles, or two drivers entered through the panel.

### Control families

All question ids and names are `Id_<Name>_<n>`. `<n>` is a 5-digit render number, and options append one digit.

| Family | Markup (light DOM unless noted) | Example stems |
| --- | --- | --- |
| Radio group | `<gds-radio-button-group id="Id_X_n" active-index="i">` (host). Question text is the host's light-DOM `<span slot="legend">…<gds-tooltip>…</span>`. Each option is a light-DOM `<gds-radio-button id="Id_X_n<i>" name="Id_X_n" value="Yes" [checked]>` with **its own shadow root** holding `<input type="radio" id="Id_X_n<i>-shadow" name="Id_X_n" value="Yes">` and `<label for="…-shadow"><slot name="label">`. Option text is the host's `[slot=label]` child. | `GiveFilingType` (Neither/State/Federal/Both), `GiveVehicleOrTrailer` (value Yes → label "Vehicle", No → "Trailer"), `GivePayPlanV2` (values `GEICO_PP_1Pay`… → "Pay In Full"…) |
| Text | `<input slot="input" id=name="Id_X_n" aria-label="…">` inside `gds-input-wrapper` | `GiveFirstName`, `GiveLastName`, `GiveZip`, `GiveInitialZipCode` |
| Currency | the same input, `inputmode="numeric" placeholder="0"`, inside `gds-currency-input-wrapper > gds-input-wrapper` | `GiveDetailedCostNew`, `GiveStatedAmount`, `GiveTotalCustomizationValue` |
| Date | input `inputmode="numeric"` with no aria-label, inside `gds-date-input-wrapper` | `GiveDateOfBirth` |
| Masked VIN | `id="Id_GiveVinPreQuote_n" name="Id_GiveVinPreQuote_nmaskedField" data-qm-encrypt="true"` | `GiveVinPreQuote` |
| select2 | `<select id="Id_X_n" aria-label="…" class="select2-hidden-accessible">`. One is `multiple` ("Select up to four commodities…") | `GivePrimaryBusinessDescription` (1599 options), `GiveYear`/`GiveMake`/`GiveModel`, `GiveDriverSuffix`, `GiveMtcHaulingCommoditiesCollect` |
| Native select | `<select id="Id_X_n" aria-label="…">` | `GiveSecondaryBusinessDescription`, `GiveOtherVehicleType`, `GiveGrossVehicleWeight`, `GiveFarthestOneWayDistance`, `GiveCity`, `GiveDriverLicenseState` |
| Coverage select | `<select id="Id_<uuid>_<n>[_COMP|_COLL|_Rental|_ERS|_FT]">` with no aria-label, labelled by a light-DOM `<gds-label-legend element="label" for="<that id>"><span>Liability Coverage</span>` (its `<label for>` is inside the shadow root), or by the section's heading | Liability type, CSL limits, the deductible rows, the cargo limit/deductible |
| Address | `<input type="search" slot="input" id=name="Id_GiveStreet_n" aria-autocomplete="list" aria-controls="address-dropdown-list" maxlength="45">` inside `<gds-address-auto-complete-wrapper threshold="3" debounce-ms="200">` | `GiveStreet` (then `GiveZip`, then the `GiveCity` select, whose options follow the ZIP) |
| Button | `<gds-button [disabled]>Text</gds-button>`. The inner shadow `<button>` holds only `<slot>`, so its own text is empty. | Next, Looks Good, Save and Continue, Discard Changes, Recalculate, Print Quote Proposal |
| Add icon | `li.add-state > .expandable-form-headline > p("Add Driver" / "Add Vehicle or Trailer")` plus `span[data-testid="addIcon"][tabindex="0"]` (no role, no onclick) | |
| Loader | `#page-load.loader-container`, `#extendedWaiting.loader-container` (`display:none` when idle) | |

### Facts about redraws and repeated names

1. **Render numbers change on redraw.** Quote & Coverages before and after Recalculate:
   - `GiveHiredCoverageRequired_65203` → `_73706`;
   - the COMP select's UUID changes;
   - the vehicle form and the trailer form give `GiveYear` different numbers.
2. **One stem can appear twice on a step.** `GivePayPlanV2` has two groups on Quote & Coverages: the main one and "View More Payment Plans".
3. **The vehicle form and the trailer form share names:**
   - `GiveYear`, `GiveOtherVehicleType`, `GiveCommercialVehicleCompCollision`, `GiveTotalCustomizationValue`, `GiveCostExcludingPermanentlyAttachedEquipment`, `GiveStatedAmount`, `GiveStreet`, `GiveZip`, `GiveCity`, `GiveRegisteredStateYesNo`.
   - Some question texts differ ("…describes the customer's **vehicle**?" / "…**trailer**?"). Year, street, ZIP and city do not.
   - The form's kind is the `GiveVehicleOrTrailer` answer, which is shown when a further unit is added and not on the first vehicle form.

### What the last run did

The captures carry the marks a run left. GEICO's `rules` are `[]` (carriers.js:27-33), so every one of these came from the generic rules.

- **Filled:**
  - driver first and last name;
  - `GiveYear`, also on the **trailer** form, by `vehicles[].year` (rules.js:26);
  - the gateway's `#start-quote-zip` (rules.js:43) and dashboard USDOT lookup box (rules.js:33). That page is not the quote, but GEICO has no `autoFillUrl`, so `onQuotePage()` is true there (sidepanel.js:1296).
- **Failed "did not keep":** three shadow-DOM radios, each matched through its humanized *name*, because the label could not be read:
  - Hazmat placard (rules.js:54);
  - filings (rules.js:56);
  - personal use (rules.js:59).
- **"No option matches":**
  - `GiveOtherVehicleType` by `vehicles[].type` (rules.js:30), matched in the name pass on "id give other vehicle type …";
  - the commodity multi-select by `operations.whatHaul` (rules.js:57).
- **"Page value differs":** VIN (masked field) and date of birth.

---

## 1. Carrier-object fields

Fields are read where the table says. Status: **R** required, **N** new field (needs the general change named), **O** omit, **D** decision for TNI or the maintainer.

| Field | Read at | GEICO value | Status / why |
| --- | --- | --- | --- |
| `id` | plan.js:152 (`${carrier.id}.q…` path of pathless rules), usage, provenance.test.mjs:183 | `'geico'` | R |
| `name` | panel display, carriers.js:56 (practice name) | `'GEICO'` | R |
| `hosts` | carriers.js:58; consistency.test.mjs:85-91 checks the manifest | `[/(^|\.)geico\.com$/]` (keep, carriers.js:30). `https://*.geico.com/*` (manifest.json:22) already covers `sales.` and `gateway2.` | R, no manifest change |
| `rules` | plan.js:52 | explicit list (§2) | R |
| `useGenericRules` | plan.js:50 | `false` | R (§5) |
| `rowSections` | plan.js:50-51 | — | O. Irrelevant once generic rules are off |
| `autoFillUrl` | sidepanel.js:1296 (automatic follow-up fills only there); set to null for practice copies (carriers.js:56) | `/^https:\/\/sales\.geico\.com\/quote(?:[?#\/]|$)/i` (tested against the full URL) | R. Without it the gateway and dashboard are auto-filled |
| `layoutUrl` | sidepanel.js:1764 (layouts recorded by themselves only there) | the same regex | R |
| `layoutSteps` | carriers.js:11-12; usage.js:240-247 `knownStep`; sidepanel.js:1283, 1544, 1670, 1950, 1973 (report key per step) | the nine step names above | R. Needs the step reader (§3.F), because `stepKey()` reads h1–h3 and finds none |
| `quoteSteps` | carriers.js:14-15, 64-68 | `STEPS.map((name) => ({ name, step: name }))`. The order is observed (progress bar), satisfying new-carrier.md:20 | R |
| `world` | sidepanel.js:2252 | omit (ISOLATED) | O. Text via `setNativeValue` and select2 via native `change` both took in ISOLATED (first/last name and Year kept). The fix in §3.C reads Lit state from host attributes, not properties. Use MAIN only if the mock and a live check prove a Lit property must be set. |
| `batch` | sidepanel.js:1350 | omit (false) | O. GEICO redraws questions after answers and shows loaders. There is no evidence that per-answer waits are unnecessary (new-carrier.md:17). |
| `replaceChoices` | sidepanel.js:1348 | omit (false) | D. Several captures show pre-selected answers (`GiveRegisteredStateYesNo` Yes, `GiveOwnerActiveDriverStatusYesNo` Yes, `GiveMtcEligibleRequireCoverageYesNo` Yes), and whether GEICO or the agent picked them is unknown. With false, a differing page answer is kept and flagged "differs". |
| `actions` | plan.js:63-126; sidepanel.js:1226 (`repeatOnReturn`) | §7 | R (Recalculate). Add-unit helpers in phase 2 |
| `advance` | sidepanel.js:1355; pagekit.js:1900-1903, 1028-1041 | phase 1: omit (the agent clicks Next). Phase 2: `{ text: '^(next|save and continue)$', steps: STEPS.slice(0, 5) }` | N (`steps` allowlist, §3.F). `exceptPages` cannot express steps, since all are `/quote`. |
| `stopPages` | sidepanel.js:1212-1216, 1365, 1490, 1499, 1580; pagekit.js:1254 | — | O. Page-keyed |
| `stopSteps` | new | `{ 'MVR & CLUE': '…orders reports: yours…', 'Payment Information': '…yours…' }` | N (§3.F). Nothing is filled or clicked there |
| `agentPages` | sidepanel.js:2794 | — | O. Page-keyed; an `agentSteps` analogue is optional |
| `quoteState` | quote-state.js:6, 31-39 | — | O. The rated state is header text, not a control. `GiveInitialZipCode` is a ZIP, and `stateCode` cannot get a state from it. |
| `supportedClasses` | plan.js:25-35 | — at first | D. Without it there is no review gate (provenance.test.mjs:518). Declare the validated classes once GEICO has any `standard` rule (none yet, §2). |
| `vehicleList`, `vehiclePages`, `trailerList`, `trailerPage(s)`, `driverList`, `driverPage` | sidepanel.js:1230, 1326-1328, 2370-2374, 2392-2463 | — | O. Page-keyed. Setting them to `/quote` would scope *every* step by unit and drop agent-edit protection of non-unit steps when the active unit changes. |
| `vehicleSteps`, `driverSteps` | new (sidepanel.js:1325-1329 `stepScope`) | `['Vehicles']`, `['Drivers & Incidents']` | N (§3.G) |
| practice copy | carriers.js:45-48 `PRACTICE` | add `{ path: /^\/test\/fixtures\/geico\//, carrier: 'geico' }` | R for the mock (§6) |
| module wiring | carriers.js:22-34; usage.js:256 `RULE_FILES` | `import { geico } from './carriers/geico.js'`, replacing the stub at 27-33. Add `'src/carriers/geico.js'` to `RULE_FILES`. | R. usage.test.mjs:281-296 fails otherwise |

Skeleton (illustrative; values that need TNI are marked):

```js
// src/carriers/geico.js
const STEPS = ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents',
  'Additional Business Info', 'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information'];
const QUOTE = /^https:\/\/sales\.geico\.com\/quote(?:[?#/]|$)/i;
const TRAILER = { field: 'GiveVehicleOrTrailer', option: 'Trailer' };   // §3.H

export const geico = {
  id: 'geico',
  name: 'GEICO',
  hosts: [/(^|\.)geico\.com$/],
  autoFillUrl: QUOTE,
  layoutUrl: QUOTE,
  layoutSteps: STEPS,
  quoteSteps: STEPS.map((name) => ({ name, step: name })),
  // Generic label rules matched GEICO's humanized names and the trailer form (§5).
  useGenericRules: false,
  vehicleSteps: ['Vehicles'],                 // §3.G
  driverSteps: ['Drivers & Incidents'],       // §3.G
  stopSteps: {                                // §3.F
    'MVR & CLUE': 'This step orders MVR and CLUE reports: nothing here is filled or clicked. It is yours.',
    'Payment Information': 'Payment is yours: nothing here is filled or clicked.',
  },
  actions: [
    { id: 'recalculate', text: '^recalculate$', waitRequired: true, needsRecalculation: true, verify: 'premium' },
  ],
  rules: [ /* §2 */ ],
};
```

---

## 2. Rule syntax, with real examples

`fieldSteps` (plan.js:132-269) reads these keys. A rule needs one **locator** and one **answer**.

### Locators (how `assign` finds the field, pagekit.js:387-498)

| Key | Meaning | Example in repo |
| --- | --- | --- |
| `field` | the field's data-model name (`c.ref`, pagekit.js:174, 256, 266). It wins over text, claims the field from text rules (pagekit.js:416-417), and a renamed field is reported (pagekit.js:489-490). | progressive.js:582 `{ q: '1ED', source: 'derived', clientFact: true, field: 'USDOTInput.Question', ask: 'Does the customer have a USDOT Number?', name: 'Has a USDOT number', kind: 'choice', value: hasUsdot, note: hasUsdotNote }` |
| `ask` | exact question text(s), compared squashed (pagekit.js:413) | progressive.js:737 `{ q: '2CE0', source: 'derived', ask: 'What is the value of the permanently attached equipment?', … kind: 'money', value: vehicleEquipment, ignore: (r) => !equipmentOver(r), scope: 'vehicle' }` |
| `label` + `not` | regex on the squashed label. With `page` it is a known question; without, a fallback (pagekit.js:494-498) | progressive.js:339-343 `{ path: 'drivers[].first', label: '^(driver )?first name$', not: 'business|company|agent|producer' }`; amwins.js:328 `{ name: 'Non-profit (standard: No)', label: '^is non profit$', kind: 'bool', source: 'standard', value: () => false }` |
| `selector` | CSS matched on the control itself, or on any radio of a group (pagekit.js:466-482). First unused match wins; no "renamed" check. | amwins.js:325 `{ selector: '#entityType', name: 'Entity type (from the company name)', kind: 'choice', source: 'derived', clientFact: true, value: entityType, note: entityTypeNote }` |
| `withOption` | an unlabelled list known by one of its options (pagekit.js:484) | |
| scoping | `page`, `notPages`, `pageOnly`, `control`, `askAfter`, `each` (plan.js:206-217) | `onPage` helper, progressive.js:418 |

### Answers

- `path` (intake) or `value(record, active)`.
- `source` is one of `intake`, `derived`, `standard`, `fact`, `attestation` (plan.js:17-18, 158). `fact` and `attestation` are never filled (plan.js:160-164).
- `clientFact` makes a missing derived answer `manualOnly` (plan.js:179).
- `note` marks the field the agent's and fills nothing (plan.js:163-174, amwins.js:453 `#accept`).
- Other answer keys: `warn`, `ignore`, `emptyNote`, `optional`, `trustPage`, `replace`, `keepChoice`, `verifyOnly`, `hidden`, `group`, `fallback` (address), `search` (type-ahead), `choiceAliases`, and `name`.
- `kind`:
  - typed: `text`, `date`, `money`, `phone`;
  - choice: `choice`, `bool`, `pick-not`, `first-option`, `selected-option` (pagekit.js:367-370);
  - special: `address-suggest`, `search-select` (pagekit.js:830-831).

### Units

- `scope: 'vehicle' | 'trailer'` creates one step per unit when there are several units, and only the active unit's step answers on a one-unit form (plan.js:141-146, pagekit.js:443-457).
- Paths with `[]` take the active index (plan.js:150-152).
- `repeat` + `repeatSelector` + `witness` serve rows drawn together (amwins.js:470-475; §4).

### GEICO rules

GEICO's form is `field: '<Stem>'`, which needs §3.A. Until then the only stable locator is a prefix selector, which is weaker (§3).

```js
// Intake answers (source 'intake' implied by path)
{ field: 'GiveFirstName', path: 'drivers[].first' },
{ field: 'GiveLastName', path: 'drivers[].last' },
{ field: 'GiveDriverSuffix', path: 'drivers[].suffix', optional: true },
{ field: 'GiveDateOfBirth', path: 'drivers[].dob', kind: 'date' },               // format unproven (§3.I)
{ field: 'CommercialDriverLicense', path: 'drivers[].cdl', kind: 'bool' },
{ field: 'TeamDrivingOrSlipSeatingYesNo', path: 'operations.teamDriving', kind: 'bool' },
{ field: 'GiveAnyVehicleNeedHazardousMaterialPlacardYesNo', path: 'operations.hazPlacard', kind: 'bool' }, // blank: the agent's
{ field: 'GiveHasFilingsYesNo', path: 'operations.filingsRequired', kind: 'bool' },
{ field: 'GiveVinPreQuote', path: 'vehicles[].vin', scope: 'vehicle', unlessAnswer: TRAILER },
{ field: 'GiveYear', path: 'vehicles[].year', kind: 'choice', scope: 'vehicle', unlessAnswer: TRAILER },
{ field: 'GiveYear', path: 'trailers[].year', kind: 'choice', scope: 'trailer', whenAnswer: TRAILER },
// Derived (exact mapping in code, tested with a nearby case where it must not apply)
{ field: 'GiveDepartmentOfTransportationNumberStatus', name: 'Has a USDOT number', source: 'derived', clientFact: true,
  kind: 'choice', value: (r) => (r.applicant?.dot ? 'Yes' : null) },   // no DOT: No vs "applied" is the agent's
{ field: 'GiveFilingType', name: 'Filing type', source: 'derived', clientFact: true, kind: 'choice', value: filingType },
// The agent's (no intake field; no TNI standard recorded for GEICO)
{ field: 'GiveVehicleOrTrailer', name: 'Vehicle or trailer', source: 'fact', note: 'Pick Vehicle or Trailer for the unit you are adding.' },
{ field: 'GivePayPlanV2', name: 'Payment plan', source: 'fact', note: 'The payment plan is yours.' },
// UUID-id coverage selects: by text, or by GEICO's stable coverage-code suffix
{ selector: 'select[id$="_COMP"]', name: 'Comprehensive deductible', source: 'fact', note: '…' },
{ ask: 'Liability Coverage', name: 'Liability coverage type', source: 'derived', clientFact: true, kind: 'choice', value: liabilityType },
```

Mapping rules that must hold:

- No `source: 'standard'` rule may be added until TNI records it **for GEICO** in docs/intake-and-rules.md. Its carrier-standards list (lines 53-78) has Progressive and AmWINS entries only.
- Progressive's "blank is No" for hazmat placard and for filings (intake-and-rules.md:69, 71) is Progressive's standard, not GEICO's.
- Candidate mappings from the captures, all subject to TNI and the maintainer:
  - `GiveInitialZipCode` → `garaging.zip`, after confirming GEICO's rated ZIP is the garaging ZIP.
  - `GiveCurrentGeicoCommercialAutoPolicyYesNo` → derived from `priorInsurance[]`.
  - `GiveBusinessStartDate` (buckets) → derived from `applicant.yearsInBusiness` / `yearEstablished`.
  - `GiveFarthestOneWayDistance` (buckets) → derived from `operations.radiusMiles` / `radius`.
  - `GiveCommercialVehicleForPersonalUse` → `operations.personalUse`. This is a per-vehicle question answered from a business-level intake answer; confirm with TNI.
  - `GiveOwnerActiveDriverStatusYesNo` → `applicant.ownerDrives`.
  - `GiveDriverLicenseState` → `drivers[].licenseState`, with the state code mapped to its full name in code.
  - `GiveMtcEligibleRequireCoverageYesNo` → `coverage.cargo`.
  - `GiveMotorTruckGeneralLiabilityCoverageRequired` → `coverage.gl` / `hasGl`.
  - CSL limits → `coverage.autoLiabLimit`, by money tokens.
  - `GiveStreet` / `GiveZip` / `GiveCity` → `garaging.*`, with `kind: 'address-suggest'` for the street.
- Bounded semantic choices go to the agent (or the AI) and are never matched by regex:
  - `GivePrimaryBusinessDescription` (1599 options);
  - `GiveSecondaryBusinessDescription`;
  - `GiveOtherVehicleType`;
  - `GiveMtcHaulingCommoditiesCollect` (multi, up to four).
- The rest have no intake field and are `fact` notes until TNI decides:
  - the Amazon, food-delivery, oil-field, coiled-steel, daycare, client-transport and seasonal-worker questions;
  - the AI and waiver-of-subrogation questions;
  - employees;
  - GVW;
  - comp/coll, rental, ERS, fire and theft, hired and non-owned coverages;
  - SR-22;
  - registration state;
  - `GiveExtendUsDotVerifyBusinessAddress` (its meaning is unclear from the captures).
- test/provenance.test.mjs:194 requires every carrier to read `operations.equipVehicle`, for example through `GiveAnyVehicleCustomizationYesNo` / `GiveTotalCustomizationValue` once TNI confirms they mean attached equipment. If they don't, the test needs an explicit GEICO exception.

---

## 3. Targeting GEICO's widgets, and the general changes needed

### What works today, with no kit change

- `deepQueryAll` (pagekit.js:50-54) collects inputs inside open shadow roots, so the shadow radios are seen. `collectControls` groups them by `name` (pagekit.js:233-245).
- A **prefix selector** on the control itself finds a question despite its render number: `selector: '[name^="Id_GiveFilingType_"]'` for a radio (matched on each radio, pagekit.js:468), `select[id^="Id_GiveYear_"]`, `[id^="Id_GiveFirstName_"]`. The trailing `_` keeps `Id_GiveYear_` from matching `Id_GiveYearsWithCurrentAutoInsurer_`.
- A prefix selector has four weaknesses:
  - It must be one compound selector. A descendant combinator across a shadow boundary, such as `gds-radio-button-group[id^=…] input`, never matches, because `matches()` stops at the root.
  - Selector rules are not "known" (pagekit.js:406), so they get no ambiguity, claimed or renamed handling.
  - **The field key keeps the render number** (field-key.js:28-29 returns `name || id`). The agent's corrections (`skip`, sidepanel.js:1367) and the AI apply guard therefore stop protecting a field as soon as GEICO redraws it.
  - Learning and coverage see one question as many keys.
- **select2, single:** the hidden native select is collected (its 1-px box is visible to `getClientRects`). `apply` sets it natively and dispatches `change` (pagekit.js:855, `setNativeValue` at 682), and select2 and jQuery handlers receive it: `GiveYear` was kept. Dependent lists (Make, Model) get the 6-second wait for options (pagekit.js:849-854).
- **Currency:** a plain light-DOM text input. Use `kind: 'money'`; `agreesWith` compares amounts (pagekit.js:990-994).

### Required general changes, in priority order

All live in the shared engine. Each needs a unit or mock test and a version bump where noted.

**A. A stable field name from `Id_<Name>_<n>`** (correction protection; enables `field:` rules).

- **field-key.js:13** (before the `fieldref` branch): derive
  ```js
  const gen = (s) => String(s ?? '').match(/^Id_([A-Za-z][A-Za-z0-9]*)_\d+(?:maskedField|-shadow)?$/)?.[1] ?? null;
  const stem = gen(el.name) ?? gen(el.id);   // name first: a radio's id carries its option digit
  ```
  and return `ref:<stem>` (the same namespace as a Duck Creek `fieldref`). Expose `gen` on the exported function, like `rowKeyBase` and `legacyKey` (field-key.js:64). Bump the version 4 → 5 (field-key.js:5, 64).
- UUID coverage ids (`Id_1c84…-…_65566`) contain `-`, so they correctly get no stem.
- **pagekit.js:174** `fieldRef`: `el?.getAttribute?.('fieldref') || globalThis.__raterFieldKey.gen?.(el.name) || globalThis.__raterFieldKey.gen?.(el.id) || null`. Lines 256 and 266 then give `c.ref` / `g.ref`, so `field: 'GiveFilingType'` works.
- **pagekit.js:237**, the radio group key: group by the raw `el.name`, not by `__raterFieldKey(el)`. Otherwise the two `GivePayPlanV2` groups, whose names differ but whose stem is the same, merge into one group of eight.
- Two fields with one stem on a page get the same key. `assign` leaves a `field` rule with two free matches unanswered (pagekit.js:464), which is the safe outcome. An edit then protects both (the safe direction). `markKey` already tells same-key fields apart by label (pagekit.js:2052-2056).
- Bump `__raterKit.version` 68 → 69 (pagekit.js:2316).

**B. Slot-projected text** (labels of shadow radios, options, buttons).

- **pagekit.js:116** `radioGroupLabel`: today `closest('[role=radiogroup]')` and `closest('fieldset')` stop at the option's own shadow root. The container walk (pagekit.js:126) ends at the root too, so the label falls back to the humanized name, which is what generic rules then matched.
  - Add first: when `first.getRootNode()` is a ShadowRoot, walk the composed ancestors (`root.host`, then `parentElement`, then `getRootNode().host`…) to the nearest element with a direct `[slot=legend]` child.
  - Use that child's text without its `gds-tooltip` subtree.
- **pagekit.js:262**, option text: when `r.labels` gives no text (the label holds only `<slot>`), use `r.getRootNode().host?.querySelector(':scope > [slot=label]')` text. This gives Yes → "Vehicle" / No → "Trailer" and `GEICO_PP_1Pay` → "Pay In Full". `matchOption` then compares real wording.
- **pagekit.js:86** `labelFor`:
  - strip markup from `aria-label` (one GEICO aria-label carries `<span …>Name</span>'s Driver License State`);
  - if the mock shows a coverage select still unlabelled, also take the text of a light-DOM element with `for="<id>"` (`gds-label-legend`).

**C. Radio state across shadow roots** (the three "did not keep" failures).

- Each `gds-radio-button` has its own shadow root, so its inputs are **not one native radio group**. Checking "No" leaves "Yes" checked, and `change` is not composed. `selectedText` (pagekit.js:322) returns the first checked input.
- The visible state is on the hosts: `gds-radio-button[checked]` and the group's `active-index`.
- Change `selectedText` / `agreesWith` so that, for a radio whose input sits alone in a shadow root, the host's `checked` attribute is the state.
- In `apply` (the radio branch at pagekit.js:856), after `opt.el.click()`, wait for the host to show the choice and report "did not keep" only if it doesn't.
- This is a hypothesis drawn from the markup. The mock must reproduce the host-attribute behaviour, and one supervised live run must confirm it before the radio rules count as working.
- `highlightTargets` (pagekit.js:942) should mark the `gds-radio-button` host and the select2 container, not the invisible inner input or the 1-px select.

**D. The address box is `type=search`.**

- **pagekit.js:23** `SKIP_INPUT_TYPES` is applied at line 232. Recorder `SKIP_TYPES` (recorder.js:39, used at 236) does the same.
- Change: keep skipping `search`, except `input[type=search][aria-autocomplete=list][aria-controls]:not(.select2-search__field)`. select2's own search box also has `aria-autocomplete="list"` (captured), and the portal search has no `aria-controls`.
- `applyAddress` (pagekit.js:720) uses `SUGGESTION_SELECTOR` (pagekit.js:718), which includes `[role=option]`. GEICO's `#address-dropdown-list` items were never captured open. **Capture them before relying on `kind: 'address-suggest'`.** The wrapper only queries after three characters and a 200 ms debounce.

**E. GEICO buttons and add icons.**

- **pagekit.js:1031** (`findAdvanceButton`), **1049** (`findButton`), **2217** (`capture`'s button list) and **recorder.js:442-447** (`BUTTONS`, agent clicks) all read `oneLine(el.value || el.textContent)` from the inner shadow `<button>`, which is empty.
- Add a helper: `buttonText(el) = own text || (root is a ShadowRoot ? root.host text : '')`. Treat the host's `disabled` / `aria-disabled` like the element's own (pagekit.js:1034, 1050).
- Add `[data-testid][tabindex]:not([tabindex="-1"])` to `findButton`'s candidates only. Then `token: 'addIcon'` with `near: 'Add Driver'` (`isNear`, pagekit.js:1066-1074) finds the add icon. Never add it to advance.
- **pagekit.js:1006** `NEVER_CLICK` and **1027** `NEVER_ADVANCE`: add `discard` ("Discard Changes", "Yes, please discard."). Add `order` and `e-?sign|signature` to `NEVER_CLICK` (§7).

**F. Step identity** (needed by `layoutSteps`, `quoteSteps`, `doneSteps`, report keys, `stopSteps`, `advance.steps`).

- **pagekit.js:2303** `stepKey()` and **recorder.js:276-280** `stepKey`: put the current progress step first: `deepQueryAll(document, 'gds-progress-bar')`, the one with `0 < value < 100`, its light-DOM text. Then the headings as today.
- `knownStep` (usage.js:240-247) already picks the part that is one of `layoutSteps`, so its redaction rule (only a known step name is sent) still holds.
- **pagekit.js:1902-1903**, the advance gate: add `&& (!advance.steps || advance.steps.some((s) => report.stepKey.split(' / ').includes(s)))`. This is an allowlist, so an unknown or undrawn step never advances.
- **pagekit.js:1254** and the panel's stop checks (sidepanel.js:1212-1216, 1365, 1490, 1499, 1580): add a `stopSteps` variant, compared to the known step.
- **pagekit.js:191-199** `pageBusy`: add `#page-load, #extendedWaiting` (GEICO's loaders) to the overlay list.

**G. Unit-scoped edits on a one-address application.**

- **sidepanel.js:1325-1329** `stepScope`: also take the entity from `carrier.vehicleSteps?.includes(step)` / `driverSteps`, using the tab's known step (`state.tabSteps.get(tabId)`, as `reportKey` does at sidepanel.js:1971-1974).
- A correction on driver 1's form then doesn't block driver 2's, and `doneSteps` (sidepanel.js:1353) is per unit. Each unit form's Next would otherwise count the whole Vehicles step as done.

**H. Vehicle versus trailer form.**

- The names are shared, and Year, street, ZIP and city have the same text, so neither `field` nor `ask` can tell the forms apart.
- Add rule keys `whenAnswer` / `unlessAnswer: { field, option }`, copied by fieldSteps (plan.js:186-267). `assign` (the step loop at pagekit.js:450) then skips a step whose condition the page's current selection of `field` contradicts.
  - The first vehicle form has no `GiveVehicleOrTrailer`, so `unlessAnswer: TRAILER` holds there.
  - A trailer rule needs `whenAnswer: TRAILER` shown and answered.
- The answer itself is the agent's in phase 1 (§2).

**I. Open items that need mock or live proof before a rule ships.**

- The date input: the value is typed as `MM/DD/YYYY` by `textFor` (pagekit.js:696-707), and the capture shows "page value differs". Find out whether GEICO's mask wants digits only.
- The masked VIN: after blur the page may show a masked value, and `loose` comparison fails. If so, `trustPage` or a compare that ignores the mask is needed.
- The select2 multi-select: `setNativeValue` selects one value only. Leave it to the agent or the AI.
- The premium wording, used by the Recalculate helper's `verify: 'premium'`:
  - `ratesStale` (pagekit.js:1011-1016) matches GEICO's "Please Recalculate", but not the `$ --.--` placeholder;
  - `premiumReady` (pagekit.js:1018-1023) does not match GEICO's "Quote $… Due Today $… Total".
  - Add both patterns, with a test.

`world: 'MAIN'` is **not** needed for any of A–H.

---

## 4. Repeated drivers and vehicles

### How GEICO shows them

- One form at a time, at one address, inside one step.
- The list view (`li.edit-component-list-item` rows) shows each unit's type, VIN and year/make/model, or the driver's name. It has edit icons (`span.expandable-form-edit-icon`), an `li.add-state` "Add Vehicle or Trailer" / "Add Driver" with an `addIcon`, and **Looks Good** in `#Id_HaveAnotherVehicleAdaptiveActionSet_Container_<n>` (or `…Driver…`).
- A unit form is the expanded `.expandable-form-content-container`. Its commit button is **Next** (vehicle) or **Save and Continue** (driver), in `#Id_*ComboActivityDataActions_<n>` and `#Id_AdditionalSubmitButtonActivity_<n>`, next to **Discard Changes**.
- Collapsed forms are hidden, so their controls are skipped (`isVisible`).
- A driver GEICO created itself (from Business & Owner Info) is shown with the driver's name inside its question labels.

### What fits, and what doesn't

| Mechanism | Fit for GEICO | Why |
| --- | --- | --- |
| Active index (`state.active`, the panel picker; `[]` paths; `scope: 'vehicle'`/`'trailer'` with `activeVehicle`) | **Use** | `assign`'s one-unit page logic (pagekit.js:443-457) answers only the active unit's step when no control names a vehicle. GEICO controls have no Duck Creek row, so `oneVehicle` is true. This is how Progressive's Add Vehicle and Add Driver pages work. |
| `witness` (amwins.js:470-471; pagekit.js:471-479, 541-559) | **Don't use (phase 1)** | A witness is a value *the page* shows to identify a row, such as an AmWINS imported VIN. On GEICO the VIN box is typed by this same fill, so it proves nothing. It works only in the selector branch, and `rowWitnessOf` (pagekit.js:550-558) walks `parentElement`, which stops at a radio's shadow root, so radios would always be unwitnessed. |
| `repeat` + `repeatSelector` | **Don't use** | It is for several rows on screen at once (AmWINS repeaters). |
| `rowSections` | n/a | Generic rules are off (§5). |
| `vehicleList` / `driverList` / `pickListItem` / `verifyListed` / `verifyDrivers` / `unitArrival` (sidepanel.js:2365-2470) | **Not as is** | All are page-keyed. `listed()` (pagekit.js:2040-2049) would work on GEICO's list views, because it reads innerText for 17-character VINs and full names. Using it needs a step-keyed list view, for example `vehicleListStep: 'Vehicles'` plus "no unit form open". That is phase 2. |

### Phase 1 contract (no add helpers)

- The agent opens Add Driver or Add Vehicle or Trailer, and picks the unit in the panel's picker.
- The rules fill the open form for `state.active`. Edits and doneSteps are scoped per unit (§3.G).
- Driver identity: on an Add Driver form the fill types the active driver's first and last name itself. On a form for a driver GEICO already created, the labels name the driver. With more than one intake driver, per-driver answers must be filled only when those labels name the active driver, and are the agent's otherwise. This needs a small kit check, a driver analogue of `vehicleRow` (pagekit.js:563-568). Until it exists, with more than one driver, only the Add Driver form is filled.
- Editing an existing listed unit (edit icon) is the agent's.
- **Looks Good** is the agent's: nothing yet proves every intake unit is listed.

### Phase 2 (after phase 1 is proven)

- Actions:
  ```js
  { id: 'addVehicle', token: 'addIcon', near: 'Add Vehicle or Trailer', scope: 'vehicle', doneWhen: … }
  { id: 'addDriver', token: 'addIcon', near: 'Add Driver', scope: 'driver', doneWhen: …, unfinished: … }
  ```
  These need §3.E and `vehicleListStep` / `driverListStep`, with `listed()`-based `verifyListed` / `verifyDrivers`.
- After that, "Looks Good" may join `advance` once every intake unit is listed.
- Action ids already scope per unit as `${id}:${active.<list>}` (plan.js:72-73).

---

## 5. Generic label rules

### How the other carriers handle them

- `buildPlan` (plan.js:47-54) appends `GENERIC_RULES` (rules.js:1-71) unless `useGenericRules === false`. With `rowSections` it fences them out of those containers (`notWithin`, pagekit.js:493).
- Generic rules match in two passes, first the squashed **label** and then the humanized **name/id** (`c.hint`, pagekit.js:270; passes at 494-498).
- **Progressive:** `useGenericRules: false` (progressive.js:431-433, "Generic label fallbacks can turn an unvalidated field … into an assertion"). It keeps its own reviewed `SAFE_LABEL_RULES` (progressive.js:336-363) inside `rules` (progressive.js:575).
- **AmWINS:** keeps the generic rules, but fences them off its repeaters: `rowSections: [DRIVER, VEHICLE, VEHICLE_COVERAGES]` (amwins.js:264-267), after a hand-added trailer got the first vehicle's body type.

### Decision for GEICO: `useGenericRules: false`

The captured run shows why:

1. `vehicles[].year` (rules.js:26) filled the **trailer** form's Year. The label is just "Year", so `not: 'trailer'` cannot help.
2. With labels unreadable in the shadow DOM, the label *is* the humanized name, so `placard`, `filings?` and `personal use` (rules.js:54, 56, 59) matched radios by their names. The name pass matched `vehicles[].type` (rules.js:30) to "id give other vehicle type …".
3. `operations.whatHaul` (rules.js:57) hit the commodity multi-select, which allows up to four choices.
4. `applicant.dot` and `garaging.zip` (rules.js:33, 43) filled the gateway's lookup and start boxes, because the carrier had no quote address.
5. GEICO's markup has no repeating-row container to fence, so `rowSections` cannot contain these. The misfires are form-wide and name-based.

The consequence: every GEICO answer is an explicit rule. An unmapped question shows as unfamiliar and is the agent's, which is the intended safe failure. If a narrow label fallback is ever wanted, copy Progressive's pattern: a reviewed list inside `rules`.

---

## 6. Tests, mock harness, CI and docs

### Unit tests (`npm test`)

**New `test/geico.test.mjs`:**

- `buildPlan(record, geico, active)`:
  - each mapped field gets the intake value;
  - a blank intake answer leaves the field the agent's (`manualOnly` / noData), never a default;
  - there are no `standard` sources until TNI records some;
  - `fact` and `attestation` are never filled.
- Each derived mapping (filing type, USDOT status, business-age and distance buckets, license state names), each with a nearby case where it must not apply.
- Vehicle versus trailer: with `whenAnswer` / `unlessAnswer`, only one of the two GiveYear steps is live.
- `quoteProgress(geico, '/quote', 'Vehicles')` returns `{ name: 'Vehicles', index: 2, count: 9 }`.
- `carrierForUrl` for `sales.geico.com/quote`, `gateway2.geico.com/` and the practice path `/test/fixtures/geico/…`.
- `autoFillUrl` matches `/quote` and not `/dashboard` or the gateway.

**Changes to existing tests:**

- **test/provenance.test.mjs:14**: add `geico` to `CARRIERS`. Add `SOURCE.geico` (around line 102), `NOT_MAPPED.geico` with a reason per intake field not read (around line 107), and `READ_INDIRECTLY.geico` (around line 161). The test at line 176 then guards GEICO; line 194 requires `operations.equipVehicle`.
- **test/usage.test.mjs:281-296**: passes once `RULE_FILES` lists `src/carriers/geico.js`.
- **test/sidepanel-safety.test.mjs:2567-2579**: still passes, because it uses a literal `{ id: 'geico' }`. Its comment "GEICO for now" becomes false: rename the literal to a neutral id. Add a GEICO case: layouts scheduled on `sales.geico.com/quote`, not on the gateway.
- **test/intake-source.test.mjs:103**: same literal; add the real-carrier assertion above.
- **test/normalize.test.mjs:383-385**: unchanged.
- **Field key** (test/pagekit.test.mjs or test/recorder.test.mjs, which load field-key.js through `vm`, pagekit.test.mjs:15-17):
  - `Id_GiveYear_81515` → `ref:GiveYear`;
  - radio name `Id_X_36353` / id `Id_X_363531-shadow` → `ref:X`;
  - `…_25322maskedField` → `ref:GiveVinPreQuote`;
  - a UUID coverage id has no stem;
  - Progressive `fieldref` and AmWINS `name#row` keys are unchanged.
- **Engine:** `NEVER_CLICK` / `NEVER_ADVANCE` now block "Discard Changes"; `advance.steps` refuses an unlisted step; `stopSteps` refuses to fill.

### Saved-page behaviour mock (the AmWINS pattern)

**`test/fixtures/geico/`** holds scrubbed copies of the captured steps (one SPA file, or one per step) plus `mock.js`:

- Scrub every client and agent value: names, phone, email, agency, agent id, address, VIN, DOB, premiums, and the `ssotoken` / `retentionKey` attributes.
- The committed-fixture scan (consistency.test.mjs:102-110, `findPii`) covers `test/fixtures/**` automatically.

`mock.js` reproduces GEICO's behaviour, the way test/fixtures/amwins/mock.js does for AmWINS:

- `gds-radio-button` hosts set `checked` on the clicked option, clear the others, and update `active-index`. The inputs sit in separate declarative shadow roots, as captured. Real Chromium parses `<template shadowrootmode>` when served.
- `gds-button` forwards clicks; `disabled` lives on the host.
- Adaptive redraw: an answer reveals follow-ups and **renumbers suffixes**, and Recalculate re-renders Quote & Coverages with new numbers and UUIDs.
- The progress bar moves on Next.
- The unit list with Add icons, the add and edit forms, and Discard with its confirm.
- select2-like hidden selects; Make and Model load after Year.
- The address suggestions, once their markup is captured.
- The `#page-load` loader.

**`scripts/geico-mock.mjs`** (copy the structure of scripts/amwins-mock.mjs:1-40). Playwright loads the fixture, injects `field-key.js` + `pagekit.js` as the panel does, and fills step by step with `buildPlan(record, geico, active)` for a synthetic record. It exits 1 when any of these fails:

- an expected answer;
- an expected "needs you" item;
- an agent correction made with `page.click` or `page.fill` (trusted events) staying protected after a redraw;
- the vehicle and trailer form separation;
- that Next is never clicked on Quote & Coverages or later;
- that nothing is clicked or filled on MVR & CLUE or Payment Information;
- that Discard, Print Quote Proposal and Looks Good are never clicked.

Mock success verifies integration behaviour only. It does not prove live acceptance (new-carrier.md:24-26).

### Commands and CI

- **package.json `scripts`:** `"mock:geico": "node scripts/geico-mock.mjs"`.
- **scripts/ci-local.mjs:71-75:** `run('GEICO mock', ['run', 'mock:geico'])` after the AmWINS mocks. Update the header comment (lines 5-8).
- **.github/workflows/windows-smoke.yml:54-57:** add `- run: npm run mock:geico`.
- **.github/workflows/checks.yml:** no change. It runs only `npm test` and the package, and the AmWINS mock isn't there either.
- **docs/testing.md:**
  - add rows to the table at lines 12-14 (GEICO rules → `test/geico.test.mjs`, `npm run mock:geico`);
  - add the harness list at lines 26-28 and its limits.

### Docs to update in the same PR (CLAUDE.md working rule)

- **README.md:3** ("generic GEICO rater fields"), **:59** ("GEICO: not captured yet; generic label rules only"), **:61** (portal domain now known: `gateway2.geico.com`, `sales.geico.com/quote`), **:71** (usage recording on GEICO quote pages, now `/quote` only).
- **docs/architecture.md:25** ("GEICO currently has generic label rules…").
- **docs/new-carrier.md:30-34**: reference implementation entry for GEICO (one-address SPA, shadow DOM).
- **docs/browser-filling.md**, Execution and Related code: shadow-DOM radios and host state, slot text, `gds-button`, `stepKey` from the progress bar, `stopSteps` / `advance.steps`, the search-type address box.
- **docs/intake-and-rules.md**:
  - the locator table: `Id_<Name>_<n>` stems as data-model names, and `whenAnswer` / `unlessAnswer`;
  - a GEICO standards subsection only for standards TNI actually records.
- **docs/learning.md**: field keys for GEICO change to `ref:<Stem>` with field-key v5.
- **docs/chrome-web-store.md:43, 93**: listing text ("GEICO commercial pages (common fields)"). manifest.json:5 and package.json:7 descriptions only if their wording changes (consistency.test.mjs:91-96 limits the length to 132).
- **src/ai/tni-rules.js**: a GEICO section only if AI assistance is in scope for GEICO's bounded choices. AI availability is not support (new-carrier.md:19).

---

## 7. Click restrictions and button classification

### The guards

- `NEVER_CLICK` (pagekit.js:1006) is checked for every helper action (`findButton`, pagekit.js:1052): `continue|next|start quote|finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out`.
- `NEVER_ADVANCE` (pagekit.js:1027) is checked for the page's move-on button (`findAdvanceButton`, pagekit.js:1035): `finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out|order`. "Save & Continue" / "Save and Continue" is rewritten to "continue" first.
- Advance happens only when nothing is left for the agent, the step isn't excluded, and the step isn't already continued (pagekit.js:1900-1903). The "Check answers before Continue" hold still applies.

### Classification

| Button (where) | Class | Mechanism / required change |
| --- | --- | --- |
| **Next** on Business Class & USDOT, Business & Owner Info, Additional Business Info, and the vehicle form (it saves the unit) | advance candidate (phase 2) | `advance.text '^next$'` with the `advance.steps` allowlist (§3.F). Already blocked for helpers by `next` |
| **Next** on Quote & Coverages (disabled until rated; leads to Final Quote Details) and later | never automatic | Outside `advance.steps`. Final Quote Details was not captured |
| **Save and Continue** (driver form) | advance candidate (phase 2) | Allowed by the rewrite at pagekit.js:1035; blocked for helpers by `save`/`continue` |
| **Looks Good** (vehicle and driver lists: "no more units") | agent's in phase 1; advance only after list verification (§4) | Not in any helper pattern; keep it out of `advance.text` |
| **Add Vehicle or Trailer** / **Add Driver** (`span[data-testid=addIcon]`) | helper (phase 2) | `token: 'addIcon'`, `near`, `scope`, `doneWhen`; needs §3.E |
| **Update Vehicle** / **Update Driver** (edit icons) | agent's | No action defined |
| **Recalculate** (Quote & Coverages; "Run Again" in the capture names) | helper | `{ id: 'recalculate', text: '^recalculate$', waitRequired: true, needsRecalculation: true, verify: 'premium' }`, as at progressive.js:517, with GEICO premium wording (§3.I). Disabled until a coverage changes (host `disabled`) |
| **Print Quote Proposal** (`gds-button href="/PrintQuote?…" target="_blank"`) | agent's | Not configured. It opens a PDF in a new tab, and Progressive's Print/Send is also the agent's |
| **Discard Changes**, **Yes, please discard.**, **No, please don't discard.** | never | Add `discard` to `NEVER_CLICK` and `NEVER_ADVANCE` (§3.E). Neither has it today |
| **Cancel** (unit forms) | never | Already in `NEVER_CLICK`/`NEVER_ADVANCE` (`cancel`) |
| Progress-bar step links (`a[role=button]`, finished steps) | never | They navigate. No GEICO action may use a step name as `text`; add a `findButton` test that `#progressIndicator` links are not hits |
| **MVR & CLUE** step, any button (reports ordering) | never | `stopSteps` (§3.F). Add `order` to `NEVER_CLICK` as belt and braces (it is only in `NEVER_ADVANCE` today) |
| **Payment Information** (submit payment, eSignature) | never | `stopSteps`; `submit` already blocked. Add `e-?sign|signature` to `NEVER_CLICK`/`NEVER_ADVANCE` |
| Gateway: **Start Quote**, **Confirm**, **New Quote**, search | agent's | `start quote` is in `NEVER_CLICK`. No GEICO action on the gateway; outside `autoFillUrl` |
| Tooltip triggers ("View tooltip", "Close tooltip") | ignore | Never a target |

Binding, purchasing, final submission, ordering reports and signing stay the agent's. The words added above only take away clicks; none adds one.

---

## Is the capture enough? (for the reply to the user)

It is enough to start the adapter and the general changes above (§3 A–H), and to map the captured questions. It is not enough to call GEICO supported. That still needs:

- captures of Business & Owner Info, Final Quote Details, MVR & CLUE and Payment Information (to set the stops), and the address suggestion list while open;
- a USDOT-number client, and two vehicles plus a trailer;
- TNI's decisions on which GEICO questions get standards (none are recorded);
- the mock, and one supervised live run proving the radio and date behaviour.
