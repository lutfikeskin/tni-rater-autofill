// Progressive's page adapter: how its Duck Creek ("DCT") rater draws questions, injected before
// pagekit.js only on Progressive's tabs (the carrier config's `pageAdapter`). Classic script, no
// imports; it registers itself as globalThis.__raterAdapter, which the kit reads when it needs it.
//
// Duck Creek draws every question as an ExtJS component. Values are set through the components so
// the page's own change/blur handlers run, and the page talks to its server after each answer, so
// filling goes one field at a time and waits for the page to settle. ExtJS is only reachable from
// the page's own JS world (the config's `world: 'MAIN'`).
//
// The kit's side of this (what each hook is for, and its behavior with no adapter) is ADAPTER in
// pagekit.js. A widget here is the field's ExtJS component.
/** @import { PageAdapter, PageAdapterKit } from '../../../types.js' */

(() => {
  /** @param {PageAdapterKit} kit @returns {Partial<PageAdapter>} */
  function create(kit) {
    const { oneLine, sleep, matchOption, noMatch, textFor, hasOptions, labelFor } = kit;
    const ext = () => (typeof globalThis.Ext?.getCmp === 'function' ? globalThis.Ext : null);
    const widget = (el) => (el?.id && ext() ? ext().getCmp(el.id.replace(/-inputEl$/, '')) ?? null : null);
    const words = (html) => oneLine(String(html ?? '').replace(/<[^>]+>/g, ' '));

    function caption(cmp) {
      for (let c = cmp, i = 0; c && i < 6; c = c.ownerCt, i++) {
        if (c.dctCaption) return words(c.dctCaption);
      }
      return null;
    }

    // Duck Creek element ids look like f_<letter><32 hex group id><question id>_<page>_<row>. The
    // question id is a number Progressive reassigns: it keeps a page's rows of one question
    // together, and is logged, but never says which question a field is (see the kit's assign).
    function questionId(id) {
      return String(id ?? '').match(/^f_[a-z]([0-9a-f]{32})([0-9a-f]+)_\d+_\d+/i)?.[2]?.toUpperCase() ?? null;
    }

    // Its <page>_<row>: on Progressive's Rates every question of one vehicle shares the row, and
    // one of them is labelled with the vehicle ("2025 RAM PROMASTER 2500").
    function row(id) {
      return String(id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_(\d+_\d+)/i)?.[1] ?? null;
    }

    // An ExtJS field's value. A combo whose list was never loaded (or was torn down by a redraw)
    // throws from getValue(); its box text is then the best answer there is.
    function value(cmp, el) {
      try { return cmp.getValue(); } catch { return el?.value || null; }
    }

    // A list redrawn while it's answered may have lost its store (TX 2026-10-07): no options.
    const storeOptions = (cmp) => (cmp.store?.getRange?.() ?? []).map((rec) => ({ rec, text: oneLine(rec.get(cmp.displayField)), value: rec.get(cmp.valueField ?? cmp.displayField) }));

    // Runs ExtJS's own "field lost focus" handling, which is when Duck Creek sends an answer to
    // its server. A real focus/blur doesn't fire while the agent is clicking in the side panel
    // (the page window isn't focused), so fall back to calling Ext's handler directly.
    function focusAndBlur(cmp, el, set) {
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

    // Go through the components so the page's own change/blur handlers run (Duck Creek sends each
    // answer to the server when the field loses focus).
    async function apply(step, c) {
      const { widget: cmp, el } = c;
      if (c.kind === 'radio') {
        const opt = matchOption(c.options, step);
        if (!opt) return noMatch(step, c.options);
        const isOn = () => (opt.widget ? !!opt.widget.getValue() : opt.el.checked);
        if (!isOn()) opt.el.click();
        if (!isOn() && opt.widget) opt.widget.setValue(true);
        return isOn() ? { ok: true, shown: opt.text } : { ok: false, reason: "the page didn't accept the choice" };
      }
      if (cmp?.readOnly) return { ok: false, reason: 'the field is read-only — set it by hand' };
      if (c.kind === 'select') {
        // `search`: the word an agent types to narrow the list (Progressive's LA business description,
        // "Trucking"); the answer is picked among its results only, none of them is a miss.
        const searched = step.search ? await queryCombo(cmp, step.search) : null;
        if (searched) {
          const hit = matchOption(searched, step);
          if (!hit) return noMatch(step, searched);
          focusAndBlur(cmp, el, () => {
            cmp.setValue(hit.value);
            cmp.fireEvent('select', cmp, hit.rec);
          });
          return { ok: true, shown: cmp.getRawValue?.() || hit.text };
        }
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
        focusAndBlur(cmp, el, () => {
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
      focusAndBlur(cmp, el, () => cmp.setValue(text));
      if (!el.value && !cmp.getValue()) return { ok: false, reason: 'the page cleared the value (it may need a different format)' };
      return { ok: true, shown: el.value || String(cmp.getValue()) };
    }

    return {
      widget,
      radioGroup: (cmp) => cmp?.up?.('radiogroup') ?? null,
      groupKey: (group) => `x:${group.id}`,
      // An ExtJS combo box: a text input backed by a list of records.
      choices: (cmp) => (cmp?.store && cmp.displayField ? storeOptions(cmp) : null),
      // A checkbox in a group ("Filings: [ ] Federal [ ] MCS-90") is named by its own box label.
      label: (cmp, kind) => (kind === 'checkbox' && cmp?.boxLabel ? words(cmp.boxLabel) : null) ?? caption(cmp),
      optionText: (cmp) => words(cmp?.boxLabel),
      question: (cmp, el) => questionId(cmp?.id ?? el?.id),
      row: (cmp, el) => row(cmp?.id ?? el?.id),
      // The field's name in the carrier's data model: Duck Creek puts it on every input
      // (fieldref="RiskInput.VIN", "ComprehensiveInput.Deductible"). It names what the field
      // holds, where the question id is only a number, which Progressive renumbers (2026-10-07).
      ref: (el) => el?.getAttribute?.('fieldref') || null,
      // Only the field itself (or its radio group) says whether it's required; outer containers
      // carrying dctRequired made optional fields like Suffix and DBA look required.
      required: (cmp) => !!cmp?.dctRequired,
      value,
      shown: (cmp) => oneLine(cmp.getRawValue?.() ?? '') || null,
      // A combo showing its placeholder ("-- Select --") holds no answer.
      holds: (cmp, el, isPlaceholder) => {
        const v = value(cmp, el);
        return v != null && v !== '' && !isPlaceholder(cmp.getRawValue?.() ?? '');
      },
      // ExtJS keeps a stale "you must select one item" error on a group until it re-validates, so
      // ask the component to validate now rather than reading the old message.
      invalid: (cmp) => {
        if (typeof cmp?.isValid === 'function') { try { return !cmp.isValid(); } catch { return false; } }
        return typeof cmp?.getActiveError === 'function' && !!cmp.getActiveError();
      },
      groupOf: (option) => option?.widget?.up?.('radiogroup') ?? null,
      // An address typed into its box (the kit sends the typing events between the two).
      setText: (cmp, text) => cmp.setValue(text),
      changed: (cmp, text) => {
        try { cmp.fireEvent?.('change', cmp, text); } catch { /* page handler expected a real event */ }
      },
      apply,
      // ExtJS's select hands its listeners the picked record, as a real pick does (Codex on PR #43).
      reselect: (cmp, el) => {
        const v = value(cmp, el);
        const rec = storeOptions(cmp).find((o) => o.value === v || o.text === oneLine(v))?.rec ?? null;
        cmp.fireEvent?.('select', cmp, rec ?? v);
      },
      highlight: (cmp) => cmp?.el?.dom?.querySelector?.('.x-form-trigger-wrap') ?? null,
      typeName: (cmp) => cmp?.xtype ?? null,
      busy: () => !!ext()?.Ajax?.isLoading?.(),
      busySelectors: ['.x-mask-msg', '.x-mask-loading'],
      // The page sends its server each answer: a fill waits for it between answers.
      serverBacked: () => !!ext(),
      onRequest: (fn) => { try { ext()?.Ajax?.on?.('beforerequest', fn); } catch { /* no ExtJS events */ } },
      offRequest: (fn) => { try { ext()?.Ajax?.un?.('beforerequest', fn); } catch { /* no ExtJS events */ } },
      // An open ExtJS list's field: its bound list's picker. Fixed when its store is local (typing
      // only filters the carrier's own choices); a remote store looks results up.
      listOwner: (list) => {
        const cmp = ext()?.getCmp(list.id);
        const field = cmp?.pickerField ?? cmp?.ownerCmp;
        const label = field?.dctCaption ?? field?.fieldLabel ?? (field?.inputEl?.dom ? labelFor(field.inputEl.dom) : null);
        return label ? { label, fixed: field.queryMode === 'local' && !field.remoteFilter } : null;
      },
    };
  }

  globalThis.__raterAdapter = { carrier: 'progressive', create };
})();
