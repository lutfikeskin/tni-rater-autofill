# TNI Rater Autofill

A Chrome extension that reads a client's **TNI Commercial Insurance Quote Application** (the fillable PDF) and fills in Progressive and GEICO rater pages from it. An optional AI assistant (OpenAI GPT-6 Luna) suggests answers, with a short tip, for the questions the rules leave for the agent.

The agent stays in control. The extension fills what it can on the page in front of them and marks everything else. It never clicks Next or Submit, never touches password fields, and by default leaves anything the rater already filled in (for example from a DOT lookup) alone.

## Install

Agents install it from its private Chrome Web Store listing (see [docs/chrome-web-store.md](docs/chrome-web-store.md)). For development:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the extension, then click its icon to open the side panel.
4. Under **Usage log**, enter your initials. **Server** defaults to `http://localhost:8787` (start it with `npm run server`).

## Using it

1. Drop the client's intake PDF into the side panel.
2. Work through **Check before quoting**. These are things the form got wrong or left ambiguous, such as an address with no commas, a VIN that fails its check digit, answers typed into the claims box, or a missing vehicle ownership answer. Edit any value in the sections below; your edits are what gets filled.
3. Open the rater page and click **Fill this page**. If the client has several drivers or vehicles, pick which one the current page is about first.
4. Look at the marks on the page:
   - **green**: filled from the intake
   - **amber dashed**: needs you (not on the intake, or required by the rater)
   - **red dashed**: couldn't fill (for example, no dropdown option matched). The side panel lists the options it saw.
5. Review, then click Next yourself and repeat on the next page.

### AI assistant

Turn it on under **AI assistant** in the side panel and paste your OpenAI API key (model: `gpt-6-luna` unless you set another). After each fill it looks at the yellow, red and amber questions and suggests an answer with a one-line reason; **Accept** puts it in (marked **purple** on the page), **Dismiss** drops it. It only picks from the page's own options, a cited intake value must exist, and the page must keep the answer, or it's marked red. MVR/CLUE orders, driver exclusions, signatures/authorisations, payment details and typed identifiers are never sent to it. **Let the AI make selections on the page** lets it pick dropdown/radio/checkbox answers itself (not when it's unsure, never typed text). Its picks are listed at the end of the panel's report and in a note at the bottom of the rater page, and Continue is not clicked until the agent approves them (**Approve and continue**, or **Reject** one to answer it yourself). Architecture, safety rules and roadmap: [docs/ai-assistant.md](docs/ai-assistant.md).

With the AI assistant on, the questions on the page, the intake and TNI's rules are sent to OpenAI with the agent's key.

The client data lives only in Chrome's session storage (in memory) and is cleared when Chrome closes or you click **Clear**. It leaves the computer only when the AI assistant is on (sent to OpenAI with the agent's key).

## Setting up a carrier: page captures

Until a carrier has exact mappings, the extension matches fields by their labels ("Date of Birth", "USDOT #", …) using the generic rules in `src/rules.js`. To make a carrier exact:

1. Load any intake (so client details can be redacted), open a rater page, and click **Capture page layout (for setup)**.
2. This saves a JSON file to Downloads. It lists every field's label, id/name, type, dropdown options and section, plus which intake field the generic rules would put there (`wouldFill`). It contains **no field values**, and client names and numbers are replaced with `[client]`.
3. Do this for every page of the quote flow, send the files over, and the mappings go into `src/carriers.js`.

## Status

- **Done and tested:** PDF reading, data cleanup with warnings, the review panel, the fill engine, highlighting, and page capture with redaction. The fill engine handles React-style inputs, dropdowns, radios, checkboxes, date inputs, amount/range matching for limits and radius, and ExtJS components. Tests use a mock React rater page (`test/mock-rater/`), a mock Duck Creek/ExtJS page (`test/mock-progressive/`) and the fake-data PDF (`test/fixtures/`).
- **Progressive:** mapped from live MD, OH and NC quotes (`captures/progressive/`, `layouts/`). Fields are matched by Progressive's question ids, and intake answers are translated into their wording. Filling goes one answer at a time, because their site checks every answer with its server; new follow-up questions are picked up as they appear. Follow-up questions the intake doesn't cover get TNI's standard answers (comprehensive/collision Yes with $1,000 deductibles, loan/lease No, equipment $0–$2,000 and "no equipment", special cargo No, "General freight" → Consumer Goods / Other Consumer Goods, filings Yes + Federal when the intake asks, rental $40/day, UM/UIM $100k CSL, automatic payments, print the insurance quote); the agent adjusts the exceptions. Anything the filler can't answer is marked **yellow** and the rest of the page still fills; a page with nothing left for the agent gets its **Continue** clicked (setting in the panel, on by default; never Finish/Buy/Bind/Submit). The MVR/CLUE order question is left to the agent. Helper buttons are clicked once each, in order: Verify DOT, Add a Vehicle, the vehicle tile, Lookup VIN, cargo "+" → Add a Commodity → Done with this coverage → Recalculate → View bill plan options → Print, Email, Fax → Print/Send.
- **GEICO:** not captured yet; generic label rules only.
- **Not done:** div-based custom dropdowns on non-ExtJS sites, scanned or handwritten intakes.
- **To confirm:** the GEICO agent portal's domain (currently `*.geico.com`), and each carrier's portal terms for agent-side autofill.

