// Progressive Personal Auto's page adapter: what its Angular quote app on foragentsonly.com
// (/Quote/Index/) draws that no other carrier does, injected on progressive-pa tabs only (the
// carrier config's `pageAdapter`), in the kit's MAIN world and the usage recorder's ISOLATED
// world. Classic script, no imports; it registers itself as globalThis.__raterAdapter.
// `shared` is plain DOM (read by field-key.js, the recorder and the kit alike); `create` is the
// kit's alone (in-flight API request tracking and column-first ordering on multi-entity grids).
/** @import { PageAdapter, PageAdapterShared } from '../../../types.js' */

(() => {
  const EMBEDDED = /^(.+?)_Embedded_Questions_List_(.+)$/;
  const VIEW_MODEL = /^viewModel/i;
  const QUOTE_PATH = /^\/(?:Quote(?:\/Index)?\/?|test\/fixtures\/progressive-pa\/.*)$/i;
  const SKIP_CAPTION = '[aria-hidden="true"], .sr-only, .visually-hidden, help-icon, .required-subtext';

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

  /** @param {Element | null | undefined} el */
  const isRadio = (el) => /** @type {HTMLInputElement | null | undefined} */ (el)?.type?.toLowerCase() === 'radio';

  // Match the data-model path from `id` for every control (radios included: on live pages Angular
  // may render a radio group's `name` as a positional `viewModel_..._<n>` path while `id` stays
  // stable). Fall back to `name` only for radios when `id` does not match and `name` does not
  // start with `viewModel` (case-insensitive).
  /** @param {Element | null | undefined} el */
  const matchEmbedded = (el) => {
    const idMatch = String(el?.id ?? '').match(EMBEDDED);
    if (idMatch) return { match: idMatch, fromId: true };
    if (!isRadio(el)) return null;
    const name = String(/** @type {HTMLInputElement | null | undefined} */ (el)?.name ?? '');
    if (!name || VIEW_MODEL.test(name)) return null;
    const nameMatch = name.match(EMBEDDED);
    return nameMatch ? { match: nameMatch, fromId: false } : null;
  };

  /** @param {Element | null | undefined} el */
  const isPickerInput = (el) => el?.getAttribute?.('name') === 'pickerInput';

  /** @param {Element | null | undefined} el */
  const refOf = (el) => {
    const hit = matchEmbedded(el);
    if (!hit) return null;
    const [, prefix, raw] = hit.match;
    let question = raw;
    if (hit.fromId && isRadio(el)) {
      const prop = el?.closest?.('question')?.getAttribute?.('property');
      const val = el?.getAttribute?.('value') ?? '';
      if (prop && (raw === prop || raw.startsWith(`${prop}_`))) {
        question = prop;
      } else if (val && raw.length > val.length + 1 && raw.endsWith(`_${val}`)) {
        question = raw.slice(0, -(val.length + 1));
      } else {
        const cut = raw.lastIndexOf('_');
        if (cut > 0) question = raw.slice(0, cut);
      }
    }
    return `${prefix.replace(/_List_\d+/g, '').replace(/_/g, '.')}.${question}`;
  };

  /** @param {Element | null | undefined} el */
  const rowOf = (el) => {
    const hit = matchEmbedded(el);
    if (!hit) return null;
    const parts = [...hit.match[1].matchAll(/_List_(\d+)/g)].map((x) => Number(x[1]) + 1);
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
      // Angular Material Smarty address autocomplete options on Named Insured.
      suggestions: ['mat-option', '.mat-mdc-option'],
    },
    // Every step of the quote shares /Quote/Index/. Keep the page as the URL path so the panel's
    // pageOf(url) agrees, and read the active step from the navigation bar (never document.title).
    // Returns undefined when this document draws no step navigation (child frame, cross-origin
    // top, non-quote path, or no nav links), null when the nav is present with no single current
    // step, and the mapped step name otherwise.
    step: () => {
      try { if (typeof window === 'undefined' || window !== window.top) return undefined; } catch { return undefined; }
      if (typeof location === 'undefined' || !QUOTE_PATH.test(location.pathname)) return undefined;
      if (!document.querySelector('a.navigation-link')) return undefined;
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
        const ids = squash(el.getAttribute?.('aria-labelledby')).split(/\s+/).filter(Boolean);
        const labelId = ids.find((id) => id.endsWith('_Label'));
        if (labelId) label = doc.getElementById?.(labelId) ?? null;
        if (!label) {
          for (const id of ids) {
            const candidate = doc.getElementById?.(id) ?? null;
            if (candidate?.tagName === 'LABEL') { label = candidate; break; }
          }
        }
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

  /**
   * 1-based primary column number for a repeating vehicle/driver/coverage control (including its
   * sibling date pickerInput), or null for page-level controls.
   * @param {Element | null | undefined} el
   * @returns {number | null}
   */
  function columnOf(el) {
    let r = rowOf(el);
    if (!r && isPickerInput(el)) {
      const question = el?.closest?.('question');
      if (question) {
        for (const ctrl of question.querySelectorAll('input, select, textarea')) {
          r = rowOf(ctrl);
          if (r) break;
        }
      }
    }
    if (!r) return null;
    const n = Number(r.split('.')[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Progressive PA renders multiple vehicles/drivers side-by-side in one grid (row-first DOM
   * order: Field 1 for Veh 1..4, then Field 2 for Veh 1..4). When 2+ columns are present, reorder
   * controls column-first (page-level before grid -> Column 1 top-to-bottom -> Column 2 -> ... ->
   * page-level after grid) so filling works left-to-right one vehicle or driver at a time.
   * @param {any[]} controls
   */
  function orderByColumn(controls) {
    if (!Array.isArray(controls) || controls.length < 2) return controls;
    const cols = controls.map((c) => columnOf(c?.el));
    const distinct = new Set(cols.filter((n) => n != null));
    if (distinct.size < 2) return controls;
    const firstRowIdx = cols.findIndex((n) => n != null);
    return controls
      .map((control, index) => ({
        control,
        index,
        group: cols[index] != null ? cols[index] : index < firstRowIdx ? 0 : Infinity,
      }))
      .sort((a, b) => a.group - b.group || a.index - b.index)
      .map((x) => x.control);
  }

  // Track same-origin Angular API XHR/fetch requests in flight (MAIN world) so serverBacked waits
  // hold until CurrentWorkflowState, AddedVehicleCollection, AddedDriverCollection, and
  // SingleVehicleVinOrder finish redrawing the form. Ignore telemetry (ClientErrorLogger).
  function ensureNetTracker() {
    const g = /** @type {any} */ (globalThis);
    if (g.__raterPpaNet) return g.__raterPpaNet;
    /** @type {Set<() => void>} */
    const listeners = new Set();
    const tracker = {
      inFlight: 0,
      /** @param {() => void} fn */
      add(fn) { listeners.add(fn); },
      /** @param {() => void} fn */
      remove(fn) { listeners.delete(fn); },
    };
    /** @param {unknown} url */
    const trackUrl = (url) => {
      try {
        const base = typeof location !== 'undefined' && location?.href ? location.href : 'https://quoting.foragentsonly.com/';
        const u = new URL(String(url ?? ''), base);
        if (typeof location !== 'undefined' && location?.origin && u.origin !== location.origin) return false;
        if (/\/ClientErrorLogger(?:[/?#]|$)/i.test(u.pathname)) return false;
        return /\/api\//i.test(u.pathname);
      } catch {
        return false;
      }
    };
    const onStart = () => {
      tracker.inFlight++;
      for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
    };
    const onDone = () => {
      tracker.inFlight = Math.max(0, tracker.inFlight - 1);
    };
    if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      /** @this {XMLHttpRequest & { __raterTrackUrl?: unknown }} */
      XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
        this.__raterTrackUrl = url;
        return /** @type {any} */ (origOpen).call(this, method, url, ...rest);
      };
      /** @this {XMLHttpRequest & { __raterTrackUrl?: unknown }} */
      XMLHttpRequest.prototype.send = function send(...args) {
        if (trackUrl(this.__raterTrackUrl)) {
          let done = false;
          const finish = () => { if (!done) { done = true; onDone(); } };
          onStart();
          this.addEventListener?.('loadend', finish, { once: true });
          try {
            return /** @type {any} */ (origSend).apply(this, args);
          } catch (err) {
            finish();
            throw err;
          }
        }
        return /** @type {any} */ (origSend).apply(this, args);
      };
    }
    if (typeof globalThis.fetch === 'function') {
      const origFetch = globalThis.fetch;
      globalThis.fetch = function fetch(input, init) {
        const url = typeof input === 'string' ? input : /** @type {any} */ (input)?.url;
        if (!trackUrl(url)) return origFetch.call(this, input, init);
        onStart();
        try {
          const p = origFetch.call(this, input, init);
          return Promise.resolve(p).finally(onDone);
        } catch (err) {
          onDone();
          throw err;
        }
      };
    }
    g.__raterPpaNet = tracker;
    return tracker;
  }

  /** @returns {Partial<PageAdapter>} */
  function create() {
    const net = ensureNetTracker();
    return {
      busy: () => net.inFlight > 0,
      serverBacked: () => true,
      onRequest: (fn) => net.add(fn),
      offRequest: (fn) => net.remove(fn),
      order: orderByColumn,
    };
  }

  globalThis.__raterAdapter = { carrier: 'progressive-pa', shared, create };
})();
