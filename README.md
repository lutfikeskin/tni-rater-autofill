# TNI Rater Autofill

A Chrome extension that reads a client's **TNI Commercial Insurance Quote Application** (the fillable PDF) and fills in Progressive and GEICO rater pages from it.

The agent stays in control. The extension fills what it can on the page in front of them and marks everything else. It never clicks Next or Submit, never touches password fields, and by default leaves anything the rater already filled in (for example from a DOT lookup) alone.

## Install (for testing)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the extension, then click its icon to open the side panel.

## Using it

1. Drop the client's intake PDF into the side panel.
2. Work through **Check before quoting**. These are things the form got wrong or left ambiguous, such as an address with no commas, a VIN that fails its check digit, answers typed into the claims box, or a missing vehicle ownership answer. Edit any value in the sections below; your edits are what gets filled.
3. Open the rater page and click **Fill this page**. If the client has several drivers or vehicles, pick which one the current page is about first.
4. Look at the marks on the page:
   - **green**: filled from the intake
   - **amber dashed**: needs you (not on the intake, or required by the rater)
   - **red dashed**: couldn't fill (for example, no dropdown option matched). The side panel lists the options it saw.
5. Review, then click Next yourself and repeat on the next page.

The client data lives only in Chrome's session storage (in memory). It never leaves the computer, and it's cleared when Chrome closes or you click **Clear**.

## Setting up a carrier: page captures

Until a carrier has exact mappings, the extension matches fields by their labels ("Date of Birth", "USDOT #", …) using the generic rules in `src/rules.js`. To make a carrier exact:

1. Load any intake (so client details can be redacted), open a rater page, and click **Capture page layout (for setup)**.
2. This saves a JSON file to Downloads. It lists every field's label, id/name, type, dropdown options and section, plus which intake field the generic rules would put there (`wouldFill`). It contains **no field values**, and client names and numbers are replaced with `[client]`.
3. Do this for every page of the quote flow, send the files over, and the mappings go into `src/carriers.js`.

## Status

- **Done and tested:** PDF reading, data cleanup with warnings, the review panel, the fill engine, highlighting, and page capture with redaction. The fill engine handles React-style inputs, dropdowns, radios, checkboxes, date inputs, amount/range matching for limits and radius, and ExtJS components. Tests use a mock React rater page (`test/mock-rater/`), a mock Duck Creek/ExtJS page (`test/mock-progressive/`) and the fake-data PDF (`test/fixtures/`).
- **Progressive:** mapped from a live MD for-hire expediter quote (`captures/progressive/`). Fields are matched by Progressive's question ids, and intake answers are translated into their wording. Filling goes one answer at a time, because their site checks every answer with its server; new follow-up questions are picked up as they appear. Consent and MVR-order questions are marked for the agent, never filled. **Not yet tried on the live site.**
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

For the pilot the log stays on each computer (`chrome.storage.local`, up to 20,000 events) until an agent clicks **Export log**. To review exports:

```bash
node scripts/summarize-usage.mjs rater-usage-*.json
```

That lists intake problems by warning code, autofill answers agents changed, fields agents filled that autofill didn't (with the intake field the value matched, which makes them candidates for new mapping rules), fill failures, and time per page. To find the intake PDF behind a log entry, search a folder of intakes by fingerprint; this runs locally and prints file paths:

```bash
node scripts/find-intake.mjs <folder of intake PDFs> rater-usage-LK-2026-10-01.json
```

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
| `src/content/pagekit.js` | Runs inside the rater page: find fields, fill, highlight, capture |
| `captures/` | Page layouts captured from real quotes (no client data) |
| `src/usage.js`, `sidepanel/usage-log.js`, `src/content/recorder.js` | Usage log: event building, local storage/export, page recorder |
| `scripts/` | `summarize-usage.mjs` and `find-intake.mjs` for reviewing exported logs |
| `test/tools/` | Capture snippets for following a live quote without the extension |
| `lib/` | pdf.js, vendored (MV3 can't load remote code). Refresh with `npm run vendor`. |

## Development

```bash
npm install
npm test
```

To try the fill engine without the extension, serve this folder (`python3 -m http.server 8791`) and open `test/mock-rater/index.html`. The side panel also opens directly at `sidepanel/sidepanel.html` in preview mode (loading and reviewing work there; filling doesn't).
