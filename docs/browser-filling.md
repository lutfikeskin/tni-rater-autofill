# Browser filling and carrier page changes

Read this when changing control discovery, matching, repeated rows, helper actions, or navigation.

## Execution

[sidepanel.js](../sidepanel/sidepanel.js) builds a plan and injects [pagekit.js](../src/content/pagekit.js) into the quote tab's frames. Progressive runs in `MAIN` world to access ExtJS. Pagekit is a classic script without imports; bump its `__raterKit.version` when changing the injected API.

[field-key.js](../src/content/field-key.js) loads before both pagekit and the recorder, in each script's world. Known question IDs, names, and IDs retain their keys. Anonymous controls use a versioned structural key anchored to their container and row, so repeated carrier fields do not share manual-edit protection or fill history. Labels and current values do not determine those keys.

The fill loop collects controls, assigns rules, applies answers, waits for the page, rereads values, and rescans. Server-backed pages generally fill one answer per round; a carrier with `batch: true` fills a visible round before settling. Enable batching only with evidence about that carrier's behavior.

Exact question IDs/selectors/known options precede label fallback. Repeated question IDs require row disambiguation; the active vehicle index alone does not prove which visible column belongs to it. A label fallback never takes one of several rows of a question, or a question the plan answers per vehicle; ambiguous rows (two vehicles that read the same) stay with the agent. Reacquire controls after redraws and verify the retained value. Retries are bounded; do not bypass acceptance checks to improve completion counts.

## Review and navigation

- Unknown fields are marked; supported fields can still fill. Missing data, failures, differing retained values, confirmations, and blocked helpers contribute to the review report.
- Unfamiliar fields block advance when required or unanswered. Optional prefilled unknowns do not always block; explicit optional/ignored rules and agent dismissals also affect this behavior.
- Agent edits are protected; an edit during filling interrupts the run. Keep that protection across retries and AI responses.
- Trusted native input/change events identify the exact control the agent answered, including a dropdown selection made after a long delay. A prefilled or page-generated value alone does not resolve missing intake data; explicit review notes still require confirmation.
- Helper actions use prerequisites and quote/entity scope. Continuation uses a separate carrier `advance` pattern and the panel setting, with unresolved blockers and pending AI approvals holding it.
- `NEVER_CLICK` and `NEVER_ADVANCE` restrict dangerous actions. Save & Continue is a specific supported continuation exception, not permission for arbitrary Save, Submit, Bind, Buy, Finish, Delete, or report-order actions.
- On one-address applications, the panel checks that the visible step signature changes after continuation. A click is not proof of navigation or of a generated document.

## When the carrier changes

A new question can become unfamiliar; a missing option or rejected answer can become a fill failure. Layout capture and rule-coverage reports provide evidence for review. This does not reliably detect a changed meaning under the same question ID or every changed conditional branch.

Capture the affected scenario and its predecessor answers, classify mapping versus control versus semantic changes, then update a scrubbed fixture and expected outcome. Do not infer applicability merely from a field's presence or absence in one saved page. Use [corrections](corrections.md) for an observed failure and [new carriers](new-carrier.md) for expanded scenario support.

## Related code and checks

- [plan.js](../src/plan.js): resolved field and action steps.
- [pagekit.js](../src/content/pagekit.js): `assign`, `fill`, `answer`, `capture`, action restrictions.
- [field-key.js](../src/content/field-key.js): shared control identities across fills, recording, and redraws.
- [recorder.js](../src/content/recorder.js): page changes and follow-up signals.
- [sidepanel.js](../sidepanel/sidepanel.js): `fillOptions`, `fillPage`, `scheduleAutoFill`, `watchNextStep`.
- [pagekit tests](../test/pagekit.test.mjs), [recorder tests](../test/recorder.test.mjs), [panel safety tests](../test/sidepanel-safety.test.mjs): focused checks; [testing](testing.md) covers real-browser harnesses.

Panel safety tests extract named functions, so preserve their top-level declarations or deliberately update that harness. Pagekit's unit harness uses a minimal DOM/ExtJS implementation; passing it does not establish live portal compatibility.
