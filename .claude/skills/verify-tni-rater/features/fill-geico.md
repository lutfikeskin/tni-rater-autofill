# Fill GEICO

Fill GEICO runs the real fill engine on the saved quote fixture with GEICO's `gds-*` behavior mocked. An agent would walk the same steps. The mock is not a live `sales.geico.com` quote.

## Sub-features

- `geico-fill` fills Business Class through Quote and Coverages against expected answers.
- `geico-agent` keeps trusted corrections the next fill must not overwrite.
- `geico-stop` fills and clicks nothing on Final Quote Details, MVR and CLUE, and Payment Information.
- `geico-ssn` never fills the owner's Social Security number.
- `geico-print` clicks Recalculate once the page is quiet, then Print Quote Proposal, and does not go past it.

## How to get to it (user POV)

- On a GEICO quote tab, choose **Fill this page** (or let Fill each page as soon as it opens run).
- Answer what the bar lists as Need you. Click Recalculate yourself after the fill's Recalculate if GEICO put coverages back.
- Stop at Print Quote Proposal. Do not open MVR and CLUE (those reports cost the agency).

## Driving it with the repo harness

Preconditions:

- Playwright Chromium is installed. Replay on 8792 is not required.
- Package is not required for this command.

- **Mock quote.** Run `npm run mock:geico`. Exit 0. Stdout reports the expected answers, the USDOT skip screen, and the gateway ZIP replacement.
- **Wrong answer.** Any filled Social Security number, a click on a stop step, an overwritten correction, or a request off the machine fails the process (exit 1).
- **Proof.** Keep the command stdout in `reviews/verify-tni-rater/fill-geico/stdout.txt`. Exit 0 is the pass. There is no panel screenshot. Label the proof `GEICO mock`, never live GEICO.

## Gotchas

- GEICO is not yet checked live in this repo. A mock pass is mock evidence.
- The fixture loads only `mock.js`. Network besides the one beat view is refused.
- `npm run mock:geico -- --headed` is for watching. It is not extra proof.
- Do not order MVR or CLUE on a live quote to "finish" verification.
