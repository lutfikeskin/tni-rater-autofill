// @ts-check
// The select2 drivers: a list select2 draws over a hidden <select> (`select2`), and a type-ahead
// list the page fills from its server (`searchSelect`, step kind search-select: AmWINS'
// classification). The fill engine (src/kit/pagekit.js) asks them in its driver list, as the
// address driver (drivers/address.js) says. Both take the engine's helpers (`kit`).

/** @param {any} kit */
export function createSelect2Drivers(kit) {
  const { deepQueryAll, oneLine, squash, sleep, settle, optionsOf, matchOption, noMatch, selectedText, multiValue, halted, interrupted } = kit;

  // Type-ahead dropdowns (select2: a hidden <select> with the box select2 draws after it, and a
  // search box that lists what matches the typed text). select2 opens on a left-button mousedown
  // (it checks the event's button), so a plain Event isn't enough.
  const Mouse = () => (typeof MouseEvent === 'function' ? MouseEvent : Event);
  const press = (el) => { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new (Mouse())(type, { bubbles: true, cancelable: true, button: 0 })); };
  const select2Box = (select) => [select.nextElementSibling, ...(select.parentElement?.children ?? [])]
    .find((n) => n && n !== select && /\bselect2\b/.test(String(n.className))) ?? null;
  // A list select2 draws (its own <select> hidden by select2), not one it only searches for.
  const isSelect2 = (c) => c.kind === 'select' && !c.widget && !!c.el.classList?.contains('select2-hidden-accessible') && !!select2Box(c.el);

  // Opens a select2 list and types `text` in its search box: { box, results } as the list then
  // shows them, or { reason } when it can't. A list taking several choices types in its own box,
  // drawn in the list's box; another in the box its open dropdown draws (none on a short list:
  // its results are read as listed). The results are the list's own (select2 names them after the
  // <select>: select2-<id>-results), else those on screen.
  async function select2Search(select, text) {
    const container = select2Box(select);
    const opener = container?.querySelectorAll?.('.select2-selection')?.[0] ?? container;
    if (!opener) return { reason: 'the search box for this list was not found; pick it yourself' };
    if (!/\bselect2-container--open\b/.test(String(container.className))) press(opener);
    const inline = () => (select.multiple ? container.querySelectorAll?.('.select2-search__field')?.[0] ?? null : null);
    // Never another list's own box (a list taking several choices always shows its box).
    const dropdownBox = () => deepQueryAll(document, '.select2-search__field').find((n) => n.getClientRects().length && !n.closest?.('.select2-selection')) ?? null;
    const own = () => (select.id ? document.getElementById?.(`select2-${select.id}-results`) : null);
    const listed = () => (own() ? [...own().querySelectorAll('.select2-results__option')] : deepQueryAll(document, '.select2-results__option'))
      .filter((n) => n.getClientRects().length && !/loading|message/.test(String(n.className)));
    let box = null;
    for (const start = Date.now(); !box && Date.now() - start < 3000 && !halted();) {
      await sleep(100);
      box = inline() ?? dropdownBox();
      if (!box && !select.multiple && own() && listed().length && Date.now() - start >= 1000) break;
    }
    // Stopped meanwhile (the agent's Stop, or their edit): nothing is typed or picked.
    if (halted()) return interrupted();
    if (!box && !(own() && listed().length)) return { reason: "the list's search box didn't open; pick it yourself" };
    if (box) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, String(text));
      for (const type of ['input', 'keyup']) box.dispatchEvent(new Event(type, { bubbles: true }));
    }
    let results = [];
    for (const start = Date.now(); Date.now() - start < 6000 && !halted();) {
      await sleep(200);
      results = listed();
      if (results.length) break;
    }
    if (halted()) return interrupted();
    return { box, results };
  }

  // Closes an open select2 list without a pick (its box takes a key, the page a click elsewhere).
  function closeSelect2(box) {
    box?.dispatchEvent(new Event('keydown', { bubbles: true }));
    document.body.dispatchEvent(new (Mouse())('mousedown', { bubbles: true, button: 0 }));
  }

  // A search-select's answer among texts (squashed): the one reading exactly `want`, else the one
  // having its words (whole words: "Trucking" is in "Trucking - Hazmat", never "Truckings"); several
  // or none is no confident match. The fill picks by it, and holds a pick to it.
  const hasWords = (text, want) => ` ${text} `.includes(` ${want} `);
  const searchHits = (texts, want) => {
    const exact = texts.filter((t) => t === want);
    return exact.length ? exact : texts.filter((t) => hasWords(t, want));
  };

  // Type-ahead dropdowns the page fills from its server (AmWINS' classification): type
  // `step.search`, and pick the one result reading `step.value`, else the one result having its
  // words (a check item for the agent: looseMatch); no such result (or several) means no confident
  // match, and the agent picks.
  async function applySearchSelect(step, c) {
    const found = await select2Search(c.el, step.search ?? step.value);
    if (found.reason) return { ok: false, reason: found.reason };
    const want = squash(step.value);
    const texts = found.results.map((n) => squash(n.textContent));
    const picked = searchHits(texts, want);
    const hits = found.results.filter((n, i) => picked.includes(texts[i]));
    if (hits.length !== 1) {
      closeSelect2(found.box);
      return { ok: false, reason: hits.length ? `${hits.length} results match "${step.value}"; pick the right one` : `no confident match for "${step.value}"; pick it yourself` };
    }
    press(hits[0]);
    await settle({ quietMs: 250, maxMs: 4000 });
    return searchAgrees(step, c) ? { ok: true, shown: oneLine(hits[0].textContent) } : { ok: false, reason: 'the page did not keep the choice; pick it yourself' };
  }

  // The pick a search-select holds is its answer by the write's own rule (searchHits): it reads
  // exactly so, or it has the answer's words and no option of its <select> reads exactly so. Which
  // result was the only one having them was the write's to judge, among the live results: the
  // <select> can keep stale options from an earlier search, which are no rivals (Claude review of
  // PR #360).
  function searchAgrees(step, c) {
    const want = squash(step.value);
    const current = squash(selectedText(c) ?? '');
    if (!want || !current) return false;
    if (current === want) return true;
    return hasWords(current, want) && !optionsOf(c).some((o) => squash(o.text) === want);
  }

  // One option of a select2 list picked as the agent picks it: its text typed in the list's search
  // box, and the one result reading exactly that clicked (one not picked yet, on a list taking
  // several: clicking a picked one takes it off).
  async function pickSelect2(select, text) {
    const found = await select2Search(select, text);
    if (found.reason) return { ok: false, reason: found.reason };
    const want = oneLine(text).toLowerCase();
    const hits = found.results.filter((n) => oneLine(n.textContent).toLowerCase() === want && n.getAttribute?.('aria-selected') !== 'true');
    if (hits.length !== 1) {
      closeSelect2(found.box);
      return { ok: false, reason: hits.length ? `the list showed "${text}" ${hits.length} times; pick it yourself` : `the list didn't show "${text}" when it was typed; pick it yourself` };
    }
    press(hits[0]);
    await settle({ quietMs: 250, maxMs: 4000 });
    return { ok: true };
  }

  // A pick taken off a select2 list taking several choices: its own × in the list's box.
  async function unpickSelect2(select, text) {
    const want = oneLine(text).toLowerCase();
    const chip = [...(select2Box(select)?.querySelectorAll?.('.select2-selection__choice') ?? [])]
      .find((n) => oneLine(n.getAttribute?.('title') ?? n.textContent.replace(/^×/, '')).toLowerCase() === want);
    const remove = chip?.querySelectorAll?.('.select2-selection__choice__remove')?.[0] ?? null;
    if (!remove) return { ok: false, reason: `"${text}" is picked but has no × to take it off; take it off yourself` };
    press(remove);
    await settle({ quietMs: 250, maxMs: 4000 });
    return { ok: true };
  }

  // GEICO's select2 lists (business description, cargo commodities, a driver's suffix, a vehicle's
  // year, make and model) take a pick only from select2 itself: the page reads its select2:select
  // and select2:unselect, never a change of the hidden <select> (FL live run 6, 2026-10-21: the
  // commodity set on the <select> showed, but GEICO took none and never asked for the cargo limit;
  // the business description set so was refused at Next). Each pick is made in the list (typed,
  // then clicked: pickSelect2), and on a list taking several a pick the answer doesn't name is
  // taken off first (GEICO takes at most four).
  async function applySelect2(step, c) {
    let options = optionsOf(c);
    if (c.el.multiple) {
      const wanted = multiValue(step.value, options);
      const picks = wanted.map((w) => options.find((o) => !o.el.disabled && o.text.toLowerCase() === w.toLowerCase()));
      if (!wanted.length || picks.some((o) => !o)) return noMatch({ ...step, value: wanted.filter((w, i) => !picks[i]).join('; ') || step.value }, options);
      for (const o of options.filter((x) => x.el.selected && !picks.includes(x))) {
        if (halted()) return interrupted();
        const off = await unpickSelect2(c.el, o.text);
        if (!off.ok) return off;
      }
      for (const o of picks.filter((x) => !x.el.selected)) {
        if (halted()) return interrupted();
        const on = await pickSelect2(c.el, o.text);
        if (!on.ok) return on;
      }
      if (!options.every((o) => !!o.el.selected === picks.includes(o))) return { ok: false, reason: 'the page did not keep these picks' };
      return { ok: true, shown: picks.map((o) => o.text).join('; ') };
    }
    let opt = matchOption(options, step);
    for (const start = Date.now(); !opt && new Set(options.map((o) => oneLine(o.text)).filter(Boolean)).size <= 1 && Date.now() - start < 6000 && !halted();) {
      await sleep(250);
      options = optionsOf(c);
      opt = matchOption(options, step);
    }
    if (halted()) return interrupted();
    if (!opt) return noMatch(step, options);
    const on = await pickSelect2(c.el, opt.text);
    if (!on.ok) return on;
    return selectedText(c) === opt.text ? { ok: true, shown: opt.text } : { ok: false, reason: 'the page did not keep the choice; pick it yourself' };
  }

  return {
    select2: {
      name: 'select2',
      writes: (step, c) => isSelect2(c),
      write: applySelect2,
    },
    searchSelect: {
      name: 'search-select',
      writes: (step) => step.kind === 'search-select',
      write: applySearchSelect,
      agrees: (step, c) => (step.kind === 'search-select' ? searchAgrees(step, c) : undefined),
    },
  };
}
