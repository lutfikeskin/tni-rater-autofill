# Spec: agents' own defaults ("My defaults")

Status: **proposal**, not implemented. Written 2026-11-05 from the code on `main` (530f86f).

## Goal

Agents can replace TNI's standard answers with their own, from Settings, without changing how anything else is decided. There are two levels:

1. **TNI defaults** (basic): the shared coverage amounts every carrier fills, set once for all carriers.
2. **Advanced**: the same amounts per carrier, each carrier's own coverage standards, and the option to make any TNI standard "ask me" instead of filled.

Nothing here lets a default answer a question the client answers, or one that only the agent may answer.

## What exists today

- Every answer has a `source` (`SOURCES` in [plan.js](../src/plan.js)): `intake`, `derived`, `standard`, `fact`, `attestation`. Only `standard` is TNI's assumption; `fact` and `attestation` are never filled (`manualOnly`).
- There are 92 rules with `source: 'standard'`: Progressive 51, AmWINS 28, GEICO 13. They come in two kinds:
  - **Coverage standards**: amounts read from `STANDARDS` in [standards.js](../src/standards.js) (UM CSL $100K, Med Pay $5K, comp/coll deductible $1K, rental $40/day and $1,200 total), plus amounts kept in one carrier's file (AmWINS towing $75, GEICO's UM deductible and type, Progressive's MD PIP, GEICO's Texas UM split, Progressive's SC BI & PD).
  - **Workflow standards**: assumptions TNI makes when the intake is blank (hazmat No, owner drives Yes, continuous coverage Yes, federal filing No, years with the current carrier, and so on). An intake answer always wins over these.
- The intake has **no field** for any coverage standard. The only intake input that touches one is a line in the notes declining physical damage (`noPhysicalDamage`, GEICO), which hands comp and collision to the agent.
- The panel builds the plan (`buildPlan` in `sidepanel/panel/coordinator.js`, `core.js`, `fill.js` and `usage.js`). The page kit receives finished steps and never reads `STANDARDS`.
- `STANDARDS` is also read by:
  - the AI rulebook (`src/ai/rulebook/*.js`), so Luna is told the amounts;
  - rule names (`name: 'Medical payments per person (standard: $5,000)'`), computed when the module loads;
  - module-level constants (`const MED_PAY = usd(STANDARDS.medPay)`, `UM_CSL`);
  - `test/standards.test.mjs`;
  - the rules fingerprint (`RULE_FILES` in [usage.js](../src/usage.js)).
- The collection server drops any `source` outside the five known values (`server/index.mjs:331`).

## Priority order

From highest to lowest. The first one that has an answer decides.

| # | Who decides | Notes |
| --- | --- | --- |
| 1 | The agent on the page, or in the panel's edit | Unchanged; answer retention keeps it |
| 2 | `intake` / `derived` | What the client asked for |
| 3 | A rule's own exception: a state or carrier rule whose source isn't `standard`, or a hand-off to the agent (`fact`, `attestation`, physical damage declined in the notes) | Unchanged: a default never reaches these |
| 4 | **Agent default, advanced** (this carrier) | New |
| 5 | **Agent default, basic** (all carriers) | New |
| 6 | TNI `standard` | Unchanged |

Two invariants make this safe:

- **A default only ever replaces a value that would have been `standard`.** Plan building decides the source exactly as it does today. Only when that result is `standard` does it look at the agent's defaults. Steps 1–3 can't be changed by construction.
- **TNI locks.** A standard TNI marks `locked` skips steps 4 and 5.

## The new source

- `source: 'agent-default'` is added to `SOURCES`. It is neither one of the agent's own sources nor `manualOnly`: the step is filled.
- A step whose agent default equals TNI's value stays `standard`, so logs don't fill up with no-op overrides.
- `standard: false`, plus a new step flag `agentDefault: true` carrying TNI's value (`tniValue`), so the report can show both.
- **Review mode** (a business class not validated for the carrier) treats it like a standard: `reviewRequired`, so Continue waits.
- Panel and page marking: its own tag "your default", and on the carrier page its own colour (neither the blue standard nor the green intake). The fill report reads "Med Pay $1,000 (your default; TNI: $5,000)".
- `isStandard` stays TNI-only. A new `isAgentDefault` is added in [resolution.js](../src/resolution.js).

