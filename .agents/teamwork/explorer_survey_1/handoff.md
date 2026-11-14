# Handoff Report: Foundation Engine & Multi-Target Architecture Survey (R1)

**Agent**: `explorer_survey_1`  
**Working Directory**: `c:\Users\Lutfy\Documents\ChatGPT\TNI Autofill\.agents\teamwork\explorer_survey_1`  
**Primary Deliverable**: `c:\Users\Lutfy\Documents\ChatGPT\TNI Autofill\.agents\teamwork\explorer_survey_1\survey_report.md`  
**Milestone**: Blueprint R1 Investigation  

---

## 1. Observation

Direct code observations from the codebase:

1. **Top-to-Bottom Cursor & Provisional Horizons (`src/kit/cursor.js:757-775`, `1130-1146`)**:
   - The engine maintains a moving cursor (`stopAt`, `pendingAt`).
   - Fields below the cursor are tagged as provisional (`provisional = at >= thisRound.bound`).
   - Provisional items emit no blocker, check, or error until the cursor reaches them.
   - A two-pass loop (`answerPasses`) executes pass 0 down to the cursor, and pass 1 evaluates remaining non-provisional items once the page settles.
2. **Multi-Signal Settling Engine (`src/kit/adapter.js:223-245`)**:
   - `settle()` checks DOM quiet time via `MutationObserver` on `document.body` (monitoring `childList`, `subtree`, `checked`, and adapter change attributes).
   - Checks `pageBusy()` (loading masks and spinners) and `partsUndefined()` (custom elements `:not(:defined)` matching `componentPrefix` like `gds-`).
   - Uses `PerformanceObserver` to track active `fetch`/`xmlhttprequest`. Excludes periodic heartbeat polls via `isBeat()` (`adapter.js:179-189`) which identifies consistent intervals within `POLL_SLACK_MS = 40`.
3. **Real-Time Co-Pilot Protections (`src/kit/guard.js:20-89`, `src/content/page-press.js:16-41`)**:
   - `guardEdits` tracks trusted gestures (`pointerdown`, `keydown`, `paste`, `drop`).
   - If an `input`/`change` event with `event.isTrusted === true` occurs within 2000ms of a gesture on that control, `onEdit(fieldKey(c))` marks the field key in `state.skipKeys` and halts filling with `EDIT_HALT`.
   - `page-press.js` resolves React 18 event queue suppression by listening for `rater-press` and executing `el.click()` inside a browser-dispatched `volumechange` event on an unattached `<audio>` element.
4. **Resilient Locators & Disambiguation (`src/kit/locator.js:40-229`, `src/kit/dom.js:166-191`, `src/content/field-key.js:20-61`)**:
   - Hierarchy: Data-model reference (`ref`) -> Exact label/regex -> Anchor proximity (`askAfter`) -> Option introspection (`withOption`) -> Witness row matching (`witness`) -> Repeated unit scoring (`vehicleRow`) -> Structural relative DOM path (`dom-v1:tag:data-id:ordinal` traversing shadow roots).
   - Label harvesting checks `aria-labelledby`, native `<label>`, sanitized `aria-label`, parent wrapper `.control-label` / `.form-label` up to 5 levels, `withoutCalendar`, `placeholder`, and `title`.
5. **Coupling Boundaries (`types.js:20-362`, `scripts/lib/kit.mjs:1-41`, `sidepanel/panel/fill.js:38-57`)**:
   - `types.js` is coupled to commercial auto schemas (`vehicles`, `drivers`, `trailers`, `USDOT`).
   - `scripts/lib/kit.mjs` compiles `src/kit/pagekit.js` via Rolldown into a single classic IIFE script.
   - `fill.js` injects scripts into tabs via Chrome MV3 `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN' | 'ISOLATED' })`.

---

## 2. Logic Chain

