# Reading the signals

What each source usually means, what to check before concluding, and which layer and document own the change. Layers follow the table in `docs/corrections.md`; read the document for a layer only when a finding lands there.

| Signal (where) | Usually means | Check before concluding | Layer · document |
| --- | --- | --- | --- |
| Problem report (`problem_report`; signals and review) | The agent's own account; several reports often share one cause | The build that logged it, the fill around it (signals), fixes on `main` since its commit | Any · `docs/corrections.md` |
| Autofill corrected (`field_change` by agent, `vsAutofill: different`; review, learner "Rules agents keep correcting") | Wrong mapping, translation, entity, or a client's legitimate exception | Same correction across different intakes (learner support counts PDFs)? One client's request is not a rule | Mapping or scoped rule · `docs/intake-and-rules.md` |
| Autofill put back (`vsAutofill: same` from another value; review) | The carrier overwrote our answer (answer retention), or the agent's own edit undone | Which page and helper ran just before | Browser execution · `docs/browser-filling.md` |
| Failed: `no option matches "…"` (signals) | The carrier changed a list, or a rule's value isn't offered for this state/product | The question's options in recent layouts (`npm run layouts`, `captures/<carrier>/generated/`) | Carrier change or rule value · `docs/browser-filling.md`, `docs/intake-and-rules.md` |
| Failed: the page did not keep the answer, marks it invalid (signals) | Format (ZIP+4, phone, date), a redraw, or a validation rule | The intake's value shape and what the agent typed (`matchesIntake`) | Normalizer or execution |
| `unfamiliar` (signals; review coverage) | No rule claims the question: a new or reworded question, or one deliberately not mapped | New this period (review "New questions without a rule")? Same text, other name (`renamed`, `reworded`)? | Rule (needs an answer source) or keep with the agent with a note |
| `leftRequired` (signals) | Required and unanswered: often a fact or attestation that must stay the agent's | The rule's `source` (`fact`, `attestation` are intended) | Drop if intended; else rule |
| `noData` (signals) | The intake doesn't hold the answer | Is it a client fact (stays the agent's) or an intake read gap (the PDF had it)? | Intake reading, or an intake form change for the maintainer |
| Blocker `button: X (waiting for Y)` (signals) | A helper's prerequisite never came, so the flow stalls | Did the agent click it by hand (problem reports)? Which page came before? | Browser execution (helpers) |
| `pageChanged`, `reworded`, `renamed` (signals) | The carrier changed the page | A capture of the page now; the layouts before and after | Capture, then rule locator (`field`) and fixtures |
| New questions, unseen answers, new follow-ups (review: new questions, "When questions show") | The carrier added a question or a branch | Its options and when it shows | Capture; Decide for its answer |
| AI errors by build (signals) | A request or context problem in that build | Do newer builds still show it? | AI · `docs/ai-assistant.md` |
| AI dismissed or rejected (review per question) | A wrong suggestion, or a question that needs a rule | The evidence it cited; the question's `source` | AI rulebook/prompt, or a rule after a Decide |
| AI accepted often (review per question) | A candidate for a plain rule | Only with a TNI standard behind it; acceptance is not correctness | Decide |
| Intake warning codes, fields corrected in the panel (review usage summary) | The reader or normalizer misreads a form shape | The raw form value shape | Intake reading · `docs/intake-and-rules.md` |
| Learner: standard, by state, page answer | Agents answer alike | Is it the client's decision (coverage, limits, payment)? | Decide |
| Learner: mapping | Agents type the same intake field | Does the field mean the same thing? | Fix when it does |
| Benchmark: would change kept answers, lost answers (if run) | A rule change since then alters answers agents accepted | Intended (a decision since) or a regression? | Rule · `docs/learning.md` |
| Fields the server dropped (signals) | The usage server is older than the extension | `node scripts/server-check.mjs`; deploy the server before the extension that sends new fields | Infrastructure · `docs/hosting.md` |
| `fill_error` stale, answers on another client's quote | S1 safety | The tab, intake and revision in the fill context | Browser execution / panel |

## Pitfalls

- **Testing versus agents' work.** `channel` `unpacked` or `source` is a development copy; `store` is what agents install. Before launch the maintainer also runs live quotes on development copies. Test runs are recognized by intake, not by channel: intakes marked as a test (`test: true` on `intake_loaded`), fixture intakes (`test/fixtures/`, `dist/synthetic-intakes/pdfs/`) and the fingerprints in `reviews/test-intakes.txt` are left out of the signals report, the review, the ledger's weekly numbers and the answer key's sheet and score. An intake quoted many times in a short time is probably a test: ask.
- **Old events lack fields.** `view`, `key` (0.9.9), `channel`/`commit`, `run`/`rules`/`settings`, `step` (0.9.6), element ids in AmWINS layouts (0.8.1). `docs/learning.md` says which version added what. A missing field is "unknown", not "absent".
- **Question ids are not identities.** Progressive renumbered every question on 2026-10-07. Identify a question by its data-model name (`ref:`) or its text on its page, as the reports do. GEICO renumbers its element names (`Id_<Name>_<n>`) on every redraw: from field-key version 5 its keys are `ref:<Name>` (coverage lists on Quote & Coverages `cov:<caption>` or `cov:<coverage>#<n>`), but the learner and the review still group its questions by page, step and label, as AmWINS'.
- **`[client]` and masked numbers** are redaction placeholders, not page text. "Co[client]ges" is "Coverages" with a client word redacted.
- **One-address applications** (AmWINS, GEICO) name steps, not pages: `page › step`. A step heading can carry counts ("My Incomplete Submissions 3"). GEICO's step is its progress bar's, and none is named while the page title disagrees.
- **GEICO quote outcomes.** A GEICO quote counts as done once it reaches a step that is the agent's (Final Quote Details, MVR & CLUE, Payment Information: a `fill_run` with blocker `stop: <step>`, which on Progressive's stop page means declined). Reaching Final Quote Details means the quote was rated; whether the agent then finished it with GEICO isn't in the log.
- **Repeated fills.** Agents re-run Fill on a page; raw event counts overstate. Use per-quote counts.
- **Intended agent questions.** Facts and attestations (`source: 'fact'`, `'attestation'`, `clientFact` without an answer) are left to the agent on purpose. "More agent work" there is a Decide item at most (an intake form question, a TNI standard), never a silent default.
