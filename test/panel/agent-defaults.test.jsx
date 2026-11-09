// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import * as usage from '../../sidepanel/usage-log.js';
import { state as panelState } from '../../sidepanel/panel/core.js';
import { DefaultsChip, DefaultsDevSwitch, TniDefaults } from '../../sidepanel/panel/agent-defaults/view.jsx';
import {
  answerDefaults, defaultsActs, defaultsHold, defaultsShownFor, fillDefaultsHash, setDefaultsShown, initialsChanged, isOwnDefault, loadDefaults, onDefaultsAnswer, refreshDefaults, settingsDefaults,
} from '../../sidepanel/panel/agent-defaults/store.js';
import { RELEASED_TO_AGENTS, agentDefaultsOn, overlayFor } from '../../src/agent-defaults/index.js';

// Agents' own defaults in the panel (docs/agent-defaults-spec.md, phase 5): Settings → Your defaults
// keeps the agent's profiles, and each quote asks whose defaults it fills with before anything fills.

afterEach(cleanup);

// Agents' store build has the feature only once TNI's managers approve it (RELEASED_TO_AGENTS); every
// other copy has it unless the developer hid it. These tests run as the repository's files ('source').
test('the feature: in the store build only once released, elsewhere unless the developer hid it', () => {
  expect(RELEASED_TO_AGENTS).toBe(false);
  expect(defaultsShownFor('store', false)).toBe(RELEASED_TO_AGENTS);
  expect(defaultsShownFor('store', true)).toBe(RELEASED_TO_AGENTS);
  expect(defaultsShownFor('unpacked', false)).toBe(true);
  expect(defaultsShownFor('unpacked', true)).toBe(false);
  expect(defaultsShownFor('source', false)).toBe(true);
  expect(agentDefaultsOn()).toBe(true);
  expect(panelState.defaultsOn).toBe(true);
  expect(panelState.defaultsDev).toBe(true);
});

// The section, drawn from the store.
const PROFILE = { v: 1, active: 'p1', profiles: { p1: { name: 'Jordan K.', values: { medPay: { value: 1_000 } } }, p2: { name: 'Sam', values: {} } } };
const actsOf = (calls) => Object.fromEntries(['create', 'pick', 'remove', 'set', 'setCarrier'].map((name) => [name, (...a) => calls.push([name, ...a])]));

test('without initials the section asks for them, and offers no profile', () => {
  storeState({ defaultsOn: true, agentDefaults: PROFILE, defaultsInitials: null });
  const { container } = render(<TniDefaults act={actsOf([])} />);
  expect(container.textContent).toMatch(/Set your initials above/);
  expect(container.querySelector('#defaults-summary').textContent).toBe('Set your initials first');
  expect(container.querySelector('#defaults-profile')).toBeNull();
});

test('with initials: the profile, each standard with TNI\'s amount first, and the agent\'s picks', () => {
  storeState({ defaultsOn: true, agentDefaults: PROFILE, defaultsInitials: 'JK' });
  const calls = [];
  const { container } = render(<TniDefaults act={actsOf(calls)} />);
  const profile = container.querySelector('#defaults-profile');
  expect([...profile.options].map((o) => o.textContent)).toEqual(['None: TNI\'s everywhere', 'Jordan K.', 'Sam']);
  expect(profile.value).toBe('p1');
  // One folded row, as AI's: the profile in force and how many amounts it changes.
  expect(container.querySelector('#defaults-fold').open).toBe(false);
  expect(container.querySelector('#defaults-summary').textContent).toBe('Jordan K. · 1 changed');
  expect(container.querySelector('#defaults-fold > summary').title).toMatch(/When your profile changes any, each quote asks first\. Client requests on the intake always win\./);
  const med = container.querySelector('#default-medPay');
  expect([...med.options].map((o) => o.textContent)).toEqual(['TNI\'s ($5,000)', '$500', '$1,000', '$2,000']);
  expect(med.selectedOptions[0].textContent).toBe('$1,000');
  expect(med.closest('label').title).toBe('TNI\'s: $5,000');
  const rental = container.querySelector('#default-rental');
  expect([...rental.options].map((o) => o.textContent)).toEqual(['TNI\'s ($40/day, $1,200)', '$30/day, $900', '$50/day, $1,500', '$100/day, $3,000']);
  expect(container.querySelectorAll('select[id^="default-"]').length).toBe(5);
  fireEvent.change(med, { target: { value: '2' } });
  fireEvent.change(rental, { target: { value: '1' } });
  fireEvent.change(container.querySelector('#default-umCsl'), { target: { value: '-1' } });
  fireEvent.change(profile, { target: { value: '' } });
  expect(calls).toEqual([['set', 'medPay', 2_000], ['set', 'rental', { perDay: 50, max: 1_500 }], ['set', 'umCsl', null], ['pick', null]]);
});

