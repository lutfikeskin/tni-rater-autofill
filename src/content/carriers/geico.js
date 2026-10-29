// GEICO's page adapter: what its quote pages (sales.geico.com) draw that no other carrier does,
// injected before pagekit.js only on GEICO's tabs (the carrier config's `pageAdapter`). Classic
// script, no imports; it registers itself as globalThis.__raterAdapter.
//
// GEICO draws its questions with its own design-system components (gds-*), each in a shadow root;
// the kit reads shadow roots, slots and -button hosts for any page, so what is left here is the
// components' names and the pages' own markers. Its data-model names (Id_<Name>_<n>) are in
// field-key.js, which the usage recorder shares.
/** @import { PageAdapter } from '../../../types.js' */

(() => {
  /** @returns {Partial<PageAdapter>} */
  function create() {
    return {
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
    };
  }

  globalThis.__raterAdapter = { carrier: 'geico', create };
})();
