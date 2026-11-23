// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { screenFor } from '../sidepanel/panel/screen.js';
import { CONTINUE, DOCK, FILLING } from '../sidepanel/panel/messages.js';

const INTAKE = { record: { applicant: { name: 'Acme Hauling LLC' } }, warnings: [], done: [] };
const pageState = (dock) => ({ intake: INTAKE, view: 'page', settingsOpen: false, dock });

// Table 1.1 row 1 (coordinator.js:1470): !state.intake -> { phase: 'start', ...DOCK.start }.
test('table 1.1 #1: start phase maps to start', () => {
  const dock = { phase: 'start', ...DOCK.start };
  assert.equal(screenFor({ intake: null, view: 'check', settingsOpen: false, dock }), 'start');
  assert.equal(screenFor(pageState(dock)), 'start');
});

// Table 1.1 row 2 (coordinator.js:1475): !inExtension -> { phase: 'off', ...DOCK.preview }.
test('table 1.1 #2: off preview maps to preview', () => {
  const dock = { phase: 'off', ...DOCK.preview };
  assert.equal(screenFor(pageState(dock)), 'preview');
});

// Table 1.1 row 3 (coordinator.js:1481-1482): tab without URL -> { phase: 'off', ...DOCK.unreadable }.
test('table 1.1 #3: off unreadable page maps to unreadable', () => {
  const dock = { phase: 'off', ...DOCK.unreadable };
  assert.equal(screenFor(pageState(dock)), 'unreadable');
});

// Table 1.1 row 4 (coordinator.js:1483): no carrier -> { phase: 'off', ...DOCK.openRater, sub }.
test('table 1.1 #4: off open a rater maps to norater', () => {
  const dock = { phase: 'off', ...DOCK.openRater, sub: 'Supports Progressive, AmWINS and GEICO.' };
  assert.equal(screenFor(pageState(dock)), 'norater');
  const withChecksLeft = { phase: 'off', ...DOCK.openRater, sub: DOCK.checksLeft(2) };
  assert.equal(screenFor(pageState(withChecksLeft)), 'norater');
});

// Table 1.1 row 5 (coordinator.js:1491): carrier stop page -> { phase: 'stopped', tone: 'bad', ...DOCK.stopped(...) }.
test('table 1.1 #5: stopped carrier page maps to stopped', () => {
  const dock = { phase: 'stopped', tone: /** @type {const} */ ('bad'), ...DOCK.stopped('Progressive') };
  assert.equal(screenFor(pageState(dock)), 'stopped');
});

// Table 1.1 row 6 (coordinator.js:1492): carrier stop step/screen -> { phase: 'yours', ...DOCK.yours(...) }.
test('table 1.1 #6: yours stop step or screen maps to yours', () => {
  const stepDock = { phase: 'yours', ...DOCK.yours('Billing', false) };
  const screenDock = { phase: 'yours', ...DOCK.yours('Add USDOT Number', true) };
  assert.equal(screenFor(pageState(stepDock)), 'yours');
  assert.equal(screenFor(pageState(screenDock)), 'yours');
});

// Table 1.1 row 7 (coordinator.js:1497): state mismatch -> { phase: 'hold', tone: 'bad', ...DOCK.stateHold(...), button: 'fill', disabled: true, alt: 'fill-anyway' }.
test('table 1.1 #7: hold state mismatch maps to hold', () => {
  const dock = {
    phase: 'hold',
    tone: /** @type {const} */ ('bad'),
    ...DOCK.stateHold('TX', 'FL'),
    button: 'fill',
    disabled: true,
    alt: 'fill-anyway',
  };
  assert.equal(screenFor(pageState(dock)), 'hold');
});

// Table 1.1 row 8 (coordinator.js:1502): defaults ask -> { phase: 'hold', tone: 'warn', ...DOCK.defaultsAsk, button: 'dock-defaults' }.
test('table 1.1 #8: hold defaults ask (dock-defaults) maps to defaults', () => {
  const dock = {
    phase: 'hold',
    tone: /** @type {const} */ ('warn'),
    ...DOCK.defaultsAsk,
    button: 'dock-defaults',
  };
  assert.equal(screenFor(pageState(dock)), 'defaults');
});

// Table 1.1 row 9 (coordinator.js:1503): defaults held -> { phase: 'hold', tone: 'warn', ...DOCK.defaultsHeld, button: 'fill', disabled: true }.
test('table 1.1 #9: hold defaults held maps to defaults', () => {
  const dock = {
    phase: 'hold',
    tone: /** @type {const} */ ('warn'),
    ...DOCK.defaultsHeld,
    button: 'fill',
    disabled: true,
  };
  assert.equal(screenFor(pageState(dock)), 'defaults');
});