// Advanced: each carrier's own row, "As above" first, TNI's there only when the basic row
// replaces it, that carrier's other amounts, then "Ask me".
test('Advanced: a row per carrier and standard, from that carrier\'s list', () => {
  storeState({ defaultsOn: true, agentDefaults: { ...PROFILE, profiles: { ...PROFILE.profiles, p1: { ...PROFILE.profiles.p1, carriers: { geico: { umCsl: { ask: true } } } } } }, defaultsInitials: 'JK' });
  const calls = [];
  const { container } = render(<TniDefaults act={actsOf(calls)} />);
  expect(container.querySelector('#defaults-advanced').open).toBe(false);
  expect(container.querySelector('#defaults-advanced .fold-note').textContent).toBe('1 carrier pick');
  // What it does is a line inside it, not a tooltip keyboard users never see.
  expect(container.querySelector('#defaults-advanced > summary').title).toBe('');
  expect(container.querySelector('#defaults-advanced-about').textContent).toMatch(/Answers that rest on it .* become yours too\./);
  expect([...container.querySelectorAll('.defaults-carrier .eyebrow')].map((e) => e.textContent)).toEqual(['Progressive', 'AmWINS', 'GEICO']);
  expect(container.querySelectorAll('select[id^="advanced-"]').length).toBe(15);
  const med = container.querySelector('#advanced-geico-medPay');
  expect([...med.options].map((o) => o.textContent)).toEqual(['As above ($1,000)', 'TNI\'s ($5,000)', '$500', '$2,000', 'Ask me']);
  expect(med.value).toBe('same');
  const um = container.querySelector('#advanced-amwins-umCsl');
  expect([...um.options].map((o) => o.textContent)).toEqual(['As above ($100,000)', '$300,000', '$500,000', '$750,000', '$1,000,000', '$1,500,000', '$2,000,000', 'Ask me']);
  expect(container.querySelector('#advanced-geico-umCsl').value).toBe('ask');
  fireEvent.change(med, { target: { value: 'ask' } });
  fireEvent.change(med, { target: { value: 'tni' } });
  fireEvent.change(med, { target: { value: '1' } });
  fireEvent.change(container.querySelector('#advanced-geico-umCsl'), { target: { value: 'same' } });
  fireEvent.change(um, { target: { value: '5' } });
  expect(calls).toEqual([['setCarrier', 'geico', 'medPay', 'ask'], ['setCarrier', 'geico', 'medPay', 5_000], ['setCarrier', 'geico', 'medPay', 2_000],
    ['setCarrier', 'geico', 'umCsl', null], ['setCarrier', 'amwins', 'umCsl', 2_000_000]]);
});

test('a new profile is named, then created', () => {
  storeState({ defaultsOn: true, agentDefaults: { v: 1, active: null, profiles: {} }, defaultsInitials: 'JK' });
  const calls = [];
  const { container, getByText } = render(<TniDefaults act={actsOf(calls)} />);
  expect(container.querySelector('#default-medPay')).toBeNull();
  fireEvent.click(getByText('New profile'));
  fireEvent.change(container.querySelector('#defaults-new-name'), { target: { value: 'Jordan K.' } });
  fireEvent.click(getByText('Create'));
  expect(calls).toEqual([['create', 'Jordan K.']]);
});

