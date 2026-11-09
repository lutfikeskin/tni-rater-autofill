// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { redactionTerms } from '../src/plan.js';
import { intakeSummary, intakeProfile, sha256Hex, matchIntake, compareText, fieldChangeEvent, fillEvents, redactor, rulesHash, RULE_FILES, STEP_MAX, knownStep, clientErrorEvent, agentSettingsEvent, platformOf, checkDismissedEvent } from '../src/usage.js';

const bytes = new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake.pdf', import.meta.url)));
const raw = await readIntakeFields(pdfjs, bytes.slice());
const result = normalizeIntake(raw, { today: new Date('2026-09-30') });
const { record } = result;
const redact = redactor(redactionTerms(record));

// Client details from the fixture that must never appear in a log event.
const PRIVATE = ['Sample', 'Jordan', 'Casey', 'Example', '1234567', '7654321', '02/03/1988', 'S12345678901', '1FTBR3X87MKA12345', 'Maple', 'Springfield', 'dispatch@', '201-0199'];
const assertNoClientData = (event) => {
  const text = JSON.stringify(event);
  for (const p of PRIVATE) assert.ok(!text.includes(p), `event leaks "${p}": ${text}`);
};

test('intake summary identifies the PDF by fingerprint only', async () => {
  const s = await intakeSummary(bytes, raw, result);
  assert.equal(s.intakeId, await sha256Hex(bytes));
  assert.equal(s.intakeId.length, 64);
  assert.equal(s.state, 'IL');
  assert.deepEqual(s.counts, { drivers: 2, vehicles: 2, trailers: 0 });
  assert.ok(s.warnings.some((w) => w.code === 'vin.invalid' && w.path === 'vehicles[1].vin'));
  assert.ok(s.warnings.every((w) => w.code), 'every warning has a code');
  assertNoClientData(s);
});

test('typed values are matched to intake fields, whatever the format', () => {
  assert.deepEqual(matchIntake(record, '02/03/1988'), ['drivers[0].dob']);
  assert.deepEqual(matchIntake(record, '1988-02-03'), ['drivers[0].dob']);
  assert.deepEqual(matchIntake(record, '1234567'), ['applicant.dot']);
  assert.deepEqual(matchIntake(record, '201'), ['applicant.phone:part']);
  assert.deepEqual(matchIntake(record, 'no'), []);
});

test('compareText', () => {
  assert.equal(compareText('(555) 201-0199', '(555) 201-0199'), 'same');
  assert.equal(compareText('(555) 201-0199', '5552010199'), 'format');
  assert.equal(compareText('Jordan Avery', 'Jordan'), 'different');
  assert.equal(compareText('Jordan Avery', ''), 'cleared');
});

test('agent edits to text boxes are logged without the text', () => {
  const filled = new Map([['295', { path: 'progressive.q295', shown: 'Jordan Avery' }]]);
  const e = fieldChangeEvent({ key: '295', q: '295', label: 'First Name', kind: 'text', before: 'Jordan Avery', after: 'Jordan', agent: true }, { record, filled, redact });
  assert.equal(e.by, 'agent');
  assert.equal(e.vsAutofill, 'different');
  assert.equal(e.change, 'edited');
  assertNoClientData(e);

  const typed = fieldChangeEvent({ key: 'x', q: '2BB', label: 'Date of Birth', kind: 'text', before: '', after: '02/03/1988', agent: true }, { record, filled: new Map(), redact });
  assert.deepEqual(typed.matchesIntake, ['drivers[0].dob']);
  assert.equal(typed.autofilled, null);
  assertNoClientData(typed);
});

// Audit 2026-11-07 LEARN-04: GEICO wraps a driver's name in an analytics <span> inside the label; the
// change and the fill name the field with the same text.
test('change and fill events log a question\'s text without the page\'s markup', () => {
  const label = "<span data-qm-encrypt='true'>Jordan</span>'s   Driver License State";
  const change = fieldChangeEvent({ key: 'ref:GiveLicenseState', label, kind: 'select', before: '', after: 'TX', agent: true }, { record, filled: new Map(), redact });
  const [, fill] = fillEvents([{ filled: [{ key: 'ref:GiveLicenseState', label: "[client]'s Driver License State", controlKind: 'select', shown: 'TX' }] }], { carrier: 'geico', page: '/quote', view: 't1', overwrite: false, ms: 1, redact });
  assert.equal(change.label, "[client]'s Driver License State");
  assert.equal(change.label, fill.label);
});

