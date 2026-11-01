import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { mountRecordingLine, mountSettings, RecordingLine, Settings } from '../../sidepanel/panel/settings-view.jsx';

// Settings in React (React PR 10, 2026-11-01): what sidepanel.html held and renderAiSettings,
// renderUsage, renderHealth, render, renderSite, captureSaid and the developer recording set with $(),
// drawn from what they say now. What each control then does is the panel's (the safety tests run
// settingsActs, aiActs, openKeyForm, renderAiSettings and the recording's functions); here, that
// Settings draws as before, with its ids, and that each control asks the panel for its own thing, a
// box on its change event and not each key.

let state;
const SWITCHES = { autoPages: true, autoFollowUps: true, autoAdvance: true, checkBeforeContinue: true, overwrite: false, finishSound: true };
beforeEach(() => {
  state = storeState({ switches: SWITCHES, ai: null, keyFormOpen: false, usageCard: null, usageNote: '', health: null, testRun: null, captureOff: false, captureStatus: null,
    devrec: { on: false, status: null, unfinished: null }, recordingLine: false });
});
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);
const acts = (calls, more = {}) => ({
  ...Object.fromEntries(['done', 'upload', 'exportLog', 'clearLog', 'capture', 'keyEdit', 'keySave'].map((name) => [name, () => calls.push([name])])),
  ...Object.fromEntries(['agent', 'serverUrl', 'serverToken', 'testRun', 'aiOn', 'aiAuto'].map((name) => [name, (v) => calls.push([name, v])])),
  switch: (name, on) => calls.push(['switch', name, on]),
  keyKey: (e) => calls.push(['keyKey', e.key]),
  devrec: null,
  ...more,
});

test('the head, the setup note, the initials and the version', () => {
  const calls = [];
  const { container } = render(<Settings act={acts(calls)} />);
  expect($(container, '.settings-head h2').textContent).toBe('Settings');
  fireEvent.click($(container, '#settings-done'));
  expect(calls).toEqual([['done']]);
  const note = $(container, '#setup-note');
  expect([note.hidden, note.getAttribute('role'), $(container, '#version').textContent]).toEqual([true, 'status', '']);
  act(() => { state.health = { version: 'Version 0.9.28', setup: 'To finish setup, add your initials and set the usage server (Advanced).', agentMissing: true }; });
  expect([note.hidden, $(container, '#setup-text').textContent, $(container, '#version').textContent])
    .toEqual([false, 'To finish setup, add your initials and set the usage server (Advanced).', 'Version 0.9.28']);
  // The initials: marked while empty, kept short, and saved when the agent leaves the box, not on each key.
  const agent = $(container, '#agent');
  expect([agent.className, agent.maxLength, agent.placeholder]).toEqual(['missing', 6, 'e.g. JK']);
  agent.value = 'jk';
  fireEvent.input(agent);
  expect(calls).toEqual([['done']]);
  fireEvent.change(agent);
  expect(calls.at(-1)).toEqual(['agent', 'jk']);
  act(() => { state.health = { ...state.health, setup: null, agentMissing: false }; });
  expect([note.hidden, agent.className]).toEqual([true, '']);
});

test('the Filling switches: in order, as saved, Let me look first off with Continue, and each asks for its own name', () => {
  const calls = [];
  const { container } = render(<Settings act={acts(calls)} />);
  const boxes = [...container.querySelectorAll('.group .card .opt input[role="switch"]')].slice(0, 6);
  expect(boxes.map((b) => [b.id, b.className, b.checked])).toEqual([
    ['auto-pages', 'switch', true], ['auto-followups', 'switch', true], ['auto-advance', 'switch', true],
    ['check-continue', 'switch', true], ['overwrite', 'switch', false], ['finish-sound', 'switch', true]]);
  expect(boxes.map((b) => b.closest('label').querySelector('b').textContent)).toEqual([
    'Fill pages when they open', 'Fill follow-up questions', 'Continue when the page is done', 'Let me look first', 'Replace prefilled answers', 'Sound when the quote is done']);
  const row = $(container, '#check-continue-row');
  expect([row.className, row.title]).toEqual(['opt sub', 'Waits for you to press Looks right, continue']);
  for (const b of boxes) fireEvent.click(b);
  expect(calls).toEqual([['switch', 'autoPages', false], ['switch', 'autoFollowUps', false], ['switch', 'autoAdvance', false],
    ['switch', 'checkBeforeContinue', false], ['switch', 'overwrite', true], ['switch', 'finishSound', false]]);
  // As saved (init) or switched: each box shows what the panel says whenever it says the switches
  // again, and Let me look first is off with Continue.
  act(() => { state.switches = { ...SWITCHES, autoAdvance: false, finishSound: false }; });
  expect([$(container, '#auto-advance').checked, $(container, '#finish-sound').checked, $(container, '#check-continue').disabled, $(container, '#auto-pages').checked])
    .toEqual([false, false, true, true]);
  act(() => { state.switches = SWITCHES; });
  expect([$(container, '#auto-advance').checked, $(container, '#check-continue').disabled, $(container, '#auto-pages').checked]).toEqual([true, false, true]);
  expect($(container, '.group > .fine').textContent).toBe('Never Binds or Submits.');
});

