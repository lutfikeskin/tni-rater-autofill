// @ts-check
import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { DOCK, FILLING } from '../../sidepanel/panel/messages.js';
import { Screen, headShown, mountScreen } from '../../sidepanel/panel/screen-view.jsx';
import { Dock } from '../../sidepanel/panel/steps-view.jsx';
import { Feed } from '../../sidepanel/panel/feed-view.jsx';

/** @import { DockSnapshot, PanelScreen, PanelState } from '../../types.js' */

/** @type {PanelState} */
let state;
beforeEach(() => {
  state = storeState({
    intake: null,
    view: 'home',
    settingsOpen: false,
    dock: null,
    fillingFor: null,
    feed: null,
    pdf: null,
    summary: null,
    detailsOpen: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const quiet = /** @type {any} */ (new Proxy({}, { get: () => () => {} }));
/** @param {ParentNode} root @param {string} id */
const $ = (root, id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));

test('Home keeps the single sr-only h1 in sidepanel.html, renders Start a quote as h2 in a div#screen-head, and keeps h3 drop-title', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  expect(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi)).toEqual(['<h1 class="sr-only">TNI Rater Autofill</h1>']);
  expect(html).toContain('<div id="screen-root"></div>');
  expect(html).toContain('<h3 class="drop-title">Drop your intake PDF here</h3>');

  const { container } = render(<Screen />);
  const head = $(container, 'screen-head');
  const eyebrow = $(container, 'screen-eyebrow');
  const title = $(container, 'screen-title');
  const lead = $(container, 'screen-lead');
  expect([head.tagName, head.hidden, head.dataset.screen, eyebrow.hidden, title.tagName, title.textContent, lead.hidden, lead.textContent]).toEqual([
    'DIV',
    false,
    'start',
    true,
    'H2',
    'Start a quote',
    false,
    'Drop the client’s intake PDF. The panel checks it and fills the rater.',
  ]);
  expect(container.querySelectorAll('h1').length).toBe(0);
});

test('headShown is true on the 17 canvas screens and false on review, check, ai, settings and open overlays', () => {
  /** @type {Array<[PanelScreen, Partial<PanelState>, DockSnapshot | null, boolean]>} */
  const cases = [
    ['start', { intake: null, view: 'home', settingsOpen: false }, { phase: 'start', hidden: false }, true],
    ['check', { intake: {}, view: 'check', settingsOpen: false }, { phase: 'ready', hidden: false }, false],
    ['norater', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'off', hidden: false }, true],
    ['unreadable', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'unreadable', hidden: false }, true],
    ['preview', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'preview', hidden: false }, true],
    ['portal', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'portal', hidden: false }, true],
    ['stopped', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'stopped', hidden: false }, true],
    ['yours', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'yours', hidden: false }, true],
    ['hold', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'hold', hidden: false }, true],
    ['defaults', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'defaults', hidden: false }, true],
    ['owner', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'owner', hidden: false }, true],
    ['ready', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'ready', hidden: false }, true],
    ['filling', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'filling', hidden: false }, true],
    ['elsewhere', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'elsewhere', hidden: false }, true],
    ['review', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'needs', hidden: false }, false],
    ['stopped-fill', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'stopped-fill', hidden: false }, true],
    ['error', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'error', hidden: false }, true],
    ['ai', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'ai', hidden: false }, false],
    ['finished', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'done', button: 'dock-summary', hidden: false }, true],
    ['continued', { intake: {}, view: 'page', settingsOpen: false }, { phase: 'done', hidden: false }, true],
    ['settings', { intake: {}, view: 'page', settingsOpen: true }, { phase: 'ready', hidden: true }, false],
  ];
  expect(cases.length).toBe(21);
  for (const [, patch, dock, expected] of cases) {
    act(() => { Object.assign(state, patch, { dock, pdf: null, detailsOpen: false, summary: null }); });
    expect(headShown(state)).toBe(expected);
  }
  act(() => { Object.assign(state, { intake: {}, view: 'page', settingsOpen: false, dock: { phase: 'ready', hidden: false } }); });
  expect(headShown(state)).toBe(true);
  act(() => { state.detailsOpen = true; });
  expect(headShown(state)).toBe(false);
  act(() => { state.detailsOpen = false; state.pdf = /** @type {any} */ ({ page: 1 }); });
  expect(headShown(state)).toBe(false);
  act(() => { state.pdf = null; state.summary = /** @type {any} */ ({ rows: [] }); });
  expect(headShown(state)).toBe(false);
});

