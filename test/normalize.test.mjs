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

test('drivers: license prefix preserved, two-word first name flagged, short dates fixed', () => {
  assert.equal(record.drivers.length, 2);
  const [d1, d2] = record.drivers;
  assert.equal(d1.licenseNumber, 'ILS12345678901', 'leading state code stays in the number');
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
  assert.deepEqual(parseLicense('MD - 10123456789'), { state: 'MD', number: 'MD10123456789' });
  assert.deepEqual(parseLicense('D123-456-789'), { state: null, number: 'D123456789' }, 'no dashes, ever');
  assert.deepEqual(parseLicense('md 1234 5678 901'), { state: 'MD', number: 'MD12345678901' });
  assert.equal(parseAddress('77 Birch Hollow Ci Apt 2 Dover DE 19901').street, '77 Birch Hollow Cir');
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
  assert.equal(step('vehicles[1].vin').value, '1FTBR3X80MKA12399');
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
  for (const t of ['Sample Expedite LLC', 'Jordan', 'Sample', 'Casey', '1234567', 'ILS12345678901', '1FTBR3X87MKA12345', 'Springfield']) {
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
  assert.equal(byQ('29F').value, true, 'owner drives answer follows the intake');
  for (const q of ['2DB', '2DD', '2DF', '77']) {
    assert.equal(carrier.rules.find((rule) => rule.q === q).ignore, true, `${q} is intentionally left blank`);
  }
  assert.ok(byQ('450').note, 'MVR/CLUE order is marked for the agent, never filled');
  assert.equal(byQ('2B9D').value, 501, 'Unlimited radius picks "More than 500 miles"');
  assert.equal(byQ('2C05').value, 'Business Only');
  assert.equal(byQ('2C1A').value, true, 'for-hire hauling is the standard trucking answer');
  assert.equal(byQ('2CA7').value, 'No', 'loan/lease: always No');
  assert.equal(byQ('2CCE').value, '$0 to $2,000', 'active vehicle entry uses the standard equipment range');
  assert.equal(byQ('216F').value, '$100000/$1000');
  assert.equal(byQ('28AC').value, 'IL');
  assert.equal(byQ('81').value, true);
});

test('progressive: loan/lease stays at the preliminary No default', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = structuredClone(record);
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '2CA7').value, 'No');
  r.operations.vehicleOwnership = 'Financed';
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '2CA7').value, 'No');
});

test('progressive: cargo not wanted means "Not selected"', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = structuredClone(record);
  r.coverage.cargo = false;
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '216F').value, 'Not selected');
});

test('current policy dates are used as written and expired dates require review', () => {
  const r = normalizeIntake({ ...raw, ins_exp_1: '08/14/2025' }, { today: new Date('2026-09-30') });
  assert.equal(r.record.priorInsurance[0].expiration, '08/14/2025');
  assert.equal(r.record.priorInsurance[0].expired, true);
  assert.ok(r.warnings.some((w) => w.code === 'prior-expiration.expired'));
  const c = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const expiration = buildPlan(r.record, c).find((s) => s.q === '9D');
  assert.match(expiration.note, /expired/);
  assert.equal(expiration.value, null);
});

test('progressive: fixes from the first live usage log', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const plan = buildPlan(record, carrier, {});
  const byQ = (q) => plan.find((s) => s.q === q);
  // Fixture's current insurance is Progressive *personal* auto: doesn't count.
  assert.equal(byQ('198').value, false);
  const commercial = structuredClone(record);
  commercial.priorInsurance[0].type = 'Commercial Auto';
  assert.equal(buildPlan(commercial, carrier).find((s) => s.q === '198').value, true);
  const noLimit = structuredClone(commercial);
  noLimit.priorInsurance[0].limit = null;
  assert.equal(buildPlan(noLimit, carrier).find((s) => s.q === '198').value, false);
  const other = structuredClone(commercial);
  other.priorInsurance[0].carrier = 'GEICO';
  assert.equal(buildPlan(other, carrier).find((s) => s.q === '198').value, false);
  assert.equal(byQ('81').re, '^is the customer currently insured$');
  // 2F6 is the hazmat placard question, not a consent question.
  assert.equal(byQ('2F6').value, false);
  assert.equal(byQ('2F6').note, null);
  // USDOT-registered name/addresses are picked over "Enter a different ...".
  for (const q of ['22F', '277', '2A5']) {
    assert.equal(byQ(q).kind, 'pick-not');
    assert.equal(byQ(q).value.not, '^enter a different');
  }
  assert.equal(byQ('2A5').value.prefer, undefined);
  // Without a registered address the owner's home address boxes get the intake's address.
  assert.equal(byQ('2AA').value, '125 Maple Leaf Dr');
  assert.equal(byQ('2AE').value, '62704');
  assert.equal(byQ('28B9').value, 'ILS12345678901');
});

