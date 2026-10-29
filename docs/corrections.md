# Correcting a reported quote problem

Read this when an agent reports a wrong answer, missing field, stalled page, or unexpected AI selection.

## Establish the cause

Start with the supplied report and affected scenario. If the task needs current central evidence, run `npm run pull`, then `npm run review`; do not download logs for unrelated edits. Locate the session, carrier, page, extension version, active entity, and preceding answers where available.

Useful events are `problem_report`, `fill_run` (blockers and advancement), `fill_field` (result, reason, timing), `field_change` (agent versus page), `page_layout` (reason `recalculate`: what GEICO showed after the fill's Recalculate, see [Browser filling](browser-filling.md)), and `ai_suggest`/`ai_decision`. A layout has structure, not the client's original typed answers. Do not claim it proves a client fact or the cause of a server rejection.

| Cause | Change the relevant layer |
| --- | --- |
| Intake was read or normalized incorrectly | Reader/normalizer; schema and review UI if needed |
| Correct fact targets the wrong question/entity | Carrier mapping or row assignment |
| State, vehicle, driver, or coverage exception | Scoped rule and supporting structured facts |
| Carrier redraw, rejected value, new control, stalled helper | Browser execution and carrier interaction |
| AI suggests an unsupported answer or applies stale context | Request/response checks, context cache, approval flow |
| Client fact or TNI decision is genuinely missing | Visible agent question; obtain evidence before encoding an answer |

## Implement and verify

1. Restate the failure as expected versus actual behavior for this scenario. Separate a one-client correction from a reusable rule.
2. Reproduce with the smallest scrubbed fixture or synthetic record that demonstrates it. Keep raw pages and client PDFs in ignored `layouts/`.
3. Fix the responsible layer. Preserve manual edits, review stops, entity scope, and retained-value verification. Update the AI rulebook only if a represented standard changes.
4. Test the failure and a nearby counterexample when the correction changes applicability. Select the affected harness from [testing](testing.md); do not bless a failing result by refreshing the baseline blindly.
5. Report what is fixed, what was exercised, and any remaining live-only uncertainty. Package, publish, deploy, or merge only when that is part of the requested outcome.

If a supposed general fix depends on an unknown insurance answer, complete independent diagnosis and ask for the missing fact or decision. Repeated selections, old walkthrough defaults, and AI confidence are not authorization to invent it.

## Related code and documentation

- [review.mjs](../scripts/review.mjs), [events.mjs](../scripts/lib/events.mjs): investigation.
- [normalize.js](../src/normalize.js), [carrier modules](../src/carriers/), [pagekit.js](../src/content/pagekit.js), [the side panel](../sidepanel/panel/): likely correction sites.
- Use [intake and rules](intake-and-rules.md) for answer semantics, [browser filling](browser-filling.md) for execution, or [AI assistance](ai-assistant.md) for AI behavior, according to the cause.
- Use [learning](learning.md) only when changing how corrections become future candidates or how their evidence is recorded.