test('the AI\'s card: its row\'s note, opened by itself without a key, its switches, and the key\'s box', () => {
  const calls = [];
  const { container } = render(<Settings act={acts(calls)} />);
  const fold = $(container, '#assistant');
  expect([fold.tagName, fold.open, $(container, '#ai-note').textContent, $(container, '#key-edit').textContent]).toEqual(['DETAILS', false, '', 'Add key']);
  const ai = { on: true, auto: false, autoOff: false, autoShown: true, keyStatus: 'Not added yet', keyTone: 'warn', keyEdit: 'Add key', warn: true, note: 'Needs a key', noteTone: 'warn' };
  act(() => { state.ai = ai; });
  expect([fold.open, $(container, '#agent-card').className, $(container, '#ai-note').textContent, $(container, '#ai-note').className])
    .toEqual([true, 'card warn', 'Needs a key', 'warn']);
  expect([$(container, '#key-status').textContent, $(container, '#key-status').className, $(container, '#ai-on').checked, $(container, '#ai-auto').checked, $(container, '#ai-auto').disabled])
    .toEqual(['Not added yet', 'warn', true, false, false]);
  // Folded by the agent: opened again only when the panel says it again.
  fold.open = false;
  act(() => { state.keyFormOpen = false; });
  expect(fold.open).toBe(false);
  act(() => { state.ai = { ...ai }; });
  expect(fold.open).toBe(true);
  // The switches ask for their own thing; the agent's click stays until the panel says otherwise.
  fireEvent.click($(container, '#ai-auto'));
  fireEvent.click($(container, '#ai-on'));
  expect(calls).toEqual([['aiAuto', true], ['aiOn', false]]);
  act(() => { state.ai = { ...ai, on: false, autoOff: true, warn: false, note: 'Off', noteTone: 'off' }; });
  expect([$(container, '#ai-on').checked, $(container, '#ai-auto').checked, $(container, '#ai-auto').disabled, $(container, '#agent-card').className])
    .toEqual([false, false, true, 'card']);
  act(() => { state.ai = { ...state.ai, autoShown: false }; });
  expect($(container, '#ai-auto-option').hidden).toBe(true);
  // The key's button opens its box and says Cancel; the box is the panel's to fill (openKeyForm).
  const edit = $(container, '#key-edit');
  const form = $(container, '#key-form');
  expect([edit.getAttribute('aria-controls'), edit.getAttribute('aria-expanded'), form.hidden]).toEqual(['key-form', 'false', true]);
  fireEvent.click(edit);
  act(() => { state.keyFormOpen = true; });
  expect([edit.getAttribute('aria-expanded'), edit.textContent, form.hidden]).toEqual(['true', 'Cancel', false]);
  const key = $(container, '#ai-openai-key');
  expect([key.type, key.autocomplete, key.getAttribute('aria-labelledby'), key.value]).toEqual(['password', 'off', 'key-label', '']);
  fireEvent.keyDown(key, { key: 'Enter' });
  fireEvent.click($(container, '#key-save'));
  act(() => { state.keyFormOpen = false; state.ai = { ...state.ai, keyEdit: 'Change' }; });
  expect([edit.getAttribute('aria-expanded'), edit.textContent, form.hidden]).toEqual(['false', 'Change', true]);
  expect(calls.slice(2)).toEqual([['keyEdit'], ['keyKey', 'Enter'], ['keySave']]);
});

test('the usage card: the last upload in its tone, what waits, and the line under it', () => {
  const { container } = render(<Settings act={acts([])} />);
  const status = $(container, '#upload-status');
  expect([status.className, status.textContent, $(container, '#usage-count').textContent]).toEqual(['status-line', '', '']);
  act(() => { state.usageCard = { count: '12 events waiting on this computer.', upload: 'No server set. Use Export log to hand it in.', uploadTone: 'warn' }; state.usageNote = 'Usage log cleared.'; });
  expect([status.className, status.textContent, $(container, '#usage-count').textContent]).toEqual(['status-line warn', 'No server set. Use Export log to hand it in.', '12 events waiting on this computer.']);
  const note = $(container, '#usage-note');
  expect([note.getAttribute('aria-live'), note.textContent]).toEqual(['polite', 'Usage log cleared.']);
});

