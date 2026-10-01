# AI assistant: architecture and roadmap

The rules engine fills what TNI has written rules for. The AI assistant only looks at what's
left: yellow (unfamiliar question), red (couldn't fill) and amber (needs you). It suggests an
answer with a short tip, and the agent accepts or dismisses it. With **Let the AI make selections
on the page** switched on, it selects dropdown/radio/checkbox answers itself (high or medium
confidence; never typed text), marked purple. Its selections are listed at the end of the panel's
report and in a note at the bottom of the rater page, and the page's Continue is not clicked
until the agent approves them (or rejects one and answers it themselves).

Model: OpenAI **GPT-6 Luna** (`gpt-6-luna`) through the Responses API, with each agent's own API
key (set under **AI assistant** in the side panel). Model name and key are per-agent settings.

## Where it sits

```mermaid
flowchart LR
  subgraph Agent's Chrome
    PDF[Intake PDF] --> Panel
    subgraph Panel[Side panel]
      N[normalize.js<br/>client record + warnings]
      P[plan.js + carriers/progressive.js<br/>TNI rules → fill steps]
      A[ai/assist.js<br/>leftovers → request → checked suggestions]
      UI[Suggestions<br/>Accept / Dismiss]
    end
    subgraph Rater[Progressive page]
      K[pagekit.js<br/>fill · answer · marks]
    end
    Panel -- fill(plan) --> K
    K -- report: filled / unknown / failed / needs<br/>+ options, section, current --> A
    A --> UI
    UI -- answer(choice) --> K
  end
  A -- HTTPS, agent's API key --> O[(OpenAI Responses API<br/>gpt-6-luna)]
  Panel -- usage events<br/>ai_suggest / ai_decision --> S[(Usage server<br/>server/index.mjs)]
  S --> L[npm run learn<br/>→ new TNI rules]
  L -. reviewed rules .-> P
```

## One page, step by step

```mermaid
sequenceDiagram
  autonumber
  actor Agent
  participant Panel as Side panel
  participant Kit as pagekit (rater page)
  participant AI as OpenAI gpt-6-luna

  Agent->>Panel: Fill this page
  Panel->>Kit: fill(plan)
  Kit-->>Panel: report (filled, unknown, failed, noData, leftRequired)
  Panel->>Panel: collectItems(): drop never-list questions (MVR/CLUE, exclusions, signatures, payment, typed IDs)
  Panel->>AI: instructions + TNI rules (cached prefix) + intake + questions<br/>JSON schema: choice ∈ field's options ∪ {leave}
  AI-->>Panel: per question: choice, tip, basis, intakePath, confidence
  Panel->>Panel: parseResponse(): choice must be an option, cited intake path must exist, autoOk only if high + intake/rule
  alt auto-select on and autoOk
    Panel->>Kit: answer(choice)
    Kit-->>Panel: kept by the page? (settle + re-read) → purple mark
  end
  Panel-->>Agent: suggestions with tips
  Agent->>Panel: Accept
  Panel->>Kit: answer(choice)
  Kit-->>Panel: ok → purple mark / not kept → red mark + reason
```

## What the AI may do

```mermaid
flowchart TD
  Q[Question left for the agent] --> NL{On the never-list?<br/>MVR/CLUE · exclude driver · sign/attest/authorise<br/>bank/card/SSN · typed VIN/licence/DOT/MC}
  NL -- yes --> X[Not sent to the AI]
  NL -- no --> M[AI answers]
  M --> V{choice is one of<br/>the page's options?}
  V -- no --> LV[Shown as 'leave for you'<br/>+ 'checked by the extension' note]
  V -- yes --> B{dropdown/radio/checkbox,<br/>confidence high or medium,<br/>changes the answer?}
  B -- no --> SG[Suggestion: Accept / Dismiss]
  B -- yes --> AU{AI selections setting on?}
  AU -- no --> SG
  AU -- yes --> AP[Selected by the AI, purple<br/>Continue held until approved]
  SG -- Accept --> AP2[Put in, purple]
  AP --> CHK{Page kept it?}
  AP2 --> CHK
  CHK -- yes --> OK[Done · later fills leave it alone]
  CHK -- no --> RED[Red mark + reason]
```

Rules the code enforces, whatever the model says:

- It can only return text. It can't click, navigate or submit. Answers go through the same
  `apply()` and "did the page keep it" check as rule-based answers (`pagekit.answer`).
- Dropdown, radio and checkbox answers must be one of the field's options. Strict structured
  outputs enforce this, and `parseResponse` checks it again.
- A cited intake path must hold a value; otherwise the answer loses its "intake" basis and high
  confidence.
- Typed text is never auto-selected. Answers the page already shows are not re-selected.
- The fixed instructions and TNI rules (`src/ai/tni-rules.js`) come first in every request, so
  the provider can cache them.

## Files

| File | Role |
| --- | --- |
| `src/ai/assist.js` | Leftovers → request, OpenAI call, response checks, auto-select rule |
| `src/ai/tni-rules.js` | TNI's quoting rules as the model reads them (keep in step with `carriers/progressive.js`) |
| `src/content/pagekit.js` | `answer()` puts in a chosen option and verifies it; flagged fields carry options/section/current; purple `ai` mark |
| `sidepanel/sidepanel.js` | `runAssist`, `applyAi`, `renderAi`, AI settings |
| `server/index.mjs` | Accepts `ai_suggest` and `ai_decision` usage events |
| `test/assist.test.mjs` | Schema, never-list, response checks, error messages |

## Usage events (for measuring the pilot)

| Event | Contents |
| --- | --- |
| `ai_suggest` | model, time, questions sent, suggested / leave / auto-eligible counts, held-back count, tokens, error |
| `ai_decision` | question id and text, `accepted` / `dismissed` / `auto` / `failed`, the chosen option (never typed text), confidence, basis, intake path |

Acceptance rate per question = `accepted` ÷ (`accepted` + `dismissed`), and agent changes after
an AI answer show up as ordinary `field_change` events. Those two numbers decide which question
types can be auto-selected for everyone, and which should become plain TNI rules.

## Roadmap

```mermaid
flowchart LR
  P0["<b>Now: Phase 1</b><br/>Suggestions + tips<br/>Accept / Dismiss<br/>opt-in auto-select<br/>5 agents, own keys"]
  P1["<b>Phase 2</b><br/>Measure the pilot<br/>acceptance per question<br/>eval on the bake-off course"]
  P2["<b>Phase 3</b><br/>Intake reading<br/>claims box, business class,<br/>free text → proposed edits"]
  P3["<b>Phase 4</b><br/>AI-drafted rules<br/>weekly batch over usage log<br/>→ reviewed PRs to progressive.js"]
  P4["<b>Phase 5</b><br/>GEICO + new states<br/>AI tips from day one,<br/>rules follow"]
  P5["<b>Phase 6</b><br/>Server-held key<br/>per-agent tokens, spend caps,<br/>central prompt/model updates"]
  P0 --> P1 --> P2 --> P3 --> P4
  P1 --> P5
```

```mermaid
gantt
  title Suggested timeline (adjust to the pilot's results)
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Pilot
  Web Store private listing, 5 agents     :p1, 2026-10-05, 7d
  Pilot with suggestions only             :p2, after p1, 14d
  Turn on auto-select per question type   :p3, after p2, 7d
  section Measure
  Bake-off eval (AI on removed rules)     :m1, 2026-10-12, 7d
  Weekly acceptance report                :m2, after p2, 21d
  section Build
  Intake reading (Phase 3)                :b1, after p2, 10d
  AI-drafted rules (Phase 4)              :b2, after b1, 10d
  GEICO capture + rules (Phase 5)         :b3, after b2, 21d
  Server-held key (Phase 6, when > ~10 agents) :b4, after p3, 7d
```

### The feedback loop the roadmap builds

```mermaid
flowchart LR
  F[Fill: rules] --> L[Leftovers]
  L --> AI[AI suggests]
  AI --> D{Agent decides}
  D --> LOG[(ai_decision<br/>field_change)]
  LOG --> LR[Weekly: learn + AI-drafted rules]
  LR --> RV[Developer reviews PR]
  RV --> F
```

Each question the AI keeps getting right becomes a plain rule, which is free, instant and
tested. The AI then handles only the next set of new questions (new states, new products,
GEICO).
