// @ts-check
// The side panel: which intake each quote tab's quote began with (`state.quoteOwners`: tab id ->
// intake id, kept for the browser session in storage.session, `quoteOwners`). A tab whose quote
// began with another intake may be the last client's quote, left open when the agent loads the next
// one (to email or print it): nothing fills there by itself, never the next client's answers into
// it (automatic fills: fillPage's `auto`, autoFill, scheduleAutoFill). The agent's own Fill this
// page, or "It's this client's quote" on the card (coordinator.js showOwnerNote), makes the tab this
// intake's from then on.
//
// A tab is this intake's quote once a fill with this intake goes through there (bindQuoteTab), or
// when the panel first sees it on one of the carrier's quote pages with this intake loaded while it
// is no intake's yet (noteQuoteTab: a quote started for this client, or one open before any intake).
// Back on the carrier's own pages outside a quote (Progressive's home, GEICO's gateway, AmWINS'
// Commercial Lines), it is no one's: the quote it opens next starts with the intake then loaded.
// One of the carrier's quote pages is one its layouts are taken on (`layoutUrl`, else `autoFillUrl`).
// One part of the panel; sidepanel.js wires the parts together.
import { carrierForUrl } from '../../src/carriers.js';
import * as usage from '../usage-log.js';
import { state, store } from './core.js';
/** @import { CarrierConfig } from '../../types.js' */

const KEY = 'quoteOwners';

// The intake loaded now: its id as loadFile gave it (set with the intake itself, before the quote's
// usage session), else the session's (an intake saved before the id was kept with it).
/** @returns {string | null} */
function currentIntake() {
  if (!state.intake) return null;
  return state.intake.intakeId ?? usage.currentSession()?.intakeId ?? null;
}

function persist() {
  Promise.resolve(store.set(KEY, Object.fromEntries(state.quoteOwners))).catch(() => {});
}

// The tabs' owners as an earlier panel kept them (a panel opened again or popped out): read before
// the panel follows any tab. One the panel learned meanwhile stays.
async function restoreQuoteOwners() {
  const saved = await Promise.resolve(store.get(KEY)).catch(() => null);
  for (const [tabId, intakeId] of Object.entries(saved ?? {})) {
    const id = Number(tabId);
    if (Number.isInteger(id) && typeof intakeId === 'string' && !state.quoteOwners.has(id)) state.quoteOwners.set(id, intakeId);
  }
}

/** @param {CarrierConfig} carrier @param {string} url */
function onQuotePageOf(carrier, url) {
  const pages = carrier.layoutUrl ?? carrier.autoFillUrl;
  return !pages || pages.test(url);
}

// A tab's address, as Chrome says it (tabs.onUpdated) or as the panel finds the tab (refreshTab). Off
// the raters nothing changes: the agent may come back to the same quote.
/** @param {number | undefined} tabId @param {string | undefined} url */
function noteQuoteTab(tabId, url) {
  if (!Number.isInteger(tabId) || !url) return;
  const carrier = carrierForUrl(url);
  if (!carrier) return;
  if (!onQuotePageOf(carrier, url)) {
    if (state.quoteOwners.delete(tabId)) persist();
    return;
  }
  const intakeId = currentIntake();
  if (intakeId && !state.quoteOwners.has(tabId)) bindQuoteTab(tabId, intakeId);
}

// A fill with this intake went through on the tab (the agent's, or an automatic one on a tab that is
// already this intake's), or the agent said the tab's quote is this client's.
/** @param {number} tabId @param {string | null} [intakeId] */
function bindQuoteTab(tabId, intakeId = currentIntake()) {
  if (!Number.isInteger(tabId) || !intakeId || state.quoteOwners.get(tabId) === intakeId) return;
  state.quoteOwners.set(tabId, intakeId);
  persist();
}

/** @param {number} tabId */
function forgetQuoteTab(tabId) {
  if (state.quoteOwners.delete(tabId)) persist();
}

// The tab's quote began with another intake than the one loaded: { owner, intakeId }, or null.
/** @param {number | undefined} [tabId] @returns {{ owner: string, intakeId: string } | null} */
function quoteOwnerIssue(tabId = state.tab?.id) {
  if (!Number.isInteger(tabId)) return null;
  const owner = state.quoteOwners.get(tabId);
  const intakeId = currentIntake();
  return owner && intakeId && owner !== intakeId ? { owner, intakeId } : null;
}

export { bindQuoteTab, forgetQuoteTab, noteQuoteTab, quoteOwnerIssue, restoreQuoteOwners };
