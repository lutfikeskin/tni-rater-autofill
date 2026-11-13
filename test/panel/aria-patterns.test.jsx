import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { checkPattern } from '@ui-sdk/core/testing';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Settings } from '../../sidepanel/panel/settings-view.jsx';
import { ClientHead } from '../../sidepanel/panel/client-view.jsx';
import { Checks } from '../../sidepanel/panel/checks-view.jsx';
import { Feed } from '../../sidepanel/panel/feed-view.jsx';
import { DefaultsChip } from '../../sidepanel/panel/agent-defaults/view.jsx';

// The panel's hand-built controls held to their WAI-ARIA pattern by @ui-sdk/core's checkPattern
// (docs/panel-ui.md, "Checked against their pattern"): roles, names, states, the ids they point at,
// and the keys a keyboard user presses (Space on a switch; Enter and Space on a disclosure, twice,
// to open and close it again). What a button asks the panel is given here as the panel does it
// (each `act` below names the panel's own), so the check covers the view and that wiring.

let state;
beforeEach(() => {
  state = storeState({
    switches: { autoPages: true, autoFollowUps: true, autoAdvance: true, checkBeforeContinue: true, overwrite: false, finishSound: true, turnSound: true },
    ai: { on: true, auto: false, autoShown: true, names: false, note: '', keyEdit: 'Add key' }, keyFormOpen: false, usageCard: null, usageNote: '', health: null,
    testRun: null, captureOff: false, captureStatus: null, devrec: { on: false, status: null, unfinished: null }, recordingLine: false,
    client: { name: 'Acme Hauling LLC', title: 'acme.pdf', meta: 'Maryland · 2 drivers', pdf: true, ask: null }, clientNote: null, newQuoteOff: false, detailsOpen: false,
    feed: null,
  });
});
afterEach(cleanup);

// Every other button does nothing here.
const quiet = (more) => new Proxy(more, { get: (acts, name) => acts[name] ?? (() => {}) });

test('each Filling and assistant switch in Settings is a named switch that Space turns on and off', async () => {
  // The panel's switch act draws what it says at once (settingsActs: state.switches; aiActs: state.ai).
  const acts = quiet({
    switch: (name, on) => act(() => { state.switches = { ...state.switches, [name]: on }; }),
    aiOn: (on) => act(() => { state.ai = { ...state.ai, on }; }),
    aiAuto: (on) => act(() => { state.ai = { ...state.ai, auto: on }; }),
    aiNames: (on) => act(() => { state.ai = { ...state.ai, names: on }; }),
  });
  const { container } = render(<Settings act={acts} />);
  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches.map((s) => s.id)).toEqual(['auto-pages', 'auto-followups', 'auto-advance', 'check-continue', 'overwrite', 'finish-sound', 'turn-sound', 'ai-on', 'ai-auto', 'ai-names']);
  for (const control of switches) await checkPattern(control.closest('label'), 'switch');
});

test('the buttons that open client details, the answer key, the AI key\'s box and your defaults are disclosures', async () => {
  // Client details: the client's name and the checks' All client details row (act.details,
  // act.openDetails: openDetails / closeDetails set state.detailsOpen), and the drawer they name.
  const details = () => act(() => { state.detailsOpen = !state.detailsOpen; });
  const head = render(<><ClientHead act={quiet({ details })} /><div id="details-view" /></>);
  await checkPattern(head.container.querySelector('#client-card'), 'disclosure');
  cleanup();
  const checks = render(<><Checks act={quiet({ openDetails: details })} /><div id="details-view" /></>);
  await checkPattern(checks.container.querySelector('#details-row'), 'disclosure');
  cleanup();
  // The answer key on This page (toggleKey in sidepanel.js flips state.keyOpen; renderSteps says it).
  const feed = { shown: true, title: 'Answers on this page', pages: [], pastKey: null, pastWhen: '', report: true, filter: 'all', counts: { all: 1, needs: 0, done: 1 }, empty: null, keyOpen: false, unmark: false, age: null };
  const page = render(<Feed act={quiet({ toggleKey: () => act(() => { state.feed = { ...state.feed, keyOpen: !state.feed.keyOpen }; }) })} />);
  act(() => { state.feed = feed; });
  await checkPattern(page.container.querySelector('#key-btn'), 'disclosure');
  cleanup();
  // The AI key's box (aiActs keyEdit: openKeyForm(!state.keyFormOpen)).
  const settings = render(<Settings act={quiet({ keyEdit: () => act(() => { state.keyFormOpen = !state.keyFormOpen; }) })} />);
  await checkPattern(settings.container.querySelector('#key-edit'), 'disclosure');
  cleanup();
  // Your defaults' pill and its popover: the view's own state.
  storeState({ defaultsOn: true, defaultsChip: { label: '2 of your own defaults on this quote', text: '2 yours', own: true, title: 'Your defaults', lines: [], after: '', action: { label: 'Use TNI\'s for this quote', onClick() {} } } });
  const chip = render(<DefaultsChip />);
  await checkPattern(chip.container.querySelector('#defaults-chip'), 'disclosure');
});
