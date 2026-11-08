import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// "What's new in vX" in the panel (audit 2026-11-07, UX-12 c): said once per version, from the lines
// src/whats-new.js keeps, with Got it; a version already said, or with nothing new, says nothing.
const env = vi.hoisted(() => {
  const data = {};
  const noop = { addListener() {}, removeListener() {} };
  const env = { version: '0.9.40', data };
  globalThis.chrome = {
    scripting: {},
    storage: {
      local: { get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, data[x]])), set: async (o) => { Object.assign(data, o); }, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: noop,
    },
    runtime: { id: 'test', getManifest: () => ({ version: env.version }), sendMessage: async () => {}, onMessage: noop, getURL: (p) => p },
    tabs: { query: async () => [], onActivated: noop, onUpdated: noop, onRemoved: noop },
  };
  return env;
});
vi.mock('../../src/whats-new.js', async (orig) => {
  const real = await orig();
  const notes = { '0.9.38': ['Older line.'], '0.9.40': ['Logos open the rater.', 'Quote summary.'] };
  return { ...real, WHATS_NEW: notes, whatsNewSince: (seen, v) => real.whatsNewSince(seen, v, notes) };
});

const { state } = await import('../../sidepanel/panel/core.js');
const { showWhatsNew } = await import('../../sidepanel/panel/whats-new.js');
const { Note } = await import('../../sidepanel/panel/notes-view.jsx');

beforeEach(() => { for (const k of Object.keys(env.data)) delete env.data[k]; state.notes = { ...state.notes, whatsNew: null }; });
afterEach(() => { cleanup(); document.body.replaceChildren(); });

const said = (node) => [node.querySelector('.issue-title').textContent, ...[...node.querySelectorAll('.small-note')].map((n) => n.textContent)];

test("after an update the card says what's new since the version last said, once, until Got it", async () => {
  env.data.whatsNewSeen = '0.9.37';
  const { container } = render(<div id="whats-new"><Note name="whatsNew" /></div>);
  await act(() => showWhatsNew());
  const card = container.querySelector('.issue.info');
  expect(said(card)).toEqual(["What's new in v0.9.40", 'Logos open the rater.', 'Quote summary.', 'In v0.9.38:', 'Older line.']);
  expect(env.data.whatsNewSeen).toBe('0.9.40');
  act(() => card.querySelector('button').click());
  expect(container.querySelector('.issue')).toBeNull();
  // Opened again: already said.
  await act(() => showWhatsNew());
  expect(container.querySelector('.issue')).toBeNull();
});

test('an update from before the card says this version only; a new install, or nothing new, says nothing', async () => {
  const { container } = render(<div id="whats-new"><Note name="whatsNew" /></div>);
  await act(() => showWhatsNew());
  expect(said(container.querySelector('.issue'))).toEqual(["What's new in v0.9.40", 'Logos open the rater.', 'Quote summary.']);
  act(() => { state.notes = { ...state.notes, whatsNew: null }; });

  // A new install: background.js started it from the version installed.
  env.data.whatsNewSeen = '0.9.40';
  await act(() => showWhatsNew());
  expect(container.querySelector('.issue')).toBeNull();

  // A version with no lines is marked said without a card.
  env.version = '0.9.41';
  await act(() => showWhatsNew());
  expect(container.querySelector('.issue')).toBeNull();
  expect(env.data.whatsNewSeen).toBe('0.9.41');
  env.version = '0.9.40';
});
