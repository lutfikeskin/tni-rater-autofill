// @ts-check
// Agents' own defaults in the side panel (docs/agent-defaults-spec.md, "Storage"): the profiles the
// agent keeps in Settings → Your defaults, the question each quote asks before anything fills, and
// what the rest of the panel reads of them. The module's rules (src/agent-defaults/) decide what a
// default changes; this file only keeps the agent's choices and says them.
//
// - chrome.storage.local `agentDefaults`: { v: 1, active: <profile id> | null, activeFor: <initials>
//   | null, profiles: { [id]: { name, values: { [standard id]: { value } }, carriers?: { [carrier id]:
//   { [standard id]: { value } | { ask: true } } } } } }. `values` is the basic section's; `carriers`
//   Advanced's, a carrier's own pick over the basic one (no pick: "As above"). Missing means
//   none: TNI's everywhere. Ids are random, never the agent's initials. The active profile counts
//   only under the initials it was picked with (`activeFor`): changing the initials leaves none
//   active, even if that write fails.
// - chrome.storage.session `agentDefaultsQuote`: { session, choice: 'mine' | 'tni', profile, initials,
//   hash }, this quote's answer to "Fill this quote with <profile>'s defaults?". Asked again for each
//   new quote (usage session); a panel opened again keeps it. "Yes, mine" holds only for the profile,
//   initials and amounts (their defaultsHash) it was given for: a profile switched, edited or deleted
//   since asks again, so nothing fills with amounts the agent didn't approve for this quote.
// - chrome.storage.local `agentDefaultsHidden`: true when the developer hid the feature in this
//   unpacked copy (Settings → Advanced). The store build ignores it: there RELEASED_TO_AGENTS decides.
// - Until the quote's question is answered nothing fills (defaultsHold: fillPage, the automatic
//   fills and the dock wait on it, as on the quote-state hold). Nor while a new intake's quote is
//   being set up (quoteStarting, until refreshDefaults), or while the agent's answer is being saved.
//   An answer Chrome refuses to save is cleared, so the quote is asked again, also after a reopen.
//
// Core panel code reads this file only through the names it exports (marked "agent defaults" where
// they're used). Removing the feature: this folder, those lines, and the TNI defaults section's mount.

import {
  RELEASED_TO_AGENTS, REGISTRY, agentDefaultsOn, amountSaid, carrierOverrides, defaultsForLog, defaultsHash, effectiveDefaults,
  isAgentDefault, onDefaultsError, setActiveDefaults, setAgentDefaultsOn,
} from '../../../src/agent-defaults/index.js';
import { CARRIERS } from '../../../src/carriers.js';
import { STANDARD_IDS } from '../../../src/standards.js';
import * as usage from '../../usage-log.js';
import { inExtension } from '../env.js';
import { logCrash, state } from '../core.js';

/** @import { DefaultChoice, DefaultsProfile } from '../../../types.js' */

const KEY = 'agentDefaults';
const QUOTE_KEY = 'agentDefaultsQuote';
const HIDDEN_KEY = 'agentDefaultsHidden';
const memory = {};
const hiddenStore = inExtension
  ? { get: async () => (await chrome.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY], set: (v) => chrome.storage.local.set({ [HIDDEN_KEY]: v }) }
  : { get: async () => memory[HIDDEN_KEY], set: async (v) => { memory[HIDDEN_KEY] = v; } };

/**
 * Whether this copy of the panel has the feature: agents' store build only once TNI's managers have
 * approved it (RELEASED_TO_AGENTS), any other copy (unpacked, the repository's files) unless the
 * developer hid it.
 * @param {string} channel @param {boolean} hidden
 */
export const defaultsShownFor = (channel, hidden) => (channel === 'store' ? RELEASED_TO_AGENTS : !hidden);
let channel = 'source';
// Turns the feature on or off in this copy: the module's overlay and rulebook rewrite, and what the
// panel draws of it (state.defaultsOn: the Settings section, the question, the client strip's pill).
function show(on) {
  setAgentDefaultsOn(on);
  state.defaultsOn = on;
}
const local = inExtension
  ? { get: async () => (await chrome.storage.local.get(KEY))[KEY], set: (v) => chrome.storage.local.set({ [KEY]: v }) }
  : { get: async () => memory[KEY], set: async (v) => { memory[KEY] = v; } };