test('screen-head, dock sr-only/aria-hidden text, filling count from fillingFor, and review/ai feed-title work together', () => {
  const css = fs.readFileSync('sidepanel/sidepanel.css', 'utf8');
  const { container } = render(
    <div className="view">
      <style>{css}</style>
      <Screen />
      <Feed act={quiet} />
      <Dock act={quiet} />
    </div>,
  );
  const head = $(container, 'screen-head');
  const eyebrow = $(container, 'screen-eyebrow');
  const title = $(container, 'screen-title');
  const lead = $(container, 'screen-lead');
  const dock = $(container, 'dock');
  const dockEyebrow = $(container, 'dock-eyebrow');
  const dockTitle = $(container, 'dock-title');
  const dockSub = $(container, 'dock-sub');
  const feedTitle = $(container, 'feed-title');

  // Ready to fill: #screen-head visible; #dock-eyebrow and #dock-title stay in DOM with sr-only + aria-hidden.
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
  expect([dock.hidden, dockSub.hidden, dockEyebrow.classList.contains('sr-only'), dockEyebrow.getAttribute('aria-hidden'), dockTitle.classList.contains('sr-only'), dockTitle.getAttribute('aria-hidden')]).toEqual([
    false, true, true, 'true', true, 'true',
  ]);

  // Filling: reads filled ONLY from state.fillingFor.filled (no regex fallback on d.eyebrow), and does not stitch d.title into d.sub;
  // #feed-title is hidden while #screen-head is shown.
  act(() => {
    state.fillingFor = /** @type {any} */ ({ filled: 3 });
    state.feed = { shown: true, title: 'Answers on this page', pages: [], filter: 'all', counts: null, keyOpen: null, report: false };
    state.dock = {
      phase: 'filling', tone: 'blue', progress: true, eyebrow: FILLING.eyebrow(3),
      title: FILLING.justFilled('Garaging ZIP'), sub: FILLING.sub,
      button: 'fill-stop', label: FILLING.stop, hidden: false, report: '', busy: true,
    };
  });
  expect([head.dataset.screen, eyebrow.textContent, eyebrow.dataset.tone, title.textContent, lead.textContent]).toEqual([
    'filling', 'Filling', 'blue', '3 answers in so far', FILLING.sub,
  ]);
  expect(getComputedStyle(feedTitle).display).toBe('none');

  // Without state.fillingFor, d.eyebrow ('Filling · 3 in') is NOT parsed: title falls back to d.title.
  act(() => {
    state.fillingFor = null;
  });
  expect([title.textContent, lead.textContent]).toEqual([FILLING.justFilled('Garaging ZIP'), FILLING.sub]);

  // Stopping and unanswered warn keep their own words from messages.js.
  act(() => {
    state.dock = {
      phase: 'filling', tone: 'blue', progress: true, eyebrow: FILLING.stoppingEyebrow,
      title: FILLING.stoppingTitle, sub: FILLING.sub,
      button: 'fill-stop', label: FILLING.stopping, disabled: true, hidden: false, report: '', busy: true,
    };
  });
  expect([eyebrow.textContent, title.textContent]).toEqual([FILLING.stoppingEyebrow, FILLING.stoppingTitle]);

  act(() => {
    state.dock = {
      phase: 'filling', tone: 'warn', progress: true, eyebrow: FILLING.eyebrow(3),
      title: FILLING.unanswered.title, sub: FILLING.unanswered.sub,
      button: 'fill-stop', label: FILLING.stop, hidden: false, report: '', busy: true,
    };
  });
  expect([eyebrow.dataset.tone, title.textContent, $(container, 'fill-stop').hidden]).toEqual([
    'warn', FILLING.unanswered.title, false,
  ]);

  // Review (needs) and AI: #screen-head hides, #dock shows #dock-eyebrow/#dock-title/#dock-sub, and #feed-title is visible!
  act(() => {
    state.feed = {
      shown: true, title: 'Answers on this page', pages: [], filter: 'needs',
      counts: { all: 12, needs: 2, done: 10 }, keyOpen: false, report: true,
    };
    state.dock = {
      phase: 'needs', tone: 'warn', eyebrow: '10 filled · 2 need you', title: 'Answer 2 questions',
      sub: 'Then Fill this page again to continue. Never Bind or Submit.',
      button: 'dock-next', label: 'Show the next one', alt: 'fill-again', altLabel: 'Fill this page again',
      hidden: false, report: '1700', busy: false,
    };
  });
  expect([head.hidden, dock.hidden, dockEyebrow.classList.contains('sr-only'), dockTitle.getAttribute('aria-hidden'), dockTitle.textContent, dockSub.hidden]).toEqual([
    true, false, false, null, 'Answer 2 questions', false,
  ]);
  expect([$(container, 'feed').hidden, feedTitle.textContent, getComputedStyle(feedTitle).display]).toEqual([
    false, 'Answers on this page', 'inline',
  ]);

  act(() => {
    state.dock = {
      phase: 'ai', tone: 'ai', eyebrow: 'AI picked 2 answers', title: 'Check the purple answers, then approve',
      sub: 'Continue waits until you approve them.', button: 'ai-approve', label: 'Approve and continue', hidden: false, report: '1700', busy: false,
    };
  });
  expect([head.hidden, dock.hidden, dockEyebrow.dataset.tone, dockTitle.getAttribute('aria-hidden'), dockTitle.textContent, dockSub.hidden]).toEqual([
    true, false, 'ai', null, 'Check the purple answers, then approve', false,
  ]);
});

