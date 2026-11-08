import { afterEach, beforeEach, expect, test } from 'vitest';
import { carrierForUrl } from '../../src/carriers.js';
import { state, store } from '../../sidepanel/panel/core.js';
import { fillPage } from '../../sidepanel/panel/fill.js';
import { scheduleAutoFill, showOwnerNote } from '../../sidepanel/panel/coordinator.js';
import { bindQuoteTab, forgetQuoteTab, noteNewTab, noteQuoteTab, openPortal, portalHold, quoteOwnerIssue, restoreQuoteOwners, settleQuoteEntries } from '../../sidepanel/panel/quote-owner.js';

// Audit 2026-11-07 FLOW-03: the agent loads client B while client A's Progressive quote is still open
// in a tab (to email or print it). Every automatic fill (a page as it opens, a follow-up, a held
// fill's resume) must leave A's quote alone; the agent's own Fill this page stays theirs to choose.
// Only a quote the loaded intake started is filled by itself.

const QUOTE = (page) => `https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=${page}`;
const HOME = 'https://www.foragentsonly.com/home/';
const intake = (intakeId) => ({ intakeId, record: { drivers: [], vehicles: [], trailers: [] }, warnings: [], done: [], agentEdited: [] });
const onTab = (id, url) => { state.tab = { id, url, carrier: carrierForUrl(url), background: false, windowId: 1 }; };
// A quote the intake loaded now starts on the tab: from Progressive's home page into the quote.
const startQuote = (id) => { noteQuoteTab(id, HOME); noteQuoteTab(id, QUOTE('BusinessOwnerInfo')); };

// Nothing fills by itself on the tab in front: the opening fill and a follow-up don't start.
async function heldThere(page) {
  const opening = fillPage({ auto: 'page' });
  expect(state.filling).toBe(false);
  await opening;
  expect(state.filling).toBe(false);
  state.autoPages.add(page);
  scheduleAutoFill(page);
  expect(state.autoTimer).toBeNull();
  // And the hold stays: neither attempt made the tab this intake's.
  expect(quoteOwnerIssue()).not.toBeNull();
}

beforeEach(() => {
  // What renderSteps writes on outside React.
  document.body.innerHTML = '<button id="pop-out"></button><button id="dock-back"></button><div id="report"></div><div id="past"></div>';
  state.quoteOwners.clear();
  state.quoteEntries.clear();
  state.cards = {};
  state.filling = false;
  state.autoPaused = false;
  state.autoTimer = null;
  state.autoPages = new Set();
  state.reports = new Map();
  state.switches = { ...state.switches, autoPages: true, autoFollowUps: true };
});
afterEach(() => {
  clearTimeout(state.autoTimer);
  state.intake = null;
  state.tab = null;
});

test('the next client\'s answers never fill the last client\'s open quote by themselves', async () => {
  // Client A: the agent starts A's quote on tab 1.
  state.intake = intake('A');
  startQuote(1);
  expect(state.quoteOwners.get(1)).toBe('A');

  // Client B loaded; the agent goes back to A's tab, which moves to its next page.
  state.intake = intake('B');
  noteQuoteTab(1, QUOTE('AddVehicle'));
  onTab(1, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(1)).toEqual({ owner: 'A', intakeId: 'B' });
  await heldThere('AddVehicle');
  expect(state.cards.owner.title).toBe('Is this Progressive quote this client’s?');
  expect(state.cards.owner.text).toMatch(/^This tab’s quote was started with another intake\. It may be another client’s quote\. Nothing fills here by itself/);
  expect(state.cards.owner.actions.map((a) => a.label)).toEqual(['It’s this client’s quote']);

  // B's own quote, started on tab 2, fills as before.
  startQuote(2);
  expect(quoteOwnerIssue(2)).toBeNull();
  onTab(2, QUOTE('BusinessOwnerInfo'));
  showOwnerNote();
  expect(state.cards.owner).toBeNull();
});

// Claude's review on #356: A's quote tab no fill with A ever went through on (started in the
// background, or every fill stopped), first seen once B is loaded, was taken as B's.
test('a quote first seen mid-quote, never started with this intake, waits for the agent', async () => {
  state.intake = intake('A');
  state.intake = intake('B');
  // The agent switches to that tab: the panel finds it on a quote page (refreshTab).
  onTab(5, QUOTE('AddDriver'));
  noteQuoteTab(5, QUOTE('AddDriver'));
  expect(state.quoteOwners.has(5)).toBe(false);
  expect(quoteOwnerIssue(5)).toEqual({ owner: null, intakeId: 'B' });
  await heldThere('AddDriver');
  expect(state.cards.owner.text).toMatch(/^This tab’s quote was open before this intake was loaded\./);
  // Its next page is still no one's.
  noteQuoteTab(5, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(5)).toEqual({ owner: null, intakeId: 'B' });
  // A quote started before any intake was loaded (the tab went into it with none) is no one's too.
  state.intake = null;
  startQuote(6);
  state.intake = intake('B');
  expect(quoteOwnerIssue(6)).toEqual({ owner: null, intakeId: 'B' });
});

test('the agent says the quote is this client\'s, or fills it themselves: it is this intake\'s from then on', () => {
  state.intake = intake('B');
  onTab(1, QUOTE('AddVehicle'));
  showOwnerNote();
  expect(state.cards.owner).not.toBeNull();
  // "It's this client's quote" (a corrected PDF of the same client is another intake).
  state.cards.owner.actions[0].onClick();
  expect(quoteOwnerIssue(1)).toBeNull();
  expect(state.cards.owner).toBeNull();
  // The agent's own Fill this page binds the tab the same way once it goes through (fillPage, autoFill).
  bindQuoteTab(3, 'A');
  bindQuoteTab(3, 'B');
  expect(state.quoteOwners.get(3)).toBe('B');
});