// Table 1.1 row 10 (coordinator.js:1508): quote owner issue -> { phase: 'hold', tone: 'warn', ...DOCK.otherClient, button: 'fill' }.
test('table 1.1 #10: hold other client maps to owner', () => {
  const dock = {
    phase: 'hold',
    tone: /** @type {const} */ ('warn'),
    ...DOCK.otherClient,
    button: 'fill',
  };
  assert.equal(screenFor(pageState(dock)), 'owner');
});

// Table 1.1 row 11 (coordinator.js:1511): carrier portal outside quote -> { phase: 'portal', ...DOCK.portal }.
test('table 1.1 #11: portal maps to portal', () => {
  const dock = { phase: 'portal', ...DOCK.portal };
  assert.equal(screenFor(pageState(dock)), 'portal');
});

// Table 1.1 row 12 (coordinator.js:1517): report error -> { phase: 'error', tone: 'bad', ...DOCK.error, ...fill }.
test('table 1.1 #12: error maps to error', () => {
  const dock = {
    phase: 'error',
    tone: /** @type {const} */ ('bad'),
    ...DOCK.error,
    button: 'fill',
    label: DOCK.fillAgain,
  };
  assert.equal(screenFor(pageState(dock)), 'error');
});

// Table 1.1 row 13 (coordinator.js:1523-1524): quote finished -> { phase: 'finished', tone: 'good', ...done, title, sub, button: 'dock-summary', alt: 'fill-again' }.
test('table 1.1 #13: finished maps to finished', () => {
  const done = DOCK.finished('AmWINS');
  const dock = {
    phase: 'finished',
    tone: /** @type {const} */ ('good'),
    ...done,
    title: done.title,
    sub: `Total premium $12,450. ${done.sub}`,
    button: 'dock-summary',
    alt: 'fill-again',
  };
  assert.equal(screenFor(pageState(dock)), 'finished');
});

// Table 1.1 row 14 (coordinator.js:1530): stopped fill -> { phase: 'stopped-fill', tone: 'warn', ...DOCK.stoppedFill(filled), button: 'fill' }.
test('table 1.1 #14: stopped-fill maps to stopped-fill', () => {
  const dock = {
    phase: 'stopped-fill',
    tone: /** @type {const} */ ('warn'),
    ...DOCK.stoppedFill(6),
    button: 'fill',
  };
  assert.equal(screenFor(pageState(dock)), 'stopped-fill');
});

// Table 1.1 row 15 (coordinator.js:1537-1538): AI picks ready -> { phase: 'ai', tone: 'ai', eyebrow, title, sub, button: 'ai-approve', label }.
test('table 1.1 #15: ai maps to ai', () => {
  const dock = {
    phase: 'ai',
    tone: /** @type {const} */ ('ai'),
    eyebrow: DOCK.ai.eyebrow(2),
    title: DOCK.ai.title(2),
    sub: DOCK.ai.sub(false, true),
    button: 'ai-approve',
    label: DOCK.ai.label(2, true),
  };
  assert.equal(screenFor(pageState(dock)), 'ai');
});

// Table 1.1 row 16 (coordinator.js:1555): ready to fill -> { phase: 'ready', ...DOCK.ready(name), sub, ...fill }.
test('table 1.1 #16: ready maps to ready', () => {
  const dock = {
    phase: 'ready',
    ...DOCK.ready('Drivers'),
    sub: DOCK.hint.continues,
    button: 'fill',
    label: DOCK.fill,
  };
  assert.equal(screenFor(pageState(dock)), 'ready');
});

// Table 1.1 row 17 (coordinator.js:1581-1583): filling on active tab -> { phase: 'filling', tone: 'blue', progress, eyebrow, title, sub, button: 'fill-stop', label, disabled }.
test('table 1.1 #17: filling on active tab maps to filling', () => {
  const measured = {
    phase: 'filling',
    tone: /** @type {const} */ ('blue'),
    progress: 0.5,
    progressSaid: FILLING.about(4, 8),
    eyebrow: FILLING.eyebrow(4),
    title: FILLING.justFilled('VIN'),
    sub: FILLING.sub,
    button: 'fill-stop',
    label: FILLING.stop,
    disabled: false,
  };
  const stopping = {
    ...measured,
    progress: true,
    eyebrow: FILLING.stoppingEyebrow,
    title: FILLING.stoppingTitle,
    label: FILLING.stopping,
    disabled: true,
  };
  assert.equal(screenFor(pageState(measured)), 'filling');
  assert.equal(screenFor(pageState(stopping)), 'filling');
});

// Table 1.1 row 18 (coordinator.js:1577): filling unanswered -> { phase: 'filling', tone: 'warn', progress: true, eyebrow, ...FILLING.unanswered, button: 'fill-stop', label, disabled } -> filling (NOT error).
test('table 1.1 #18: filling unanswered stays on filling (not error)', () => {
  const dock = {
    phase: 'filling',
    tone: /** @type {const} */ ('warn'),
    progress: true,
    eyebrow: FILLING.eyebrow(3),
    ...FILLING.unanswered,
    button: 'fill-stop',
    label: FILLING.stop,
    disabled: false,
  };
  assert.equal(screenFor(pageState(dock)), 'filling');
});

