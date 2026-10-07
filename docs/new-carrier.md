# Adding a carrier or a new supported scenario

Read this when adding a carrier, product, state, or materially different vehicle/coverage flow. A generic label match is not evidence of full support.

## Capture the behavior

Define the initial supported scope: carrier/product, states, operations, vehicle types, driver/vehicle counts, requested coverages, and known exceptions. Reuse existing intake concepts where their meanings agree.

Capture live page layouts and the answers that reveal follow-up questions within the authorized quoting workflow: name a scenario, capture, change one answer, capture again (Capture page layout or Alt+Shift+C), then `npm run captures` for the before/after of each step. Saved HTML/PDFs go in ignored `layouts/`; scrub derived fixtures. A saved page describes one visible state, often without runtime dropdown choices or hidden server-generated branches.

For each discovered question, record its target by a locator the carrier's own code depends on (a data-model name, element id/name, or data-id), scoped to its page or step; the question's text is the fallback where there is none and the check elsewhere. A generated number, a position, or a label alone is never a locator. Record also its meaning, options, source of the answer, entity, applicability, and unresolved decisions. Include known combinations that change the flow. Do not infer all conditional behavior from a union of captured fields.

## Implement the adapter

1. Add a module under [src/carriers](../src/carriers/), register it in [carriers.js](../src/carriers.js), and add required hosts to [manifest.json](../manifest.json).
2. Map confirmed facts and approved scoped defaults. Decide explicitly whether generic fallbacks are suitable; Progressive disables them. See [intake and rules](intake-and-rules.md) if the scenario needs new facts or exceptions.
3. Implement supported controls and helpers with prerequisites. Use `MAIN` only when page-owned widgets require it; enable batching only with evidence that per-answer server waits are unnecessary. Follow [browser filling](browser-filling.md) for execution changes.
4. Give repeated drivers/vehicles distinct targets and verify entity identity after redraws, imports, or lookups. Preserve questions that need an agent's answer.
5. Add the carrier's supported standards to [tni-rules.js](../src/ai/tni-rules.js) when AI assistance is in scope. AI availability does not make the carrier fully supported.

## Validate and expand

Use saved-page behavior mocks where practical, as with AmWINS, or layout replays for server-backed pages, as with Progressive. Include known expected answers, branch triggers, rejection/redraw behavior, manual corrections, missing information, and no-final-submission checks. Add the relevant checks to CI for maintained support.

Test the initial supported scenarios and the known exceptions, including a nearby combination where a rule must not apply. Mock success does not prove live backend acceptance or complete product coverage. Use a supervised pilot for live-only behavior; document unsupported questions instead of generalizing from one successful quote.

After pilot runs, inspect `npm run coverage` and agent reports. Use [learning](learning.md) for candidate discovery and [corrections](corrections.md) for fixes. Expand support when new scenarios are validated; this document does not automatically start another carrier or release milestone.

## Reference implementations

- [progressive.js](../src/carriers/progressive.js), [replay page](../test/replay/index.html), [e2e.mjs](../scripts/e2e.mjs): questions by data-model name or text, and server-backed replay (also renumbered).
- [amwins.js](../src/carriers/amwins.js), [AmWINS fixtures](../test/fixtures/amwins/), [amwins-mock.mjs](../scripts/amwins-mock.mjs): selectors, repeated sections, and saved-page behavior.
- [consistency tests](../test/consistency.test.mjs): host permissions and shared contracts; [testing](testing.md): commands and limits.