test('a carrier\'s pages outside a quote are no one\'s and wait for the next quote; off the raters a tab keeps its quote', () => {
  state.intake = intake('A');
  startQuote(1);
  state.intake = intake('B');
  // The agent looks at their email in A's tab, then comes back to A's quote: still A's.
  noteQuoteTab(1, 'https://mail.example.test/inbox');
  noteQuoteTab(1, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(1)).toEqual({ owner: 'A', intakeId: 'B' });
  // Progressive's home page: nothing to hold there, and the next quote from it starts with B.
  noteQuoteTab(1, HOME);
  onTab(1, HOME);
  expect(state.quoteOwners.has(1)).toBe(false);
  expect(quoteOwnerIssue(1)).toBeNull();
  noteQuoteTab(1, QUOTE('BusinessOwnerInfo'));
  expect(state.quoteOwners.get(1)).toBe('B');
  // A closed tab is forgotten.
  forgetQuoteTab(1);
  expect(state.quoteOwners.size).toBe(0);
});

test('a new tab: from the home page or blank it starts its quote with the intake, from a quote tab it shares that quote, restored on a quote it is no one\'s', () => {
  state.intake = intake('A');
  startQuote(1);
  noteQuoteTab(2, HOME);
  state.intake = intake('B');
  // Progressive's home page opens the quote in a new tab.
  noteNewTab({ id: 3, openerTabId: 2, pendingUrl: QUOTE('BusinessOwnerInfo') });
  noteQuoteTab(3, QUOTE('BusinessOwnerInfo'));
  expect(state.quoteOwners.get(3)).toBe('B');
  // A tab A's quote opens (its proposal) is A's quote's.
  noteNewTab({ id: 4, openerTabId: 1, pendingUrl: QUOTE('Print') });
  expect(state.quoteOwners.get(4)).toBe('A');
  // A new blank tab the agent opens and starts a quote in.
  noteNewTab({ id: 7, url: 'chrome://newtab/' });
  noteQuoteTab(7, QUOTE('BusinessOwnerInfo'));
  expect(state.quoteOwners.get(7)).toBe('B');
  // A closed tab restored on a quote page.
  noteNewTab({ id: 8, pendingUrl: QUOTE('AddVehicle') });
  noteQuoteTab(8, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(8)).toEqual({ owner: null, intakeId: 'B' });
});

test('loading an intake: a tab that went into a quote while the panel was closed did so before it', async () => {
  noteQuoteTab(1, HOME);
  noteQuoteTab(2, HOME);
  noteQuoteTab(3, HOME);
  const now = { 1: QUOTE('AddVehicle'), 2: HOME };
  await settleQuoteEntries(async (id) => now[id]);
  expect([...state.quoteEntries]).toEqual([2]);
  state.intake = intake('B');
  noteQuoteTab(1, QUOTE('AddDriver'));
  expect(quoteOwnerIssue(1)).toEqual({ owner: null, intakeId: 'B' });
});

test('a panel opened again keeps whose quote each tab is (storage.session)', async () => {
  state.intake = intake('A');
  bindQuoteTab(7);
  noteQuoteTab(9, HOME);
  state.quoteOwners.clear();
  state.quoteEntries.clear();
  await restoreQuoteOwners();
  expect(state.quoteOwners.get(7)).toBe('A');
  expect([...state.quoteEntries]).toEqual([9]);
  expect(await store.get('quoteOwners')).toEqual({ owners: { 7: 'A' }, entries: [9] });
});

// Review of #468 (CodeRabbit): a rater's logo opens its agent home page, and AmWINS' is Commercial
// Lines, where a fill picks the risk state and clicks Open new application. A logo is a page the
// agent asked to see: nothing fills there by itself until the agent opens the application, or fills.
test('a tab a rater\'s logo opened fills nothing by itself until the agent opens a quote there, or fills it', async () => {
  const LINES = 'https://myagency.amwinsadmittedplacement.com/commerciallines';
  const APPLICATION = 'https://myagency.amwinsadmittedplacement.com/application/businessauto/123/insured';
  const created = [];
  const chromeBefore = globalThis.chrome;
  globalThis.chrome = { ...chromeBefore, tabs: { ...chromeBefore?.tabs, create: async ({ url }) => { created.push(url); return { id: 9, url }; } } };
  try {
    state.intake = intake('B');
    await openPortal(LINES);
    expect(created).toEqual([LINES]);
    noteNewTab({ id: 9, url: '' });
    onTab(9, LINES);
    expect(portalHold()).toBe(true);
    // A sign-in on the way there keeps it held.
    onTab(9, 'https://login.amwinsadmittedplacement.com/signin');
    expect(portalHold()).toBe(true);
    onTab(9, LINES);
    const opening = fillPage({ auto: 'page' });
    expect(state.filling).toBe(false);
    await opening;
    state.autoPages.add('/commerciallines');
    scheduleAutoFill('/commerciallines');
    expect(state.autoTimer).toBeNull();
    // The agent opened the application themselves: their quote, filled by itself from then on.
    noteQuoteTab(9, APPLICATION);
    onTab(9, APPLICATION);
    expect(portalHold()).toBe(false);
    expect(state.portalTabs.has(9)).toBe(false);
    // A tab closed forgets it.
    await openPortal(LINES);
    forgetQuoteTab(9);
    expect(state.portalTabs.has(9)).toBe(false);
  } finally {
    globalThis.chrome = chromeBefore;
    state.portalTabs.clear();
  }
});
