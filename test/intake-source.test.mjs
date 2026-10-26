import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields, readIntakePlaces } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { sourceFields, sourcePlace } from '../src/intake-source.js';
import { buildPlan } from '../src/plan.js';
import { SECTIONS, NOT_ON_INTAKE } from '../src/schema.js';
import { quoteProgress, carrierForUrl } from '../src/carriers.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const pdf = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const raw = await readIntakeFields(pdfjs, pdf('sample-intake.pdf'));
const places = await readIntakePlaces(pdfjs, pdf('sample-intake.pdf'));
// The 2026-10 form: no other-insurance-products box; Additional Notes and the Canada question added.
const rawNew = await readIntakeFields(pdfjs, pdf('sample-intake-2026-10.pdf'));
const placesNew = await readIntakePlaces(pdfjs, pdf('sample-intake-2026-10.pdf'));

test('the intake PDF says where each of its fields is drawn', () => {
  assert.deepEqual(places.pages, [{ width: 612, height: 792 }]);
  // The USDOT box, near the top left of the form (PDF units from the bottom left).
  assert.equal(places.fields.dot_number.page, 0);
  places.fields.dot_number.rect.forEach((n, i) => assert.ok(Math.abs(n - [74, 681, 162, 695][i]) <= 1, `USDOT box edge ${i}: ${n}`));
  for (const [form, fields] of [[raw, places], [rawNew, placesNew]]) {
    for (const name of Object.keys(form)) {
      const place = fields.fields[name];
      assert.ok(place, `${name} has a place`);
      assert.equal(place.page, 0);
      const [x1, y1, x2, y2] = place.rect;
      assert.ok(x1 < x2 && y1 < y2 && x2 <= 612 && y2 <= 792, `${name} is on the page`);
    }
  }
});

test('every answer of the client record points at the form fields it was read from', () => {
  const { rows } = normalizeIntake(raw, { today: new Date('2026-09-30') });
  for (const section of SECTIONS) {
    for (const [tpl] of section.fields) {
      const path = tpl.replace('[]', '[0]');
      const fields = sourceFields(path, rows);
      // The agent's (driver gender): no box on the form, never read.
      if (NOT_ON_INTAKE.has(tpl)) { assert.deepEqual(fields, [], `${path} isn't on the form`); continue; }
      assert.ok(fields.length, `${path} has a form field`);
      // A field of either form: the Additional Notes box and the Canada question are only on the
      // 2026-10 form.
      for (const name of fields) assert.ok(name in raw || name in rawNew, `${path}: ${name} is a field of the form`);
    }
  }
  // A TNI standard or an answer only the agent gives is on no field.
  assert.deepEqual(sourceFields('applicant.unknown', rows), []);
  assert.deepEqual(sourceFields('drivers[9].dob', rows), []);
});

test('a driver, vehicle or trailer is found in its own form row, blank rows skipped', () => {
  const blank = Object.fromEntries(Object.keys(raw).map((k) => [k, typeof raw[k] === 'boolean' ? false : '']));
  const twoRows = { ...blank, company_name: 'X', drv_first_2: 'Ann', drv_last_2: 'Lee', drv_dob_2: '01/02/1980', veh_vin_3: '1FTBR3X87MKA12345', veh_year_3: '2021' };
  const { record, rows } = normalizeIntake(twoRows, { today: new Date('2026-09-30') });
  assert.equal(record.drivers.length, 1);
  assert.deepEqual(rows, { drivers: [2], vehicles: [3], trailers: [] });
  assert.deepEqual(sourceFields('drivers[0].dob', rows), ['drv_dob_2']);
  assert.deepEqual(sourceFields('drivers[0].maritalStatus', rows), ['marital_stat_1.1']);
  assert.deepEqual(sourceFields('vehicles[0].vin', rows), ['veh_vin_3']);
  // Without rows (an intake saved by an earlier version), the item's own number.
  assert.deepEqual(sourceFields('vehicles[1].vin'), ['veh_vin_2']);
});

test('a place covers all of its fields: the whole driver row, the prior policy', () => {
  const intake = { ...normalizeIntake(raw, { today: new Date('2026-09-30') }), places };
  const dob = sourcePlace('drivers[0].dob', intake);
  assert.deepEqual(dob, { page: 0, rect: places.fields.drv_dob_1.rect, rects: [places.fields.drv_dob_1.rect] });
  const row = sourcePlace('drivers[0]', intake);
  assert.ok(row.rect[0] <= places.fields.drv_first_1.rect[0] && row.rect[2] >= places.fields.drv_cdl_yr_1.rect[2]);
  const prior = sourcePlace('priorInsurance[0]', intake);
  assert.equal(prior.rect[0], places.fields.ins_type_1.rect[0]);
  assert.equal(prior.rect[2], places.fields.ins_exp_1.rect[2]);
  assert.equal(sourcePlace('applicant.dot', { ...intake, places: null }), null, 'no places, no "See in PDF"');
  assert.equal(sourcePlace('coverage.unknown', intake), null);
});