test('change and fill events name the control, so repeated vehicle rows stay apart', () => {
  const second = fieldChangeEvent({ key: '2B9D@2', q: '2B9D', label: 'Farthest distance', kind: 'select', before: '', after: '500 miles', agent: true }, { record, filled: new Map(), redact });
  assert.deepEqual([second.q, second.key], ['2B9D', '2B9D@2']);
  // A key with client data is redacted, and a digest under the session's secret salt keeps two
  // such controls apart. Without a salt the key is left out rather than merged with the other.
  const owner = (key, keySalt) => fieldChangeEvent({ key, label: 'Owner', kind: 'select', before: '', after: 'Yes', agent: true }, { record, filled: new Map(), redact, keySalt }).key;
  const [jordan, casey] = [owner('owner_Jordan', 'salt-1'), owner('owner_Casey', 'salt-1')];
  assert.match(jordan, /^owner_\[client\]#[0-9a-f]{8}$/);
  assert.notEqual(jordan, casey);
  assert.equal(owner('owner_Jordan', 'salt-1'), jordan, 'the same control keeps its key within the quote');
  assert.notEqual(owner('owner_Jordan', 'salt-2'), jordan, 'another quote\'s salt gives another digest');
  assert.equal(owner('owner_Jordan'), null);
  assertNoClientData({ jordan, casey });
  assert.equal(owner('2B9D@2', 'salt-1'), '2B9D@2', 'keys without client data stay as they are');
  const [, filled] = fillEvents([{ filled: [{ key: '2B9D@3', q: '2B9D', label: 'Farthest distance', controlKind: 'select', shown: '500 miles' }] }], { carrier: 'progressive', page: 'Rates', overwrite: false, ms: 1, redact });
  assert.deepEqual([filled.q, filled.key], ['2B9D', '2B9D@3']);
});

// Audit 2026-11-07, DATA-10: a step without a path or q has a path that is its place in the plan
// (amwins.q73 with one driver, amwins.q80 with two). Its fill_field says what the answer means, its
// rule's concept and TNI entry, which are the same in every quote.
test('a fill_field names its rule\'s concept and TNI entry from the plan it was given', async () => {
  const { buildPlan } = await import('../src/plan.js');
  const { amwins } = await import('../src/carriers/amwins.js');
  const two = { ...record, drivers: [...record.drivers, { ...record.drivers[0], first: 'Second' }] };
  const gender = (plan) => plan.find((s) => s.concept === 'driver.gender' || /gender/i.test(s.name ?? ''));
  const one = gender(buildPlan(record, amwins, {}));
  const other = gender(buildPlan(two, amwins, {}));
  assert.ok(one?.concept, 'AmWINS has a gender question with a concept');
  assert.equal(one.concept, other.concept);
  const plan = buildPlan(record, amwins, {});
  const tnied = plan.find((s) => s.tni && s.concept);
  const frames = [{ filled: [{ stepId: one.id, key: 'k1', label: 'Gender', controlKind: 'select', shown: 'MALE', path: one.path }, { stepId: tnied.id, key: 'k2', label: 'X', controlKind: 'select', shown: 'No', path: tnied.path }, { key: 'k3', label: 'No step' }] }];
  const [, a, b, c] = fillEvents(frames, { carrier: 'amwins', page: '/app', view: 't1', overwrite: false, ms: 1, redact, plan });
  assert.equal(a.concept, one.concept);
  assert.deepEqual([b.concept, b.tni], [tnied.concept, tnied.tni]);
  assert.deepEqual([c.concept, c.tni], [undefined, undefined]);
  const [, without] = fillEvents(frames, { carrier: 'amwins', page: '/app', view: 't1', overwrite: false, ms: 1, redact });
  assert.equal(without.concept, undefined, 'no plan, no concept');
  // The panel gives fillEvents the plan the fill was given, at every logFill.
  const coordinator = fs.readFileSync(new URL('../sidepanel/panel/coordinator.js', import.meta.url), 'utf8');
  const fill = fs.readFileSync(new URL('../sidepanel/panel/fill.js', import.meta.url), 'utf8');
  const calls = [...coordinator.matchAll(/\blogFill\(([^)]*)\)/g), ...fill.matchAll(/\blogFill\(([^)]*)\)/g)].map((m) => m[1]).filter((args) => !args.includes('plan = null'));
  assert.ok(calls.length >= 3);
  for (const args of calls) assert.match(args, /, plan$/, `logFill(${args})`);
  assert.match(coordinator, /keptLogged: state\.keptLogged\.seen, plan,/);
});

// Audit 2026-11-07, DATA-14: an answer from a value the agent corrected in the panel is logged as
// such, so the parser's accuracy isn't counted with the agent's corrections.
test('a fill_field says when its answer read the agent\'s correction, and the panel tells the plan', async () => {
  const [, edited, plain] = fillEvents([{ filled: [
    { key: 'k1', label: 'Date of birth', controlKind: 'text', source: 'intake', path: 'drivers[0].dob', edited: true },
    { key: 'k2', label: 'Date of birth', controlKind: 'text', source: 'intake', path: 'drivers[1].dob' },
  ] }], { carrier: 'progressive', page: 'AddDriver', view: 't1', overwrite: false, ms: 1, redact });
  assert.deepEqual([edited.source, edited.edited], ['intake', true]);
  assert.equal(plain.edited, undefined);
  // CodeRabbit on #480: a failed answer isn't the agent's, even when its step read their correction.
  const [, failedEv] = fillEvents([{ failed: [{ key: 'k1', label: 'Date of birth', controlKind: 'text', source: 'intake', path: 'drivers[0].dob', edited: true, code: 'answer.not-kept', reason: 'x' }] }],
    { carrier: 'progressive', page: 'AddDriver', view: 't1', overwrite: false, ms: 1, redact });
  assert.deepEqual([failedEv.result, failedEv.edited], ['failed', undefined]);
  const { buildPlan } = await import('../src/plan.js');
  const { progressive } = await import('../src/carriers/progressive.js');
  const steps = buildPlan(record, progressive, {}, { edited: ['drivers[0].dob'] }).filter((s) => s.path === 'drivers[0].dob');
  assert.ok(steps.length && steps.every((s) => s.edited === true));
  assert.ok(buildPlan(record, progressive, {}).every((s) => !('edited' in s)), 'no edits, no mark');
  const planFor = fs.readFileSync(new URL('../sidepanel/panel/plan-for.js', import.meta.url), 'utf8');
  const core = fs.readFileSync(new URL('../sidepanel/panel/core.js', import.meta.url), 'utf8');
  assert.match(planFor, /edited: editedOf\(record\)/);
  assert.ok(core.includes('onPlanEdits((record) => (state.intake?.record === record ? [...(state.intake.agentEdited ?? []), ...(state.intake.agentDerived ?? [])] : []));'));
  // CodeRabbit on #480: a value recomputed from the correction (claims box → any claims) counts, and
  // a TNI standard never does.
  const recordJs = fs.readFileSync(new URL('../sidepanel/panel/record.js', import.meta.url), 'utf8');
  assert.ok(recordJs.includes('state.intake.agentDerived = [...new Set(Object.values(by).flat())];'));
  const cleared = structuredClone(record);
  cleared.claims = { ...(cleared.claims ?? {}), hasClaims: null };
  const fallback = buildPlan(cleared, progressive, {}, { edited: ['claims.hasClaims'] }).filter((s) => s.standard && s.path === 'claims.hasClaims');
  assert.ok(fallback.length && fallback.every((s) => !s.edited), 'a standard is never marked edited');
});

// Audit 2026-11-07, FLOW-12: a fill of the quote tab while the agent was on another, and how long its
// page was hidden (the longest a frame saw), so the weekly review can tell throttled fills apart.
test('a fill run says it ran in the background and how long its page was hidden, only when so', () => {
  const ctx = { carrier: 'progressive', page: 'Rates', overwrite: false, ms: 1, redact: (t) => t };
  const [back] = fillEvents([{ fields: 3, hiddenMs: 1200 }, { fields: 1, hiddenMs: 900 }, { fields: 1 }], { ...ctx, background: true });
  const [front] = fillEvents([{ fields: 3 }], ctx);
  assert.deepEqual([back.background, back.hiddenMs], [true, 1200]);
  assert.deepEqual(['background' in front, 'hiddenMs' in front], [false, false]);
});

