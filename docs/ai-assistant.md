# AI assistant: rule-first Jev architecture

The rules engine remains the source of decisions that can be made exactly. It reads the intake,
applies carrier mappings and TNI's written rules, and fills the page. The AI assistant handles the
small remainder: an unresolved radio, select or checkbox where the carrier's available options do
not have an exact deterministic mapping.

The provider is TypeSafe AI **Jev** (`jev-1.13.0` by default) through
`https://api.typesafe.ai/v1/systemone`. The agent's Jev key and model are stored per device in the
extension settings. The legacy OpenAI key and model settings are not sent to any provider.

Jev is a choice and recommendation layer, not a replacement for the rule engine. It can return one
of the options the page actually offers or `leave` for the agent. It does not create text for form
fields, infer typed identifiers, click controls, navigate pages, perform lookups or submit a quote.

## Where it sits

```mermaid
flowchart LR
  subgraph Agent's Chrome
    PDF[Intake PDF] --> Panel
    subgraph Panel[Side panel]
      N[normalize.js<br/>client record + warnings]
      P[plan.js + carrier rules<br/>TNI rules → fill steps]
      A[ai/assist.js<br/>unresolved choices → Jev → evidence checks]
      UI[Suggestions<br/>Accept / Dismiss]
    end
    subgraph Rater[Carrier page]
      K[pagekit.js<br/>fill · answer · marks]
    end
    Panel -- fill(plan) --> K
    K -- report: filled / unknown / failed / needs<br/>+ options, section, current --> A
    A --> UI
    UI -- answer(choice) --> K
  end
  A -- HTTPS, Jev key --> O[(TypeSafe AI<br/>Jev jev-1.13.0)]
  Panel -- usage events<br/>ai_suggest / ai_decision --> S[(Usage server<br/>server/index.mjs)]
  S --> L[npm run learn<br/>→ reviewed TNI rules]
  L -. reviewed rules .-> P
```

## One page, step by step

```mermaid
sequenceDiagram
  autonumber
  actor Agent
  participant Panel as Side panel
  participant Kit as pagekit (rater page)
  participant AI as TypeSafe AI Jev

  Agent->>Panel: Fill this page
  Panel->>Kit: fill(plan)
  Kit-->>Panel: report (filled, unknown, failed, noData, leftRequired)
  Panel->>Panel: collectItems(): keep unresolved choice controls; drop never-list questions
  Panel->>AI: current options + active intake facts + carrier-scoped TNI rules
  AI-->>Panel: exact choice or leave + evidence + confidence
  Panel->>Panel: check option, evidence, active context and stale request
  Panel->>AI: proposed choice + selected evidence + active intake
  AI-->>Panel: support probability (Noul)
  Panel->>Panel: validate verification and automatic-selection thresholds
  alt auto-select enabled and conservative checks pass
    Panel->>Kit: answer(choice)
    Kit-->>Panel: kept by the page? (settle + re-read) → purple mark
  end
  Panel-->>Agent: suggestions with reasons and evidence
  Agent->>Panel: Accept
  Panel->>Kit: answer(choice)
  Kit-->>Panel: ok → purple mark / not kept → red mark + reason
```

## What Jev may do

```mermaid
flowchart TD
  Q[Question left for the agent] --> NL{On the never-list?<br/>MVR/CLUE · exclude driver · sign/attest/authorise<br/>bank/card/SSN · typed VIN/licence/DOT/MC}
  NL -- yes --> X[Not sent to Jev]
  NL -- no --> C{Radio, select or checkbox<br/>with carrier options?}
  C -- no --> T[Stay with deterministic rules<br/>or the agent; no generated text]
  C -- yes --> M[Jev evaluates the available choices]
  M --> V{choice is one of<br/>the page's options or leave?}
  V -- no --> LV[Shown as 'leave for you'<br/>+ checked by the extension]
  V -- yes --> E{Intake or carrier rule evidence<br/>supports the choice?}
  E -- no --> LV
  E -- yes --> R{Second verification passes<br/>and context is current?}
  R -- no --> SG[Suggestion only or leave for agent]
  R -- yes --> AU{AI selections setting on?}
  AU -- no --> SG
  AU -- yes --> AP[Selected by Jev, purple<br/>Continue held until approved]
  SG -- Accept --> AP2[Put in, purple]
  AP --> CHK{Page kept it?}
  AP2 --> CHK
  CHK -- yes --> OK[Done · later fills leave it alone]
  CHK -- no --> RED[Red mark + reason]
```

Rules the code enforces, whatever Jev says:

- Rules and exact carrier mappings run before Jev. Jev never overrides a deterministic answer.
- The request contains only unresolved choice controls. Typed text, dates, amounts and identifiers
  stay with deterministic rules or the agent.
- A choice must be one of the page's current options. `leave` is always available, including when
  the model is uncertain or the evidence is incomplete.
- Evidence is selected from the active intake facts and the carrier-scoped TNI rules. The source must
  be one of the supplied intake facts or carrier rules; Jev then checks its relevance in a second call. The
  active driver, vehicle and trailer indexes are checked before the answer is used.
- A second verification stage checks the proposed option against the selected evidence. Model
  probabilities and confidence labels are signals for this process, not accuracy guarantees.
