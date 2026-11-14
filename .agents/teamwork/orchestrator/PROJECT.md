# Project: Enterprise Browser Automation & Autofill Architectural Blueprint

## Architecture
Transforming the deterministic browser automation and autofill foundation into a general-purpose, modular, extensible enterprise platform:
1. **Core Deterministic Engine & Multi-Target Runtime**:
   - Decoupled `ExecutionTarget` port abstraction for Chrome MV3, standalone Node/Python SDK (Playwright/Puppeteer/CDP), and headless cloud runners.
   - Top-to-bottom cursor with provisional horizons, multi-signal settling (DOM quiet, custom elements, network idle with periodic heartbeat subtraction `isBeat` using composite `(HTTP_METHOD, URL_PATTERN)` keying, non-idempotent exclusion, and adaptive jitter).
   - Human-like synthetic & CDP input dispatch (Bezier curve mouse movement, React 18 event queue bridging, trusted gesture tracking).
   - Real-time user co-pilot protections: composite predicate $\text{IsGuarded}(e, t)$ with recent gesture window ($\le 2000$ms), deep activeElement focus, popup focus containment (`aria-owns`/`aria-controls`), input dirtiness tracking, and `YIELD_WAIT` state machine.
   - 4-layer resilient locator strategy: Semantic attributes -> Native Computed Accessibility Tree (`AXTree`) -> Relative visual anchors -> Structural fallback across open and closed Shadow DOM (including recursive multi-realm iframe traversal).
2. **Dual Authoring Interfaces & Unified IR**:
   - Clean, type-safe Programmatic SDK for TypeScript/Node.js and Python 3.10+ with lifecycle hooks and fluent flow builders.
   - Visual Low-Code UI Studio with live in-page inspector, step recorder, canvas editor, and bi-directional AST/JSON synchronization engine.
   - Unified Intermediate Representation (IR) AST schema (`WorkflowDefinitionIR`) with polymorphic `ValueBindingIR` & `ExpressionBindingIR` supporting JavaScript and Python AST lambdas, trivia preservation, and sandboxed execution.
3. **Interactive Debugging & Observability**:
   - Active CDP execution controller (breakpoints, pause/resume, step-over, step-into, time-travel frame inspection).
   - In-page `<automata-debug-hud>` overlay: field state color-coding, quiet-settle progress indicator, locator resilience badge, agreement/rejection tracking.
   - OpenTelemetry-compliant trace schema (`TelemetrySpan`) with structured URL sanitization (`sanitizeTelemetryUrl`) and attribute PII redaction (`sanitizeTelemetryAttributes`).
   - Automated 4-tier failure diagnostics pipeline with patch generation.
4. **High-Leverage Bounded AI Integration**:
   - 4 specialized AI micro-assistants: Layout Classifier, Field Mapper, Bounded Ambiguity Resolver (with complete Draft-07 input and output schemas for 2-phase evidence grounding), Dynamic Selector Healer (with `entityScope`, strategy enum harmonization, and 4-gate preflight uniqueness protocol).
   - Mathematical justification: why unconstrained agent loops fail vs. bounded semantic evaluation.
   - Exact Draft-07 JSON schemas, composite SHA-256 caching formulas, and multi-tier execution hierarchy.
   - Self-improving learning loop with statistical rule inference thresholds (90% standards, 80% mappings, 20% audit) and ground-truth answer key replay.
5. **Enterprise Governance, Extensibility & Security Ecosystem**:
   - Standardized `module.json` manifest schema, dependency resolution, and versioning.
   - Web Worker plugin isolation with CSP `default-src 'none'`, capability stripping, and deep-frozen `ReadonlyStepView`.
   - Strictly veto-only `onSubmissionValidation` hook (`'allow'` disallowed).
   - Zero-leakage credential protection with `SecureSecretBuffer` triple-pass memory zeroization, 5-category expanded regex lexicon + multilingual dictionaries (ES, FR, DE), positive navigation allowlist, and fail-closed arbitration rule.
   - Tamper-evident cryptographically chained audit logging schema (`EnterpriseAuditEvent`) with `seq`, `previousEventHash`, `eventHash`, `signature`, RFC 8785 JCS, and `verifyAuditChain` algorithm.
   - Multi-environment deployment topologies (Multi-tenant SaaS, Hybrid Enterprise Federation, Sovereign Air-Gapped On-Premise).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Decoupled Core Execution Engine | Pure engine core delegating browser operations via `ExecutionTarget` interface | M1 | explorer_survey_1 |
