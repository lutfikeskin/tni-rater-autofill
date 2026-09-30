import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseAddress, parseLicense, toMoney, toDate, vinProblem, parseLimitDeductible } from '../src/normalize.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';

// test/fixtures/sample-intake.pdf is the real TNI form filled with made-up data, including the
// kinds of mess real clients produce (stray tabs, "45,000$", state prefix on the license, etc.).
const fixture = new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake.pdf', import.meta.url)));
const raw = await readIntakeFields(pdfjs, fixture);
const { record, warnings } = normalizeIntake(raw, { today: new Date('2026-09-30') });
const msgs = warnings.map((w) => `${w.path}: ${w.msg}`).join('\n');

test('business details are cleaned up', () => {
  assert.equal(record.applicant.name, 'Sample Expedite LLC');
  assert.equal(record.applicant.dot, '1234567');
  assert.equal(record.applicant.mc, '7654321');
  assert.equal(record.applicant.phone, '(555) 201-0199');
  assert.equal(record.applicant.owner2, null, '"N/A" becomes empty');
  assert.equal(record.applicant.yearsExperience, 3);
  assert.equal(record.applicant.yearsInBusiness, 5);
  assert.equal(record.applicant.fein, null);
});

test('garaging address without commas is split and flagged', () => {
  assert.deepEqual(record.garaging, { street: '125 Maple Leaf Dr', unit: 'Apt 4', city: 'Springfield', state: 'IL', zip: '62704' });
  assert.match(msgs, /garaging\.city: Address had no commas/);
});

test('drivers: license prefix removed, two-word first name flagged, short dates fixed', () => {
  assert.equal(record.drivers.length, 2);
  const [d1, d2] = record.drivers;
  assert.equal(d1.licenseNumber, 'S12345678901');
  assert.equal(d1.licenseState, 'IL');
  assert.equal(d1.first, 'Jordan Avery', 'kept as written, not guessed');
  assert.match(msgs, /drivers\[0\]\.first: .*more than one word/);
  assert.equal(d1.maritalStatus, 'Single');
  assert.equal(d2.dob, '07/09/1995');
  assert.equal(d2.cdl, true);
  assert.equal(d2.cdlYear, 2019);
  assert.equal(d2.maritalStatus, 'Married');
});

test('vehicles: values parsed, bad VIN flagged, N/A trailer rows dropped', () => {
  assert.equal(record.vehicles.length, 2);
  assert.equal(record.vehicles[0].vin, '1FTBR3X87MKA12345');
  assert.equal(record.vehicles[0].value, 45000);
  assert.equal(record.vehicles[1].value, 38000);
  assert.match(msgs, /vehicles\[1\]\.vin: .*check-digit/);
  assert.doesNotMatch(msgs, /vehicles\[0\]\.vin/);
  assert.equal(record.trailers.length, 0);
});

test('claims box holding other answers is flagged, ownership hint surfaced once', () => {
  assert.equal(record.claims.hasClaims, false, 'first line "No" answers the claims question');
  assert.match(msgs, /claims\.text: Claims box has 4 lines/);
  const own = warnings.filter((w) => w.path === 'operations.vehicleOwnership');
  assert.equal(own.length, 1);
  assert.match(own[0].msg, /Financed/);
});

test('coverage', () => {
  assert.equal(record.coverage.autoLiabLimit, '$1M CSL');
  assert.equal(record.coverage.cargoLimit, 100000);
  assert.equal(record.coverage.cargoDeductible, 1000);
  assert.equal(record.coverage.gl, false);
});

test('rejects PDFs that are not the TNI form', () => {
  assert.ok(normalizeIntake({ some_field: 'x' }).error);
});

test('helpers', () => {
  assert.equal(toMoney('40,000$'), 40000);
  assert.equal(toMoney('$1.5M'), 1500000);
  assert.equal(toMoney('about 40k'), null);
  assert.equal(toDate('2/30/2020'), null);
  assert.equal(toDate('1-2-03'), '01/02/2003');
  assert.equal(vinProblem('1FTBR3X87MKA12345'), null);
  assert.match(vinProblem('1FTBR3X87MKA1234'), /16 characters/);
  assert.match(vinProblem('1FTBR3X87MKAO2345'), /I, O or Q/);
  assert.deepEqual(parseLimitDeductible('$100K/$2.5K Ded'), { limit: 100000, deductible: 2500 });
  assert.deepEqual(parseLicense('MD - 10123456789'), { state: 'MD', number: '10123456789' });
  assert.deepEqual(parseLicense('D123-456-789'), { state: null, number: 'D123-456-789' });
  assert.equal(parseAddress('100 Main St, Rock Hill, SC 29730').city, 'Rock Hill');
  assert.equal(parseAddress('100 Main St, Rock Hill, SC 29730').confident, true);
  assert.equal(parseAddress('9 Oak Ave N Fort Worth TX 76102').city, 'Fort Worth');
  assert.equal(parseAddress('9 Oak Ave N Fort Worth TX 76102').street, '9 Oak Ave N');
  assert.equal(parseAddress('PO Box 12 Somewhere').state, null);
});