## Settings UI

### TNI defaults (basic)

A Settings section titled **TNI defaults** shows one row per shared coverage concept:

| Row | TNI's value | Choices |
| --- | --- | --- |
| Uninsured / underinsured motorist (CSL) | $100,000 | Use TNI's · listed amounts |
| Medical payments | $5,000 | Use TNI's · listed amounts |
| Comprehensive deductible | $1,000 | Use TNI's · listed amounts |
| Collision deductible | $1,000 | Use TNI's · listed amounts |
| Rental reimbursement | $40/day, $1,200 | Use TNI's · listed pairs |

- Each row defaults to **Use TNI's**. That stores nothing, so it follows TNI when TNI changes its standard.
- Choices are **pick-lists only, no free text**. Each list is the intersection of amounts every carrier sells, kept in code (below). An amount only some carriers sell goes under Advanced.
- A **Reset all to TNI** button.
- When TNI has changed its value since the agent picked theirs, the row shows "TNI's is now $X".

Comp and collision are split here because carriers ask them separately. Today they share one `STANDARDS.deductible`; the registry keeps that as TNI's value for both.

### Advanced

A collapsed **Advanced** section below it, with one group per carrier:

- **Per-carrier amounts**: the basic rows again, with "Same as above" as the default, offering every amount that carrier sells.
- **Carrier-only coverage standards**: AmWINS towing; GEICO's UM deductible and UM/UIM type; Progressive's MD PIP; and so on. Each comes with TNI's value and the carrier's own options.
- **Ask me instead**: any standard, coverage or workflow, can be switched to "Ask me". The step then becomes the agent's (`fact`-like: not filled, with a note, `manualOnly`, never Luna's).
- **Workflow standards offer only TNI's answer or "Ask me", never a different fixed answer.** These are assumptions about the client (no hazmat, owner drives, continuously insured). A preset "Yes" or "No" of the agent's own would answer for every client without evidence. "Ask me" moves the answer toward the agent, which is never less correct.
- Per-state overrides are **not in v1** (open question 3).

## Code design

### Registry: `src/defaults.js` (new)

```js
// One entry per overridable standard.
{
  id: 'medPay',                 // stable storage key
  label: 'Medical payments',
  level: 'basic',               // basic | carrier
  kind: 'coverage',             // coverage | workflow (workflow: only 'tni' or 'ask')
  tni: () => STANDARDS.medPay,  // TNI's value, live
  rules: ['progressive.medpay', 'geico.medpay-pip', 'amwins.medpay-pip'], // the `tni` ids it drives
  choices: { all: [1000, 2000, 5000, 10000], progressive: [...], geico: [...], amwins: [...] },
  locked: false,                // TNI may lock it
  ask: true,                    // "Ask me" allowed
}
```

`tni` ids already group the rules (`amwins.um`, `geico.um`, `progressive.um`, and so on), so the registry points at them instead of at single rules.

### Plan

- `buildPlan(record, carrier, active, defaults = null)` resolves the effective standards once (`effectiveStandards(defaults, carrier.id)`). Rules get them as a third argument, `value(record, active, std)`. `null` means TNI's, so every existing caller, mock and test behaves exactly as today.
- Rules move from module constants (`MED_PAY`, `UM_CSL`) to `std.medPay` and friends, and rule names lose their embedded amounts. The step's name or note states the amount instead, computed per plan.
- After the source is decided (the existing line in `fieldSteps`): if `source === 'standard'` and the rule's `tni` id has an override for this carrier, then:
  - with **Ask me**, the source becomes `fact` with the note "You chose to answer this yourself (Settings → TNI defaults)";
  - with a **value**, the source becomes `agent-default` and the value comes from `std`;
  - with a **locked** standard, nothing changes.
- **One source for defaults**: the panel reads them into state once, and every `buildPlan` call in the panel passes `state.defaults`. Otherwise the plan that filled and the plan `usage.js` rebuilds for logging could disagree. A test enforces this: every panel call passes it.