// Audit 2026-11-07 (ENG-07): a fill that halted or failed an answer logs its timeline on fill_run,
// its questions and buttons redacted and its keys salted as a fill_field's.
test('a fill_run carries the timeline of a fill that halted, redacted as its fields are', () => {
  const timeline = [
    { what: 'wait', at: 0, why: 'answer', ms: 150, ended: 'quiet' },
    { what: 'answer', at: 160, key: 'owner_Jordan', label: "Jordan's Role", kind: 'choice', ok: false, ms: 20 },
    { what: 'press', at: 300, button: 'Edit Jordan', how: 'kit' },
    { what: 'wait', at: 310, why: 'continue', ms: 15000, ended: 'limit', held: ['busy'] },
  ];
  const [run] = fillEvents([{ halted: true, timeline }, { timeline: [{ what: 'run', at: 0, on: true }] }], { carrier: 'geico', page: '/quote', view: 't1', overwrite: false, ms: 1, redact, keySalt: 'salt-1' });
  assert.equal(run.timeline.length, 4, 'one frame\'s, the first that has one');
  assert.deepEqual(run.timeline[0], timeline[0]);
  assert.deepEqual(run.timeline[3], timeline[3]);
  assert.match(run.timeline[1].key, /^owner_\[client\]#[0-9a-f]{8}$/);
  assert.deepEqual([run.timeline[1].label, run.timeline[2].button], ["[client]'s Role", 'Edit [client]']);
  assertNoClientData(run.timeline);
  const [plain] = fillEvents([{ filled: [] }], { carrier: 'geico', page: '/quote', view: 't1', overwrite: false, ms: 1, redact });
  assert.equal('timeline' in plain, false, 'none without one');
});

// Audit 2026-11-07, FLOW-11: the second click of a Continue that didn't take is said on its fill_run,
// so the weekly review can judge whether the retry is still needed.
test('a fill run that clicked a lost Continue again says so, and no other does', () => {
  const ctx = { carrier: 'amwins', page: 'Step', overwrite: false, ms: 1, redact: (t) => t };
  const [retried] = fillEvents([{ fields: 3, advanced: 'Save & Continue' }], { ...ctx, auto: 'page', retried: true });
  const [plain] = fillEvents([{ fields: 3, advanced: 'Save & Continue' }], { ...ctx, auto: 'page' });
  assert.deepEqual([retried.retried, 'retried' in plain], [true, false]);
});

test('dropdown changes keep the option text, minus client names', () => {
  const filled = new Map([['2B9D', { path: 'progressive.q2B9D', shown: 'More than 500 miles' }]]);
  const e = fieldChangeEvent({ key: '2B9D', q: '2B9D', label: 'Farthest distance', kind: 'select', before: 'More than 500 miles', after: '500 miles', agent: true }, { record, filled, redact });
  assert.equal(e.from, 'More than 500 miles');
  assert.equal(e.to, '500 miles');
  assert.equal(e.vsAutofill, 'different');
  const addr = fieldChangeEvent({ key: '277', q: '277', label: 'Address', kind: 'radio', before: '', after: '125 Maple Leaf Dr Springfield IL (USDOT Address)', agent: false }, { record, filled: new Map(), redact });
  assert.equal(addr.by, 'page');
  assertNoClientData(addr);
});

test('a name word is redacted only as a whole word; other terms wherever they appear as written', () => {
  // Codex review on 4f455f4: a driver named Ann turned "Annual mileage" into "[client]ual mileage".
  const r = redactor(['Ann Carlson', 'Ann', 'Carlson', 'Car', 'José', '1234567', '1FTBR3X87MKA12345']);
  for (const fact of ['Annual mileage', 'Cargo', 'Caravan', 'carrier', 'Oscar', 'Carlsonville']) assert.equal(r(fact), fact);
  assert.equal(r('Ann drives. ANN, Ann\'s truck'), '[client] drives. [client], [client]\'s truck');
  assert.equal(r('Ann Carlson; José.'), '[client]; [client].');
  assert.equal(r('owner_Ann'), 'owner_[client]', 'an underscore is not part of the word');
  assert.equal(r('USDOT1234567 vin=1FTBR3X87MKA12345x'), 'USDOT[client] vin=[client]x', 'numbers and VINs still match inside longer text');
});

test('control keys: data-model names kept whole, other ids redacted like prose', () => {
  // Maintainer, 2026-10-13: log quality over redaction. A name word redacted inside a data-model
  // name ("HasContinuousCo[client]ge") split the question in every report.
  const redact = redactor(['Ann', 'Car', 'José', 'Vera', '1FTBR3X87MKA12345']);
  const ctx = { record: {}, filled: new Map(), redact, keySalt: 'quote-salt' };
  const keyOf = (key) => fieldChangeEvent({ key, label: 'Annual mileage and Cargo', kind: 'text', before: '', after: '123', agent: true }, ctx);
  for (const key of ['ref:MoreBusinessInput.HasContinuousCoverage', 'ref:RiskInput.CarrierCode@2', 'driverAnn1', 'ownerCar2', 'comprehensiveDeductibleExclude#1']) {
    const event = keyOf(key);
    assert.equal(event.key, key, `${key} is kept as it is`);
    assert.equal(event.label, 'Annual mileage and Cargo');
    const [, fill] = fillEvents([{ filled: [{ key, label: event.label, controlKind: 'text' }] }], { ...ctx, carrier: 'progressive' });
    assert.equal(fill.key, key, 'fill and change events identify the same control');
  }
  // A whole client word or a number in an id is still redacted, with a digest to keep controls apart.
  for (const [key, shown] of [['owner_Ann', 'owner_[client]'], ['vin_1FTBR3X87MKA12345', 'vin_[client]'], ['José-3', '[client]-3']]) {
    const event = keyOf(key);
    assert.match(event.key, new RegExp(`^${shown.replace('[client]', '\\[client\\]')}#[0-9a-f]{8}$`));
    assert.equal(fieldChangeEvent({ key, label: 'x', kind: 'text', before: '', after: '1', agent: true }, { ...ctx, keySalt: undefined }).key, null);
    const [, fill] = fillEvents([{ filled: [{ key, label: 'x', controlKind: 'text' }] }], { ...ctx, carrier: 'amwins' });
    assert.equal(fill.key, event.key, 'fill and change events identify the same redacted control');
  }
});

test('a combo box keeps its value only when each side is one of its known options', () => {
  const choices = new Map([['2C1A', new Set(['Transit 150', 'Transit 250', 'Transit 350'])]]);
  const combo = (before, after, ctx = {}) => fieldChangeEvent({ key: '2C1A', q: '2C1A', label: 'Model', kind: 'select', combo: true, before, after, agent: true },
    { record, filled: new Map(), redact, choices, ...ctx });

  const pick = combo('Transit 250', 'Transit 350');
  assert.deepEqual([pick.kind, pick.from, pick.to], ['select', 'Transit 250', 'Transit 350']);
  assert.equal(combo('', 'Transit 350').from, null, 'an empty box is not text');
  assert.equal(combo(' Transit  350 ', '').from, 'Transit 350', 'spacing does not matter');

  // A search typed into the box, or a value no fill saw among the options, is logged like text:
  // whether it was entered, cleared or edited and which intake field it matches, never the value.
  for (const [before, after, change] of [['', 'Trans', 'entered'], ['Transit 350', 'Transit 3', 'edited'], ['Trans', '', 'cleared']]) {
    const e = combo(before, after);
    assert.equal(e.kind, 'text');
    assert.equal(e.change, change);
    assert.equal('from' in e || 'to' in e, false, `${before} -> ${after} leaves no value`);
  }
  const intake = combo('', 'transit 350');
  assert.equal(intake.kind, 'text', 'case differs from the option, so it may be typed');
  assert.deepEqual(intake.matchesIntake, ['vehicles[0].model']);
  const unknown = combo('', 'Transit 350', { choices: new Map() });
  assert.equal(unknown.kind, 'text', 'no options known for this combo yet');
  assert.equal(combo('', 'Transit 350', { choices: undefined }).kind, 'text');
  const other = fieldChangeEvent({ key: '2C1A@2', q: '2C1A', label: 'Model', kind: 'select', combo: true, before: '', after: 'Transit 350', agent: true },
    { record, filled: new Map(), redact, choices });
  assert.equal(other.kind, 'text', 'options are per control: another row\'s combo is not confirmed');

  // Autofill comparisons follow the kind.
  const filled = new Map([['2C1A', { path: 'vehicles[0].model', shown: 'Transit 350' }]]);
  assert.equal(combo('Transit 350', 'Transit 35', { filled }).vsAutofill, 'different');
  assert.equal(combo('Transit 350', 'Transit 250', { filled }).vsAutofill, 'different');
  assert.equal(combo('', 'Transit 350', { filled }).vsAutofill, 'same');

  // Native selects and radios are unchanged: their values are always options.
  const native = fieldChangeEvent({ key: '2B9D', q: '2B9D', label: 'Farthest distance', kind: 'select', before: '', after: '500 miles', agent: true }, { record, filled: new Map(), redact, choices });
  assert.deepEqual([native.kind, native.to], ['select', '500 miles']);
  const radio = fieldChangeEvent({ key: '2F6', q: '2F6', label: 'Hazmat', kind: 'radio', before: '', after: 'No', agent: true }, { record, filled: new Map(), redact, choices });
  assert.deepEqual([radio.kind, radio.to], ['radio', 'No']);
});

test('fill results drop typed values but keep chosen options', () => {
  const frames = [{
    fields: 10, rounds: 3,
    filled: [
      { label: 'First Name', path: 'progressive.q295', q: '295', controlKind: 'text', shown: 'Jordan Avery' },
      { label: 'Liability', path: 'coverage.autoLiabLimit', q: '1D97', controlKind: 'select', shown: '$1 million CSL' },
    ],
    failed: [{ label: 'Radius', path: 'operations.radius', q: null, controlKind: 'select', reason: 'no option matches "Unlimited"', options: ['0-50 miles'] }],
    noData: [], kept: [], leftRequired: [],
  }];
  const events = fillEvents(frames, { carrier: 'progressive', page: 'AddVehicle', overwrite: false, ms: 1200, redact });
  assert.equal(events[0].type, 'fill_run');
  assert.equal(events[0].filled, 2);
  const text = events.find((e) => e.q === '295');
  assert.equal(text.shown, undefined);
  assert.equal(events.find((e) => e.q === '1D97').shown, '$1 million CSL');
  events.forEach(assertNoClientData);
});

// Audit 2026-11-07, LEARN-09: a failed answer is logged with its code, for the reviews to count by.
test('a failed answer is logged with its code beside its reason', () => {
  const frames = [{ fields: 1, filled: [], noData: [], kept: [], leftRequired: [],
    failed: [{ label: 'Radius', path: 'operations.radius', q: null, controlKind: 'select', code: 'option.no-match', reason: 'no option matches "Unlimited"' }] }];
  const failed = fillEvents(frames, { carrier: 'progressive', page: 'AddVehicle', overwrite: false, ms: 1, redact }).find((e) => e.result === 'failed');
  assert.deepEqual([failed.code, failed.reason], ['option.no-match', 'no option matches "Unlimited"']);
});

// Audit 2026-11-07, LEARN-11: every fill run of a page logged each kept answer again (59% of fill
// events). A kept answer is logged once per quote, tab, page, step, question and what it shows; the
// run still counts them all.
test('a kept answer is logged once per quote and what it shows, and counted on every run', () => {
  const kept = (now, extra = {}) => ({ label: 'Garaging ZIP', key: 'ref:GiveZip', q: null, controlKind: 'text', now, ...extra });
  const run = (items, opts = {}) => fillEvents([{ fields: items.length, filled: [], failed: [], noData: [], leftRequired: [], kept: items }],
    { carrier: 'geico', page: '/quote', view: 't1', overwrite: false, ms: 1, redact, step: 'Vehicles', ...opts });
  const keptOf = (events) => events.filter((e) => e.type === 'fill_field' && e.result === 'kept').length;
  const keptLogged = new Set();
  const first = run([kept('20001'), kept('20001', { label: 'Business ZIP', key: 'ref:BizZip' })], { keptLogged });
  assert.deepEqual([keptOf(first), first[0].kept], [2, 2]);
  const again = run([kept('20001'), kept('20001', { label: 'Business ZIP', key: 'ref:BizZip' })], { keptLogged });
  assert.deepEqual([keptOf(again), again[0].kept], [0, 2], 'the same answers kept again: counted, not logged');
  assert.equal(keptOf(run([kept('20002')], { keptLogged })), 1, 'what the field shows changed');
  assert.equal(keptOf(run([kept('20002')], { keptLogged, view: 't2' })), 1, 'another tab');
  assert.equal(keptOf(run([kept('20002')], { keptLogged, step: 'Drivers' })), 1, 'another step');
  assert.equal(keptOf(run([kept('20002', { differs: true })], { keptLogged })), 1, 'one that differs from the rule always');
  assert.equal(keptOf(run([kept('20001')])), 1, 'without the quote\'s set, every one');
});

test('summary script turns a log into corrections and mapping candidates', async () => {
  const s = await intakeSummary(bytes, raw, result);
  const base = { v: '0.1.0', agent: 'LK', session: 's1', intakeId: s.intakeId };
  const log = { kind: 'usage-log', events: [
    { ...base, t: '2026-10-01T10:00:00Z', type: 'intake_loaded', ...s },
    { ...base, t: '2026-10-01T10:00:05Z', type: 'page_view', carrier: 'progressive', page: 'AddVehicle' },
    { ...base, t: '2026-10-01T10:00:09Z', type: 'fill_run', carrier: 'progressive', page: 'AddVehicle', filled: 5, failed: 1, noData: 1, ms: 8000 },
    { ...base, t: '2026-10-01T10:00:20Z', type: 'field_change', carrier: 'progressive', page: 'AddVehicle', q: '2B9D', label: 'Farthest distance', kind: 'select', by: 'agent', autofilled: 'progressive.q2B9D', from: 'More than 500 miles', to: '500 miles', vsAutofill: 'different' },
    { ...base, t: '2026-10-01T10:00:30Z', type: 'field_change', carrier: 'progressive', page: 'AddVehicle', q: '2B70', label: 'Garaging county', kind: 'text', by: 'agent', autofilled: null, change: 'entered', matchesIntake: ['garaging.city'] },
    { ...base, t: '2026-10-01T10:01:30Z', type: 'page_view', carrier: 'progressive', page: 'AddDriver' },
  ] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'log.json');
  fs.writeFileSync(file, JSON.stringify(log));
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize-usage.mjs', import.meta.url)), file, '--json'], { encoding: 'utf8' }));
  assert.equal(out.totals.intakes, 1);
  assert.match(out.corrections[0].changes[0], /"More than 500 miles" → "500 miles"/);
  assert.match(out.unmapped[0].what[0], /matches garaging\.city/);
  assert.equal(out.pages.find((p) => p.page === 'progressive AddVehicle').avgSeconds, 85);
  assert.ok(out.intakeWarnings.some((w) => w.code === 'vin.invalid'));
});

test('typed dates in date pickers are never logged, even if they look like dropdowns', () => {
  const e = fieldChangeEvent({ key: '9D', q: '9D', label: 'Current Policy Expiration Date', kind: 'select', before: '08/14/2026', after: '10/14/2026', agent: true }, { record, filled: new Map(), redact });
  assert.equal(e.kind, 'text');
  assert.equal(e.from, undefined);
  assert.equal(e.to, undefined);
  assert.ok(!JSON.stringify(e).includes('2026'));
});

test('unfamiliar warnings are logged for training without entered values', () => {
  const events = fillEvents([{ fields: 1, rounds: 1, filled: [], unknown: [{ q: 'ABCD', label: 'New question', key: 'ABCD', controlKind: 'text', shown: 'private typed answer' }] }], { carrier: 'progressive', page: 'AddVehicle', redact: (s) => s });
  assert.equal(events[0].unknown, 1);
  const warning = events.find((event) => event.result === 'unfamiliar');
  assert.equal(warning.q, 'ABCD');
  assert.equal(warning.label, 'New question');
  assert.equal(warning.controlKind, 'text');
  assert.equal(warning.shown, undefined);
  assert.ok(!JSON.stringify(events).includes('private typed answer'));
});

test('labels from the fill engine replace the recorder guess', () => {
  const labels = new Map([['2F6', 'Do any listed vehicles or the load require a hazardous material placard?']]);
  const e = fieldChangeEvent({ key: '2F6', q: '2F6', label: 'Four digit suffix of phone', kind: 'radio', before: '', after: 'No', agent: true }, { record, filled: new Map(), redact, labels });
  assert.match(e.label, /hazardous material placard/);
});

test('fill events say which view (tab and vehicle) they were on', () => {
  const events = fillEvents([{ fields: 1, filled: [{ key: '2B9D@2', q: '2B9D', label: 'Farthest distance', controlKind: 'select', shown: '500 miles' }] }],
    { carrier: 'progressive', page: 'AddVehicle', view: 't1:v1', overwrite: false, ms: 1, redact });
  assert.deepEqual(events.map((e) => [e.type, e.view]), [['fill_run', 't1:v1'], ['fill_field', 't1:v1']]);
});

// Codex on PR #65 (2c8eeb9): a step heading could name the insured, and the tab may still show the
// previous client's quote, which the loaded intake's redaction doesn't know: only the carrier's own
// step names are sent.
test('only a known step name is sent as the step', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  assert.deepEqual(amwins.layoutSteps, ['Insured Info', 'Drivers', 'Vehicles', 'Coverages', 'Underwriting']);
  assert.equal(knownStep(amwins, 'Vehicles '), 'Vehicles');
  assert.equal(knownStep(amwins, 'coverages'), 'Coverages');
  assert.equal(knownStep(amwins, '  Draft Application Saved! / Insured  Info'), 'Insured Info', 'a dialog heading beside the step');
  assert.equal(knownStep(amwins, 'Old Client Trucking LLC'), undefined);
  assert.equal(knownStep(amwins, 'Vehicles for Old Client Trucking LLC'), undefined, 'a heading that only contains a step name');
  assert.equal(knownStep(amwins, ''), undefined);
  assert.equal(knownStep({ id: 'amwins', layoutSteps: true }, 'Vehicles'), undefined, 'no list of names: no step');
  assert.equal(knownStep({ id: 'progressive' }, 'Vehicles'), undefined);
  // GEICO's steps, read from its progress bar; its dashboard and gateway names are none of them.
  const { geico } = await import('../src/carriers/geico.js');
  assert.equal(knownStep(geico, 'Vehicles'), 'Vehicles');
  assert.equal(knownStep(geico, 'quote & coverages'), 'Quote & Coverages');
  assert.equal(knownStep(geico, 'Dashboard'), undefined);
  assert.equal(knownStep(geico, 'Old Client Trucking LLC'), undefined);
  const change = fieldChangeEvent({ key: 'k', label: 'Owner', kind: 'select', before: '', after: 'Yes', agent: true }, { record, filled: new Map(), redact, step: knownStep(amwins, 'Old Client Trucking LLC') });
  assert.equal('step' in change, false);
});

