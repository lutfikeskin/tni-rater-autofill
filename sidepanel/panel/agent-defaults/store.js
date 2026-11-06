// @ts-check
// Agents' own defaults in the side panel (docs/agent-defaults-spec.md, "Storage"): the profiles the
// agent keeps in Settings → TNI defaults, the question each quote asks before anything fills, and
// what the rest of the panel reads of them. The module's rules (src/agent-defaults/) decide what a
// default changes; this file only keeps the agent's choices and says them.
//
// - chrome.storage.local `agentDefaults`: { v: 1, active: <profile id> | null, activeFor: <initials>
//   | null, profiles: { [id]:
//   { name, values: { [standard id]: { value } } } } }. Missing means none: TNI's everywhere. Ids are
//   random, never the agent's initials. The active profile counts only under the initials it was
//   picked with (`activeFor`): changing the initials leaves none active, even if that write fails.
// - chrome.storage.session `agentDefaultsQuote`: { session, choice: 'mine' | 'tni', profile, initials,
//   hash }, this quote's answer to "Fill this quote with <profile>'s defaults?". Asked again for each
//   new quote (usage session); a panel opened again keeps it. "Yes, mine" holds only for the profile,
//   initials and amounts (their defaultsHash) it was given for: a profile switched, edited or deleted
//   since asks again, so nothing fills with amounts the agent didn't approve for this quote.
// - Until the quote's question is answered nothing fills (defaultsHold: fillPage, the automatic
//   fills and the dock wait on it, as on the quote-state hold). Nor while a new intake's quote is
//   being set up (quoteStarting, until refreshDefaults), or while the agent's answer is being saved.
//   An answer Chrome refuses to save is cleared, so the quote is asked again, also after a reopen.
//
// Core panel code reads this file only through the names it exports (marked "agent defaults" where
// they're used). Removing the feature: this folder, those lines, and the TNI defaults section's mount.

import {
  AGENT_DEFAULTS_ON, REGISTRY, amountSaid, defaultsForLog, defaultsHash, effectiveDefaults, isAgentDefault,
  onDefaultsError, setActiveDefaults,
} from '../../../src/agent-defaults/index.js';
import { STANDARD_IDS } from '../../../src/standards.js';
import * as usage from '../../usage-log.js';
import { inExtension } from '../env.js';
import { logCrash, state } from '../core.js';

/** @import { DefaultChoice, DefaultsProfile } from '../../../types.js' */

const KEY = 'agentDefaults';
const QUOTE_KEY = 'agentDefaultsQuote';
const memory = {};
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
  if (!AGENT_DEFAULTS_ON || !initials || !stored?.active || stored.activeFor !== initials) return null;
  return stored.profiles[stored.active] ?? null;
}
// A profile replacing anything: one that only repeats TNI's asks nothing.
const replacesAny = (profile) => !!profile && Object.keys(effectiveDefaults(profile, null)).length > 0;
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
  const [stored, saved, kept] = await Promise.all([local.get(), usage.settings(), session.get()]);
  initials = saved?.agent ?? null;
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
  if (!choice || !AGENT_DEFAULTS_ON) return undefined;
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

function changedSaid(profile) {
  const effective = effectiveDefaults(profile, null);
  return REGISTRY.filter((e) => effective[e.id]).map((e) => {
    const d = effective[e.id];
    return `${e.label}: ${'ask' in d ? 'you answer it' : amountSaid(d.value)} (TNI's: ${amountSaid(STANDARD_IDS[e.id]())})`;
  });
}

function say() {
  const profile = activeProfile();
  const choice = choiceHere();
  let card = null;
  // Switching changes what fills from now on; answers already on the carrier's pages stay as they
  // are (as with any answer the fill engine gave before), so the card says so.
  const after = 'Switching changes what fills next, not answers already on the carrier\'s pages.';
  if (!starting && state.intake && currentSessionId() && replacesAny(profile)) {
    const name = profile.name || 'Your profile';
    const changed = changedSaid(profile);
    if (!choice) {
      card = { tone: 'warn', role: 'alert', title: `Fill this quote with ${name}'s defaults?`, text: `Nothing fills until you answer. ${changed.length} in place of TNI's standards:`, notes: changed, compare: [],
        actions: [{ label: 'Yes, mine', className: 'tinted', onClick: () => onAnswer('mine') }, { label: 'Use TNI\'s', className: 'ghost', onClick: () => onAnswer('tni') }] };
    } else if (choice === 'mine') {
      card = { tone: 'quiet', role: 'status', title: `Defaults: ${name}, ${changed.length} changed`, text: after, notes: changed, compare: [],
        actions: [{ label: 'Use TNI\'s for this quote', className: 'ghost', onClick: () => onAnswer('tni') }] };
    } else {
      card = { tone: 'quiet', role: 'status', title: 'TNI\'s standards for this quote', text: `${name}'s defaults aren't used. ${after}`, notes: [], compare: [],
        actions: [{ label: `Use ${name}'s`, className: 'ghost', onClick: () => onAnswer('mine') }] };
    }
  }
  state.cards = { ...state.cards, defaults: card };
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

// Settings → TNI defaults (view.jsx), as `act.defaults`.
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
  };
}

