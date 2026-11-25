// @ts-check
// GEICO Personal Auto's page adapter: what its React + GDS quote app on sales.geico.com/quote
// draws that no other carrier does, injected on geico-pa tabs only (the carrier config's
// `pageAdapter`), in the kit's MAIN world and the usage recorder's ISOLATED world. Classic script,
// no imports; it registers itself as globalThis.__raterAdapter.
// `shared` is plain DOM (read by field-key.js, the recorder and the kit alike); `create` is the
// kit's alone (in-flight /api/lookup and /api/conversation XHR/fetch tracking, entity row indexing,
// and column-first + dependency ordering on .ssp-grid pages).
/** @import { PageAdapter, PageAdapterShared } from '../../../types.js' */

(() => {
  const QUOTE_PATH = /^\/(?:quote(?:\/|$)|test\/fixtures\/geico-pa\/)/i;
  const DATA_NAME = /^Id_([A-Za-z][A-Za-z0-9]*)_(?:Applicant_)?\d+(?:maskedField|-shadow)?$/;
  const BOX_NAME = /^checkbox-Id_([A-Za-z][A-Za-z0-9]*)_(?:Applicant_)?\d+-([A-Za-z0-9]*)$/;
  const COVERAGE_ID = /^Id_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+(?:_([A-Za-z][A-Za-z0-9]*))?$/i;
  const VEHICLE_HEADER = /^(?:19|20)\d{2}\s+\S/;
  const SKIP_TEXT = 'gds-tooltip, [role="tooltip"], template, script, style';

  // Canonical step names from the left-drawer vertical stepper (gds-vertical-stepper-item).
  // document.title is "GEICO" on every step, and every step shares /quote.
  /** @type {Record<string, string>} */
  const STEPS = {
    'POLICYHOLDER INFORMATION': 'Policyholder Information',
    'CURRENT INSURANCE': 'Current Insurance',
    'VEHICLE INFORMATION': 'Vehicle Information',
    'DRIVER INFORMATION': 'Driver Information',
    'LICENSE HISTORY': 'License History',
    'SELECT DRIVERS WITH INCIDENTS': 'Select Drivers with Incidents',
    'GROUPS OR ORGANIZATIONS': 'Groups or Organizations',
    'QUOTE SUMMARY': 'Quote Summary',
    'VEHICLE DETAILS': 'Vehicle Details',
    'DRIVER DETAILS': 'Driver Details',
    'COMMUNICATION OPTIONS': 'Communication Options',
    'PAYMENT PLAN': 'Payment Plan',
    'PAYMENT TYPE': 'Payment Type',
  };

  // Within-column dependency priority inside .ssp-grid tables.
  // - Vehicle Information: Primary Use triggers /api/lookup/AnnualMileage and overwrites Annual
  //   Mileage, so Primary Use (and Commute/Business follow-ups) must run before Annual Mileage.
  // - Driver Information: Column 1 Marital Status = Married auto-spawns the Spouse column via
  //   /api/lookup/GetUpdatePageTemplate, so Marital Status runs early in Column 1 before Column 2+.
  /** @type {Record<string, number>} */
  const GRID_PRIORITY = {
    // Vehicle Information
    YesNoPreQuoteHaveFullVinActivity: 10,
    GiveVinPreQuote: 20,
    GiveYear: 30,
    GiveMake: 31,
    GiveModel: 32,
    YesNoAntiLockBrakes: 33,
    GiveBodyStyle: 34,
    GivePassiveRestraintDevice: 35,
    GiveVehicleOwnerShip: 40,
    GiveLengthOfOwnership: 50,
    GiveVehiclePrimaryUse: 60,
    GiveDaysPerWeekCommute: 70,
    GiveMilesOneWay: 71,
    GiveTypeOfBusinessUse: 72,
    GiveAnnualMileage: 80,
    // Driver Information
    GiveFirstName: 10,
    GiveLastName: 11,
    GiveDateOfBirth: 12,
    GiveGender: 13,
    GiveMaritalStatus: 14,
    GiveRelationshipToInsured: 15,
    GiveEducationLevel: 20,
    GiveGovernmentMilitaryAffiliation: 21,
    GiveMilitaryAffiliation: 22,
    GiveMilitaryBranch: 23,
    GiveMilitaryGrade: 24,
    GiveActiveOrRetired: 25,
    GiveGovernmentGrade: 26,
    GiveEmploymentStatus: 30,
    GiveIndustry: 31,
    GiveOccupationByIndustry: 32,
    YesNoEmployedLastTwelveMonths: 33,
    GiveStudentType: 34,
    GiveDriversLicenseStatus: 40,
    GiveDriverExclusionInsuredYesNo: 41,
    GiveDriverStatus: 42,
    YesNoGoodStudentDiscount: 43,
    GiveStudentAway: 44,
    YesNoDefensiveDriverCourse: 45,
  };

  /** @param {unknown} s */
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /** @param {unknown} s */
  const words = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  /**
   * Climbs out of open shadow roots (e.g. a <gds-radio-button>'s inner radio input) to the host
   * element in light DOM so .closest() queries work across shadow boundaries.
   * @param {Element | null | undefined} el
   * @returns {Element | null}
   */
  function lightEl(el) {
    /** @type {any} */
    let n = el ?? null;
    while (n) {
      const root = n.getRootNode?.();
      if (!root || root === document || !root.host) return n;
      n = root.host;
    }
    return null;
  }

  /**
   * Reads visible text inside el, stripping tooltips, shadow templates, scripts and styles.
   * @param {Element | null | undefined} el
   * @returns {string}
   */
  function cleanText(el) {
    if (!el) return '';
    const clone = /** @type {Element} */ (el.cloneNode(true));
    for (const skip of clone.querySelectorAll(SKIP_TEXT)) skip.remove();
    return squash(clone.textContent);
  }

  /**
   * Extracts GEICO's stable data-model name from Id_<Name>_<render>, stripping render numbers,
   * maskedField/-shadow suffixes, and joining checkbox suffixes (GiveAllDriversAcknowledgement.Yes).
   * @param {Element | null | undefined} el
   * @returns {string | null}
   */
  function dataName(el) {
    const hEl = /** @type {HTMLInputElement | null | undefined} */ (el);
    const box = String(hEl?.id ?? '').match(BOX_NAME);
    if (box) return box[2] ? `${box[1]}.${box[2]}` : box[1];
    for (const s of [hEl?.name, hEl?.id]) {
      const m = String(s ?? '').match(DATA_NAME);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * 1-based entity column number for a control inside a .ssp-grid table (Vehicle Information,
   * Driver Information), where column 0 is td.row-header and entities occupy columns 1..N.
   * @param {Element | null | undefined} el
   * @returns {number | null}
   */
  function gridColumnOf(el) {
    const node = lightEl(el);
    const td = node?.closest?.('td');
    if (!td || !td.closest?.('.ssp-grid')) return null;
    const tr = td.parentElement;
    if (!tr || tr.tagName !== 'TR') return null;
    const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const idx = cells.indexOf(td);
    return idx >= 1 ? idx : null;
  }

  /**
   * 1-based driver section index on License History, where drivers are stacked as sibling <div>s
   * directly under form#salesForm, each starting with a <gds-section-header> naming the driver.
   * @param {Element | null | undefined} el
   * @returns {number | null}
   */
  function licenseDriverIndexOf(el) {
    const node = lightEl(el);
    const form = node?.closest?.('form#salesForm');
    if (!form) return null;
    const children = [...form.children];
    const isLicensePage = children.some((ch) => {
      const hdr = ch.querySelector?.('gds-section-header');
      return !!hdr && cleanText(hdr).toLowerCase() === 'license history';
    });
    if (!isLicensePage) return null;
    let driverIdx = 0;
    for (const child of children) {
      const hdr = child.querySelector?.('gds-section-header');
      if (hdr && cleanText(hdr).toLowerCase() !== 'license history') driverIdx++;
      if (child === node || child.contains(node)) return driverIdx > 0 ? driverIdx : null;
    }
    return null;
  }

  /**
   * 1-based vehicle section index for per-vehicle coverages on Quote Summary, where each vehicle's
   * selects sit in .coverage-form-field-wrapper siblings after a <gds-section-header> naming the
   * vehicle (e.g. "2020 Make Model xxxxxxxxxxxxx0001"). Policy-level coverages precede all vehicle
   * headers and return null.
   * @param {Element | null | undefined} el
   * @returns {number | null}
   */
  function quoteVehicleIndexOf(el) {
    const node = lightEl(el);
    const wrapper = node?.closest?.('.coverage-form-field-wrapper');
    const container = wrapper?.parentElement;
    if (!wrapper || !container) return null;
    let vehIdx = 0;
    for (const child of container.children) {
      if (child === wrapper) return vehIdx > 0 ? vehIdx : null;
      const hdr = child.querySelector?.('gds-section-header');
      if (hdr && VEHICLE_HEADER.test(cleanText(hdr))) vehIdx++;
    }
    return null;
  }

  /**
   * 1-based entity row/column key for repeating controls across .ssp-grid, License History, and
   * Quote Summary per-vehicle coverages; null for single-instance/policy-level controls.
   * @param {Element | null | undefined} el
   * @returns {string | null}
   */
  function rowOf(el) {
    const col = gridColumnOf(el);
    if (col != null) return String(col);
    const lic = licenseDriverIndexOf(el);
    if (lic != null) return String(lic);
    const veh = quoteVehicleIndexOf(el);
    if (veh != null) return String(veh);
    return null;
  }

  /**
   * Stable key for Quote Summary coverage <select>s whose ids are Id_<uuid>_<n> (regenerated on
   * every render/Recalculate). Policy-level lists key by their normalized <gds-label-legend> text
   * ("cov:bodily injury liability bi"); per-vehicle lists append their 1-based vehicle ordinal
   * ("cov:comprehensive excluding collision#2") so multiple vehicles never collide. Also supports
   * commercial-style suffixed ids (Id_<uuid>_<n>_COMP -> "cov:COMP#2").
   * @param {Element | null | undefined} el
   * @returns {string | null}
   */
  function coverageKey(el) {
    const id = String(el?.id ?? '');
    const m = id.match(COVERAGE_ID);
    const root = /** @type {Document | ShadowRoot | null} */ (m && el?.getRootNode?.());
    if (!m || !root?.querySelectorAll) return null;
    if (m[1]) {
      const rows = [...root.querySelectorAll(`[id$="_${m[1]}"]`)].filter((x) => String(x.id).match(COVERAGE_ID)?.[1] === m[1]);
      const at = rows.indexOf(/** @type {Element} */ (el));
      return at < 0 ? null : `cov:${m[1]}#${at + 1}`;
    }
    const label = [...root.querySelectorAll('[for]')].find((x) => x.getAttribute('for') === id);
    if (!label) return null;
    const raw = cleanText(label);
    if (/\$|\b(?:19|20)\d{2}\b|\b(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/i.test(raw)) return null;
    const text = words(raw).slice(0, 80).trim();
    if (!text) return null;
    const vehIdx = quoteVehicleIndexOf(el);
    return vehIdx != null ? `cov:${text}#${vehIdx}` : `cov:${text}`;
  }

  /**
   * Stable key for controls without a GEICO Id_<Name>_<render> data-model name:
   * - Quote Summary coverage <select>s (UUID-keyed -> "cov:<label>" / "cov:<label>#<vehicle>")
   * - Vehicle Prefill's "Quote a different vehicle" card checkbox ("prefill:AddVehicle"), avoiding
   *   anonymous dom-v1 keys tied to Id_AutoVehiclePrefill_NativePrefillChoiceSet_<render>.
   * @param {Element | null | undefined} el
   * @returns {string | null}
   */
  function specialKey(el) {
    const cov = coverageKey(el);
    if (cov) return cov;
    const input = /** @type {HTMLInputElement | null | undefined} */ (el);
    if (input?.tagName === 'INPUT' && input.type?.toLowerCase() === 'checkbox' && input.value === 'AddVehicle') {
      if (lightEl(el)?.closest?.('gds-card-selections-card')) return 'prefill:AddVehicle';
    }
    return null;
  }

  /**
   * Clean, tooltip-free question caption for the usage recorder (and grid cells whose aria-label
   * is missing, dangling, or embeds encrypted client names).
   * @param {Element | null | undefined} el
   * @returns {string}
   */
  function captionOf(el) {
    if (!el) return '';
    const input = /** @type {HTMLInputElement} */ (el);
    const node = lightEl(el);
    if (!node) return '';
    // Vehicle Prefill manual-entry card checkbox: read its title without touching prefilled
    // vehicle cards (whose titles contain vehicle models and masked VINs).
    if (input.tagName === 'INPUT' && input.type?.toLowerCase() === 'checkbox' && input.value === 'AddVehicle') {
      const card = node.closest?.('gds-card-selections-card');
      if (card) return cleanText(card.querySelector?.('.image-selection-title')) || 'Quote a different vehicle';
    }
    // Inside .ssp-grid, the row header <td class="row-header"> holds the exact question caption
    // without client PII (whereas aria-label may be absent on DOB or embed client names).
    const td = node.closest?.('td');
    if (td?.closest?.('.ssp-grid')) {
      const hdr = td.parentElement?.querySelector?.('td.row-header');
      const text = cleanText(hdr);
      if (text) return text;
    }
    // Radios delegate to recorder.js legendFor(), which reads [slot="legend"] stripping tooltips.
    if (input.type?.toLowerCase() === 'radio') return '';
    const doc = node.ownerDocument ?? document;
    if (el.id) {
      const escaped = String(el.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const linked = doc.querySelector?.(`gds-label-legend[for="${escaped}"], label[for="${escaped}"]`);
      const text = cleanText(linked);
      if (text) return text;
    }
    const field = node.closest?.('.form-field');
    if (field) {
      const own = field.querySelector?.('gds-label-legend');
      const text = cleanText(own);
      if (text) return text;
    }
    return '';
  }

  /** @type {PageAdapterShared} */
  const shared = {
    selectors: {
      // Spinners while a step loads and while Recalculate rates (stay display:none when idle).
      busy: ['#page-load', '#extendedWaiting'],
      // A <gds-button> host is what the agent presses (its shadow <button>/<a> holds only a slot).
      agentPress: ['gds-button'],
      // A legend's <gds-tooltip> holds help copy, never the question's words.
      tooltips: ['gds-tooltip'],
      // Address autocomplete suggestions inside <gds-address-auto-complete-wrapper>'s shadow root.
      suggestions: ['gds-dropdown-list-item[type="address"]'],
      // Left-drawer vertical stepper navigation links: never clicked as Continue or helper.
      stepLinks: ['gds-drawer', 'gds-vertical-stepper'],
      // Disabled GDS buttons and disabled select wrappers.
      disabled: ['gds-button[disabled]', '.select-box.disabled'],
      // Field validation messages.
      errors: ['.form-message'],
    },
    // Every step shares /quote and document.title === "GEICO". Identify the active step from the
    // unlisted Vehicle Prefill interstitial first, then the sole current vertical stepper item.
    step: () => {
      try { if (typeof window === 'undefined' || window !== window.top) return undefined; } catch { return undefined; }
      if (typeof location === 'undefined' || !QUOTE_PATH.test(location.pathname)) return undefined;
      if (document.querySelector('[id^="Id_AutoVehiclePrefill_"]')) return 'Vehicle Prefill';
      if (!document.querySelector('gds-vertical-stepper-item')) return undefined;
      const current = document.querySelectorAll('gds-vertical-stepper-item[state="current"]');
      if (current.length !== 1) return null;
      return STEPS[cleanText(current[0]).toUpperCase()] ?? null;
    },
    // A pick on a GDS radio updates active-index on <gds-radio-button-group>; a Vehicle Prefill
    // card toggle updates selected on <gds-card-selections-card>.
    changeAttributes: ['active-index', 'selected'],
    // Wait for GDS custom elements to upgrade before harvesting/filling.
    components: 'gds-',
    keys: {
      ref: dataName,
      row: rowOf,
      special: specialKey,
      dataName,
    },
    caption: captionOf,
    // GEICO date inputs sit inside <gds-date-input-wrapper> or a date-masked <gds-input-wrapper>.
    date: (el) => !!lightEl(el)?.closest?.('gds-date-input-wrapper, [mask-type*="date"]'),
  };

  /**
   * Reorders .ssp-grid controls (Vehicle Information, Driver Information) column-first
   * (page-level before grid -> Column 1 -> Column 2 -> ... -> page-level footer last, such as
   * GiveAllDriversAcknowledgement), and enforces within-column dependency order (e.g. Primary Use
   * before Annual Mileage; Marital Status early in Driver 1). Non-grid pages keep DOM order.
   * @param {any[]} controls
   */
  function orderControls(controls) {
    if (!Array.isArray(controls) || controls.length < 2) return controls;
    const cols = controls.map((c) => gridColumnOf(c?.el));
    const firstGridIdx = cols.findIndex((n) => n != null);
    if (firstGridIdx < 0) return controls;
    return controls
      .map((control, index) => {
        const col = cols[index];
        const stem = dataName(control?.el) ?? '';
        const priority = col != null && stem in GRID_PRIORITY ? GRID_PRIORITY[stem] : 50;
        const group = col != null ? col : index < firstGridIdx ? 0 : Infinity;
        return { control, index, group, priority };
      })
      .sort((a, b) => a.group - b.group || a.priority - b.priority || a.index - b.index)
      .map((x) => x.control);
  }

  // Track same-origin GEICO PA API XHR/fetch requests (/api/lookup/* and /api/conversation/*)
  // in flight (MAIN world) so serverBacked waits hold until SearchVin, LengthOfOwnership,
  // AnnualMileage, GetUpdatePageTemplate, OccupationByIndustry, DateFirstLicensed, and
  // controlinput finish redrawing the form. Ignore analytics/telemetry/polling endpoints.
  function ensureNetTracker() {
    const g = /** @type {any} */ (globalThis);
    if (g.__raterGpaNet) return g.__raterGpaNet;
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
        const base = typeof location !== 'undefined' && location?.href ? location.href : 'https://sales.geico.com/quote';
        const u = new URL(String(url ?? ''), base);
        if (typeof location !== 'undefined' && location?.origin && u.origin !== location.origin) return false;
        return /\/api\/(?:lookup|conversation)\//i.test(u.pathname);
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
    g.__raterGpaNet = tracker;
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
      row: (_widget, el) => rowOf(el),
      order: orderControls,
    };
  }

  globalThis.__raterAdapter = { carrier: 'geico-pa', shared, create };
})();
