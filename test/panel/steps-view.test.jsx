import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Dock, Steps, mountDock, mountSteps } from '../../sidepanel/panel/steps-view.jsx';

// The panel's two tabs (Intake, This page) and the dock in React (React PR 5, 2026-11-01): what renderSteps and
// renderDock wrote on the page's own elements, drawn from what they say now (state.steps,
// state.dock). What each says is checked by the safety tests (dockFor, continueSaid, renderSteps,
// renderDock); here, that the page shows it with the ids, attributes and wording the panel's
// harnesses read (#dock[data-phase], data-report, #fill, #dock-alt[data-go], #fill-summary), and
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
  b.querySelector('.step-label').textContent, b.querySelector('.step-note').textContent]);
const shown = (container) => [...container.querySelectorAll('.dock-body > button')].filter((b) => !b.hidden).map((b) => [b.id, b.textContent, b.disabled]);
const $ = (container, id) => container.querySelector(`#${id}`);

// Audit 2026-11-07, UX-04: three numbered steps, two of them the same view (Fill page, Review page),
// whose checkmarks went back on every page, beside the header's "Step n of m". Now two tabs, no
// numbers: the intake, and the page in front.
test('the two tabs say what renderSteps says of them, in order, and ask the panel for their view', () => {
  const t = acts();
  const { container } = render(<Steps act={t.act} />);
  // Before the panel says anything: plain.
  expect(steps(container)).toEqual([
    ['step-check', null, null, 'Intake', ''],
    ['step-fill', null, null, 'This page', ''],
  ]);
  expect(container.querySelector('.step-num')).toBe(null);
  expect([...container.querySelectorAll('.step')].map((b) => b.getAttribute('aria-controls'))).toEqual(['check-view', 'page-view']);
  act(() => {
    state.steps = {
      check: { tone: 'done', note: 'All checked', current: false },
      fill: { tone: 'active', note: '2 need you', current: true, review: true },
    };
  });
  expect(steps(container)).toEqual([
    ['step-check', 'done', null, 'Intake', 'All checked'],
    ['step-fill', 'active', 'true', 'This page', '2 need you'],
  ]);
  // Mark done lowers what is left: the note the Luna mock reads (#fill-summary) follows.
  act(() => { state.steps = { ...state.steps, fill: { tone: 'active', note: '1 needs you', current: true, review: true } }; });
  expect($(container, 'fill-summary').textContent).toBe('1 needs you');
  // A filled page's tab reads the page again (confirm); before the fill it only shows the page.
  fireEvent.click($(container, 'step-check'));
  fireEvent.click($(container, 'step-fill'));
  act(() => { state.steps = { ...state.steps, check: { tone: 'warn', note: '3 to check', current: true }, fill: { tone: 'active', note: 'Ready to fill', current: false, review: false } }; });
  expect(steps(container).map((s) => s.slice(1, 3))).toEqual([['warn', 'true'], ['active', null]]);
  fireEvent.click($(container, 'step-fill'));
  expect(t.calls).toEqual([['check'], ['confirm'], ['fill']]);
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

// Audit 2026-11-07, FLOW-13: automatic filling paused on the tab in front (renderDock's `paused`) is
// said under the dock's word, as a status line, on whatever page the tab is on.
test('the dock says when automatic filling is paused on the tab, and stops saying it once lifted', () => {
  const { container } = render(<Dock act={acts().act} />);
  const word = { phase: 'ready', eyebrow: 'Next', title: 'Fill the Vehicles page', sub: 'Clicks Continue once nothing is left for you.', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false };
  act(() => { state.dock = { ...word, paused: 'Automatic filling is paused on this tab. Your next Fill turns it back on.' }; });
  const line = $(container, 'dock-paused');
  expect([line.hidden, line.getAttribute('role'), line.textContent]).toEqual([false, 'status', 'Automatic filling is paused on this tab. Your next Fill turns it back on.']);
  expect($(container, 'dock-sub').textContent).toBe('Clicks Continue once nothing is left for you.');
  act(() => { state.dock = { ...word, paused: '' }; });
  expect(line.hidden).toBe(true);
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
    expect([...nav.querySelectorAll('.step')].map((b) => b.id)).toEqual(['step-check', 'step-fill']);
    expect(foot.querySelector('#dock')?.hidden).toBe(true);
  });
  nav.remove();
  foot.remove();
});

