---
name: verify-tni-rater
description: >-
  Drive TNI Rater Autofill's Chrome side panel and carrier mocks the way an
  agent would, using this repo's Playwright harnesses and a packaged
  extension, never the user's Chrome. Use when verifying a fill, panel, or
  quote-page change, or when asked to prove the extension works.
---

# Verify TNI Rater Autofill

An agent uses this Chrome MV3 side panel on a carrier quote tab. They drop in a TNI intake PDF and press Fill this page. Progressive, AmWINS, and GEICO are the supported raters.

Do not drive the Chrome profile the human already loaded the unpacked extension into. That profile holds their settings, OpenAI key, and usage queue. Two drivers on that instance will corrupt it.

The proof surface is Playwright Chromium with `dist/tni-rater-autofill` (fixed development id `cbpjccegchfackokbiogplhdekblkccj`) plus the local mocks. Live carrier sites are out of scope unless the human asked for a live quote. Never bind, buy, submit, order reports, or sign.

Read the feature map under [features/](features/README.md) before driving. Prove the feature you touched. One mapped feature is enough when the change is local.

## Launch

From the repo root, after `npm ci` and `npx playwright install chromium` once on this machine.

```bash
npm run package
npm run replay
```

`npm run package` writes `dist/tni-rater-autofill`. Ready means that folder exists and contains `manifest.json`, not that the command printed.

`npm run replay` binds `127.0.0.1:8792` only. Ready means it printed `Open http://localhost:8792/test/replay/` and doctor (below) can fetch the AmWINS mock. The GEICO mock and Progressive `--fixtures` replay start their own servers. They do not need 8792.

If 8792 is already this repo's replay, reuse it. Do not start a second listener. If 8792 is something else, stop. Do not kill other people's processes by name.

Teardown is in Cleanup.

## Doctor

Run this first whenever anything looks off, and before the first drive of a session.

```bash
node .claude/skills/verify-tni-rater/scripts/doctor.mjs
```

It is read-only. It checks Node, `dist/tni-rater-autofill`, Playwright, the sample intake, and that port 8792 is this checkout's replay serving `CL - Business Auto (mock)`. Exit 0 and a `READY` line means the packaged AmWINS proof is worth driving. Exit 1 prints what is missing.

## Drive

Prefer the repo scripts. They already click the real panel controls and fail on a wrong answer, a missing hold, a submit, or a request off the machine.

| What you are proving | Command | Needs |
| --- | --- | --- |
| Packaged panel on AmWINS, intake load, agent hold, pop out, no Submit | `npm run e2e:extension -- <evidence-dir>` | package, replay on 8792 |
| AmWINS rules without the panel | `npm run mock:amwins` | Playwright |
| GEICO quote mock | `npm run mock:geico` | Playwright |
| Progressive committed layouts | `npm run e2e -- --fixtures` | Playwright, internet for ExtJS |

Pass a new directory under `reviews/verify-tni-rater/` as `<evidence-dir>` so screenshots land there. `reviews/` is gitignored.

Do not write a new Playwright script when one of those commands covers the path. If you must drive the panel yourself, launch a **new** persistent Chromium with `--disable-extensions-except` and `--load-extension` pointing at `dist/tni-rater-autofill`, as `scripts/extension-e2e.mjs` does. Stable handles in the panel:

- File input `#file` (drop the PDF here)
- `#site` (carrier and step, e.g. starts with `AmWINS`)
- `#details-row` text All client details
- `#fill` button Fill this page
- `#pop-out` name Open in its own window
- `#dock-back` name Back to the side panel
- `#settings-btn` name Settings

Wait on the panel and mock, not a sleep. `scripts/extension-e2e.mjs` uses `quiet()` and the dock's `data-phase` / `data-report`.

A unit test or `vm` pagekit run is not this skill. Those belong to `npm test`.

## Evidence

Proof lives in `reviews/verify-tni-rater/<run-id>/`. Keep that folder. Cleanup must not delete it.

For `e2e:extension` the script writes `client-details.png`, `panel.png`, `earlier-page.png`, `popped.png` (and the narrow variants). Also keep the command's stdout. A pass prints a line that starts with `OK:` and exits 0. A fail prints `FAILED:` and exits 1.

Proof standards:

- Exercise the agent's path (PDF in, Fill this page, hold, trusted answer, no Submit). Do not poke `chrome.storage` to fake a filled page.
- Capture the action and the later state. The `OK:` line names what was checked. The screenshots show the panel at those points.
- Side effects. Usage must hit only the throwaway local server the script starts. The run fails if any request leaves localhost, including TNI's production usage host.
- Mocks are the production boundary for the carrier site. A mock pass is not live GEICO, Progressive, or AmWINS acceptance. Say which surface you drove.

`npm run mock:geico` and `npm run e2e -- --fixtures` prove the fill engine on saved pages. They do not open the packaged side panel. Do not report them as a panel proof.

## Cleanup

Kill only processes this run started.

- Replay you launched. Stop that process (Ctrl+C in its terminal, or the PID you spawned). Do not `taskkill` by image name.
- `e2e:extension` already closes its Chromium and its throwaway usage server, and deletes that usage temp dir. Do not delete `reviews/verify-tni-rater/`.
- Leave the human's Chrome, their `dist/` load, and a replay you did not start.

## Helpers

`scripts/doctor.mjs` is the only helper this skill ships. Invocation is under Doctor.

## Live quotes

Give the human a loadable `dist/tni-rater-autofill` from `npm run package`. State the version in `manifest.json` and the git HEAD. Do not click Bind, Buy, Submit, order reports, or sign. GEICO is not yet checked live in-repo.