| F2 | Multi-Signal Settling Engine | DOM quiet, custom element definition, network idle with periodic heartbeat subtraction (`isBeat`) | M1 | explorer_survey_1 |
| F3 | Human-Like Interaction & Co-Pilot Guard | Bezier mouse curves, React 18 event bridging, 2000ms gesture detection, non-destructive user override | M1 | explorer_survey_1 |
| F4 | 4-Layer Resilient Locator Strategy | Semantic attributes, native AXTree resolution, relative visual anchors, and structural fallbacks | M1 | explorer_survey_1 |
| F5 | Shadow DOM Penetration | Traversal across open Shadow DOM and CDP-level pierced closed Shadow DOM | M1 | explorer_survey_1 |
| F6 | Multi-Target Runtime Drivers | TargetMV3, TargetPlaywright, TargetPuppeteer, and TargetCDP implementations | M1 | explorer_survey_1 |
| F7 | Unified Intermediate Representation (IR) | Formal AST schema for workflows, steps, locators, and hooks | M1 | explorer_survey_2 |
| F8 | Programmatic SDK (Node/TypeScript) | Type-safe fluent builder, lifecycle hooks, and runner | M1 | explorer_survey_2 |
| F9 | Programmatic SDK (Python) | Async Pythonic SDK with type hints and Pydantic validation | M1 | explorer_survey_2 |
| F10 | Visual Low-Code UI Studio | In-page recorder, element inspector, workflow canvas, and properties panel | M1 | explorer_survey_2 |
| F11 | Bidirectional Synchronization Engine | 3-way AST merge and comment preservation between visual studio and SDK code | M1 | explorer_survey_2 |
| F12 | Active CDP Debug Controller | Breakpoint management, pause/resume, step-over/into, and time-travel replay | M1 | explorer_survey_2 |
| F13 | In-Page Visual HUD & State Overlays | Interactive overlay with field status badges, quiet wait indicator, and diff tooltips | M1 | explorer_survey_2 |
| F14 | Telemetry & OTel Trace Schemas | High-fidelity OpenTelemetry-compliant trace collection and event logging | M1 | explorer_survey_2 |
| F15 | Automated Failure Root-Cause Diagnostics | 4-tier diagnostic pipeline with automated patch generation | M1 | explorer_survey_2 |
| F16 | Bounded Semantic AI Architecture | Justification of bounded evaluation vs unconstrained LLM agent failure modes | M1 | miner_survey_3 |
| F17 | 4 Specialized AI Micro-Assistants | Layout Classifier, Field Mapper, Ambiguity Resolver (2-phase), Selector Healer | M1 | miner_survey_3 |
| F18 | Micro-Assistant JSON Schemas | Draft-07 JSON schemas for input/output of all 4 AI micro-assistants | M1 | miner_survey_3 |
| F19 | Deterministic Caching & Multi-Tier Execution | SHA-256 composite keys, tier escalation, and fail-closed fallbacks | M1 | miner_survey_3 |
| F20 | Self-Improving Learning Loop | Telemetry ingestion, statistical rule inference thresholds, answer-key replay | M1 | miner_survey_3 |
| F21 | Enterprise Plugin Manifest (`module.json`) | Formal manifest specification, dependency resolution, versioning | M1 | miner_survey_3 |
| F22 | Typed Lifecycle Extension Hooks | Extensibility points (`beforeStepExecute`, `onSubmissionAttempt`, etc.) | M1 | miner_survey_3 |
| F23 | Enterprise Security & Sandboxing | Credential sanitization, memory safety, least-privilege permissions | M1 | miner_survey_3 |
| F24 | Submission-Blocking Guardrails | Non-negotiable anti-bind/purchase enforcement, stop-screen triggers | M1 | miner_survey_3 |
| F25 | Tamper-Evident Audit Logging | Cryptographically chained audit event log schema | M1 | miner_survey_3 |
| F26 | Deployment Topologies & Config Management | Multi-tenant SaaS, Hybrid Enterprise Federation, Air-Gapped On-Premise | M1 | miner_survey_3 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Blueprint & Technical Specification Authoring & Verification | Author and verify docs/enterprise-architecture-blueprint.md with all R1-R5 specifications, diagrams, schemas, and interfaces | Survey | DONE |

---

## Code Layout
- Target deliverable: `docs/enterprise-architecture-blueprint.md` (3,267 lines, 154KB)
- Verification artifacts:
  - Reviewer Reports: `.agents/teamwork/reviewer_r2_1/review_report.md`, `.agents/teamwork/reviewer_r2_2/review_report.md`
  - Challenger Reports: `.agents/teamwork/challenger_r2_1/challenge_report.md`, `.agents/teamwork/challenger_r2_2/challenge_report.md`
  - Forensic Audit Report: `.agents/teamwork/auditor_r2_1/audit_report.md`
  - Gate verdicts: `.agents/teamwork/orchestrator/GATE_STATUS.md`
