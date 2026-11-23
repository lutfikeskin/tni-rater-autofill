// @ts-check
// Progressive Personal Auto: on Progressive's agent site (foragentsonly.com), for a personal-auto
// intake. It has its own page adapter (`src/content/carriers/progressive-pa.js`): Progressive's
// personal-auto quote is a different Angular app on `/Quote/Index/`, on the same host as commercial
// Progressive, whose ExtJS adapter does not apply. The page stays `/Quote/Index/`, steps are named
// by the adapter's `step` hook from the navigation bar, and Point of Sale and Final Sale are stop
// steps. No rules yet and no `display`: the panel knows the tab and records it (captures, developer
// recordings), fills nothing, and does not offer it as a rater until its rules are written from
// recorded quotes (docs/new-carrier.md).

/** @import { CarrierConfig } from '../../types.js' */

/** @type {CarrierConfig} */
export const progressivePa = {
  id: 'progressive-pa',
  name: 'Progressive Personal Auto',
  product: 'personal-auto',
  hosts: [/(^|\.)foragentsonly\.com$/, /(^|\.)progressive\.com$/],
  pageAdapter: 'src/content/carriers/progressive-pa.js',
  // Automatic layouts and quote-tab ownership apply only to the quote itself, not /home/.
  layoutUrl: /\/Quote\/Index(?:\/|[?#]|$)/i,
  layoutSteps: ['Named Insured', 'Products', 'Household Members', 'Additional Details', 'Coverages', 'Portfolio', 'Point of Sale', 'Final Sale'],
  stopSteps: {
    'Point of Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
    'Final Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
  },
  rules: [],
  useGenericRules: false,
};
