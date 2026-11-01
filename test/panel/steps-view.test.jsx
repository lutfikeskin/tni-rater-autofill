import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Dock, Steps, mountDock, mountSteps } from '../../sidepanel/panel/steps-view.jsx';

// The quote's three steps and the dock in React (React PR 5, 2026-11-01): what renderSteps and
// renderDock wrote on the page's own elements, drawn from what they say now (state.steps,
// state.dock). What each says is checked by the safety tests (dockFor, continueSaid, renderSteps,
// renderDock); here, that the page shows it with the ids, attributes and wording the panel's
// harnesses read (#dock[data-phase], data-report, #fill, #dock-alt[data-go], #finish-summary), and
// what each button asks the panel to do (wired in sidepanel.js: the safety tests check the wiring).

let state;
beforeEach(() => { state = storeState({ steps: null, dock: null }); });
afterEach(cleanup);

// What the buttons were asked to do.
const acts = () => {
  const calls = [];
  const call = (name) => (...args) => { calls.push([name, ...args]); };
  return { calls, act: Object.fromEntries(['check', 'fill', 'confirm', 'stop', 'next', 'lookRight', 'approve', 'alt'].map((n) => [n, call(n)])) };
};
const steps = (container) => [...container.querySelectorAll('.step')].map((b) => [b.id, b.dataset.state ?? null, b.getAttribute('aria-current'),
  b.querySelector('.step-num').textContent, b.querySelector('.step-label').textContent, b.querySelector('.step-note').textContent]);
const shown = (container) => [...container.querySelectorAll('.dock-body > button')].filter((b) => !b.hidden).map((b) => [b.id, b.textContent, b.disabled]);
const $ = (container, id) => container.querySelector(`#${id}`);

// From the safety test on the client strip ("Intake", "Fill page", "Review page" in the page's
// markup) and renderSteps' step(): each step's tone, number (✓ once done), note and the one shown.
test('the three steps say what renderSteps says of them, in order, and ask the panel for their view', () => {
  const t = acts();
  const { container } = render(<Steps act={t.act} />);
  // Before the panel says anything: plain, numbered.
  expect(steps(container)).toEqual([
    ['step-check', null, null, '1', 'Intake', ''],
    ['step-fill', null, null, '2', 'Fill page', ''],
    ['step-confirm', null, null, '3', 'Review page', ''],
  ]);
  expect([...container.querySelectorAll('.step')].map((b) => b.getAttribute('aria-controls'))).toEqual(['check-view', 'page-view', 'page-view']);
  act(() => {
    state.steps = {
      check: { tone: 'done', note: 'All checked', current: false },
      fill: { tone: 'done', note: '12 filled automatically', current: false },
      confirm: { tone: 'active', note: '2 need you', current: true },
    };
  });
  expect(steps(container)).toEqual([
    ['step-check', 'done', null, '✓', 'Intake', 'All checked'],
    ['step-fill', 'done', null, '✓', 'Fill page', '12 filled automatically'],
    ['step-confirm', 'active', 'step', '3', 'Review page', '2 need you'],
  ]);
  // Mark done lowers what is left: the note the Luna mock reads (#finish-summary) follows.
  act(() => { state.steps = { ...state.steps, confirm: { tone: 'active', note: '1 needs you', current: true } }; });
  expect($(container, 'finish-summary').textContent).toBe('1 needs you');
  act(() => { state.steps = { ...state.steps, check: { tone: 'warn', note: '3 to check', current: true }, confirm: { tone: '', note: 'After the fill', current: false } }; });
  expect(steps(container).map((s) => s.slice(1, 4))).toEqual([['warn', 'step', '1'], ['done', null, '✓'], ['', null, '3']]);
  for (const id of ['check', 'fill', 'confirm']) fireEvent.click($(container, `step-${id}`));
  expect(t.calls).toEqual([['check'], ['fill'], ['confirm']]);
});

// From renderDock: the dock is hidden until the panel says it and while Settings is open; it names
// its phase and the fill it is about, shows the one button dockFor names (the others hidden, as the
// page had them), its progress while a fill runs, and its alternative.
test('the dock shows dockFor\'s word, its one button and its alternative, with the phase and report the harnesses read', () => {
  const t = acts();
  const { container } = render(<Dock act={t.act} />);
  const dock = $(container, 'dock');
  expect(dock.hidden).toBe(true);
  expect(shown(container)).toEqual([]);
  act(() => {
    state.dock = { phase: 'needs', tone: 'warn', eyebrow: '12 filled · 2 need you', title: 'Answer 2 questions', sub: 'Then Fill this page again to continue. Never Bind or Submit.',
      button: 'dock-next', label: 'Show the next one', alt: 'fill-again', altLabel: 'Fill this page again', hidden: false, report: '1700', busy: false };
  });
  expect([dock.hidden, dock.dataset.phase, dock.dataset.report]).toEqual([false, 'needs', '1700']);
  expect([$(container, 'dock-eyebrow').textContent, $(container, 'dock-eyebrow').dataset.tone, $(container, 'dock-title').textContent, $(container, 'dock-sub').hidden])
    .toEqual(['12 filled · 2 need you', 'warn', 'Answer 2 questions', false]);
  expect($(container, 'fill-progress').hidden).toBe(true);
  expect(shown(container)).toEqual([['dock-next', 'Show the next one', false], ['dock-alt', 'Fill this page again', false]]);
  expect($(container, 'dock-alt').dataset.go).toBe('fill-again');
  // A fill running: its progress and Stop, about no report yet, nothing else offered.
  act(() => {
    state.dock = { phase: 'filling', tone: 'blue', progress: true, eyebrow: 'Filling · 3 in', title: 'Reading the page…', sub: 'Keep this tab open.',
      button: 'fill-stop', label: 'Stop', disabled: false, hidden: false, report: '', busy: true };
  });
  expect([dock.dataset.phase, dock.dataset.report, $(container, 'fill-progress').hidden]).toEqual(['filling', '', false]);
  expect(shown(container)).toEqual([['fill-stop', 'Stop', false]]);
  // No sub: none shown. Settings open: the dock hides.
  act(() => { state.dock = { phase: 'off', eyebrow: 'Next', title: 'Open the client’s quote on a rater', hidden: true, report: '', busy: false }; });
  expect([dock.hidden, $(container, 'dock-sub').hidden, $(container, 'dock-eyebrow').dataset.tone]).toEqual([true, true, '']);
  expect(shown(container)).toEqual([]);
});