test('Intake check view keeps dock blockers and running Stop visible with their eyebrow, title and sub', () => {
  act(() => {
    state.intake = {};
    state.view = 'check';
  });
  const { container } = render(<><Screen /><Dock act={quiet} /></>);
  const head = $(container, 'screen-head');
  const dock = $(container, 'dock');
  const dockEyebrow = $(container, 'dock-eyebrow');
  const dockTitle = $(container, 'dock-title');
  const dockSub = $(container, 'dock-sub');

  // 1. Carrier stop (no button, no alt).
  act(() => {
    state.dock = { phase: 'stopped', tone: 'bad', ...DOCK.stopped('AmWINS'), hidden: false, report: '1700', busy: false };
  });
  expect([head.hidden, dock.hidden, dockEyebrow.dataset.tone, dockEyebrow.textContent, dockTitle.getAttribute('aria-hidden'), dockTitle.classList.contains('sr-only'), dockTitle.textContent, dockSub.hidden, dockSub.textContent]).toEqual([
    true, false, 'bad', 'Stopped by AmWINS', null, false, 'Nothing to fill on this rater', false, DOCK.stopped('AmWINS').sub,
  ]);

  // 2. Fill error (Fill this page again + error title).
  act(() => {
    state.dock = { phase: 'error', tone: 'bad', ...DOCK.error, button: 'fill', label: DOCK.fillAgain, hidden: false, report: '1700', busy: false };
  });
  expect([head.hidden, dock.hidden, dockEyebrow.textContent, dockTitle.getAttribute('aria-hidden'), dockTitle.textContent, $(container, 'fill').hidden, $(container, 'fill').textContent]).toEqual([
    true, false, DOCK.error.eyebrow, null, DOCK.error.title, false, DOCK.fillAgain,
  ]);

  // 3. Quote state hold (disabled Fill + Fill anyway + hold title).
  act(() => {
    state.dock = { phase: 'hold', tone: 'bad', ...DOCK.stateHold('TX', 'FL'), button: 'fill', disabled: true, alt: 'fill-anyway', hidden: false, report: '', busy: false };
  });
  expect([head.hidden, dock.hidden, dockTitle.getAttribute('aria-hidden'), dockTitle.textContent, /** @type {HTMLButtonElement} */ ($(container, 'fill')).disabled, $(container, 'dock-alt').hidden, $(container, 'dock-alt').textContent]).toEqual([
    true, false, null, DOCK.stateHold('TX', 'FL').title, true, false, DOCK.stateHold('TX', 'FL').altLabel,
  ]);

  // 4. Running fill (Stop button + filling title).
  act(() => {
    state.dock = { phase: 'filling', tone: 'blue', progress: true, eyebrow: FILLING.eyebrow(2), title: FILLING.reading, sub: FILLING.sub, button: 'fill-stop', label: FILLING.stop, hidden: false, report: '', busy: true };
  });
  expect([head.hidden, dock.hidden, dockTitle.getAttribute('aria-hidden'), dockTitle.textContent, $(container, 'fill-stop').hidden, $(container, 'fill-stop').textContent]).toEqual([
    true, false, null, FILLING.reading, false, FILLING.stop,
  ]);
});