// Audit 2026-10-08, finding 7: a fill's events can be joined by run and attributed to a rule version.
test('fill events carry their run, the rules fingerprint, the settings in force and the step', async () => {
  const frames = [{ fields: 2, filled: [{ key: 'vin', label: 'VIN', controlKind: 'text', shown: '1FTBR3X87MKA12345' }], failed: [{ key: 'x', label: 'Radius', controlKind: 'select', reason: 'no option' }], stepKey: 'Vehicles' }];
  const settings = { autoAdvance: true, autoFollowUps: true, autoPages: false, overwrite: false };
  const events = fillEvents(frames, { carrier: 'amwins', page: '/application/businessauto', overwrite: false, ms: 1, redact,
    run: 'e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', rules: 'f00dbeefcafe', settings, step: 'Vehicles / Jordan Avery' });
  assert.equal(events[0].type, 'fill_run');
  assert.deepEqual([events[0].run, events[0].rules, events[0].settings, events[0].step], ['e3a4a4e0-3c1d-4d1b-9a4b-0f8d1c2b3a45', 'f00dbeefcafe', settings, 'Vehicles / [client]']);
  assert.ok(events.slice(1).every((e) => e.run === events[0].run && e.step === 'Vehicles / [client]'), 'every field event shares the run and step');
  assert.ok(events.slice(1).every((e) => !('rules' in e) && !('settings' in e)), 'rules and settings only on the run');
  events.forEach(assertNoClientData);
  // A carrier whose pages have names carries no step; nothing is sent as null.
  const plain = fillEvents(frames, { carrier: 'progressive', page: 'AddVehicle', overwrite: false, ms: 1, redact });
  assert.ok(plain.every((e) => !('run' in e) && !('rules' in e) && !('settings' in e) && !('step' in e)));
  // A long step heading is cut.
  const long = fillEvents(frames, { carrier: 'amwins', page: 'P', overwrite: false, ms: 1, redact, step: 'x'.repeat(300) });
  assert.equal(long[0].step.length, STEP_MAX);
  // Field changes name their step the same way, redacted.
  const change = fieldChangeEvent({ key: 'k', label: 'Owner', kind: 'select', before: '', after: 'Yes', agent: true }, { record, filled: new Map(), redact, step: 'Drivers / Jordan Avery' });
  assert.equal(change.step, 'Drivers / [client]');
  assert.equal('step' in fieldChangeEvent({ key: 'k', label: 'Owner', kind: 'select', before: '', after: 'Yes', agent: true }, { record, filled: new Map(), redact }), false);
  // The rules fingerprint: the first 12 hex of SHA-256 over the rule files' text, in their order.
  const texts = RULE_FILES.map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const hash = await rulesHash(texts);
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(hash, (await sha256Hex(texts.join('\n'))).slice(0, 12));
  assert.notEqual(await rulesHash([...texts.slice(0, -1), `${texts.at(-1)}\n// changed`]), hash, 'a rule change changes it');
  // Codex on PR #65 (f8d6215): every module the plan, normalization and carriers import changes
  // the answers, so the fingerprint covers their whole import graph.
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // An import, or a re-export (`export { STATES } from './states.js'`).
    for (const [, spec] of text.matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  };
  ['src/plan.js', 'src/normalize.js', 'src/carriers.js'].forEach(visit);
  assert.deepEqual([...reached].sort(), [...RULE_FILES].sort());
});