test('plan resolves the chosen driver and vehicle', () => {
  const plan = buildPlan(record, carrierForUrl('https://www.foragentsonly.com/quote'), { drivers: 1, vehicles: 1 });
  const step = (p) => plan.find((s) => s.path === p);
  assert.equal(step('drivers[1].first').value, 'Casey');
  assert.equal(step('vehicles[1].make').value, 'ISUZU');
  assert.equal(step('applicant.dot').value, '1234567');
  assert.equal(step('drivers[1].dob').kind, 'date');
});

test('carrier detection', () => {
  assert.equal(carrierForUrl('https://www.foragentsonly.com/x')?.id, 'progressive');
  assert.equal(carrierForUrl('https://agents.geico.com/x')?.id, 'geico');
  assert.equal(carrierForUrl('https://notgeico.com/x'), null);
  assert.equal(carrierForUrl('https://example.com/?u=geico.com'), null);
});

test('redaction list covers names and IDs but not makes or states', () => {
  const terms = redactionTerms(record);
  for (const t of ['Sample Expedite LLC', 'Jordan', 'Sample', 'Casey', '1234567', 'S12345678901', '1FTBR3X87MKA12345', 'Springfield']) {
    assert.ok(terms.includes(t), t);
  }
  for (const t of ['FORD', 'IL', 'LLC', 'Van']) assert.ok(!terms.includes(t), t);
});

test('progressive: intake answers are translated into Progressive wording', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/Express/Default.aspx');
  assert.equal(carrier.id, 'progressive');
  assert.equal(carrier.world, 'MAIN');
  const plan = buildPlan(record, carrier, {});
  const byQ = (q) => plan.find((s) => s.q === q);
  assert.equal(byQ('1ED').value, 'Yes - the customer has a USDOT number');
  assert.equal(byQ('1F3').value, '1234567');
  assert.equal(byQ('22D').value, 'Corporation or LLC / Non-Profit', 'LLC in the company name');
  // Owner "Jordan Avery Sample" matches driver 1 by last name.
  assert.equal(byQ('295').value, 'Jordan Avery');
  assert.equal(byQ('297').value, 'Sample');
  assert.equal(byQ('2BB').value, '02/03/1988');
  assert.deepEqual(['2DB', '2DD', '2DF'].map((q) => byQ(q).value), ['555', '201', '0199']);
  assert.ok(byQ('450').note, 'MVR/CLUE order is marked for the agent, never filled');
  assert.equal(byQ('2B9D').value, 501, 'Unlimited radius picks "More than 500 miles"');
  assert.equal(byQ('2C05').value, 'Business Only');
  assert.equal(byQ('2C1A').value, true, 'has an MC number, so for-hire');
  assert.equal(byQ('2CA7').value, null, 'ownership blank on the intake: left for the agent');
  assert.equal(byQ('2CCE').value, '$0 to $2,000');
  assert.equal(byQ('216F').value, '$100000/$1000');
  assert.equal(byQ('28AC').value, 'IL');
  assert.equal(byQ('81').value, true);
});

test('progressive: loan/lease follows vehicle ownership once the agent fills it in', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = structuredClone(record);
  r.operations.vehicleOwnership = 'Financed';
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '2CA7').value, 'Yes - Loan');
  r.coverage.cargo = false;
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '216F').value, 'Not selected');
});

test('license format and expired prior policy are flagged', () => {
  // Fixture license S12345678901 is a valid IL shape; an 11-digit MD number is not.
  assert.doesNotMatch(msgs, /license\.format|doesn't look like a IL license/);
  const r = normalizeIntake({ ...raw, drv_lic_1: 'MD - 10123456789', drv_state_1: 'MD', ins_exp_1: '08/14/2026' }, { today: new Date('2026-09-30') });
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('license.format'));
  assert.ok(codes.includes('prior.expired'));
  assert.ok(!normalizeIntake({ ...raw, ins_exp_1: '12/31/2026' }, { today: new Date('2026-09-30') }).warnings.some((w) => w.code === 'prior.expired'));
});

test('progressive: fixes from the first live usage log', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const plan = buildPlan(record, carrier, {});
  const byQ = (q) => plan.find((s) => s.q === q);
  // Prior policy is Progressive *personal* auto: not "insured with Progressive Commercial Auto".
  assert.equal(byQ('198').value, false);
  assert.equal(byQ('81').re, '^is the customer currently insured$');
  // 2F6 is the hazmat placard question, not a consent question.
  assert.equal(byQ('2F6').value, false);
  assert.equal(byQ('2F6').note, null);
  // USDOT-registered name/addresses are picked over "Enter a different ...".
  for (const q of ['22F', '277', '2A5']) {
    assert.equal(byQ(q).kind, 'pick-not');
    assert.equal(byQ(q).value, '^enter a different');
  }
  assert.equal(byQ('28B9').value, 'S12345678901');
});