test('Advanced: the test-run mark with an intake, the server boxes on their change, Capture and the usage buttons', () => {
  const calls = [];
  const { container } = render(<Settings act={acts(calls)} />);
  const advanced = $(container, '#advanced');
  expect([advanced.tagName, advanced.open, advanced.querySelector('summary').textContent]).toEqual(['DETAILS', false, 'Advanced, for setup only']);
  const row = $(container, '#test-run-row');
  expect([row.hidden, row.textContent]).toEqual([true, ' This intake is a test run, not a client']);
  act(() => { state.testRun = false; });
  expect([row.hidden, $(container, '#test-run').checked]).toEqual([false, false]);
  fireEvent.click($(container, '#test-run'));
  expect(calls).toEqual([['testRun', true]]);
  act(() => { state.testRun = true; });
  expect($(container, '#test-run').checked).toBe(true);
  // The server, its token, the scenario and the note: boxes the panel reads by id.
  const url = $(container, '#server-url');
  const token = $(container, '#server-token');
  expect([url.type, token.type, $(container, '#capture-scenario').maxLength, $(container, '#capture-note').maxLength]).toEqual(['url', 'password', 60, 200]);
  url.value = 'https://usage.example';
  fireEvent.input(url);
  expect(calls.length).toBe(1);
  fireEvent.change(url);
  token.value = 'tok';
  fireEvent.change(token);
  expect(calls.slice(1)).toEqual([['serverUrl', 'https://usage.example'], ['serverToken', 'tok']]);
  // Capture page layout off without a carrier page; what it did under it.
  const capture = $(container, '#capture');
  expect([capture.disabled, $(container, '#capture-status').hidden]).toEqual([false, true]);
  act(() => { state.captureOff = true; state.captureStatus = 'Open a carrier page to capture its layout.'; });
  expect([capture.disabled, $(container, '#capture-status').hidden, $(container, '#capture-status').textContent]).toEqual([true, false, 'Open a carrier page to capture its layout.']);
  act(() => { state.captureOff = false; });
  for (const id of ['capture', 'upload-usage', 'export-usage', 'clear-usage']) fireEvent.click($(container, `#${id}`));
  expect(calls.slice(3)).toEqual([['capture'], ['upload'], ['exportLog'], ['clearLog']]);
  expect($(container, '#clear-usage').className).toBe('ghost small-btn danger');
});

test('the developer recording: only with its buttons, which follow a recording, the unfinished one to save, and its line', () => {
  const none = render(<Settings act={acts([])} />);
  expect($(none.container, '#devrec').hidden, 'a store build: no card').toBe(true);
  cleanup();
  const calls = [];
  const devrec = Object.fromEntries(['start', 'note', 'stop', 'recover'].map((name) => [name, () => calls.push(name)]));
  const { container } = render(<Settings act={acts([], { devrec })} />);
  const shown = () => ['devrec-start', 'devrec-note', 'devrec-stop', 'devrec-recover'].filter((id) => !$(container, `#${id}`).hidden);
  expect([$(container, '#devrec').hidden, shown(), $(container, '#devrec-status').hidden]).toEqual([false, ['devrec-start'], true]);
  fireEvent.click($(container, '#devrec-start'));
  act(() => { state.devrec = { on: true, status: 'Recording 0:05 · 12 events.', unfinished: { id: 'geico-x', label: 'Save 2 unfinished recordings, one by one' } }; });
  expect(shown()).toEqual(['devrec-note', 'devrec-stop', 'devrec-recover']);
  expect([$(container, '#devrec-recover').textContent, $(container, '#devrec-recover').dataset.id]).toEqual(['Save 2 unfinished recordings, one by one', 'geico-x']);
  expect([$(container, '#devrec-status').hidden, $(container, '#devrec-status').getAttribute('role'), $(container, '#devrec-status').textContent]).toEqual([false, 'status', 'Recording 0:05 · 12 events.']);
  expect($(container, '#advanced > summary').textContent, 'seen with Advanced folded').toBe('Advanced, for setup only · Recording');
  for (const id of ['devrec-note', 'devrec-stop', 'devrec-recover']) fireEvent.click($(container, `#${id}`));
  expect(calls).toEqual(['start', 'note', 'stop', 'recover']);
});

test('the footer\'s Recording usage line: hidden until said', () => {
  const { container } = render(<RecordingLine />);
  const line = $(container, '#recording');
  expect([line.className, line.hidden, line.textContent, line.title]).toEqual(['recording', true, '● Recording usage', 'Usage is recorded, never client information. See Settings.']);
  act(() => { state.recordingLine = true; });
  expect(line.hidden).toBe(false);
});

test('mountSettings and mountRecordingLine draw before they return', () => {
  const host = document.body.appendChild(document.createElement('section'));
  const foot = document.body.appendChild(document.createElement('span'));
  act(() => {
    mountSettings(host, acts([]));
    mountRecordingLine(foot);
    const ids = ['settings-done', 'setup-note', 'agent', 'auto-pages', 'auto-followups', 'auto-advance', 'check-continue', 'overwrite', 'finish-sound', 'assistant', 'ai-on', 'ai-auto',
      'key-edit', 'key-form', 'ai-openai-key', 'key-save', 'usage', 'upload-status', 'usage-count', 'usage-note', 'advanced', 'test-run', 'server-url', 'server-token',
      'capture-scenario', 'capture-note', 'capture', 'upload-usage', 'export-usage', 'clear-usage', 'capture-status', 'devrec', 'version'];
    expect(ids.filter((id) => !host.querySelector(`#${id}`))).toEqual([]);
    expect(!!foot.querySelector('#recording')).toBe(true);
  });
  host.remove();
  foot.remove();
});