### Values the carrier doesn't sell

The registry's per-carrier `choices` prevent most of these. If the page still lacks the amount (a state's list, or a renamed option), the step is **left to the agent with a note**: "Your default $1,000 isn't offered here; TNI's is $5,000." It does not fall back to TNI silently. A silent fallback would quote something the agent believes they changed.

### Cross-field checks (computed per plan, not trusted to the UI)

- **UM can't exceed the auto liability limit.** If it would, the UM step is left to the agent with a note. This is common in practice: a $1M UM default with a $750K liability.
- **Med Pay coupling.** GEICO's and AmWINS' PIP answers ("PIP No because Med Pay is offered") assume Med Pay is chosen. Basic offers no "None" for Med Pay. If "Ask me" is chosen for Med Pay, the coupled PIP step becomes the agent's too.
- **Rental follows comp and collision** (GEICO): "Ask me" on comp or collision makes rental the agent's.
- Existing state exceptions (GEICO's Texas UM split, Progressive's SC BI & PD, Florida PIP) keep their own sources and are untouched (priority row 3).

### AI (Luna)

- `rulebookFor(carrierId, std)` writes the rulebook text from the effective values. Today it states TNI's amounts, so Luna would contradict an agent default on a re-asked or unfilled coverage field.
- An "Ask me" step is `manualOnly`, so Luna never suggests it. That matches the meaning of "Ask me".
- The AI cache key includes a digest of the effective defaults, so a cached suggestion made under different defaults isn't reused.

### Storage

- `chrome.storage.local`, key `agentDefaults`: `{ [initials]: { v: 1, values: { [id]: { value, tniAtPick } | { ask: true } }, carriers: { [carrierId]: {...} } } }`.
- Keyed by the agent's initials, since computers are shared. Changing initials switches defaults; blank initials use TNI's.
- A new key with a "missing means TNI" reader needs no migration. A later shape change follows [storage-version.js](../src/storage-version.js).
- No client data is stored there, only amounts and choices.

### Logging and review

- **Server first.** `server/index.mjs` must accept `agent-default` in `source` and deploy before any extension that sends it. Otherwise the server silently drops `source` from those events.
- `fill_field.source = 'agent-default'`. `agent_settings` (already logged per quote) gains `defaults`: only the overrides, as `{ id, value | 'ask', carrier? }`, so the review knows what each quote was filled with.
- Add a `defaultsHash` beside the `rules` fingerprint on `fill_run` and `fill_error`: the same rules with different defaults fill different answers.
- **Signals and review**: `source` counts include `agent-default`. A correction of an `agent-default` answer is reported apart from a correction of a TNI standard. It means the agent overrode their own default, not that TNI's rule is wrong.
- **Benchmark and answer key**: replay each quote with the defaults its `agent_settings` logged. Otherwise every agent default reads as "today's rules differ".
- **Developer recordings** store the effective defaults, so a replay reproduces the fill.

## Risk analysis

