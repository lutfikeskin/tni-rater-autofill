# Decisions API replacement evaluation

Evaluated 2026-10-07 against commit `9064b811ff84ef2768fe5995b49fdc55893a68dc`, in branch `codex/decisions-api-evaluation`.

Status: feasibility and implementation assessment only. No runtime replacement or live benchmark was performed. This document proposes work; it does not change the current assistant contract.

## Recommendation

Use the Decisions API for bounded semantic option selection and note classification, alongside the existing deterministic fill engine. This is the best architectural fit for fast feedback with no generated explanations. Preserve source attribution, abstention, verification, manual edits and approval holds.

A direct endpoint substitution does **not** satisfy the requested outcome. The response contract changes, citations need explicit representation, and the current assistant does not audit every already-filled answer. Near-instant latency and high correction precision remain hypotheses until measured on expert-reviewed quoting cases.

## Verified provider facts

The [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions) currently describes:

- Public beta, with only `gpt-6-luna`, at `POST /v1/decisions`. This replaces the Responses execution path, not the underlying model.
- Approximately 10x faster answers than Responses; no application-specific latency guarantee.
- `choice` for fixed categories, `predicate` for condition probabilities, and `score` for ordered rubrics.
- Independent questions can share a request; questions depending on previous results require another request.
- Choice probabilities and a separate confidence value. Thresholds should be chosen using labeled application examples.
- Input-only billing at $0.10 per million tokens, without cache-read, cache-write or output charges; regional and long-context adjustments apply.

The [create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) defines named answers in question order, typed string/boolean choices, per-question refusals, and usage counters. It accepts text and inline images, not PDF/file inputs or tools. It provides no custom JSON-output schema, generated source-ID array or explanation field. The documented request has no `store`, `reasoning`, `text`, `max_output_tokens`, or streaming parameter; do not forward the Responses body.

