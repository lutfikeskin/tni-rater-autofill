# Fill AmWINS

Fill AmWINS is the agent's packaged-extension path. They load an intake, fill the mock Business Auto application, answer a fact the intake left blank, pop the panel into its own window, and stop at the declaration. Submit is never clicked.

## Sub-features

- `amwins-fill` runs Fill this page on the AmWINS mock until a client fact holds Continue.
- `amwins-hold` leaves the cleared second-driver marital status blank and does not Save and Continue until the agent answers.
- `amwins-agent` types a trusted answer (`DIVORCED`) on the rater control, then resumes from the panel.
- `amwins-popout` moves the panel into its own window, shows earlier step reports, fills, and returns with Back to the side panel.
- `amwins-no-submit` leaves the declaration unticked and Submit unpressed.

## How to get to it (user POV)

- With the AmWINS application in the quote tab, choose **Fill this page**.
- When the bar says a fact needs you, answer it on the rater page, then fill again.
- Choose **Open in its own window**, then **Back to the side panel**.
- On Underwriting, tick the declaration and Submit yourself. The extension never does those.

## Driving it with the repo harness

Preconditions:

- Doctor reports `READY`.
- Evidence directory `reviews/verify-tni-rater/fill-amwins` exists.
- Replay is this checkout on 8792.

- **Packaged fill.** Run `npm run e2e:extension -- reviews/verify-tni-rater/fill-amwins`. The script drops the sample intake, clears `drivers[1].maritalStatus` in All client details, and clicks `#fill`.
- **Hold.** Before it answers marital status, the mock step and save count stay put for 1.5 s of quiet. A Continue that ran fails the process.
- **Agent answer.** It focuses the Drivers marital-status control and chooses `DIVORCED` with keys, not `selectOption`. The recorder must acknowledge that edit. Then it clicks Fill this page again.
- **No Submit.** It reaches Underwriting with the I-declare item still for the agent. `#accept` stays unchecked. `window.__amwinsMock.submitted` stays false.
- **Pop out.** It clicks `#pop-out` (Open in its own window), checks the page menu still lists earlier steps, fills, then `#dock-back`.
- **Proof.** Exit code 0 and stdout contains `OK: manual facts held Continue`. The evidence dir has `panel.png`, `earlier-page.png`, and `popped.png`. Stdout also contains `Usage:` with `intake_loaded` and `0 requests off this machine`.

## Gotchas

- `npm run mock:amwins` fills with the engine only. It does not open the packaged panel. Do not report it as this feature.
- Native clicks need the panel surface in front on Windows. The script calls `bringToFront`. A headed re-run you drive by hand must focus the panel tab before Fill this page.
- If a TNI standard starts answering the cleared marital-status field, the hold never comes and the run fails on purpose (`Manual hold wasn't exercised`). Clear a different client fact rather than drop the hold.
- Port 8792 must serve this repo's fixture. A stale process on that port that is not replay fails doctor.
- Live AmWINS is a different surface. This feature does not prove it.
