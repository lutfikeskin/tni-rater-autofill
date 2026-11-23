// @ts-check
// GEICO Personal Auto: on GEICO's agent site, for a personal-auto intake. No rules yet: the panel
// knows the tab and records it (captures, developer recordings), and fills nothing, until the
// rules are written from recorded quotes (docs/new-carrier.md). Not offered as a rater until then
// (no `display`).

/** @import { CarrierConfig } from '../../types.js' */

/** @type {CarrierConfig} */
export const geicoPa = {
  id: 'geico-pa',
  name: 'GEICO Personal Auto',
  product: 'personal-auto',
  hosts: [/(^|\.)geico\.com$/],
  // GEICO's own components (gds-*, the progress bar), as on its commercial quote: read with the same
  // page adapter, so captures and recordings name its questions. To confirm on the first recording.
  pageAdapter: 'src/content/carriers/geico.js',
  rules: [],
  useGenericRules: false,
};