// From the safety test 'a page with nothing to fill and nothing left offers Continue, a fill that
// replaces nothing' (renderDock set #fill's data-go; its listener read it) and the one holding Fill
// while the quote's state differs: what Fill and the alternative ask the panel with.
test('Fill asks with its go, is held while a fill runs or the dock says so, and the alternative asks with what it offers', () => {
  const t = acts();
  const { container } = render(<Dock act={t.act} />);
  act(() => { state.dock = { phase: 'ready-continue', title: 'Ready for Continue', button: 'fill', label: 'Continue', go: 'continue', alt: 'fill-again', altLabel: 'Fill this page again', hidden: false, report: '1700', busy: false }; });
  expect([$(container, 'fill').dataset.go, ...shown(container)[0]]).toEqual(['continue', 'fill', 'Continue', false]);
  fireEvent.click($(container, 'fill'));
  fireEvent.click($(container, 'dock-alt'));
  expect(t.calls).toEqual([['fill', 'continue'], ['alt', 'fill-again']]);
  // A plain fill asks with no go.
  act(() => { state.dock = { phase: 'ready', title: 'Fill this page', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false }; });
  expect($(container, 'fill').dataset.go).toBe('');
  fireEvent.click($(container, 'fill'));
  expect(t.calls.at(-1)).toEqual(['fill', '']);
  // A fill running on another tab holds Fill here.
  act(() => { state.dock = { ...state.dock, busy: true }; });
  expect($(container, 'fill').disabled).toBe(true);
  // The quote's state differs: Fill held, Fill anyway offered.
  act(() => { state.dock = { phase: 'hold', tone: 'bad', title: 'Sort out the state above', button: 'fill', label: 'Fill this page', disabled: true, alt: 'fill-anyway', altLabel: 'Fill anyway', hidden: false, report: '', busy: false }; });
  expect(shown(container)).toEqual([['fill', 'Fill this page', true], ['dock-alt', 'Fill anyway', false]]);
  fireEvent.click($(container, 'dock-alt'));
  expect(t.calls.at(-1)).toEqual(['alt', 'fill-anyway']);
});

// sidepanel.js's Looks right disabled its button while lookRight read the page, and Stop's was
// disabled once pressed (stopFill); renderDock set each shown button's disabled again on every word.
test('a button a click disabled is enabled again by the dock\'s next word, as renderDock did; the others ask the panel', () => {
  const t = acts();
  const lookRight = (button) => { button.disabled = true; t.calls.push(['lookRight', button.id]); };
  const { container } = render(<Dock act={{ ...t.act, lookRight }} />);
  const word = { phase: 'check', tone: 'good', eyebrow: 'All answered', title: 'Look over the answers, then continue', sub: 'Never Binds or Submits.', button: 'look-right', label: 'Looks right, continue', hidden: false, report: '1700', busy: false };
  act(() => { state.dock = word; });
  fireEvent.click($(container, 'look-right'));
  expect([t.calls.at(-1), $(container, 'look-right').disabled]).toEqual([['lookRight', 'look-right'], true]);
  act(() => { state.dock = { ...word, eyebrow: 'The page changed' }; });
  expect($(container, 'look-right').disabled).toBe(false);
  // Stopping: Stop held.
  act(() => { state.dock = { phase: 'filling', title: 'Stopping after the answer going in now…', button: 'fill-stop', label: 'Stopping…', disabled: true, hidden: false, report: '', busy: true }; });
  expect(shown(container)).toEqual([['fill-stop', 'Stopping…', true]]);
  act(() => { state.dock = { phase: 'filling', title: 'Reading the page…', button: 'fill-stop', label: 'Stop', disabled: false, hidden: false, report: '', busy: true }; });
  fireEvent.click($(container, 'fill-stop'));
  act(() => { state.dock = { phase: 'needs', title: 'Answer the last question', button: 'dock-next', label: 'Show the next one', hidden: false, report: '1700', busy: false }; });
  fireEvent.click($(container, 'dock-next'));
  act(() => { state.dock = { phase: 'ai', tone: 'ai', title: 'Check the purple answers, then approve', button: 'ai-approve', label: 'Approve and continue', hidden: false, report: '1700', busy: false }; });
  expect([...$(container, 'ai-approve').classList]).toEqual(['primary', 'big', 'ai']);
  fireEvent.click($(container, 'ai-approve'));
  expect(t.calls.slice(-3).map(([name]) => name)).toEqual(['stop', 'next', 'approve']);
});

// sidepanel.js wires the panel and focuses a step (record.js) right after it mounts them.
test('mountSteps and mountDock draw before they return', () => {
  const nav = document.body.appendChild(document.createElement('nav'));
  const foot = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountSteps(nav, acts().act);
    mountDock(foot, acts().act);
    expect([...nav.querySelectorAll('.step')].map((b) => b.id)).toEqual(['step-check', 'step-fill', 'step-confirm']);
    expect(foot.querySelector('#dock')?.hidden).toBe(true);
  });
  nav.remove();
  foot.remove();
});
