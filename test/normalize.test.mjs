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

test('claims box: first line answers claims, the rest are notes (no warning), ownership read from them', () => {
  assert.equal(record.claims.hasClaims, false, 'first line "No" answers the claims question');
  assert.equal(record.claims.notes, '3 Years\nFinanced\nDec page will be provided');
  assert.doesNotMatch(msgs, /claims\.text/);
  assert.equal(record.operations.vehicleOwnership, 'Financed');
  assert.equal(warnings.filter((w) => w.path === 'operations.vehicleOwnership').length, 0);
});

test('"Unlimited" radius needs no warning; an unreadable one still does', () => {
  assert.equal(record.operations.radius, 'Unlimited');
  assert.doesNotMatch(msgs, /operations\.radius/);
  const odd = normalizeIntake({ ...raw, avg_radius: 'around town' }, { today: new Date('2026-09-30') });
  assert.ok(odd.warnings.some((w) => w.code === 'radius.not-miles'));
});

test('claims box without a yes/no keeps everything as notes and leaves the claims answer open', () => {
  const r = normalizeIntake({ ...raw, claims_details: 'Leased\nNew venture' }, { today: new Date('2026-09-30') }).record;
  assert.equal(r.claims.hasClaims, null);
  assert.equal(r.claims.notes, 'Leased\nNew venture');
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
  // The unit after the comma, in front of the city (2026-10-05 FL run: city read as "APT … ORLANDO").
  assert.deepEqual(
    (({ street, unit, city }) => ({ street, unit, city }))(parseAddress('100 Sample Way, APT 12 ORLANDO, FL, 32801')),
    { street: '100 Sample Way', unit: 'APT 12', city: 'ORLANDO' });
  assert.equal(parseAddress('100 Sample Way, #12 Rock Hill, SC 29730').unit, '#12');
  assert.equal(parseAddress('100 Sample Way, #12 Rock Hill, SC 29730').city, 'Rock Hill');
  // A city that starts like a unit word stays whole.
  assert.equal(parseAddress('100 Main St, Ste Genevieve, MO 63670').city, 'Ste Genevieve');
  assert.equal(parseAddress('100 Main St, Ste Genevieve, MO 63670').unit, null);
  assert.equal(parseAddress('100 Main St Apt 4, Dover, DE 19901').unit, 'Apt 4');
  assert.equal(parseAddress('100 Main St Apt 4, Dover, DE 19901').city, 'Dover');
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
  assert.deepEqual(['2DB', '2DD', '2DF'].map((q) => byQ(q).value), [null, null, null]);
  assert.ok(['2DB', '2DD', '2DF'].every((q) => byQ(q).ignore), 'optional phone is deliberately left blank');
  assert.ok(byQ('450').note, 'MVR/CLUE order is marked for the agent, never filled');
  assert.equal(byQ('2B9D').value, 501, 'Unlimited radius picks "More than 500 miles"');
  assert.equal(byQ('2C05').value, 'Business Only');
  assert.equal(byQ('2C1A').value, true, 'has an MC number, so for-hire');
  assert.equal(byQ('2CA7').value, 'Yes - Loan', 'loan/lease: "Financed" in the claims-box notes');
  const loan = (ownership) => buildPlan({ ...record, operations: { ...record.operations, vehicleOwnership: ownership } }, carrier, {}).find((s) => s.q === '2CA7').value;
  assert.equal(loan('Owned'), 'No');
  assert.equal(loan(null), 'No');
  assert.equal(loan('Leased'), 'Yes - Lease');
  assert.equal(byQ('2CCE').value, '$0 to $2,000');
  assert.equal(byQ('216F').value, '$100000/$1000');
  assert.equal(byQ('28AC').value, 'IL');
  assert.equal(byQ('81').value, true);
});

test('progressive: cargo not wanted means "Not selected"', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const r = structuredClone(record);
  r.coverage.cargo = false;
  assert.equal(buildPlan(r, carrier).find((s) => s.q === '216F').value, 'Not selected');
});