test('scrolling #screen-title out of #view sets #dock[data-head-out] and reveals #dock-eyebrow, #dock-title and #dock-sub visually while keeping aria-hidden', async () => {
  /** @type {IntersectionObserverCallback | null} */
  let ioCallback = null;
  /** @type {IntersectionObserverInit | undefined} */
  let ioOptions;
  /** @type {Element | null} */
  let observed = null;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    /**
     * @param {IntersectionObserverCallback} cb
     * @param {IntersectionObserverInit} [opts]
     */
    constructor(cb, opts) { ioCallback = cb; ioOptions = opts; }
    /** @param {Element} el */
    observe(el) { observed = el; }
    disconnect() { disconnect(); }
  });

  act(() => {
    state.intake = {};
    state.view = 'page';
    state.dock = {
      phase: 'error', tone: 'bad', ...DOCK.error,
      button: 'fill', label: DOCK.fillAgain, hidden: false, report: '1700', busy: false,
    };
  });
  const { container } = render(
    <main id="view">
      <Screen />
      <Dock act={quiet} />
    </main>,
  );
  const view = $(container, 'view');
  const screenTitle = $(container, 'screen-title');
  const dock = $(container, 'dock');
  const dockEyebrow = $(container, 'dock-eyebrow');
  const dockTitle = $(container, 'dock-title');
  const dockSub = $(container, 'dock-sub');

  expect(observed).toBe(screenTitle);
  expect(ioOptions).toEqual({ root: view, threshold: 1 });

  // While #screen-title intersects #view in full: dock text is sr-only + aria-hidden.
  expect([dock.hasAttribute('data-head-out'), dockTitle.classList.contains('sr-only'), dockTitle.getAttribute('aria-hidden'), dockSub.hidden, dockSub.getAttribute('aria-hidden')]).toEqual([
    false, true, 'true', true, null,
  ]);

  // #screen-title clips above #view (ratio < 1): data-head-out reveals dock text visually while keeping aria-hidden='true'.
  await act(async () => {
    ioCallback?.([/** @type {any} */ ({ isIntersecting: true, intersectionRatio: 0.4 })], /** @type {any} */ ({}));
  });
  expect([
    dock.hasAttribute('data-head-out'),
    dockEyebrow.classList.contains('sr-only'),
    dockEyebrow.getAttribute('aria-hidden'),
    dockTitle.classList.contains('sr-only'),
    dockTitle.getAttribute('aria-hidden'),
    dockSub.hidden,
    dockSub.getAttribute('aria-hidden'),
  ]).toEqual([
    true, false, 'true', false, 'true', false, 'true',
  ]);

  // Scrolling back to full view (ratio === 1) removes data-head-out and restores sr-only + hidden sub.
  await act(async () => {
    ioCallback?.([/** @type {any} */ ({ isIntersecting: true, intersectionRatio: 1 })], /** @type {any} */ ({}));
  });
  expect([dock.hasAttribute('data-head-out'), dockTitle.classList.contains('sr-only'), dockTitle.getAttribute('aria-hidden'), dockSub.hidden, dockSub.getAttribute('aria-hidden')]).toEqual([
    false, true, 'true', true, null,
  ]);
});