// Delete profile asks in the panel, never with a browser dialog (audit 2026-11-07, UX-17).
test('Delete profile asks first, in the panel: Cancel keeps the profile, Delete removes it', () => {
  const s = storeState({ defaultsOn: true, agentDefaults: { v: 1, active: 'p1', profiles: { p1: { name: 'Jordan K.', values: {} } } }, defaultsInitials: 'JK' });
  const calls = [];
  const dialog = globalThis.confirm;
  globalThis.confirm = () => { throw new Error('no browser dialog'); };
  try {
    const { container, getByText } = render(<TniDefaults act={actsOf(calls)} />);
    expect(container.querySelector('#defaults-confirm')).toBeNull();
    fireEvent.click(getByText('Delete profile'));
    expect(container.querySelector('#defaults-confirm-text').textContent).toBe("Delete Jordan K.'s defaults?");
    expect(container.querySelector('#defaults-delete')).toBeNull();
    // The focus goes to Cancel, and back to Delete profile once the question closes (a keyboard user's).
    expect(document.activeElement?.id).toBe('defaults-confirm-no');
    fireEvent.click(container.querySelector('#defaults-confirm-no'));
    expect([container.querySelector('#defaults-confirm'), calls, document.activeElement?.id]).toEqual([null, [], 'defaults-delete']);
    fireEvent.click(getByText('Delete profile'));
    fireEvent.click(container.querySelector('#defaults-confirm-yes'));
    expect(calls).toEqual([['remove', 'p1']]);
    expect([container.querySelector('#defaults-confirm'), document.activeElement?.id]).toEqual([null, 'defaults-delete']);
    // The deletion saved takes Delete profile away: the focus goes to the Profile menu, which stays.
    act(() => { s.agentDefaults = { v: 1, active: null, profiles: {} }; });
    expect([container.querySelector('#defaults-delete'), document.activeElement?.id]).toEqual([null, 'defaults-profile']);
  } finally { globalThis.confirm = dialog; }
});

// The store: what the quote waits on, logs and fills with.
let answers;
beforeEach(async () => {
  storeState({ cards: {}, agentDefaults: null, defaultsInitials: null, intake: null });
  usage.restoreSession(null);
  await usage.saveSettings({ agent: 'JK' });
  await setDefaultsShown(true);
  await loadDefaults();
  // Each test starts with no profile (outside the extension the store keeps them in memory).
  for (const id of Object.keys(panelState.agentDefaults.profiles)) await defaultsActs().remove(id);
  answers = [];
  onDefaultsAnswer((choice) => { answers.push(choice); return answerDefaults(choice); });
});

async function profileWithMedPay() {
  const acts = defaultsActs();
  await acts.create('Jordan K.');
  await acts.set('medPay', 2_000);
}
const loadQuote = () => {
  panelState.intake = { record: {} };
  usage.startSession('intake-1');
  refreshDefaults();
};

test('a quote waits for the agent to say whose defaults it takes, then fills and logs with them', async () => {
  await profileWithMedPay();
  expect(defaultsHold()).toBe(false); // no quote yet
  loadQuote();
  expect(defaultsHold()).toBe(true);
  expect(settingsDefaults()).toBeUndefined();
  expect(overlayFor('geico')).toBeNull();
  const card = panelState.cards.defaults;
  expect(card.title).toBe('Fill this quote with Jordan K.\'s defaults?');
  expect(card.notes).toEqual(['Medical payments: $2,000 (TNI\'s: $5,000)']);
  expect(card.actions.map((a) => a.label)).toEqual(['Yes, mine', 'Use TNI\'s']);
  await card.actions[0].onClick();
  expect(answers).toEqual(['mine']);
  expect(defaultsHold()).toBe(false);
  expect(settingsDefaults()).toEqual([{ id: 'medPay', value: 2_000 }]);
  expect(fillDefaultsHash()).toMatch(/^[0-9a-f]{12}$/);
  expect(overlayFor('geico')).toBeTypeOf('function');
  // Answered: no card above the answers; the client strip's pill says it.
  expect(panelState.cards.defaults).toBeNull();
  expect(panelState.defaultsChip.label).toBe('Jordan K.\'s defaults: 1 in place of TNI\'s');
  expect(panelState.defaultsChip.short).toBe('1 yours');
  expect(panelState.defaultsChip.lines).toEqual([{ label: 'Medical payments', value: '$2,000', tni: '$5,000' }]);
  // Use TNI's for this quote: TNI's everywhere, logged as an empty list.
  await answerDefaults('tni');
  expect(settingsDefaults()).toEqual([]);
  expect(fillDefaultsHash()).toBeUndefined();
  expect(overlayFor('geico')).toBeNull();
  expect(panelState.cards.defaults).toBeNull();
  expect(panelState.defaultsChip.title).toBe('TNI\'s standards for this quote');
  expect(panelState.defaultsChip.action.label).toBe('Use Jordan K.\'s');
  expect(panelState.defaultsChip.short).toBe('TNI\'s');
  // The next quote asks again.
  loadQuote();
  expect(defaultsHold()).toBe(true);
});