### Progressive: what still needs capturing

- Type of Trucker options, the vehicle-type picker, and the VIN vs Year/Make/Model choice.
- Column headers for the per-vehicle coverages (comp/collision/rental/…).
- Variants: other states (CA, NY, NJ, FL, TX have their own questions), trailers, hazmat, filings = Yes, ELD = Yes, several drivers/vehicles, box truck / tractor.

## Usage log (pilot)

While an intake is loaded, the extension records how it's used on Progressive and GEICO quote pages, so the mappings can be improved from real quotes. A "Recording usage" label shows in the side panel header, and the **Usage log** section at the bottom of the panel explains it to agents. **Tell agents in writing before rollout** (several states require notice of electronic monitoring of employees).

What's recorded (`src/usage.js`, `src/content/recorder.js`):

| Event | Contents |
| --- | --- |
| `intake_loaded` | intake fingerprint (SHA-256 of the PDF), form version, state, business class, vehicle types, driver/vehicle/trailer counts, requested coverages, warning codes |
| `warning_checked`, `intake_edit` | which warning (code) the agent checked off; which intake field they corrected in the panel (added/changed/cleared) |
| `fill_run`, `fill_field` | per fill: carrier, page, what was filled/kept/failed and why; chosen dropdown/radio options (not typed text) |
| `field_change` | a field that changed on the rater page, by the agent or by the page: for dropdowns/radios the from/to option; for text boxes only whether it matches what autofill typed (same / format / different) and which intake field the new value equals, e.g. `drivers[0].dob`, worked out on the agent's computer |
| `page_view` | carrier page switches (for time per page) |
| `problem_report` | the agent's note from "Report a problem on this page" (client names redacted) |

Never recorded: client names, numbers, addresses, or anything typed into text boxes; screenshots; keystrokes; other websites. Client names are also redacted from labels and options.

Events wait in `chrome.storage.local` on the agent's computer and are uploaded every minute to the collection server set under **Usage log → Server** (default `http://localhost:8787`). They're removed from the computer only once the server has stored them, so nothing is lost while the server is down. **Export log** still works as a fallback.

### Collection server

```bash
npm run server
```

Plain Node, no dependencies. It listens on `127.0.0.1:8787` and appends events to `server-data/events/YYYY-MM-DD.jsonl`, one file per day. It accepts only known event types and fields, drops agency staff lists from layouts, and ignores duplicates, so retried uploads are safe. Settings: `PORT`, `HOST`, `DATA_DIR`, `RATER_TOKEN`. Before running it anywhere other than this computer, set `RATER_TOKEN` (the extension sends it as a Bearer token), put it behind HTTPS, and add the server's address to `host_permissions` in `manifest.json`.

### Weekly review

Every script reads the server folder, exported logs, or both. `npm run review` runs them all and adds what the AI assistant did and the agents' problem reports, in one Markdown file (`reviews/review-<date>.md`, covering what's new since the last review):

```bash
npm run review    # everything below, plus AI accept/reject per question and problem reports
npm run learn     # rule suggestions: standard answers, per-state answers, new intake mappings, rules agents keep correcting
npm run layouts   # carrier page layouts per state/product -> captures/<carrier>/generated/
npm run summary   # intake problems, corrections, failures, time per page
node scripts/find-intake.mjs <folder of intake PDFs> server-data   # which intake a session used
```

`learn` prints rule lines ready to paste into `src/carriers/<carrier>.js`. **Review each one**: a consistent answer isn't always a correct one. Generated layouts are git-ignored; review them before committing any.

### Replay test pages

```bash
npm run replay
```

Open `http://localhost:8792/test/replay/`. It rebuilds a carrier's pages from any layout file (the hand-made `captures/progressive/*.json`, or one from `npm run layouts`) as working ExtJS pages with Progressive-style ids and server round-trips, then runs the real fill engine. **Fill every page** gives a coverage table: questions per page, how many were filled, what failed, and which have no rule yet. It's built from recorded structure only; no carrier HTML or code is copied.

### Replay regression run (before every release)

```bash
npm run e2e              # every recorded layout (state/product), real fill engine, real browser
npm run e2e -- --update  # accept the current results as the baseline
```

