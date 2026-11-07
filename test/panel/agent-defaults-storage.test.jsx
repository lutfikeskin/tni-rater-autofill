import { expect, test, vi } from 'vitest';

// Agents' own defaults when Chrome's storage refuses a write (docs/agent-defaults-spec.md, phase 5):
// the panel and the module follow only what was saved. The panel runs here as in the extension, on a
// chrome.storage stub whose writes to the keys in `failing` throw.
const failing = vi.hoisted(() => {
  const keys = new Set();
  const area = () => {
    const data = {};
    return {
      get: async (k) => (k == null ? { ...data } : Object.fromEntries([].concat(k).map((x) => [x, data[x]]))),
      set: async (o) => {
        for (const k of Object.keys(o)) if (keys.has(k)) throw new Error(`write refused: ${k}`);
        Object.assign(data, o);
      },
      remove: async (k) => { for (const x of [].concat(k)) delete data[x]; },
    };
  };
  const noop = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    scripting: {},
    storage: { local: area(), session: area(), onChanged: noop },
    runtime: { id: 'test', getManifest: () => ({ version: '0.0.0' }), sendMessage: async () => {}, onMessage: noop, getURL: (p) => p },
    tabs: { query: async () => [], onActivated: noop, onUpdated: noop, onRemoved: noop },
  };
  return keys;
});

const { state: panelState } = await import('../../sidepanel/panel/core.js');
const usage = await import('../../sidepanel/usage-log.js');
const { answerDefaults, defaultsActs, defaultsHold, initialsChanged, loadDefaults, quoteStarting, refreshDefaults, setDefaultsShown } = await import('../../sidepanel/panel/agent-defaults/store.js');
const { overlayFor } = await import('../../src/agent-defaults/index.js');

test('a write Chrome refuses changes nothing: the quote stays held, and the overlay follows what was saved', async () => {
  await usage.saveSettings({ agent: 'JK' });
  await loadDefaults();
  const acts = defaultsActs();
  await acts.create('Jordan K.');
  await acts.set('medPay', 2_000);
  panelState.intake = { record: {} };
  usage.startSession('intake-1');
  refreshDefaults();
  expect(defaultsHold()).toBe(true);

  // "Yes, mine" can't be saved: the quote is still asked and nothing fills with the defaults.
  failing.add('agentDefaultsQuote');
  await answerDefaults('mine');
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  failing.delete('agentDefaultsQuote');
  await answerDefaults('mine');
  expect(defaultsHold()).toBe(false);
  expect(overlayFor('geico')).toBeTypeOf('function');
  // Switching to TNI's can't be saved either: the earlier "Yes, mine" no longer counts, so the quote is
  // asked again and held, never filled with the defaults the agent tried to stop.
  failing.add('agentDefaultsQuote');
  await answerDefaults('tni');
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  failing.delete('agentDefaultsQuote');
  await answerDefaults('mine');
  expect(overlayFor('geico')).toBeTypeOf('function');

  // An amount that can't be saved: the panel keeps the saved one, and so does the quote.
  failing.add('agentDefaults');
  await acts.set('medPay', 1_000);
  expect(panelState.agentDefaults.profiles[panelState.agentDefaults.active].values).toEqual({ medPay: { value: 2_000 } });
  expect(defaultsHold()).toBe(false);

  // The initials blanked while the profile can't be saved: no defaults fill without initials.
  await initialsChanged(null);
  expect(overlayFor('geico')).toBeNull();
  expect(defaultsHold()).toBe(false);
  failing.clear();
});

// A quote whose answer is being saved, a refused answer after the panel reopens, a new intake being
// set up, and new initials whose profile write failed: none fills with defaults the agent didn't
// approve for that quote under those initials.
test('nothing fills with defaults while the answer saves, after a refused answer and a reopen, while a new quote is set up, or under new initials', async () => {
  failing.clear();
  await usage.saveSettings({ agent: 'JK' });
  await loadDefaults();
  const acts = defaultsActs();
  await acts.create('Sam');
  await acts.set('umCsl', 300_000);
  panelState.intake = { record: {} };
  usage.startSession('intake-2');
  refreshDefaults();
  await answerDefaults('mine');
  expect(overlayFor('geico')).toBeTypeOf('function');

  // While "Use TNI's" is being saved: held, and the defaults no longer fill.
  const saved = answerDefaults('tni');
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  await saved;
  expect(defaultsHold()).toBe(false);
  await answerDefaults('mine');

  // Refused, then the panel reopened: still asked, never the earlier "Yes, mine".
  failing.add('agentDefaultsQuote');
  await answerDefaults('tni');
  failing.delete('agentDefaultsQuote');
  await loadDefaults();
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  await answerDefaults('mine');

  // A new intake loading: held from the moment it is the panel's, with the last quote's answer
  // unused, until the new quote is set up and asks.
  quoteStarting();
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  expect(panelState.cards.defaults).toBeNull();
  usage.startSession('intake-3');
  refreshDefaults();
  expect(defaultsHold()).toBe(true);
  expect(panelState.cards.defaults.title).toBe('Fill this quote with Sam\'s defaults?');
  await answerDefaults('mine');

  // New initials whose profile write fails, then the panel reopened under them: no profile active.
  failing.add('agentDefaults');
  await usage.saveSettings({ agent: 'XY' });
  await initialsChanged('XY');
  failing.delete('agentDefaults');
  await loadDefaults();
  expect(panelState.agentDefaults.active).toBeNull();
  expect(defaultsHold()).toBe(false);
  expect(overlayFor('geico')).toBeNull();
});

// The developer's switch (unpacked copies): a write Chrome refuses changes nothing, so the next panel
// opened doesn't quietly go back; a read Chrome refuses is taken as not hidden and never stops the
// panel's start (review of #305).
test('the developer\'s switch: a refused write changes nothing, a refused read doesn\'t stop the panel', async () => {
  failing.clear();
  await loadDefaults();
  expect(panelState.defaultsOn).toBe(true);
  failing.add('agentDefaultsHidden');
  await setDefaultsShown(false);
  expect(panelState.defaultsOn).toBe(true);
  failing.delete('agentDefaultsHidden');
  await setDefaultsShown(false);
  expect(panelState.defaultsOn).toBe(false);
  await loadDefaults();
  expect(panelState.defaultsOn).toBe(false);
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (k) => {
    if ([].concat(k).includes('agentDefaultsHidden')) throw new Error('read refused');
    return get(k);
  };
  try {
    await loadDefaults();
  } finally {
    chrome.storage.local.get = get;
  }
  expect(panelState.defaultsOn).toBe(true);
  await setDefaultsShown(true);
});