| # | Risk | Likelihood | Impact | Mitigation in this spec |
| --- | --- | --- | --- | --- |
| R1 | A default overrides a client's request or an agent-only question | Low (by design) | High: wrong quote | The override applies only where `source === 'standard'` after normal resolution; test: no `intake`/`derived`/`fact`/`attestation` step ever changes with any defaults |
| R2 | Workflow standards become preset client facts ("no hazmat" for everyone) | Medium if allowed | High: misrepresentation on an application | Workflow standards offer only TNI's answer or "Ask me" |
| R3 | The amount isn't on the carrier's list and the field fails or falls back silently | Medium | Medium | Per-carrier choice lists; a missing option goes to the agent with a note, never a silent fallback |
| R4 | Invalid combinations: UM > liability, Med Pay none with PIP declined | Medium | High: carrier error or a client without PIP/Med Pay | Cross-field checks in plan building; no "None" for Med Pay in basic |
| R5 | Plans built in different places disagree (fill vs log vs AI) | Medium | Medium: misleading logs, wrong review | One `state.defaults`; test that every panel `buildPlan` call passes it |
| R6 | Server drops the new `source` | Certain if order is wrong | Medium: lost provenance | Deploy server first; consistency test between server whitelist and `SOURCES` |
| R7 | The weekly review, benchmark and answer key read agent defaults as rule errors | High | Medium: noisy reviews, wrong fixes | Log defaults per quote; replay with them; report `agent-default` corrections apart |
| R8 | Luna contradicts the agent's default | Medium | Low–Medium | Rulebook from effective values; cache key includes the defaults digest |
| R9 | A stale pinned default after TNI changes its standard | Medium | Low–Medium | "Use TNI's" stores nothing; a pinned row shows "TNI's is now $X" |
| R10 | The wrong agent's defaults on a shared computer | Medium | Medium | Keyed by initials; the panel header shows "Your defaults: 2 changed" while any override is active |
| R11 | Answer retention or `replace` / `keepChoice` behaviour changes | Low | Medium | Only `value` and `source` change; a rule's `replace`, `keepChoice` and similar flags are untouched; carrier mocks are run with overrides |
| R12 | Refactoring 92 rules (names, constants) changes today's answers | Medium | High | Phase 1 ships plumbing only, proven identical with `npm run benchmark -- --against` and `test/standards.test.mjs` |
| R13 | Review mode (unvalidated class) is bypassed by a default | Low | Medium | `agent-default` is `reviewRequired` exactly when `standard` would be |
| R14 | Agents' quotes drift from TNI policy unnoticed | Medium | Business, not technical | `agent_settings.defaults` lets the weekly review list who overrides what; TNI can lock |

## Rollout

1. **Server.** Accept `agent-default` in `source`, `defaults` in `agent_settings` and `defaultsHash` on fill runs, then deploy. This changes no behaviour. *Done in code; see [hosting](hosting.md).*
2. **Plumbing, no UI.** Add the registry, the `std` argument, rule names without amounts, `isAgentDefault`, and the rulebook from effective values. Prove nothing changed: `npm test`, the carrier mocks, and `npm run benchmark -- --save` on `main` then `--against` on the branch with zero differences.
3. **Basic UI.** Add the TNI defaults section, the page colour, the report tag and logging. Test the e2e with an override on each carrier mock.
4. **Advanced.** Add per-carrier amounts, carrier-only coverage standards, and "Ask me".
5. **Review tooling.** Update signals, review, benchmark and answer key for `agent-default` and the logged defaults.

Each step is its own PR. Steps 2–5 update [intake-and-rules.md](intake-and-rules.md) (the provenance table and the new source), [learning.md](learning.md) (`agent_settings.defaults`, signals), [ai-assistant.md](ai-assistant.md) (the rulebook from effective values), [hosting.md](hosting.md) (the server whitelist) and [testing.md](testing.md).

## Tests to add

- **Isolation:** for every carrier's rules and a set of records, any combination of defaults changes only steps whose no-defaults source is `standard`.
- **Null defaults:** `buildPlan(..., null)` deep-equals today's plan for every fixture intake.
- **Locked:** a locked standard ignores any override.
- **Ask me:** the step is `manualOnly` with the note; coupled PIP and rental steps follow.
- **Unsold amount:** the step goes to the agent with a note, with no fallback.
- **UM above liability:** the step goes to the agent.
- **Review mode:** an `agent-default` step is `reviewRequired`.
- **Server and extension agree on `SOURCES`.**
- **Every panel `buildPlan` call passes `state.defaults`.**
- **Rulebook:** text follows the effective values (an extension of `test/standards.test.mjs`).
- **E2E:** a packaged extension with a Med Pay override on each carrier mock; the page shows it and the log carries `agent-default`.

## Open questions for TNI

1. May agents override TNI's coverage standards at all, and which ones? Which should TNI lock?
2. Should "Ask me" be allowed for every workflow standard, or only some?
3. Per-state defaults in Advanced (for example a different UM in no-fault states): needed, or later?
4. Defaults stored per computer and initials, or synced through the collection server so they follow the agent?
5. Should the weekly review alert when an agent's default differs from TNI's, or only count it?
