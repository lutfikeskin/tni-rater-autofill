import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { redactionTerms } from '../src/plan.js';
import { intakeSummary, sha256Hex, matchIntake, compareText, fieldChangeEvent, fillEvents, redactor } from '../src/usage.js';

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
  const out = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/summarize-usage.mjs', import.meta.url).pathname, file, '--json'], { encoding: 'utf8' }));
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
