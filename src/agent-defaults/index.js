// @ts-check
// Agents' own defaults (docs/agent-defaults-spec.md): the module's one entry point. Everything about
// the feature is under src/agent-defaults/ (and, from phase 5, sidepanel/panel/agent-defaults/).
// Core code only plugs it in: the panel's planFor passes overlayFor's overlay to buildPlan, and
// Luna's evidence passes rulebookRewriteFor's rewrite to rulebookFor. test/agent-defaults.test.mjs
// checks that nothing else imports it.
//
// Off switch: AGENT_DEFAULTS_ON. While false, overlayFor and rulebookRewriteFor give nothing, so
// every plan and rulebook is the rules' own, whatever is stored.
//
// Removing the feature: delete this folder and sidepanel/panel/agent-defaults/, the wiring lines in
// sidepanel/panel/plan-for.js and src/ai/common.js, server/agent-defaults.mjs (its header lists the
// rest), and these tests. The `std` fields on rules and the generic hooks may stay: alone they do
// nothing.

import { STANDARD_IDS } from '../standards.js';
import { CARRIERS } from '../carriers.js';
import { resolutionOf } from '../resolution.js';
import { REGISTRY, entryOf } from './registry.js';
import { AGENT_DEFAULT_SOURCE, makeOverlay, safeOverlay, amountSaid } from './overlay.js';

/** @import { DefaultChoice, DefaultsProfile, EffectiveDefaults, FillItem, RulebookEntry, StepOverlay } from '../../types.js' */

export { AGENT_DEFAULT_SOURCE, REGISTRY, amountSaid };

// The feature's switch. Phase 5 turns it on with the TNI defaults page (docs/agent-defaults-spec.md).
export const AGENT_DEFAULTS_ON = true;

// The profile whose defaults this quote fills with: set by the panel once the agent confirms it for
// the quote (phase 5), null otherwise. No profile, no change.
/** @type {DefaultsProfile | null} */
let active = null;
/** @param {DefaultsProfile | null} profile */
export function setActiveDefaults(profile) { active = profile ?? null; }
export const activeDefaults = () => active;

// Where an overlay that throws reports (the panel logs it as a client_error from phase 5).
/** @type {(error: unknown) => void} */
let reportError = () => {};
/** @param {(error: unknown) => void} fn */
export function onDefaultsError(fn) { reportError = fn; }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @param {DefaultChoice[]} list @param {unknown} value */
const offered = (list, value) => list.some((c) => same(c, value));

/**
 * The defaults in force on one carrier: each registry standard the profile replaces there, as
 * { value } (an amount its list offers) or { ask: true }. The carrier's own (Advanced) setting wins
 * over the profile's basic one. An unknown id, a value its list doesn't offer, or a value equal to
 * TNI's is left out, so that standard stays TNI's.
 * @param {DefaultsProfile | null} profile @param {string | null | undefined} carrierId
 * @returns {EffectiveDefaults}
 */
export function effectiveDefaults(profile, carrierId) {
  /** @type {EffectiveDefaults} */
  const out = {};
  if (!profile) return out;
  for (const entry of REGISTRY) {
    // A standard TNI locks keeps TNI's answer whatever is stored.
    if (entry.locked) continue;
    const own = carrierId ? profile.carriers?.[carrierId]?.[entry.id] : undefined;
    const basic = profile.values?.[entry.id];
    const pick = own ?? basic;
    if (!pick || typeof pick !== 'object') continue;
    if ('ask' in pick && pick.ask === true) { out[entry.id] = { ask: true }; continue; }
    if (!('value' in pick)) continue;
    const list = own ? entry.choices[carrierId ?? ''] ?? [] : entry.choices.all;
    if (!offered(list, pick.value) || same(pick.value, STANDARD_IDS[entry.id]())) continue;
    out[entry.id] = { value: pick.value };
  }
  return out;
}

/**
 * The overlay for a plan on this carrier, or null (off, no profile, or nothing replaced).
 * @param {string | null | undefined} carrierId @returns {StepOverlay | null}
 */
export function overlayFor(carrierId) {
  if (!AGENT_DEFAULTS_ON || !active || !carrierId) return null;
  const effective = effectiveDefaults(active, carrierId);
  if (!Object.keys(effective).length) return null;
  return safeOverlay(makeOverlay(effective, carrierId), (error) => reportError(error));
}

// The rulebook entries (by id) stating each standard on each carrier: the `tni` of its rules carrying
// that standard's `std`.
/** @param {string} carrierId @param {string} id */
const entriesFor = (carrierId, id) => new Set((CARRIERS.find((c) => c.id === carrierId)?.rules ?? [])
  .filter((r) => r.std?.id === id && r.tni).map((r) => r.tni));

/**
 * A rewrite for Luna's rulebook on this carrier: each entry stating a replaced standard says what the
 * agent's default is instead, so Luna never argues for TNI's amount; null when nothing is replaced.
 * @param {string | null | undefined} carrierId @returns {((entry: RulebookEntry) => RulebookEntry) | null}
 */
