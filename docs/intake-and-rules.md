# Intake mappings and conditional rules

Read this when changing the client record, interpreting an intake, or adding an answer/default/exception.

## Current contract

[intake.js](../src/intake.js) reads named PDF form fields. [normalize.js](../src/normalize.js) builds the record and warnings; [schema.js](../src/schema.js) defines editable fields. Claims-box notes are retained, with limited special parsing such as missing ownership and non-trucking liability: a line with NTL, non-trucking (also "non tracking") or bobtail adds a review item quoting it, and `coverage.ntl` stays unset until the agent sets it (a mention such as "no bobtail" is not a request). This is not a general free-text extractor; Luna's claims-box review (see [AI assistance](ai-assistant.md)) only flags lines.

[plan.js](../src/plan.js) resolves values before they enter the page. Rules come from [carriers.js](../src/carriers.js), [carrier modules](../src/carriers/), and [generic rules](../src/rules.js) unless the carrier disables them. Progressive disables broad generic rules.

| Rule responsibility | Current mechanism |
| --- | --- |
| Find a question | `q`, `selector`, `withOption`, or `label` plus `not` |
| Supply an answer | `path` or `value(record, active)` |
| Leave a decision to the agent | `note`; unresolved value becomes a review item |
| Deliberately preserve/skip a field | `ignore`; use only for a known reason |
| Fill but require confirmation | `warn` |
| Address repeated entities | Active list index, `repeat`, selectors, and `scope: 'vehicle'`. With several vehicles, a `scope: 'vehicle'` rule becomes one step per vehicle; each takes the one row naming its vehicle (`vehicleHint`: at least two of year, make and model), and a row's questions without the vehicle in their label belong to the vehicle its labelled questions name. On a page with no vehicle-labelled rows, only the active vehicle's step answers. `scopeIndex` is copied onto steps but `assign()` does not read it. |
| Interpret existing carrier values | `replace`, `trustPage`, `verifyOnly`, `emptyNote` |

Carrier rules precede generic rules, and exact matching precedes label fallback. There is no general most-specific-rule resolver; ordering and conditional functions matter. Read [browser filling](browser-filling.md) only when changing matching or execution behavior.

## Adding or correcting a rule

1. Identify the source, target question, carrier/product/state, and affected entity. A similarly worded question is not enough evidence.
2. Classify the answer as an explicit fact, supported transformation, approved scoped default, known non-applicability, or unresolved decision. Unknown is not No.
3. Prefer a shared fact and carrier-specific translation. Add a narrow condition for a real exception; do not copy an entire flow for each combination.
4. Preserve conflicting or ambiguous notes for review. A tentative coverage mention needs confirmation and an entity target before becoming a selection.
5. Test the intended case and a nearby case where the rule must not apply. Update [the AI rulebook](../src/ai/tni-rules.js) when a standard represented there changes.

## Known gaps to account for

Progressive currently defaults question `28C1` (Exclude driver) to No. AmWINS also has coverage-exclusion defaults. The AI exclusion filter does not protect these deterministic rules. The schema has no dedicated driver-exclusion field; do not describe that case as supported. Non-trucking liability (`coverage.ntl`, set by the agent) is only opened on Progressive ("Add Non-Trucking Liability instead?" on Rates, verified by the link disappearing); what that section asks has not been seen on a live quote, so its questions and the rest of Rates stay with the agent (Rates is never continued for them), and AmWINS has no known NTL option. An NTL mention the agent hasn't answered yet holds the Rates helpers like NTL itself; an explicit No doesn't.

Coverage and ownership are largely shared at policy/operations level. A correctly targeted vehicle row can still receive an inappropriate shared answer. Explicit entity-specific coverage, provenance, applicability/conflict resolution, and final requested-versus-entered reconciliation are design work, not existing guarantees.

For a new missing concept, extend extraction, schema, review UI, rules, and verification together within the authorized scope. If information is absent from the intake, keep a visible agent question rather than inventing an answer. Repeated missing questions may justify a conditional intake supplement; logs alone do not authorize a new default.

## Verification

Use [normalize tests](../test/normalize.test.mjs), [intake regressions](../test/intake-regressions.test.mjs), and [Progressive rule tests](../test/progressive.test.mjs) as applicable. AmWINS expected answers live in [amwins-mock.mjs](../scripts/amwins-mock.mjs). Select the affected browser checks from [testing](testing.md).
