// Shared by the fill engine and recorder in their respective script worlds.
(() => {
  // Stamped like pagekit.js (scripts/lib/package.mjs): another build left in the page is replaced.
  const BUILD = 'source';
  if (globalThis.__raterFieldKey?.version === 5 && globalThis.__raterFieldKey.build === BUILD) return;

  // GEICO (sales.geico.com) draws a question as Id_<Name>_<render number> and renumbers it on every
  // redraw (a new step, an answer that reveals follow-ups, Recalculate): an edit kept under the
  // number protects nothing after the next redraw. <Name> is the data-model name (GiveYear,
  // TeamDrivingOrSlipSeatingYesNo). A radio option's input id adds its option digit and -shadow (its
  // name doesn't, so the name is read first); the VIN box adds maskedField. The boxes of a checkbox
  // group share one name and differ only by id, checkbox-Id_<Name>_<n>-<Box>: the box joins the
  // name (AddFilings.MCS90). A coverage id (Id_<uuid>_<n>_COMP) has none: a UUID has dashes.
  const DATA_NAME = /^Id_([A-Za-z][A-Za-z0-9]*)_\d+(?:maskedField|-shadow)?$/;
  const BOX_NAME = /^checkbox-Id_([A-Za-z][A-Za-z0-9]*)_\d+-([A-Za-z0-9]+)$/;
  function dataName(el) {
    const box = String(el?.id ?? '').match(BOX_NAME);
    if (box) return `${box[1]}.${box[2]}`;
    for (const s of [el?.name, el?.id]) {
      const m = String(s ?? '').match(DATA_NAME);
      if (m) return m[1];
    }
    return null;
  }

  // GEICO's coverage lists (Quote & Coverages) have only an id, Id_<uuid>_<n>, with a new uuid on
  // every render and every Recalculate (the saved Full and AfterRunAgain pages share none): an
  // agent's coverage pick kept under it was lost on the next Recalculate. A per-vehicle row ends in
  // its coverage (_COMP, _COLL, _Rental, _ERS, _FT, _HVRS, _RRWDT, _CustomizationValue,
  // _VehicleValue) and is known by it and its place among that coverage's rows (cov:COMP#2: the
  // second vehicle's). Its label names the vehicle (year, make, model, VIN) and its premium, which
  // never go in a key. A policy-level list has a label of its own, a <gds-label-legend for=…>, the
  // coverage's name: cov:liability coverage. Neither: its id, as before.
  const COVERAGE_ID = /^Id_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+(?:_([A-Za-z][A-Za-z0-9]*))?$/i;
  const words = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  function coverageKey(el) {
    const id = String(el?.id ?? '');
    const m = id.match(COVERAGE_ID);
    const root = m && el.getRootNode?.();
    if (!root?.querySelectorAll) return null;
    if (m[1]) {
      const rows = [...root.querySelectorAll(`[id$="_${m[1]}"]`)].filter((x) => String(x.id).match(COVERAGE_ID)?.[1] === m[1]);
      const at = rows.indexOf(el);
      return at < 0 ? null : `cov:${m[1]}#${at + 1}`;
    }
    const label = [...root.querySelectorAll('[for]')].find((x) => x.getAttribute('for') === id);
    if (!label) return null;
    // Without its tooltip's text (the legend holds a <gds-tooltip>). A label that reads like a
    // vehicle or an amount (a year, a VIN, a $) is not a coverage's name: its id, as before.
    let text = label.textContent ?? '';
    for (const tip of label.querySelectorAll('gds-tooltip, [role=tooltip]')) if (tip.textContent) text = text.replace(tip.textContent, ' ');
    if (/\$|\b(?:19|20)\d{2}\b|\b(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/i.test(text)) return null;
    text = words(text).slice(0, 80).trim();
    return text ? `cov:${text}` : null;
  }

  function fieldKey(el, { q = null } = {}) {
    // A Duck Creek field (Progressive) by its data-model name (fieldref): its question id is a
    // number Progressive reassigns (2026-10-07), and an edit kept under it would protect whatever
    // question has that number next. Repeated per vehicle on one page (Rates rows _<page>_2,
    // _<page>_3, …), each row past the first gets its own key, so an agent edit on one vehicle's
    // row doesn't protect the others. Without a data-model name, the question id (version 3).
    // GEICO's data-model names (dataName) take the same road (version 5): ref:GiveYear.
    const ref = el.getAttribute?.('fieldref') || dataName(el);
    if (ref || q != null) {
      const row = String(el.id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_\d+_(\d+)/i)?.[1];
      const base = ref ? `ref:${ref}` : q;
      return row && row !== '1' ? `${base}@${row}` : base;
    }
    const coverage = coverageKey(el);
    if (coverage) return coverage;
    // A checkbox repeated per row keeps the template's name, and only its id carries the row
    // (AmWINS' vehicle coverage boxes: name "medicalPaymentExclude", ids
    // medicalPaymentExclude<row>_<box>_). Every row gets its own key, name#<row> numbered from 1,
    // so an edit or answer on one vehicle stays on that vehicle. The first row too: a plain name
    // saved before (version 2) could be any row's edit, and protects them all (rowKeyBase).
    if (el.name && el.type?.toLowerCase() !== 'radio') {
      const row = String(el.id ?? '').startsWith(el.name) ? el.id.slice(el.name.length).match(/^(\d+)_\d+_/)?.[1] : null;
      if (row) return `${el.name}#${Number(row) + 1}`;
    }
    const known = el.name || el.id;
    if (known) return known;

    // Anonymous radio options identify their shared answer group, rather than an option.
    const radio = el.type?.toLowerCase() === 'radio';
    const anchor = radio ? (el.closest('fieldset, [role=radiogroup]') ?? el.parentElement ?? el) : el;

    // Anonymous repeated controls need their row, not their label or current value.
    // Anchor at the nearest container ID and use ordinals among equivalent siblings.
    const signature = node => [node.tagName.toLowerCase(), node.getAttribute('data-id') ?? '',
      node.getAttribute('type') ?? ''].map(encodeURIComponent).join(':');
    const parts = [];
    for (let node = anchor; node?.nodeType === 1;) {
      if (node.id) { parts.unshift(`id:${encodeURIComponent(node.id)}`); break; }
      const parent = node.parentElement;
      const siblings = [...((parent ?? node.parentNode)?.children ?? [])].filter(sibling => signature(sibling) === signature(node));
      parts.unshift(`${signature(node)}:${Math.max(0, siblings.indexOf(node)) + 1}`);
      if (parent) node = parent;
      else {
        node = node.getRootNode?.().host;
        if (node) parts.unshift('shadow');
      }
    }
    return `dom-v1:${radio ? 'radio/' : ''}${parts.join('/')}`;
  }

  // The plain name an older key used for a row key (name#<row>), else null.
  const rowKeyBase = (key) => String(key ?? '').match(/^(.+)#\d+$/)?.[1] ?? null;

  // The key an older build (version 3) gave a Duck Creek field: its question id (@row).
  const legacyKey = (el, { q = null } = {}) => {
    if (q == null) return null;
    const row = String(el.id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_\d+_(\d+)/i)?.[1];
    return row && row !== '1' ? `${q}@${row}` : q;
  };

  globalThis.__raterFieldKey = Object.assign(fieldKey, { version: 5, build: BUILD, rowKeyBase, legacyKey, dataName });
})();
