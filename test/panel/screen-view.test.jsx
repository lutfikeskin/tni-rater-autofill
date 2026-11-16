// @ts-check
import fs from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Screen, headShown, mountScreen } from '../../sidepanel/panel/screen-view.jsx';
import { Dock } from '../../sidepanel/panel/steps-view.jsx';

/** @import { PanelState } from '../../types.js' */

/** @type {PanelState} */
let state;
beforeEach(() => {
  state = storeState({
    intake: null,
    view: 'home',
    settingsOpen: false,
    dock: null,
    fillingFor: null,
    pdf: null,
    summary: null,
    detailsOpen: false,
  });
});
afterEach(cleanup);

const quiet = /** @type {any} */ (new Proxy({}, { get: () => () => {} }));
/** @param {ParentNode} root @param {string} id */
const $ = (root, id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));

test('Home shows Start a quote as the single visible h1 and its lead, with sequential h2 drop-title and no sr-only h1 in sidepanel.html', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  expect(html).not.toMatch(/<h1\b/i);
  expect(html).not.toContain('Start a quote');
  expect(html).toContain('<div id="screen-root"></div>');
  expect(html).toContain('<h2 class="drop-title">Drop your intake PDF here</h2>');

  const { container } = render(<Screen />);
  const head = $(container, 'screen-head');
  const eyebrow = $(container, 'screen-eyebrow');
  const title = $(container, 'screen-title');
  const lead = $(container, 'screen-lead');
  expect([head.hidden, head.dataset.screen, eyebrow.hidden, title.tagName, title.textContent, lead.hidden, lead.textContent]).toEqual([
    false,
    'start',
    true,
    'H1',
    'Start a quote',
    false,
    'Drop the client’s intake PDF. The panel checks it and fills the rater.',
  ]);
  expect(container.querySelectorAll('h1').length).toBe(1);
});

