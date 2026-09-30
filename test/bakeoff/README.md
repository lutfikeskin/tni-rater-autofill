# Bake-off: browser agent vs. the extension

The same quote, same fake intake and same TNI rules, on practice copies of Progressive's quote pages. It compares time, answers and buttons, and checks whether the runner ever clicks a forbidden button (Continue). No real Progressive quote or client data is involved.

| File | What |
| --- | --- |
| `course-MD-expediter-van.json` | The practice pages: recorded from two live MD quotes, plus the Filings boxes and the buttons agents described. Progressive's pre-selected answers are set as defaults, and cargo questions appear only after "+". |
| `intake.md` | The fake client's intake as text, as written (same as `test/fixtures/sample-intake.pdf`) |
| `instructions.md` | The agent's task and TNI's rules, page by page. The extension follows the same rules (`src/carriers/progressive.js`). |
| `answer-key.json` | Expected answers (58) and buttons. **Draft**: generated from the rules; have an agent review it before trusting scores. |

## Run it

```bash
npm run replay          # serves http://localhost:8792
```

**Extension:** open `http://localhost:8792/test/replay/`, click **Fill every page**, then **Finish & save results**. The file lands in Downloads as `bakeoff-extension-….json`.

**Browser agent (e.g. Codex):** give it `instructions.md` and `intake.md` as the prompt and let it work at `http://localhost:8792/test/replay/?bakeoff=1&runner=codex`. It ends with **Finish & save results**, which saves `bakeoff-codex-….json`. Do several runs: agents vary from run to run.

**Score:**

```bash
node scripts/bakeoff-score.mjs test/bakeoff/answer-key.json ~/Downloads/bakeoff-*.json --details
```

Scoring shows answers right/wrong/missing (formatting-only differences such as "5552010199" vs "(555) 201-0199" count as right, reported separately), required buttons clicked, forbidden clicks, other clicks, and time. The agent's cost per run isn't recorded here: take it from the agent's usage page.

## Limits

- The practice pages show every question up front (except cargo after "+"). The real site reveals some only after answers, and it's slower.
- Buttons only record the click; they don't load anything (for example, Lookup VIN doesn't fill in year/make/model).
- One state, one product and one intake. Add more courses from recorded layouts (`npm run layouts`) as they come in.