const session = inExtension
  ? { get: async () => (await chrome.storage.session.get(QUOTE_KEY))[QUOTE_KEY], set: (v) => chrome.storage.session.set({ [QUOTE_KEY]: v }), clear: () => chrome.storage.session.remove(QUOTE_KEY) }
  : { get: async () => memory[QUOTE_KEY], set: async (v) => { memory[QUOTE_KEY] = v; }, clear: async () => { delete memory[QUOTE_KEY]; } };

// What is stored, read whole: a shape it doesn't know is none.
/** @returns {{ v: 1, active: string | null, activeFor: string | null, profiles: Record<string, DefaultsProfile> }} */
const empty = () => ({ v: 1, active: null, activeFor: null, profiles: {} });
// A profile picked under other initials (or none recorded) isn't active under these.
function cleanStored(x, initials) {
  if (!x || typeof x !== 'object' || x.v !== 1 || typeof x.profiles !== 'object' || !x.profiles) return empty();
  const active = typeof x.active === 'string' && x.profiles[x.active] && initials && x.activeFor === initials ? x.active : null;
  return { v: 1, active, activeFor: active ? initials : null, profiles: x.profiles };
}

// The quote's question and the profile in force, as the module needs them (setActiveDefaults).
let initials = null;
let quote = null;
// A new intake's quote being set up (quoteStarting), and the agent's answer being saved: both hold.
let starting = false;
let saving = false;
const currentSessionId = () => usage.currentSession()?.id ?? null;

/** The active profile, when the agent has one and initials to go with it. @returns {DefaultsProfile | null} */
function activeProfile() {
  const stored = state.agentDefaults;
  if (!agentDefaultsOn() || !initials || !stored?.active || stored.activeFor !== initials) return null;
  return stored.profiles[stored.active] ?? null;
}
// A profile replacing anything, in the basic section or a carrier's (Advanced): one that only repeats
// TNI's asks nothing.
const replacesAny = (profile) => !!profile && defaultsForLog(profile).length > 0;
// The carriers Advanced offers: those the registry lists amounts for.
export const DEFAULTS_CARRIERS = Object.freeze(Object.keys(REGISTRY[0]?.choices ?? {}).filter((id) => id !== 'all')
  .map((id) => ({ id, name: CARRIERS.find((c) => c.id === id)?.name ?? id })));
// This quote's answer, when it is this quote's; "Yes, mine" only while the profile, the initials and
// the amounts are the ones it was given for.
function choiceHere() {
  if (!quote || quote.session !== currentSessionId()) return null;
  if (quote.choice !== 'mine') return quote.choice;
  const same = quote.profile === (state.agentDefaults?.active ?? null) && quote.initials === initials
    && quote.hash != null && quote.hash === defaultsHash(activeProfile());
  return same ? 'mine' : null;
}

// Tells the module which defaults fill this quote: the profile's after "Yes, mine", else none.
function apply() {
  const profile = activeProfile();
  setActiveDefaults(!starting && !saving && choiceHere() === 'mine' && replacesAny(profile) ? profile : null);
  say();
}

/** Reads what is stored (the panel's init) and logs an overlay error as a client_error. */
export async function loadDefaults() {
  onDefaultsError((error) => logCrash(error));
  // The developer's switch, read apart: a read Chrome refuses is logged and taken as not hidden, never
  // stopping the panel's start (the store build ignores it anyway).
  const hiddenRead = hiddenStore.get().catch((error) => { logCrash(error); return undefined; });
  const [stored, own, kept, hidden] = await Promise.all([local.get(), usage.agentInitials(), session.get(), hiddenRead]);
  channel = usage.build().channel;
  // The developer's switch: in every copy but the store build.
  state.defaultsDev = channel !== 'store';
  show(defaultsShownFor(channel, hidden === true));
  initials = own ?? null;
  state.defaultsInitials = initials;
  quote = kept && typeof kept === 'object' ? kept : null;
  state.agentDefaults = cleanStored(stored, initials);
  apply();
}

// The panel shows only what was saved: a write that fails changes no profile and is logged. The
// module still follows what changed in memory meanwhile (initials blanked: no defaults fill).
async function store(next) {
  try {
    await local.set(next);
  } catch (error) {
    logCrash(error);
    apply();
    return;
  }
  state.agentDefaults = next;
  apply();
}

// Nothing fills while this quote's question is unanswered: only with the feature on, initials, an
// active profile replacing something, and an intake loaded in a quote.
export function defaultsHold() {
  if (!state.intake || !replacesAny(activeProfile())) return false;
  return starting || saving || (!!currentSessionId() && !choiceHere());
}

