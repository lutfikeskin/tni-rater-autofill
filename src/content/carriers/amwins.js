// AmWINS' page adapter: what its application pages draw that no other carrier does, injected on
// AmWINS' tabs only (the carrier config's `pageAdapter`), in the kit's world and the usage
// recorder's. Classic script, no imports; it registers itself as globalThis.__raterAdapter. All of
// it is `shared`: plain DOM, read by field-key.js, the recorder and the kit alike.
/** @import { PageAdapterShared } from '../../../types.js' */

(() => {
  /** @type {PageAdapterShared} */
  const shared = {
    selectors: {
      // Its overlay while it saves or reloads the application (it redraws every step when the
      // reload lands, so nothing may be filled before that).
      busy: ['#loadingDefault'],
      // Every step of the application is in the page, each in its own .form-tab; only the one on
      // screen is shown.
      otherStep: ['.form-tab'],
    },
    keys: {
      // A checkbox repeated per row keeps the template's name, and only its id carries the row
      // (vehicle coverage boxes: name "medicalPaymentExclude", ids medicalPaymentExclude<row>_<box>_).
      // Every row gets its own key, name#<row> numbered from 1, so an edit or answer on one vehicle
      // stays on that vehicle. The first row too: a plain name saved before (field key version 2)
      // could be any row's edit, and protects them all (field-key.js rowKeyBase).
      rowName: (el) => {
        if (!el.name || el.type?.toLowerCase() === 'radio') return null;
        const row = String(el.id ?? '').startsWith(el.name) ? el.id.slice(el.name.length).match(/^(\d+)_\d+_/)?.[1] : null;
        return row ? `${el.name}#${Number(row) + 1}` : null;
      },
    },
  };

  globalThis.__raterAdapter = { carrier: 'amwins', shared };
})();