test('a panel crash is logged redacted, with frames from the extension only', () => {
  const err = new Error('Cannot read properties of null (reading \'record\') for Vera');
  err.stack = `Error: x\n    at fill (chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel/sidepanel.js:1240:7)\n    at https://carrier.example/app.js:1:1\n    at chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/usage.js:30:2`;
  assert.deepEqual(clientErrorEvent(err, { where: 'panel', redact: redactor(['Vera']) }),
    { type: 'client_error', where: 'panel', error: 'Cannot read properties of null (reading \'record\') for [client]', stack: ['sidepanel/sidepanel.js:1240:7', 'src/usage.js:30:2'] });
  // A rejected promise can carry anything: a string, nothing, an object without a stack.
  assert.equal(clientErrorEvent('plain text', { where: 'panel' }).error, 'plain text');
  assert.equal(clientErrorEvent(undefined, { where: 'panel' }).error, 'unknown error');
  assert.equal(clientErrorEvent({ message: 'm' }, { where: 'panel' }).stack, undefined);
  assert.equal(clientErrorEvent(new Error('x'.repeat(400)), { where: 'panel' }).error.length, 300);
});

test('the agent\'s settings event has every setting, defaults included, and never the AI key', () => {
  const central = 'https://central.example';
  assert.deepEqual(agentSettingsEvent({}, { reason: 'intake', centralServer: central }), { type: 'agent_settings', reason: 'intake', values: {
    autoFollowUps: true, autoAdvance: true, autoPages: true, overwrite: false, aiOn: true, aiAuto: false, aiNames: true, aiKey: false, uploads: 'central' } });
  const e = agentSettingsEvent({ autoAdvance: false, autoPages: true, aiOn: true, lunaAuto: true, lunaNames: false, lunaKey: 'sk-secret', serverUrl: 'http://localhost:8787' },
    { overwrite: true, reason: 'changed', changed: 'aiKey', centralServer: central });
  assert.deepEqual(e.values, { autoFollowUps: true, autoAdvance: false, autoPages: true, overwrite: true, aiOn: true, aiAuto: true, aiNames: false, aiKey: true, uploads: 'other' });
  assert.equal(e.changed, 'aiKey');
  assert.ok(!JSON.stringify(e).includes('sk-secret'), 'never the key');
  assert.equal(agentSettingsEvent({ serverUrl: '' }, { reason: 'opened', centralServer: central }).values.uploads, 'off');
  assert.equal(agentSettingsEvent({ serverUrl: central }, { reason: 'opened', centralServer: central }).values.uploads, 'central');
});

