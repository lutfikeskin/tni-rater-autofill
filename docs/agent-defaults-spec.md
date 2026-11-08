# Spec: agents' own defaults ("My defaults")

Status: **in progress**, on in the unpacked copy and hidden from agents' store build until TNI's managers approve it (`RELEASED_TO_AGENTS`, below). Written 2026-11-05 from the code on `main` (530f86f). Done: the server (rollout step 1), the generic hooks (step 2), the module (step 3), the review tooling (step 4), the TNI defaults page with its logging (step 5), and Advanced's per-carrier amounts and "Ask me" (step 6). Not yet: carrier-only coverage standards (step 6; which ones is TNI's to list). TNI's answers to the open questions below are pending; until then the maintainer's provisional choices (recorded there) apply.

## Goal

Agents can replace TNI's standard answers with their own, from Settings, without changing how anything else is decided. There are two levels:

1. **TNI defaults** (basic): the shared coverage amounts every carrier fills, set once for all carriers.
2. **Advanced**: the same amounts per carrier, each carrier's own coverage standards, and the option to make a TNI standard "ask me" instead of filled, except a workflow standard other answers rest on (owner drives; see below).

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

- `source: 'agent-default'` (`AGENT_DEFAULT_SOURCE` in the module). Core's `SOURCES` in [plan.js](../src/plan.js) stays without it, so the source exists only while the module does; the server accepts `SOURCES` and `agent-default` (`FIELD_SOURCES` in `server/agent-defaults.mjs`, held to them by `test/consistency.test.mjs`). It is neither one of the agent's own sources nor `manualOnly`: the step is filled.
- A step whose agent default equals TNI's value stays `standard`, so logs don't fill up with no-op overrides.
- `standard: false`, plus `agentDefault: { id, amount, tni }` on the step (the standard's id, and the agent's amount and TNI's as the panel says them: "$2,000", "$5,000"), so the report can show both; on "Ask me" it is `{ id, ask: true }`.
- **Review mode** (a business class not validated for the carrier) treats it like a standard: `reviewRequired`, so Continue waits.
- Panel and page marking: its own tag "your default", and on the carrier page its own colour (neither the blue standard nor the green intake). The fill report reads "Med Pay $1,000 (your default; TNI: $5,000)".
- `isStandard` in [resolution.js](../src/resolution.js) stays TNI-only. `isAgentDefault` lives in the module (`src/agent-defaults/`), not in `resolution.js`.

## Settings UI

### TNI defaults (basic)

A Settings row titled **Your defaults**, folded like AI's, says the profile in force and how many amounts it changes ("Jordan K. · 2 changed"); its tooltip says what the section does. Opened, it shows one row per shared coverage concept:

| Row | TNI's value | Choices |
| --- | --- | --- |
| Uninsured / underinsured motorist (CSL) | $100,000 | Use TNI's · listed amounts |
| Medical payments | $5,000 | Use TNI's · listed amounts |
| Comprehensive deductible | $1,000 | Use TNI's · listed amounts |
| Collision deductible | $1,000 | Use TNI's · listed amounts |
| Rental reimbursement | $40/day, $1,200 | Use TNI's · listed pairs |

- Each row defaults to **Use TNI's**. That stores nothing, so it follows TNI when TNI changes its standard.
- Choices are **pick-lists only, no free text**. Each list is the intersection of amounts every carrier sells, kept in code (below). An amount only some carriers sell goes under Advanced.
- At the top, the **profile** these defaults belong to: pick one, create one, or none (TNI's everywhere). See Storage.
- A **Reset all to TNI** button.
- When TNI has changed its value since the agent picked theirs, the row shows "TNI's is now $X".

Comp and collision are split here because carriers ask them separately. Today they share one `STANDARDS.deductible`; the registry keeps that as TNI's value for both.

### Advanced

A folded **Per carrier** row, the last of the section's rows. Opened, its first line says which answers it makes the agent's (not a tooltip, which keyboard users never see), then one group per carrier:

- **Per-carrier amounts**: the basic rows again, with "As above" as the default, offering every amount that carrier sells. Where the basic row replaces the standard, "TNI's" is offered too, so one carrier can keep TNI's amount. *Done: `Advanced` in `sidepanel/panel/agent-defaults/view.jsx` (collapsed, a group per carrier the registry lists), stored as the profile's `carriers` (the store's `setCarrier`).*
- **Carrier-only coverage standards**: AmWINS towing; GEICO's UM deductible and UM/UIM type; Progressive's MD PIP; and so on. Each comes with TNI's value and the carrier's own options. *Not yet: each needs a registry entry and `std` on its rules, and TNI's list of which.*
- **Ask me instead**: a coverage standard, or a workflow standard whose assumption reaches only its own step and listed dependents, can be switched to "Ask me". *Done for the five coverage amounts, per carrier (open question 2's provisional answer); no workflow standard is offered.* Owner drives can't: other answers read its assumption directly (below), so the agent corrects it in All client details instead. The step then becomes the agent's (`fact`-like: not filled, with a note, `manualOnly`, never Luna's).
- **Workflow standards offer only TNI's answer or "Ask me", never a different fixed answer.** These are assumptions about the client (no hazmat, continuously insured). Owner drives is one too, but it offers no "Ask me" either (below). A preset "Yes" or "No" of the agent's own would answer for every client without evidence. "Ask me" moves the answer toward the agent, which is never less correct.
- Per-state overrides are **not in v1** (open question 3).

## Code design

The feature lives in its own modules. Core code (plan building, rules, the page kit, the report, Luna) only gets small **generic hooks** that know nothing about agent defaults. With no defaults, or with the feature switched off or removed, each hook does nothing and every answer is exactly today's.

### Where everything lives

| Part | Where | Knows about agent defaults? |
| --- | --- | --- |
| Registry of overridable standards (data only) | `src/agent-defaults/registry.js` | Yes |
| The overlay: plan step in, plan step out; cross-field checks | `src/agent-defaults/overlay.js` (**done**, switched off) | Yes |
| Effective defaults, the off switch, Luna's rulebook rewrite, their log entries; `defaultsHash` from step 5 | `src/agent-defaults/index.js` (the module's entry point; **done**, switched off) | Yes |
| Storage, the quote's question and hold, logging, and the Settings section | `sidepanel/panel/agent-defaults/store.js`, `view.jsx` (**done**) | Yes |
| Server shapes | `server/agent-defaults.mjs` (**done**, PR #299) | Yes |
| Plan building | `src/plan.js`: an optional `overlay` hook | No |
| Rules | `std` metadata on standard rules: data, ignored without the module | Describes them only |
| The panel's plans | one `planFor()` wrapper in the panel, used by every `buildPlan` call | Wires the module in, one line |
| Report tag and page colour | the report's row kind `own` ("Your default"), the live row's tag, the key, and the page kit's `own` mark (teal, `COLORS` in `src/kit/marks.js`) | One entry each |
| Luna's rulebook | an optional `rewrite` hook on `rulebookFor` | No |

The rule is that **only `src/agent-defaults/` and `sidepanel/panel/agent-defaults/` import from `src/agent-defaults/`**, apart from the one wiring line in `planFor()`, the one in Luna's evidence (`src/ai/common.js`, the rulebook rewrite), the review tooling's adapter (`scripts/lib/agent-defaults.mjs`) and, from step 5, one in usage logging. `test/agent-defaults.test.mjs` fails on any other importer.

### Registry: `src/agent-defaults/registry.js`

```js
// One entry per overridable standard: data only (DefaultEntry in types.js).
{
  id: 'medPay',                 // a STANDARD_IDS key (src/standards.js): the storage key, the log's id,
                                // and the `std` id its rules carry; TNI's amount comes from there, live
  label: 'Medical payments',
  choices: { all: [500, 1000, 2000, 5000], progressive: [...], geico: [...], amwins: [...] },
  dependents: [{ carrier: 'geico', concept: 'coverage.pip', tni: 'geico.medpay-pip' }, ...],
  locked: false,                // TNI may lock it: nothing stored replaces it
}
```

`choices.all` is what every carrier sells (the TNI defaults page); a carrier's own list is what its Advanced row offers, from the carriers' captured layouts. Only the five shared coverage amounts are in the registry today. Workflow standards (owner drives and the like) are not: see the cross-field checks below.

The registry lists no rules. An override reaches **only the rules that carry its id in their own `std` field** (below), never everything sharing a `tni` id or a `concept`. Those groups are too coarse: GEICO's `geico.medpay-pip` (and concept-wise its PIP) holds Basic PIP beside Medical Payments, and `geico.um` holds the UM deductible and UM/UIM type beside the UM limits. A Med Pay or UM amount must never land in those. They carry no `medPay` or `umCsl` `std`; one may later get its own registry id (`umDeductible`). Taking an entry out of the registry puts that one standard back to TNI's everywhere. A stored default whose id the registry no longer has is ignored.

### Rules: metadata, not rewrites

Each standard rule an override may change gains a `std` field. The field names its registry id, how the rule writes an amount in this carrier's words, and where the default applies (`applies`). The rule's own `value` stays as it is, so the rule still gives TNI's answer by itself:

```js
// Progressive writes "$5,000 per person" (MED_PAY).
{ q: '1FE4', tni: 'progressive.medpay', source: 'standard', ..., value: () => MED_PAY,
  std: { id: 'medPay', write: (amount) => `${usd(amount)} per person`, name: (amount) => `Medical payments per person (standard: ${usd(amount)})` } }

// GEICO writes "$100,000 Combined Single Limit" (UM_LIMIT), and picks Texas' split inside the same
// `standard` rule: the default stays out of Texas.
{ q: 'UninsuredMotorist', tni: 'geico.um', source: 'standard', value: (r) => (texas(r) ? UM_SPLIT : UM_LIMIT), ...,
  std: { id: 'umCsl', applies: (r) => !texas(r), write: (amount) => `${usd(amount)} Combined Single Limit`, ... } }

// Progressive's comprehensive deductible also takes a glass-deductible option of the same amount.
{ q: '1FCD', tni: 'progressive.deductibles', source: 'standard', ..., value: () => DEDUCTIBLE,
  choiceAliases: () => [`${DEDUCTIBLE} w/ $0 Glass Deductible`],
  std: { id: 'compDeductible', write: (amount) => `${usd(amount)} Deductible`,
    aliases: (amount) => [`${usd(amount)} Deductible w/ $0 Glass Deductible`] } }
```

- **Exact targets.** A rule gets `std` only for the one answer it writes. A rule that answers something else under the same `tni` id or `concept` (Basic PIP, UM deductible, UM/UIM type) gets none.
- **State and carrier exceptions stay TNI's.** A `standard` rule that branches inside its `value` (GEICO's Texas UM split, Florida PIP, Progressive's SC BI & PD) declares `applies`, which is false wherever the rule gives the exception. There the overlay leaves the step's answer unchanged and sets `defaultInfo` to "TX: TNI's $100,000/$300,000 applies here (its own exception), not your default", so the agent sees why their default didn't apply. It is **never `note`**: to the page kit a step with a `note` is the agent's and isn't filled (`!s.note` in `src/kit/cursor.js`), so a note would leave Texas' UM blank instead of TNI's split. `defaultInfo` is shown in the panel's report only; the page kit and the resolution don't read it. `source === 'standard'` alone is not enough: these exceptions are `standard` too.
- **Amount-bearing text.** A rule whose `note` or `unofferedNote` states the amount (GEICO's "doesn't list $5,000 medical payments") gives `std.note(amount)` too.
- **Aliases follow the amount.** The page kit tries a step's `choiceAliases` before matching by amount, so an alias left at TNI's amount could pick "$1,000 Deductible w/ $0 Glass Deductible" for a $500 default even with "$500 Deductible" listed. A rule with `choiceAliases` that name the amount gives `std.aliases(amount)`, and the overlay replaces the step's aliases with them. If it doesn't, the overlay drops the step's aliases rather than keep a stale one.
- **Held to the rule.** For every fixture record and for one synthetic record per state (50 states and DC), wherever `applies` is true: `std.write(TNI's amount)` equals the rule's value, `std.name(TNI's amount)` equals its name, `std.note` equals its note, and `std.aliases(TNI's amount)` equals its `choiceAliases`. A rule carrying the wrong `std` fails this, because a PIP rule's value is no Med Pay amount. So does a state branch without `applies`, because Texas' split is no CSL amount. The metadata therefore can't drift from the rule, and deleting it (or the whole module) changes nothing the rule fills.

### Plan: one generic hook

- `buildPlan(record, carrier, active, { overlay } = {})`. After `fieldSteps` builds a step, and **before** its resolution is computed, it calls `overlay?.(step, rule, { record, carrier, active })` and uses the step that comes back. `plan.js` never imports the module.
- Steps gain `tni: rule.tni ?? null`, which is generic and useful to logs anyway.
- The overlay (in the module) acts only when `step.source === 'standard'`, the rule has `std`, and `std.applies` (if given) is true for this record and unit:
  - with **Ask me**, the step becomes the agent's (`manualOnly`, source `fact`) with the note "You chose to answer <standard> yourself (Settings → Your defaults)";
  - with a **value**, the source becomes `agent-default`, the value is `std.write(amount)`, the name is `std.name(amount)`, the choice aliases are `std.aliases(amount)` (none when the rule gives none), the unoffered note says the default isn't offered, and `agentDefault` records the standard, the amount and TNI's (for the report);
  - with a **locked** standard, or no default, the step is returned unchanged.
- **One way to build a panel plan.** A `planFor(state, carrier, active)` wrapper replaces the seven `buildPlan` calls in `coordinator.js`, `core.js`, `fill.js` and `usage.js`. It is the only place the overlay is passed in, so the plan that fills, the plan that logs and the plan Luna reads can't disagree. A test fails if a panel file calls `buildPlan` directly.

### Failure isolation and the off switch

- **A failing overlay never breaks a fill.** The overlay `overlayFor()` gives is wrapped per step in try/catch (`safeOverlay`). If it throws, that step goes to the agent with the note "Your default couldn't be applied: answer it yourself", and the error goes to `onDefaultsError` (the panel logs it as a `client_error` from step 5). It neither falls back silently to TNI's value nor stops the plan; the other steps fill as normal.
- **Off switch:** `agentDefaultsOn()` in `src/agent-defaults/index.js`, off until the panel turns it on. While it's off, `overlayFor()` and `rulebookRewriteFor()` give null, so `planFor()` passes no overlay and Luna's rulebook is TNI's; the Settings row, the quote's question and its hold, and the client strip's pill are hidden too, and nothing new is logged. Stored defaults are kept, so turning it back on restores them; a quote answered while it was off is asked again.
- **Released to agents:** `RELEASED_TO_AGENTS` in the same file, `false` until TNI's managers approve the feature. The panel's `loadDefaults` turns the switch on by build: agents' store build only once it is `true`; any other copy (the unpacked one, the repository's files) unless the developer hid it with **Your defaults (developer only)** in Settings → Advanced, for setup only (`chrome.storage.local` `agentDefaultsHidden`; the store build has no such switch and ignores the key). Approval is a release whose PR sets it to `true`.
- **One standard off:** remove its registry entry (above).

### Removing the feature

1. Delete `src/agent-defaults/`, `sidepanel/panel/agent-defaults/` and `server/agent-defaults.mjs` (with its lines marked `agent defaults` in `server/index.mjs`, its name in `server/Dockerfile` and in `SERVER_HASH`).
2. Delete the wiring line in `planFor()`, the one in `src/ai/common.js` and the one in usage logging, and `scripts/lib/agent-defaults.mjs` with its uses (marked `agent defaults` in the benchmark, answer key, learning and signals).
3. Optionally delete the `std` fields on rules; they're inert without the module.
4. Delete the `agent-default` entry from the source → style map and the module's tests.

The generic hooks (`overlay`, `planFor()`, the `rulebookFor` `rewrite`, `tni` on steps) can stay: with nothing plugged in they do nothing. Stored `agentDefaults` in `chrome.storage.local` are unread and harmless. A later storage migration may remove them.

### Values the carrier doesn't sell

The registry's per-carrier `choices` prevent most of these. If the page still lacks the amount (a state's list, or a renamed option), the step is **left to the agent with a note**: "Your default $1,000 isn't offered here; TNI's is $5,000." It does not fall back to TNI silently. A silent fallback would quote something the agent believes they changed. The same holds for a list condition that gives TNI's own answer (`onlyIf` with a `value`: GEICO's Medical Payments Not Included where its list offers no limit): the overlay drops it, so where GEICO lists no limit the step is the agent's ("Your default medical payments of $2,000 isn't offered here"), even with Not Included already chosen on the page.

### Cross-field checks (computed per plan, not trusted to the UI)

- **UM can't exceed the auto liability limit.** If it would, the UM step is left to the agent with a note. This is common in practice: a $1M UM default with a $750K liability.
- **Med Pay coupling.** GEICO's and AmWINS' PIP answers ("PIP No because Med Pay is offered") assume Med Pay is chosen. Basic offers no "None" for Med Pay. If "Ask me" is chosen for Med Pay, the coupled PIP step becomes the agent's too.
- **Rental follows comp and collision** (GEICO): "Ask me" on comp or collision makes rental the agent's.
- **Answers coupled to a coverage follow "Ask me".** The registry lists each entry's `dependents`: the `std` ids or rule `q`s whose own TNI answer assumes it (PIP declined beside Med Pay; GEICO's rental behind comprehensive and collision). "Ask me" on the entry makes those the agent's as well where their own source is `standard`, with the note "Answer this after <entry>, which you chose to answer yourself". Where the intake answers a dependent (`derived`), it stays as it is.
- **Dependents follow their prerequisite whenever it goes to the agent, not only on "Ask me".** A default can also fail at fill time: the carrier doesn't list the amount (unoffered), a cross-field check stops it (UM above the liability limit), or the overlay throws. If the prerequisite goes to the agent and the dependent is still filled with TNI's coupled answer, the quote can contradict itself. For example, GEICO's Med Pay goes to the agent because its list lacks the default, the agent picks Not Included, and Basic PIP is still declined "because Med Pay is offered": the client ends up with neither coverage.
  - **Today (conservative):** a dependent is the agent's whenever its prerequisite is replaced at all, by a default or "Ask me", with the note "Answer this after <prerequisite>, which your default changes". It is never filled with TNI's coupled answer beside an agent default, so no fill-time failure of the prerequisite can leave the quote contradicting itself. The cost is one more question for the agent where the default does fill. A dependent the agent replaces itself (GEICO's rental with a rental default) takes its own default.
  - **Later, if that question proves a burden:** whether the amount is offered is known only on the page, so a finer hold would be checked at fill time. The overlay would give each dependent step `requires`: the paths of its prerequisite steps (a new generic step field, read by the page kit, which knows nothing about defaults). The page kit would fill a step with `requires` only once each required step was filled by this fill with the plan's answer, and otherwise leave it to the agent. `requires` would be given only where the overlay changed the prerequisite, so TNI's own behaviour stays unchanged.
- **Assumptions other code reads are never "Ask me".** A step overlay changes plan steps only. Some workflow standards are read straight from the record by shared helpers, so no step change reaches those readers. Owner drives is one: with the box blank, `ownerDrives()` (src/answers/owner.js) is TNI's Yes for the owner's daily operations, GEICO's driver list (`listedDriver`, `driversKnown`) and its SR-22 answer, and Progressive's exclusion answer. "Ask me" there would leave all of those answering as if the owner drives, contradicting the agent. Owner drives therefore stays TNI's (`ask: false`, `locked: true`). An agent who knows the owner doesn't drive sets it in All client details: that is an intake correction the record carries, so every reader sees it. A workflow standard is offered "Ask me" only when its assumption reaches nothing but its own step and its listed dependents. A test proves this for each entry (below), so a new helper reading it later fails that test instead of silently contradicting the agent.
- State exceptions (GEICO's Texas UM split, Progressive's SC BI & PD, Florida PIP) stay TNI's: through their own non-`standard` sources, or through `std.applies` where the exception is a branch inside a `standard` rule (priority row 3).

### AI (Luna)

- `rulebookFor(carrier, { rewrite })`: a generic hook the module fills in, so the rulebook text states the effective values (entries carry `std` metadata, like rules). Today it states TNI's amounts, so Luna would contradict an agent default on a re-asked or unfilled coverage field.
- An "Ask me" step is `manualOnly`, so Luna never suggests it. That matches the meaning of "Ask me".
- The rewrite (`rulebookRewriteFor()`, wired in `evidenceFor`) appends to each entry stating a replaced standard, as its rules' `tni` names it, what the agent's default is there, or that the agent answers it.
- From step 5, the AI cache key includes a digest of the effective defaults, so a cached suggestion made under different defaults isn't reused.

### Storage

- `chrome.storage.local`, key `agentDefaults`: `{ v: 1, active: <profile id> | null, profiles: { [id]: { name, values: { [stdId]: { value, tniAtPick } | { ask: true } }, carriers: { [carrierId]: {...} } } } }`. Each profile id is random (`crypto.randomUUID()`).
- **Defaults belong to a profile the agent picks, never to initials.** Two agents may share initials on one computer, so initials can't tell their defaults apart. In Settings the agent creates a profile ("Jordan K.") or picks an existing one. With no active profile, every answer is TNI's.
- **Confirmed for every quote.** A profile being active is never enough on its own: two agents with the same initials could share a computer, and nothing about the second one changes. So each time an intake is loaded (each new quote), before anything fills, the panel asks "Fill this quote with **Jordan K.**'s defaults?" with two buttons, **Yes, mine** and **Use TNI's**. The answer holds for that quote only. Until the agent answers, nothing fills, the same as a held page. **Use TNI's** fills TNI's everywhere and leaves the profile stored for next time.
- **Blank initials use TNI's.** With no initials set, no profile can be active: every answer is TNI's and the question isn't asked.
- **Changing initials** clears the active profile as well, so TNI's apply until a profile is picked again.
- **Always visible.** Once the quote's question is answered, a teal pill in the client strip says how many amounts are the agent's ("2 yours"; a plain "TNI's" after Use TNI's); its popover lists each one beside TNI's, with **Use TNI's for this quote** (or **Use <name>'s**). Each answer they filled is tagged **Your default** and marked teal. The log carries the overrides (`agent_settings.defaults`) but not the profile's name.
- A new key with a "missing means TNI" reader needs no migration. A later shape change follows [storage-version.js](../src/storage-version.js).
- No client data is stored there, only amounts and choices.

### Logging and review

- **Server first.** The server must accept `agent-default` in `source` and deploy before any extension that sends it. Otherwise the server silently drops `source` from those events. This is done in `server/agent-defaults.mjs`.
- `fill_field.source = 'agent-default'`. `agent_settings` (already logged per quote) gains `defaults`: only the overrides, as `{ id, value | 'ask', carrier? }`, so the review knows what each quote was filled with.
- Add a `defaultsHash` beside the `rules` fingerprint on `fill_run` and `fill_error`: the same rules with different defaults fill different answers.
- **Signals and review**: `source` counts include `agent-default`. A correction of an `agent-default` answer is reported apart from a correction of a TNI standard. It means the agent overrode their own default, not that TNI's rule is wrong.
- **Benchmark and answer key**: replay each quote with the defaults its last `agent_settings` logged. Otherwise every agent default reads as "today's rules differ". So every quote's `agent_settings` must log `defaults` once the feature is on: the list in force for it, and an empty list after **Use TNI's**.
- **Developer recordings** store the effective defaults, so a replay reproduces the fill.

## Risk analysis

| # | Risk | Likelihood | Impact | Mitigation in this spec |
| --- | --- | --- | --- | --- |
| R1b | A default lands in the wrong answer (Basic PIP, UM deductible or type) or overrides a state exception inside a standard rule (GEICO Texas UM) | Medium without exact targets | High: wrong coverage | Overrides reach only rules carrying that id in `std`; `std.applies` keeps exceptions TNI's; the per-state consistency test fails on a wrong `std` or a missing `applies` |
| R1 | A default overrides a client's request or an agent-only question | Low (by design) | High: wrong quote | The override applies only where `source === 'standard'` after normal resolution; test: no `intake`/`derived`/`fact`/`attestation` step ever changes with any defaults |
| R2 | Workflow standards become preset client facts ("no hazmat" for everyone) | Medium if allowed | High: misrepresentation on an application | Workflow standards offer only TNI's answer or "Ask me" |
| R3 | The amount isn't on the carrier's list and the field fails or falls back silently | Medium | Medium | Per-carrier choice lists; a missing option goes to the agent with a note, never a silent fallback |
| R4 | Invalid combinations: UM > liability, Med Pay none with PIP declined | Medium | High: carrier error or a client without PIP/Med Pay | Cross-field checks in plan building; no "None" for Med Pay in basic |
| R5 | Plans built in different places disagree (fill vs log vs AI) | Medium | Medium: misleading logs, wrong review | One `planFor()` wrapper is the only way the panel builds a plan; a test fails on a direct `buildPlan` call |
| R6 | Server drops the new `source` | Certain if order is wrong | Medium: lost provenance | Deploy server first; consistency test between server whitelist and `SOURCES` |
| R7 | The weekly review, benchmark and answer key read agent defaults as rule errors | High | Medium: noisy reviews, wrong fixes | Log defaults per quote; replay with them; report `agent-default` corrections apart |
| R8 | Luna contradicts the agent's default | Medium | Low–Medium | Rulebook from effective values; cache key includes the defaults digest |
| R9 | A stale pinned default after TNI changes its standard | Medium | Low–Medium | "Use TNI's" stores nothing; a pinned row shows "TNI's is now $X" |
| R10 | The wrong agent's defaults on a shared computer, same initials included | Medium | High: another agent's coverages on a quote | Defaults belong to an explicitly picked profile with a random id, never to initials; each quote asks the agent to confirm the active profile before anything fills; blank or changed initials mean TNI's; the header and report name the profile |
| R11 | Answer retention or `replace` / `keepChoice` behaviour changes | Low | Medium | Only `value` and `source` change; a rule's `replace`, `keepChoice` and similar flags are untouched; carrier mocks are run with overrides |
| R12 | Touching 92 rules changes today's answers | Low | High | Rules keep their values; they only gain `std` metadata, held to them by a consistency test; phase 2 is proven identical with `npm run benchmark -- --against` |
| R13 | Review mode (unvalidated class) is bypassed by a default | Low | Medium | `agent-default` is `reviewRequired` exactly when `standard` would be |
| R14 | Agents' quotes drift from TNI policy unnoticed | Medium | Business, not technical | `agent_settings.defaults` lets the weekly review list who overrides what; TNI can lock |
| R15 | A bug in the feature breaks fills, or the feature has to come out | Medium | High | Overlay failures go to the agent per step; `agentDefaultsOn()` switches it off (agents' store build until `RELEASED_TO_AGENTS`, the developer's switch elsewhere); the code sits in its own modules with a removal checklist and an import-boundary test |

## Rollout

1. **Server.** Accept `agent-default` in `source`, `defaults` in `agent_settings` and `defaultsHash` on fill runs, then deploy. This changes no behaviour. *Done and deployed; see [hosting](hosting.md).*
2. **Generic hooks, no feature.** Add the `overlay` hook in `buildPlan`, `tni` on steps, the `planFor()` wrapper, the `rulebookFor` `rewrite` hook, and `std` metadata on standard rules. Prove nothing changed: `npm test`, the carrier mocks, and `npm run benchmark -- --save` on `main` then `--against` on the branch with zero differences. *Done.*
3. **The module, switched off.** Add `src/agent-defaults/` (registry, overlay with its cross-field checks, effective defaults, the rulebook rewrite, `isAgentDefault`, the log entries) with `test/agent-defaults.test.mjs`, switched off, and wire it into `planFor()` and `evidenceFor`. Progressive and AmWINS write a million-dollar UM the way their lists do ("$1 million CSL", "$1M"). *Done.*
4. **Review tooling.** Update signals, review, benchmark and answer key for `agent-default` and the logged defaults, before any agent can switch defaults on. Otherwise the benchmark would replay those quotes with TNI's values and report false differences. *Done: one adapter, `scripts/lib/agent-defaults.mjs`, replays each quote with its logged defaults (`profileFromLog`, `replayOverlay` in the module), keeps answer-key cells and rule suggestions apart from TNI's standards, and gives the weekly signals the defaults in force and corrections of them apart ([learning](learning.md)).*
5. **Basic UI, switched on.** Add the TNI defaults section, the profile question, the page colour, the report tag and logging, and switch it on. Requires step 4 merged. Test the e2e with an override on each carrier mock. *Done: Settings → Your defaults (profiles, an amount per standard from `choices.all`), the quote's question as a card above the page's answers with the dock held (`defaultsHold` in the panel's store, checked where the quote-state hold is; on the intake's checks the dock's Show the question opens the card, and once answered, the page whose opening fill the question held fills as on opening, if it is still in front for the same intake: `resumeHeldFill`, also once a fill, a pick or an AI answer going in as it was answered ends; a page nothing was waiting on, such as the last client's quote left open, is never filled by it), a "Yes, mine" kept only for the profile, initials and amounts (`defaultsHash`) it was given for, so a profile changed mid-quote asks again, a hold also while a new intake's quote is set up and while the answer is saving (an answer Chrome refuses to save is cleared, so the quote asks again), a profile active only under the initials it was picked with (`activeFor`), `agent_settings.defaults` and `defaultsHash`, the "Your default" tag and the teal mark, overlay errors logged as `client_error`. Once answered, the card gives way to the client strip's pill (`DefaultsChip`, `state.defaultsChip`). Hidden from agents' store build until released (`RELEASED_TO_AGENTS`).*
6. **Advanced.** Add per-carrier amounts, carrier-only coverage standards, and "Ask me". *Done: per-carrier amounts and "Ask me" for the five coverage amounts. A carrier's pick over the basic one is logged with its carrier where it changes what fills there (`carrierOverrides` in the module): a carrier's TNI's over a basic default is logged as TNI's amount, so the review replays each carrier as it was filled. The quote's card names each carrier's ("GEICO only: …"). Carrier-only standards are not yet done.*

Each step is its own PR. Steps 2–6 update [intake-and-rules.md](intake-and-rules.md) (the provenance table and the new source), [learning.md](learning.md) (`agent_settings.defaults`, signals), [ai-assistant.md](ai-assistant.md) (the rulebook from effective values), [hosting.md](hosting.md) (the server whitelist) and [testing.md](testing.md).

## Tests to add

- **Isolation:** for every carrier's rules and a set of records, any combination of defaults changes only steps whose no-defaults source is `standard`.
- **Null defaults:** `buildPlan(..., null)` deep-equals today's plan for every fixture intake.
- **Locked:** a locked standard ignores any override.
- **Ask me:** the step is `manualOnly` with the note; coupled PIP and rental steps follow.
- **Dependents of an unoffered default:** on GEICO's mock, with a Med Pay default the list doesn't offer, Med Pay and Basic PIP are both the agent's, Basic PIP is not declined, and the report names Med Pay as the reason. With the default offered, both fill as planned. A UM default above the liability limit holds its dependents the same way.
- **Workflow "Ask me" reaches everything it should:** for each workflow entry that offers "Ask me", flipping its intake field (blank to the answer opposite TNI's) changes, on every carrier and fixture, only its own step and its listed `dependents`. A step that changes outside that list fails, which is how owner drives would fail (GEICO's driver list, Progressive's exclusion). Owner drives offers no "Ask me", and correcting it in client details reaches every reader.
- **Unsold amount:** the step goes to the agent with a note, with no fallback.
- **UM above liability:** the step goes to the agent.
- **Exact targets:** with Med Pay and UM overrides on every carrier mock, GEICO's Basic PIP, UM deductible and UM/UIM type steps are unchanged.
- **Texas and another state:** with a UM override, GEICO in Texas still **fills** TNI's $100,000/$300,000 split, its step has no `note`, and the report shows the `defaultInfo`; GEICO in Ohio takes the default.
- **Aliases:** with a $500 comprehensive default on Progressive's mock listing "$500" (not "$500 Deductible", which would match exactly before any alias is tried and hide the bug) and "$1,000 Deductible w/ $0 Glass Deductible", the fill picks "$500". With a stale $1,000 alias left on the step it would pick the glass option, so this test fails on that bug.
- **Profiles:** two profiles under the same initials stay apart; a new intake with an active profile fills nothing until the agent answers the question; **Use TNI's** fills TNI's for that quote and keeps the profile; blank initials mean no profile and TNI's everywhere; changing initials clears the active profile.
- **Review mode:** an `agent-default` step is `reviewRequired`.
- **Server and extension agree on `SOURCES`.**
- **Every panel plan goes through `planFor()`.** No panel file calls `buildPlan` directly.
- **Import boundary:** only the module's own files, `planFor()`, `src/ai/common.js` and usage logging import `src/agent-defaults/`.
- **Off and empty are no-ops:** with the switch off, or with no defaults stored, every fixture's plan deep-equals the plan without the overlay.
- **`std` metadata matches its rule:** `std.write(TNI's amount)` equals the rule's value, and `std.name(TNI's amount)` equals its name.
- **A throwing overlay** sends that step to the agent with its note and leaves the other steps unchanged.
- **Rulebook:** text follows the effective values (an extension of `test/standards.test.mjs`).
- **E2E:** a packaged extension with a Med Pay override on each carrier mock; the page shows it and the log carries `agent-default`.

## Open questions for TNI

1. May agents override TNI's coverage standards at all, and which ones? Which should TNI lock? *Provisional (the maintainer's choice, 2026-11-06, until TNI answers): all five shared coverage amounts are open to agents; none is locked. A lock is one `locked: true` in the registry.*
2. Should "Ask me" be allowed for every workflow standard, or only some? *Provisional: "Ask me" only for the five coverage amounts, in Advanced; no workflow standard is offered (owner drives never is, above).*
3. Per-state defaults in Advanced (for example a different UM in no-fault states): needed, or later? *Provisional: later.*
4. Profiles stored per computer, or synced through the collection server so they follow the agent? *Provisional: per computer (`chrome.storage.local`).*
5. Should the weekly review alert when an agent's default differs from TNI's, or only count it? *Provisional: count it (the signals' Agents' own defaults section), no alert.*
