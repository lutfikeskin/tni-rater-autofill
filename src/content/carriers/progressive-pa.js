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
  // from document.title, which carries the client's name. "COVERAGES/BILL PLANS" maps to
  // "Coverages" so a client named Bill does not trigger word-boundary redaction on the step name.
  /** @type {Record<string, string>} */
  const STEPS = {
    'NAMED INSURED': 'Named Insured',
    'PRODUCTS': 'Products',
    'HOUSEHOLD MEMBERS': 'Household Members',
    'ADDITIONAL DETAILS': 'Additional Details',
    'COVERAGES/BILL PLANS': 'Coverages',
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

  /** @param {Element | null | undefined} el */
  const isPickerInput = (el) => el?.getAttribute?.('name') === 'pickerInput';

  /** @param {Element | null | undefined} el */
  const refOf = (el) => {
    const m = controlId(el).match(EMBEDDED);
    if (!m) return null;
    return `${m[1].replace(/_List_\d+/g, '').replace(/_/g, '.')}.${m[2]}`;
  };

  /** @param {Element | null | undefined} el */
  const rowOf = (el) => {
    const m = controlId(el).match(EMBEDDED);
    if (!m) return null;
    const parts = [...m[1].matchAll(/_List_(\d+)/g)].map((x) => Number(x[1]) + 1);
    if (!parts.length) return null;
    while (parts.length > 1 && parts.at(-1) === 1) parts.pop();
    return parts.join('.');
  };

  /** @param {Element | null} label */
  function labelText(label) {
    if (!label || label.closest?.(SKIP_CAPTION)) return '';
    const clone = /** @type {Element} */ (label.cloneNode(true));
    for (const skip of clone.querySelectorAll(SKIP_CAPTION)) skip.replaceWith(' ');
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
    // Every step of the quote shares /Quote/Index/. Keep the page as the URL path so the panel's
    // pageOf(url) agrees, and read the active step from the navigation bar (never document.title).
    step: () => {
      if (typeof location === 'undefined' || !QUOTE_PATH.test(location.pathname)) return null;
      const current = document.querySelectorAll('a.navigation-link[aria-current]:not([aria-current="false"])');
      if (current.length !== 1) return null;
      return STEPS[squash(current[0].textContent).toUpperCase()] ?? null;
    },
    keys: {
      // Stable data-model key from `<Section>[_<List>_List_<n>]..._Embedded_Questions_List_<Name>`:
      // strip `_List_<n>` from the prefix, join prefix segments with `.`, keep `<Name>` as is.
      // Non-embedded controls (e.g. Angular Material `mat-input-21`, `product_tab_AA`) return null.
      ref: refOf,
      // 1-based row path from every `_List_<n>` index in the prefix, dropping trailing `.1` parts
      // while always keeping the first part (`[0]` -> "1", `[1,0]` -> "2", `[0,1]` -> "1.2").
      row: rowOf,
      // Angular Material date pickers have an auto-incremented `mat-input-<n>` id and share
      // `name="pickerInput"`; pair with the sibling Embedded control inside the same `<question>`
      // so repeated entity rows get distinct keys (`picker:<ref>@<row>`), falling back to
      // `picker:<property>` when no Embedded sibling exists.
      special: (el) => {
        if (!isPickerInput(el)) return null;
        const question = el.closest?.('question');
        if (!question) return null;
        for (const ctrl of question.querySelectorAll('input, select, textarea')) {
          const ref = refOf(ctrl);
          if (ref) {
            const row = rowOf(ctrl);
            return row && row !== '1' ? `picker:${ref}@${row}` : `picker:${ref}`;
          }
        }
        const property = question.getAttribute?.('property');
        return property ? `picker:${property}` : null;
      },
    },
    // Recorder caption: the question's own words only, never a vehicle/person entity heading,
    // help-icon sr-only text, or coverage cost text.
    caption: (el) => {
      if (!el) return '';
      const input = /** @type {HTMLInputElement} */ (el);
      const type = input.type?.toLowerCase();
      // Checkboxes keep their own <label> when it holds visible text (e.g. "Boat"); if its label
      // holds only sr-only/aria-hidden text or is empty, read the enclosing question's label.
      if (type === 'checkbox') {
        const own = [...(input.labels ?? [])].map(labelText).filter(Boolean).join(' ');
        if (own) return '';
        return labelText(el.closest?.('question')?.querySelector?.('.question-label label') ?? null);
      }
      const doc = el.ownerDocument ?? document;
      let label = el.closest?.('question')?.querySelector?.('.question-label label') ?? null;
      if (!label) {
        const labelId = squash(el.getAttribute?.('aria-labelledby')).split(/\s+/).find((id) => id.endsWith('_Label'));
        if (labelId) label = doc.getElementById?.(labelId) ?? null;
      }
      // Radios skip `label[for]` because it names the option ("Yes"/"No"), not the question.
      if (!label && type !== 'radio' && el.id) {
        const escaped = String(el.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        label = doc.querySelector?.(`label[for="${escaped}"]`) ?? null;
      }
      return labelText(label);
    },
    // Angular Material calendar inputs are typed dates; flag them so the recorder logs each change.
    date: (el) => isPickerInput(el),
  };

  globalThis.__raterAdapter = { carrier: 'progressive-pa', shared };
})();