// "Yes, mine" is for the amounts it was given for: an edited, switched or deleted profile asks again
// (and logs again once answered); "Use TNI's" stands whatever the profile does.
test('a profile changed after "Yes, mine" asks the quote again before anything fills with it', async () => {
  await profileWithMedPay();
  loadQuote();
  await answerDefaults('mine');
  expect(defaultsHold()).toBe(false);
  // An amount edited: asked again, nothing fills with the new amount, nothing logged for it yet.
  await defaultsActs().set('medPay', 1_000);
  expect(defaultsHold()).toBe(true);
  expect(settingsDefaults()).toBeUndefined();
  expect(fillDefaultsHash()).toBeUndefined();
  expect(overlayFor('geico')).toBeNull();
  expect(panelState.cards.defaults.title).toBe('Fill this quote with Jordan K.\'s defaults?');
  await answerDefaults('mine');
  expect(defaultsHold()).toBe(false);
  expect(settingsDefaults()).toEqual([{ id: 'medPay', value: 1_000 }]);
  // Another profile picked: asked again.
  const first = panelState.agentDefaults.active;
  await defaultsActs().create('Sam');
  await defaultsActs().set('umCsl', 300_000);
  expect(defaultsHold()).toBe(true);
  // Back to the approved one, as it was: its answer stands.
  await defaultsActs().pick(first);
  expect(defaultsHold()).toBe(false);
  // New initials, then the same profile again: asked again.
  await initialsChanged('XY');
  await defaultsActs().pick(first);
  expect(defaultsHold()).toBe(true);
  // "Use TNI's" stands through an edit.
  await answerDefaults('tni');
  await defaultsActs().set('medPay', 2_000);
  expect(defaultsHold()).toBe(false);
  expect(settingsDefaults()).toEqual([]);
});

test('no question without a profile replacing something, without initials, or without a quote', async () => {
  loadQuote();
  expect(defaultsHold()).toBe(false); // no profile
  const acts = defaultsActs();
  await acts.create('Jordan K.');
  expect(defaultsHold()).toBe(false); // a profile with TNI's everywhere
  await acts.set('medPay', 5_000); // TNI's own amount
  expect(defaultsHold()).toBe(false);
  await acts.set('medPay', 2_000);
  expect(defaultsHold()).toBe(true);
  // New initials: no active profile until one is picked again.
  await initialsChanged('XY');
  expect(panelState.agentDefaults.active).toBeNull();
  expect(defaultsHold()).toBe(false);
  expect(panelState.cards.defaults).toBeNull();
  await defaultsActs().pick(Object.keys(panelState.agentDefaults.profiles)[0]);
  expect(defaultsHold()).toBe(true);
  // Blank initials: TNI's everywhere, nothing asked.
  await initialsChanged(null);
  await defaultsActs().pick(Object.keys(panelState.agentDefaults.profiles)[0]);
  expect(defaultsHold()).toBe(false);
  // The client cleared: no question.
  await initialsChanged('JK');
  await defaultsActs().pick(Object.keys(panelState.agentDefaults.profiles)[0]);
  panelState.intake = null;
  refreshDefaults();
  expect(defaultsHold()).toBe(false);
  expect(panelState.cards.defaults).toBeNull();
});

test('profiles: ids are random, a deleted active profile leaves none active, an unknown standard is refused', async () => {
  const acts = defaultsActs();
  await acts.create('Jordan K.');
  await acts.create('Sam');
  const ids = Object.keys(panelState.agentDefaults.profiles);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await acts.set('nope', 1);
  await acts.set('medPay', 2_000);
  const active = panelState.agentDefaults.active;
  expect(panelState.agentDefaults.profiles[active].values).toEqual({ medPay: { value: 2_000 } });
  await acts.set('medPay', null);
  expect(panelState.agentDefaults.profiles[active].values).toEqual({});
  await acts.remove(active);
  expect(panelState.agentDefaults.active).toBeNull();
  expect(Object.keys(panelState.agentDefaults.profiles)).toHaveLength(1);
});