// A derived answer (plan.js `from`) is marked on every answer it was worked out from: one mark
// each, on the first one's page; the box around them is what the viewer scrolls to.
test('a place for several answers marks each one, and the paths the PDF has no field for are skipped', () => {
  const intake = { ...normalizeIntake(raw, { today: new Date('2026-09-30') }), places };
  const both = sourcePlace(['applicant.dot', 'drivers[0].dob', 'coverage.unknown'], intake);
  assert.deepEqual(both.rects, [places.fields.dot_number.rect, places.fields.drv_dob_1.rect]);
  assert.equal(both.page, 0);
  for (const r of both.rects) assert.ok(both.rect[0] <= r[0] && both.rect[1] <= r[1] && both.rect[2] >= r[2] && both.rect[3] >= r[3], 'the box covers each mark');
  assert.deepEqual(sourcePlace(['applicant.dot', 'applicant.dot'], intake).rects, [places.fields.dot_number.rect], 'one mark per field');
  assert.equal(sourcePlace([], intake), null);
});

// W44-09: years in business read from the notes, when the form leaves them blank, are shown on the
// notes box they were read from, not on the blank year-established box.
test('an answer the reader took from the notes points at that notes box (W44-09)', () => {
  const today = { today: new Date('2026-10-26') };
  const blank = { ...rawNew, year_established: 'N/A', years_experience: 'N/A' };
  const fromNotes = { ...normalizeIntake({ ...blank, claims_details: 'No', additional_notes: 'In Biz for 3+ years' }, today), places: placesNew };
  assert.deepEqual(sourcePlace('applicant.yearsInBusiness', fromNotes).rects, [placesNew.fields.additional_notes.rect]);
  const fromClaims = { ...normalizeIntake({ ...blank, claims_details: 'No\nIn Biz for 3+ years', additional_notes: '' }, today), places: placesNew };
  assert.deepEqual(sourcePlace('applicant.yearsInBusiness', fromClaims).rects, [placesNew.fields.claims_details.rect]);
  // Read from its own box: that box.
  const boxed = { ...normalizeIntake({ ...rawNew, year_established: '2020' }, today), places: placesNew };
  assert.deepEqual(sourcePlace('applicant.yearsInBusiness', boxed).rects, [placesNew.fields.year_established.rect]);
  // An intake saved before readFrom: its own box.
  const { readFrom, ...saved } = fromNotes;
  assert.ok(readFrom);
  assert.deepEqual(sourcePlace('applicant.yearsInBusiness', saved).rects, [placesNew.fields.year_established.rect]);
});

// "No" in the USDOT box (TNI, 2026-10-26: answer to PR question): the has-a-USDOT-number answers
// it gives are shown on that box.
test('a USDOT answer read from "no" in the USDOT box points at that box', () => {
  const intake = { ...normalizeIntake({ ...rawNew, dot_number: 'No', mc_number: '', mc_dot_60days: '' }, { today: new Date('2026-10-26') }), places: placesNew };
  for (const step of [buildPlan(intake.record, progressive).find((s) => s.q === '1ED'), buildPlan(intake.record, geico).find((s) => s.name === 'Has a USDOT number')]) {
    assert.deepEqual(step.from, ['applicant.noDot']);
    assert.deepEqual(sourcePlace(step.from, intake).rects, [placesNew.fields.dot_number.rect]);
  }
  assert.deepEqual(sourceFields('applicant.noMc'), ['mc_number']);
});

test('the page strip names the quote step a page or a one-address step is on', () => {
  assert.deepEqual(quoteProgress(progressive, 'BusinessOwnerInfo'), { name: 'Business', index: 0, count: 7 });
  assert.deepEqual(quoteProgress(progressive, 'AddTrailer'), { name: 'Vehicles', index: 1, count: 7 });
  assert.deepEqual(quoteProgress(progressive, 'CoveragesRates'), { name: 'Rates', index: 5, count: 7 });
  assert.equal(quoteProgress(progressive, 'SaveQuote'), null, 'a page whose place wasn\'t recorded gets no number');
  assert.equal(quoteProgress(progressive, null), null);
  const practice = carrierForUrl('http://localhost:8792/test/replay/index.html');
  assert.deepEqual(quoteProgress(practice, 'AddDriver'), { name: 'Drivers', index: 2, count: 7 }, 'practice pages too');
  assert.deepEqual(quoteProgress(amwins, '/application/businessauto', 'Vehicles'), { name: 'Vehicles', index: 2, count: 5 });
  assert.equal(quoteProgress(amwins, '/application/businessauto', undefined), null, 'an AmWINS step not read yet');
  assert.equal(quoteProgress({ id: 'portal-only' }, '/quote'), null, 'a carrier without steps');
  // GEICO: nine steps at one address, each its own step heading.
  assert.deepEqual(quoteProgress(geico, '/quote', 'Vehicles'), { name: 'Vehicles', index: 2, count: 9 });
  assert.deepEqual(quoteProgress(geico, '/quote', 'Payment Information'), { name: 'Payment Information', index: 8, count: 9 });
  assert.equal(quoteProgress(geico, '/quote', undefined), null, 'a GEICO step not read yet');
  assert.deepEqual(geico.quoteSteps.map((s) => s.step), geico.layoutSteps);
  // A page belongs to one step only.
  const pages = progressive.quoteSteps.flatMap((s) => s.pages);
  assert.equal(new Set(pages).size, pages.length);
  assert.deepEqual(amwins.quoteSteps.map((s) => s.step), amwins.layoutSteps);
});