test('screen-head draws dock eyebrow, tone, h1 title and lead across canvas screens and hides on check, settings and overlays', () => {
  const { container } = render(<><Screen /><Dock act={quiet} /></>);
  const head = $(container, 'screen-head');
  const eyebrow = $(container, 'screen-eyebrow');
  const title = $(container, 'screen-title');
  const lead = $(container, 'screen-lead');
  const dock = $(container, 'dock');
  const dockSub = $(container, 'dock-sub');

  // Ready to fill: eyebrow, title and lead in #screen-head; dock shows button without duplicating sub.
  act(() => {
    state.intake = {};
    state.view = 'page';
    state.dock = {
      phase: 'ready', eyebrow: 'Next', title: 'Fill the Vehicles page',
      sub: 'Clicks Continue once nothing is left for you.',
      button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false,
    };
  });
  expect([head.hidden, head.dataset.screen, eyebrow.hidden, eyebrow.textContent, eyebrow.dataset.tone, title.textContent, lead.hidden, lead.textContent]).toEqual([
    false, 'ready', false, 'Next', undefined, 'Fill the Vehicles page', false, 'Clicks Continue once nothing is left for you.',
  ]);
  expect([dock.hidden, dockSub.hidden]).toEqual([false, true]);
  // No duplicate title/eyebrow/lead in the accessibility tree: #dock-eyebrow/#dock-title are gone and #dock-sub is hidden.
  expect([dock.querySelector('#dock-eyebrow'), dock.querySelector('#dock-title'), dockSub.hidden]).toEqual([null, null, true]);
  expect(dock.textContent).not.toContain('Fill the Vehicles page');

  // Filling: steady count in #screen-title ("3 answers in so far") and current status in #screen-lead;
  // unanswered warn keeps its own warning title and Stop button.
  act(() => {
    state.fillingFor = /** @type {any} */ ({ filled: 3 });
    state.dock = {
      phase: 'filling', tone: 'blue', progress: true, eyebrow: 'Filling · 3 in',
      title: 'Just filled: Garaging ZIP', sub: 'Keep this tab open.',
      button: 'fill-stop', label: 'Stop', hidden: false, report: '', busy: true,
    };
  });
  expect([head.dataset.screen, eyebrow.textContent, eyebrow.dataset.tone, title.textContent, lead.textContent]).toEqual([
    'filling', 'Filling', 'blue', '3 answers in so far', 'Just filled: Garaging ZIP. Keep this tab open.',
  ]);

  act(() => {
    state.fillingFor = null;
    state.dock = {
      phase: 'filling', tone: 'warn', progress: true, eyebrow: 'Filling · 3 in',
      title: 'The page isn’t answering', sub: 'If it shows a message box, answer it there. The fill goes on after.',
      button: 'fill-stop', label: 'Stop', hidden: false, report: '', busy: true,
    };
  });
  expect([head.dataset.screen, eyebrow.dataset.tone, title.textContent, $(container, 'fill-stop').hidden]).toEqual([
    'filling', 'warn', 'The page isn’t answering', false,
  ]);

  // Review (needs, check) and AI: warn/good/ai eyebrow tones in #screen-head, compact button in #dock.
  act(() => {
    state.dock = {
      phase: 'needs', tone: 'warn', eyebrow: '10 filled · 2 need you', title: 'Answer 2 questions',
      sub: 'Then Fill this page again to continue. Never Bind or Submit.',
      button: 'dock-next', label: 'Show the next one', alt: 'fill-again', altLabel: 'Fill this page again',
      hidden: false, report: '1700', busy: false,
    };
  });
  expect([head.dataset.screen, eyebrow.dataset.tone, title.textContent, lead.textContent, dock.hidden, dockSub.hidden]).toEqual([
    'review', 'warn', 'Answer 2 questions', 'Then Fill this page again to continue. Never Bind or Submit.', false, true,
  ]);

  act(() => {
    state.dock = {
      phase: 'ai', tone: 'ai', eyebrow: 'AI picked 2 answers', title: 'Check the purple answers, then approve',
      sub: 'Continue waits until you approve them.', button: 'ai-approve', label: 'Approve and continue', hidden: false, report: '1700', busy: false,
    };
  });
  expect([head.dataset.screen, eyebrow.dataset.tone, title.textContent, lead.textContent, dock.hidden, dockSub.hidden]).toEqual([
    'ai', 'ai', 'Check the purple answers, then approve', 'Continue waits until you approve them.', false, true,
  ]);

  // Message-only screens (norater, portal, stopped, yours, continued): #screen-head carries the message; #dock hides cleanly.
  for (const [screen, word] of /** @type {const} */ ([
    ['norater', { phase: 'off', eyebrow: 'Next', title: 'Open the client’s quote on a rater', sub: 'Progressive, AmWINS or GEICO.', hidden: false, report: '', busy: false }],
    ['portal', { phase: 'portal', eyebrow: 'Next', title: 'Open the client’s quote', sub: 'This is the portal. Filling starts on a quote page.', hidden: false, report: '', busy: false }],
    ['stopped', { phase: 'stopped', eyebrow: 'Stopped by Progressive', title: 'Nothing to fill on this rater', sub: 'Nothing on this page was filled or clicked.', hidden: false, report: '1700', busy: false }],
    ['yours', { phase: 'yours', eyebrow: 'This step is yours', title: 'Finish Bind yourself', sub: 'Nothing on this step is filled or clicked.', hidden: false, report: '1700', busy: false }],
    ['continued', { phase: 'done', tone: 'good', eyebrow: 'Continued', title: 'Continue clicked', sub: 'Clicked “Next” for you. Nothing is submitted or bound.', hidden: false, report: '1700', busy: false }],
  ])) {
    act(() => { state.dock = word; });
    expect([head.hidden, head.dataset.screen, title.textContent, dock.hidden]).toEqual([false, screen, word.title, true]);
  }

  // Own-heading screens (Intake checks and Settings) hide #screen-head, keep one sr-only h1 in the document, and let #dock-sub carry dock.sub.
  act(() => {
    state.view = 'check';
    state.dock = {
      phase: 'ready', eyebrow: 'Next', title: 'Fill this page',
      sub: '2 intake items not looked at yet. You can still fill.',
      button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false,
    };
  });
  expect([head.hidden, container.querySelectorAll('h1.sr-only').length, dock.hidden, dockSub.hidden, dockSub.textContent]).toEqual([
    true, 1, false, false, '2 intake items not looked at yet. You can still fill.',
  ]);

  act(() => { state.settingsOpen = true; });
  expect([head.hidden, headShown(state), container.querySelectorAll('h1.sr-only').length]).toEqual([true, false, 1]);

  // Overlays (PDF sheet, quote summary, All client details drawer) hide #screen-head too.
  act(() => {
    state.settingsOpen = false;
    state.view = 'page';
    state.dock = { phase: 'ready', title: 'Fill this page', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false };
  });
  expect(head.hidden).toBe(false);
  act(() => { state.detailsOpen = true; });
  expect(head.hidden).toBe(true);
  act(() => { state.detailsOpen = false; state.pdf = /** @type {any} */ ({ page: 1 }); });
  expect(head.hidden).toBe(true);
  act(() => { state.pdf = null; state.summary = /** @type {any} */ ({ rows: [] }); });
  expect(head.hidden).toBe(true);
});