// Every report row the panel builds from a fill keeps "Your default": the page's report and the
// rows an automatic follow-up adds to it.
test('report rows from a fill and from a follow-up both carry the agent\'s own default', async () => {
  const fs = await import('node:fs');
  for (const file of ['sidepanel/panel/fill.js', 'sidepanel/panel/coordinator.js']) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = text.match(/standard: isStandard\(x, 'filled'\)[^\n]*/g) ?? [];
    expect(rows.length, file).toBeGreaterThan(0);
    for (const row of rows) expect(row, file).toContain("own: isOwnDefault(x, 'filled')");
  }
});

test('Advanced picks alone ask the quote too, and the card and the log name their carrier', async () => {
  const acts = defaultsActs();
  await acts.create('Jordan K.');
  await acts.setCarrier('geico', 'umCsl', 500_000);
  await acts.setCarrier('nowhere', 'umCsl', 500_000);
  await acts.setCarrier('geico', 'nope', 1);
  const id = panelState.agentDefaults.active;
  expect(panelState.agentDefaults.profiles[id].carriers).toEqual({ geico: { umCsl: { value: 500_000 } } });
  loadQuote();
  expect(defaultsHold()).toBe(true);
  expect(panelState.cards.defaults.notes).toEqual(['GEICO only: Uninsured / underinsured motorist (CSL): $500,000 (TNI\'s: $100,000)']);
  await answerDefaults('mine');
  expect(settingsDefaults()).toEqual([{ id: 'umCsl', value: 500_000, carrier: 'geico' }]);
  expect(overlayFor('geico')).toBeTypeOf('function');
  expect(overlayFor('amwins')).toBeNull();
  // A basic default with TNI's on GEICO and "Ask me" on Progressive.
  await acts.set('medPay', 2_000);
  await acts.setCarrier('geico', 'medPay', 5_000);
  await acts.setCarrier('progressive', 'medPay', 'ask');
  expect(panelState.cards.defaults.notes).toEqual(['Medical payments: $2,000 (TNI\'s: $5,000)', 'Progressive only: Medical payments: you answer it (TNI\'s: $5,000)',
    'GEICO only: Uninsured / underinsured motorist (CSL): $500,000 (TNI\'s: $100,000)', 'GEICO only: Medical payments: TNI\'s $5,000']);
  // Changed after the answer: asked again, then filled and logged with the new picks.
  expect(panelState.cards.defaults.title).toBe('Fill this quote with Jordan K.\'s defaults?');
  await answerDefaults('mine');
  expect(panelState.defaultsChip.count).toBe(4);
  expect(panelState.defaultsChip.lines.map((l) => l.value)).toEqual(['$2,000', 'You answer it', '$500,000', 'TNI\'s $5,000']);
  // The log: basic first, then each carrier's own, carriers in a fixed (alphabetical) order.
  expect(settingsDefaults()).toEqual([{ id: 'medPay', value: 2_000 }, { id: 'umCsl', value: 500_000, carrier: 'geico' },
    { id: 'medPay', value: 5_000, carrier: 'geico' }, { id: 'medPay', value: 'ask', carrier: 'progressive' }]);
  // As above again: the carrier's picks go.
  for (const [c, s] of [['geico', 'umCsl'], ['geico', 'medPay'], ['progressive', 'medPay']]) await acts.setCarrier(c, s, null);
  expect(panelState.agentDefaults.profiles[id].carriers).toEqual({});
  expect(defaultsHold()).toBe(true);
  await answerDefaults('mine');
  expect(settingsDefaults()).toEqual([{ id: 'medPay', value: 2_000 }]);
});

test('an answer is the agent\'s own default by its source', () => {
  expect(isOwnDefault({ source: 'agent-default' }, 'filled')).toBe(true);
  expect(isOwnDefault({ source: 'standard', standard: true }, 'filled')).toBe(false);
});


// The report: an answer the agent's own default gave is its own kind of row, tagged "Your default".
test('a report row from the agent\'s own default is its own kind', async () => {
  const { answerRecord } = await import('../../sidepanel/panel/report-rows.js');
  expect(answerRecord({ label: 'Medical payments', value: '$2,000', own: true, standard: false }).kind).toBe('own');
  expect(answerRecord({ label: 'Medical payments', value: '$5,000', standard: true }).kind).toBe('standard');
  expect(answerRecord({ label: 'Medical payments', value: '$2,000', own: true, edited: true }).kind).toBe('edited');
});

