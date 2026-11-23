// @ts-check
// Progressive Personal Auto: on Progressive's agent site, for a personal-auto intake. No rules yet:
// the panel knows the tab and records it (captures, developer recordings), and fills nothing, until
// the rules are written from recorded quotes (docs/new-carrier.md). Where its quote runs, and on
// which pages, is not recorded yet, so it has no page adapter. Not offered as a rater until then
// (no `display`).

/** @import { CarrierConfig } from '../../types.js' */

/** @type {CarrierConfig} */
export const progressivePa = {
  id: 'progressive-pa',
  name: 'Progressive Personal Auto',
  product: 'personal-auto',
  hosts: [/(^|\.)foragentsonly\.com$/, /(^|\.)progressive\.com$/],
  rules: [],
  useGenericRules: false,
};
