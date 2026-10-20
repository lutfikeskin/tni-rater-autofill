# Weekly review W<week> (<since> – <date>)

Sources: `reviews/signals-<date>.md`, `reviews/review-<date>.md`, `reviews/ledger-<date>.md`[, `reviews/benchmark-<date>.json`], ledger #<issue>. Client data: none in this brief. Test runs left out: <n>.

## For you

Plain language, no code names, five to eight short lines:

- What agents did this week (quotes, carriers) and how it went (done, stuck, declined).
- What is broken, worst first, in the agent's words of what they saw.
- What got better since last week (verified fixes).
- What I need from you: the questions below, and which fixes to approve.

## Weekly numbers

From the ledger report (`npm run ledger`): this period's numbers beside the previous ledger issue's. No trend when either period has fewer than about 10 quotes.

| Number | This period (<n> quotes) | Last period (<n> quotes) | Trend |
| --- | --- | --- | --- |
| Quotes (any carrier · per carrier) | | | |
| Quotes done (reached the carrier's final page) | | | |
| Median minutes for a done quote | | | |
| Answers filled by the rules, per quote | | | |
| Autofilled answers corrected, per 100 filled | | | |
| Left to the agent per quote (unfamiliar / leftRequired / noData / failed) | | | |
| Problem reports per 10 quotes | | | |
| AI requests · error rate (newest build) | | | |
| Restricted actions by the extension (must be 0) | | | |

Builds this period: <versions and channels; how many quotes on the newest>.

## Last period's decisions

From the ledger report; each status confirmed by you, not copied.

| ID | Title | Status | Evidence |
| --- | --- | --- | --- |
| W41-02 | | verified / recurred / not exercised / still open | builds and counts |

## Findings

| ID | Sev | Type | Title | Layer | Builds | Reach | Size |
| --- | --- | --- | --- | --- | --- | --- | --- |

### W<week>-01 · S? · Fix · <title>

- **Expected vs actual:**
- **Evidence:** counts per quote, builds, pages, problem report numbers (signals), masked quotes of the agent's words.
- **Cause:** confirmed, or the hypothesis and how to confirm it.
- **Proposed change:** layer, likely files, the test that reproduces it, a nearby case where it must not apply.
- **What the agent will notice:** one line.
- **Signature to watch:** in the ledger's structured form (`symptom <event> page=… result=…`, or `expect <event> … when <event> …`), so next week's `npm run ledger` counts it.

## Questions for the maintainer

### W<week>-0? · <question>

- What the page asks, and where (carrier, page, state/product).
- Options and the evidence for each (counts, intake fields, the carrier's wording).
- **Recommendation:** which option and why, or "keep it the agent's".
- **If not answered:** it stays the agent's question; nothing is defaulted.

## Captures needed

What to capture, on which page and scenario, and which answer to change between captures.

## Watch

Items already fixed on `main` or too thin to act on, each with its signature.

## Dropped

Items that are intended behavior or noise, each with the reason.

## Proposed implementation batch

Approved-to-be items grouped by branch (one coherent cause or layer per PR), in order, with expected checks.
