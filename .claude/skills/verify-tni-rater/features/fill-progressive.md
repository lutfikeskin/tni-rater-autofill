# Fill Progressive

Fill Progressive replays committed per-state layouts in a real browser with the real fill engine and Progressive rules. Each page's outcomes must match the accepted baseline. This is not a live Progressive quote.

## Sub-features

- `progressive-fixtures` fills committed layouts under `test/fixtures/progressive`.
- `progressive-baseline` fails when a question's answer, rule, blocker, or Continue changes with the counts unchanged.
- `progressive-renumber` (optional extra) shifts question ids the way Progressive did on 2026-10-07. Outcomes must still match, because questions are found by name or text.

## How to get to it (user POV)

- On a Progressive Duck Creek page, choose **Fill this page**. The fill goes one answer at a time. Follow-ups appear as the page accepts values.
- Continue is clicked only when nothing is left for the agent and Continue when the page is done is on. Finish, Buy, Bind, and Submit are never clicked.

## Driving it with the repo harness

Preconditions:

- Playwright Chromium is installed.
- Internet is available. The replay page loads ExtJS 6.2.0 from cdnjs with a pinned integrity hash.
- Replay on 8792 is not required. This command starts its own server.

- **Committed layouts.** Run `npm run e2e -- --fixtures`. Exit 0.
- **Report.** A Markdown report is written under `reviews/e2e-<date>.md`. Copy or point to it from `reviews/verify-tni-rater/fill-progressive/`.
- **Renumber (only if the change is about question ids).** Run `npm run e2e -- --fixtures --renumber`. Exit 0 and the same baseline outcomes.
- **Proof.** Exit 0 and a baseline match. Label the proof `Progressive fixtures`. Do not call `--update` during verification. Updating the baseline is a product decision, not a proof.

## Gotchas

- Local captures and generated layouts run only without `--fixtures`. A pass that included unreviewed generated layouts is not the committed proof.
- The sample intake takes the layout's state. Florida layouts get Florida answers such as PIP.
- A replay does not prove live navigation, server acceptance, or lookup reliability.
- `--headed` is for watching.