test('progressive: standard answers for follow-up questions', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const byQ = (q, r = record) => buildPlan(r, carrier).find((s) => s.q === q);
  assert.equal(byQ('2CCC').value, true, 'comprehensive/collision: yes');
  assert.ok(byQ('1FCD').note, 'unresolved per-vehicle column is surfaced for review');
  assert.ok(byQ('1FF2').note, 'multi-vehicle rental column is scoped for review');
  assert.equal(byQ('2158').value, false, 'special cargo: no');
  assert.equal(byQ('215A').value, false, 'special cargo: no');
  assert.equal(byQ('216A').value, 'Consumer Goods', '"General freight hauler"');
  assert.equal(byQ('216B').value, 'Other Consumer Goods');
  assert.equal(byQ('83').value, true);
  assert.equal(byQ('A2').value, 'None');
  assert.equal(byQ('28C1').value, false);
  const single = structuredClone(record);
  single.vehicles = [single.vehicles[0]];
  const singleByQ = (q) => buildPlan(single, carrier).find((s) => s.q === q);
  assert.equal(singleByQ('2CCE').value, '$0 to $2,000');
  // Filings: the all-vehicles attestation is agent-controlled; Federal is checked only when the
  // intake explicitly names it, and MCS-90 stays under portal/agent control.
  assert.equal(byQ('F11').value, null);
  assert.ok(carrier.rules.find((r) => r.q === 'F11').review);
  assert.equal(buildPlan(record, carrier).find((s) => s.name === 'Federal filing').value, true);
  assert.equal(buildPlan(record, carrier).find((s) => s.name === 'MCS-90 (preserve portal selection)').value, null);
  const noFilings = structuredClone(record);
  noFilings.operations.filingsRequired = false;
  assert.equal(byQ('F11', noFilings).value, null);
  assert.equal(buildPlan(noFilings, carrier).find((s) => s.name === 'Federal filing').value, null);
  assert.equal(byQ('CA', noFilings).value, false);
  // No USDOT and not getting one: "No".
  const noDot = structuredClone(record);
  noDot.applicant.dot = null;
  assert.equal(byQ('1ED', noDot).value, 'No - and the customer will not have a USDOT number');
  assert.equal(byQ('20F', noDot).value, null);
  // Other freight descriptions aren't guessed.
  const other = structuredClone(record);
  other.operations.whatHaul = 'Auto parts';
  assert.equal(byQ('216A', other).value, null);
});

test('progressive: filings require matching evidence and do not infer Federal from USDOT alone', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const noDot = structuredClone(record);
  noDot.applicant.dot = null;
  const noDotPlan = buildPlan(noDot, carrier);
  assert.equal(noDotPlan.find((s) => s.q === 'CA').value, null);
  assert.match(noDotPlan.find((s) => s.q === 'CA').note, /no USDOT/);
  assert.equal(noDotPlan.find((s) => s.name === 'Federal filing').value, null);

  const stateOnly = structuredClone(record);
  stateOnly.operations.filingsWhich = 'State filing';
  assert.equal(buildPlan(stateOnly, carrier).find((s) => s.name === 'Federal filing').value, null);
});

