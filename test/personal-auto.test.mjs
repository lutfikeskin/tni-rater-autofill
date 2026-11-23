// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { detectIntakeForm, readIntake } from '../src/intake-forms.js';
import { formVersion, FIELDS, OLD_FIELDS } from '../src/products/personal-auto/form.js';
import { splitLicense, splitNameAndBirth } from '../src/products/personal-auto/read.js';
import { fieldInfo, partsOf, rederive, sectionsOf } from '../src/product-parts.js';
import { SECTIONS as COMMERCIAL_SECTIONS } from '../src/schema.js';
import { carrierForUrl } from '../src/carriers.js';
import { redactionTerms } from '../src/plan.js';
import { intakeProfile, intakeSummary } from '../src/usage.js';

// Synthetic intakes only (made-up names, numbers and addresses): the form TNI shares, and its first
// version with the PDF editor's field names. The blank form is docs/intake-form-personal-auto/.
const read = async (file) => {
  const bytes = new Uint8Array(fs.readFileSync(new URL(file, import.meta.url)));
  return { bytes, raw: await readIntakeFields(pdfjs, bytes.slice()) };
};
const current = await read('./fixtures/personal-auto/intake-current.pdf');
const first = await read('./fixtures/personal-auto/intake-first.pdf');
const blank = await read('../docs/intake-form-personal-auto/personal-auto-intake-form.pdf');
const commercial = await read('./fixtures/sample-intake.pdf');
const today = new Date('2026-11-23');
const ok = (result) => {
  assert.ok(!('error' in result), JSON.stringify(result));
  return /** @type {import('../types.js').IntakeResult & { form?: string }} */ (result);
};

test('the blank form has every field the reader reads, and the commercial and personal-auto forms are told apart', () => {
  assert.deepEqual(Object.keys(blank.raw).sort(), [...FIELDS].sort());
  assert.equal(Object.keys(OLD_FIELDS).length, 102);
  assert.equal(formVersion(current.raw), 'current');
  assert.equal(formVersion(first.raw), 'first');
  assert.equal(formVersion(commercial.raw), null);
  assert.equal(detectIntakeForm(current.raw)?.id, 'tni-personal-auto');
  assert.equal(detectIntakeForm(first.raw)?.id, 'tni-personal-auto');
  assert.equal(detectIntakeForm(commercial.raw)?.id, 'tni-commercial-auto');
});

test('the current form reads into the personal-auto record, each answer from its own box', () => {
  const r = ok(readIntake(current.raw, { today }));
  assert.equal(r.form, 'tni-personal-auto');
  const { record } = r;
  assert.equal(record.product, 'personal-auto');
  assert.deepEqual(record.applicant, { name: 'Jordan Sample', phone: '(555) 010-0142', email: 'sample.client@example.com', applicationDate: '11/20/2026' });
  assert.deepEqual(record.garaging, { street: '100 Example St', unit: null, city: 'Knoxville', state: 'TN', zip: '37901' });
  assert.deepEqual(record.residence, { timeAtAddress: '3 years', priorAddress: null, ownership: 'Rent' });
  const [jordan, casey] = record.drivers;
  assert.deepEqual({ ...jordan }, { first: 'Jordan', middle: null, last: 'Sample', suffix: null, dob: '02/03/1985', gender: 'Female', maritalStatus: 'Married',
    relation: 'Insured', licenseNumber: 'S1234567', licenseState: 'TN', yearLicensed: 2003, occupation: 'Teacher', education: "Bachelor's Degree",
    matureCourse: true, goodStudent: null, distantStudent: null });
  // An unticked discount box is unanswered, not No.
  assert.equal(casey.goodStudent, true);
  assert.equal(casey.matureCourse, null);
  const [accord, corolla] = record.vehicles;
  assert.equal(accord.value, 18500);
  assert.equal(accord.annualMiles, 12000);
  assert.equal(accord.commuteMiles, 15);
  assert.equal(accord.commuteDays, 5);
  assert.equal(accord.damage, false);
  assert.deepEqual(accord.lienholder, { name: 'Example Credit Union', street: '1 Bank Way', city: 'Dallas', state: 'TX', zip: '75201' });
  // "50,000+" is no exact amount: kept as written.
  assert.equal(corolla.annualMiles, '50,000+');
  assert.equal(corolla.damage, true);
  assert.deepEqual(record.trailers, []);
  assert.deepEqual(record.priorInsurance, [{ currentlyInsured: true, carrier: 'Example Mutual', limit: '$50k/$100k', insuredFor: '2 years', expiration: '12/31/2026' }]);
  assert.deepEqual(record.coverage, { liabilityLimit: '100/300/100', compDeductible: '$500', collDeductible: '$1,000' });
  assert.equal(record.notes.text, 'Rear bumper dent on the Corolla.');
  // The second VIN's check digit is wrong on purpose; nothing else needs the agent.
  assert.deepEqual(r.warnings.map((w) => w.code), ['vin.invalid']);
  assert.deepEqual(r.rows, { drivers: [1, 2], vehicles: [1, 2], trailers: [] });
  assert.deepEqual(r.readFrom, {});
});