// A new intake is loading (intake.js, from the moment it is the panel's): nothing fills with the
// last quote's answer until the new quote is set up and asked (refreshDefaults ends it).
export function quoteStarting() {
  starting = true;
  apply();
}

// What the quote's agent_settings log (`defaults`): the profile's replacements after "Yes, mine",
// an empty list after "Use TNI's", nothing before the agent answers.
export function settingsDefaults() {
  const choice = choiceHere();
  if (!choice || !agentDefaultsOn()) return undefined;
  return choice === 'mine' ? defaultsForLog(activeProfile()) : [];
}

// The fingerprint a fill's events carry (fill_run, fill_error), or undefined with TNI's.
export function fillDefaultsHash() {
  return (choiceHere() === 'mine' && defaultsHash(activeProfile())) || undefined;
}

// An answer the agent's own default filled (the report's tag).
/** @param {any} item @param {string} [list] */
export const isOwnDefault = (item, list) => isAgentDefault(item, list);

/** The initials changed: no profile is active until the agent picks one again. */
export async function initialsChanged(value) {
  initials = value ?? null;
  state.defaultsInitials = initials;
  const stored = state.agentDefaults ?? empty();
  if (stored.active) {
    // None active from now on; if the write fails, `activeFor` still keeps the old one inactive.
    const next = { ...stored, active: null, activeFor: null };
    state.agentDefaults = next;
    await local.set(next).catch((error) => logCrash(error));
  }
  apply();
}

// The question, or the profile in force, above the page's answers (cards-view.jsx `defaults`).
// `answer(choice)` and the logging are wired by the panel (answerDefaults).
let onAnswer = (_choice) => {};
/** @param {(choice: 'mine' | 'tni') => void} fn */
export function onDefaultsAnswer(fn) { onAnswer = fn; }

// Each change from TNI's standards: the basic ones, then each carrier's own (a carrier's TNI's over a
// basic default included). `note` is the question card's line; label, value and tni the icon's popover.
function changes(profile) {
  const one = (label, e, d) => {
    const tni = amountSaid(STANDARD_IDS[e.id]());
    if ('ask' in d) return { label, value: 'You answer it', tni, note: `${label}: you answer it (TNI's: ${tni})` };
    if (JSON.stringify(d.value) === JSON.stringify(STANDARD_IDS[e.id]())) return { label, value: `TNI's ${tni}`, tni: null, note: `${label}: TNI's ${tni}` };
    const value = amountSaid(d.value);
    return { label, value, tni, note: `${label}: ${value} (TNI's: ${tni})` };
  };
  const basic = effectiveDefaults({ values: profile.values }, null);
  const lines = REGISTRY.filter((e) => basic[e.id]).map((e) => one(e.label, e, basic[e.id]));
  for (const c of DEFAULTS_CARRIERS) {
    const own = carrierOverrides(profile, c.id);
    for (const e of REGISTRY) if (own[e.id]) lines.push(one(`${c.name} only: ${e.label}`, e, own[e.id]));
  }
  return lines;
}

// Before the agent answers, the question as a card above the page's answers (cards-view.jsx
// `defaults`): it holds the fill, so it must be seen. Once answered, a pill in the client strip
// (client-view.jsx, state.defaultsChip) with what this quote fills in its popover.
function say() {
  const profile = activeProfile();
  const choice = choiceHere();
  let card = null;
  let chip = null;
  // Switching changes what fills from now on; answers already on the carrier's pages stay as they
  // are (as with any answer the fill engine gave before), so the popover says so.
  const after = 'Switching changes what fills next, not answers already on the carrier\'s pages.';
  if (!starting && state.intake && currentSessionId() && replacesAny(profile)) {
    const name = profile.name || 'Your profile';
    const changed = changes(profile);
    if (!choice) {
      card = { tone: 'warn', role: 'alert', title: `Fill this quote with ${name}'s defaults?`, text: `Nothing fills until you answer. ${changed.length} in place of TNI's standards:`, notes: changed.map((c) => c.note), compare: [],
        actions: [{ label: 'Yes, mine', className: 'tinted', onClick: () => onAnswer('mine') }, { label: 'Use TNI\'s', className: 'ghost', onClick: () => onAnswer('tni') }] };
    } else if (choice === 'mine') {
      chip = { choice, count: changed.length, short: `${changed.length} yours`, label: `${name}'s defaults: ${changed.length} in place of TNI's`, title: `${name}'s defaults`, sub: 'On this quote, in place of TNI\'s standards',
        lines: changed.map(({ label, value, tni }) => ({ label, value, tni })), after, action: { label: 'Use TNI\'s for this quote', onClick: () => onAnswer('tni') } };
    } else {
      chip = { choice, count: 0, short: "TNI's", label: 'TNI\'s standards for this quote', title: 'TNI\'s standards for this quote', sub: `${name}'s defaults aren't used.`,
        lines: [], after, action: { label: `Use ${name}'s`, onClick: () => onAnswer('mine') } };
    }
  }
  state.cards = { ...state.cards, defaults: card };
  state.defaultsChip = chip;
}

