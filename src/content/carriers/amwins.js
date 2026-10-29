// AmWINS' page adapter: what its application pages draw that no other carrier does, injected
// before pagekit.js only on AmWINS' tabs (the carrier config's `pageAdapter`). Classic script, no
// imports; it registers itself as globalThis.__raterAdapter.
/** @import { PageAdapter } from '../../../types.js' */

(() => {
  /** @returns {Partial<PageAdapter>} */
  function create() {
    return {
      selectors: {
        // Its overlay while it saves or reloads the application (it redraws every step when the
        // reload lands, so nothing may be filled before that).
        busy: ['#loadingDefault'],
        // Every step of the application is in the page, each in its own .form-tab; only the one on
        // screen is shown.
        otherStep: ['.form-tab'],
      },
    };
  }

  globalThis.__raterAdapter = { carrier: 'amwins', create };
})();