test('the first version\'s shared boxes are split, each split said for the agent to confirm, and answers asked once are only given to one vehicle', () => {
  const r = ok(readIntake(first.raw, { today }));
  const { record, warnings, readFrom } = r;
  const codes = warnings.map((w) => `${w.level} ${w.code} ${w.path}`);
  const [jordan, casey] = record.drivers;
  assert.deepEqual([jordan.first, jordan.last, jordan.dob, jordan.licenseNumber, jordan.licenseState], ['Jordan', 'Sample', '02/03/1985', 'S1234567', 'TN']);
  assert.deepEqual([casey.first, casey.last, casey.dob, casey.licenseNumber, casey.licenseState], ['Casey', 'Sample', '07/09/2007', 'S7654321', 'TN']);
  for (const i of [0, 1]) {
    assert.ok(codes.includes(`check driver.name-dob-one-box drivers[${i}].first`));
    assert.ok(codes.includes(`check driver.license-one-box drivers[${i}].licenseNumber`));
  }
  // Two vehicles, one commute: whose it is is the agent's.
  assert.equal(record.vehicles[0].commuteMiles, null);
  assert.ok(codes.includes('check vehicles.commute-miles-one-box vehicles'));
  // One financed vehicle: the lienholder is its own, split, and said so.
  assert.deepEqual(record.vehicles[0].lienholder, { name: 'Example Credit Union', street: '1 Bank Way', city: 'Dallas', state: 'TX', zip: '75201' });
  assert.equal(record.vehicles[1].lienholder.name, null);
  assert.ok(codes.includes('info vehicles.lienholder-name-one-box vehicles[0].lienholder.name'));
  // "No" damage is every vehicle's; a discount names its driver; "none" names no one.
  assert.deepEqual(record.vehicles.map((v) => v.damage), [false, false]);
  assert.deepEqual(record.drivers.map((d) => [d.goodStudent, d.matureCourse]), [[null, null], [true, null]]);
  // Comprehensive Yes with $500; collision No Coverage.
  assert.deepEqual(record.coverage, { liabilityLimit: null, compDeductible: '$500', collDeductible: 'No Coverage' });
  // The panel shows a split answer on its own box of the PDF: the first version's own field names.
  assert.deepEqual(readFrom['drivers[0].dob'], ['text_6xetx']);
  assert.deepEqual(readFrom['vehicles[0].lienholder.city'], ['text_77ijpl']);
});

