# Handoff Report: Dual Authoring & Interactive Debugging Survey (R2 & R3)

**Agent:** `explorer_survey_2`  
**Date:** 2026-11-04T18:28:00Z  
**Target Milestone:** Requirements R2 & R3 Architecture Survey & Technical Specification  
**Handoff Type:** Hard (Task Complete)  

---

## 1. Observation

1. **Current Recording & Observability Implementation:**
   - In `docs/developer-recording.md` (lines 35–45, 66–90), recording is specified as an offline passive observer writing `events.jsonl`, `recording.json`, raw DOM snapshots, and screenshots into a zip file in Downloads. Line 23 states: *"A recorder that only watches. It never clicks, types, scrolls or navigates, and nothing in it can."* Furthermore, Decision Record DR-2 (lines 267–270) explicitly avoids `chrome.debugger` to avoid extension warnings in production builds.
   - In `src/content/trace.js` (lines 48–53, 225–233, 284–296), trace events are captured in an isolated world via `MutationObserver` (`BURST_QUIET_MS = 100`) and `PerformanceObserver` (`resource` entries for fetch/XHR). Line 283 notes: *"A request still running isn't seen."*
   - In `sidepanel/recording.js` (lines 12–25, 108–120), chunks are buffered in the extension's Origin Private File System (`navigator.storage.getDirectory()`) every 200 events or 5 seconds, and exported via `fflate.zipSync`.
   - In `scripts/lib/recording.mjs` (lines 176–216), offline reports compute wait slack (`e.slack = waitEnd - activity.reduce(...)`) and step timelines.
   - In `src/kit/marks.js` (lines 9–12, 37–49), target element overlays are restricted to basic CSS outline changes (`MARK = 'data-rater-autofill'`, `outline = 2px solid/dashed`).

2. **Current Authoring Implementation:**
   - In `types.js` (lines 126–201, 368–440), workflows are represented as carrier-specific data structures (`CarrierConfig`, `CarrierRule`, `FieldStep`, `ActionStep`).
   - In `sidepanel/panel/fill.js` (lines 37–57, 98–101), workflows are built on the fly from an intake record (`buildPlan(ctx.intake.record, carrier, ...)`), with DOM scripts injected into target tabs via `chrome.scripting.executeScript`.
   - There is currently no programmatic SDK for Node.js or Python, no visual workflow editor canvas, and no Unified Intermediate Representation (IR) AST schema for general-purpose browser workflows.

---

## 2. Logic Chain

1. **Need for Unified Intermediate Representation (IR):**
   - Observations show that existing workflows in `types.js` are tightly coupled to commercial auto concepts (`ClientRecord`, `Financing`, `UnitList`).
   - To support both a Programmatic SDK (Node/Python) and a Low-Code Visual UI Studio, there must be a common canonical representation.
   - Therefore, a JSON/YAML AST schema (`WorkflowDefinitionIR`) was designed with explicit step types (`NavigateStep`, `FillFieldStep`, `ClickActionStep`, `WaitStep`, `LoopStep`, `ConditionalBranchStep`), resilient multi-tiered locators (`SemanticLocatorIR`), and lifecycle hooks.

2. **Need for Active CDP Integration for Debugging (R3):**
   - Observation from `src/content/trace.js:283` showed that `PerformanceObserver` cannot detect *in-flight* pending requests, leading to potential race conditions during quiet settling.
   - Observation from `docs/developer-recording.md:23` showed that the existing system is purely a passive observer without step pause, breakpoints, or time-travel.
   - Therefore, the enterprise architecture introduces a CDP Debug Controller utilizing `Debugger` (breakpoints, pause/resume, step-over/into), `Network` (exact in-flight request tracking), `Accessibility` (real-time a11y tree node inspection), `DOMDebugger` (mutation breakpoints), and `Page` (screencast/snapshots).

3. **In-Page Visual State Inspection & HUD:**
   - Observation from `src/kit/marks.js:45` showed that basic CSS outlines are vulnerable to overflow clipping and cannot display status details or value diffs.
   - Therefore, an interactive `<automata-debug-hud>` and badge overlay system was architected, displaying field status color-coding, locator resilience scores, diff tooltips, and a live quiet-settling progress ring.

4. **Automated Root-Cause Diagnostics:**
   - Observation from `scripts/lib/recording.mjs` showed that timing and attribution analysis can be computed deterministically from execution streams.
   - By combining CDP execution frames, DOM mutation logs, and accessibility tree snapshots, the engine can execute a 4-tier heuristic diagnostic rule pipeline (Locator Breakdown, Timing Race Condition, Server Validation Error, Unit Scope Drift) and automatically emit concrete remediation patches.

---

## 3. Caveats

1. **Extension Permissions:** Attaching the Chrome DevTools Protocol (`chrome.debugger`) in an extension context generates a native warning bar (*"Extension is debugging this browser"*). In headless/Node/Python environments (via Playwright or pure CDP WebSocket), this warning does not occur. The architecture therefore specifies dual-mode telemetry: lightweight passive content-script observation for live end-user extension builds, and full CDP attachment for developer, studio, and headless test runners.
2. **Main World vs Isolated World Boundaries:** On legacy complex web apps (e.g. ExtJS on Progressive), JavaScript widget state lives in the page's MAIN world. The CDP bridge bypasses isolated world restrictions via `Runtime.evaluate` and `DOM.describeNode`.

---

## 4. Conclusion

The technical survey and specification for Requirements **R2 (Dual Authoring Interfaces)** and **R3 (Interactive Debugging & Observability System)** is complete and documented in:
`c:\Users\Lutfy\Documents\ChatGPT\TNI Autofill\.agents\teamwork\explorer_survey_2\survey_report.md`

Key deliverables include:
- Complete TypeScript / JSDoc interfaces for `WorkflowDefinitionIR`, `SemanticLocatorIR`, `StepNode`, `CDPDebugSession`, `TelemetrySpan`, and `DiagnosticReport`.
- Complete Programmatic SDK architectures and code examples for both Node.js/TypeScript and Python 3.10+.
- Visual Low-Code UI Studio architecture with bidirectional AST synchronization (3-way merge and comment preservation).
- CDP interactive debugging controller specification with step-by-step execution control and time-travel inspection.
- In-page HUD overlay design with quiet-settle progress indicator and carrier agreement/rejection tracking.
- Automated failure root-cause diagnostics pipeline.

---

## 5. Verification Method

To independently verify this survey and specification:
1. Inspect the detailed report file:
   `c:\Users\Lutfy\Documents\ChatGPT\TNI Autofill\.agents\teamwork\explorer_survey_2\survey_report.md`
2. Validate TypeScript schema syntax:
   The TypeScript interfaces in sections 3.1, 4.1, and 4.3 strictly adhere to standard TypeScript 5+ syntax.
3. Validate architectural consistency with existing codebase:
   - Check `types.js` to confirm alignment with existing fill options, plan steps, and trace event structures.
   - Check `src/content/trace.js` and `sidepanel/recording.js` to confirm proper evolution from the passive recording foundation into active CDP and OTel-compliant telemetry.
