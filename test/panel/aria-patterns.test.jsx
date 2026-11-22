import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { checkPattern } from '@ui-sdk/core/testing';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Settings } from '../../sidepanel/panel/settings-view.jsx';
import { ClientHead } from '../../sidepanel/panel/client-view.jsx';
import { Checks } from '../../sidepanel/panel/checks-view.jsx';
import { Steps } from '../../sidepanel/panel/steps-view.jsx';
import { Feed } from '../../sidepanel/panel/feed-view.jsx';
import { Review } from '../../sidepanel/panel/review-view.jsx';
import { ReportRows } from '../../sidepanel/panel/report-view.jsx';
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
    client: { name: 'Acme Hauling LLC', title: 'acme.pdf', meta: 'Maryland \u00b7 2 drivers', pdf: true, ask: null }, clientNote: null, newQuoteOff: false, detailsOpen: false,
    checks: null, checksAll: false, steps: null, feed: null,
  });
});
afterEach(cleanup);

// Every other button does nothing here.
const quiet = (more = {}) => new Proxy(more, { get: (acts, name) => acts[name] ?? (() => {}) });

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
  // Checks in both focus mode (open checks > 0) and full-list mode: #details-row stays a disclosure,
  // and neither view-switching link in #steps carries aria-expanded.
  act(() => {
    state.checks = { title: '2 to check on the intake', sub: 's', cleanup: [], later() {}, cards: [
      { i: 0, title: 'USDOT #', msg: 'Missing.', alert: false, lookRight() {}, field: { path: 'applicant.dot', label: 'USDOT #', control: 'input', value: '', maxLength: 200, edit() {} } },
      { i: 1, title: 'State', msg: 'Check state.', alert: false, lookRight() {} },
    ] };
  });
  const checksFocus = render(<><Checks act={quiet({ openDetails: details })} /><div id="details-view" /></>);
  await checkPattern(checksFocus.container.querySelector('#details-row'), 'disclosure');
  expect(checksFocus.container.querySelector('#see-all-checks').getAttribute('aria-expanded')).toBe(null);
  cleanup();
  act(() => { state.checksAll = true; });
  const checksList = render(<><Checks act={quiet({ openDetails: details })} /><div id="details-view" /></>);
  await checkPattern(checksList.container.querySelector('#details-row'), 'disclosure');
  expect(checksList.container.querySelector('#one-check-mode').getAttribute('aria-expanded')).toBe(null);
  cleanup();
  const steps = render(<Steps act={quiet({})} />);
  expect([...steps.container.querySelectorAll('.step')].map((b) => b.getAttribute('aria-expanded'))).toEqual([null, null]);
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

