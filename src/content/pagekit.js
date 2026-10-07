// Injected into rater pages (every frame) by the side panel. Classic script, no imports.
// Exposes globalThis.__raterKit = { fill, answer, markKey, aiBanner, capture, clear }.
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
  // This build of the kit (stamped by scripts/package.mjs): one left in the page by another build,
  // from before an extension reload or update, is replaced rather than reused.
  const BUILD = 'source';
  if (globalThis.__raterKit?.version === 54 && globalThis.__raterKit.build === BUILD) return;

  const MARK = 'data-rater-autofill';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
  // ai: an answer the AI assistant chose (accepted by the agent or auto-selected); check it.
  const COLORS = { filled: '#16a34a', needs: '#d97706', failed: '#dc2626', ai: '#7c3aed' };
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
    // No explicit label: the smallest wrapper that holds only this field, preferring its label
    // element; a date picker's calendar (Su Mo Tu …, month names) is not part of the question.
    if (!oneLine(parts.join(''))) {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
        if (countControls(p) > 1) break;
        const own = p.querySelector?.('label, .control-label, .form-label');
        const t = withoutCalendar(own ? textOutsideControls(own) : textOutsideControls(p));
        if (t) { parts.push(t); break; }
      }
    }
    if (!oneLine(parts.join('')) && el.placeholder) parts.push(el.placeholder);
    // The tooltip our own marks put on a field is never its question.
    const title = el.dataset?.raPrevTitle ?? (/^Rater Autofill:/.test(el.title ?? '') ? '' : el.title);
    if (!oneLine(parts.join('')) && title) parts.push(title);
    return oneLine(parts.join(' ')).slice(0, 160) || oneLine(humanize(el.name || el.id));
  }

  function withoutCalendar(text) {
    const t = oneLine(text);
    const cut = t.search(/\b(su mo tu we th fr sa|mo tu we th fr sa su)\b|[«»]/i);
    return (cut >= 0 ? t.slice(0, cut) : t).trim();
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
    // app-valid-rq: AmWINS marks its required fields this way.
    return el.required || el.getAttribute('aria-required') === 'true' || el.getAttribute('app-valid-rq') === '1' || !!el.closest?.('table[app-valid-rq="1"]') || /\*/.test(label);
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

  // The field's name in the carrier's data model: Duck Creek puts it on every input
  // (fieldref="RiskInput.VIN", "ComprehensiveInput.Deductible"). It names what the field holds,
  // where the question id below is only a number, which Progressive renumbers (2026-10-07).
  const fieldRef = (el) => el?.getAttribute?.('fieldref') || null;

  // Duck Creek element ids look like f_<letter><32 hex group id><question id>_<page>_<row>. The
  // question id is a number Progressive reassigns: it keeps a page's rows of one question
  // together, and is logged, but never says which question a field is (see assign).
  function dctQuestionId(id) {
    return String(id ?? '').match(/^f_[a-z]([0-9a-f]{32})([0-9a-f]+)_\d+_\d+/i)?.[2]?.toUpperCase() ?? null;
  }

  // Its <page>_<row>: on Progressive's Rates every question of one vehicle shares the row, and
  // one of them is labelled with the vehicle ("2025 RAM PROMASTER 2500").
  const VEHICLE_LABEL = /^(?:19|20)\d{2}\s+\S/;
  function dctRow(id) {
    return String(id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_(\d+_\d+)/i)?.[1] ?? null;
  }

  // The page is waiting on its server or re-drawing after an answer.
  function pageBusy() {
    const X = ext();
    if (X?.Ajax?.isLoading?.()) return true;
    // #loadingDefault: AmWINS' overlay while it saves or reloads the application (it redraws every
    // step when the reload lands, so nothing may be filled before that).
    return [...document.querySelectorAll('.x-mask-msg, .x-mask-loading, [class*="loading-mask"], [class*="LoadingMessage"], #loadingDefault')]
      .some((m) => m.getClientRects().length && getComputedStyle(m).visibility !== 'hidden');
  }

  // Wait until the page stops changing: not busy and no new nodes for `quietMs`.
  async function settle({ quietMs = 250, maxMs = 15000 } = {}) {
    let last = Date.now();
    const mo = new MutationObserver(() => { last = Date.now(); });
    mo.observe(document.body, { subtree: true, childList: true });
    const start = Date.now();
    try {
      await sleep(60);
      while (Date.now() - start < maxMs) {
        if (!pageBusy() && Date.now() - last >= quietMs) return true;
        await sleep(60);
      }
      return false;
    } finally {
      mo.disconnect();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Finding the fields on the page

  // Selectors of rules allowed to fill a field that isn't on screen (set while a fill runs): a
  // question the page adds to an earlier step of a one-address application after it was left.
  let hiddenOk = [];

  function collectControls() {
    const out = [];
    const groups = new Map();
    for (const el of deepQueryAll(document, CONTROL_SELECTOR)) {
      const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : el.tagName.toLowerCase();
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(type)) continue;
      if (el.disabled || (!isVisible(el) && !hiddenOk.some((sel) => safeMatches(el, sel)))) continue;
      const cmp = extCmp(el);
      if (type === 'radio') {
        const extGroup = cmp?.up?.('radiogroup') ?? null;
        const key = extGroup ? `x:${extGroup.id}` : `${el.form ? 'f' : ''}:${globalThis.__raterFieldKey(el)}`;
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
      // A checkbox in a group ("Filings: [ ] Federal [ ] MCS-90") is named by its own box label.
      c.label = (c.kind === 'checkbox' && cmp?.boxLabel ? oneLine(String(cmp.boxLabel).replace(/<[^>]+>/g, ' ')) : null) ?? dctCaption(cmp) ?? labelFor(el);
      c.q = dctQuestionId(cmp?.id ?? el.id);
      c.ref = fieldRef(el);
      out.push(c);
    }
    for (const g of groups.values()) {
      g.options = g.radios.map((r) => {
        const item = extCmp(r);
        return { el: r, cmp: item, text: oneLine(String(item?.boxLabel ?? '').replace(/<[^>]+>/g, ' ')) || oneLine([...(r.labels ?? [])].map(textOutsideControls).join(' ')) || r.value, value: r.value };
      });
      g.label = dctCaption(g.cmp) ?? radioGroupLabel(g.radios, g.options.map((o) => o.text));
      g.q = dctQuestionId(g.cmp?.id ?? g.el.id) ?? (String(g.el.name).match(/^[a-z]+_([0-9A-F]+)/)?.[1] ?? null);
      g.ref = g.radios.map(fieldRef).find(Boolean) ?? null;
    }
    for (const c of out) {
      c.text = squash(c.label);
      c.hint = humanize(c.el.name || c.el.id || '');
      c.required = dctRequired(c.cmp) || isRequired(c.el, c.label);
    }
    // The vehicle a per-vehicle row belongs to: a question labelled with it ("2025 RAM PROMASTER
    // 2500") names its row, and the row's unlabelled questions (vehicle value, equipment) are its
    // too. A row naming two vehicles names none.
    const rowVehicle = new Map();
    for (const c of out) {
      c.row = dctRow(c.cmp?.id ?? c.el.id);
      if (!c.row || !VEHICLE_LABEL.test(c.label ?? '')) continue;
      rowVehicle.set(c.row, rowVehicle.has(c.row) && rowVehicle.get(c.row) !== c.text ? null : c.text);
    }
    for (const c of out) c.vehicle = VEHICLE_LABEL.test(c.label ?? '') ? c.text : (c.row && rowVehicle.get(c.row)) || null;
    return out;
  }

  function optionsOf(c) {
    if (c.options) return c.options;
    if (c.kind === 'select') return [...c.el.options].map((o) => ({ el: o, text: oneLine(o.text), value: o.value }));
    return [];
  }

  const isPlaceholderOption = (text) => /^(-+|select\b|choose\b|please\b|\s*$)/i.test(oneLine(text));

  // What the AI assistant needs to know about a field left for the agent: its choices (never
  // agency staff lists), the heading it sits under, and what the page shows now.
  function describe(c) {
    const options = /agent|producer/i.test(c.label ?? '') ? []
      : [...new Set(optionsOf(c).map((o) => o.text).filter((t) => t && !isPlaceholderOption(t)))];
    return { options, section: sectionOf(c.el), current: c.kind === 'text' ? (c.el.value ? 'has a value' : null) : selectedText(c) };
  }

  // An ExtJS field's value. A combo whose list was never loaded (or was torn down by a redraw)
  // throws from getValue(); its box text is then the best answer there is.
  function cmpValue(cmp, el) {
    try { return cmp.getValue(); } catch { return el?.value || null; }
  }

  function hasValue(c) {
    if (c.kind === 'radio') return c.options.some((o) => (o.cmp ? !!cmpValue(o.cmp, o.el) : o.el.checked));
    if (c.cmp && c.kind === 'select') {
      const v = cmpValue(c.cmp, c.el);
      return v != null && v !== '' && !isPlaceholderOption(c.cmp.getRawValue?.() ?? '');
    }
    if (c.kind === 'text') return c.el.value.trim() !== '';
    if (c.kind === 'checkbox') return c.el.checked;
    const o = c.el.selectedOptions?.[0];
    return !!o && o.value !== '' && !isPlaceholderOption(o.text);
  }

  function selectedText(c) {
    if (c.kind === 'checkbox') return c.el.checked ? 'checked' : 'unchecked';
    if (c.kind === 'radio') return c.options.find((o) => (o.cmp ? cmpValue(o.cmp, o.el) : o.el.checked))?.text ?? null;
    if (c.cmp) return oneLine(c.cmp.getRawValue?.() ?? '') || null;
    const o = c.el.selectedOptions?.[0];
    return o && !isPlaceholderOption(o.text) ? oneLine(o.text) : null;
  }

  // ExtJS keeps a stale "you must select one item" error on a group until it re-validates, so
  // ask the component to validate now rather than reading the old message.
  function invalidControl(c) {
    if (c.el.getAttribute('aria-invalid') === 'true' || c.el.validity?.valid === false) return true;
    const cmp = c.cmp ?? c.options?.[0]?.cmp?.up?.('radiogroup');
    if (typeof cmp?.isValid === 'function') { try { return !cmp.isValid(); } catch { return false; } }
    return typeof cmp?.getActiveError === 'function' && !!cmp.getActiveError();
  }

  // Same answer, different formatting: 45000 / "45,000" / "$45,000", 02/03/1988 / 1988-02-03.
  function loose(v) {
    const s = String(v ?? '').trim();
    const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/) ?? s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    // 1/5/1980, 01/05/1980 and 1980-01-05 are the same date.
    if (m) return m[0].startsWith(m[3]) ? `d${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}` : `d${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}${m[3]}`;
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Some known answers become a summary plus a dependent question after the server redraw.
  // Require both witnesses so disappearing controls alone never count as accepted answers.
  function summaryAccepted(step, controls) {
    if (!step.summaryAfter || !controls.some((c) => c.text === squash(step.summaryAfter))) return false;
    return (document.body.innerText ?? '').split(/\r?\n/).some((line) => {
      const text = squash(line).replace(/^business(?: type)? /, '').replace(/ edit$/, '');
      return [step.value, ...(step.choiceAliases ?? [])].some((value) => text === squash(value));
    });
  }

  // Same key the usage recorder (recorder.js) uses, so its changes can be tied to our fills.
  function fieldKey(c) {
    return globalThis.__raterFieldKey(c.el, { q: c.q });
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); } catch { return false; }
  }

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
  function assign(controls, plan) {
    const used = new Set();
    const donePaths = new Set();
    const pairs = [];
    const page = currentPage();
    const steps = plan.map((s) => ({ ...s, reC: s.re ? new RegExp(s.re, 'i') : null, exC: s.ex ? new RegExp(s.ex, 'i') : null }));
    const take = (s, c, how, reworded = false) => { used.add(c); donePaths.add(s.path); pairs.push({ step: s, control: c, how, reworded }); };
    const fits = (s, c) => !(c.kind === 'checkbox' && s.kind !== 'bool');
    const known = (s) => !!(s.field || s.ask?.length || (s.reC && s.pages?.length));
    // A question's own pages (`notPages`: never there, whatever finds it).
    const onPage = (s) => (!s.pages?.length || s.pages.includes(page)) && !s.notPages?.includes(page);
    // A data-model name is found on any page, except where the step is fenced off: a trailer's
    // questions carry the vehicle's names (RiskInput.VIN), so each is kept to its own pages.
    const nameHere = (s) => (s.pageOnly ? onPage(s) : !s.notPages?.includes(page));
    const worded = (s) => !!s.ask?.length || !!s.reC;
    const textIs = (s, x) => !!x.text && ((s.ask ?? []).some((a) => squash(a) === x.text) || (!!s.reC && s.reC.test(x.text) && !(s.exC && s.exC.test(x.text))));
    // Data-model names some rule knows: those fields are that rule's, never a text rule's.
    const claimed = new Set(steps.map((s) => s.field).filter(Boolean));
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
        if (s.selector) c = controls.find((x) => !used.has(x) && (safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector))));
        // A dropdown with no usable label, known by one of its options ("NO PRIOR").
        if (!c && s.withOption) { how = 'option'; c = controls.find((x) => !used.has(x) && optionsOf(x).some((o) => squash(o.text) === squash(s.withOption))); }
      }
      if (c) take(s, c, how, !!s.field && worded(s) && !textIs(s, c));
    }
    // A data-model name not on the page, while its expected wording is: the field was probably renamed.
    pairs.renamed = steps.filter((s) => s.field && worded(s) && onPage(s) && nameHere(s) && !found.get(s).length)
      .flatMap((s) => { const x = controls.find((y) => !used.has(y) && y.ref !== s.field && !claimed.has(y.ref) && textIs(s, y)); return x ? [{ step: s, control: x }] : []; });
    for (const field of ['text', 'hint']) {
      for (const s of steps) {
        if (!s.reC || known(s) || donePaths.has(s.path) || !onPage(s)) continue;
        const c = controls.find((x) => !used.has(x) && !repeated.has(x.q) && !perVehicle.has(x) && x[field] && fits(s, x) && s.reC.test(x[field]) && !(s.exC && s.exC.test(x[field])));
        if (c) take(s, c, field === 'text' ? 'label' : 'name');
      }
    }
    return pairs;
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

  function matchOption(options, step) {
    // Options that read the same are the same choice (pages sometimes list one twice).
    const seenText = new Set();
    const usable = options.filter((o) => {
      const k = squash(o.text);
      if (!k || isPlaceholderOption(o.text) || seenText.has(k)) return false;
      seenText.add(k);
      return true;
    });
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
    if (step.kind === 'first-option') return usable[0] ?? null;
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
    // Date boxes with a vanillajs-datepicker (AmWINS): the page reads the picker's date, not the
    // box, and the picker only takes typed text on Tab / Enter / leaving the box. Tab is handled
    // the same whether its calendar is open or not.
    if (el.classList?.contains('datepicker-input')) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
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

  // Address boxes with the carrier's own address suggestions: type the whole one-line address,
  // wait for the suggestion list, pick its first entry (which fills street, city and ZIP).
  // No suggestion means the address needs the agent; the ZIP/city rules then check the rest.
  const SUGGESTION_SELECTOR = '[role=option], .x-boundlist-item, .pac-item, [class*="suggest"] li, [class*="Suggest"] li, [class*="autocomplete"] li, [class*="Autocomplete"] li';
  const shownSuggestions = () => deepQueryAll(document, SUGGESTION_SELECTOR).filter((el) => el.getClientRects().length && oneLine(el.textContent));
  async function applyAddress(step, c) {
    const text = String(step.value);
    const { el, cmp } = c;
    const before = new Set(shownSuggestions());
    // Google's address autocomplete (Progressive uses it): its list (.pac-item) is only shown
    // while the box has focus, which it doesn't while the agent works in the side panel. The
    // suggestions are still there, hidden; they're picked the way the keyboard does (↓, Enter).
    const pacBefore = new Map(deepQueryAll(document, '.pac-item').map((x) => [x, x.textContent]));
    const houseNumber = text.match(/^\s*(\d+)/)?.[1] ?? null;
    const freshPac = () => deepQueryAll(document, '.pac-item').find((x) => pacBefore.get(x) !== x.textContent && oneLine(x.textContent) && (!houseNumber || x.textContent.includes(houseNumber))) ?? null;
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new Event('focus'));
    if (cmp) cmp.setValue(text);
    else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, text);
    // Suggestion lists listen for typing: send the events typing would.
    for (const type of ['input', 'keydown', 'keyup']) el.dispatchEvent(new Event(type, { bubbles: true }));
    try { cmp?.fireEvent?.('change', cmp, text); } catch { /* page handler expected a real event */ }
    // What the page adds while it thinks: when no known list shows up, the reason names the new
    // elements (tag.class), so the carrier's suggestion list can be recognised next time.
    const added = [];
    const mo = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && added.length < 40) added.push(n);
    }) : null;
    mo?.observe(document.body, { subtree: true, childList: true });
    let first = null;
    try {
      for (const start = Date.now(); !first && Date.now() - start < 4000;) {
        await sleep(200);
        first = freshPac() ?? shownSuggestions().find((x) => !before.has(x)) ?? null;
      }
    } finally {
      mo?.disconnect();
    }
    if (!first) {
      // A box with its own city/ZIP boxes gets back just the street.
      if (step.fallback) {
        if (cmp) cmp.setValue(step.fallback);
        else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, step.fallback);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.blur?.();
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
    const e = typeof KeyboardEvent === 'function' ? new KeyboardEvent(type, { key, bubbles: true, cancelable: true }) : new Event(type, { bubbles: true });
    for (const prop of ['keyCode', 'which']) { try { Object.defineProperty(e, prop, { get: () => code }); } catch { /* read-only */ } }
    if (!('key' in e)) e.key = key;
    return e;
  }

  // Type-ahead dropdowns (select2: a hidden <select> with a search box the page fills from its
  // server). Open it, type `step.search`, and pick the one result containing `step.value`; no
  // such result (or several) means no confident match, and the agent picks.
  async function applySearchSelect(step, c) {
    const select = c.el;
    const container = [select.nextElementSibling, ...(select.parentElement?.children ?? [])]
      .find((n) => n && n !== select && /\bselect2\b/.test(String(n.className))) ?? null;
    const opener = container?.querySelectorAll?.('.select2-selection')?.[0] ?? container;
    if (!opener) return { ok: false, reason: 'the search box for this list was not found; pick it yourself' };
    // select2 opens on a left-button mousedown (it checks the event's button), so a plain Event
    // isn't enough.
    const Mouse = typeof MouseEvent === 'function' ? MouseEvent : Event;
    const press = (el) => { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new Mouse(type, { bubbles: true, cancelable: true, button: 0 })); };
    press(opener);
    let box = null;
    for (const start = Date.now(); !box && Date.now() - start < 3000;) {
      await sleep(100);
      box = deepQueryAll(document, '.select2-search__field').find((n) => n.getClientRects().length) ?? null;
    }
    if (!box) return { ok: false, reason: "the list's search box didn't open; pick it yourself" };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, String(step.search ?? step.value));
    for (const type of ['input', 'keyup']) box.dispatchEvent(new Event(type, { bubbles: true }));
    const want = squash(step.value);
    let hits = [];
    for (const start = Date.now(); Date.now() - start < 6000;) {
      await sleep(200);
      const results = deepQueryAll(document, '.select2-results__option').filter((n) => n.getClientRects().length && !/loading|message/.test(String(n.className)));
      // The result that is exactly the wanted text wins over others that only contain it.
      const exact = results.filter((n) => squash(n.textContent) === want);
      hits = exact.length ? exact : results.filter((n) => squash(n.textContent).includes(want));
      if (results.length) break;
    }
    if (hits.length !== 1) {
      box.dispatchEvent(new Event('keydown', { bubbles: true }));
      document.body.dispatchEvent(new Mouse('mousedown', { bubbles: true, button: 0 }));
      return { ok: false, reason: hits.length ? `${hits.length} results match "${step.value}"; pick the right one` : `no confident match for "${step.value}"; pick it yourself` };
    }
    press(hits[0]);
    await settle({ quietMs: 250, maxMs: 4000 });
    return squash(selectedText(c) ?? '').includes(want) ? { ok: true, shown: oneLine(hits[0].textContent) } : { ok: false, reason: 'the page did not keep the choice; pick it yourself' };
  }

  // Returns { ok: true, shown } or { ok: false, reason, options? }.
  async function apply(step, c) {
    if (step.kind === 'address-suggest' && c.kind === 'text') return applyAddress(step, c);
    if (step.kind === 'search-select') return applySearchSelect(step, c);
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
    let options = optionsOf(c);
    let opt = matchOption(options, step);
    // A list still waiting for its options (loaded after the page shows): give it a few seconds.
    for (const start = Date.now(); !opt && c.kind === 'select' && options.filter((o) => oneLine(o.text)).length <= 1 && Date.now() - start < 6000;) {
      await sleep(250);
      options = optionsOf(c);
      opt = matchOption(options, step);
    }
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
  // Type-ahead lists (e.g. Progressive's business type list) only hold what matches the typed
  // text: type the value, wait for the list to load, then pick.
  async function queryCombo(cmp, text) {
    if (typeof cmp.doQuery !== 'function') return null;
    cmp.doQuery(text, false, true);
    const start = Date.now();
    await sleep(200);
    if (!cmp.store) return null;
    while (cmp.store?.isLoading?.() && Date.now() - start < 6000) await sleep(100);
    return storeOptions(cmp);
  }

  // A list redrawn while it's answered may have lost its store (TX 2026-10-07): no options.
  const storeOptions = (cmp) => (cmp.store?.getRange?.() ?? []).map((rec) => ({ rec, text: oneLine(rec.get(cmp.displayField)), value: rec.get(cmp.valueField ?? cmp.displayField) }));
  const hasOptions = (options) => options.some((o) => !isPlaceholderOption(o.text));

  async function applyExt(step, c) {
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
      let opt = matchOption(c.options, step);
      if (!opt && step.kind !== 'bool') {
        for (const q of [String(step.value), String(step.value).split(/\s+/).slice(0, 2).join(' ')]) {
          const loaded = await queryCombo(cmp, q);
          opt = loaded && matchOption(loaded, step);
          if (opt) break;
        }
      }
      // A list that fills in only after another answer (Progressive's cargo commodities, once
      // their category is picked) may still be empty: give it a few seconds to load.
      for (const start = Date.now(); !opt && !hasOptions(storeOptions(cmp)) && Date.now() - start < 6000;) {
        await sleep(250);
        opt = matchOption(storeOptions(cmp), step);
      }
      if (!opt) return noMatch(step, hasOptions(c.options) ? c.options : storeOptions(cmp));
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
      el.style.outline = `2px ${status === 'filled' || status === 'ai' ? 'solid' : 'dashed'} ${COLORS[status]}`;
      el.style.outlineOffset = '1px';
      if (note) el.setAttribute('title', `Rater Autofill: ${note}`);
    }
  }

  function clear() {
    aiBanner([]);
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

  // Does the field already hold the answer we'd give?
  function agreesWith(step, c) {
    // The chosen suggestion rewrites the typed address in the page's own format.
    if (step.kind === 'address-suggest') return c.kind === 'text' && hasValue(c);
    if (step.kind === 'search-select') return squash(selectedText(c) ?? '').includes(squash(step.value));
    if (c.kind === 'checkbox') return typeof step.value === 'boolean' && (c.cmp ? !!cmpValue(c.cmp, c.el) : c.el.checked) === step.value;
    if (step.kind === 'selected-option') return /^selected\b/i.test(selectedText(c) ?? '');
    if (c.kind === 'text') {
      if (loose(c.el.value) === loose(textFor(step, c))) return true;
      // Carriers standardize addresses to ZIP+4 (and intakes sometimes have it): 17101-1234 is
      // 17101, whichever side has the +4.
      if (/zip/i.test(step.path ?? '') && /^\d{5}(?:-?\d{4})?$/.test(String(step.value).trim())) {
        const five = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 5);
        return five(c.el.value).length === 5 && five(c.el.value) === five(step.value);
      }
      if (step.kind === 'money') {
        const amount = (v) => /^\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*$/.test(String(v)) ? Number(String(v).replace(/[$,\s]/g, '')) : null;
        const actual = amount(c.el.value), wanted = amount(step.value);
        return actual != null && wanted != null && actual === wanted;
      }
      return oneLine(c.el.value) === oneLine(textFor(step, c));
    }
    const current = selectedText(c);
    const opt = matchOption(optionsOf(c), step);
    return !!opt && oneLine(opt.text) === oneLine(current ?? '');
  }

  // ---------------------------------------------------------------------------------------------
  // Clicking buttons (carrier "actions": Verify DOT, Lookup VIN, Add a Commodity, …)

  // Never clicked, whatever a rule says: moving on or committing is always the agent's call.
  const NEVER_CLICK = /\b(continue|next|start quote|finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out)\b/i;

  // Progressive names its pages in ?pageName=; other sites by path or #/route (ids normalised).
  const currentPage = () => (new URLSearchParams(location.search).get('pageName') || (location.pathname + ((location.hash ?? '').startsWith('#/') ? location.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id')).replace(/-Reload$/, '');

  function ratesStale() {
    const text = document.body.innerText ?? '';
    // "The coverages have changed, please "recalculate" to see your rate." / "Recalculate to see
    // coverage cost" (Progressive), or a premium of ****.
    return /\*{4}|(?:must|please|need to)\W+recalculate|recalculate to see|premium.*(?:out of date|not current)|chang\w*.*recalculate/i.test(text);
  }

  function premiumReady() {
    if (pageBusy() || ratesStale()) return false;
    const text = document.body.innerText ?? '';
    // "Total premium amount $12,815.00 per year" (Progressive), "Total premium: $12,345.67".
    return /(?:total|annual|policy|estimated)\s+premium(?:\s+amount)?\s*:?\s*\$\s*[1-9][\d,]*(?:\.\d{2})?/i.test(text);
  }

  // The page's own "move on" button, only ever used when nothing is left for the agent. Buttons
  // that commit anything stay off limits whatever the pattern says.
  const NEVER_ADVANCE = /\b(finish|buy|bind|purchase|submit|save|delete|remove|cancel|logout|log out|sign out|order)\b/i;
  function findAdvanceButton(pattern) {
    const re = new RegExp(pattern, 'i');
    let best = null;
    for (const el of deepQueryAll(document, 'a, button, [role=button], input[type=button], input[type=submit], .x-btn')) {
      if (!el.getClientRects().length || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.x-item-disabled, .x-btn-disabled, [aria-disabled="true"]')) continue;
      const text = oneLine(el.value || el.textContent);
      // "Save & Continue" (AmWINS) only saves the draft and opens the next step.
      const committing = NEVER_ADVANCE.test(text.replace(/^save\s*(?:&|and)\s*continue$/i, 'continue'));
      if (text.length > 40 || committing || !re.test(text)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // `disabledToo`: also a visible button the page has disabled (a link that must be gone).
  function findButton(step, { disabledToo = false } = {}) {
    const re = step.text ? new RegExp(step.text, 'i') : null;
    let best = null;
    // `unique`: two separate matches (two reefer tiles) leave the choice to the agent.
    const separate = [];
    for (const el of deepQueryAll(document, 'a, button, [role=button], [role=link], input[type=button], input[type=submit], .x-btn, [onclick]')) {
      if (!el.getClientRects().length) continue;
      if (!disabledToo && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.x-item-disabled, .x-btn-disabled, [aria-disabled="true"]'))) continue;
      const text = oneLine(el.value || el.textContent);
      if (NEVER_CLICK.test(text)) continue;
      const attrs = [el.id, el.getAttribute('name'), el.getAttribute('href'), el.getAttribute('onclick'),
        ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)].join(' ');
      const hit = (re && text.length <= 80 && re.test(text)) || (step.token && attrs.includes(step.token));
      if (!hit || (step.near && !isNear(el, step.near, re))) continue;
      // Prefer the innermost match (the link itself, not the table cell around it).
      if (!best || best.contains(el)) best = el;
      if (!separate.some((s) => s.contains(el) || el.contains(s))) separate.push(el);
    }
    return step.unique && separate.length > 1 ? null : best;
  }

  // For look-alike buttons ("+" next to every coverage): the button's section must mention
  // `near`, and the smallest block around it that does must hold no other such button.
  function isNear(el, near, re) {
    const want = near.toLowerCase();
    for (let p = el.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) {
      if (!p.textContent.toLowerCase().includes(want)) continue;
      const alike = [...p.querySelectorAll('a, button, [role=button], .x-btn, [onclick]')].filter((b) => re && re.test(oneLine(b.value || b.textContent)));
      return alike.filter((b) => !b.contains(el) && !el.contains(b)).length === 0;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Public API

  // Fills in rounds: each round re-reads the page, handles every step that now has a field, and
  // on pages that talk to their server after each answer (ExtJS/Duck Creek) stops after one
  // answer and waits. New questions that appear because of an answer get picked up next round.
  // `skip`: field keys to leave alone (ones the agent changed; used by automatic follow-up fills).
  // `doneActions`: button actions already clicked earlier in this quote.
  // `replaceChoices`: a dropdown/radio/checkbox answer the page pre-selected (not the agent) is
  // replaced when it differs from ours; agent changes are protected by `skip`.
  // `visitedPages`: pages already seen in this quote (for actions that wait on a page).
  // `advance`: { text, exceptPages } — when the page ends with nothing for the agent to look at
  // (no unfamiliar required fields, nothing missing, nothing failed), click its Continue button.
  // `batch`: for pages whose answers never wait on a server (AmWINS): every answer the round can
  // see is given in one pass and checked on the spot, with one wait for the page per round
  // instead of one per answer. What an answer reveals or redraws is picked up next round, and
  // anything the page changes later is given again (see `refill`).
  // `doneSteps`: steps of a one-address application (stepKey) already continued from: a step the
  // agent goes back to is theirs, never continued again.
  // `stopPages`: pages where the carrier has stopped the quote: nothing is filled or clicked there.
  async function fill(plan, { overwrite = false, maxRounds = 60, skip = [], keepMarks = false, doneActions = [], replaceChoices = false, visitedPages = [], advance = null, batch = false, doneSteps = [], stopPages = [] } = {}) {
    // An agent edit protects its field. A plain name saved by an older build (field-key v2)
    // protects every row key made from it (name#<row>): it could have been any row's edit.
    const skipKeys = new Set(skip);
    const skipped = Set.prototype.has.bind(skipKeys);
    skipKeys.has = (key) => skipped(key) || skipped(globalThis.__raterFieldKey.rowKeyBase?.(key));
    // A field the agent edited, by its key, or by the question id an older build kept it under
    // (version 3) in a quote begun before this one: left alone rather than overwritten.
    const skippedField = (c) => skipKeys.has(fieldKey(c)) || skipped(globalThis.__raterFieldKey.legacyKey?.(c.el, { q: c.q }));
    const actions = plan.filter((s) => s.kind === 'action');
    plan = plan.filter((s) => s.kind !== 'action');
    const clicked = new Set(doneActions);
    const openersTried = new Set();
    const nudged = new Set();
    // Answers the page changed or cleared after we gave them (a lookup redrawing its boxes, a
    // panel re-rendering), or didn't keep the first time: given again, at most twice each.
    const retries = new Map();
    const refill = new Set();
    // A lookup box its helper has already used (the VIN list Import Data empties) isn't given again.
    const immediateAfter = new Set(actions.filter((a) => a.immediate).flatMap((a) => a.after));
    hiddenOk = plan.filter((s) => s.hidden && s.selector).map((s) => s.selector);
    const consumedPaths = () => new Set(actions.filter((a) => clicked.has(a.action)).flatMap((a) => a.after));
    const retryOnce = (id) => { const n = retries.get(id) ?? 0; if (n >= 2) return false; retries.set(id, n + 1); return true; };
    // Server requests the page sends (ExtJS pages), counted for the per-answer timing.
    let ajaxCount = 0;
    const countAjax = () => { ajaxCount++; };
    try { ext()?.Ajax?.on?.('beforerequest', countAjax); } catch { /* no ExtJS events */ }
    const visited = new Set(visitedPages);
    const startPage = currentPage();
    if (!keepMarks) clear();
    const handled = new Map(); // step id -> { status, note }
    const report = { frame: location.origin + location.pathname, fields: 0, filled: [], noData: [], kept: [], failed: [], leftRequired: [], actions: [], unknown: [], blocked: [], protectedKeys: [], invalidatedActions: [], checks: [], reworded: [], renamed: [], halted: false, rounds: 0 };
    if (stopPages.includes(startPage)) {
      report.halted = true;
      report.reason = 'The carrier stopped this quote on this page: nothing is filled or clicked here.';
      return report;
    }
    const serverBacked = !!ext();
    let pendingAction = null;
    let progressed = false; // did the last round fill or click anything?
    if (!await settle({ quietMs: 400, maxMs: 15000 })) {
      report.halted = true;
      report.reason = 'The page is still waiting on its server. Review and retry.';
      return report;
    }
    const halt = (reason) => { report.halted = true; report.reason = reason; };
    // A real user edit during a fill must survive even while the recorder is paused.
    let lastGesture = -Infinity;
    const gestureTypes = ['pointerdown', 'keydown', 'paste', 'drop'];
    const trackGesture = (event) => { if (event.isTrusted) lastGesture = Date.now(); };
    const protectEdit = (event) => {
      if (!event.isTrusted || Date.now() - lastGesture > 2000) return;
      const c = collectControls().find((x) => x.el === event.target || x.radios?.includes(event.target));
      if (c) { skipKeys.add(fieldKey(c)); report.protectedKeys.push(fieldKey(c)); halt('An agent edit interrupted filling. Review before resuming.'); }
    };
    for (const type of gestureTypes) document.addEventListener(type, trackGesture, true);
    document.addEventListener('input', protectEdit, true);
    document.addEventListener('change', protectEdit, true);
    try {

    for (let round = 0; round < maxRounds; round++) {
      report.rounds = round + 1;
      const controls = collectControls();
      report.fields = Math.max(report.fields, controls.length);
      if (report.halted) break;
      const allPairs = assign(controls, plan);
      // Review items are flagged in yellow and the rest of the page still fills. Only a stuck
      // page or an agent edit stops the fill.
      const mapped = new Set(allPairs.map((p) => p.control));
      // Rows of one repeated question share a key; their labels (the vehicle) tell them apart.
      const flag = (list, item) => { if (!list.some((x) => x.key === item.key && x.label === item.label)) list.push(item); };
      // Known questions whose wording changed (answered, and flagged when answered), and fields that
      // read like a known question whose data-model name isn't on the page (left for the agent).
      for (const p of allPairs.filter((x) => x.reworded)) flag(report.reworded, { label: p.control.label, key: fieldKey(p.control), name: p.step.name, field: p.step.field });
      const renamed = new Map(allPairs.renamed.map((r) => [r.control, r.step]));
      for (const [c, step] of renamed) flag(report.renamed, { label: c.label, key: fieldKey(c), name: step.name, field: step.field, now: c.ref ?? null });
      for (const c of controls) {
        if (mapped.has(c) || skippedField(c)) continue;
        flag(report.unknown, { label: c.label, key: fieldKey(c), q: c.q, ref: c.ref ?? null, controlKind: c.kind, required: c.required, ...describe(c) });
        mark(c, 'needs', renamed.has(c) ? `Looks like "${renamed.get(c).name}", but the carrier renamed this field: left for you.` : 'Unfamiliar question — left for you.');
      }
      for (const c of controls) {
        if (!mapped.has(c) || skippedField(c) || !hasValue(c) || !invalidControl(c)) continue;
        // An answer the page invalidated after another one changed (Progressive's liability limit
        // after a PIP change) is picked again, at most twice; then it's the agent's.
        const own = allPairs.find((p) => p.control === c)?.step;
        if (own && own.value != null && !own.ignore && !own.note && !own.verifyOnly && retryOnce(own.id)) {
          report.failed = report.failed.filter((x) => x.key !== fieldKey(c));
          handled.delete(own.id);
          refill.add(own.id);
          continue;
        }
        flag(report.failed, { label: c.label, key: fieldKey(c), q: c.q, controlKind: c.kind, reason: 'The page marks this answer invalid.', ...describe(c) });
        mark(c, 'failed', 'the page marks this answer invalid');
      }
      for (const { step, control } of allPairs) {
        if (skippedField(control) || !hasValue(control)) continue;
        if (step.verifyOnly && !agreesWith(step, control)) {
          flag(report.failed, { label: control.label, key: fieldKey(control), q: control.q, reason: 'The looked-up value differs from the intake. Check the VIN.' });
          mark(control, 'failed', 'lookup result differs from the intake');
        } else if (!step.verifyOnly && !step.ignore && !step.note && !step.replace && !step.trustPage && step.value != null && control.kind === 'text' && !overwrite && !agreesWith(step, control) && !handled.has(step.id) && !refill.has(step.id)) {
          // The page already had a different value (e.g. from the USDOT lookup): keep it, show it.
          flag(report.kept, { label: control.label, key: fieldKey(control), q: control.q, path: step.path, name: step.name, differs: true });
          mark(control, 'needs', `page says something different from the intake (${step.name})`);
          handled.set(step.id, { status: 'needs', note: `page value differs from the intake: ${step.name}` });
        }
      }
      const consumed = consumedPaths();
      for (const previous of [...report.filled]) {
        const pair = allPairs.find(({ step }) => step.id === previous.stepId);
        if (!pair || skippedField(pair.control) || agreesWith(pair.step, pair.control) || consumed.has(pair.step.path)) continue;
        if (retryOnce(pair.step.id)) {
          report.filled = report.filled.filter((x) => x !== previous);
          handled.delete(pair.step.id);
          refill.add(pair.step.id);
          continue;
        }
        if (hasValue(pair.control)) {
          report.failed.push({ ...previous, reason: 'A later server response changed this answer; check it.' });
          report.filled = report.filled.filter((x) => x !== previous);
          handled.set(pair.step.id, { status: 'failed', note: 'a later server response changed this answer' });
        }
      }
      if (report.halted) break;
      // Buttons that must come right after their field (Verify DOT, Lookup VIN) go first.
      if (window === window.top && clickNextAction(controls, true)) {
        // A lookup (Import Data) may wait on its server without changing the page for a while.
        if (!await settle(serverBacked ? {} : { quietMs: 800, maxMs: 8000 })) { halt('The helper response did not settle. Review before retrying.'); break; }
        if (!verifyAction()) break;
        if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
        continue;
      }
      const pairs = assign(controls, plan).filter(({ step, control }) => !handled.has(step.id) && !skippedField(control));
      let changed = false;
      // A failed answer may still have redrawn the page (new questions): look again next round.
      let retry = false;
      for (const { step: planned, control: c, how, reworded } of pairs) {
        // A known field whose question reads differently now: answered, and the agent checks it.
        const step = reworded ? { ...planned, warn: [planned.warn, `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check the answer.`].filter(Boolean).join(' ') } : planned;
        const item = { stepId: step.id, label: c.label, path: step.path, name: step.name, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, how };
        // A question left as the page has it whose wording changed: what the page has may not fit
        // any more, so the agent checks it (Continue waits).
        const leftAlone = step.verifyOnly || step.ignore;
        if (leftAlone && reworded) {
          const note = `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check what the page has.`;
          if (step.verifyOnly) report.kept.push(item);
          report.checks.push({ ...item, note, ...describe(c) });
          handled.set(step.id, { status: 'needs', note });
          continue;
        }
        if (step.verifyOnly) { report.kept.push(item); handled.set(step.id, { status: null }); continue; }
        if (step.ignore || (!hasValue(c) && consumedPaths().has(step.path))) { handled.set(step.id, { status: null }); continue; }
        if (step.businessNames?.length) {
          // The registered names the USDOT lookup offers (Progressive's Business Name choice).
          const registered = assign(controls, plan).find((p) => p.step.registeredName)?.control;
          const names = uniqueBusinessNames(registered ? optionsOf(registered).filter((o) => o.text.trim() && !/^enter a different/i.test(o.text)) : []);
          const matches = names.filter((o) => step.businessNames.some((name) => businessNameKey(o.text) === businessNameKey(name)));
          if (names.length && matches.length !== 1) {
            const note = 'The DOT lookup business name differs from the intake. Verify the identity before accepting it.';
            report.noData.push({ ...item, note, reviewOnly: true, ...describe(c) });
            handled.set(step.id, { status: 'needs', note });
            continue;
          }
        }
        if (step.note || step.value == null) {
          if (step.optional) { handled.set(step.id, { status: null }); continue; }
          report.noData.push({ ...item, note: step.note, ...describe(c) });
          handled.set(step.id, { status: 'needs', note: step.note ?? `intake form has no answer for ${step.name}` });
          continue;
        }
        // A pre-selected "Enter a different …" isn't an answer worth keeping for pick-not steps.
        const presetToReplace = step.kind === 'pick-not' && new RegExp(step.value.not, 'i').test(selectedText(c) ?? '') && !agreesWith(step, c);
        const isChoice = c.kind === 'radio' || c.kind === 'select' || c.kind === 'checkbox';
        const differs = isChoice && replaceChoices && !agreesWith(step, c);
        if (!overwrite && hasValue(c) && !presetToReplace && !differs && !refill.has(step.id) && !(step.replace && !agreesWith(step, c))) {
          report.kept.push(item);
          // Still our default from an earlier fill: still the agent's to confirm.
          if (step.warn && agreesWith(step, c)) {
            report.checks.push({ ...item, note: step.warn, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.warn });
          } else handled.set(step.id, { status: null });
          continue;
        }
        // Timing and side effects of this answer, for working out which questions could be
        // answered together: did it reach the server, did questions appear or disappear, did
        // other answers change.
        // Batch: a field an earlier answer this round redrew is answered next round.
        if (batch && c.el.isConnected === false) { retry = true; continue; }
        const snap = (list) => new Map(list.map((x) => [`${fieldKey(x)}|${x.label}`, x.kind === 'text' ? x.el.value : selectedText(x)]));
        const before = batch ? null : snap(controls);
        const t0 = Date.now();
        const requests0 = ajaxCount;
        let result;
        try { result = await apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
        const tApplied = Date.now();
        if (result.ok && batch) {
          item.timing = { ms: Date.now() - t0, settleMs: 0, ajax: ajaxCount - requests0, revealed: 0, removed: 0, changed: 0, batch: true };
          if (report.halted) result = { ok: false, reason: 'the agent interrupted filling' };
          else if (c.el.isConnected === false) result = { ok: false, reason: 'the page did not keep the answer; check it' };
          else if (invalidControl(c) || !agreesWith(step, c)) result = { ok: false, reason: 'the page did not keep the answer; check it' };
        } else if (result.ok) {
          const settled = await settle(serverBacked ? {} : { quietMs: 150, maxMs: 3000 });
          const currentControls = collectControls();
          const after = snap(currentControls);
          const mine = `${fieldKey(c)}|${c.label}`;
          item.timing = {
            ms: Date.now() - t0, settleMs: Date.now() - tApplied, ajax: ajaxCount - requests0,
            revealed: [...after.keys()].filter((k) => !before.has(k)).length,
            removed: [...before.keys()].filter((k) => !after.has(k)).length,
            changed: [...before.keys()].filter((k) => k !== mine && after.has(k) && after.get(k) !== before.get(k)).length,
          };
          const fresh = assign(currentControls, plan).find((p) => p.step.id === step.id)?.control;
          // An address box may collapse once a suggestion is picked; the ZIP/city rules check it.
          const accepted = fresh ? !invalidControl(fresh) && agreesWith(step, fresh) : step.kind === 'address-suggest' || summaryAccepted(step, currentControls);
          if (!settled || !accepted || report.halted) {
            result = { ok: false, reason: !settled ? 'the page did not settle after the answer' : !fresh ? 'the field disappeared after the answer; check the page' : report.halted ? 'the agent interrupted filling' : 'the page did not keep the answer; check it' };
          }
        }
        if (result.ok) {
          if (currentPage() === 'CoveragesRates') {
            // The bill plan (payment method) stays chosen; the premium needs recalculating.
            // A cargo answer re-arms Done with this coverage too.
            for (const id of ['recalculate', 'print', 'printSend', ...(step.cargo ? ['doneCargo'] : [])]) {
              clicked.delete(id);
              report.actions = report.actions.filter((x) => x.id !== id);
              if (!report.invalidatedActions.includes(id)) report.invalidatedActions.push(id);
            }
          }
          report.filled.push({ ...item, shown: result.shown });
          handled.set(step.id, { status: 'filled', note: `filled from intake: ${step.name}` });
          if (step.warn) {
            report.checks.push({ ...item, note: step.warn, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.warn });
          }
          changed = true;
          // Batch: carry on with the next answer, except before a helper button that waits on
          // this one (Import Data after the VIN list): it's clicked first thing next round.
          if (!batch || immediateAfter.has(step.path)) break;
        } else if (/did not keep/.test(result.reason ?? '') && !report.halted && retryOnce(step.id)) {
          // Often a later redraw resets it (a coverage list reloading): try again next round.
          refill.add(step.id);
          retry = true;
          if (serverBacked) break;
        } else {
          report.failed.push({ ...item, reason: result.reason, ...describe(c) });
          handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${result.reason}` });
          retry = true;
          if (report.halted) break;
          // On pages that redraw after every answer, a failed answer may have redrawn it too: the
          // controls read this round may be gone, so read the page again before the next one.
          if (serverBacked) break;
        }
      }
      if (report.halted) break;
      // Nothing left to type or pick: click the next button whose turn it is.
      let helperClicked = false;
      if (!changed && window === window.top) changed = helperClicked = clickNextAction(controls);
      progressed = changed;
      if (!changed && !retry) break;
      if (!changed) continue;
      // An answer given one at a time has already waited for the page (above); only a helper
      // click or a batch of answers still needs the wait. (Waiting twice cost Progressive about
      // 0.3 s per answer.)
      if ((helperClicked || batch) && !await settle(serverBacked ? {} : { quietMs: batch ? 150 : 250, maxMs: 3000 })) { halt('The page did not settle after the helper.'); break; }
      if (!verifyAction()) break;
      if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
    }

    function verifyAction() {
      const a = pendingAction;
      pendingAction = null;
      if (!a) return true;
      if (a.verify === 'download') {
        report.documentPending = true;
        return true;
      }
      let accepted = true;
      if (a.verify === 'premium') accepted = premiumReady();
      // A link that opens a section (Add Non-Trucking Liability) is gone once it took; still on
      // screen but disabled is not gone.
      if (a.verify === 'gone') accepted = !findButton(a, { disabledToo: true });
      if (a.verify === 'cargoClosed') {
        const controls = collectControls();
        // The cargo section's questions still on screen (found by the rules for them).
        const expanded = assign(controls, plan).some(({ step }) => step.cargo === 'section');
        const cargoSteps = plan.filter((s) => s.cargo === 'limit' && s.value != null);
        const retained = assign(controls, cargoSteps).some(({ step, control }) => agreesWith(step, control));
        const summary = (document.body.innerText ?? '').match(/motor truck cargo[^\n]*(?:\n[^\n]*){0,2}/i)?.[0] ?? '';
        const amounts = moneyTokens(summary);
        const summaryAgrees = cargoSteps.some((s) => moneyTokens(s.value).length >= 2 && moneyTokens(s.value).every((n) => amounts.includes(n)));
        accepted = !expanded && (retained || summaryAgrees);
      }
      if (!accepted) {
        clicked.delete(a.action);
        report.invalidatedActions.push(a.action);
        report.actions = report.actions.filter((x) => x.id !== a.action);
        report.blocked.push({ id: a.action, why: 'result not verified yet' });
      }
      return accepted;
    }

    // A helper the agent must otherwise do by hand is open while the helpers it follows have run
    // and the page hasn't settled it (NTL added, then set back to No, and still on the quote).
    function holdOpen(a) {
      return !!a.missing && a.afterActions.every((id) => clicked.has(id)) && !clicked.has(a.action)
        && (!a.pages.length || a.pages.includes(currentPage())) && !(a.resolvedBy && findButton({ text: a.resolvedBy }));
    }

    function clickNextAction(controls, immediateOnly = false) {
      const pairs = assign(controls, plan);
      // A prerequisite holds when its field shows the intake's answer, or an answer the agent chose
      // themselves (their correction counts as resolved). Missing, rejected or different: not yet.
      const has = (path) => pairs.some(({ step, control }) => step.path === path && !step.ignore && !invalidControl(control)
        && ((step.value != null && agreesWith(step, control)) || (skippedField(control) && hasValue(control))));
      const blocked = [];
      for (const a of actions.filter((x) => !immediateOnly || x.immediate)) {
        // A link verified by its going away that is back on its page (NTL removed by hand, then
        // asked for again) is due again.
        if (clicked.has(a.action) && a.verify === 'gone' && (!a.pages.length || a.pages.includes(currentPage())) && findButton(a)) clicked.delete(a.action);
        if (clicked.has(a.action) || (a.pages.length && !a.pages.includes(currentPage()))) continue;
        // A blank repeater row is already sufficient: do not add a duplicate merely because
        // its fields have not been filled yet (or the agent went back to this step).
        if (a.unlessSelector && deepQueryAll(document, a.unlessSelector).length) { clicked.add(a.action); continue; }
        if (report.halted || pageBusy()) return false;
        if (a.action === 'printSend' && controls.some((c) => /^(email|e mail|fax)$/.test(c.text) && hasValue(c))) {
          report.blocked.push({ id: a.action, why: 'Email or Fax is ticked; untick it to print' });
          continue;
        }
        if (a.unless.some(has) || (a.unlessActions ?? []).some((id) => clicked.has(id))) { clicked.add(a.action); continue; }
        // Recalculate only when the rates are out of date; otherwise it isn't waited for.
        if (a.needsRecalculation && !ratesStale()) continue;
        const button = findButton(a);
        // `nudge`: a button that shows only once the page took an answer (Progressive's "Done with
        // this coverage" after the cargo commodity): with everything else ready and no button, that
        // answer is picked again, once (the agent's re-pick is what made it show).
        if (!button && a.nudge && !nudged.has(a.action) && a.after.every(has) && a.afterActions.every((id) => clicked.has(id))) {
          const pair = pairs.find(({ step }) => step.path === a.nudge && step.value != null);
          if (pair && agreesWith(pair.step, pair.control)) {
            nudged.add(a.action);
            if (pair.control.cmp) pair.control.cmp.fireEvent?.('select', pair.control.cmp, cmpValue(pair.control.cmp, pair.control.el));
            else setNativeValue(pair.control.el, pair.control.el.value);
            return true;
          }
        }
        // Menu items ("Add Vehicle" under "Add") only show once their menu button is opened.
        if (!button && !a.opener) continue;
        const holds = actions.filter((h) => (a.heldBy ?? []).includes(h.baseAction) && holdOpen(h));
        const ready = !holds.length && (!a.afterAny?.length || a.afterAny.some(has))
          && (!a.needsPremium || premiumReady())
          && (!a.needsRecalculation || ratesStale())
          && a.after.every(has)
          && a.afterActions.every((id) => clicked.has(id))
          && (!a.afterPages.length || a.afterPages.some((p) => visited.has(p)))
          && (!a.afterValue || pairs.some(({ step, control }) => step.path === a.afterValue[0] && new RegExp(a.afterValue[1], 'i').test(selectedText(control) ?? '')));
        if (!ready) {
          // Name what it waits for (field paths, buttons, pages: no client values), so the panel
          // and the usage log say why a helper didn't run.
          const waitingFor = [
            ...a.after.filter((p) => !has(p)),
            ...(a.afterAny?.length && !a.afterAny.some(has) ? [`one of ${a.afterAny.join(' / ')}`] : []),
            ...a.afterActions.filter((id) => !clicked.has(id)).map((id) => `${id} clicked`),
            ...(a.afterPages.length && !a.afterPages.some((p) => visited.has(p)) ? [`${a.afterPages.join(' / ')} visited`] : []),
            ...(a.needsPremium && !premiumReady() ? ['a current premium'] : []),
            ...(a.afterValue ? [`${a.afterValue[0]} set`] : []),
            ...holds.map((h) => `${h.label ?? h.baseAction} resolved`),
          ];
          blocked.push(a.action);
          report.blocked.push({ id: a.action, why: waitingFor.length ? `waiting for ${waitingFor.join(', ')}` : 'waiting for its prerequisites' });
          continue;
        }
        if (!button) {
          const opener = !openersTried.has(a.action) && findButton({ text: a.opener });
          if (!opener) continue;
          openersTried.add(a.action);
          report.actions.push({ id: `${a.action}:menu`, text: oneLine(opener.value || opener.textContent).slice(0, 60) });
          opener.click();
          return true;
        }
        clicked.add(a.action);
        report.actions.push({ id: a.action, text: oneLine(button.value || button.textContent).slice(0, 60) });
        pendingAction = a;
        button.click();
        return true;
      }
      return false;
    }

    // A helper that opened the next page (the vehicle tile opens Add Vehicle) leaves its questions
    // to that page's own fill: none of them is reported or marked as this page's.
    const stillHere = !report.navigatedTo && currentPage() === startPage;
    // Answers still waiting for another try when the fill ended are left for the agent, and so is
    // a field the page should have filled itself (emptyNote) but didn't.
    for (const { step, control } of stillHere ? assign(collectControls(), plan) : []) {
      if (step.emptyNote && !hasValue(control) && !skippedField(control)) {
        report.noData.push({ stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind, note: step.emptyNote, ...describe(control) });
        handled.set(step.id, { status: 'needs', note: step.emptyNote });
        continue;
      }
      if (!refill.has(step.id) || handled.has(step.id) || skippedField(control) || agreesWith(step, control)) continue;
      report.failed.push({ stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind, reason: 'the page did not keep the answer; check it', ...describe(control) });
      handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: the page did not keep the answer` });
    }
    if (progressed && report.rounds === maxRounds && !report.halted) halt('Filling reached its round limit. Check the page before retrying.');
    // The page may have redrawn while filling, so mark the final fields.
    const controls = collectControls();
    const pairs = assign(controls, plan);
    for (const { step, control } of stillHere ? pairs : []) {
      const h = handled.get(step.id);
      if (h?.status) mark(control, h.status, h.note);
    }
    // Question text for every field on the page, keyed like the usage recorder's changes.
    report.labels = controls.map((c) => [fieldKey(c), c.label]);
    // Each ExtJS combo's loaded choices (never agency staff lists), so the usage log can tell a
    // pick from text typed into the box.
    report.choices = controls.filter((c) => c.cmp && c.kind === 'select' && c.options && !/agent|producer/i.test(c.label ?? ''))
      .map((c) => [fieldKey(c), [...new Set(c.options.map((o) => o.text).filter(Boolean))]]);
    report.skipped = controls.filter((c) => skippedField(c)).map((c) => ({ label: c.label, key: fieldKey(c) }));
    const matched = new Set(pairs.map((p) => p.control));
    for (const c of stillHere ? controls : []) {
      if (!matched.has(c) && report.unknown.some((x) => x.key === fieldKey(c)) && !skippedField(c)) mark(c, 'needs', 'Unfamiliar question — left for you.');
      if (!matched.has(c) && c.required && !hasValue(c) && !skippedField(c)) {
        report.leftRequired.push({ label: c.label, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, ...describe(c) });
        mark(c, 'needs', 'required, and not on the intake form');
      }
    }
    // A helper the agent must otherwise do by hand (the vehicle tile) that couldn't be clicked here,
    // once the helpers it follows have run (an NTL still on the quote after the agent set it to No).
    if (window === window.top && currentPage() === startPage) {
      for (const a of actions) {
        if (!a.missing || clicked.has(a.action) || (a.pages.length && !a.pages.includes(currentPage())) || findButton(a)
          || !a.afterActions.every((id) => clicked.has(id)) || a.unlessActions?.some((id) => clicked.has(id))
          || (a.resolvedBy && findButton({ text: a.resolvedBy }))) continue;
        report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.missing });
      }
      // Clicked earlier, but what it adds never got in (Add Trailer opened, the trailer page left
      // without filling it): the agent finishes it before Continue.
      for (const a of actions) {
        if (!a.unfinished || !a.doneWhen?.length || !clicked.has(a.action) || a.doneWhen.some((id) => clicked.has(id))
          || (a.pages.length && !a.pages.includes(currentPage()))) continue;
        report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.unfinished });
      }
    }
    // A button that was waiting earlier in this fill and got clicked later isn't waiting any more.
    report.blocked = report.blocked.filter((b, i, all) => !clicked.has(b.id) && all.findIndex((x) => x.id === b.id) === i);
    // Anything the agent should look at before moving on.
    // The carrier probably changed this page: a known field renamed, or most of its questions
    // unfamiliar at once. Continue waits for the agent, and the panel says so.
    report.pageChanged = report.renamed.length > 0 || (report.unknown.length >= 5 && report.unknown.length >= 0.4 * Math.max(1, report.fields));
    // A field drawn without a caption (the cargo commodity lists) is named after its rule.
    const called = (x) => x.label || x.name || x.path || 'a question with no label';
    report.blockers = [
      ...(report.pageChanged ? [`page changed: ${report.unknown.length} unfamiliar question(s)${report.renamed.length ? `, ${report.renamed.length} known field(s) renamed` : ''}`] : []),
      // An unfamiliar question with no answer yet is left for the agent even when the page
      // doesn't mark it required (Progressive validates some only on Continue).
      ...report.unknown.filter((x) => x.required || x.current == null).map((x) => `unfamiliar: ${called(x)}`),
      ...report.noData.map((x) => `needs you: ${called(x)}`),
      ...report.failed.map((x) => `failed: ${called(x)}`),
      ...report.leftRequired.map((x) => `required: ${called(x)}`),
      ...report.kept.filter((x) => x.differs).map((x) => `differs: ${called(x)}`),
      ...report.checks.map((x) => `check: ${called(x)}`),
      ...report.blocked.map((x) => `button: ${x.id}${x.why?.startsWith('waiting for ') ? ` (${x.why})` : ''}`),
      ...(report.halted ? [report.reason] : []),
    ];
    report.stepKey = stepKey();
    // A page the plan expects questions on that shows none yet, with nothing done on it, is still
    // drawing (Business Owner Info right after the state is picked, OK 2026-10-07): Continue there
    // only gets "fields are empty" errors. (A tile page that was clicked continues.)
    const notDrawn = !report.fields && !report.actions.length && plan.some((s) => s.pages?.includes(startPage));
    if (advance && window === window.top && !report.blockers.length && !notDrawn && currentPage() === startPage && !pageBusy()
      && !(advance.exceptPages ?? []).includes(currentPage()) && !doneSteps.includes(report.stepKey)) {
      // The last answer may still be redrawing part of the page (a new payment method reloads the
      // plan list): a Continue clicked meanwhile is lost. Let it finish first.
      if (serverBacked) await settle({ quietMs: 500, maxMs: 6000 });
      const button = !pageBusy() && currentPage() === startPage ? findAdvanceButton(advance.text) : null;
      if (button) {
        report.advanced = oneLine(button.value || button.textContent).slice(0, 40);
        // On one-address applications (AmWINS) the side panel waits for the questions to change.
        report.signatureBefore = signature();
        button.click();
      }
    }
    return report;
    } finally {
      hiddenOk = [];
      try { ext()?.Ajax?.un?.('beforerequest', countAjax); } catch { /* no ExtJS events */ }
      for (const type of gestureTypes) document.removeEventListener(type, trackGesture, true);
      document.removeEventListener('input', protectEdit, true);
      document.removeEventListener('change', protectEdit, true);
    }
  }

  // Puts answers the agent accepted from the AI assistant (or that it was allowed to pick itself)
  // into their fields: [{ key, label, value, note }], `value` being one of the field's option
  // texts, 'checked'/'unchecked' for a checkbox, or text. Same apply-and-verify path as fill():
  // an answer counts only once the page has settled and still shows it.
  async function answer(answers, expectedSnapshots) {
    if (expectedSnapshots && !expectedSnapshots.includes(decisionSnapshot())) {
      return answers.map(a => ({ key: a.key, label: a.label, ok: false, reason: 'the page changed since the assistant evaluated it; request fresh suggestions' }));
    }
    const serverBacked = !!ext();
    const find = (key, label) => {
      const same = collectControls().filter((c) => fieldKey(c) === key);
      return same.length > 1 ? same.find((c) => c.label === label) ?? null : same[0] ?? null;
    };
    const results = [];
    for (const a of answers) {
      const c = find(a.key, a.label);
      if (!c) { results.push({ key: a.key, label: a.label, ok: false, reason: 'the question is no longer on this page' }); continue; }
      if (a.expected) {
        const d = describe(c);
        const options = c.kind === 'checkbox' ? ['checked', 'unchecked'] : d.options;
        const changed = [c.label !== a.label && 'label', c.kind !== a.expected.kind && 'type',
          (d.section || null) !== (a.expected.section || null) && 'section',
          JSON.stringify(options) !== JSON.stringify(a.expected.options) && 'options',
          (d.current ?? null) !== (a.expected.current ?? null) && 'selection'].filter(Boolean);
        if (changed.length) {
          results.push({ key: a.key, label: a.label, ok: false, reason: `the field changed (${changed.join(', ')}) since the assistant evaluated it; request a fresh suggestion` });
          continue;
        }
      }
      const step = c.kind === 'checkbox'
        ? { id: `ai:${a.key}`, name: 'AI suggestion', kind: 'bool', value: /^(checked|yes|true)$/i.test(String(a.value)) }
        : { id: `ai:${a.key}`, name: 'AI suggestion', value: String(a.value) };
      let result;
      try { result = await apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
      if (result.ok) {
        const settled = await settle(serverBacked ? {} : { quietMs: 250, maxMs: 3000 });
        const fresh = find(a.key, a.label);
        if (!settled) result = { ok: false, reason: 'the page did not settle after the answer' };
        else if (!fresh) result = { ok: false, reason: 'the field disappeared after the answer; check the page' };
        else if (invalidControl(fresh) || !agreesWith(step, fresh)) result = { ok: false, reason: 'the page did not keep the answer; check it' };
        else mark(fresh, 'ai', a.note ?? 'answer suggested by the AI assistant — check it');
      }
      if (!result.ok) { const now = find(a.key, a.label); if (now) mark(now, 'failed', `AI answer not accepted: ${result.reason}`); }
      results.push({ key: a.key, label: a.label, ok: result.ok, shown: result.shown ?? null, reason: result.reason ?? null });
    }
    return results;
  }

  // Re-marks one field (e.g. an AI choice the agent rejected). Returns whether it was found.
  // Which of these the page shows: a VIN as a whole run of letters and digits (the vehicle list's
  // units on the quote), or a name as all its words on one line (one driver of the driver list, not
  // a first name from one and a last name from another). Only true/false goes back.
  function listed(items) {
    const text = String(document.body?.innerText ?? '').toUpperCase();
    const page = ` ${text.replace(/[^A-Z0-9]+/g, ' ')} `;
    const lines = text.split(/\n+/).map((l) => ` ${l.replace(/[^A-Z0-9]+/g, ' ')} `);
    const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (items ?? []).map((t) => {
      if (Array.isArray(t)) { const words = t.map(word).filter((w) => w.length >= 2); return words.length >= 2 && lines.some((l) => words.every((w) => l.includes(` ${w} `))); }
      const v = word(t);
      return v.length >= 11 && page.includes(` ${v} `);
    });
  }

  function markKey(key, label, status, note) {
    const same = collectControls().filter((c) => fieldKey(c) === key);
    const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
    if (c) mark(c, status, note);
    return !!c;
  }

  // A small note at the bottom of the rater page listing what the AI selected and still needs
  // the agent's approval in the side panel. No buttons or inputs, so the fill engine and the
  // page's own scripts never pick it up. An empty list removes it.
  const BANNER_ID = 'rater-autofill-ai-banner';
  function aiBanner(lines) {
    if (window !== window.top) return;
    document.getElementById(BANNER_ID)?.remove();
    if (!lines?.length) return;
    const box = document.createElement('div');
    box.id = BANNER_ID;
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 12px;'
      + 'background:#f5f1ff;border:2px solid #7c3aed;border-radius:8px;color:#2e1065;font:13px/1.4 system-ui,sans-serif;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.15)';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:4px';
    head.textContent = `AI selected ${lines.length} answer${lines.length === 1 ? '' : 's'} on this page (purple). Approve in the side panel before Continue.`;
    const list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:18px';
    for (const line of lines.slice(0, 12)) {
      const li = document.createElement('li');
      li.textContent = line;
      list.append(li);
    }
    box.append(head, list);
    document.body.append(box);
  }

  // Describes this page's form so exact mappings can be written. Records no typed values (only
  // which dropdown/radio choice is picked); any text matching `redact` (client names, numbers)
  // is replaced with [client].
  function capture(plan, redact = []) {
    const patterns = redact.filter((t) => t && t.length >= 3).map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
    // Registered addresses offered by the carrier aren't in the intake, so redact them by shape.
    const r = (s) => patterns.reduce((acc, re) => acc.replace(re, '[client]'), oneLine(s)).replace(/^.+?(?=\((?:USDOT|Primary Business|Mailing|Garaging) Address\))/i, '[client] ');
    const controls = collectControls();
    const matched = new Map(plan ? assign(controls, plan).map((p) => [p.control, p.step.path]) : []);
    const path = location.pathname.replace(/\d{5,}/g, ':id');
    const pageName = currentPage();
    return {
      frame: location.origin + path,
      page: pageName,
      // The step of a one-address application on screen (its visible headings), redacted.
      step: r(stepKey()),
      isTopFrame: window === window.top,
      title: r(document.title),
      headings: deepQueryAll(document, 'h1, h2, h3, legend, [role=heading]').filter(isVisible).map((h) => r(h.textContent)).filter(Boolean).slice(0, 40),
      controls: controls.map((c) => ({
        q: c.q ?? undefined,
        // The field's data-model name (fieldref): how a rule finds it (assign).
        ref: c.ref ?? undefined,
        // Its row (Duck Creek "<page>_<row>": one per vehicle or trailer on Rates), numbers only.
        row: c.row ?? undefined,
        kind: c.kind,
        type: c.cmp?.xtype ?? c.type,
        label: r(c.label),
        name: c.el.name || null,
        id: c.el.id || null,
        // Repeating sections without ids (AmWINS drivers/vehicles) still name their fields.
        dataId: c.el.getAttribute('data-id') || null,
        selector: cssPath(c.el),
        required: c.required,
        section: r(sectionOf(c.el)),
        ...captureOptions(c, r),
        wouldFill: matched.get(c) ?? null,
        pageHasValue: hasValue(c),
        // Which choice is picked (never text typed into boxes): shows which answers make
        // follow-up questions appear.
        selected: c.kind === 'text' ? undefined : r(selectedText(c) ?? ''),
      })),
      // Buttons and links on the page (text only), so button actions can be written from layouts.
      buttons: [...new Set(deepQueryAll(document, 'a, button, [role=button], input[type=button], input[type=submit], .x-btn')
        .filter((el) => el.getClientRects().length).map((el) => r(oneLine(el.value || el.textContent)).slice(0, 60)).filter(Boolean))].slice(0, 80),
      customWidgets: deepQueryAll(document, '[role=combobox]:not(input):not(select), [role=listbox], [contenteditable=true]')
        .filter(isVisible).slice(0, 50).map((el) => ({ role: el.getAttribute('role') ?? 'contenteditable', label: r(labelFor(el)), selector: cssPath(el) })),
      // Validation and help messages on screen (what the page said about the answers), redacted. A
      // message can repeat what was typed into a box (a corrected VIN, a phone number): the boxes'
      // text and anything shaped like a VIN or a long number are taken out as well.
      messages: [...new Set(deepQueryAll(document, '[role=alert], .x-form-error-msg, .x-form-invalid-under, [class*="error-message"], [class*="validation-message"], [class*="help-block"]')
        .filter(isVisible).map((el) => withoutTyped(r(oneLine(el.textContent)), controls).slice(0, 200)).filter(Boolean))].slice(0, 40),
      // Dropdown lists open on screen (a capture taken with the keyboard shortcut while one is open):
      // their choices as shown, and which question opened them. Choices are kept only for a fixed
      // list of a known question: never agency staff lists, never a list whose question can't be
      // found, and never a lookup filled from what was typed (addresses, businesses, customers).
      openLists: deepQueryAll(document, '[role=listbox], .x-boundlist').filter(isVisible).slice(0, 10).map((list) => {
        const owner = listOwner(list);
        const label = owner?.label ?? null;
        const items = [...list.querySelectorAll('[role=option], .x-boundlist-item')].map((o) => withoutTyped(r(oneLine(o.textContent)), controls)).filter(Boolean);
        const kept = !!owner?.fixed && label !== null && !/agent|producer/i.test(label);
        return { label: label === null ? null : r(label), selector: cssPath(list), count: items.length, fixed: !!owner?.fixed,
          options: kept ? items.slice(0, CAPTURE_OPTIONS) : [], optionsTruncated: (kept && items.length > CAPTURE_OPTIONS) || undefined };
      }),
    };
  }

  // Text typed into the page's boxes, and anything shaped like a VIN or a long number, out of a
  // message the page shows (it may repeat what was typed, which the intake's terms don't cover).
  function withoutTyped(text, controls) {
    // Every box that holds typed text, whatever its role, read from the page itself: the questions
    // found (a combo you can type into included) and the boxes question discovery skips (search
    // boxes, editable regions).
    const boxes = [...controls.map((c) => c.el), ...deepQueryAll(document, 'input, textarea, [contenteditable=""], [contenteditable=true]')];
    const typed = [...new Set(boxes.filter((el) => el?.tagName === 'TEXTAREA' || el?.getAttribute?.('contenteditable') != null
      || (el?.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset|image|file|hidden|password|range|color)$/i.test(el.type ?? '')))
      .map((el) => oneLine(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent)))].filter((v) => v.length >= 3);
    // Whatever the case or spacing the page shows it in (it may capitalize what was typed).
    const pattern = (v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    let out = typed.reduce((acc, v) => acc.replace(pattern(v), '[typed]'), text);
    out = out.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[typed]').replace(/\d[\d\s().-]{4,}\d/g, '[number]');
    return out;
  }

  // The question an open dropdown list belongs to, and whether the list is a fixed one (a choice,
  // not results looked up from what was typed): by ARIA (aria-owns / aria-controls), then ExtJS
  // (the bound list's field; fixed when its store is local: typing only filters the carrier's own
  // choices, a remote store looks results up),
  // then the box the agent is in. null when none is found.
  function listOwner(list) {
    const fixedBox = (el) => !!el && (el.tagName !== 'INPUT' || el.readOnly || !String(el.value ?? '').trim());
    if (list.id) {
      const owner = deepQueryAll(document, 'input, [role=combobox]').find((el) =>
        `${el.getAttribute('aria-owns') ?? ''} ${el.getAttribute('aria-controls') ?? ''}`.split(/\s+/).includes(list.id));
      if (owner) return { label: labelFor(owner), fixed: fixedBox(owner) && owner.getAttribute('aria-autocomplete') !== 'list' };
      const cmp = ext()?.getCmp(list.id);
      const field = cmp?.pickerField ?? cmp?.ownerCmp;
      const label = field?.dctCaption ?? field?.fieldLabel ?? (field?.inputEl?.dom ? labelFor(field.inputEl.dom) : null);
      if (label) return { label, fixed: field.queryMode === 'local' && !field.remoteFilter };
    }
    const focused = document.activeElement;
    return focused && focused !== document.body && /^(INPUT|SELECT)$/.test(focused.tagName ?? '')
      ? { label: labelFor(focused), fixed: focused.tagName === 'SELECT' || !!focused.readOnly } : null;
  }

  // A captured field's choices, as the page has them loaded (never agency staff / agent-code
  // lists, which aren't page structure). Long lists are cut, and say so.
  const CAPTURE_OPTIONS = 250;
  function captureOptions(c, r) {
    const all = /agent|producer/i.test(c.label ?? '') ? [] : optionsOf(c);
    return { options: all.slice(0, CAPTURE_OPTIONS).map((o) => r(o.text)), optionsTruncated: all.length > CAPTURE_OPTIONS || undefined };
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

  // Which step of a one-address application is on screen: its visible headings.
  function stepKey() {
    return deepQueryAll(document, 'h1, h2, h3').filter(isVisible).map((h) => oneLine(h.textContent)).filter(Boolean).slice(0, 4).join(' / ');
  }

  // The questions on screen, to tell when a step that keeps the same address has changed.
  function signature() {
    return collectControls().map((c) => `${fieldKey(c)}|${c.label}`).join('\n');
  }

  // Used only locally to reject stale AI answers, never sent to a provider or usage logs.
  function decisionSnapshot() {
    return JSON.stringify([location.href, collectControls().map(c => ({ key: fieldKey(c), label: c.label, kind: c.kind,
      ...describe(c), current: c.kind === 'text' ? c.el.value : selectedText(c) }))]);
  }

  globalThis.__raterKit = { version: 54, build: BUILD, fill, answer, listed, markKey, aiBanner, capture, clear, signature, decisionSnapshot, busy: pageBusy };
})();
