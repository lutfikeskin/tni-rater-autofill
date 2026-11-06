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
const { answerDefaults, defaultsActs, defaultsHold, initialsChanged, loadDefaults, refreshDefaults } = await import('../../sidepanel/panel/agent-defaults/store.js');
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

  // An amount that can't be saved: the panel keeps the saved one, and so does the quote.
  failing.add('agentDefaults');
  await acts.set('medPay', 1_000);
  expect(panelState.agentDefaults.profiles[panelState.agentDefaults.active].values).toEqual({ medPay: { value: 2_000 } });
  expect(defaultsHold()).toBe(false);

  // The initials blanked while the profile can't be saved: no defaults fill without initials.
  await initialsChanged(null);
  expect(overlayFor('geico')).toBeNull();
  expect(defaultsHold()).toBe(false);
});