The [data-controls documentation](https://developers.openai.com/api/docs/guides/your-data) lists default abuse-monitoring retention of up to 30 days and ZDR eligibility subject to account configuration and limitations, including prompt-cache and image exceptions. Removing `store:false` is a schema change, not permission to claim zero retention. Existing partial intake filtering remains partial filtering.

Account access, endpoint-specific practical limits and real browser/network behavior have not been tested.

## What the project actually does

| Current behavior | Code evidence | Replacement consequence |
| --- | --- | --- |
| Fixed Luna provider and model | [providers.js](../src/ai/providers.js), lines 1–16 | Introduce an endpoint/policy identity even though the model name stays the same. |
| Option, up to four source IDs, explanation, missing/conflict notes | [luna.js](../src/ai/luna.js), lines 28–49 and 79–107 | Losing prose is acceptable; losing evidence or abstention is not. |
| Second call checks the proposed option against cited sources and the whole scoped intake | [luna.js](../src/ai/luna.js), lines 109–189 | Use a dependent verification request; same-request judgments cannot verify a choice not yet returned. |
| Active-entity intake facts and carrier-scoped rules | [common.js](../src/ai/common.js), lines 69–110 | Reuse scope and source construction. Keep exact calculations in code. |
| Review only failed, unfamiliar, missing-data and required unanswered items | [common.js](../src/ai/common.js), lines 45–67 | A separate comparison against all eligible visible choices is needed for page-wide correction. |
| Assistant runs after filling; agent-edited and AI-settled fields are excluded | [sidepanel.js](../sidepanel/sidepanel.js), lines 1552 and 1882–1973 | Faster inference alone does not create feedback on every page/intake change. |
| Two booleans per claims fragment, at most 20 fragments; warnings only | [luna.js](../src/ai/luna.js), lines 251–335 | Two predicates per fragment preserve the classification capability; code already writes warnings. |
| Snapshot checks, retained-value verification and durable review holds | [sidepanel.js](../sidepanel/sidepanel.js), lines 2014–2239; [pagekit.js](../src/content/pagekit.js), lines 1351–1414 | Retain these mechanisms independently of the inference endpoint. |

A current batch with at least one non-leave proposal needs two sequential calls; an all-leave batch needs one. Batches are also sequential. Requests allow at most 12 fields and 48,000 serialized characters, with 4,096/2,048 output-token budgets. Each HTTP call has a 45-second timeout and bounded retries. These are caps, not measured latency. The panel generally renders suggestions after the complete `suggest()` operation.

The never-list blocks reports, exclusions, authorizations/signatures, payment details and NTL questions, among other restrictions. Numeric/date/limit/identity semantics are manual-only for automatic application, although eligible visible-choice questions may still receive suggestions that the agent can explicitly accept. Text entry is already outside the AI application path.

## Capability coverage

| Needed capability | Decisions design | Assessment |
| --- | --- | --- |
| Choose a visible radio/select/checkbox option | Named `choice`, using opaque option IDs and explicit leave outcomes | Strong fit. Validate against the original visible options before application. |
| Distinguish missing, explicit No, conflicts and no matching option | Predeclared leave/reason categories plus verification | Representable without prose; semantic accuracy needs evaluation. |
| Cite intake facts or rules | Code-mapped evidence candidates, or separate source-selection questions | Requires new design. Native confidence is not evidence. |
| Verify the exact choice and its cited evidence | Separate `predicate` after option and sources are known | Strong structural fit; another same-model judgment is still not independent proof. |
| Flag NTL and coverage-change requests in claims notes | Two independent predicates for each pre-split fragment | Strong fit. Preserve redaction, negative statements, duplicate suppression, truncation and failure warnings. |
| Explain recommendations | Fixed templates showing the option, source paths/rules and review reason | No generated narrative, as requested. |
| Cache, protect edits, apply and confirm retention, hold Continue | Existing code with a new policy/cache identity | Code-owned capabilities; preserve them. |
| Find an incorrect answer that already looks filled | New visible-answer audit against the resolved plan/intake | Missing today; endpoint migration alone will not add it. |
| Final quote agrees with all client requests | Wider reconciliation, extraction and entity-provenance work | Not guaranteed by either endpoint. Keep unsupported requests visible for manual review. |

Use `choice` for carrier options, not `score`. Carrier labels are categories; averaging ordinal positions would not identify a valid answer. Use predicates for evidence support and claims flags. Do not ask the model to invent a confidence percentage.

## Evidence-preserving implementation

Reuse the provider interface (`suggest`, `reviewNotes`) and the existing application/approval code. Implement a dedicated Decisions request builder, parser and policy version. Do not reuse the Responses envelope parser or treat old cached `verified:true` entries as verified Decisions results.

There are two viable paths:

1. **Two requests for fields with code-defined evidence candidates.** Code constructs bounded candidates, each mapping an opaque choice ID to a visible option and an explicit bundle of source IDs. Include leave/reason candidates. Decisions selects a candidate; code resolves the tuple; a separate predicate checks the exact answer, every cited source, missing facts and conflicts against the full scoped intake. Candidate construction must be justified by field metadata/rules. The repository currently creates a shared source pool, not a complete field-to-evidence registry.
2. **Generic fallback preserving dynamic citations: three requests.** Select the visible option; select up to four sources using named fixed-choice questions over the supplied source IDs and an explicit no-source/leave choice; then verify the proposed answer and exact selected citations against the full scoped intake. Validate, deduplicate and cap source IDs at four. Preserve missing/conflict abstention. Missing or irrelevant citations fail closed. Source-slot questions can be independent once the proposed answer is supplied, but their combined adequacy is established only by the final check.

Use the generic three-request path as the initial parity baseline; optimize validated mapped fields to two requests only after measuring correctness and latency. The second path most directly preserves the current generic citation capability. The first is a possible optimization for mapped fields, not a reason to silently drop options, facts or multi-source cases. Avoid enumerating the power set of sources. Preflight question/choice cardinalities and serialized size against verified endpoint limits; split bounded groups or leave the field manual rather than truncate evidence. Neither path has been benchmarked.

For claims predicates, define upper/lower probability thresholds using held-out labels: confidently positive becomes a flag, confidently negative becomes false, and the uncertain band becomes a manual Check intake warning. A refusal or malformed result also requires manual review. Do not silently translate uncertainty to false. This adapter is necessary because the current notes contract expects booleans.

Start the pilot with suggestions and agent acceptance. Retain separately opted-in automatic application only for supported, applicable, changed visible choices outside the manual-only and never lists, after validation and the existing approval controls. Thresholds must come from held-out data before expanding automatic eligibility.

Verification must reject unrelated evidence, unsupported defaults, absent facts and conflicting notes even when the option probability is high. Read all applicable bounded context; retrieval must not hide a contradictory note. If a single field exceeds the request budget, leave it manual.

## Correcting already-filled answers

Add a read-only audit of eligible visible choices after the page settles. Compare current selections with intake-backed expected answers and applicable carrier rules. Use deterministic comparison wherever the mapping is exact; use Decisions only for remaining bounded semantic alternatives.

A prefilled choice is currently often placed in `report.kept` ([pagekit.js](../src/content/pagekit.js), lines 1065–1075); the assistant collector ignores that category. Successfully filled choices are also not a general audit input. This explains why changing the API cannot by itself catch all wrong selections.

The audit should:

- Identify carrier, page, frame/document and active entity before assessing a field.
- Treat page defaults and previous AI selections as context, not client evidence.
- Show disagreements on manually edited fields without overwriting the agent's answer.
- Re-audit after relevant intake, option, entity or page changes, with debounce and stale-response cancellation.
- Keep numeric comparisons, dates, limits and identifiers in code or manual review.
- Apply through `answer()`, recheck snapshots, verify retained values and preserve pending holds before Continue.

For example, the synthetic evaluation's refrigeration-breakdown case supplies explicit `coverage.reeferBreakdown:false` while the page says Yes: No is a supported candidate. Its missing hazardous-placard fact supports neither Yes nor No; a prefilled No must not become evidence. These are illustrative fixture expectations, not an expert-reviewed insurance answer key.

Known shared coverage/entity gaps and limited free-text extraction remain documented in [intake and rules](intake-and-rules.md). Decisions must not be described as fixing those implicitly.

## Measuring speed and confidence

The existing [evaluation runner](../scripts/ai-eval.mjs) supports only Luna Responses live runs, with no endpoint selector. It scores option/basis/evidence agreement and reports mean/median timing. It does not measure calibration, tail latency, page correction recall or claims-note classification. The corpus contains five synthetic cases, seven fields and zero expert-reviewed cases; every case uses only one driver and one vehicle.

For a useful comparison:

1. Obtain expert-reviewed labels for the correct visible option, supporting sources and required abstention. Split calibration and test data by quote/scenario so near-duplicates do not leak.
2. Run Responses and Decisions repeatedly on identical sanitized contexts, randomizing paired run order to reduce load/time bias. Include missing-vs-No, contradictory notes, unsupported defaults, paraphrases, no matching option, wrong prefilled/filled answers, active-entity switches, dependent fields, manual edits, stale responses and restricted actions. Evaluate claims-note false negatives separately.
3. Measure option-and-evidence correctness among proposed corrections, correct abstention, missed wrong answers, source validity, coverage and error rates. Acceptance rate and carrier retention are not correctness.
4. Evaluate raw option probability, its gap to alternatives, predicate support and the separate confidence field on held-out labels. Do not assume a formula for confidence or multiply same-model scores as independent evidence. Choose thresholds per validated scenario where data permits; abstain elsewhere.
5. Measure cold and local-cache-hit p50/p95/p99, requests per page, retries and cost. Time page-settled to displayed suggestion, then verified suggestion, then retained correction. Separately time page arrival/fill/settlement: carrier waits can dominate.
6. Test multiple plausible batch sizes and two-/three-stage provenance paths. Render verified groups promptly if safe; applying one group changes the page snapshot and must invalidate or revalidate other pending groups.

A proposed speed target for the pilot is p95 under one second to initial feedback and under two seconds to a verified recommendation after page settlement. Initial feedback must be labeled as checking and cannot enable application before evidence verification finishes. These are product targets, not provider promises or measured results. Measure the generic citation path against the same target.

An illustrative precision gate is a one-sided 95% lower bound of at least 99.5% among eligible corrections, plus no observed violations of hard restrictions in the test suite. About 600 independent, accepted, expert-labeled corrections with zero errors are needed just for that aggregate bound; correlated cases and per-scenario claims require more evidence. This example is a proposed gate, not a calibrated threshold or an insurance safety standard. Track recall and abstention so passing by declining every correction is impossible.

## Scoped implementation surfaces and verification

| Surface | Necessary change if implementation proceeds |
| --- | --- |
| `src/ai/` provider and common code | Decisions transport/validation, evidence strategy, note predicates, stale checks and conservative request bounds; keep shared restrictions. |
| `sidepanel/sidepanel.js` | Endpoint/policy cache separation, fixed review messages, visible-answer audit and scheduling; preserve durable holds and manual edits. |
| `src/content/pagekit.js` | Expose any missing audit metadata; retain snapshot, frame identity and answer-retention checks. |
| `scripts/ai-eval.mjs` and evaluation cases | Endpoint comparison, expert review status, confidence/calibration metrics, tail latency and correction/claims coverage. |
| Unit tests and controlled extension mock | Malformed/duplicate/missing answers, refusals, unknown options/sources, invalid probabilities, missing/conflicting evidence, stale results, no credential leakage, protected edits and reload-safe approval holds. |
| AI/browser/intake/testing documentation | Describe the final implemented behavior and measured limits. Existing `api.openai.com` host permission already covers the new endpoint. |

For runtime changes, project-required verification is `npm test`, affected AI/panel/pagekit checks, packaging and the controlled assistant browser workflow; update the current Responses-specific mock rather than claiming it validates Decisions unchanged. Run packaged-extension checks when orchestration changes. Mocks establish integration behavior only. Live comparison needs explicit credential handling and account access.

This evaluation changes documentation only. It neither implements a replacement nor claims live accuracy, cost savings or near-instant performance.