// Audit 2026-11-07, UX-08: Fill this page hid as Stop showed, and keyboard focus fell to the page;
// a keyboard or screen-reader agent had to tab back through the panel to reach Stop.
test('keyboard focus stays in the dock as its button changes, and is never taken from elsewhere', () => {
  const t = acts();
  const { container } = render(<><button id="elsewhere">elsewhere</button><Dock act={t.act} /></>);
  const say = (word) => act(() => { state.dock = { title: 'x', hidden: false, report: '', busy: false, ...word }; });
  say({ phase: 'ready', button: 'fill', label: 'Fill this page' });
  $(container, 'fill').focus();
  // Fill pressed: Stop shows in its place, and takes the focus.
  say({ phase: 'filling', button: 'fill-stop', label: 'Stop', busy: true });
  expect(document.activeElement.id).toBe('fill-stop');
  // Stop pressed: it stays, disabled, as Stopping…; then the next word's button takes it.
  say({ phase: 'filling', button: 'fill-stop', label: 'Stopping…', disabled: true, busy: true });
  say({ phase: 'needs', button: 'dock-next', label: 'Show the next one', alt: 'fill-again', altLabel: 'Fill this page again' });
  expect(document.activeElement.id).toBe('dock-next');
  // A word with no button: its alternative.
  say({ phase: 'finished', alt: 'fill-again', altLabel: 'Fill this page again' });
  expect(document.activeElement.id).toBe('dock-alt');
  // Stop pressed with nothing else in the dock: the browser drops focus from it (blur, to the page),
  // and the agent then moves on to a control outside the dock before the next word: that is theirs
  // (review of #390, CodeRabbit).
  say({ phase: 'filling', button: 'fill-stop', label: 'Stopping…', disabled: true, busy: true });
  act(() => { document.activeElement.blur(); });
  $(container, 'elsewhere').focus();
  act(() => { document.activeElement.blur(); });
  say({ phase: 'ready', button: 'fill', label: 'Fill this page again' });
  expect(document.activeElement).toBe(document.body);
  // Focus elsewhere: the dock's changes leave it there.
  $(container, 'elsewhere').focus();
  say({ phase: 'ready', button: 'fill', label: 'Fill this page' });
  say({ phase: 'filling', button: 'fill-stop', label: 'Stop', busy: true });
  expect(document.activeElement.id).toBe('elsewhere');
});

// Audit 2026-11-07, FLOW-05: while a quiet automatic fill ran (no answer in yet), the dock still
// offered Looks right, Show the next one or Fill this page again, and a click did nothing. While
// answers go in every button but Stop waits, and says why.
test('while answers go in, every dock button but Stop is held and says why', () => {
  const t = acts();
  const { container } = render(<Dock act={t.act} />);
  const why = 'Wait for the answers going in to finish.';
  for (const word of [
    { phase: 'check', button: 'look-right', label: 'Looks right, continue', alt: 'fill-again', altLabel: 'Fill this page again' },
    { phase: 'needs', button: 'dock-next', label: 'Show the next one', alt: 'fill-again', altLabel: 'Fill this page again' },
    { phase: 'ready', button: 'fill', label: 'Fill this page again', alt: 'fill-again', altLabel: 'Fill this page again' },
  ]) {
    act(() => { state.dock = { ...word, title: 'x', hidden: false, report: '1700', busy: true }; });
    const button = $(container, word.button);
    expect([button.hidden, button.disabled, button.title]).toEqual([false, true, why]);
    expect([$(container, 'dock-alt').disabled, $(container, 'dock-alt').title]).toEqual([true, why]);
    act(() => { state.dock = { ...state.dock, busy: false }; });
    expect([button.disabled, button.title, $(container, 'dock-alt').disabled]).toEqual([false, '', false]);
  }
  // Stop never waits.
  act(() => { state.dock = { phase: 'elsewhere', title: 'Filling your other GEICO tab', button: 'fill-stop', label: 'Stop', disabled: false, hidden: false, report: '', busy: true }; });
  expect([$(container, 'fill-stop').disabled, $(container, 'fill-stop').title]).toEqual([false, '']);
  fireEvent.click($(container, 'fill-stop'));
  expect(t.calls.at(-1)?.[0]).toBe('stop');
});