test('current policy dates are used as written and expired dates are warned', () => {
  const r = normalizeIntake({ ...raw, ins_exp_1: '08/14/2025' }, { today: new Date('2026-09-30') });
  assert.equal(r.record.priorInsurance[0].expiration, '08/14/2025');
  assert.ok(r.warnings.some((w) => w.code === 'prior-expiration.expired'));
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
  // "Currently insured" (any carrier) by its data-model name, not the "…with Progressive" question.
  assert.equal(byQ('81').field, 'MoreBusinessInput.HasCurrentInsurancePolicy');
  // 2F6 is the hazmat placard question, not a consent question.
  assert.equal(byQ('2F6').value, false);
  assert.equal(byQ('2F6').note, null);
  // USDOT-registered name/addresses are picked over "Enter a different ...".
  for (const q of ['22F', '277']) {
    assert.equal(byQ(q).kind, 'pick-not');
    assert.equal(byQ(q).value.not, '^enter a different');
  }
  assert.equal(byQ('2A5').kind, 'first-option');
  // Without a registered address the owner's home address box gets the whole address, then
  // Progressive's first suggestion.
  assert.equal(byQ('2AA').kind, 'address-suggest');
  assert.equal(byQ('2AA').value, '125 Maple Leaf Dr Apt 4, Springfield, IL 62704');
  assert.equal(byQ('2A9').value, '125 Maple Leaf Dr Apt 4, Springfield, IL 62704');
  assert.equal(byQ('2CE8').value, 45000);
  assert.equal(byQ('2AE').value, '62704');
  assert.equal(byQ('28B9').value, 'ILS12345678901');
});

test('progressive: standard answers for follow-up questions', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const byQ = (q, r = record) => buildPlan(r, carrier).find((s) => s.q === q);
  assert.equal(byQ('2CCC').value, true, 'comprehensive/collision: yes');
  assert.equal(byQ('2158').value, false, 'special cargo: no');
  assert.equal(byQ('215A').value, false, 'special cargo: no');
  assert.equal(byQ('216A').value, 'Consumer Goods', '"General freight hauler"');
  assert.equal(byQ('216B').value, 'Other Consumer Goods');
  assert.equal(byQ('83').value, true);
  assert.equal(byQ('A2').value, 'None');
  assert.equal(byQ('28C1').value, false);
  // Filings: "all vehicles on quote" and Federal only when the intake says filings are needed;
  // MCS-90 is ticked by the page with Federal, so it's left alone.
  assert.equal(byQ('F11').value, true);
  assert.equal(buildPlan(record, carrier).find((s) => s.re === '^mcs ?-?90$').ignore, true);
  const noFilings = structuredClone(record);
  noFilings.operations.filingsRequired = false;
  assert.equal(byQ('F11', noFilings).value, false);
  assert.equal(byQ('CA', noFilings).value, false);
  // No USDOT and not getting one: "No"; the "belongs to the business" question only exists with one.
  const noDot = structuredClone(record);
  noDot.applicant.dot = null;
  assert.equal(byQ('1ED', noDot).value, 'No - and the customer will not have a USDOT number');
  assert.equal(byQ('20F', noDot).ignore, true);
  assert.equal(byQ('20F').value, true, 'standard: the USDOT number belongs to the business');
  // Other freight descriptions aren't guessed.
  const other = structuredClone(record);
  other.operations.whatHaul = 'Auto parts';
  assert.equal(byQ('216A', other).value, null);
});