- Only a high-confidence answer with valid evidence and a passing verification can become an
  automatic candidate. The agent must opt into automatic selections, and the existing
  approve-before-Continue boundary remains in force.
- Answers the page already shows are not re-selected. After applying a choice, the page is read
  again; if it did not keep the answer, the result is marked failed for the agent.
- A manual edit wins over a pending or previously returned Jev answer. Context and edit checks
  prevent a late response from overwriting what the agent changed.
- Requests and responses are tied to the intake and active context. Late responses or responses
  after an intake, driver or vehicle edit are discarded.

## Data and settings

The request is sent directly from the extension to TypeSafe AI only when **Jev assistant** is on.
It contains the unresolved carrier questions and options, the active intake context needed to
interpret them, and the applicable TNI rules. The Jev key is stored locally per device and is
never written to usage events or logs. The extension does not send the key to the collection
server. MVR/CLUE orders, exclusions, signatures and attestations, payment or bank details, and
typed identifiers are excluded before a request is built.

The settings are separate from the old OpenAI settings:

| Setting | Purpose |
| --- | --- |
| `aiOn` | Enables Jev requests and suggestions. |
| `aiAuto` | Opts into applying eligible choice suggestions before the agent approves Continue. |
| `jevKey` | The agent's TypeSafe AI key, stored on that device and never logged. |
| `jevModel` | Jev model name; the default is the pinned `jev-1.13.0`. |

If no Jev key is configured, the rules engine still works and unresolved questions remain for the
agent. A live key is not part of the repository or test fixtures.

Automatic selection uses pinned `jev-1.13.0`, choice probability at least 0.98, derived
confidence at least 0.97, a top-to-runner-up margin of at least 0.95, evidence probability
at least 0.98, and verified support at least 0.99. Numerical/date/identity questions remain
manual recommendations. These are conservative starting thresholds, not calibrated accuracy.
A different configured model can suggest answers but cannot automatically select them until
its policy is explicitly validated in code. Requests batch four fields at a time, with two
stages per batch and bounded retries for 429/529 responses.

## Files

| File | Role |
| --- | --- |
| `src/ai/assist.js` | Unresolved choices → Jev request, response/evidence checks, auto-select eligibility |
| `src/ai/tni-rules.js` | TNI's carrier-scoped quoting rules as Jev reads them; keep in step with carrier rules |
| `src/content/pagekit.js` | `answer()` puts in a chosen option and verifies it; flagged fields carry options/section/current; purple `ai` mark |
| `sidepanel/sidepanel.js` | `runAssist`, `applyAi`, `renderAi`, Jev settings and approval boundary |
| `server/index.mjs` | Accepts `ai_suggest` and `ai_decision` usage events without receiving the Jev key |
| `test/assist.test.mjs` | Choice schema, never-list, evidence/response checks, stale-result and error handling |

## Usage events and evaluation

| Event | Contents |
| --- | --- |
| `ai_suggest` | model, time, choice questions sent, suggested / leave / auto-eligible counts, held-back count, provider usage, error |
| `ai_decision` | question id and redacted label, `accepted` / `dismissed` / `auto` / `failed`, chosen option (never typed text), confidence, evidence basis and intake path |

The key and client values are never logged. Agent changes after a Jev answer show up as ordinary
`field_change` events. Acceptance rate per question is `accepted` ÷ (`accepted` + `dismissed`),
but acceptance alone is not accuracy. The pilot also measures independently checked answer
accuracy, confidently-wrong answers, appropriate abstentions, evidence-verification failures,
latency and cost. A Jev confidence or probability value is not used as a measured accuracy rate.

The automated tests use deterministic mocked provider responses. They verify request boundaries,
choice validation, evidence checks, stale-response protection, manual edits and approval before
Continue; they do not establish Jev's live-model accuracy or latency.

## Rollout and learning loop

```mermaid
flowchart LR
  P0["<b>Current</b><br/>Rules first<br/>Jev choice suggestions<br/>leave / evidence / verification"]
  P1["<b>Measure</b><br/>Mocked provider tests<br/>live agent decisions<br/>accuracy and abstentions"]
  P2["<b>Controlled automation</b><br/>Opt-in verified choices<br/>approve before Continue<br/>per-question review"]
  P3["<b>Promote stable answers</b><br/>Repeated verified choices<br/>become deterministic TNI rules<br/>with tests"]
  P4["<b>Expand coverage</b><br/>New states, products and carriers<br/>only after captures and evaluation"]
  P0 --> P1 --> P2 --> P3 --> P4
```

```mermaid
flowchart LR
  F[Fill: deterministic rules] --> L[Unresolved choice controls]
  L --> AI[Jev suggests or abstains]
  AI --> V[Evidence + second verification]
  V --> D{Agent decides}
  D --> LOG[(ai_decision<br/>field_change)]
  LOG --> LR[Review: accuracy, errors, abstentions]
  LR --> RV[Developer reviews a rule change]
  RV --> F
```

Each choice that repeatedly passes evidence verification and agent review can become a plain rule,
which is fast, deterministic and tested. Jev then handles only the next set of unresolved
questions while the system keeps a conservative abstention path.
