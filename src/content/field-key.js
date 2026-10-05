// Shared by the fill engine and recorder in their respective script worlds.
(() => {
  // Stamped like pagekit.js (scripts/lib/package.mjs): another build left in the page is replaced.
  const BUILD = 'source';
  if (globalThis.__raterFieldKey?.version === 3 && globalThis.__raterFieldKey.build === BUILD) return;

  function fieldKey(el, { q = null } = {}) {
    // A known question keeps its id. Repeated per vehicle on one page (Progressive's Rates rows
    // _<page>_2, _<page>_3, …), each row past the first gets its own key, so an agent edit on one
    // vehicle's row doesn't protect the others. First rows keep the plain id, as before.
    if (q != null) {
      const row = String(el.id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_\d+_(\d+)/i)?.[1];
      return row && row !== '1' ? `${q}@${row}` : q;
    }
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

  globalThis.__raterFieldKey = Object.assign(fieldKey, { version: 3, build: BUILD, rowKeyBase });
})();