export function rulebookRewriteFor(carrierId) {
  if (!AGENT_DEFAULTS_ON || !active || !carrierId) return null;
  return makeRulebookRewrite(effectiveDefaults(active, carrierId), carrierId);
}

/**
 * The rewrite itself, from the defaults in force on the carrier (rulebookRewriteFor's, and the tests').
 * @param {EffectiveDefaults} effective @param {string} carrierId
 * @returns {((entry: RulebookEntry) => RulebookEntry) | null}
 */
export function makeRulebookRewrite(effective, carrierId) {
  /** @type {Map<string, string[]>} */
  const said = new Map();
  for (const [id, d] of Object.entries(effective)) {
    const label = entryOf(id)?.label ?? id;
    const line = 'ask' in d ? `The agent answers ${label.toLowerCase()} themselves here, not TNI's standard.`
      : `The agent's own default replaces TNI's ${label.toLowerCase()} here: ${amountSaid(d.value)}.`;
    for (const entryId of entriesFor(carrierId, id)) said.set(entryId, [...(said.get(entryId) ?? []), line]);
  }
  if (!said.size) return null;
  return (entry) => (said.has(entry.id) ? { ...entry, text: `${entry.text} ${said.get(entry.id).join(' ')}` } : entry);
}

// An answer filled with the agent's own default (the report's tag, the log's source).
/** @param {FillItem} item @param {string} [list] */
export const isAgentDefault = (item, list) => resolutionOf(item, list).method === AGENT_DEFAULT_SOURCE;

/**
 * What agent_settings.defaults logs: each standard the profile replaces, basic ones without a carrier,
 * in a fixed order (server/agent-defaults.mjs DEFAULTS_SHAPE). Only valid choices are logged, as
 * effectiveDefaults would use them. A rental default logs its daily amount.
 * @param {DefaultsProfile | null} profile
 * @returns {{ id: string, value: number | 'ask', carrier?: string }[]}
 */
export function defaultsForLog(profile) {
  if (!profile) return [];
  const out = [];
  const one = (id, d, carrier) => {
    const value = 'ask' in d ? 'ask' : typeof d.value === 'number' ? d.value : d.value.perDay;
    out.push(carrier ? { id, value, carrier } : { id, value });
  };
  for (const [id, d] of Object.entries(effectiveDefaults({ values: profile.values }, null))) one(id, d);
  for (const carrierId of Object.keys(profile.carriers ?? {}).sort()) {
    const own = effectiveDefaults({ carriers: { [carrierId]: profile.carriers[carrierId] } }, carrierId);
    for (const [id, d] of Object.entries(own)) one(id, d, carrierId);
  }
  return out;
}

/**
 * The profile a quote's logged `agent_settings.defaults` describe (defaultsForLog's inverse): what
 * the review tooling replays a recorded quote with (scripts/lib/agent-defaults.mjs). A rental default
 * logs its daily amount: the list's choice with that amount. An entry it can't read is left out, so
 * that standard replays as TNI's.
 * @param {unknown} defaults @returns {DefaultsProfile | null}
 */
export function profileFromLog(defaults) {
  if (!Array.isArray(defaults) || !defaults.length) return null;
  /** @type {Required<Pick<DefaultsProfile, 'values' | 'carriers'>>} */
  const profile = { values: {}, carriers: {} };
  for (const d of defaults) {
    const entry = typeof d?.id === 'string' ? entryOf(d.id) : null;
    const list = entry && (d.carrier ? entry.choices[d.carrier] : entry.choices.all);
    if (!list) continue;
    const choice = list.find((c) => (typeof c === 'number' ? c === d.value : c.perDay === d.value));
    const pick = d.value === 'ask' ? { ask: /** @type {const} */ (true) } : choice != null ? { value: choice } : null;
    if (!pick) continue;
    if (d.carrier) (profile.carriers[d.carrier] ??= {})[d.id] = pick;
    else profile.values[d.id] = pick;
  }
  return profile;
}

/**
 * The overlay a recorded quote was filled with on this carrier, from its logged defaults; null when it
 * logged none. Not behind AGENT_DEFAULTS_ON: it replays what a build with the feature on did.
 * @param {unknown} defaults @param {string | null | undefined} carrierId @returns {StepOverlay | null}
 */
export function replayOverlay(defaults, carrierId) {
  const profile = profileFromLog(defaults);
  if (!profile || !carrierId) return null;
  const effective = effectiveDefaults(profile, carrierId);
  return Object.keys(effective).length ? makeOverlay(effective, carrierId) : null;
}

/**
 * The fingerprint of the defaults a fill runs with (fill_run's and fill_error's `defaultsHash`): 12 hex
 * digits over what defaultsForLog says of the profile, so the same defaults give the same hash on any
 * computer; null with none (TNI's everywhere). Not a secret: it only tells two sets of defaults apart.
 * @param {DefaultsProfile | null} profile @returns {string | null}
 */
export function defaultsHash(profile) {
  const said = defaultsForLog(profile);
  if (!said.length) return null;
  // Two FNV-1a passes (32 bits each, different offsets): enough to tell profiles apart, and sync.
  const text = JSON.stringify(said);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01000193)}`.slice(0, 12);
}
