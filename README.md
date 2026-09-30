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
| `test/tools/` | Capture snippets for following a live quote without the extension |
| `lib/` | pdf.js, vendored (MV3 can't load remote code). Refresh with `npm run vendor`. |

## Development

```bash
npm install
npm test
```

To try the fill engine without the extension, serve this folder (`python3 -m http.server 8791`) and open `test/mock-rater/index.html`. The side panel also opens directly at `sidepanel/sidepanel.html` in preview mode (loading and reviewing work there; filling doesn't).