Fills every layout (bake-off course, captures, and the per-state layouts from `npm run layouts`) on the replay page in Playwright's Chromium and compares with `test/e2e-baseline.json`: fewer answers filled, a new failure, or Continue clicked with questions still open fails the run. Report: `reviews/e2e-<date>.md`. One-time setup: `npx playwright install chromium`. The replay page doesn't imitate Progressive's address suggestions, so those stay "failed" there.

### AmWINS mock (before every AmWINS rule change)

```bash
npm run mock:amwins              # all five steps, real fill engine, real browser
npm run mock:amwins -- --headed  # watch it
```

`test/fixtures/amwins/application.html` is the Business Auto application saved from the live site (client details and the site's scripts removed); `test/fixtures/amwins/mock.js` plays what the site's own script does (show/hide rules, Save & Continue between steps, Import Data's preview and Import Valid Records, the VIN decoder, Default all answers to No, the classification search). The run fills every step the way the side panel does, answers the two questions the intake can't, and checks all answers against TNI's rules. It fails on a wrong answer, a step that stops early, or Submit being clicked.

```bash
npm run e2e:extension    # needs npm run package and npm run replay (port 8792)
```

The packaged extension itself in Chromium, its side panel opened as a page, on the same mock: loads the sample intake, clicks **Fill this page** once and checks that the panel goes through every step on its own (Save & Continue), stops at the declaration and never submits.

### Synthetic intake variations and AI controls

```bash
npm run test:intakes -- --workers 6
npm run test:intakes -- --carrier amwins --cases 03,09,69,71,97
npm run test:intakes -- --carrier progressive --lookup-check --cases 51,73,74,75,76,77,78,79,80,81,82
npm run package
npm run mock:ai
```

The intake runner reads the actual PDFs in `dist/synthetic-intakes` (or `--pool <folder>`), checks retained answers against the pool manifest, and writes JSON reports and screenshots under a temporary output folder (`--out <folder>` overrides it). The pool stays outside source control. VIN/DOT responses come from its lookup fixtures; no real carrier lookups are made. The mock's exact GVW of 9,000 is a synthetic decoder response, not a weight inferred from a real VIN.

AmWINS exercises the five application steps, including repeated drivers/vehicles and save/reload. A review stop is recorded before the runner continues to inspect later pages; it is not counted as automatic progress. FAO rebuilds captured pages individually. It does **not** establish full quote navigation, backend acceptance, or real lookup reliability. Missing questions and truncated business-type search results are reported as unsupported, alongside existing replay failures such as address autocomplete. Passing the selected assertions is not complete carrier coverage.

The AI runner uses the packaged extension with controlled provider responses. It checks suggestion acceptance, approval before Continue, preservation of manual edits, and response reuse. It blocks live AI requests and central uploads; it does not measure a live model's accuracy or latency. Suggestions are cached per intake and active driver/vehicle, and late responses after a context change are discarded.

## Hosting

Updates reach agents through the Chrome Web Store; their usage logs go to TNI's server on Railway and a daily GitHub Action builds the review. See [docs/hosting.md](docs/hosting.md).

## Files

| Path | What it does |
| --- | --- |
| `sidepanel/` | The side panel UI |
| `src/intake.js` | Reads the PDF's form fields (pdf.js) |
| `src/normalize.js` | Cleans the answers into a client record and produces the warnings |
| `src/schema.js` | Every client-record field: label and value kind |
| `src/rules.js` | Generic label → field rules |
| `src/carriers.js`, `src/carriers/` | Per-carrier domains and exact mappings (Progressive in `carriers/progressive.js`) |
| `src/plan.js` | Resolves values into fill steps; builds the capture redaction list |
| `src/content/pagekit.js` | Runs inside the rater page: find fields, fill, put in AI answers, highlight, capture |
| `src/ai/` | AI assistant: request/response checks (`assist.js`) and TNI's rules as the model reads them (`tni-rules.js`) |
| `captures/` | Page layouts captured from real quotes (no client data) |
| `src/usage.js`, `sidepanel/usage-log.js`, `src/content/recorder.js` | Usage log: event building, local storage/export, page recorder |
| `server/` | Usage collection server |
| `scripts/` | Review tools: `learn-rules`, `build-layouts`, `summarize-usage`, `find-intake` (shared code in `scripts/lib/`) |
| `test/replay/` | Replay test pages built from layout files |
| `test/tools/` | Capture snippets for following a live quote without the extension |
| `lib/` | pdf.js, vendored (MV3 can't load remote code). Refresh with `npm run vendor`. |
| `icons/`, `scripts/package.mjs` | Store icons; `npm run package` builds the Web Store zip in `dist/` |

## Development

```bash
npm install
npm test
```

To try the fill engine without the extension, serve this folder (`python3 -m http.server 8791`) and open `test/mock-rater/index.html`. The side panel also opens directly at `sidepanel/sidepanel.html` in preview mode (loading and reviewing work there; filling doesn't).
