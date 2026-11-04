// @ts-check
// The locator: which control on the page answers each plan step (`assign`), and which option of
// a list is the answer (`matchOption`), with the unit-row and option helpers they use. The fill
// engine (src/kit/pagekit.js) creates it once (`createLocator(kit)`) and keeps the names it calls;
// the engine's helpers come in `kit` (they live in its closure), the ones defined further down the
// engine as functions called when needed (`currentPage`, `stepKey`). `extraRowKeys` is the
// engine's own Map, shared.

/** @param {any} kit */
export function createLocator(kit) {
  const { squash, humanize, STATE_NAMES, isPlaceholderOption, optionsOf, safeMatches, shownControl, unitFormsOf, stepIs, stepKey, currentPage, extraRowKeys } = kit;

  // Kinds of step that answer a text box, and kinds that pick a choice: which of two questions
  // reading the same ("Business Name" as a registered-name choice, or a box) is a step's.
  const TEXT_STEPS = new Set(['text', 'date', 'address-suggest']);
  const TYPED_STEPS = new Set(['date', 'address-suggest']);
  // Yes / No too (Codex on PR #43): a question that became a text box is never typed "Yes" into.
  const CHOICE_STEPS = new Set(['choice', 'pick-not', 'first-option', 'selected-option', 'bool']);

  // Pairs plan steps with page fields. A carrier's known question is found by what it is, never
  // by its question id: Progressive renumbered every question on 2026-10-07, and an id kept from
  // before then named another question (Business Name got the trucker type). So, by
  // - the field's data-model name (`field`, Duck Creek's fieldref: "ComprehensiveInput.Deductible"),
  //   on whatever page it is; its expected wording (`ask`/`re`) is a check: other words on the field
  //   fill it, flagged for the agent (`reworded`);
  // - else its question on its page (`ask`, the exact text, or `re` on `pages`), never a field
  //   another rule knows by its data-model name; the first one after an anchor question when the
  //   text repeats (`askAfter`: the business "City" comes after "Street Address", the owner's after
  //   "Home Address"; with no anchor on screen, none);
  // - else the list offering a given answer (`withOption`), or a selector.
  // A known question not found stays with the agent: it never falls back to a looser label rule.
  // A data-model name not on the page while its expected wording is (a renamed field) is reported
  // (`pairs.renamed`) and left with the agent. Then label rules, then a pass on the field's name/id.
  // Each pair says how it was found (`how`).
  // On a one-address application whose steps share their field names (GEICO's GiveFirstName is the
  // owner on one step and a driver on another), a rule kept to steps (`steps`) or to a form
  // (`whenShown` / `unlessShown`: a question only that form asks) is live only there; one that
  // isn't live neither answers nor claims a field. A unit's form that may be another unit's is held
  // (`pairs.units`, `pairs.held`; see unitFormsOf).
  function assign(controls, plan) {
    const used = new Set();
    const donePaths = new Set();
    /** @type {any} */
    const pairs = [];
    // Steps with a witness whose unit's row isn't among the rows on the page (none or several
    // read as the unit): left for the agent, named by unit (pairs.unwitnessed).
    const unwitnessed = [];
    // The rows a witness step chooses among: known questions, never unfamiliar ones, also while
    // no unit's row is among them yet (the rows before an import) (pairs.witnessed).
    const witnessed = new Set();
    // Rows showing a witness (a VIN) no intake unit has: a vehicle on the quote the intake doesn't
    // list. Never answered or changed; each row is a check for the agent (pairs.extraRows).
    const extraRows = new Map();
    // Rows of a per-unit question found by a selector that name their unit: the rule each is for.
    // One no step took is a check naming the row for the agent, never an unfamiliar question
    // (pairs.unmatchedRows).
    const namedRows = new Map();
    const page = currentPage();
    // The step on screen, read only for a plan kept to steps ('' when no step is named: then no
    // stepped rule is live, and GEICO's fields stay the agent's).
    const stepNow = plan.some((s) => s.steps?.length) ? stepKey() : '';
    const live = (s) => (!s.steps?.length || stepIs(s.steps, stepNow))
      && (!s.whenShown || !!shownControl(controls, s.whenShown)) && (!s.unlessShown || !shownControl(controls, s.unlessShown));
    const steps = plan.filter(live).map((s) => ({ ...s, reC: s.re ? new RegExp(s.re, 'i') : null, exC: s.ex ? new RegExp(s.ex, 'i') : null }));
    const units = unitFormsOf(controls, steps);
    // Steps of a held form: they keep their fields (no other rule takes them, and they aren't
    // unfamiliar), but answer nothing.
    const isHeld = (s) => !!s.whenShown?.unit && !!units.find((u) => u.list === s.whenShown.unit)?.held;
    // Every witness value an intake unit claims (its VIN): a row reading as none of them isn't ours.
    const wanted = new Set(steps.filter((s) => s.witness).map((s) => idText(s.witness.value)).filter(Boolean));
    const take = (s, c, how, reworded = false) => { used.add(c); donePaths.add(s.path); pairs.push({ step: s, control: c, how, reworded }); };
    const fits = (s, c) => !(c.kind === 'checkbox' && s.kind !== 'bool');
    // A label pattern kept to pages or steps is a known question there, as a data-model name is.
    const known = (s) => !!(s.field || s.ask?.length || (s.reC && (s.pages?.length || s.steps?.length)));
    // A question's own pages (`notPages`: never there, whatever finds it).
    const onPage = (s) => (!s.pages?.length || s.pages.includes(page)) && !s.notPages?.includes(page);
    // A data-model name is found on any page, except where the step is fenced off: a trailer's
    // questions carry the vehicle's names (RiskInput.VIN), so each is kept to its own pages.
    const nameHere = (s) => (s.pageOnly ? onPage(s) : !s.notPages?.includes(page));
    const worded = (s) => !!s.ask?.length || !!s.reC;
    const textIs = (s, x) => !!x.text && ((s.ask ?? []).some((a) => squash(a) === x.text) || (!!s.reC && s.reC.test(x.text) && !(s.exC && s.exC.test(x.text))));
    // Data-model names some rule knows here: those fields are that rule's, never a text rule's. A
    // name fenced off this page (a trailer's RiskInput.PAValue on Add Vehicle) claims nothing here.
    const claimed = new Set(steps.filter((s) => s.field && nameHere(s)).map((s) => s.field));
    const isIt = (s, x) => (s.field ? x.ref === s.field && nameHere(s) : onPage(s) && worded(s) && !claimed.has(x.ref) && textIs(s, x));
    // A choice is never typed into a box, nor a typed address or date put in a choice; a plain
    // text step only gives way to a box when its text names a box and a choice.
    const definite = (s, x) => !(CHOICE_STEPS.has(s.kind) && x.kind === 'text') && !(TYPED_STEPS.has(s.kind) && x.kind !== 'text');
    const kindFits = (s, x) => !(TEXT_STEPS.has(s.kind) && x.kind !== 'text');
    const afterAnchor = (same, anchor) => {
      const at = controls.findIndex((x) => x.text === squash(anchor));
      const next = at < 0 ? null : same.find((x) => controls.indexOf(x) > at);
      return next ? [next] : [];
    };
    // The fields a known question is on this page (several: one per vehicle, or one per group).
    const fieldsOf = (s) => {
      if (!known(s)) return [];
      // `control`: the kind of field the question is, when its text is shared with another kind.
      let same = controls.filter((x) => isIt(s, x) && definite(s, x) && (!s.control || x.kind === s.control));
      if (same.length > 1 && same.some((x) => kindFits(s, x))) same = same.filter((x) => kindFits(s, x));
      // The anchor tells repeated texts apart; a data-model name is already the one field.
      return s.askAfter && !s.field ? afterAnchor(same, s.askAfter) : same;
    };
    const found = new Map(steps.map((s) => [s, fieldsOf(s)]));
    // A label fallback can't tell rows of one question apart, nor a vehicle's question from
    // another vehicle's: those are only answered by a known question and its vehicle. (Rows of one
    // question share a question id on the page: that compares the page with itself.)
    const repeated = new Set(controls.map((x) => x.q).filter((q, i, all) => q && all.indexOf(q) !== i));
    // Fields of a per-vehicle question: its steps come one per vehicle (activeVehicle true or
    // false), with or without a year/make/model to name its row.
    const perVehicle = new Set(steps.filter((s) => s.activeVehicle != null).flatMap((s) => found.get(s)));
    // A page about one vehicle (Add Vehicle): no question names a vehicle and the per-vehicle
    // questions sit in one row. Rows of several vehicles without their names stay with the agent.
    const oneVehicle = !controls.some((x) => x.vehicle) && new Set([...perVehicle].map((x) => x.row)).size <= 1;

    // Distinct known questions may share intake data (business and home ZIP/City).
    // Match every known question; path deduplication applies only to label fallbacks.
    for (const s of steps) {
      if (isHeld(s)) continue;
      let c = null;
      let how = s.field ? 'field' : 'text';
      const same = found.get(s);
      if (known(s) && s.activeVehicle != null) {
        // One step per vehicle (several in the quote): on a page showing one vehicle at a time, the
        // active vehicle's; otherwise the row labelled with this vehicle's year/make/model. A
        // vehicle the intake doesn't describe can't name a row: left to the agent.
        c = oneVehicle ? (s.activeVehicle && same.length === 1 ? same[0] : null) : s.vehicleHint ? vehicleRow(same, s.vehicleHint) : null;
        if (c && used.has(c)) c = null;
      } else if (known(s)) {
        // Without a vehicle, several fields for one question are ambiguous: they stay yellow.
        // `each`: a question repeated in several groups, one step per group.
        const free = same.filter((x) => !used.has(x));
        c = s.each ? free[0] ?? null : free.length > 1 ? null : free[0] ?? null;
      } else if (onPage(s)) {
        how = 'selector';
        if (s.selector) {
          const all = controls.filter((x) => safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector)));
          const matching = all.filter((x) => !used.has(x));
          // A repeated question's rows (AmWINS' vehicle rows): the step's unit's row is the one
          // whose witness (its VIN) reads as the unit's, never the row at the unit's position.
          // No such row, or two, while rows are there: the unit is the agent's (unwitnessed).
          if (s.witness) {
            c = witnessRow(matching, s.witness);
            if (!c && all.length) unwitnessed.push(s);
            for (const x of all) {
              witnessed.add(x);
              const w = rowWitnessOf(x, s.witness);
              if (w?.value && !wanted.has(w.value) && !extraRows.has(w.el)) extraRows.set(w.el, s.witness);
            }
          } else if (s.activeVehicle != null && all.some((x) => x.vehicle)) {
            // A per-unit question's rows that name their unit (GEICO's coverage rows, "2020 RAM 3500
            // …", a trailer among the vehicles): the step's unit's row is the one naming it, never
            // the row at the unit's position, which a trailer listed among the vehicles shifts
            // (GEICO live run, 2026-10-28). A row no unit names, or two alike, is the agent's (namedRows).
            c = s.vehicleHint ? namedRow(all, s, steps) : null;
            if (c && used.has(c)) c = null;
            for (const x of all) if (x.vehicle && !namedRows.has(x)) namedRows.set(x, s);
          } else c = matching[0] ?? null;
          // An ignored step for every match (`every`: the gateway's other product boxes, however many).
          if (s.ignore && s.every) for (const x of matching.slice(1)) take(s, x, how);
        }
        // A dropdown with no usable label, known by one of its options ("NO PRIOR").
        if (!c && s.withOption) { how = 'option'; c = controls.find((x) => !used.has(x) && optionsOf(x).some((o) => squash(o.text) === squash(s.withOption))); }
      }
      // Reworded: found by its data-model name, its wording isn't the rule's. A field with no wording
      // of its own (nameOnly) can't say so: it was taken for reworded, a check that held Progressive's
      // Rates helpers on TX's caption-less PIP limit (live recording, 2026-10-23).
      if (c) take(s, c, how, !!s.field && worded(s) && !c.nameOnly && !textIs(s, c));
    }
    // A held form's fields (its steps' and its marker question) that no live step took: nobody
    // else's, and not unfamiliar either. The form is one check for the agent (fill).
    const held = new Set();
    for (const s of steps.filter(isHeld)) {
      const mine = known(s) ? found.get(s) : s.selector ? controls.filter((x) => safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector))) : [];
      for (const x of mine) if (!used.has(x)) held.add(x);
    }
    for (const u of units) if (u.held && !used.has(u.marker)) held.add(u.marker);
    for (const x of held) used.add(x);
    // A data-model name not on the page, while its expected wording is: the field was probably renamed.
    pairs.renamed = steps.filter((s) => s.field && worded(s) && onPage(s) && nameHere(s) && !found.get(s).length)
      .flatMap((s) => { const x = controls.find((y) => !used.has(y) && y.ref !== s.field && !claimed.has(y.ref) && textIs(s, y)); return x ? [{ step: s, control: x }] : []; });
    // A label rule kept out of a carrier's row sections (`notWithin`): its rows are answered by
    // their own rules, or stay the agent's.
    const fenced = (s, x) => !!s.notWithin?.some((sel) => { try { return !!x.el?.closest(sel); } catch { return false; } });
    for (const field of ['text', 'hint']) {
      for (const s of steps) {
        if (!s.reC || known(s) || isHeld(s) || donePaths.has(s.path) || !onPage(s)) continue;
        const c = controls.find((x) => !used.has(x) && !repeated.has(x.q) && !perVehicle.has(x) && !fenced(s, x) && x[field] && fits(s, x) && s.reC.test(x[field]) && !(s.exC && s.exC.test(x[field])));
        if (c) take(s, c, field === 'text' ? 'label' : 'name');
      }
    }
    // A list condition with a value (`onlyIf`: GEICO's Medical Payments is Not Included where it
    // offers no limit, Basic PIP I decline where Medical Payments offers one; TNI, 2026-10-26,
    // W44-26) answers in place of the rule's, read from the lists on the page now, so every check of
    // the answer (kept, accepted, changed since it was given) agrees with what was given.
    for (const p of pairs) {
      const value = p.step.onlyIf && p.step.value != null && !p.step.note ? holdingCondition(p.step, p.control, pairs)?.value : null;
      if (value != null) p.step = { ...p.step, value };
    }
    pairs.unwitnessed = unwitnessed;
    pairs.witnessed = witnessed;
    pairs.unmatchedRows = [...namedRows].filter(([x]) => !used.has(x)).map(([control, step]) => ({ control, step }));
    pairs.held = held;
    pairs.units = units;
    // Numbered by their place among the page's rows (by their witness controls), never by value.
    const witnesses = steps.filter((s) => s.witness).map((s) => s.witness);
    const rowWitnesses = [...new Set(controls.flatMap((x) => witnesses.some((w) => safeMatches(x.el, w.selector)) ? [x.el] : []))];
    const identities = [...extraRows].map(([el, witness]) => JSON.stringify([
      witness.selector, String(witness.path ?? '').replace(/\[\d+\]/g, '[]'), idText(el.value),
    ]));
    // A removed identity loses its acknowledgement, including a later re-addition of the same VIN.
    // Without visible witness rows (another application step), absence proves no removal.
    if (rowWitnesses.length) {
      for (const identity of extraRowKeys.keys()) if (!identities.includes(identity)) extraRowKeys.delete(identity);
    }
    pairs.extraRows = [...extraRows].map(([el, witness], i) => {
      const identity = identities[i];
      const count = identities.filter((id) => id === identity).length;
      // A duplicate's VIN cannot identify which row was reviewed. Keep its key on that DOM
      // control through reordering; after a redraw each duplicate requires fresh confirmation.
      if (extraRowKeys.get(identity)?.count !== count) {
        extraRowKeys.set(identity, { count, key: `extra-row:${crypto.randomUUID()}`, rows: new WeakMap() });
      }
      const entry = extraRowKeys.get(identity);
      if (count > 1 && !entry.rows.has(el)) entry.rows.set(el, `extra-row:${crypto.randomUUID()}`);
      return { witness, position: rowWitnesses.indexOf(el) + 1, key: count === 1 ? entry.key : entry.rows.get(el) };
    });
    return pairs;
  }

  const unitNoun = (list) => ({ vehicles: 'vehicle', drivers: 'driver', trailers: 'trailer' }[list] ?? 'unit');

  // What the agent is told about a held unit form: the unit by its place in the intake's list,
  // never by its VIN or name.
  function heldFormNote(u) {
    const noun = unitNoun(u.list);
    const which = u.boundTo != null
      ? `This form was filled for ${noun} ${Number(u.boundTo) + 1}, and the panel has ${noun} ${Number(u.active) + 1} picked`
      : `This form may be another ${noun}'s than ${noun} ${Number(u.active) + 1}, which was filled on an earlier form`;
    if (u.count <= 1) return `${which}. The intake lists ${u.count === 1 ? `one ${noun}` : `no ${noun}s`}: answer this form yourself.`;
    // A form filled for one unit stays held once the agent picks the unit it is really about: the
    // note says both ways out, as only the agent can tell whose it is.
    if (u.boundTo == null) return `${which}: pick the ${noun} this form is about in the panel, then Fill again.`;
    const filledFor = `${noun} ${Number(u.boundTo) + 1}`;
    return `${which}: if it is ${filledFor}'s, pick ${filledFor} in the panel, then Fill again; if it is ${noun} ${Number(u.active) + 1}'s, correct its answers yourself.`;
  }

  // Letters and digits only, uppercase: how a witness value (a VIN) compares with the page's.
  const idText = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // The unit a witness path names ("vehicles[1].vin": vehicle 2), and what the witness is (VIN).
  const unitName = (path) => { const m = String(path ?? '').match(/^(\w+?)s?\[(\d+)\]/); return m ? `${m[1]} ${Number(m[2]) + 1}` : 'this unit'; };
  const witnessName = (w) => { const k = String(w.path ?? '').split('.').pop() ?? ''; return k.length <= 3 ? k.toUpperCase() : humanize(k); };

  // Of the rows of a repeated question (one control each), the one whose row holds the step's
  // witness: a control matching `witness.selector` (AmWINS' [data-id="vin"]) reading as
  // `witness.value`. A control's row is its nearest ancestor holding a witness control, which
  // must be the only one there (higher up is the whole panel). No row reading as the unit (the
  // import hasn't landed, or rejected its VIN; the intake has no VIN for it), or two (two rows
  // with one VIN), is no row: the unit stays the agent's.
  function witnessRow(candidates, witness) {
    const want = idText(witness.value);
    if (!want) return null;
    const rows = candidates.filter((x) => rowWitnessOf(x, witness)?.value === want);
    return rows.length === 1 ? rows[0] : null;
  }

  // A control's row's witness control and what it reads (letters and digits), or null when the
  // nearest ancestor holding a witness control holds two (the whole panel) or there is none.
  function rowWitnessOf(x, witness) {
    for (let p = x.el; p && p !== document; p = p.parentElement) {
      let found;
      try { found = [...p.querySelectorAll(witness.selector)]; } catch { return null; }
      if (!found.length) continue;
      return found.length === 1 ? { el: found[0], value: idText(found[0].value) } : null;
    }
    return null;
  }

  // The one row naming this vehicle best: at least two of its year, make and model as whole
  // words, also when the intake gives only one of them. Two rows that fit equally well (two
  // identical vans) are the agent's.
  function vehicleRow(rows, hint) {
    const score = (x) => hint.filter((h) => ` ${x.vehicle ?? ''} `.includes(` ${h} `)).length;
    const best = Math.max(0, ...rows.map(score));
    const top = rows.filter((x) => score(x) === best);
    return best >= 2 && top.length === 1 ? top[0] : null;
  }

  const unmatchedRowNote = (step) => `${step.name}: this row's vehicle matches none of the intake's vehicles and trailers (or two of them alike), so it wasn't filled. Answer it yourself.`;

  // The row of a per-unit step among rows naming their unit: the one naming the step's unit best
  // (vehicleRow), unless another unit asked the same question names it as well or better (two
  // units alike, or the step's own unit missing from the rows): then no unit's, and the agent's.
  function namedRow(rows, step, steps) {
    const row = vehicleRow(rows, step.vehicleHint);
    if (!row) return null;
    const score = (hint) => hint.filter((h) => ` ${row.vehicle ?? ''} `.includes(` ${h} `)).length;
    const mine = score(step.vehicleHint);
    const rivals = steps.filter((t) => t !== step && t.selector === step.selector && t.activeVehicle != null && t.vehicleHint);
    return rivals.some((t) => score(t.vehicleHint) >= mine) ? null : row;
  }

  // ---------------------------------------------------------------------------------------------
  // Choosing dropdown / radio options

  function moneyTokens(s) {
    const out = [];
    for (const m of String(s).matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?\b/gi)) {
      let n = parseFloat(m[1].replace(/,/g, ''));
      const unit = (m[2] ?? '').toLowerCase();
      if (unit === 'k' || unit === 'thousand') n *= 1e3;
      else if (unit) n *= 1e6;
      out.push(Math.round(n));
    }
    return out;
  }

  function candidates(step) {
    const v = step.value;
    if (step.kind === 'bool') return v ? ['yes', 'y', 'true'] : ['no', 'n', 'false'];
    if (step.kind === 'state') return [squash(v), STATE_NAMES[String(v).toUpperCase()]].filter(Boolean);
    return [v, ...(step.choiceAliases ?? [])].map(squash);
  }

  const businessNameKey = (text) => squash(String(text).replace(/\((?:US)?DOT[^)]*\)/ig, ''));

  // Registered business names that read the same once normalised count once (the lookup can
  // list one name twice).
  function uniqueBusinessNames(options) {
    const seen = new Set();
    return options.filter((o) => {
      const k = businessNameKey(o.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // A list's stand-in for what is picked: GEICO starts every coverage list with an
  // <option value="" hidden> repeating the current choice ("Not Included"). Picking it picks nothing.
  const standIn = (o) => o.el?.tagName === 'OPTION' && (!!o.el.hidden || !!o.el.disabled || o.value === '');

  // A list's choices: options that read the same are the same choice (pages sometimes list one
  // twice), and the real one of them is the choice, never a stand-in reading like it. Placeholders
  // are no choice.
  function usableOptions(options) {
    const seenText = new Set();
    const real = new Set(options.filter((o) => !standIn(o)).map((o) => squash(o.text)));
    return options.filter((o) => {
      const k = squash(o.text);
      if (!k || isPlaceholderOption(o.text) || seenText.has(k) || (standIn(o) && real.has(k))) return false;
      seenText.add(k);
      return true;
    });
  }

  // Whether a list offers a limit: a choice with an amount ("$2,500", "$10,000/No deductible"),
  // never a placeholder, a stand-in, "Not Included" or "I decline". No list offers none.
  const offersLimit = (list) => !!list && usableOptions(optionsOf(list)).some((o) => moneyTokens(o.text).length > 0);

  // A step's `onlyIf` condition that holds first, its list read from its own field or, with a
  // `path`, from that question's among `pairs` (a question off the page offers none); none holding: null.
  const holdingCondition = (step, control, pairs) => step.onlyIf?.find((x) => offersLimit(x.path ? pairs.find((p) => p.step.path === x.path)?.control : control) === x.limit) ?? null;

  function matchOption(options, step) {
    const usable = usableOptions(options);
    // "Any option except …" (e.g. the registered USDOT address instead of "Enter a different
    // address"), preferring one that matches `prefer` when there are several.
    if (step.kind === 'pick-not') {
      const allowed = usable.filter((o) => !new RegExp(step.value.not, 'i').test(o.text));
      if (step.registeredName && step.businessNames?.length) {
        // One registered name listed twice ("ACME LLC", "Acme, LLC") is still one match.
        const matches = uniqueBusinessNames(allowed.filter((o) => step.businessNames.some((name) => businessNameKey(o.text) === businessNameKey(name))));
        return matches.length === 1 ? matches[0] : null;
      }
      return (step.value.prefer && allowed.find((o) => new RegExp(step.value.prefer, 'i').test(o.text))) || allowed[0]
        || (step.value.fallback && usable.find((o) => new RegExp(step.value.fallback, 'i').test(o.text))) || null;
    }
    if (step.kind === 'selected-option') return usable.find((o) => /^selected\b/i.test(o.text)) ?? null;
    // Always the page's first choice (e.g. the first offered home address).
    // Unless that first choice is no answer (`firstNot`): then none, and the question is the agent's.
    if (step.kind === 'first-option') return step.firstNot && usable[0] && new RegExp(step.firstNot, 'i').test(usable[0].text) ? null : usable[0] ?? null;
    const cands = candidates(step);
    // `matchStart`: the answer, else each alias in turn, as an option reading so or beginning so
    // (Progressive's business type lists: "General Freight Trucking Haul general goods…"); never one
    // only mentioning it further on ("Auto Hauler (For Hire Trucking)" is not For Hire Trucking).
    if (step.matchStart) {
      for (const c of cands.filter(Boolean)) {
        const exact = usable.find((o) => squash(o.text) === c || squash(o.value) === c);
        const starts = usable.filter((o) => squash(o.text).startsWith(c));
        if (exact) return exact;
        if (starts.length === 1) return starts[0];
        // Several begin with it: the answer is listed, but which one is the agent's; never the
        // next alias in its place (Claude review of PR #220).
        if (starts.length > 1) return null;
      }
      return null;
    }
    for (const c of cands) {
      const hit = usable.find((o) => squash(o.text) === c || squash(o.value) === c);
      if (hit) return hit;
    }
    // Dollar amounts: "$1M CSL" matches "$1 million CSL"; "$100000/$1000" matches
    // "$100k with a $1,000 Deductible".
    if (step.kind !== 'bool' && step.kind !== 'state') {
      const want = typeof step.value === 'number' ? [step.value] : moneyTokens(step.value);
      if (want.length) {
        const hits = usable.filter((o) => { const t = moneyTokens(o.text); return t.length === want.length && t.every((n, i) => n === want[i]); });
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) {
          const csl = /csl|combined/.test(squash(step.value));
          return hits.find((o) => /csl|combined/.test(squash(o.text)) === csl) ?? null;
        }
      }
    }
    // Numeric bands: 350 matches "201-500"; 800 matches "500+" / "More than 500 miles";
    // otherwise the smallest single-number option that covers the value (150 -> "200 miles").
    const n = typeof step.value === 'number' ? step.value : /^\d+$/.test(String(step.value)) ? Number(step.value) : null;
    if (n != null && step.kind === 'int') {
      for (const o of usable) {
        const t = o.text.replace(/,/g, '');
        const range = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
        if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
        const open = t.match(/(\d+)\s*\+|(?:over|more than|greater than)\s*(\d+)/i);
        if (open && n > Number(open[1] ?? open[2]) - (open[1] ? 1 : 0)) return o;
      }
      const single = usable
        .map((o) => ({ o, t: moneyTokens(o.text) }))
        .filter(({ o, t }) => t.length === 1 && !/(\d+)\s*\+|over|more than|greater than|-|–|\bto\b/i.test(o.text) && t[0] >= n)
        .sort((a, b) => a.t[0] - b.t[0]);
      if (single.length) return single[0].o;
    }
    // A requested amount must match exactly; never turn $1,000 into $10,000 by substring.
    if (step.kind !== 'bool' && moneyTokens(step.value).length) return null;
    for (const c of cands.filter((x) => x.length >= 2)) {
      const starts = usable.filter((o) => squash(o.text).startsWith(c));
      if (starts.length === 1) return starts[0];
    }
    for (const c of cands.filter((x) => x.length >= 3)) {
      const has = usable.filter((o) => squash(o.text).includes(c));
      if (has.length === 1) return has[0];
    }
    return null;
  }

  return { assign, matchOption, holdingCondition, moneyTokens, businessNameKey, uniqueBusinessNames, heldFormNote, unitName, unitNoun, unmatchedRowNote, witnessName };
}
