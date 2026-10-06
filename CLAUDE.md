# Project guidance

TNI Rater Autofill is a Chrome MV3 extension that turns an intake PDF into commercial-auto quote answers. The goal is a correct quote reflecting the client's requests, with unresolved decisions visible to the agent. A filled field or accepted carrier value does not prove the answer is correct.

## Working rules

- Keep changes within the requested outcome. Preserve unrelated work; do not turn a correction into a release or another milestone.
- Do not invent client facts or insurance answers. Distinguish missing information, explicit No, and not applicable. Existing defaults are implementation behavior, not proof they fit every client.
- Preserve agent corrections, answer-retention checks, review blockers, and restrictions on binding, purchasing, submitting, ordering reports, and signing.
- Keep raw carrier HTML/PDFs and client captures in ignored `layouts/`. Scrub committed fixtures; keep typed client values and credentials out of logs and commits.
- Use a task branch (`codex/<topic>` for Codex). Commit, PR, publish, or deploy only within the requested scope; the maintainer merges unless authorized otherwise.
- For code changes, run `npm test` and the affected system's checks below. For documentation-only work, check links, commands, and factual consistency; no release or version bump is needed.
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
| A reported wrong answer, failed fill, or live-run problem | [Corrections](docs/corrections.md) |
| Adding a carrier or expanding supported carrier scenarios | [New carriers](docs/new-carrier.md) |
| AI suggestions, prompts, validation, caching, or approval | [AI assistance](docs/ai-assistant.md) |
| Harnesses, regression coverage, CI, packaging, or release verification | [Testing](docs/testing.md) |
| Collection-server operation or deployment | [Hosting](docs/hosting.md) |
| Chrome Web Store distribution | [Store release](docs/chrome-web-store.md) |

Dated walkthroughs, reports, generated reviews, and captures are evidence for the scenario they describe, not current global instructions. Proposed capabilities in the focused documents remain proposals until implemented and verified.