test('agents\' own defaults: the settings event carries them once answered, a fill their fingerprint', () => {
  const central = 'https://central.example';
  // Before the agent says whose defaults the quote takes: no `defaults` at all.
  assert.equal('defaults' in agentSettingsEvent({}, { reason: 'intake', centralServer: central }), false);
  // TNI's: an empty list. The agent's: each default in force.
  assert.deepEqual(agentSettingsEvent({}, { reason: 'changed', changed: 'defaults', centralServer: central, defaults: [] }).defaults, []);
  const mine = [{ id: 'umCsl', value: 300000 }, { id: 'medPay', value: 'ask', carrier: 'geico' }];
  assert.deepEqual(agentSettingsEvent({}, { reason: 'changed', changed: 'defaults', centralServer: central, defaults: mine }).defaults, mine);
  // A fill with the agent's defaults carries the fingerprint on its fill_run only; with TNI's, none.
  const frames = [{ fields: 1, rounds: 1, filled: [{ key: 'um', q: 'um', label: 'UM', controlKind: 'select', shown: '$300K' }] }];
  const ctx = { carrier: 'amwins', page: 'Coverages', overwrite: false, ms: 1, redact: (s) => s };
  const [run, field] = fillEvents(frames, { ...ctx, defaultsHash: '0a1b2c3d4e5f' });
  assert.equal(run.type, 'fill_run');
  assert.equal(run.defaultsHash, '0a1b2c3d4e5f');
  assert.equal(field.defaultsHash, undefined);
  assert.equal('defaultsHash' in fillEvents(frames, ctx)[0], false);
});

