// Per-carrier settings. `rules` are exact mappings for that carrier's pages and always win over
// the generic label rules in rules.js. A rule targets a field by one of:
//   q        the carrier's own question id (Duck Creek sites like Progressive)
//   selector a CSS selector
//   label    a regex on the field's label (same format as rules.js), plus optional `not`
// and gets its value from `path` (a client-record path) or `value(record, active)`. A rule with
// `note` and no value marks the field for the agent and never fills it.
//
// `world: 'MAIN'` runs the page script in the page's own JavaScript world, needed when the
// carrier's widgets (e.g. ExtJS) are only reachable through the page's own objects.
//
// Host patterns also need a matching entry in manifest.json "host_permissions".

import { progressive } from './carriers/progressive.js';

export const CARRIERS = [
  progressive,
  {
    id: 'geico',
    name: 'GEICO',
    hosts: [/(^|\.)geico\.com$/],
    // Empty until we capture GEICO's quote pages; the generic label rules do the work meanwhile.
    rules: [],
  },
  {
    id: 'test',
    name: 'Local test page',
    hosts: [/^(localhost|127\.0\.0\.1)$/],
    rules: [],
  },
];

export function carrierForUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return CARRIERS.find((c) => c.hosts.some((re) => re.test(host))) ?? null;
}
