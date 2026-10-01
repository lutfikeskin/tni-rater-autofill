import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SIDEPANEL = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');

// Keep these tests coupled to the production functions.  The side panel is an ES module with
// browser-only imports, so extract only the functions under test and evaluate those functions in
// a small VM harness instead of copying their implementation into a test helper.
function extractFunction(name) {
  const match = SIDEPANEL.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(match, `could not find ${name} in sidepanel/sidepanel.js`);
  const start = match.index;
  const open = SIDEPANEL.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < SIDEPANEL.length; i += 1) {
    const ch = SIDEPANEL[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (!depth) return SIDEPANEL.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const HELPERS_START = SIDEPANEL.indexOf('const samePage =');
const HELPERS_END = SIDEPANEL.indexOf('\n\n// Watch the rater tab', HELPERS_START);
const PAGE_HELPERS = SIDEPANEL.slice(HELPERS_START, HELPERS_END);
const FUNCTIONS = ['rememberFill', 'scheduleAutoFill', 'refreshTab'].map(extractFunction).join('\n');

function harness() {
  const state = {
    tab: null,
    filled: new Map(),
    labels: new Map(),
    autoPages: new Set(),
    tabSessions: new Map(),
    agentKeys: new Map(),
    filling: false,
    autoTimer: null,
    autoPending: false,
    autoPaused: false,
    doneActions: new Set(),
    visitedPages: new Set(),
  };
  const ui = { 'auto-followups': { checked: true } };
  const scheduled = [];
  const cleared = [];
  const rendered = [];
  let timerId = 0;
  let activeTab = null;

  const context = {
    URL,
    state,
    inExtension: true,
    $: (id) => ui[id],
    onQuotePage: () => true,
    setTimeout: (fn, ms) => {
      const handle = { id: ++timerId };
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => cleared.push(handle),
    renderSite: () => rendered.push(state.tab?.id ?? null),
    ensureRecorder: async () => {},
    carrierForUrl: () => ({ id: 'progressive', practice: false }),
    chrome: {
      scripting: {},
      tabs: { query: async () => [activeTab] },
    },
  };
  vm.runInNewContext(`${PAGE_HELPERS}\n${FUNCTIONS}`, context, { filename: 'sidepanel/sidepanel.js' });

  return {
    state,
    ui,
    scheduled,
    cleared,
    rendered,
    refreshTab: context.refreshTab,
    rememberFill: context.rememberFill,
    scheduleAutoFill: context.scheduleAutoFill,
    setActiveTab(tab) { activeTab = tab; },
  };
}

const quoteTab = (id, page = 'AddVehicle') => ({
  id,
  url: `https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=${page}`,
});

test('a halted fill persists the pause, clears pending work, and protects keys', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.state.agentKeys.set('AddVehicle', new Set(['agent-edited']));
  h.state.autoTimer = { id: 'pending-followup' };
  h.state.autoPending = true;

  h.rememberFill([{
    fields: 2,
    halted: true,
    reason: 'Unknown relevant question',
    protectedKeys: ['newly-revealed'],
    filled: [],
    actions: [],
  }]);

  assert.equal(h.state.autoPaused, true);
  assert.equal(h.state.autoPending, false);
  assert.deepEqual([...h.state.agentKeys.get('AddVehicle')].sort(), ['agent-edited', 'newly-revealed']);
  assert.deepEqual(h.cleared, [{ id: 'pending-followup' }]);

  h.scheduleAutoFill('AddVehicle');
  assert.equal(h.scheduled.length, 0, 'a paused session must not schedule another follow-up');
});

test('invalidated actions are removed before newly successful actions are recorded', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.state.doneActions = new Set(['stale-lookup', 'keep-me']);

  h.rememberFill([{
    fields: 1,
    filled: [],
    invalidatedActions: ['stale-lookup'],
    actions: [{ id: 'fresh-lookup' }],
  }]);

  assert.deepEqual([...h.state.doneActions].sort(), ['fresh-lookup', 'keep-me']);
});

test('switching tabs stores and restores agent keys and the persistent pause', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'BusinessOwnerInfo'), carrier: { id: 'progressive' } };
  h.state.agentKeys = new Map([['BusinessOwnerInfo', new Set(['agent-key'])]]);
  h.state.autoPaused = true;
  h.state.autoPending = true;

  h.setActiveTab(quoteTab(2));
  await h.refreshTab();

  assert.equal(h.state.tab.id, 2);
  assert.equal(h.state.autoPaused, false, 'a newly visited tab starts unpaused');
  assert.equal(h.state.agentKeys.size, 0);
  assert.ok(h.state.tabSessions.has(1));
  assert.equal(h.state.tabSessions.get(1).autoPaused, true);
  assert.equal(h.state.tabSessions.get(1).agentKeys.get('BusinessOwnerInfo').has('agent-key'), true);

  const secondTabKeys = h.state.agentKeys;
  h.state.agentKeys.set('AddVehicle', new Set(['second-tab-key']));
  h.state.autoPaused = true;
  h.setActiveTab(quoteTab(1, 'BusinessOwnerInfo'));
  await h.refreshTab();

  assert.equal(h.state.tab.id, 1);
  assert.equal(h.state.autoPaused, true);
  assert.notEqual(h.state.agentKeys, secondTabKeys);
  assert.deepEqual([...h.state.agentKeys.get('BusinessOwnerInfo')], ['agent-key']);
  assert.equal(h.state.agentKeys.has('AddVehicle'), false);
});