test('the platform: system and Chrome major version, from userAgentData or the user agent', () => {
  assert.deepEqual(platformOf({ userAgentData: { platform: 'Windows', brands: [{ brand: 'Not A;Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }] }, userAgent: '' }), { os: 'Windows', chrome: 141 });
  assert.deepEqual(platformOf({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }), { os: 'macOS', chrome: 140 });
  assert.deepEqual(platformOf({}), { os: null, chrome: null });
});

test('fill events say why an answer was given; a dismissed check is keyed like them', () => {
  const frames = [{ filled: [
    { key: '2CCC', q: '2CCC', label: 'Comp/coll', controlKind: 'radio', shown: 'Yes', source: 'standard', standard: true, review: true },
    { key: '2B20', q: '2B20', label: 'VIN', controlKind: 'text', source: 'intake' },
  ], leftRequired: [{ key: '246', q: '246', label: 'USDOT belongs', controlKind: 'radio', source: 'attestation', manualOnly: true }] }];
  const events = fillEvents(frames, { carrier: 'progressive', page: 'AddVehicle', redact: (x) => x });
  const field = (q) => events.find((e) => e.type === 'fill_field' && e.q === q);
  assert.deepEqual([field('2CCC').source, field('2CCC').standard, field('2CCC').review], ['standard', true, true]);
  assert.deepEqual([field('2B20').source, field('2B20').standard, field('2B20').review], ['intake', undefined, undefined]);
  assert.deepEqual([field('246').source, field('246').manualOnly], ['attestation', true]);
  assert.deepEqual(checkDismissedEvent({ key: 'owner_Ann', q: null, label: 'Owner Ann', mark: 'needs' }, { redact: redactor(['Ann']), keySalt: 's' }),
    { type: 'check_dismissed', q: null, key: checkDismissedEvent({ key: 'owner_Ann' }, { redact: redactor(['Ann']), keySalt: 's' }).key, label: 'Owner [client]', mark: 'needs' });
});

// W43-44: what the page did after the fill's Recalculate, logged as a layout the review scripts
// don't read as the page's (reason 'recalculate'), without client data.
test('a Recalculate trace is logged as a page_layout the layouts leave out, without client data', async () => {
  const { buildLayouts } = await import('../scripts/lib/layouts.mjs');
  const recalcTrace = { action: 'recalculate', ms: 4680, press: 'page', premiumMs: 300, requests: [[-2500, -2000]], answers: [
    { label: 'Jordan Casey 1FTBR3X87MKA12345 Coverage', key: 'cov:COMP#1', shown: '$1,000 deductible', agents: false, seen: [[300, '$500 deductible'], [4680, '$1,000 deductible']], putBack: true },
    { label: 'Liability', key: 'cov:liability#1', shown: '$1,000,000 Combined Single Limit', agents: true, seen: [], putBack: false },
  ] };
  const events = fillEvents([{ filled: [], recalcTrace }], { carrier: 'geico', page: '/quote', overwrite: false, ms: 1, redact, step: 'Quote & Coverages' });
  const trace = events.find((e) => e.type === 'page_layout');
  assert.deepEqual([trace.reason, trace.step, trace.context.premiumMs, trace.context.press, trace.context.requests], ['recalculate', 'Quote & Coverages', 300, 'page', [[-2500, -2000]]]);
  // How it was pressed is one of three words, nothing else.
  const odd = fillEvents([{ filled: [], recalcTrace: { ...recalcTrace, press: 'Jordan Casey' } }], { carrier: 'geico', page: '/quote', overwrite: false, ms: 1, redact, step: 'Quote & Coverages' });
  assert.equal(odd.find((e) => e.type === 'page_layout').context.press, null);
  assert.deepEqual(trace.fields.map((f) => [f.key, f.selected, f.seen, f.putBack, f.agents]), [
    ['cov:COMP#1', '$1,000 deductible', [[300, '$500 deductible'], [4680, '$1,000 deductible']], true, false],
    ['cov:liability#1', '$1,000,000 Combined Single Limit', [], false, true],
  ]);
  assertNoClientData(trace);
  assert.equal(events.filter((e) => e.type === 'page_layout').length, 1);
  // Not a layout of the page.
  assert.deepEqual(buildLayouts([{ ...trace, session: 's', t: '2026-10-22T00:00:00Z' }]), []);
  // No trace, no event.
  assert.ok(!fillEvents([{ filled: [] }], { carrier: 'geico', page: '/quote', overwrite: false, ms: 1, redact }).some((e) => e.type === 'page_layout'));
});

test('the business profile describes the intake without identifying the client', () => {
  const p = intakeProfile(record, { redact, today: new Date('2026-09-30') });
  assertNoClientData(p);
  assert.equal(p.type, 'intake_profile');
  assert.deepEqual([p.business.state, p.business.dot, p.business.mc, p.business.fein], ['IL', 'given', 'given', 'blank'], 'whether a number was given, never the number');
  assert.equal(p.vehicles.length, record.vehicles.length);
  assert.deepEqual(Object.keys(p.vehicles[0]), ['type', 'year', 'make', 'model', 'value'], 'no VIN');
  assert.deepEqual(p.drivers.map((d) => d.age), [38, 31], 'ages on the day, not dates of birth');
  assert.deepEqual(Object.keys(p.drivers[0]), ['age', 'licenseState', 'cdl', 'cdlYear', 'excluded', 'maritalStatus', 'gender'], 'no name or license number');
  assert.equal(p.coverage.autoLiabLimit, '$1M CSL', 'the limits asked for');
  assert.equal(p.priorInsurance[0].expires, '2026-10', 'a month, not the date');
});

test('profile text loses what could identify the client; numbers, yes/no and gender keep their shapes', () => {
  const synthetic = {
    applicant: { dot: null, mc: '  ', fein: '12-3456789', mcDotWithin60Days: true, yearsInBusiness: 0, yearsExperience: null, ownerDrives: null },
    garaging: { state: 'tx' },
    operations: { businessClass: 'Freight Hauler', whatHaul: 'Steel coils 40000 lbs, call owner@example.com', radiusMiles: 250.4, teamDriving: false, canadaLoads: null, equipVehicle: '5k?' },
    vehicles: [{ type: 'Semi Truck', year: '19', make: 'Freightliner 1FUJGLDR0CLBP8834', model: '579', vin: '1FUJGLDR0CLBP8834', value: 65000 }],
    trailers: [],
    trailerInfo: { interchangeLimit: '$20,000' },
    drivers: [
      { first: 'Ann', dob: '10/01/1980', licenseNumber: 'A1234567', gender: 'MALE' },
      { dob: '1980-10-01', gender: 'M' },
      ...Array(60).fill({}),
    ],
    coverage: { autoLiability: 'Yes' },
    priorInsurance: [{ carrier: 'None', expiration: null }, { carrier: 'Sample Mutual', expiration: '11/30/2026' }],
    claims: { hasClaims: null },
  };
  const p = intakeProfile(synthetic, { redact: redactor(['Ann', 'Sample']), today: new Date('2026-09-30') });
  assert.deepEqual([p.business.dot, p.business.mc, p.business.fein, p.business.state], ['blank', 'blank', 'given', 'TX']);
  assert.deepEqual([p.business.dotWithin60Days, p.business.yearsInBusiness, p.business.ownerDrives], [true, 0, null], 'zero years is an answer; unanswered stays null');
  assert.equal(p.operations.whatHaul, 'Steel coils # lbs, call #', 'five digits and an email address taken out');
  assert.deepEqual([p.operations.radiusMiles, p.operations.teamDriving, p.operations.canadaLoads, p.operations.equipVehicle], [250, false, null, null]);
  assert.deepEqual(p.vehicles, [{ type: 'Semi Truck', year: null, make: 'Freightliner #', model: '579', value: 65000 }], 'a VIN inside a make goes; an unreadable year is no year');
  assert.equal(p.trailerInfo.interchangeLimit, 20000);
  assert.equal(p.drivers.length, 50, 'at most 50 units');
  assert.deepEqual([p.drivers[0].age, p.drivers[0].gender, p.drivers[1].age, p.drivers[1].gender], [45, 'MALE', null, 'MALE'], 'the birthday not yet reached; gender as typed in the panel (M, Female) read as MALE or FEMALE');
  assert.deepEqual(p.priorInsurance.map((x) => [x.carrier, x.expires]), [['None', 'none'], ['[client] Mutual', '2026-11']]);
  assert.equal(p.hasClaims, null);
  for (const leak of ['Ann', '1FUJ', 'A1234567', '10/01/1980', 'example.com', '12-3456789', '40000']) assert.ok(!JSON.stringify(p).includes(leak), leak);
});

// Review of PR #149: identifiers written with punctuation, ID boxes holding words, impossible dates
// and limits typed with digits.
test('profile: punctuated identifiers and the intake\'s spaced VINs go; ID boxes, expiry months and limits keep their meaning', () => {
  const synthetic = {
    applicant: { dot: 'Pending', mc: '0', fein: '123456789' },
    operations: { whatHaul: 'Produce; call (312) 555-0142, SSN 123-45-6789, born 01-05-1980 or 01.05.1980, licence S123-4567-8901, policy CA-0193-4471, truck 1FUJ GLDR 0CLB P8834' },
    vehicles: [{ make: 'Freightliner', model: 'Cascadia 126', vin: '1FUJGLDR0CLBP8834' }],
    drivers: [{ dob: '02/30/1980' }],
    coverage: { autoLiabLimit: '$1000000 CSL', glLimit: '1000000' },
    priorInsurance: [
      { carrier: 'Progressive', limit: '25/50/25', expiration: '13/01/2026' },
      { limit: '100/300/100', expiration: '11/30/2026' },
      { limit: '123-45-6789' },
    ],
  };
  const p = intakeProfile(synthetic, { today: new Date('2026-10-22') });
  assert.equal(p.operations.whatHaul, 'Produce; call (#, SSN #, born # or #, licence S#, policy CA-#, truck #');
  assert.deepEqual([p.business.dot, p.business.mc, p.business.fein], ['other', 'other', 'given'], 'a word or a zero is something written, not a number');
  assert.equal(p.vehicles[0].model, 'Cascadia 126', 'a model number stays');
  assert.equal(p.drivers[0].age, null, 'no age from an impossible date of birth');
  assert.deepEqual([p.coverage.autoLiabLimit, p.coverage.glLimit], ['$1000000 CSL', '1000000']);
  assert.deepEqual(p.priorInsurance.map((x) => [x.limit, x.expires]), [['25/50/25', null], ['100/300/100', '2026-11'], [null, null]], 'no month 13; an SSN is no limit');
});

// REC-09 (audit 2026-11-07): a fill_run's waits are its frames' summed, by what they were for;
// anything that isn't a wait kind with whole counts is left out.
test('a fill run sums its frames\' waits by kind, counts and ms only', () => {
  const frames = [
    { waits: { answer: { n: 3, ms: 900, limit: 0, slack: 300 }, continue: { n: 1, ms: 800, limit: 0, slack: 500 } } },
    { waits: { answer: { n: 1, ms: 200, limit: 1, slack: 0 }, 'Sam Smith': { n: 1, ms: 5, limit: 0, slack: 0 }, round: { n: 1.5, ms: 1, limit: 0, slack: 0 } } },
    {},
  ];
  const [run] = fillEvents(frames, { carrier: 'amwins', page: 'P', overwrite: false, ms: 1, redact: (s) => s });
  assert.deepEqual(run.waits, { answer: { n: 4, ms: 1100, limit: 1, slack: 300 }, continue: { n: 1, ms: 800, limit: 0, slack: 500 } });
  assert.equal('waits' in fillEvents([{}], { carrier: 'amwins', page: 'P', overwrite: false, ms: 1, redact: (s) => s })[0], false, 'a fill that waited for nothing says nothing');
});
