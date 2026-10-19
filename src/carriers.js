// Per-carrier settings. `rules` are exact mappings for that carrier's pages and always win over
// the generic label rules in rules.js. A rule targets a field by one of:
//   q        the carrier's own question id (Duck Creek sites like Progressive)
//   selector a CSS selector
//   label    a regex on the field's label (same format as rules.js), plus optional `not`
// and gets its value from `path` (a client-record path) or `value(record, active)`. A rule with
// `note` and no value marks the field for the agent and never fills it.
//
// `layoutUrl` (or else `autoFillUrl`): the carrier's quote pages, where page layouts are recorded
// as the agent works even without a fill. A carrier with neither gets layouts from fills only.
// `layoutSteps`: one address for several steps (AmWINS), as the list of its step headings; each
// layout also names its step, and fill and field-change events name it only when it is one of them.
//
// `quoteSteps`: the quote's steps in order, for the side panel's page strip, each with the pages
// (`pages`) or the one-address step heading (`step`, one of `layoutSteps`) that are part of it.
//
// `world: 'MAIN'` runs the page script in the page's own JavaScript world, needed when the
// carrier's widgets (e.g. ExtJS) are only reachable through the page's own objects.
//
// Host patterns also need a matching entry in manifest.json "host_permissions".

import { progressive } from './carriers/progressive.js';
import { amwins } from './carriers/amwins.js';

export const CARRIERS = [
  progressive,
  {
    id: 'geico',
    name: 'GEICO',
    hosts: [/(^|\.)geico\.com$/],
    // Empty until we capture GEICO's quote pages; the generic label rules do the work meanwhile.
    rules: [],
  },
  amwins,
  {
    id: 'test',
    name: 'Local test page',
    hosts: [/^(localhost|127\.0\.0\.1)$/],
    rules: [],
  },
];

// Practice copies of carrier pages served from this repo (test/replay, test/mock-progressive).
// They get the real carrier's rules, but aren't real quotes, so usage isn't recorded for them.
const PRACTICE = [
  { path: /^\/test\/(replay|mock-progressive)\//, carrier: 'progressive' },
  { path: /^\/test\/fixtures\/amwins\//, carrier: 'amwins' },
];

export function carrierForUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
    const practice = PRACTICE.find((p) => p.path.test(u.pathname));
    const real = practice && CARRIERS.find((c) => c.id === practice.carrier);
    if (real) return { ...real, name: `${real.name} (practice)`, practice: true, autoFillUrl: null, layoutUrl: null };
  }
  return CARRIERS.find((c) => c.hosts.some((re) => re.test(u.hostname))) ?? null;
}

// Where the tab is in the carrier's quote (`quoteSteps`), for the side panel's page strip: the
// step's name, its place (0-based) and how many steps there are; null on a page in none of them.
// `step`: the one-address application's step (usage.js knownStep), when known.
export function quoteProgress(carrier, page, step) {
  const steps = carrier?.quoteSteps ?? [];
  const index = steps.findIndex((s) => (step && s.step === step) || (page && s.pages?.includes(page)));
  return index < 0 ? null : { name: steps[index].name, index, count: steps.length };
}