test('Settings checkboxes, #steps tabs, client & filter toolbars, #file-confirm alertdialog, and row disclosures pass APG patterns', async () => {
  // Checkboxes in Settings.
  act(() => {
    state.testRun = { on: false, disabled: false };
    state.captureOff = false;
    state.devrec = { on: false, status: null, unfinished: null };
  });
  const settingsActs = quiet({
    testRun: (on) => act(() => { state.testRun = { ...state.testRun, on }; }),
    captureOff: (on) => act(() => { state.captureOff = on; }),
    devrec: (on) => act(() => { state.devrec = { ...state.devrec, on }; }),
  });
  const settings = render(<Settings act={settingsActs} />);
  for (const box of settings.container.querySelectorAll('input[type="checkbox"]:not([role="switch"])')) {
    await checkPattern(box.closest('label') ?? box, 'checkbox');
  }
  cleanup();

  // #steps view tabs (APG tabs: tablist, tab, tabpanel, ArrowLeft/ArrowRight/Home/End, Enter/Space).
  act(() => {
    state.steps = {
      check: { tone: 'warn', note: '2 to check', open: 2, current: true },
      fill: { tone: '', note: 'Ready to fill', current: false, review: false },
    };
  });
  const tabsView = render(
    <div>
      <div id="steps" role="tablist" aria-label="Intake or this page">
        <Steps act={quiet({
          check: () => act(() => { state.steps = { check: { ...state.steps.check, current: true }, fill: { ...state.steps.fill, current: false } }; }),
          fill: () => act(() => { state.steps = { check: { ...state.steps.check, current: false }, fill: { ...state.steps.fill, current: true } }; }),
        })} />
      </div>
      <section id="check-view" role="tabpanel" aria-labelledby="step-check" />
      <section id="page-view" role="tabpanel" aria-labelledby="step-fill" hidden />
    </div>,
  );
  await checkPattern(tabsView.container, 'tabs');
  cleanup();

  // Client tools (.btn-group) and feed filters (#filters) toolbars (APG toolbar: 1 roving Tab stop + arrows + Home/End).
  const clientView = render(<ClientHead act={quiet()} />);
  await checkPattern(clientView.container.querySelector('.btn-group'), 'toolbar');
  cleanup();

  act(() => {
    state.feed = { shown: true, title: 'Answers on this page', pages: [], pastKey: null, pastWhen: '', report: true, filter: 'all', counts: { all: 3, needs: 1, done: 2 }, empty: null, keyOpen: false, unmark: false, age: null };
  });
  const feedView = render(<Feed act={quiet({ setFilter: (filter) => act(() => { state.feed = { ...state.feed, filter }; }) })} />);
  await checkPattern(feedView.container.querySelector('#filters'), 'toolbar');
  cleanup();

  // File confirmation popover (#file-confirm) as a non-modal APG alertdialog.
  act(() => {
    state.client = { ...state.client, ask: { text: 'Clear Acme?', yes: 'Clear this client' } };
    state.fileConfirmFrom = 'clear-client';
  });
  const confirmView = render(<ClientHead act={quiet({
    cancel: () => act(() => {
      state.client = { ...state.client, ask: null };
      document.getElementById('clear-client')?.focus();
    }),
  })} />);
  await checkPattern(confirmView.container.querySelector('#file-confirm'), 'alertdialog');
  cleanup();

  // Inline Worth a look and Other answers rows in Review and AnswerRow in ReportRows as APG disclosures with aria-controls.
  const rec = { id: 10, type: 'answer', kind: 'standard', label: 'Is non profit', value: 'No', open: false, v: 0, source: { title: 'TNI standard answer', tag: { kind: 'standard', text: 'TNI standard' } } };
  const intakeRec = { id: 11, type: 'answer', kind: 'intake', label: 'DOT number', value: '1234567', open: false, v: 0, source: { title: 'From the intake', tag: { kind: 'intake', text: 'Intake (p. 1)' } } };
  const entry = { key: '1|/Info||Info', step: 'Insured Info', filled: 2, list: [rec, intakeRec], drawn: 0 };
  act(() => { state.reportFor = entry; state.allAnswers = false; state.filling = false; });
  const toggle = (r) => act(() => {
    r.open = !r.open;
    r.v += 1;
    entry.drawn += 1;
    state.rowsDrawn = (state.rowsDrawn ?? 0) + 1;
  });
  const reviewView = render(<Review act={quiet({ toggleWorth: toggle, rowActs: quiet() })} />);
  const worthRow = reviewView.container.querySelector('#review-worth .review-row');
  expect(worthRow.getAttribute('aria-controls')).toBeTruthy();
  await checkPattern(worthRow, 'disclosure');
  const restRow = reviewView.container.querySelector('#review-answers .review-row');
  expect(restRow.getAttribute('aria-controls')).toBeTruthy();
  await checkPattern(restRow, 'disclosure');
  cleanup();

  rec.open = false;
  const rowsView = render(<ReportRows entry={entry} ctx={{}} act={quiet({ toggleRow: toggle })} />);
  const rowHead = rowsView.container.querySelector('.row-head');
  expect(rowHead.getAttribute('aria-controls')).toBeTruthy();
  await checkPattern(rowHead, 'disclosure');
});
