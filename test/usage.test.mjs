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
  const log = { events: [
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