/** The agent's answer for this quote. @param {'mine' | 'tni'} choice */
export async function answerDefaults(choice) {
  const id = currentSessionId();
  if (!id) return;
  const hash = choice === 'mine' ? defaultsHash(activeProfile()) : null;
  const next = { session: id, choice, profile: state.agentDefaults?.active ?? null, initials, hash };
  // Held while saving, and taken only once saved. An answer Chrome refused is logged and drops this
  // quote's earlier one too, here and in storage (a "Yes, mine" the agent was switching away from
  // never keeps filling, nor comes back with the panel reopened): the quote is asked again and held.
  saving = true;
  apply();
  try {
    await session.set(next);
    quote = next;
  } catch (error) {
    logCrash(error);
    quote = null;
    await session.clear().catch(() => {});
  } finally {
    saving = false;
  }
  apply();
}

// A new quote (intake loaded, or the panel on a saved one): say the question again.
export function refreshDefaults() {
  starting = false;
  apply();
}

/**
 * The developer's switch (Settings → Advanced, unpacked copies only): shows or hides the whole feature
 * in this copy, as agents' store build will have it. Kept across restarts. @param {boolean} on
 */
export async function setDefaultsShown(on) {
  if (channel === 'store') return;
  // As with the profiles, the panel shows only what was saved: a write Chrome refuses is logged and
  // changes nothing, so the next panel opened doesn't quietly go back.
  try {
    await hiddenStore.set(!on);
  } catch (error) {
    logCrash(error);
    return;
  }
  show(!!on);
  apply();
}

// Settings → Your defaults (view.jsx), as `act.defaults`.
export function defaultsActs() {
  const now = () => state.agentDefaults ?? empty();
  return {
    create: async (name) => {
      const label = String(name ?? '').trim().slice(0, 40);
      if (!label) return;
      const id = crypto.randomUUID();
      const stored = now();
      await store({ ...stored, active: id, activeFor: initials, profiles: { ...stored.profiles, [id]: { name: label, values: {} } } });
    },
    pick: async (id) => {
      const stored = now();
      const active = id && stored.profiles[id] ? id : null;
      await store({ ...stored, active, activeFor: active ? initials : null });
    },
    remove: async (id) => {
      const stored = now();
      if (!stored.profiles[id]) return;
      const { [id]: _gone, ...profiles } = stored.profiles;
      const active = stored.active === id ? null : stored.active;
      await store({ ...stored, active, activeFor: active ? stored.activeFor : null, profiles });
    },
    // A standard's amount (a DefaultChoice) or null for TNI's.
    set: async (stdId, value) => {
      const stored = now();
      const id = stored.active;
      const profile = id ? stored.profiles[id] : null;
      if (!profile || !REGISTRY.some((e) => e.id === stdId)) return;
      const values = { ...(profile.values ?? {}) };
      if (value == null) delete values[stdId];
      else values[stdId] = { value: /** @type {DefaultChoice} */ (value) };
      await store({ ...stored, profiles: { ...stored.profiles, [id]: { ...profile, values } } });
    },
    // Advanced: a carrier's own pick for a standard. null is "As above" (the basic one), 'ask'
    // leaves it to the agent there, else an amount (a DefaultChoice) that carrier's list offers.
    setCarrier: async (carrierId, stdId, pick) => {
      const stored = now();
      const id = stored.active;
      const profile = id ? stored.profiles[id] : null;
      if (!profile || !REGISTRY.some((e) => e.id === stdId) || !DEFAULTS_CARRIERS.some((c) => c.id === carrierId)) return;
      const carriers = { ...(profile.carriers ?? {}) };
      const own = { ...(carriers[carrierId] ?? {}) };
      if (pick == null) delete own[stdId];
      else own[stdId] = pick === 'ask' ? { ask: true } : { value: /** @type {DefaultChoice} */ (pick) };
      if (Object.keys(own).length) carriers[carrierId] = own;
      else delete carriers[carrierId];
      await store({ ...stored, profiles: { ...stored.profiles, [id]: { ...profile, carriers } } });
    },
  };
}