1. **Premise 1**: The existing TNI Autofill execution engine already solves the most intricate problems of browser automation (asynchronous redraw race conditions, lag bounds, multi-signal settling, heartbeat polling deadlocks, user co-pilot interception, and synthetic framework event dispatch).
2. **Premise 2**: These core capabilities are currently tightly coupled to Chrome MV3 APIs (`chrome.scripting`, `chrome.runtime`), insurance domain entities (`vehicles`, `drivers`, `USDOT`), and DOM-only content script evaluation (`deepQueryAll`).
3. **Inference 1**: To create a general-purpose, enterprise-grade engine, the execution logic in `src/kit/` can be extracted into a pure TypeScript engine core (`@autofill/core`), where all interactions with the browser are delegated to an abstract port (`ExecutionTarget`).
4. **Inference 2**: By defining target drivers for `TargetMV3`, `TargetPlaywright`, `TargetPuppeteer`, and `TargetCDP`:
   - MV3 maintains zero-footprint live user co-pilot mode.
   - Playwright/CDP unlocks closed Shadow DOM piercing (`DOM.getDocument({ pierce: true })`), computed accessibility tree (`AXTree`) resolution, and headless cloud containerization.
5. **Inference 3**: Replacing heuristic DOM attribute crawling with native Computed Accessibility Trees (`AXTree`) while preserving the 4-layer fallback architecture elevates locator resilience across enterprise web applications by an order of magnitude.

---

## 3. Caveats

1. **Closed Shadow DOM in MV3**: While closed Shadow DOM can be pierced natively in Playwright/CDP via Chrome DevTools Protocol, inside standard Chrome MV3 content scripts it remains inaccessible unless monkey-patched via `Element.prototype.attachShadow` at `document_start` in the `MAIN` world.
2. **Anti-Bot Telemetry**: High-security bot detection systems (e.g. Cloudflare Turnstile, Akamai) detect synthetic DOM events (`isTrusted: false`). For cloud and headless targets, CDP-level native hardware input (`Input.dispatchMouseEvent` with Bezier curves) must be used rather than synthetic DOM dispatch.
3. **No Code Implementation**: In accordance with the Explorer role instructions, this task was strictly read-only investigation and architectural blueprinting; no source code was altered.

---

## 4. Conclusion

Requirement R1 (Comprehensive Platform Architecture & Core Engine) is fully surveyed, analyzed, and specified in `c:\Users\Lutfy\Documents\ChatGPT\TNI Autofill\.agents\teamwork\explorer_survey_1\survey_report.md`.

The deliverable provides:
- Exhaustive documentation of the existing engine mechanics (cursor engine, settling, co-pilot guards, locators, drivers).
- Complete multi-target architectural design decoupling MV3, Playwright, Puppeteer, and Cloud headless runners via `ExecutionTarget`.
- Concrete TypeScript/JSDoc interface specifications for plans, steps, locators, execution contexts, and telemetry.
- Formal Mermaid & ASCII state machine diagrams for step lifecycles, round/cursor processing, and co-pilot interception.
- Self-healing protocols for stale DOM references, late redraws, and quarantined entity rows.

---

## 5. Verification Method

To independently verify the evidence and findings:

1. **Verify Existing Engine Build**:
   ```powershell
   node -e "import('./scripts/lib/kit.mjs').then(m => m.buildKit()).then(k => console.log('Kit build successful. Code length:', k.code.length))"
   ```
2. **Inspect Engine Files**:
   - `src/kit/cursor.js`: Lines 757-775 (cursor horizon), lines 862-880 (`waitFor`), lines 591-602 (`lagBound`).
   - `src/kit/adapter.js`: Lines 179-189 (`isBeat`), lines 223-245 (`settle`).
   - `src/kit/guard.js`: Lines 20-89 (`guardEdits` and 2000ms gesture window).
   - `src/content/page-press.js`: Lines 16-41 (audio `volumechange` React 18 event dispatch trick).
   - `src/kit/locator.js`: Lines 40-229 (`assign` locator hierarchy).
3. **Run Project Test Suite**:
   ```powershell
   npm test
   ```
   Ensures all existing tests pass and verifies baseline integrity.
