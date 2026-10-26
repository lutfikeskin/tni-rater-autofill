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
    for (const [, spec] of text.matchAll(/^import\s[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
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
    autoFollowUps: true, autoAdvance: true, autoPages: true, overwrite: false, aiOn: true, aiAuto: false, aiKey: false, uploads: 'central' } });
  const e = agentSettingsEvent({ autoAdvance: false, autoPages: true, aiOn: true, lunaAuto: true, lunaKey: 'sk-secret', serverUrl: 'http://localhost:8787' },
    { overwrite: true, reason: 'changed', changed: 'aiKey', centralServer: central });
  assert.deepEqual(e.values, { autoFollowUps: true, autoAdvance: false, autoPages: true, overwrite: true, aiOn: true, aiAuto: true, aiKey: true, uploads: 'other' });
  assert.equal(e.changed, 'aiKey');
  assert.ok(!JSON.stringify(e).includes('sk-secret'), 'never the key');
  assert.equal(agentSettingsEvent({ serverUrl: '' }, { reason: 'opened', centralServer: central }).values.uploads, 'off');
  assert.equal(agentSettingsEvent({ serverUrl: central }, { reason: 'opened', centralServer: central }).values.uploads, 'central');
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