test('fill report omits absent sections without rendering null text', () => {
  const box = { className: '', children: [], replaceChildren(...children) { this.children = children; } };
  const context = {
    $: () => box,
    state: { tab: { id: 1, url: 'https://example.test/?pageName=AddVehicle' } },
    pageOf: () => 'AddVehicle',
    h: (tag, props, ...children) => ({ tag, props, children }),
  };
  vm.runInNewContext(extractFunction('renderReport'), context);
  context.renderReport([{ fields: 1, filled: [{ label: 'Zip Code', shown: '21000' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] }]);
  assert.ok(box.children.length > 0);
  assert.ok(box.children.every((child) => child != null && child !== false), 'DOM replaceChildren must receive only actual report nodes');
});

test('ignore button skips only the chosen field on the current page and resumes filling', async () => {
  const state = { tab: { id: 1, url: 'Rates' }, agentKeys: new Map(), filling: false, autoPaused: true };
  const calls = [];
  const context = { state, pageOf: (url) => url, fillPage: async () => calls.push([...state.agentKeys.get('Rates')]) };
  vm.runInNewContext(extractFunction('ignoreReview'), context);
  await context.ignoreReview('200F', 1, 'Rates');
  assert.deepEqual(calls, [['200F']]);
  await context.ignoreReview('other', 2, 'Rates');
  await context.ignoreReview('other', 1, 'OldPage');
  state.filling = true;
  await context.ignoreReview('other', 1, 'Rates');
  assert.equal(calls.length, 1);
  assert.deepEqual([...state.agentKeys.get('Rates')], ['200F']);
});

test('warning rows render accessible dismiss buttons bound to their field and page', () => {
  const box = { replaceChildren(...children) { this.children = children; } };
  const clicks = [];
  const context = {
    $: () => box,
    state: { tab: { id: 7, url: 'Rates' } }, pageOf: (url) => url,
    h: (tag, props, ...children) => ({ tag, props, children }),
    ignoreReview: (...args) => clicks.push(args),
  };
  vm.runInNewContext(extractFunction('renderReport'), context);
  context.renderReport([{ fields: 3, halted: true, unknown: [{ key: '200F', label: 'Vehicle field' }], failed: [{ key: 'failed', label: 'Rejected', reason: 'invalid' }], noData: [{ key: 'missing', label: 'Missing' }] }]);
  const buttons = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button') buttons.push(node);
    visit(node.children);
  };
  visit(box.children);
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => button.props['aria-label'].includes('Ignore')));
  buttons.forEach((button) => button.props.onclick());
  assert.deepEqual(clicks, [['200F', 7, 'Rates'], ['failed', 7, 'Rates'], ['missing', 7, 'Rates']]);
});

test('warning-only automatic follow-ups render and log unfamiliar fields without pausing', async () => {
  const frames = [{ fields: 1, filled: [], actions: [], unknown: [{ key: 'new', label: 'New question' }], halted: false }];
  const logged = [], rendered = [], layouts = [];
  const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), autoPaused: false, filling: false };
  const context = {
    state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
    runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {},
    renderReport: (result) => rendered.push(result), recordLayout: (page) => layouts.push(page),
    fillEvents: () => [{ type: 'fill_field', result: 'unfamiliar' }],
    redactionTerms: () => [], redactor: () => (s) => s, usage: { log: (...events) => logged.push(...events) },
  };
  vm.runInNewContext(extractFunction('autoFill'), context);
  await context.autoFill('Rates');
  assert.equal(state.autoPaused, false);
  assert.equal(state.filling, false);
  assert.equal(rendered.length, 1);
  assert.equal(logged[0].result, 'unfamiliar');
  assert.deepEqual(layouts, ['Rates']);
});
