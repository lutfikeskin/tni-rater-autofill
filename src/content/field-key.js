// Shared by the fill engine and recorder in their respective script worlds.
//
// A field's key is what the agent's corrections are saved under, so a key never changes for a field
// once saved. How a carrier names its fields is its page adapter's (`shared.keys`, injected in each
// world before this is used: src/content/carriers/<carrier>.js), read when a key is asked for:
//   ref(el)      the field's data-model name (Progressive's fieldref, GEICO's Id_<Name>_<n> name)
//   row(el)      a question's row, past the first, on a page that repeats it per unit (Progressive)
//   special(el)  a key of the carrier's own for fields with neither (GEICO's coverage lists)
//   rowName(el)  a row's key for a box repeated per row under one name (AmWINS)
//   dataName(el) the name the carrier's element names carry, for labels (GEICO)
(() => {
  // Stamped like pagekit.js (scripts/lib/package.mjs): another build left in the page is replaced.
  const BUILD = 'source';
  if (globalThis.__raterFieldKey?.version === 5 && globalThis.__raterFieldKey.build === BUILD) return;

  const keys = () => globalThis.__raterAdapter?.shared?.keys ?? {};
  const ref = (el) => keys().ref?.(el) || null;
  const dataName = (el) => keys().dataName?.(el) ?? null;

  function fieldKey(el, { q = null } = {}) {
    // A field by its data-model name: a Duck Creek field's question id is a number Progressive
    // reassigns (2026-10-07), and an edit kept under it would protect whatever question has that
    // number next; GEICO's render number changes on every redraw. Repeated per vehicle on one page
    // (Progressive's Rates rows), each row past the first gets its own key, so an agent edit on one
    // vehicle's row doesn't protect the others. Without a data-model name, the question id
    // (version 3). GEICO's data-model names take the same road (version 5): ref:GiveYear.
    const name = ref(el);
    if (name || q != null) {
      const row = keys().row?.(el) ?? null;
      const base = name ? `ref:${name}` : q;
      return row && row !== '1' ? `${base}@${row}` : base;
    }
    const special = keys().special?.(el);
    if (special) return special;
    const rowKey = keys().rowName?.(el);
    if (rowKey) return rowKey;
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

  // The key an older build (version 3) gave a question with an id: its question id (@row).
  const legacyKey = (el, { q = null } = {}) => {
    if (q == null) return null;
    const row = keys().row?.(el) ?? null;
    return row && row !== '1' ? `${q}@${row}` : q;
  };

  globalThis.__raterFieldKey = Object.assign(fieldKey, { version: 5, build: BUILD, rowKeyBase, legacyKey, dataName, ref });
})();