test('progressive: second live quote — business type, standard vehicle answers, buttons', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const single = structuredClone(record);
  single.vehicles = [single.vehicles[0]];
  const plan = buildPlan(single, carrier, {});
  const byQ = (q, r = single) => buildPlan(r, carrier).find((s) => s.q === q);
  assert.equal(byQ('239').value, 'For Hire Trucking', 'Expediter');
  assert.equal(byQ('267').value, 'Other For-Hire Trucking', 'Expediter');
  const other = structuredClone(record);
  other.operations.businessClass = 'Dry Van';
  assert.equal(byQ('239', other).value, 'Dry Van', 'anything else: as on the intake');
  assert.equal(byQ('267', other).value, 'Dry Van');
  assert.equal(byQ('1FF2').value, '$40 per day, $1,200 max');
  assert.equal(carrier.replaceChoices, true);
  const federal = plan.find((s) => s.name === 'Federal filing');
  assert.equal(federal.value, true, 'filings needed: Federal ticked');
  assert.equal(plan.find((s) => s.name === 'MCS-90 (preserve portal selection)').value, null);
  assert.equal(byQ('F11').value, null);
  assert.equal(byQ('2CA7').value, 'No');
  assert.equal(byQ('2CCE').value, '$0 to $2,000');
  assert.equal(byQ('2CE3').value, null, 'range alone does not prove there is no equipment');
  const equipment = structuredClone(single);
  equipment.operations.equipVehicle = 500;
  assert.equal(buildPlan(equipment, carrier).find((s) => s.q === '2CE3').value, false, 'a stated equipment amount clears the no-equipment checkbox');
  assert.equal(byQ('2CE8').value, 45000);
  assert.equal(byQ('27E').value, '125 Maple Leaf Dr');
  assert.equal(byQ('3E98').value, 'Automatic payments from checking account');
  assert.equal(byQ('32CC').value, true);
  assert.equal(byQ('32D0').value, false);
  assert.equal(byQ('32DD').value, false);
  const actions = plan.filter((s) => s.kind === 'action');
  assert.deepEqual(actions.map((a) => a.action), ['verifyDot', 'vehicleTile:0', 'lookupVin:0', 'openCargo', 'addCommodity', 'doneCargo', 'recalculate', 'billPlan', 'print', 'printSend']);
  assert.ok(actions.find((a) => a.action === 'lookupVin:0').immediate);
  assert.equal(actions.find((a) => a.action === 'openCargo').near, 'motor truck cargo');
  const printRe = new RegExp(actions.find((a) => a.action === 'print').text, 'i');
  for (const t of ['Print, Email, Fax', 'Print/Email/Fax', 'Print, Email or Fax', 'Print']) assert.ok(printRe.test(t), t);
  assert.ok(!printRe.test('Print/Send'));
  assert.ok(new RegExp(actions.find((a) => a.action === 'billPlan').text, 'i').test('View Bill plan options'));
  assert.equal(actions.find((a) => a.action === 'vehicleTile:0').text, '^Cargo Van$');
  assert.deepEqual(actions.find((a) => a.action === 'lookupVin:0').after, ['vehicles[0].vin']);
  const noCargo = structuredClone(single);
  noCargo.coverage.cargo = false;
  const noCargoActions = buildPlan(noCargo, carrier).filter((s) => s.kind === 'action').map((a) => a.action);
  assert.ok(!noCargoActions.includes('openCargo'));
  assert.deepEqual(buildPlan(noCargo, carrier).find((s) => s.action === 'billPlan').afterAll, ['coverage.autoLiabLimit']);
  assert.deepEqual(buildPlan(noCargo, carrier).find((s) => s.action === 'recalculate').afterActions, []);
  assert.deepEqual(plan.find((s) => s.action === 'recalculate').afterActions, ['doneCargo']);
  assert.deepEqual(plan.find((s) => s.action === 'billPlan').afterActions, ['recalculate']);
  assert.equal(plan.find((s) => s.action === 'billPlan').readiness, 'premium');
  assert.equal(plan.find((s) => s.action === 'printSend').afterAll.length, 4);
  assert.ok(buildPlan(record, carrier, { vehicles: 1 }).some((s) => s.action === 'lookupVin:1'));
  assert.equal(plan.filter((s) => s.action === 'print').length, 1);
  assert.ok(carrier.autoFillUrl.test('https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=AddVehicle'));
  assert.ok(!carrier.autoFillUrl.test('https://www.foragentsonly.com/newbusiness/quotesearch/'));
});

test('practice pages get the Progressive rules, marked as practice', () => {
  const c = carrierForUrl('http://localhost:8792/test/replay/?bakeoff=1&pageName=AddVehicle');
  assert.equal(c.id, 'progressive');
  assert.equal(c.practice, true);
  assert.equal(c.world, 'MAIN');
  assert.equal(carrierForUrl('http://localhost:8792/test/mock-rater/index.html').id, 'test');
  assert.equal(carrierForUrl('https://clpolicy.foragentsonly.com/Express/Default.aspx').practice, undefined);
});

test('review gates do not guess driver history or requested GL underwriting', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = structuredClone(record);
  r.claims.hasClaims = false;
  r.coverage.gl = true;
  const plan = buildPlan(r, carrier);
  assert.equal(plan.find((s) => s.q === '28F5').value, null);
  assert.match(plan.find((s) => s.q === '28F5').note, /each driver/);
  assert.equal(plan.find((s) => s.q === 'A2').value, 'None', 'requested GL is not evidence of existing other business insurance');
  assert.ok(plan.some((s) => s.kind === 'review' && s.pages.includes('CoveragesRates')));
  assert.equal(plan.find((s) => s.q === '1E7C').ignore, true);
});

test('expiration review uses the corrected date, not stale normalization status', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = normalizeIntake({ ...raw, ins_exp_1: '08/14/2025' }, { today: new Date('2026-09-30') }).record;
  r.priorInsurance[0].expiration = '08/14/2099';
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '9D').note, null);
  r.priorInsurance[0].expiration = '02/30/2099';
  assert.match(buildPlan(r, carrier).find((s) => s.q === '9D').note, /valid/);
});
