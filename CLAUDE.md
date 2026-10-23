# Project guidance

TNI Rater Autofill is a Chrome MV3 extension that turns an intake PDF into commercial-auto quote answers. The goal is a correct quote reflecting the client's requests, with unresolved decisions visible to the agent. A filled field or accepted carrier value does not prove the answer is correct.

## Working rules

- Keep changes within the requested outcome. Preserve unrelated work; do not turn a correction into a release or another milestone.
- Do not invent client facts or insurance answers. Distinguish missing information, explicit No, and not applicable. A TNI standard is the exception: TNI's own fixed answer may fill a question the intake doesn't answer, and that is not inventing. It counts only as a `standard` rule that [Intake and rules](docs/intake-and-rules.md) records as TNI's; any other answer without intake support is invented. Existing defaults are implementation behavior, not proof they fit every client.
- Preserve agent corrections, answer-retention checks, review blockers, and restrictions on binding, purchasing, submitting, ordering reports, and signing.
- Keep raw carrier HTML/PDFs and client captures in ignored `layouts/`. Scrub committed fixtures; keep client values and credentials out of the repository. Client data reaching TNI's collection server, its logs, or a service the extension calls, such as an AI provider, is not a leak: licensed TNI agents use the extension and TNI runs the server. Credentials stay out of logs.
- Use a task branch (`codex/<topic>` for Codex). Commit, PR, publish, or deploy only within the requested scope; the maintainer merges unless authorized otherwise.
- For code changes, run `npm test` and the affected system's checks below. For documentation-only work, check links, commands, and factual consistency; no release or version bump is needed.
- Type checking is gradual JSDoc on the JavaScript as it runs: no `.ts` files and no build step. A file opts in with `// @ts-check` as its first line (one under `server/`, `scripts/` or `test/` runs on Node and also needs `@types/node`, not installed yet); the shapes passed between parts (carrier config, plan steps, the fill report, usage events) are typedefs in `src/types.js`, comments only and never packaged. Declare a new carrier option, plan step, report or event field there with what it does, add types with comments only (a `/** @type */ (x)` cast adds parentheses to the code), and run `npm run typecheck` ([Testing](docs/testing.md)).
- When a change alters behavior, commands, or data that a document below or the README describes, update that document in the same PR. Say in the PR which documents changed, or why none needed to.
- For AI integration, prompts, decision policies, or evaluation work, keep exact mappings, calculations, and execution in code; the model only resolves bounded semantic choices. Preserve manual review, provider request validation, safe failure, and restrictions on navigation or submission. Controlled mocks verify integration behavior, not live accuracy or calibrated thresholds.
- Keep `AGENTS.md` and `CLAUDE.md` identical when editing shared guidance.

## Read only for the affected work

Start with the relevant source. Read the matching document when the task affects that system; do not load every document or follow every link by default. Documents identify their related code and tests.

| If the action affects… | Read… |
| --- | --- |
| Project goals, shared boundaries, or general architecture | [Architecture](docs/architecture.md) |
| Intake parsing, mappings, defaults, applicability, or state/vehicle/coverage exceptions | [Intake and rules](docs/intake-and-rules.md) |
| Live controls, page changes, helper actions, navigation, or fill verification | [Browser filling](docs/browser-filling.md) |
| Learning from new fields, corrections, exceptions, layouts, or usage events | [Learning](docs/learning.md) |
| The weekly review of agents' runs, or implementing the fixes it approved | Skills [weekly-review](.claude/skills/weekly-review/SKILL.md), then [apply-review-fixes](.claude/skills/apply-review-fixes/SKILL.md) |
| A reported wrong answer, failed fill, or live-run problem | [Corrections](docs/corrections.md) |
| Adding a carrier or expanding supported carrier scenarios | [New carriers](docs/new-carrier.md) |
| AI suggestions, prompts, validation, caching, or approval | [AI assistance](docs/ai-assistant.md) |
| Harnesses, regression coverage, CI, packaging, or release verification | [Testing](docs/testing.md) |
| The quoting history warehouse: its tables, `npm run warehouse`, business-analysis SQL | [Quoting history database](docs/quoting-history-database.md) |
| Collection-server operation or deployment | [Hosting](docs/hosting.md) |
| Chrome Web Store distribution | [Store release](docs/chrome-web-store.md) |

Dated walkthroughs, reports, generated reviews, and captures are evidence for the scenario they describe, not current global instructions. Proposed capabilities in the focused documents remain proposals until implemented and verified.