test('a name and date of birth in one box, and a license and its state', () => {
  assert.deepEqual(splitNameAndBirth('Jane Q Example DOB: 3/4/1990'), { first: 'Jane', last: 'Q Example', dob: '03/04/1990', date: '3/4/1990' });
  assert.deepEqual(splitNameAndBirth('Example, Jane'), { first: 'Jane', last: 'Example', dob: null, date: null });
  assert.deepEqual(splitNameAndBirth(''), { first: null, last: null, dob: null, date: null });
  assert.deepEqual(splitLicense('TN - S1234567'), { state: 'TN', number: 'S1234567' });
  assert.deepEqual(splitLicense('S1234567, tn'), { state: 'TN', number: 'S1234567' });
  assert.deepEqual(splitLicense('S1234567'), { state: null, number: 'S1234567' });
});

test('the panel draws and edits a personal-auto record with its own sections, never commercial auto\'s', () => {
  const { record } = ok(readIntake(current.raw, { today }));
  assert.notEqual(sectionsOf(record), COMMERCIAL_SECTIONS);
  assert.equal(sectionsOf({ product: 'commercial-auto' }), COMMERCIAL_SECTIONS);
  assert.ok(sectionsOf(record).every((s) => !['operations', 'trailers', 'trailerInfo', 'claims'].includes(s.id)));
  // Every section's fields are paths of the record the reader makes.
  for (const s of sectionsOf(record)) assert.ok(s.id in record || s.list in record, s.id);
  assert.equal(fieldInfo('applicant.name', record).label, 'Named insured');
  assert.equal(fieldInfo('applicant.name', { product: 'commercial-auto' }).label, 'Company name');
  assert.equal(fieldInfo('vehicles[1].lienholder.state', record).kind, 'state');
  assert.equal(partsOf(record).unnamed, 'Unnamed client');
  // An edit recomputes nothing, and adds none of commercial auto's answers to the record.
  const before = JSON.stringify(record);
  assert.deepEqual(rederive(record, 'notes.text', { intake: { warnings: [] } }), []);
  assert.equal(JSON.stringify(record), before);
});

test('a personal-auto intake picks the personal-auto carriers, which fill nothing yet', () => {
  assert.equal(carrierForUrl('https://sales.geico.com/quote', { product: 'personal-auto' })?.id, 'geico-pa');
  assert.equal(carrierForUrl('https://www.foragentsonly.com/home/', { product: 'personal-auto' })?.id, 'progressive-pa');
  assert.equal(carrierForUrl('https://sales.geico.com/quote', { product: 'commercial-auto' })?.id, 'geico');
  assert.equal(carrierForUrl('https://sales.geico.com/quote')?.id, 'geico', 'with no intake, the first carrier on the host, as before');
  for (const id of ['geico-pa', 'progressive-pa']) {
    const c = carrierForUrl(id === 'geico-pa' ? 'https://sales.geico.com/quote' : 'https://www.foragentsonly.com/', { product: 'personal-auto' });
    assert.deepEqual([c?.rules.length, c?.useGenericRules, 'autoFillUrl' in (c ?? {}), 'display' in (c ?? {})], [0, false, false, false], id);
  }
});

test('the usage log reads a personal-auto intake without client details, as a commercial one', async () => {
  const r = ok(readIntake(current.raw, { today }));
  const terms = redactionTerms(r.record);
  for (const t of ['Jordan', 'Sample', 'Casey', 'S1234567', '1HGCM82633A004352', '100 Example St', 'Knoxville', '02/03/1985', 'sample.client@example.com']) {
    assert.ok(terms.includes(t), `redacted: ${t}`);
  }
  const PRIVATE = ['Jordan', 'Casey', 'Sample', 'S1234567', '1HGCM82633A004352', '100 Example', '010-0142', 'sample.client'];
  const summary = await intakeSummary(current.bytes, current.raw, r);
  const profile = intakeProfile(r.record, { today });
  for (const event of [summary, profile]) {
    const text = JSON.stringify(event);
    for (const p of PRIVATE) assert.ok(!text.includes(p), `no "${p}" in ${text}`);
  }
  assert.deepEqual(summary.counts, { drivers: 2, vehicles: 2, trailers: 0 });
  assert.equal(summary.businessClass, null);
});
