// Injected into rater pages (every frame) by the side panel. Classic script, no imports.
// Exposes globalThis.__raterKit = { fill, capture, clear }.
//
// It never clicks Next/Submit, never touches password fields, and by default leaves fields the
// page already filled alone.
//
// Two kinds of pages are handled:
//  - plain HTML / React / Angular forms: values are set on the DOM elements;
//  - ExtJS pages (Progressive's Duck Creek "DCT" app): values are set through the ExtJS
//    components, and the page talks to its server after each answer, so filling goes one field
//    at a time and waits for the page to settle. Needs the page's own JS world (world: 'MAIN').

(() => {
  if (globalThis.__raterKit?.version === 8) return;

  const MARK = 'data-rater-autofill';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
  const COLORS = { filled: '#16a34a', needs: '#d97706', failed: '#dc2626' };
  const STATE_NAMES = {
    AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
    DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
    IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
    MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
    NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
    NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
    RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
    VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------------------------
  // Text helpers

  const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const humanize = (s) => squash(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]$:]+/g, ' '));
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  function deepQueryAll(root, selector, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    return out;
  }

  function isVisible(el) {
    if (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return true;
    // Styled radios/checkboxes often hide the real input and show the <label> instead.
    return [...(el.labels ?? [])].some((l) => l.getClientRects().length);
  }

  // Text inside `root`, skipping the contents of form controls (so option lists don't leak in).
  function textOutsideControls(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest('select, option, textarea, button, script, style, noscript, [hidden], [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let t = '';
    while (walker.nextNode()) t += ` ${walker.currentNode.nodeValue}`;
    return oneLine(t);
  }

  const CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea';
  const countControls = (el) => el.querySelectorAll(CONTROL_SELECTOR).length;

  function byId(el, id) {
    const root = el.getRootNode();
    return root.getElementById?.(id) ?? document.getElementById(id);
  }

  function labelFor(el) {
    const parts = [];
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) for (const id of labelledBy.split(/\s+/)) { const n = byId(el, id); if (n) parts.push(n.textContent); }
    for (const l of el.labels ?? []) parts.push(textOutsideControls(l));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    // No explicit label: use the text of the smallest wrapper that holds only this field.
    if (!oneLine(parts.join(''))) {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
        if (countControls(p) > 1) break;
        const t = textOutsideControls(p);
        if (t) { parts.push(t); break; }
      }
    }
    if (!oneLine(parts.join('')) && el.placeholder) parts.push(el.placeholder);
    if (!oneLine(parts.join('')) && el.title) parts.push(el.title);
    return oneLine(parts.join(' ')).slice(0, 160) || oneLine(humanize(el.name || el.id));
  }

  function radioGroupLabel(radios, optionTexts) {
    const first = radios[0];
    const group = first.closest('[role=radiogroup]');
    if (group && (group.getAttribute('aria-label') || group.getAttribute('aria-labelledby'))) return labelFor(group);
    const fieldset = first.closest('fieldset');
    if (fieldset && radios.every((r) => fieldset.contains(r))) {
      const legend = fieldset.querySelector('legend');
      if (legend) return oneLine(legend.textContent);
    }
    // Smallest container holding the whole group; its text minus the option labels.
    let c = first.parentElement;
    while (c && !radios.every((r) => c.contains(r))) c = c.parentElement;
    for (let i = 0; c && i < 3; i++, c = c.parentElement) {
      let t = textOutsideControls(c);
      for (const o of optionTexts) if (o) t = t.replace(o, ' ');
      t = oneLine(t);
      if (t) return t.slice(0, 160);
      if (c.querySelectorAll(CONTROL_SELECTOR).length > radios.length) break;
    }
    return oneLine(humanize(first.name));
  }

  function isRequired(el, label) {
    return el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(label);
  }

  function sectionOf(el) {
    for (let p = el.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const heads = [...p.querySelectorAll('h1, h2, h3, h4, legend, [role=heading]')]
        .filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (heads.length) return oneLine(heads.at(-1).textContent).slice(0, 100);
    }
    return '';
  }

  // ---------------------------------------------------------------------------------------------
  // ExtJS / Duck Creek helpers (only work in the page's own JS world)

  const ext = () => (typeof globalThis.Ext?.getCmp === 'function' ? globalThis.Ext : null);
  const extCmp = (el) => (el?.id && ext() ? ext().getCmp(el.id.replace(/-inputEl$/, '')) ?? null : null);

  function dctCaption(cmp) {
    for (let c = cmp, i = 0; c && i < 6; c = c.ownerCt, i++) {
      if (c.dctCaption) return oneLine(String(c.dctCaption).replace(/<[^>]+>/g, ' '));
    }
    return null;
  }

  // Only the field itself (or its radio group) says whether it's required; outer containers
  // carrying dctRequired made optional fields like Suffix and DBA look required.
  function dctRequired(cmp) {
    return !!cmp?.dctRequired;
  }

  // Duck Creek element ids look like f_<letter><32 hex group id><question id>_<page>_<row>.
  function dctQuestionId(id) {
    return String(id ?? '').match(/^f_[a-z]([0-9A-F]{32})([0-9A-F]+)_\d+_\d+/)?.[2] ?? null;
  }

  // The page is waiting on its server or re-drawing after an answer.
  function pageBusy() {
    const X = ext();
    if (X?.Ajax?.isLoading?.()) return true;
    return [...document.querySelectorAll('.x-mask-msg, .x-mask-loading, [class*="loading-mask"], [class*="LoadingMessage"]')]
      .some((m) => m.getClientRects().length && getComputedStyle(m).visibility !== 'hidden');
  }

  // Wait until the page stops changing: not busy and no new nodes for `quietMs`.
  async function settle({ quietMs = 400, maxMs = 15000 } = {}) {
    let last = Date.now();
    const mo = new MutationObserver(() => { last = Date.now(); });
    mo.observe(document.body, { subtree: true, childList: true });
    const start = Date.now();
    try {
      await sleep(100);
      while (Date.now() - start < maxMs) {
        if (!pageBusy() && Date.now() - last >= quietMs) return true;
        await sleep(120);
      }
      return false;
    } finally {
      mo.disconnect();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Finding the fields on the page

  function collectControls() {
    const out = [];
    const groups = new Map();
    for (const el of deepQueryAll(document, CONTROL_SELECTOR)) {
      const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : el.tagName.toLowerCase();
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(type)) continue;
      if (el.disabled || !isVisible(el)) continue;
      const cmp = extCmp(el);
      if (type === 'radio') {
        const extGroup = cmp?.up?.('radiogroup') ?? null;
        const key = extGroup ? `x:${extGroup.id}` : `${el.form ? 'f' : ''}:${el.name || el.id}`;
        let g = groups.get(key);
        if (!g) {
          g = { kind: 'radio', el, type, radios: [], cmp: extGroup };
          groups.set(key, g);
          out.push(g);
        }
        g.radios.push(el);
        continue;
      }
      const c = { kind: el.tagName === 'SELECT' ? 'select' : type === 'checkbox' ? 'checkbox' : 'text', el, type, cmp };
      if (cmp?.store && cmp.displayField) {
        // ExtJS combo box: a text input backed by a list of records.
        c.kind = 'select';
        c.options = cmp.store.getRange().map((rec) => ({ rec, text: oneLine(rec.get(cmp.displayField)), value: rec.get(cmp.valueField ?? cmp.displayField) }));
      }
      c.label = dctCaption(cmp) ?? labelFor(el);
      c.q = dctQuestionId(cmp?.id ?? el.id);
      out.push(c);
    }
    for (const g of groups.values()) {
      g.options = g.radios.map((r) => {
        const item = extCmp(r);
        return { el: r, cmp: item, text: oneLine(String(item?.boxLabel ?? '').replace(/<[^>]+>/g, ' ')) || oneLine([...(r.labels ?? [])].map(textOutsideControls).join(' ')) || r.value, value: r.value };
      });
      g.label = dctCaption(g.cmp) ?? radioGroupLabel(g.radios, g.options.map((o) => o.text));
      g.q = dctQuestionId(g.cmp?.id ?? g.el.id) ?? (String(g.el.name).match(/^[a-z]+_([0-9A-F]+)/)?.[1] ?? null);
    }
    for (const c of out) {
      c.text = squash(c.label);
      c.hint = humanize(c.el.name || c.el.id || '');
      c.required = dctRequired(c.cmp) || isRequired(c.el, c.label);
    }
    return out;
  }

  function optionsOf(c) {
    if (c.options) return c.options;
    if (c.kind === 'select') return [...c.el.options].map((o) => ({ el: o, text: oneLine(o.text), value: o.value }));
    return [];
  }

  const isPlaceholderOption = (text) => /^(-+|select\b|choose\b|please\b|\s*$)/i.test(oneLine(text));

  function hasValue(c) {
    if (c.kind === 'radio') return c.options.some((o) => (o.cmp ? !!o.cmp.getValue() : o.el.checked));
    if (c.cmp && c.kind === 'select') {
      const v = c.cmp.getValue();
      return v != null && v !== '' && !isPlaceholderOption(c.cmp.getRawValue?.() ?? '');
    }
    if (c.kind === 'text') return c.el.value.trim() !== '';
    if (c.kind === 'checkbox') return c.el.checked;
    const o = c.el.selectedOptions?.[0];
    return !!o && o.value !== '' && !isPlaceholderOption(o.text);
  }

  function selectedText(c) {
    if (c.kind === 'checkbox') return c.el.checked ? 'checked' : 'unchecked';
    if (c.kind === 'radio') return c.options.find((o) => (o.cmp ? o.cmp.getValue() : o.el.checked))?.text ?? null;
    if (c.cmp) return oneLine(c.cmp.getRawValue?.() ?? '') || null;
    const o = c.el.selectedOptions?.[0];
    return o && !isPlaceholderOption(o.text) ? oneLine(o.text) : null;
  }

  // Same key the usage recorder (recorder.js) uses, so its changes can be tied to our fills.
  function fieldKey(c) {
    return c.q ?? ((c.kind === 'radio' ? c.el.name : c.el.name || c.el.id) || c.label);
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); } catch { return false; }
  }

  // Pairs plan steps with page fields: carrier question ids and selectors first, then label
  // rules, then a last pass on the field's name/id for pages with unhelpful labels.
  function assign(controls, plan) {
    const used = new Set();
    const donePaths = new Set();
    const pairs = [];
    const steps = plan.map((s) => ({ ...s, reC: s.re ? new RegExp(s.re, 'i') : null, exC: s.ex ? new RegExp(s.ex, 'i') : null }));
    const take = (s, c) => { used.add(c); donePaths.add(s.path); pairs.push({ step: s, control: c }); };
    const fits = (s, c) => !(c.kind === 'checkbox' && s.kind !== 'bool');

    for (const s of steps) {
      if (donePaths.has(s.path)) continue;
      let c = null;
      if (s.q) c = controls.find((x) => !used.has(x) && x.q === s.q);
      if (!c && s.selector) c = controls.find((x) => !used.has(x) && (safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector))));
      if (c) take(s, c);
    }
    for (const field of ['text', 'hint']) {
      for (const s of steps) {
        if (!s.reC || donePaths.has(s.path)) continue;
        const c = controls.find((x) => !used.has(x) && x[field] && fits(s, x) && s.reC.test(x[field]) && !(s.exC && s.exC.test(x[field])));
        if (c) take(s, c);
      }
    }
    return pairs;
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
    return [squash(v)];
  }

  function matchOption(options, step) {
    const usable = options.filter((o) => squash(o.text) && !isPlaceholderOption(o.text));
    // "Any option except …" (e.g. the registered USDOT address instead of "Enter a different
    // address"), preferring one that matches `prefer` when there are several.
    if (step.kind === 'pick-not') {
      const allowed = usable.filter((o) => !new RegExp(step.value.not, 'i').test(o.text));
      return (step.value.prefer && allowed.find((o) => new RegExp(step.value.prefer, 'i').test(o.text))) || allowed[0] || null;
    }
    const cands = candidates(step);
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
    if (n != null && step.kind !== 'bool') {
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

  // ---------------------------------------------------------------------------------------------
  // Setting values

  // Plain pages: set the value in a way React / Angular / Vue notice.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function textFor(step, c) {
    const v = step.value;
    switch (step.kind) {
      case 'bool': return v ? 'Yes' : 'No';
      case 'date': {
        const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m && c.type === 'date' ? `${m[3]}-${m[1]}-${m[2]}` : String(v);
      }
      case 'phone': return c.el.maxLength > 0 && c.el.maxLength <= 10 ? String(v).replace(/\D/g, '') : String(v);
      default: return String(v);
    }
  }

  const noMatch = (step, options) => ({
    ok: false,
    reason: `no option matches "${step.value}"`,
    options: options.filter((o) => !isPlaceholderOption(o.text)).map((o) => o.text).slice(0, 25),
  });

  // Returns { ok: true, shown } or { ok: false, reason, options? }.
  function apply(step, c) {
    if (c.cmp || c.options?.some((o) => o.cmp)) return applyExt(step, c);
    if (c.el.readOnly) return { ok: false, reason: 'the field is read-only (usually a date picker or lookup) — set it by hand' };
    if (c.kind === 'text') {
      const text = textFor(step, c);
      if (c.el.maxLength > 0 && text.length > c.el.maxLength) return { ok: false, reason: `value is longer than the field allows (${c.el.maxLength})` };
      setNativeValue(c.el, text);
      if (c.el.value === '') return { ok: false, reason: 'the page cleared the value (it may need a different format)' };
      return { ok: true, shown: c.el.value };
    }
    if (c.kind === 'checkbox') {
      if (typeof step.value !== 'boolean') return { ok: false, reason: 'checkbox needs a yes/no answer' };
      if (c.el.checked !== step.value) c.el.click();
      return { ok: true, shown: step.value ? 'checked' : 'unchecked' };
    }
    const options = optionsOf(c);
    const opt = matchOption(options, step);
    if (!opt) return noMatch(step, options);
    if (c.kind === 'select') setNativeValue(c.el, opt.value);
    else if (!opt.el.checked) opt.el.click();
    return { ok: true, shown: opt.text };
  }

  // Runs ExtJS's own "field lost focus" handling, which is when Duck Creek sends an answer to
  // its server. A real focus/blur doesn't fire while the agent is clicking in the side panel
  // (the page window isn't focused), so fall back to calling Ext's handler directly.
  function extFocusAndBlur(cmp, el, set) {
    let blurred = false;
    cmp.on('blur', () => { blurred = true; }, null, { single: true });
    el.focus();
    set();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    if (!blurred && typeof cmp.onFocusLeave === 'function') {
      cmp.onFocusLeave({ type: 'focusleave', event: new FocusEvent('blur'), target: el, relatedTarget: document.body, fromComponent: cmp, toComponent: null });
    }
    if (!blurred) cmp.fireEvent('blur', cmp, new FocusEvent('blur'));
  }

  // ExtJS pages: go through the components so the page's own change/blur handlers run (Duck
  // Creek sends each answer to the server when the field loses focus).
  function applyExt(step, c) {
    const { cmp, el } = c;
    if (c.kind === 'radio') {
      const opt = matchOption(c.options, step);
      if (!opt) return noMatch(step, c.options);
      const isOn = () => (opt.cmp ? !!opt.cmp.getValue() : opt.el.checked);
      if (!isOn()) opt.el.click();
      if (!isOn() && opt.cmp) opt.cmp.setValue(true);
      return isOn() ? { ok: true, shown: opt.text } : { ok: false, reason: "the page didn't accept the choice" };
    }
    if (cmp?.readOnly) return { ok: false, reason: 'the field is read-only — set it by hand' };
    if (c.kind === 'select') {
      const opt = matchOption(c.options, step);
      if (!opt) return noMatch(step, c.options);
      extFocusAndBlur(cmp, el, () => {
        cmp.setValue(opt.value);
        cmp.fireEvent('select', cmp, opt.rec);
      });
      return { ok: true, shown: cmp.getRawValue?.() || opt.text };
    }
    if (c.kind === 'checkbox') {
      if (typeof step.value !== 'boolean') return { ok: false, reason: 'checkbox needs a yes/no answer' };
      if (!!cmp.getValue() !== step.value) cmp.setValue(step.value);
      return { ok: true, shown: step.value ? 'checked' : 'unchecked' };
    }
    const text = textFor(step, c);
    if (c.el.maxLength > 0 && text.length > c.el.maxLength) return { ok: false, reason: `value is longer than the field allows (${c.el.maxLength})` };
    extFocusAndBlur(cmp, el, () => cmp.setValue(text));
    if (!el.value && !cmp.getValue()) return { ok: false, reason: 'the page cleared the value (it may need a different format)' };
    return { ok: true, shown: el.value || String(cmp.getValue()) };
  }

  // ---------------------------------------------------------------------------------------------
  // Highlighting

  function highlightTargets(c) {
    if (c.kind !== 'radio') return [c.cmp?.el?.dom?.querySelector?.('.x-form-trigger-wrap') ?? c.el];
    return c.radios.map((r) => (isVisible(r) && r.getClientRects().length ? r : r.labels?.[0] ?? r));
  }

  function mark(c, status, note) {
    for (const el of highlightTargets(c)) {
      if (!el.hasAttribute(MARK)) {
        el.dataset.raPrevOutline = el.style.outline;
        el.dataset.raPrevOffset = el.style.outlineOffset;
        el.dataset.raPrevTitle = el.getAttribute('title') ?? '';
      }
      el.setAttribute(MARK, status);
      el.style.outline = `2px ${status === 'filled' ? 'solid' : 'dashed'} ${COLORS[status]}`;
      el.style.outlineOffset = '1px';
      if (note) el.setAttribute('title', `Rater Autofill: ${note}`);
    }
  }

  function clear() {
    let n = 0;
    for (const el of deepQueryAll(document, `[${MARK}]`)) {
      el.style.outline = el.dataset.raPrevOutline ?? '';
      el.style.outlineOffset = el.dataset.raPrevOffset ?? '';
      if (el.dataset.raPrevTitle) el.setAttribute('title', el.dataset.raPrevTitle); else el.removeAttribute('title');
      for (const k of ['raPrevOutline', 'raPrevOffset', 'raPrevTitle']) delete el.dataset[k];
      el.removeAttribute(MARK);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------
  // Clicking buttons (carrier "actions": Verify DOT, Lookup VIN, Add a Commodity, …)

  // Never clicked, whatever a rule says: moving on or committing is always the agent's call.
  const NEVER_CLICK = /\b(continue|next|finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out)\b/i;

  const currentPage = () => (new URLSearchParams(location.search).get('pageName') || location.pathname).replace(/-Reload$/, '');

  function findButton(step) {
    const re = step.text ? new RegExp(step.text, 'i') : null;
    let best = null;
    for (const el of deepQueryAll(document, 'a, button, [role=button], [role=link], input[type=button], input[type=submit], .x-btn, [onclick]')) {
      if (!el.getClientRects().length || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const text = oneLine(el.value || el.textContent);
      if (NEVER_CLICK.test(text)) continue;
      const attrs = [el.id, el.getAttribute('name'), el.getAttribute('href'), el.getAttribute('onclick'),
        ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)].join(' ');
      const hit = (re && text.length <= 80 && re.test(text)) || (step.token && attrs.includes(step.token));
      // Prefer the innermost match (the link itself, not the table cell around it).
      if (hit && (!best || best.contains(el))) best = el;
    }
    return best;
  }

  // ---------------------------------------------------------------------------------------------
  // Public API

  // Fills in rounds: each round re-reads the page, handles every step that now has a field, and
  // on pages that talk to their server after each answer (ExtJS/Duck Creek) stops after one
  // answer and waits. New questions that appear because of an answer get picked up next round.
  // `skip`: field keys to leave alone (ones the agent changed; used by automatic follow-up fills).
  // `optional`: question ids never flagged as "needs you" (middle initial, suffix, DBA, …).
  // `doneActions`: button actions already clicked earlier in this quote.
  async function fill(plan, { overwrite = false, maxRounds = 60, skip = [], keepMarks = false, optional = [], doneActions = [] } = {}) {
    const skipKeys = new Set(skip);
    const quiet = new Set(optional);
    const actions = plan.filter((s) => s.kind === 'action');
    plan = plan.filter((s) => s.kind !== 'action');
    const clicked = new Set(doneActions);
    const startPage = currentPage();
    if (!keepMarks) clear();
    const handled = new Map(); // step id -> { status, note }
    const report = { frame: location.origin + location.pathname, fields: 0, filled: [], noData: [], kept: [], failed: [], leftRequired: [], actions: [], rounds: 0 };
    const serverBacked = !!ext();
    await settle({ quietMs: 200, maxMs: 5000 });

    for (let round = 0; round < maxRounds; round++) {
      report.rounds = round + 1;
      const controls = collectControls();
      report.fields = Math.max(report.fields, controls.length);
      const pairs = assign(controls, plan).filter(({ step, control }) => !handled.has(step.id) && !skipKeys.has(fieldKey(control)));
      let changed = false;
      for (const { step, control: c } of pairs) {
        const item = { label: c.label, path: step.path, name: step.name, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind };
        if (step.note || step.value == null) {
          if (quiet.has(c.q)) { handled.set(step.id, { status: null }); continue; }
          report.noData.push({ ...item, note: step.note });
          handled.set(step.id, { status: 'needs', note: step.note ?? `intake form has no answer for ${step.name}` });
          continue;
        }
        // A pre-selected "Enter a different …" isn't an answer worth keeping for pick-not steps.
        const presetToReplace = step.kind === 'pick-not' && new RegExp(step.value.not, 'i').test(selectedText(c) ?? '');
        if (!overwrite && hasValue(c) && !presetToReplace) {
          report.kept.push(item);
          handled.set(step.id, { status: null });
          continue;
        }
        let result;
        try { result = apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
        if (result.ok) {
          report.filled.push({ ...item, shown: result.shown });
          handled.set(step.id, { status: 'filled', note: `filled from intake: ${step.name}` });
          changed = true;
          if (serverBacked) break;
        } else {
          report.failed.push({ ...item, reason: result.reason, options: result.options });
          handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${result.reason}` });
        }
      }
      // Nothing left to type or pick: click the next button whose turn it is.
      if (!changed && window === window.top) changed = clickNextAction(controls);
      if (!changed) break;
      await settle(serverBacked ? {} : { quietMs: 250, maxMs: 3000 });
      if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
    }

    function clickNextAction(controls) {
      const pairs = assign(controls, plan);
      const has = (path) => pairs.some(({ step, control }) => step.path === path && hasValue(control));
      for (const a of actions) {
        if (clicked.has(a.action) || (a.page && a.page !== currentPage())) continue;
        if (a.after.length && !a.after.some(has)) continue;
        if (a.afterActions.some((id) => !clicked.has(id))) continue;
        if (a.unless.some(has)) { clicked.add(a.action); continue; }
        const button = findButton(a);
        if (!button) continue;
        clicked.add(a.action);
        report.actions.push({ id: a.action, text: oneLine(button.value || button.textContent).slice(0, 60) });
        button.click();
        return true;
      }
      return false;
    }

    // The page may have redrawn while filling, so mark the final fields.
    const controls = collectControls();
    const pairs = assign(controls, plan);
    for (const { step, control } of pairs) {
      const h = handled.get(step.id);
      if (h?.status) mark(control, h.status, h.note);
    }
    // Question text for every field on the page, keyed like the usage recorder's changes.
    report.labels = controls.map((c) => [fieldKey(c), c.label]);
    const matched = new Set(pairs.map((p) => p.control));
    for (const c of controls) {
      if (!matched.has(c) && c.required && !hasValue(c) && !quiet.has(c.q)) {
        report.leftRequired.push({ label: c.label, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind });
        mark(c, 'needs', 'required, and not on the intake form');
      }
    }
    return report;
  }

  // Describes this page's form so exact mappings can be written. Records no typed values (only
  // which dropdown/radio choice is picked); any text matching `redact` (client names, numbers)
  // is replaced with [client].
  function capture(plan, redact = []) {
    const patterns = redact.filter((t) => t && t.length >= 3).map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
    const r = (s) => patterns.reduce((acc, re) => acc.replace(re, '[client]'), oneLine(s));
    const controls = collectControls();
    const matched = new Map(plan ? assign(controls, plan).map((p) => [p.control, p.step.path]) : []);
    const path = location.pathname.replace(/\d{5,}/g, ':id');
    const pageName = new URLSearchParams(location.search).get('pageName');
    return {
      frame: location.origin + path,
      page: pageName,
      isTopFrame: window === window.top,
      title: r(document.title),
      headings: deepQueryAll(document, 'h1, h2, h3, legend, [role=heading]').filter(isVisible).map((h) => r(h.textContent)).filter(Boolean).slice(0, 40),
      controls: controls.map((c) => ({
        q: c.q ?? undefined,
        kind: c.kind,
        type: c.cmp?.xtype ?? c.type,
        label: r(c.label),
        name: c.el.name || null,
        id: c.el.id || null,
        selector: cssPath(c.el),
        required: c.required,
        section: r(sectionOf(c.el)),
        options: optionsOf(c).map((o) => r(o.text)).slice(0, 60),
        wouldFill: matched.get(c) ?? null,
        pageHasValue: hasValue(c),
        // Which choice is picked (never text typed into boxes): shows which answers make
        // follow-up questions appear.
        selected: c.kind === 'text' ? undefined : r(selectedText(c) ?? ''),
      })),
      customWidgets: deepQueryAll(document, '[role=combobox]:not(input):not(select), [role=listbox], [contenteditable=true]')
        .filter(isVisible).slice(0, 50).map((el) => ({ role: el.getAttribute('role') ?? 'contenteditable', label: r(labelFor(el)), selector: cssPath(el) })),
    };
  }

  function cssPath(el) {
    const looksStable = (s) => s && !/\d{4,}|[a-f0-9]{8,}|^(mat|ng|react|ember|ext)-?/i.test(s);
    if (looksStable(el.id) && el.getRootNode().querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    if (looksStable(el.name)) return `${el.tagName.toLowerCase()}[name="${el.name.replace(/"/g, '\\"')}"]`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
      let part = e.tagName.toLowerCase();
      if (looksStable(e.id)) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  globalThis.__raterKit = { version: 8, fill, capture, clear };
})();