// Table 1.1 row 19 (coordinator.js:1573): filling on another tab -> { phase: 'elsewhere', tone: 'blue', progress: true, eyebrow, title, sub, button: 'fill-stop', label, disabled }.
test('table 1.1 #19: elsewhere maps to elsewhere', () => {
  const there = FILLING.elsewhere('Progressive');
  const dock = {
    phase: 'elsewhere',
    tone: /** @type {const} */ ('blue'),
    progress: true,
    eyebrow: FILLING.eyebrow(2),
    title: there.title,
    sub: there.sub,
    button: 'fill-stop',
    label: FILLING.stop,
    disabled: false,
  };
  assert.equal(screenFor(pageState(dock)), 'elsewhere');
});

// Table 1.1 row 20 (coordinator.js:1289-1290, 1542): needs with dock-next (Show the next one / Skip to the next one) -> review.
test('table 1.1 #20: needs with dock-next maps to review', () => {
  const dock = {
    phase: 'needs',
    tone: /** @type {const} */ ('warn'),
    eyebrow: CONTINUE.needs.eyebrow(5, 2),
    title: CONTINUE.needs.title(2),
    sub: CONTINUE.next.followUps,
    button: 'dock-next',
    label: CONTINUE.needs.label,
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(dock)), 'review');
  assert.equal(screenFor(pageState({ ...dock, label: DOCK.skipNext })), 'review');
});

// Table 1.1 row 21 (coordinator.js:1278): needs covered -> { phase: 'needs', tone: 'warn', eyebrow, ...CONTINUE.covered, alt: 'fill-again', altLabel } -> review.
test('table 1.1 #21: needs covered maps to review', () => {
  const dock = {
    phase: 'needs',
    tone: /** @type {const} */ ('warn'),
    eyebrow: CONTINUE.filled(5),
    ...CONTINUE.covered,
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(dock)), 'review');
});

// Table 1.1 row 22 (coordinator.js:1285-1287): waiting (buttons left, Progressive) -> review.
test('table 1.1 #22: waiting buttons left maps to review', () => {
  const dock = {
    phase: 'waiting',
    tone: /** @type {const} */ ('blue'),
    eyebrow: CONTINUE.filled(8),
    title: CONTINUE.buttonsLeft.title,
    sub: CONTINUE.buttonsLeft.sub,
    button: 'fill',
    label: CONTINUE.buttonsLeft.continue,
    go: 'continue',
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(dock)), 'review');
});

// Table 1.1 row 23 (coordinator.js:1293): check (Looks right, continue) -> review.
test('table 1.1 #23: dock phase check (Looks right, continue) maps to review', () => {
  const dock = {
    phase: 'check',
    tone: /** @type {const} */ ('good'),
    ...CONTINUE.check,
    button: 'look-right',
    label: CONTINUE.looksRight,
  };
  assert.equal(screenFor(pageState(dock)), 'review');
});

// Table 1.1 row 24 (coordinator.js:1292): check page changed -> review.
test('table 1.1 #24: dock phase check (page changed) maps to review', () => {
  const dock = {
    phase: 'check',
    tone: /** @type {const} */ ('warn'),
    ...CONTINUE.changed,
    button: 'look-right',
    label: CONTINUE.looksRight,
  };
  assert.equal(screenFor(pageState(dock)), 'review');
});

// Table 1.1 row 25 (coordinator.js:1294-1295): yours offSteps / offList (alt: 'fill-again') -> review.
test('table 1.1 #25: yours offSteps and offList (alt fill-again) map to review', () => {
  const offSteps = {
    phase: 'yours',
    tone: /** @type {const} */ ('good'),
    ...CONTINUE.offSteps,
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  const offList = {
    phase: 'yours',
    tone: /** @type {const} */ ('good'),
    ...CONTINUE.offList,
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(offSteps)), 'review');
  assert.equal(screenFor(pageState(offList)), 'review');
});

// Table 1.1 row 26 (coordinator.js:1297-1305): ready-continue (manual and autoAdvance) -> review.
test('table 1.1 #26: ready-continue maps to review', () => {
  const manual = {
    phase: 'ready-continue',
    tone: /** @type {const} */ ('good'),
    eyebrow: CONTINUE.ready.eyebrow,
    title: CONTINUE.ready.title,
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
    sub: CONTINUE.ready.manual,
  };
  const auto = {
    phase: 'ready-continue',
    tone: /** @type {const} */ ('good'),
    eyebrow: CONTINUE.ready.eyebrow,
    title: CONTINUE.ready.title,
    sub: CONTINUE.ready.sub,
    button: 'fill',
    label: CONTINUE.ready.label,
    go: 'continue',
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(manual)), 'review');
  assert.equal(screenFor(pageState(auto)), 'review');
});

