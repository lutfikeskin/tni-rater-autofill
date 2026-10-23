// @ts-check
// Per-carrier settings. `rules` are exact mappings for that carrier's pages and always win over
// the generic label rules in rules.js. A rule targets a field by one of:
//   q        the carrier's own question id (Duck Creek sites like Progressive)
//   field    the field's data-model name (Progressive's fieldref, GEICO's Id_<Name>_<n> stem)
//   ask      the question's exact text, as a check on the name or on its own
//   selector a CSS selector
//   label    a regex on the field's label (same format as rules.js), plus optional `not`
// and gets its value from `path` (a client-record path) or `value(record, active)`. A rule with
// `note` and no value marks the field for the agent and never fills it.
//
// On a one-address application a rule names the step(s) it answers on (`steps`, from
// `layoutSteps`: GEICO's GiveFirstName is the owner on one step and a driver on another), and
// a rule for one form of a step names a question only that form asks: `whenShown` (or
// `unlessShown`) `{ field, label?, unit? }`, with `unit` ('vehicles', 'drivers', 'trailers') when
// the form is for the panel's active vehicle, driver or trailer. Either may be a function of
// (record, active); so may `verifyOnly` (checked against the intake, never typed).
//
// `layoutUrl` (or else `autoFillUrl`): the carrier's quote pages, where page layouts are recorded
// as the agent works even without a fill. A carrier with neither gets layouts from fills only.
// `layoutSteps`: one address for several steps, as the list of its step names (AmWINS' headings,
// GEICO's progress bar); each layout also names its step, and fill and field-change events name it
// only when it is one of them.
//
// `quoteSteps`: the quote's steps in order, for the side panel's page strip, each with the pages
// (`pages`) or the one-address step (`step`, one of `layoutSteps`) that are part of it.
//
// `vehicleSteps` / `driverSteps`: one-address steps that show one vehicle's (or trailer's) form, or
// one driver's, at a time: the agent's edits there are kept per unit. `stopSteps`: steps that are
// the agent's, by name, with what the panel says there: nothing is filled or clicked on them. An
// action's `steps`: the only steps it is clicked on. `stopButtons`: screens that are the agent's
// without a step of their own, by name, each known by a button only it shows (`button`, a pattern on
// the button's words) with what the panel says there (`note`, or a function of the client record):
// nothing is filled or clicked on them either (stopScreen below).
//
// `world: 'MAIN'` runs the page script in the page's own JavaScript world, needed when the
// carrier's widgets (e.g. ExtJS) are only reachable through the page's own objects.
//
// Host patterns also need a matching entry in manifest.json "host_permissions".

import { progressive } from './carriers/progressive.js';
import { amwins } from './carriers/amwins.js';
import { geico } from './carriers/geico.js';

/** @import { CarrierConfig } from '../types.js' */

/** @type {CarrierConfig[]} */
export const CARRIERS = [
  progressive,
  geico,
  amwins,
  {
    id: 'test',
    name: 'Local test page',
    hosts: [/^(localhost|127\.0\.0\.1)$/],
    rules: [],
  },
];

// Practice copies of carrier pages served from this repo (test/replay, test/mock-progressive,
// test/fixtures/amwins, test/fixtures/geico).
// They get the real carrier's rules, but aren't real quotes, so usage isn't recorded for them.
const PRACTICE = [
  { path: /^\/test\/(replay|mock-progressive)\//, carrier: 'progressive' },
  { path: /^\/test\/fixtures\/amwins\//, carrier: 'amwins' },
  { path: /^\/test\/fixtures\/geico\//, carrier: 'geico' },
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

// The carrier's screen that is the agent's (`stopButtons`) a page shows, by the words of its buttons
// (a page layout's `buttons`): its name, or null.
export function stopScreen(carrier, buttons) {
  const words = (buttons ?? []).map((b) => String(b ?? '').replace(/\s+/g, ' ').trim());
  return Object.entries(carrier?.stopButtons ?? {}).find(([, s]) => words.some((w) => new RegExp(s.button, 'i').test(w)))?.[0] ?? null;
}
