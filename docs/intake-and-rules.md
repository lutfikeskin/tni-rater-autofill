# Intake mappings and conditional rules

Read this when changing the client record, interpreting an intake, or adding an answer/default/exception.

## Current contract

[intake.js](../src/intake.js) reads named PDF form fields. [normalize.js](../src/normalize.js) builds the record and warnings; [schema.js](../src/schema.js) defines editable fields. Claims-box notes are retained, with limited special parsing such as missing ownership and non-trucking liability: a line with NTL, non-trucking (also "non tracking") or bobtail adds a review item quoting it, and `coverage.ntl` stays unset until the agent sets it (a mention such as "no bobtail" is not a request). An intake listing a semi trailer (Dry Van, Reefer, Flatbed, Tanker, Lowboy, Step Deck) with no Semi Truck or Pickup Truck to pull it gets a check warning on the vehicle types. This is not a general free-text extractor; Luna's claims-box review (see [AI assistance](ai-assistant.md)) only flags lines.

[plan.js](../src/plan.js) resolves values before they enter the page. Rules come from [carriers.js](../src/carriers.js), [carrier modules](../src/carriers/), and [generic rules](../src/rules.js) unless the carrier disables them. Progressive disables broad generic rules.

| Rule responsibility | Current mechanism |
| --- | --- |
| Find a question | `field` (data-model name) or `ask`/`label` on the rule's `page`, `selector`, `withOption`, or `label` plus `not`; `pageOnly` keeps a data-model name to the rule's pages and `notPages` keeps a rule off pages (a trailer's questions carry the vehicle's names) |
| Supply an answer | `path` or `value(record, active)`, with its `source` (below) |
| Leave a decision to the agent | `note`; unresolved value becomes a review item |
| Deliberately preserve/skip a field | `ignore`; use only for a known reason |
| Fill but require confirmation | `warn` |
| Address repeated entities | Active list index, `repeat`, selectors, and `scope: 'vehicle'`. With several vehicles, a `scope: 'vehicle'` rule becomes one step per vehicle; each takes the one row naming its vehicle (`vehicleHint`: at least two of year, make and model), and a row's questions without the vehicle in their label belong to the vehicle its labelled questions name. On a page with no vehicle-labelled rows, only the active vehicle's step answers. A vehicle with a trailer on the quote also finds its row by name, and a `scope: 'trailer'` rule (a trailer's Rates row, "2019 Wilson") is one step per trailer, the same way. `scopeIndex` is copied onto steps but `assign()` does not read it. |
| Interpret existing carrier values | `replace`, `trustPage`, `verifyOnly`, `emptyNote` |

### Answer provenance (`source`)

Every carrier rule with a `value` declares where its answer comes from ([test/provenance.test.mjs](../test/provenance.test.mjs) enforces it); a rule with only a `path` is `intake`. `plan.js fieldSteps` acts on it:

| `source` | Meaning | Step |
| --- | --- | --- |
| `intake` | A record path, no computed value | Filled from the intake |
| `derived` | Computed from intake facts, with the evidence in the rule | Filled; may carry its own `warn` or `note` (a missing fact gives a note, never a guess) |
| `standard` | A TNI coverage or workflow standard | Filled and marked `standard: true`; the panel's fill report tags it "standard" |
| `fact` | A client fact the intake doesn't supply (gender, year licensed, continuous coverage, other business coverages, loss runs, …) | Never filled: `value: null` and the rule's `note` (else "<name> isn't on the intake: answer it yourself") |
| `attestation` | Something the agent must assert (the USDOT number belongs to the business, it was obtained within 60 days) | Never filled, as `fact` |

Review mode: a carrier lists the business classes its rules were written for (`supportedClasses`; Progressive and AmWINS: expediter, freight hauler, general freight, the last also matched on what they haul). `supportedClass(record, carrier)` is false for any other class and for a missing one; then every `standard` step gets the `warn` "Review mode: the business class "…" isn't validated for <carrier>; confirm this standard answer.", so it is filled but becomes a check item that holds Continue, and the panel shows a review-mode banner above the fill button. Intake and derived answers are unaffected.

The 2026-10-09 classification turned several earlier TNI defaults into notes: the USDOT belongs / within 60 days answers, continuous coverage, other business coverages, the NJ vehicle registrant, blank trailer ownership as owned, blank vehicle ownership as no loan/lease, "will not have a USDOT number" with no 60-day answer, and on AmWINS gender, year licensed (birth year + 17), year established (this year), current-carrier tenure, loss runs and marital status (Married). Each is now the agent's when the intake doesn't answer it.

Carrier rules precede generic rules, and exact matching precedes label fallback. There is no general most-specific-rule resolver; ordering and conditional functions matter. A label fallback is skipped once a carrier rule fills the same intake path, so a carrier rule with a computed value (no path) leaves its path to the generic rule on rows it doesn't answer; a carrier's `rowSections` (AmWINS: drivers, vehicles, vehicle coverages) keeps generic rules out of those sections, and a row the intake doesn't describe stays the agent's. Read [browser filling](browser-filling.md) only when changing matching or execution behavior.

## Adding or correcting a rule

1. Identify the source, target question, carrier/product/state, and affected entity. A similarly worded question is not enough evidence.
2. Classify the answer as an explicit fact, supported transformation, approved scoped default, known non-applicability, or unresolved decision. Unknown is not No.
3. Prefer a shared fact and carrier-specific translation. Add a narrow condition for a real exception; do not copy an entire flow for each combination.
4. Preserve conflicting or ambiguous notes for review. A tentative coverage mention needs confirmation and an entity target before becoming a selection.
5. Test the intended case and a nearby case where the rule must not apply. Update [the AI rulebook](../src/ai/tni-rules.js) when a standard represented there changes.

## Known gaps to account for

Progressive answers question `28C1` (Exclude driver) No for a driver listed on the intake (`derived`); excluding a driver is the agent's decision. AmWINS also has coverage-exclusion defaults. The AI exclusion filter does not protect these deterministic rules. The schema has no dedicated driver-exclusion field; do not describe that case as supported. Non-trucking liability (`coverage.ntl`, set by the agent) is only opened on Progressive ("Add Non-Trucking Liability instead?" on Rates, verified by the link disappearing); what that section asks has not been seen on a live quote, so its questions and the rest of Rates stay with the agent (Rates is never continued for them), and AmWINS has no known NTL option. An NTL mention the agent hasn't answered yet holds the Rates helpers like NTL itself; an explicit No doesn't.

Progressive asks for a Vehicle Type on Add Vehicle only when the VIN lookup doesn't match the tile picked from the intake's type (an intake "Van" whose VIN is a truck tractor); it is left to the agent with a note naming the intake's type. Progressive trailers (TNI, 2026-10-07): after the vehicles, Add Trailer, the trailer's tile (Flatbed, Dry Van and Reefer have one; other types are the agent's pick), then the intake trailer's VIN, year, make and value, the vehicle's distance, loan/lease from the intake's trailer ownership (none given, or an answer other than owned, financed or leased, such as Rented: the agent's), comprehensive/collision Yes and no equipment (the intake's trailer equipment value when it gives one); on Rates, its row gets $1,000 comprehensive and collision and no rental or fire/theft. Personal injury protection shares one data-model name across states: Florida gets TNI's standard, other states keep Progressive's choice (an empty one is the agent's). On the Print page Email and Fax are unticked, so the agent's Print/Send only opens the PDF. AmWINS has no trailer section (TNI, 2026-10-08): each intake trailer is a line of the Underwriting step's disclosure text, after the radius line, as `Trailer - 2015 Great Dane Dry Van - VIN … - $25K` (year, make and type, VIN, value; a part the intake lacks, or a year or value it couldn't read, is left out). A trailer is never added as a vehicle row or put in the VIN lookup list.

Coverage and ownership are largely shared at policy/operations level. A correctly targeted vehicle row can still receive an inappropriate shared answer. Explicit entity-specific coverage, provenance, applicability/conflict resolution, and final requested-versus-entered reconciliation are design work, not existing guarantees.

For a new missing concept, extend extraction, schema, review UI, rules, and verification together within the authorized scope. If information is absent from the intake, keep a visible agent question rather than inventing an answer. Repeated missing questions may justify a conditional intake supplement; logs alone do not authorize a new default.

## Verification

Use [normalize tests](../test/normalize.test.mjs), [intake regressions](../test/intake-regressions.test.mjs), and [Progressive rule tests](../test/progressive.test.mjs) as applicable. AmWINS expected answers live in [amwins-mock.mjs](../scripts/amwins-mock.mjs). Select the affected browser checks from [testing](testing.md).