test('screen transitions move focus to #screen-title only when the screen id changes and focus is not inside an interactive control, dock, or closing Settings', () => {
  const { container } = render(
    <>
      <Screen />
      <input id="answer-input" />
      <button id="settings-btn" type="button">Settings</button>
      <Dock act={quiet} />
    </>,
  );
  // Initial mount on 'start' does not steal focus.
  expect(document.activeElement).toBe(document.body);

  // Screen change from 'start' -> 'ready' when focus is on body moves focus to #screen-title.
  act(() => {
    state.intake = {};
    state.view = 'page';
    state.dock = { phase: 'ready', title: 'Fill the Vehicles page', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false };
  });
  const title = $(container, 'screen-title');
  expect(document.activeElement).toBe(title);

  // Wording updates within the SAME screen id ('ready') do not re-focus #screen-title.
  title.blur();
  expect(document.activeElement).toBe(document.body);
  act(() => {
    state.dock = { ...state.dock, title: 'Fill the Drivers page' };
  });
  expect(document.activeElement).toBe(document.body);

  // Closing Settings ('settings' -> 'ready') leaves focus on #settings-btn.
  const settingsBtn = $(container, 'settings-btn');
  act(() => { state.settingsOpen = true; });
  settingsBtn.focus();
  act(() => { state.settingsOpen = false; });
  expect(document.activeElement).toBe(settingsBtn);

  // Focus inside an input is never stolen on screen change.
  const input = $(container, 'answer-input');
  input.focus();
  act(() => {
    state.dock = { phase: 'needs', title: 'Answer 1 question', button: 'dock-next', label: 'Show the next one', hidden: false, report: '1700', busy: false };
  });
  expect(document.activeElement).toBe(input);

  // Focus inside #dock is left to Dock's own button-to-button focus handoff (UX-08).
  const nextBtn = $(container, 'dock-next');
  nextBtn.focus();
  act(() => {
    state.dock = { phase: 'filling', title: 'Filling…', button: 'fill-stop', label: 'Stop', hidden: false, report: '', busy: true };
  });
  expect(document.activeElement?.id).toBe('fill-stop');
});

test('mountScreen draws #screen-head synchronously and toggles footer .line when #view overflows', () => {
  const view = document.body.appendChild(document.createElement('main'));
  view.id = 'view';
  const host = view.appendChild(document.createElement('div'));
  const foot = document.body.appendChild(document.createElement('footer'));
  foot.className = 'foot';
  Object.defineProperty(view, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(view, 'scrollHeight', { configurable: true, value: 420 });
  Object.defineProperty(view, 'scrollTop', { configurable: true, writable: true, value: 0 });

  act(() => {
    mountScreen(host);
    expect(host.querySelector('#screen-title')?.textContent).toBe('Start a quote');
  });
  expect(foot.classList.contains('line')).toBe(true);

  act(() => {
    view.scrollTop = 220;
    view.dispatchEvent(new Event('scroll'));
  });
  expect(foot.classList.contains('line')).toBe(false);

  view.remove();
  foot.remove();
});