// Table 1.1 row 27 (coordinator.js:1267): done (Continue clicked) -> continued.
test('table 1.1 #27: done (Continue clicked) maps to continued', () => {
  const dock = {
    phase: 'done',
    tone: /** @type {const} */ ('good'),
    ...CONTINUE.continued('Continue'),
    alt: 'fill-again',
    altLabel: CONTINUE.fillAgain,
  };
  assert.equal(screenFor(pageState(dock)), 'continued');
});

// Precedence: settingsOpen over everything; !intake -> start; view === 'check' -> check; renderDock envelope fields (including row 28 paused).
test('precedence: settingsOpen wins over everything, no intake returns start, and view check returns check', () => {
  const readyDock = {
    phase: 'ready',
    ...DOCK.ready('Vehicles'),
    sub: DOCK.hint.continues,
    button: 'fill',
    label: DOCK.fill,
    hidden: false,
    report: '',
    busy: false,
    paused: 'Automatic filling is paused on this tab. Your next Fill turns it back on.',
  };
  const fillingDock = {
    phase: 'filling',
    tone: /** @type {const} */ ('blue'),
    progress: true,
    eyebrow: FILLING.eyebrow(0),
    title: FILLING.reading,
    sub: FILLING.sub,
    button: 'fill-stop',
    label: FILLING.stop,
    disabled: false,
    hidden: false,
    report: '',
    busy: true,
    paused: '',
  };

  // settingsOpen beats no intake, check view, page view and active filling.
  assert.equal(screenFor({ intake: null, view: 'check', settingsOpen: true, dock: null }), 'settings');
  assert.equal(screenFor({ intake: INTAKE, view: 'check', settingsOpen: true, dock: readyDock }), 'settings');
  assert.equal(screenFor({ intake: INTAKE, view: 'page', settingsOpen: true, dock: fillingDock }), 'settings');

  // !intake beats check view, page view and any stale dock when settingsOpen is false.
  assert.equal(screenFor({ intake: null, view: 'check', settingsOpen: false, dock: readyDock }), 'start');
  assert.equal(screenFor({ intake: null, view: 'page', settingsOpen: false, dock: fillingDock }), 'start');
  assert.equal(screenFor(), 'start');

  // view === 'check' beats page dock states when intake is loaded and settingsOpen is false.
  assert.equal(screenFor({ intake: INTAKE, view: 'check', settingsOpen: false, dock: readyDock }), 'check');
  assert.equal(screenFor({ intake: INTAKE, view: 'check', settingsOpen: false, dock: { phase: 'hold', tone: 'warn', ...DOCK.defaultsAsk, button: 'dock-defaults' } }), 'check');
  assert.equal(screenFor({ intake: INTAKE, view: 'check', settingsOpen: false, dock: null }), 'check');

  // renderDock's envelope fields (including row 28's paused footer note) do not alter the screen, and null dock falls back to norater.
  assert.equal(screenFor({ intake: INTAKE, view: 'page', settingsOpen: false, dock: readyDock }), 'ready');
  assert.equal(screenFor({ intake: INTAKE, view: 'page', settingsOpen: false, dock: null }), 'norater');
});

test('screen.js stays pure (no imports, no DOM) and maps every dock phase in coordinator.js', () => {
  const screenSrc = fs.readFileSync(new URL('../sidepanel/panel/screen.js', import.meta.url), 'utf8');
  assert.match(screenSrc.split('\n', 1)[0], /^\/\/ @ts-check$/);
  const withoutComments = screenSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /\bimport\b/, 'screen.js must have no runtime imports');
  assert.doesNotMatch(withoutComments, /\b(document|window|navigator|HTMLElement|Element)\b/, 'screen.js must not touch the DOM');

  const coordSrc = fs.readFileSync(new URL('../sidepanel/panel/coordinator.js', import.meta.url), 'utf8');
  const coordPhases = [...new Set([...coordSrc.matchAll(/phase: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  const mappedPhases = [...new Set([...withoutComments.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))].sort();
  assert.deepEqual(mappedPhases, coordPhases, 'screen.js must map every phase in coordinator.js and no non-existent phase');

  const typesSrc = fs.readFileSync(new URL('../types.js', import.meta.url), 'utf8');
  const unionMatch = typesSrc.match(/@typedef \{([^}]+)\} PanelScreen/);
  assert.ok(unionMatch, 'types.js declares PanelScreen');
  const unionValues = [...unionMatch[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  const returnedValues = [...new Set([...withoutComments.matchAll(/return '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(returnedValues, unionValues, 'every PanelScreen value in types.js is returned by screenFor');
});
