---
name: New carrier or product
about: Every place a carrier is registered, from docs/new-carrier.md, so none is missed
title: "New carrier: <carrier> <product>"
---

<!-- Each item names the step of docs/new-carrier.md it comes from; read that step before ticking it.
     A box is ticked when the change is merged, not when it is started. No client data here. -->

**Scope** (docs/new-carrier.md, Capture the behavior): carrier and product, states, operations,
vehicle types, driver and vehicle counts, coverages, known exceptions.

### Capture the behavior

- [ ] Live page layouts captured for each step (Capture page layout, `npm run captures`), saved pages kept in ignored `layouts/`
- [ ] Each question's locator, meaning, options, answer source and applicability recorded

### Implement the adapter

- [ ] Step 1: the module `src/carriers/<carrier>.js`, registered in `src/carriers.js`
- [ ] Step 1: its hosts in `manifest.json` (`test/consistency.test.mjs` checks them), `autoFillUrl` and `layoutUrl` kept to the quote's own pages
- [ ] Step 1: the module, and every module it imports, in `RULE_FILES` in `src/usage.js` (`test/usage.test.mjs` checks them)
- [ ] Step 1: the carrier in `test/provenance.test.mjs`, and any new carrier option declared in `types.js`
- [ ] Step 2: generic label rules on or off (`useGenericRules`), decided; a `standard` rule only for an answer TNI has recorded (docs/intake-and-rules.md)
- [ ] Step 3: the page adapter `src/content/carriers/<carrier>.js`, if its widgets need one
- [ ] Step 4: repeated drivers and vehicles found by a witness, helpers with `verify`
- [ ] Step 5: the rulebook part `src/ai/rulebook/<carrier>.js`, listed in `CARRIER_PARTS` in `src/ai/tni-rules.js` (`test/rulebook.test.mjs`)
- [ ] Step 5: each rule's `concept` in `src/concepts.js`, then `npm run concepts` (`test/concepts.test.mjs`)
- [ ] Step 6: `quoteSteps` (and `layoutSteps` on a one-address application), and `advance` only on pages or steps that bind, buy, submit, order reports or sign nothing

### Validate and expand

- [ ] A mock or replay of the carrier's pages under `test/fixtures/<carrier>/` with its runner in `scripts/` and an `npm run` script
- [ ] That runner as a job in `.github/workflows/checks.yml`
- [ ] The supported scenarios and known exceptions tested, including a nearby combination a rule must not reach
- [ ] `README.md`'s Status and `docs/architecture.md` say what is supported and what is still unverified live
