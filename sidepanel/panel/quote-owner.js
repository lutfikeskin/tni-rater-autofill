// @ts-check
// The side panel: which intake each quote tab's quote was started with (`state.quoteOwners`: tab id
// -> intake id), kept for the browser session in storage.session (`quoteOwners`). On one of the
// carrier's quote pages, a tab whose quote wasn't started with the intake loaded may be another
// client's (the last client's quote, left open to email or print it, or a quote open before this
// intake was loaded): nothing fills there by itself, never the next client's answers into it
// (automatic fills: fillPage's `auto`, autoFill, scheduleAutoFill). The agent's own Fill this page,
// or "It's this client's quote" on the card (coordinator.js showOwnerNote), makes the tab this
// intake's from then on.
//
// A quote is bound to an intake only by what shows it was started with that intake:
// - a fill with the intake that went through on the tab (bindQuoteTab), or the agent's claim;
// - the tab entering a quote from the carrier's own pages outside one (Progressive's home, GEICO's
//   gateway, AmWINS' Commercial Lines), or opened from such a tab or as a new tab, while the intake
//   is loaded (`state.quoteEntries`: tabs whose next quote starts with the intake loaded when they
//   reach it; noteQuoteTab, noteNewTab). A tab opened from a quote tab shares its quote's owner.
// A tab first seen on a quote page with neither (open before the panel saw it, or before the intake
// was loaded) is no one's, and waits for the agent. Off the raters a tab keeps what it had: the agent
// may come back to the same quote. A carrier's quote page is one its layouts are taken on
// (`layoutUrl`, else `autoFillUrl`; a practice page is all quote).
// One part of the panel; sidepanel.js wires the parts together.
import { carrierForUrl } from '../../src/carriers.js';
import * as usage from '../usage-log.js';
import { state, store } from './core.js';

const KEY = 'quoteOwners';

// The intake loaded now: its id as loadFile gave it (set with the intake itself, before the quote's
// usage session), else the session's (an intake saved before the id was kept with it).
/** @returns {string | null} */
function currentIntake() {
  if (!state.intake) return null;
  return state.intake.intakeId ?? usage.currentSession()?.intakeId ?? null;
}

function persist() {
  const saved = { owners: Object.fromEntries(state.quoteOwners), entries: [...state.quoteEntries] };
  Promise.resolve(store.set(KEY, saved)).catch(() => {});
}

// What an earlier panel kept (a panel opened again or popped out): read before the panel follows any
// tab. What the panel learned meanwhile stays.
async function restoreQuoteOwners() {
  const saved = await Promise.resolve(store.get(KEY)).catch(() => null);
  for (const [tabId, intakeId] of Object.entries(saved?.owners ?? {})) {
    const id = Number(tabId);
    if (Number.isInteger(id) && typeof intakeId === 'string' && !state.quoteOwners.has(id) && !state.quoteEntries.has(id)) state.quoteOwners.set(id, intakeId);
  }
  for (const id of saved?.entries ?? []) {
    if (Number.isInteger(id) && !state.quoteOwners.has(id)) state.quoteEntries.add(id);
  }
}

// Whether the address is one of a carrier's quote pages (null: not a rater's).
/** @param {string | undefined} url @returns {boolean | null} */
function quotePage(url) {
  const carrier = url ? carrierForUrl(url) : null;
  if (!carrier) return null;
  const pages = carrier.layoutUrl ?? carrier.autoFillUrl;
  return !pages || pages.test(url);
}

// A tab's address, as Chrome says it (tabs.onUpdated) or as the panel finds the tab (refreshTab).
/** @param {number | undefined} tabId @param {string | undefined} url */
function noteQuoteTab(tabId, url) {
  if (!Number.isInteger(tabId) || !url) return;
  const quote = quotePage(url);
  if (quote == null) return;
  if (!quote) {
    // On the carrier's pages outside a quote: the next quote here starts with the intake then loaded.
    if (state.quoteEntries.has(tabId) && !state.quoteOwners.has(tabId)) return;
    state.quoteOwners.delete(tabId);
    state.quoteEntries.add(tabId);
    persist();
    return;
  }
  if (!state.quoteEntries.has(tabId)) return;
  // Into a quote from there: it was started with the intake loaded now (none: no one's).
  state.quoteEntries.delete(tabId);
  const intakeId = currentIntake();
  if (intakeId) state.quoteOwners.set(tabId, intakeId);
  persist();
}

