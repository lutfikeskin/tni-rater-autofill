// GEICO's page adapter: what its quote pages (sales.geico.com) draw that no other carrier does,
// injected before field-key.js's and pagekit.js's use on GEICO's tabs only (the carrier config's
// `pageAdapter`), in the kit's world and the usage recorder's. Classic script, no imports; it
// registers itself as globalThis.__raterAdapter.
//
// GEICO draws its questions with its own design-system components (gds-*), each in a shadow root;
// the kit and the recorder read shadow roots, slots and -button hosts for any page, so what is left
// here is the components' names, the pages' own markers and how its fields are named. All of it is
// `shared`: plain DOM, read by field-key.js, the recorder and the kit alike.
/** @import { PageAdapterShared } from '../../../types.js' */

(() => {
  // GEICO draws a question as Id_<Name>_<render number> and renumbers it on every redraw (a new
  // step, an answer that reveals follow-ups, Recalculate): an edit kept under the number protects
  // nothing after the next redraw. <Name> is the data-model name (GiveYear,
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

  /** @type {PageAdapterShared} */
  const shared = {
    selectors: {
      // Spinners while a step loads and while Recalculate rates (both stay in the page,
      // display:none, when idle).
      busy: ['#page-load.loader-container', '#extendedWaiting.loader-container'],
      // A <gds-button> host is what the agent presses (its shadow <button> holds only a slot).
      agentPress: ['gds-button'],
      // A legend's <gds-tooltip> holds its help text in the page: never the question's words.
      tooltips: ['gds-tooltip'],
      // The address box's suggestions, in its wrapper's shadow root (FL live run 3, 2026-10-21).
      suggestions: ['gds-dropdown-list-item[type=address]'],
      // The step progress bar: one <gds-progress-bar> per step, in the page itself, value 100
      // done, 0 to come; every step shares one address, so the bar says which step is on screen.
      stepBar: ['gds-progress-bar[value]'],
      // The bar's links (#progressIndicator) each open their step: never a helper or a Continue.
      stepLinks: ['#progressIndicator'],
    },
    // A pick on a design-system radio redraws nothing: its group's `active-index` changes (and
    // its host's `checked`, which the kit watches on any page).
    changeAttributes: ['active-index'],
    // Its own components' tag prefix: a fill waits for those the page hasn't defined yet (they
    // draw no control while GEICO's script loads).
    components: 'gds-',
    keys: {
      // A field by its data-model name (ref:GiveYear), never the render number it is drawn with.
      ref: dataName,
      dataName,
      // A coverage list by its coverage and row (cov:COMP#2), or its caption (cov:liability coverage).
      special: coverageKey,
    },
  };

  globalThis.__raterAdapter = { carrier: 'geico', shared };
})();
