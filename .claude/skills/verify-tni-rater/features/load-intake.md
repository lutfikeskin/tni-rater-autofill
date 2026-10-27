# Load intake

Load intake lets an agent drop a TNI quote application PDF into the side panel, see which client it is, and open every parsed field in All client details to correct a blank.

## Sub-features

- `intake-drop` loads the PDF from the panel file control.
- `intake-named` shows the client on the panel once the record is in session storage.
- `intake-details` opens All client details so a field can be cleared or edited.

## How to get to it (user POV)

- Drop the PDF onto the side panel, or use the panel's file control.
- Choose **All client details** (the row under the intake checks, or the client name at the top).

## Driving it with the repo harness

Preconditions:

- Doctor reports `READY`.
- Evidence directory `reviews/verify-tni-rater/load-intake` exists.
- Replay is this checkout on 8792.

- **Open packaged panel on AmWINS.** Run `npm run e2e:extension -- reviews/verify-tni-rater/load-intake`. The script loads `dist/tni-rater-autofill`, opens `chrome-extension://<id>/sidepanel/sidepanel.html`, and navigates the quote tab to `http://localhost:8792/test/fixtures/amwins/application.html`.
- **Drop PDF.** The script sets `#file` to `test/fixtures/sample-intake.pdf`. `#details-row` becomes visible within 10 s. `#site` starts with `AmWINS`.
- **Open details.** The script clicks `#details-row`. `#details-view` is visible. It writes `client-details.png`.
- **Proof.** `client-details.png` shows All client details. Stdout contains `site:`. Exit code of a full run is 0 only if later fill steps also pass. For this feature alone, the screenshot plus `site:` and a visible `#details-row` in that screenshot are the intake proof. If the command fails after intake, still keep the screenshot and say which later step failed.

## Gotchas

- The sample PDF answers every AmWINS client fact. A hold is not visible until a fact is cleared in All client details (see Fill AmWINS).
- Loading a real client PDF from `test/TestIntakes/` is not a verification seed. It is client data.
- The panel follows the tab in front. If `#site` is not AmWINS, the wrong tab was focused.