// A tab opened while the panel is open (tabs.onCreated). One a quote tab opened shares its quote's
// owner (a print or proposal page of the same quote); one opened from the carrier's pages outside a
// quote (Progressive's home opens the quote in a new tab), or a new tab on no quote page yet, starts
// its quote with the intake loaded when it gets there. A tab opened on a quote page by itself (a
// closed tab restored) is no one's.
/** @param {{ id?: number, openerTabId?: number, url?: string, pendingUrl?: string } | undefined} tab */
function noteNewTab(tab) {
  const id = tab?.id;
  if (!Number.isInteger(id) || state.quoteOwners.has(id) || state.quoteEntries.has(id)) return;
  const opener = tab.openerTabId;
  const owner = Number.isInteger(opener) ? state.quoteOwners.get(opener) : undefined;
  if (owner) state.quoteOwners.set(id, owner);
  else if ((Number.isInteger(opener) && state.quoteEntries.has(opener)) || !quotePage(tab.pendingUrl || tab.url)) state.quoteEntries.add(id);
  else return;
  persist();
}

// Another intake is about to be loaded: a tab still waiting to enter a quote that is on a quote page
// already (it moved while the panel was closed) entered it before this intake: no one's.
/** @param {(id: number) => Promise<string | undefined>} urlOf  the tab's address now */
async function settleQuoteEntries(urlOf) {
  let changed = false;
  for (const id of [...state.quoteEntries]) {
    const url = await urlOf(id).catch(() => undefined);
    if (url === undefined || quotePage(url)) { state.quoteEntries.delete(id); changed = true; }
  }
  if (changed) persist();
}

// A fill with this intake went through on the tab (the agent's, or an automatic one on a tab that is
// already this intake's), or the agent said the tab's quote is this client's.
/** @param {number} tabId @param {string | null} [intakeId] */
function bindQuoteTab(tabId, intakeId = currentIntake()) {
  if (!Number.isInteger(tabId) || !intakeId || state.quoteOwners.get(tabId) === intakeId) return;
  state.quoteOwners.set(tabId, intakeId);
  state.quoteEntries.delete(tabId);
  persist();
}

/** @param {number} tabId */
function forgetQuoteTab(tabId) {
  state.portalTabs.delete(tabId);
  const owned = state.quoteOwners.delete(tabId);
  const entering = state.quoteEntries.delete(tabId);
  if (owned || entering) persist();
}

// The tab's quote wasn't started with the intake loaded: { owner (null: no one's), intakeId }, or
// null. Only on a carrier's quote page (the tab in front's address; another tab's is taken as one).
/** @param {number | undefined} [tabId] @returns {{ owner: string | null, intakeId: string } | null} */
function quoteOwnerIssue(tabId = state.tab?.id) {
  const intakeId = currentIntake();
  if (!Number.isInteger(tabId) || !intakeId) return null;
  if (tabId === state.tab?.id && !quotePage(state.tab?.url)) return null;
  const owner = state.quoteOwners.get(tabId) ?? null;
  return owner === intakeId ? null : { owner, intakeId };
}

// A rater's logo on the "open a rater" card opens its agent home page in a new tab (the carrier's
// `display.portalUrl`): a page the agent asked to see, not a fill. AmWINS' is Commercial Lines, where
// a fill picks the risk state and opens a new application, so nothing fills on that tab by itself
// (automatic fills: fillPage's `auto`, autoFill, scheduleAutoFill) until it reaches a quote page
// other than the one opened (the agent opened the application themselves), or the agent fills it
// (fillPage, not automatic). A sign-in on the way there keeps it held. Kept while the panel is open.
/** @param {string} url */
const placeOf = (url) => {
  try { const u = new URL(url); return `${u.host}${u.pathname}`.toLowerCase().replace(/\/$/, ''); } catch { return null; }
};
/** @param {string} url */
async function openPortal(url) {
  if (!url) return;
  const tab = await chrome.tabs.create({ url });
  if (Number.isInteger(tab?.id)) state.portalTabs.set(tab.id, placeOf(url));
}
// Whether automatic fills wait on the tab (the tab in front's address; another tab's stays held).
/** @param {number | undefined} [tabId] */
function portalHold(tabId = state.tab?.id) {
  const opened = state.portalTabs.get(tabId);
  if (opened === undefined) return false;
  const url = tabId === state.tab?.id ? state.tab?.url : null;
  if (url && quotePage(url) && placeOf(url) !== opened) { state.portalTabs.delete(tabId); return false; }
  return true;
}
// The agent's own fill on the tab: it is theirs to fill from then on.
/** @param {number | undefined} tabId */
function releasePortal(tabId) { state.portalTabs.delete(tabId); }

export { bindQuoteTab, forgetQuoteTab, noteNewTab, noteQuoteTab, openPortal, portalHold, quoteOwnerIssue, releasePortal, restoreQuoteOwners, settleQuoteEntries };