test('screen transitions focus and scroll #screen-title only when focus is inside the panel, never stealing from body or an unfocused panel', () => {
  const scrollBehavior = vi.fn(/** @returns {ScrollBehavior} */ () => 'instant');
  const { container } = render(
    <>
      <Screen scrollBehavior={scrollBehavior} />
      <button id="panel-btn" type="button">Inside panel</button>
      <input id="answer-input" />
      <button id="settings-btn" type="button">Settings</button>
      <Dock act={quiet} />
    </>,
  );
  const title = $(container, 'screen-title');
  const scrollIntoView = vi.fn();
  title.scrollIntoView = scrollIntoView;

  // 1. Focus on document.body (no panel element focused): screen change does NOT steal focus.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  expect(document.activeElement).toBe(document.body);
  act(() => {
    state.intake = {};
    state.view = 'page';
    state.dock = { phase: 'ready', title: 'Fill the Vehicles page', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false };
  });
  expect(document.activeElement).toBe(document.body);
  expect(scrollIntoView).not.toHaveBeenCalled();

  // 2. Panel window unfocused (agent typing on the rater tab): screen change does NOT focus #screen-title.
  const panelBtn = $(container, 'panel-btn');
  panelBtn.focus();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  act(() => {
    state.dock = { phase: 'portal', title: 'Open the client’s quote', hidden: false, report: '', busy: false };
  });
  expect(document.activeElement).toBe(panelBtn);
  expect(scrollIntoView).not.toHaveBeenCalled();

  // 3. Panel has focus and focus is on a non-dock, non-input control inside the panel: moves focus AND scrolls with scrollBehavior().
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  act(() => {
    state.dock = { phase: 'error', tone: 'bad', ...DOCK.error, button: 'fill', label: DOCK.fillAgain, hidden: false, report: '1700', busy: false };
  });
  expect(document.activeElement).toBe(title);
  expect(scrollBehavior).toHaveBeenCalled();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });

  // 4. Same-screen wording update ('error' -> 'error') does not re-focus #screen-title.
  panelBtn.focus();
  scrollIntoView.mockClear();
  act(() => {
    state.dock = { ...state.dock, sub: 'Try again.' };
  });
  expect(document.activeElement).toBe(panelBtn);
  expect(scrollIntoView).not.toHaveBeenCalled();

  // 5. Closing Settings ('settings' -> 'error') leaves focus on #settings-btn.
  const settingsBtn = $(container, 'settings-btn');
  act(() => { state.settingsOpen = true; });
  settingsBtn.focus();
  act(() => { state.settingsOpen = false; });
  expect(document.activeElement).toBe(settingsBtn);

  // 6. Focus inside an input is never stolen.
  const input = $(container, 'answer-input');
  input.focus();
  act(() => {
    state.dock = { phase: 'ready', title: 'Fill the Drivers page', button: 'fill', label: 'Fill this page', hidden: false, report: '', busy: false };
  });
  expect(document.activeElement).toBe(input);

  // 7. Focus inside #dock stays with Dock's button-to-button handoff (UX-08).
  const fillBtn = $(container, 'fill');
  fillBtn.focus();
  act(() => {
    state.dock = { phase: 'filling', title: 'Filling…', button: 'fill-stop', label: 'Stop', hidden: false, report: '', busy: true };
  });
  expect(document.activeElement?.id).toBe('fill-stop');
});

test('mountScreen draws #screen-head synchronously', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountScreen(host, { scrollBehavior: () => 'auto' });
    expect(host.querySelector('#screen-title')?.textContent).toBe('Start a quote');
  });
  host.remove();
});
