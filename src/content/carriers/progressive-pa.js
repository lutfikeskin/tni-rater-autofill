// Progressive Personal Auto's page adapter: what its Angular quote app on foragentsonly.com
// (/Quote/Index/) draws that no other carrier does, injected on progressive-pa tabs only (the
// carrier config's `pageAdapter`), in the kit's world and the usage recorder's. Classic script,
// no imports; it registers itself as globalThis.__raterAdapter. All of it is `shared`: plain DOM,
// read by field-key.js, the recorder and the kit alike (no `create`).
/** @import { PageAdapterShared } from '../../../types.js' */

(() => {
  const EMBEDDED = /^(.+?)_Embedded_Questions_List_(.+)$/;
  const QUOTE_PATH = /^\/Quote\/Index\/?$/i;
  const SKIP_CAPTION = '[aria-hidden="true"], .sr-only, .visually-hidden, help-icon';

  // Fixed step names from the top navigation bar (a.navigation-link[aria-current]). Never read
  // from document.title, which carries the client's name.
  /** @type {Record<string, string>} */
  const STEPS = {
    'NAMED INSURED': 'Named Insured',
    'PRODUCTS': 'Products',
    'HOUSEHOLD MEMBERS': 'Household Members',
    'ADDITIONAL DETAILS': 'Additional Details',
    'COVERAGES/BILL PLANS': 'Coverages/Bill Plans',
    'PORTFOLIO': 'Portfolio',
    'POINT OF SALE': 'Point of Sale',
    'FINAL SALE': 'Final Sale',
  };

  /** @param {unknown} s */
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // Radios carry the question stem in `name` (their `id` appends `_Y`/`_N`); every other control
  // carries it in `id` (selects and text boxes have no `name`, and repeated checkboxes share one).
  /** @param {Element | null | undefined} el */
  const controlId = (el) => {
    const input = /** @type {HTMLInputElement | null | undefined} */ (el);
    return input?.type?.toLowerCase() === 'radio' ? String(input.name ?? '') : String(el?.id ?? '');
  };

  /** @param {Element | null} label */
  function labelText(label) {
    if (!label || label.closest?.(SKIP_CAPTION)) return '';
    const clone = /** @type {Element} */ (label.cloneNode(true));
    for (const skip of clone.querySelectorAll(SKIP_CAPTION)) skip.remove();
    return squash(clone.textContent).replace(/[\s*:]+$/, '').trim();
  }

  /** @type {PageAdapterShared} */
  const shared = {
    selectors: {
      // The idle spinner stays in the DOM hidden; pageBusy() checks visibility (getClientRects and
      // computed visibility) before counting a busy selector as busy.
      busy: ['.ui-blocker-spinner-outer-wrapper'],
      // Step navigation links have no href and must never be clicked as a Continue or helper.
      stepLinks: ['a.navigation-link'],
    },
    // Every step of the quote shares /Quote/Index/. Read the active step from the navigation bar
    // only for this document's own pathname; never read another document's step or document.title.
    page: (loc) => {
      if (!loc?.pathname || !QUOTE_PATH.test(loc.pathname) || typeof location === 'undefined' || loc.pathname !== location.pathname) return null;
      const current = document.querySelectorAll('a.navigation-link[aria-current]:not([aria-current="false"])');
      if (current.length !== 1) return null;
      return STEPS[squash(current[0].textContent).toUpperCase()] ?? null;
    },
    keys: {
      // Stable data-model key from `<Section>[_<List>_List_<n>]..._Embedded_Questions_List_<Name>`:
      // strip `_List_<n>` from the prefix, join prefix segments with `.`, keep `<Name>` as is.
      // Non-embedded controls (e.g. Angular Material `mat-input-21`, `product_tab_AA`) return null.
      ref: (el) => {
        const m = controlId(el).match(EMBEDDED);
        if (!m) return null;
        return `${m[1].replace(/_List_\d+/g, '').replace(/_/g, '.')}.${m[2]}`;
      },
      // 1-based row path from every `_List_<n>` index in the prefix, dropping trailing `.1` parts
      // while always keeping the first part (`[0]` -> "1", `[1,0]` -> "2", `[0,1]` -> "1.2").
      row: (el) => {
        const m = controlId(el).match(EMBEDDED);
        if (!m) return null;
        const parts = [...m[1].matchAll(/_List_(\d+)/g)].map((x) => Number(x[1]) + 1);
        if (!parts.length) return null;
        while (parts.length > 1 && parts.at(-1) === 1) parts.pop();
        return parts.join('.');
      },
    },
    // Recorder caption: the question's own words only, never a vehicle/person entity heading,
    // help-icon sr-only text, or coverage cost text. Checkboxes return '' so their own <label> wins.
    caption: (el) => {
      if (!el || /** @type {HTMLInputElement} */ (el).type?.toLowerCase() === 'checkbox') return '';
      const doc = el.ownerDocument ?? document;
      let label = el.closest?.('question')?.querySelector?.('.question-label label') ?? null;
      if (!label) {
        const firstId = squash(el.getAttribute?.('aria-labelledby')).split(' ')[0];
        if (firstId && firstId.endsWith('_Label')) label = doc.getElementById?.(firstId) ?? null;
      }
      if (!label && el.id) {
        const escaped = String(el.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        label = doc.querySelector?.(`label[for="${escaped}"]`) ?? null;
      }
      return labelText(label);
    },
  };

  globalThis.__raterAdapter = { carrier: 'progressive-pa', shared };
})();
