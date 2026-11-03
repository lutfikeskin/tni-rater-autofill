// @ts-check
// The address driver: an address box with the carrier's own suggestions (step kind
// address-suggest). The fill engine (src/kit/pagekit.js) asks it, in its driver list, whether it
// writes a step to a control (`writes`), to write it (`write`: { ok, shown } or { ok: false,
// reason }), and whether the control already holds the answer (`agrees`: undefined when the step
// isn't its). It takes the engine's helpers (`kit`) rather than importing them: they live in the
// engine's closure.

/** @param {any} kit */
export function createAddressDriver(kit) {
  const { adapter, withAdapter, deepQueryAll, oneLine, sleep, settle, hasValue, unpicked } = kit;

  // Address boxes with the carrier's own address suggestions: type the whole one-line address,
  // wait for the suggestion list, pick its first entry for that address (which fills street, city
  // and ZIP): one with its house number and, when both show one, its ZIP. No such suggestion means
  // the address needs the agent; the ZIP/city rules then check the rest. GEICO's are
  // <gds-dropdown-list-item type="address">, in its address wrapper's shadow root, read as list items
  // (its script; FL live run 3, 2026-10-21).
  // A list's items (the adapter's `options`) and the carrier's own suggestions (its `suggestions`).
  const suggestionSelector = () => withAdapter(withAdapter('[role=option], .pac-item, [class*="suggest"] li, [class*="Suggest"] li, [class*="autocomplete"] li, [class*="Autocomplete"] li', 'options'), 'suggestions');
  // An address's house number (its leading number) and ZIP (after a state's two letters).
  const houseNumberOf = (text) => String(text ?? '').match(/^\s*(\d+)\b/)?.[1] ?? null;
  const zipOf = (text) => String(text ?? '').match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/i)?.[1] ?? null;
  const shownSuggestions = () => deepQueryAll(document, suggestionSelector()).filter((el) => el.getClientRects().length && oneLine(el.textContent));
  async function applyAddress(step, c) {
    const text = String(step.value);
    const { el, widget } = c;
    const before = new Set(shownSuggestions());
    // Google's address autocomplete (Progressive uses it): its list (.pac-item) is only shown
    // while the box has focus, which it doesn't while the agent works in the side panel. The
    // suggestions are still there, hidden; they're picked the way the keyboard does (↓, Enter).
    const pacBefore = new Map(deepQueryAll(document, '.pac-item').map((x) => [x, x.textContent]));
    const houseNumber = text.match(/^\s*(\d+)/)?.[1] ?? null;
    const freshPac = () => deepQueryAll(document, '.pac-item').find((x) => pacBefore.get(x) !== x.textContent && oneLine(x.textContent) && (!houseNumber || x.textContent.includes(houseNumber))) ?? null;
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new Event('focus'));
    if (widget) adapter().setText(widget, text);
    else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, text);
    // Suggestion lists listen for typing: send the events typing would.
    for (const type of ['input', 'keydown', 'keyup']) el.dispatchEvent(new Event(type, { bubbles: true }));
    if (widget) adapter().changed(widget, text);
    // What the page adds while it thinks: when no known list shows up, the reason names the new
    // elements (tag.class), so the carrier's suggestion list can be recognised next time.
    const added = [];
    const mo = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && added.length < 40) added.push(n);
    }) : null;
    mo?.observe(document.body, { subtree: true, childList: true });
    // A suggestion for this address: the same house number, and the same ZIP when both show one
    // (another town's same street is not it).
    const wantZip = zipOf(text);
    const fits = (x) => {
      const shown = oneLine(x.textContent);
      return (!houseNumber || houseNumberOf(shown) === houseNumber) && (!wantZip || !zipOf(shown) || zipOf(shown) === wantZip);
    };
    let first = null;
    let offered = false;
    try {
      for (const start = Date.now(); !first && Date.now() - start < 4000;) {
        await sleep(200);
        const fresh = shownSuggestions().filter((x) => !before.has(x));
        offered ||= fresh.length > 0;
        first = freshPac() ?? fresh.find(fits) ?? null;
      }
    } finally {
      mo?.disconnect();
    }
    if (!first) {
      // A box with its own city/ZIP boxes gets back just the street.
      if (step.fallback) {
        if (widget) adapter().setText(widget, step.fallback);
        else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, step.fallback);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.blur?.();
      if (step.checkNumber) unpicked.set(el, el.value);
      if (offered) return { ok: false, reason: `none of the page's address suggestions has the intake's house number${wantZip ? ' and ZIP' : ''}: pick the address yourself` };
      const seen = [...new Set(added.filter((n) => n.getClientRects?.().length).map((n) => `${n.tagName.toLowerCase()}${n.id ? `#${String(n.id).replace(/\d{3,}/g, '#')}` : ''}${typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}${n.getAttribute?.('role') ? `[role=${n.getAttribute('role')}]` : ''}`))].slice(0, 8);
      return { ok: false, reason: `the page offered no address suggestion; check the address, city and ZIP${seen.length ? ` (new on the page: ${seen.join(', ')})` : ''}` };
    }
    const shown = oneLine(first.textContent).slice(0, 120);
    if (first.classList?.contains('pac-item') || / pac-item /.test(` ${first.className} `)) {
      for (const [key, code] of [['ArrowDown', 40], ['Enter', 13]]) el.dispatchEvent(keyEvent('keydown', key, code));
      await settle({ quietMs: 300, maxMs: 5000 });
      // Still the typed text: Google didn't take the keys; click the suggestion instead.
      if (el.value !== text) return { ok: true, shown };
    }
    for (const type of ['mousedown', 'mouseup']) first.dispatchEvent(new Event(type, { bubbles: true }));
    first.click?.();
    await settle({ quietMs: 300, maxMs: 5000 });
    return { ok: true, shown };
  }

  // A key press as page scripts read it (Google's autocomplete looks at keyCode).
  function keyEvent(type, key, code) {
    // An Event where KeyboardEvent is missing (a test's page), given `key` below.
    /** @type {any} */
    const e = typeof KeyboardEvent === 'function' ? new KeyboardEvent(type, { key, bubbles: true, cancelable: true }) : new Event(type, { bubbles: true });
    for (const prop of ['keyCode', 'which']) { try { Object.defineProperty(e, prop, { get: () => code }); } catch { /* read-only */ } }
    if (!('key' in e)) e.key = key;
    return e;
  }

  return {
    name: 'address',
    writes: (step, c) => step.kind === 'address-suggest' && c.kind === 'text',
    write: applyAddress,
    // The chosen suggestion rewrites the typed address in the page's own format. `checkNumber`: an
    // address the page put there itself (GEICO's, from its USDOT record) agrees only with the
    // intake's house number. Any address step is this driver's, whatever the control.
    agrees: (step, c) => (step.kind === 'address-suggest'
      ? c.kind === 'text' && hasValue(c) && (!step.checkNumber || houseNumberOf(c.el.value) === houseNumberOf(step.value))
      : undefined),
  };
}