// Once answered, the quote's defaults are a pill in the client strip that says it ("2 yours"), and on
// a click what fills and the switch to TNI's; nothing with the feature off.
test('the client strip\'s pill: 2 yours, then what fills and Use TNI\'s in its popover', () => {
  const calls = [];
  const chip = { choice: 'mine', count: 2, short: '2 yours', label: 'Jordan K.\'s defaults: 2 in place of TNI\'s', title: 'Jordan K.\'s defaults', sub: 'On this quote, in place of TNI\'s standards',
    lines: [{ label: 'Medical payments', value: '$2,000', tni: '$5,000' }, { label: 'Progressive only: Medical payments', value: 'You answer it', tni: '$5,000' }],
    after: 'Switching changes what fills next.', action: { label: 'Use TNI\'s for this quote', onClick: () => calls.push('tni') } };
  storeState({ defaultsOn: true, defaultsChip: chip });
  const { container, getByText } = render(<DefaultsChip />);
  const button = container.querySelector('#defaults-chip');
  expect(button.getAttribute('aria-label')).toBe(chip.label);
  expect(button.className).toContain('own');
  expect(button.textContent).toBe('2 yours');
  const pop = container.querySelector('#defaults-pop');
  expect(pop.hidden).toBe(true);
  fireEvent.click(button);
  expect(pop.hidden).toBe(false);
  expect([...pop.querySelectorAll('.pop-line')].map((l) => l.textContent)).toEqual(['Medical payments$2,000TNI\'s $5,000', 'Progressive only: Medical paymentsYou answer itTNI\'s $5,000']);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(pop.hidden).toBe(true);
  fireEvent.click(button);
  fireEvent.click(getByText('Use TNI\'s for this quote'));
  expect(calls).toEqual(['tni']);
  expect(pop.hidden).toBe(true);
  // Gone with the pill (a new quote): it comes back closed, not open by itself.
  fireEvent.click(button);
  expect(pop.hidden).toBe(false);
  act(() => { panelState.defaultsChip = null; });
  expect(container.querySelector('#defaults-chip')).toBeNull();
  act(() => { panelState.defaultsChip = chip; });
  expect(container.querySelector('#defaults-pop').hidden).toBe(true);
  cleanup();
  storeState({ defaultsOn: false, defaultsChip: chip });
  expect(render(<DefaultsChip />).container.querySelector('#defaults-chip')).toBeNull();
});

// The developer's switch hides the whole feature in this copy: no section, no question, no hold, no
// overlay, nothing logged; on again, the quote asks. Kept for the next panel opened.
test('the developer\'s switch hides the whole feature, and shows it again', async () => {
  await profileWithMedPay();
  loadQuote();
  expect(defaultsHold()).toBe(true);
  await setDefaultsShown(false);
  expect(panelState.defaultsOn).toBe(false);
  expect(defaultsHold()).toBe(false);
  expect(panelState.cards.defaults).toBeNull();
  expect(panelState.defaultsChip).toBeNull();
  expect(settingsDefaults()).toBeUndefined();
  await answerDefaults('mine');
  expect(overlayFor('geico')).toBeNull();
  expect(settingsDefaults()).toBeUndefined();
  expect(render(<TniDefaults act={actsOf([])} />).container.querySelector('#tni-defaults')).toBeNull();
  await loadDefaults();
  expect(panelState.defaultsOn).toBe(false);
  // The switch itself, in Advanced.
  const calls = [];
  const box = render(<DefaultsDevSwitch act={(on) => calls.push(on)} />).container.querySelector('#defaults-shown');
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(calls).toEqual([true]);
  // On again: an answer given while hidden doesn't count, so the quote asks before anything fills.
  await setDefaultsShown(true);
  expect(panelState.defaultsOn).toBe(true);
  expect(defaultsHold()).toBe(true);
  expect(overlayFor('geico')).toBeNull();
  await answerDefaults('mine');
  expect(overlayFor('geico')).toBeTypeOf('function');
  expect(panelState.defaultsChip.count).toBe(1);
});
