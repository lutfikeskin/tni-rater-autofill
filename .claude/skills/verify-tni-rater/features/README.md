# TNI Rater Autofill verification map

This directory is the maintained source for verifying what an agent sees in the side panel and on a rater page. Read this index before driving, then use the matching feature file.

## Baseline preconditions

- Work in the repo root. Run `node .claude/skills/verify-tni-rater/scripts/doctor.mjs` and require `READY` before a packaged AmWINS drive.
- Use Playwright Chromium the scripts launch. Never attach to the human's loaded Chrome.
- Seed PDF is `test/fixtures/sample-intake.pdf` (committed, fake). Do not load `test/TestIntakes/` or other client PDFs into a proof.
- Put screenshots and logs in `reviews/verify-tni-rater/<run-id>/`. That folder survives cleanup.
- One replay listener on `127.0.0.1:8792`. Reuse it if doctor says it is this checkout's replay.

## Driving conventions

- Start from the feature file's preconditions.
- Prefer the npm script the feature names. The scripts click `#file`, `#fill`, `#details-row`, and `#pop-out`.
- Treat every command as literal.
- Restore nothing in Chrome. Each script uses a temp profile.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command, exit code, and stdout. For `e2e:extension`, also the screenshots it writes.
- A mock or fixture pass is labeled as that mock. It is not a live carrier quote.
- Record the feature ID with every artifact.
- An unreachable path (replay down, no package, no Playwright) is a failure with that reason. Do not mark it verified through a different command.

## Features

- [Load intake](./load-intake.md) covers dropping the PDF and opening All client details.
- [Fill AmWINS](./fill-amwins.md) covers the packaged panel on the AmWINS mock, the agent hold, pop out, and no Submit.
- [Fill GEICO](./fill-geico.md) covers the GEICO quote mock, including stop steps and no SSN fill.
- [Fill Progressive](./fill-progressive.md) covers committed Progressive layout replays against the baseline.
- [Luna assistance](./luna-assistance.md) covers the packaged Luna mock, not live OpenAI.