test('progressive: second live quote — business type, standard vehicle answers, buttons', () => {
  const carrier = carrierForUrl('https://clpolicy.foragentsonly.com/');
  const plan = buildPlan(record, carrier, {});
  const byQ = (q, r = record) => buildPlan(r, carrier).find((s) => s.q === q);
  assert.equal(byQ('239').value, 'For Hire Trucking', 'Expediter');
  assert.equal(byQ('267').value, 'Other For-Hire Trucking', 'Expediter');
  const other = structuredClone(record);
  other.operations.businessClass = 'Dry Van';
  assert.equal(byQ('239', other).value, 'Dry Van', 'other classes: as written on the intake');
  assert.equal(byQ('267', other).ignore, true, 'type of trucker only exists for For Hire Trucking');
  assert.equal(byQ('1FF2').value, '$40 per day, $1,200 max');
  // Two vehicles on the fixture: a step per vehicle, each finding its row by year/make/model;
  // the active vehicle's is the one a page showing one vehicle at a time uses.
  const rental = (active) => buildPlan(record, carrier, active).filter((s) => s.q === '1FF2');
  assert.deepEqual(rental({}).map((s) => [s.vehicleHint, s.activeVehicle]), [[['2021', 'ford', 'transit 350'], true], [['2019', 'isuzu', 'npr hd'], false]]);
  assert.deepEqual(rental({ vehicles: 1 }).map((s) => s.activeVehicle), [false, true]);
  assert.equal(carrier.replaceChoices, true);
  const federal = plan.find((s) => s.re === '^federal( liability)?( filing)?$');
  assert.equal(federal.value, true, 'filings needed: Federal ticked');
  assert.equal(plan.find((s) => s.re === '^mcs ?-?90$').ignore, true);
  assert.equal(byQ('F11').value, true);
  assert.equal(byQ('2CA7').value, 'Yes - Loan', 'financed (claims-box notes)');
  assert.equal(byQ('2CCE').value, '$0 to $2,000');
  assert.equal(byQ('2CE3').value, true);
  assert.equal(byQ('1FCD').value, '$1,000 Deductible');
  assert.equal(byQ('1FD2').value, '$1,000 Deductible');
  assert.equal(byQ('2BB4').ignore, true, 'GVW comes from the VIN lookup');
  assert.equal(byQ('28E6').value, false, 'driver 1 has no CDL');
  assert.ok(carrier.advance.exceptPages.includes('AdditionalDetails'));
  assert.ok(new RegExp(carrier.advance.text, 'i').test('Ok, start quote.'));
  assert.ok(new RegExp(carrier.advance.text, 'i').test('Continue'));
  assert.ok(!new RegExp(carrier.advance.text, 'i').test('Finish & Buy'));
  assert.equal(byQ('2CE8').value, 45000);
  assert.equal(byQ('27E').kind, 'address-suggest');
  assert.equal(byQ('27E').value, '125 Maple Leaf Dr Apt 4, Springfield, IL 62704');
  assert.equal(byQ('27E').fallback, '125 Maple Leaf Dr');
  assert.equal(byQ('3E98').value, 'Automatic payments from checking account');
  assert.equal(byQ('32CC').value, true);
  const actions = plan.filter((s) => s.kind === 'action');
  assert.deepEqual(actions.map((a) => a.action), ['verifyDot', 'addVehicle:0', 'addDriver:0', 'businessTypeSearch', 'vehicleTile:0', 'lookupVin:0', 'ntlStillAdded', 'openCargo', 'addCargoCommodity', 'doneCargo', 'billPlan', 'recalculate', 'print']);
  assert.deepEqual(actions.find((a) => a.action === 'addVehicle:0').unlessActions, ['lookupVin:0']);
  assert.equal(actions.find((a) => a.action === 'addVehicle:0').opener, '^add$');
  assert.ok(actions.find((a) => a.action === 'lookupVin:0').immediate);
  assert.equal(actions.find((a) => a.action === 'openCargo').near, 'motor truck cargo');
  const printRe = new RegExp(actions.find((a) => a.action === 'print').text, 'i');
  for (const t of ['Print, Email, Fax', 'Print/Email/Fax', 'Print, Email or Fax', 'Print']) assert.ok(printRe.test(t), t);
  assert.ok(!printRe.test('Print/Send'));
  assert.ok(new RegExp(actions.find((a) => a.action === 'billPlan').text, 'i').test('View Bill plan options'));
  assert.equal(actions.find((a) => a.action === 'vehicleTile:0').text, '^Cargo Van$');
  assert.deepEqual(actions.find((a) => a.action === 'lookupVin:0').after, ['vehicles[0].vin']);
  const noCargo = structuredClone(record);
  noCargo.coverage.cargo = false;
  const noCargoActions = buildPlan(noCargo, carrier).filter((s) => s.kind === 'action').map((a) => a.action);
  assert.ok(!noCargoActions.includes('openCargo'));
  assert.deepEqual(buildPlan(noCargo, carrier).find((s) => s.action === 'billPlan').afterAny, ['coverage.autoLiabLimit', 'progressive.q2150', 'progressive.q216F']);
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

test('a blank DOT/MC section is a valid absence, not a missing-data warning', () => {
  const noDot = normalizeIntake({ ...raw, dot_number: '', mc_number: '', mc_dot_60days: '' });
  assert.equal(noDot.record.applicant.dot, null);
  assert.equal(noDot.record.applicant.mcDotWithin60Days, null);
  assert.equal(noDot.warnings.some((warning) => warning.code === 'dot.missing'), false);
});

test('"NO POP" as the current carrier means not currently insured, without a warning', () => {
  const r = normalizeIntake({ ...raw, ins_type_1: 'Select*', ins_carrier_1: 'NO POP ', ins_limit_1: 'Select*', ins_exp_1: 'n/a' }, { today: new Date('2026-09-30') });
  assert.equal(r.record.priorInsurance.length, 0);
  assert.ok(!r.warnings.some((w) => w.code === 'prior.incomplete'));
});

test('AmWINS pages are recognised as a carrier, not as practice', () => {
  const c = carrierForUrl('https://myagency.amwinsadmittedplacement.com/quote/123/vehicles');
  assert.equal(c.id, 'amwins');
  assert.equal(c.practice, undefined);
  assert.equal(carrierForUrl('https://amwinsadmittedplacement.com.evil.test/'), null);
});

test('an owner whose surname has two words is found in the driver list', () => {
  const people = { ...raw, owner_drives: true, owner_name_1: 'SAMPLE VINICIUS TESTA EXAMPLO',
    drv_first_1: 'SAMPLE VINICIUS', drv_last_1: 'TESTA EXAMPLO', drv_first_2: '', drv_last_2: '', drv_first_3: '', drv_last_3: '', drv_first_4: '', drv_last_4: '' };
  const listed = normalizeIntake(people, { today: new Date('2026-09-30') });
  assert.ok(!listed.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'same person across the name boxes');
  const lastOnly = normalizeIntake({ ...people, owner_name_1: 'SAMPLE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(!lastOnly.warnings.some((w) => w.code === 'drivers.owner-not-listed'), "owner's surname is one of the driver's last-name words");
  const other = normalizeIntake({ ...people, owner_name_1: 'SOMEONE ELSE' }, { today: new Date('2026-09-30') });
  assert.ok(other.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'a different person still warns');
  const sharedWord = normalizeIntake({ ...people, owner_name_1: 'ALICE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(sharedWord.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'a surname word with another first name still warns');
});

// PR #17 review: a mention ("no bobtail") must never become NTL coverage. The agent sets it.
test('NTL / non-trucking / bobtail in the claims box asks the agent; coverage.ntl stays unset', () => {
  const today = { today: new Date('2026-09-30') };
  for (const text of ['No\nNTL', 'No\nNeeds non-trucking liability', 'no claims\nnon tracking', 'No\nBob-tail coverage', 'No\nnontrucking only', 'No\nno bobtail', 'No\nDoes not want NTL']) {
    const r = normalizeIntake({ ...raw, claims_details: text }, today);
    assert.equal(r.record.coverage.ntl, null, `${text}: only the agent sets NTL`);
    const w = r.warnings.find((x) => x.code === 'coverage.ntl');
    assert.equal(w?.level, 'check', text);
    assert.equal(w.path, 'coverage.ntl', 'the Check intake card edits the field itself');
    assert.ok(w.msg.includes(text.split('\n').at(-1)), 'the line is quoted for the agent');
  }
  for (const text of ['No\nFinanced', 'No\nUntle Bobcat control', 'Yes\nTruck stopped at the toll']) {
    const r = normalizeIntake({ ...raw, claims_details: text }, today);
    assert.equal(r.record.coverage.ntl, null, text);
    assert.ok(!r.warnings.some((x) => x.code === 'coverage.ntl'), text);
  }
});

// test/fixtures/multi-vehicle-intake.pdf: the FL expediter run with two vans and a semi truck,
// personal details replaced with made-up ones (VINs keep make/model/year, new serials).
test('multi-vehicle intake: unit before the city, three vehicles with their types', async () => {
  const pdf = new Uint8Array(fs.readFileSync(new URL('./fixtures/multi-vehicle-intake.pdf', import.meta.url)));
  const { record: r, warnings: w } = normalizeIntake(await readIntakeFields(pdfjs, pdf), { today: new Date('2026-10-02') });
  assert.deepEqual(r.garaging, { street: '100 SAMPLE WAY', unit: 'APT 101', city: 'ORLANDO', state: 'FL', zip: '32801' });
  assert.deepEqual(r.vehicles.map((v) => [v.type, v.year, v.make, v.value]), [
    ['Van', 2025, 'RAM', 34000], ['Van', 2019, 'MERCEDES-BENZ', 15000], ['Semi Truck', 2016, 'FREIGHTLINER', 20000],
  ]);
  assert.equal(r.vehicles[1].vin, 'WD4PF1CD8KT100002', 'leading space and lowercase cleaned up');
  assert.equal(r.operations.businessClass, 'Expediter');
  assert.ok(!w.some((x) => x.path?.startsWith('vehicles')), 'no vehicle warnings');
});
