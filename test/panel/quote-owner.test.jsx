import { afterEach, beforeEach, expect, test } from 'vitest';
import { carrierForUrl } from '../../src/carriers.js';
import { state, store } from '../../sidepanel/panel/core.js';
import { fillPage } from '../../sidepanel/panel/fill.js';
import { scheduleAutoFill, showOwnerNote } from '../../sidepanel/panel/coordinator.js';
import { bindQuoteTab, forgetQuoteTab, noteQuoteTab, quoteOwnerIssue, restoreQuoteOwners } from '../../sidepanel/panel/quote-owner.js';

// Audit 2026-11-07 FLOW-03: the agent loads client B while client A's Progressive quote is still open
// in a tab (to email or print it). Every automatic fill (a page as it opens, a follow-up, a held
// fill's resume) must leave A's quote alone; the agent's own Fill this page stays theirs to choose.

const QUOTE = (page) => `https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=${page}`;
const HOME = 'https://www.foragentsonly.com/home/';
const intake = (intakeId) => ({ intakeId, record: { drivers: [], vehicles: [], trailers: [] }, warnings: [], done: [], agentEdited: [] });
const onTab = (id, url) => { state.tab = { id, url, carrier: carrierForUrl(url), background: false, windowId: 1 }; };

beforeEach(() => {
  // What renderSteps writes on outside React.
  document.body.innerHTML = '<button id="pop-out"></button><button id="dock-back"></button><div id="report"></div><div id="past"></div>';
  state.quoteOwners.clear();
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
  // Client A: the agent quotes A on tab 1, which the panel sees on Progressive's quote pages.
  state.intake = intake('A');
  onTab(1, QUOTE('BusinessOwnerInfo'));
  noteQuoteTab(1, QUOTE('BusinessOwnerInfo'));
  expect(quoteOwnerIssue(1)).toBeNull();

  // Client B loaded; the agent goes back to A's tab, which moves to its next page.
  state.intake = intake('B');
  noteQuoteTab(1, QUOTE('AddVehicle'));
  onTab(1, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(1)).toEqual({ owner: 'A', intakeId: 'B' });

  // The page's opening fill (Fill each new page) doesn't start: nothing is filled or clicked.
  const opening = fillPage({ auto: 'page' });
  expect(state.filling).toBe(false);
  await opening;
  expect(state.filling).toBe(false);
  expect(state.cards.owner.title).toBe('This Progressive tab’s quote began with another intake.');
  expect(state.cards.owner.actions.map((a) => a.label)).toEqual(['It’s this client’s quote']);

  // Nor a follow-up on a page the panel filled there.
  state.autoPages.add('AddVehicle');
  scheduleAutoFill('AddVehicle');
  expect(state.autoTimer).toBeNull();

  // A new quote for B on its own tab fills as before.
  noteQuoteTab(2, QUOTE('BusinessOwnerInfo'));
  expect(quoteOwnerIssue(2)).toBeNull();
  onTab(2, QUOTE('BusinessOwnerInfo'));
  showOwnerNote();
  expect(state.cards.owner).toBeNull();
});

test('the agent says the quote is this client\'s, or fills it themselves: it is this intake\'s from then on', () => {
  state.intake = intake('A');
  bindQuoteTab(1);
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

test('a tab back on the carrier\'s pages outside a quote is no one\'s; off the raters it keeps its quote', () => {
  state.intake = intake('A');
  noteQuoteTab(1, QUOTE('AddVehicle'));
  state.intake = intake('B');
  // The agent looks at their email in A's tab, then comes back to A's quote: still A's.
  noteQuoteTab(1, 'https://mail.example.test/inbox');
  noteQuoteTab(1, QUOTE('AddVehicle'));
  expect(quoteOwnerIssue(1)).toEqual({ owner: 'A', intakeId: 'B' });
  // Progressive's home page: the next quote there starts with B.
  noteQuoteTab(1, HOME);
  expect(state.quoteOwners.has(1)).toBe(false);
  noteQuoteTab(1, QUOTE('BusinessOwnerInfo'));
  expect(state.quoteOwners.get(1)).toBe('B');
  // No intake loaded: a quote page binds nothing.
  state.intake = null;
  noteQuoteTab(4, QUOTE('BusinessOwnerInfo'));
  expect(state.quoteOwners.has(4)).toBe(false);
  // A closed tab is forgotten.
  forgetQuoteTab(1);
  expect(state.quoteOwners.size).toBe(0);
});

test('a panel opened again keeps whose quote each tab is (storage.session)', async () => {
  state.intake = intake('A');
  bindQuoteTab(7);
  state.quoteOwners.clear();
  await restoreQuoteOwners();
  expect(state.quoteOwners.get(7)).toBe('A');
  expect(await store.get('quoteOwners')).toEqual({ 7: 'A' });
});
