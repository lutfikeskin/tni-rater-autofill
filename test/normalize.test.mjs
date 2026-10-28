import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseAddress, parseLicense, toMoney, toDate, vinProblem, parseLimitDeductible, parseRadius, isLongHaul, ownershipFromNotes, rederive, ntlWithCargo, ntlNoDotFilings, ntlWithPrimary, ntlUndecided, ntlDotFilingsHold, NTL_PRIMARY_MESSAGE } from '../src/normalize.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { noPriorInsurance } from '../src/util.js';
import { progressive, owner } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

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

test('a semi trailer with no tractor or pickup on the intake is flagged (TN 2026-10-08)', () => {
  const withTrailer = (types, trailer) => normalizeIntake({ ...raw, veh_type_1: types[0], veh_type_2: types[1], trl_type_1: trailer, trl_year_1: '2018', trl_make_1: 'Wabash', trl_vin_1: '1JJV532D8JL000000' }, { today: new Date('2026-09-30') }).warnings;
  const noTractor = withTrailer(['Van', 'Box Truck'], 'Dry Van').find((w) => w.code === 'vehicle-type.no-tractor');
  assert.equal(noTractor?.level, 'check');
  assert.match(noTractor.msg, /Dry Van trailer.*Van, Box Truck/);
  assert.ok(!withTrailer(['Van', 'Semi Truck'], 'Dry Van').some((w) => w.code === 'vehicle-type.no-tractor'), 'a tractor pulls it');
  assert.ok(!withTrailer(['Pickup Truck', 'Van'], 'Flatbed').some((w) => w.code === 'vehicle-type.no-tractor'), 'a pickup pulls a hotshot flatbed');
  assert.ok(!withTrailer(['Van', 'Box Truck'], 'Enclosed').some((w) => w.code === 'vehicle-type.no-tractor'), 'an enclosed trailer can follow a van');
  assert.ok(!warnings.some((w) => w.code === 'vehicle-type.no-tractor'), 'no trailer, no warning');
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

// Audit 2026-10-08: "48 states" was read as 48 miles and "100-500 miles" as 100, with no warning.
// Phrases come first; a range or another unit is the agent's; a bare "48" is still 48 miles.
test('radius: long-haul phrases, miles, ranges and other units, with what each carrier plans', () => {
  const today = { today: new Date('2026-09-30') };
  const cases = [
    // [as written, radiusMiles, warning codes on the radius fields, Progressive 2B9D, AmWINS radius]
    ['48 states', null, [], 501, 501],
    ['lower 48', null, [], 501, 501],
    ['Unlimited', null, [], 501, 501],
    ['Long haul', null, [], 501, 501],
    ['nationwide', null, [], 501, 501],
    // Codex review on f49a270: a mileage beside a long-haul word is the answer; the 48 of "48 states" is not miles.
    ['anywhere within 100 miles', 100, [], 100, 100],
    ['OTR up to 500 miles', 500, [], 500, 500],
    ['48', 48, [], 48, 48],
    ['48 miles', 48, [], 48, 48],
    ['250', 250, [], 250, 250],
    ['1,500 miles', 1500, [], 1500, 1500],
    ['500+', 500, [], 500, 500],
    ['100-500 miles', null, ['radius.range'], null, null],
    ['100 to 500', null, ['radius.range'], null, null],
    ['100–500', null, ['radius.range'], null, null],
    ['100 miles to 500 miles', null, ['radius.range'], null, null],
    ['100 miles - 500 miles', null, ['radius.range'], null, null],
    ['100mi-500mi', null, ['radius.range'], null, null],
    ['250 km', null, ['radius.unit'], null, null],
    ['11 states', null, ['radius.not-miles'], null, null],
    ['0', null, ['radius.not-miles'], null, null],
    ['around town', null, ['radius.not-miles'], null, null],
    ['', null, ['radius.missing'], null, null],
  ];
  for (const [written, miles, codes, progressiveMiles, amwinsMiles] of cases) {
    const { record: r, warnings: w } = normalizeIntake({ ...raw, avg_radius: written }, today);
    assert.equal(r.operations.radius, written || null, `${written}: kept as written`);
    assert.equal(r.operations.radiusMiles, miles, `${written}: miles`);
    assert.deepEqual(w.filter((x) => x.path.startsWith('operations.radius')).map((x) => x.code), codes, `${written}: warnings`);
    assert.equal(buildPlan(r, progressive).find((s) => s.q === '2B9D').value, progressiveMiles, `${written}: Progressive farthest one-way distance`);
    assert.equal(buildPlan(r, amwins).find((s) => s.name === 'Radius').value, amwinsMiles, `${written}: AmWINS radius`);
  }
  const range = normalizeIntake({ ...raw, avg_radius: '100-500 miles' }, today).warnings.find((w) => w.code === 'radius.range');
  assert.equal(range.level, 'check');
  assert.equal(range.path, 'operations.radiusMiles', 'the check card edits the miles');
  assert.match(range.msg, /"100-500 miles", a range/);
  const disclosure = (written) => buildPlan(normalizeIntake({ ...raw, avg_radius: written }, today).record, amwins).find((s) => s.re === '^disclosure details$').value;
  assert.match(disclosure('48 states'), /More than 500 miles radius/, 'AmWINS disclosure line for the lower 48');
  assert.match(disclosure('48'), /^48 miles radius/m);
});

test('radius: long-haul words do not hide invalid distances or unsupported units', () => {
  const cases = [
    ['OTR 100-500 miles', 'range'],
    ['lower 48, 100-500 miles', 'range'],
    ['48 states 250 km', 'unit'],
    ['long haul 250 km', 'unit'],
    ['nationwide 100 miles / 500 miles', 'text'],
    ['OTR 0 miles', 'text'],
    ['100 feet', 'unit'],
    ['100 furlongs', 'unit'],
    ['100 leagues', 'unit'],
    ['100 parsecs', 'unit'],
    ['100-furlongs radius', 'unit'],
    ['100 nautical miles', 'unit'],
    ['100 meters', 'unit'],
    ['100-ft radius', 'unit'],
    ['long haul 100 yards', 'unit'],
  ];
  for (const [written, kind] of cases) {
    assert.deepEqual(parseRadius(written), { miles: null, kind }, written);
    assert.equal(isLongHaul(written), false, `${written}: no widest-band fallback`);
    const { record: r, warnings } = normalizeIntake({ ...raw, avg_radius: written });
    assert.equal(r.operations.radius, written, `${written}: original retained`);
    assert.equal(r.operations.radiusMiles, null, `${written}: no invented miles`);
    assert.ok(warnings.some((w) => w.code === `radius.${kind === 'text' ? 'not-miles' : kind}`), written);
    assert.equal(buildPlan(r, progressive).find((s) => s.q === '2B9D').value, null, `${written}: Progressive`);
    assert.equal(buildPlan(r, amwins).find((s) => s.name === 'Radius').value, null, `${written}: AmWINS`);
    assert.doesNotMatch(buildPlan(r, amwins).find((s) => s.re === '^disclosure details$').value, /miles radius/, `${written}: disclosure`);
  }
  for (const written of ['100 miles', '100 mi.', '100-mile radius', '100 miles radius of operation', '100 radius of operation', 'OTR up to 100 miles', 'lower 48, 100 miles', '48 states up to 100 miles']) {
    assert.deepEqual(parseRadius(written), { miles: 100, kind: 'miles' }, written);
  }
});

test('radius: in-state and interstate mileage never means the lower 48', () => {
  for (const written of ['48 in-state miles', '48 in state miles', '48 interstate miles']) {
    assert.deepEqual(parseRadius(written), { miles: 48, kind: 'miles' }, written);
    assert.equal(isLongHaul(written), false, written);
    const { record: r, warnings } = normalizeIntake({ ...raw, avg_radius: written });
    assert.equal(r.operations.radius, written);
    assert.equal(r.operations.radiusMiles, 48);
    assert.ok(!warnings.some(w => w.code.startsWith('radius.')));
    assert.equal(buildPlan(r, progressive).find(s => s.q === '2B9D').value, 48);
    const plan = buildPlan(r, amwins);
    assert.equal(plan.find(s => s.name === 'Radius').value, 48);
    assert.match(plan.find(s => s.re === '^disclosure details$').value, /^48 miles radius/m);
  }
  for (const written of ['48 states', '48 contiguous states', '48 continental states', '48 US states', '48 U.S. states', '48-states', 'lower 48']) {
    assert.deepEqual(parseRadius(written), { miles: null, kind: 'long-haul' }, written);
  }
});

test('radius: in after an explicit mile unit is prose, while standalone inches need conversion', () => {
  for (const written of ['100 miles in state', '100 miles in CA', '100 mi. in California', '100 miles in-state']) {
    assert.deepEqual(parseRadius(written), { miles: 100, kind: 'miles' }, written);
    const { record: r, warnings } = normalizeIntake({ ...raw, avg_radius: written });
    assert.equal(r.operations.radius, written);
    assert.ok(!warnings.some(w => w.code.startsWith('radius.')));
    assert.equal(buildPlan(r, progressive).find(s => s.q === '2B9D').value, 100);
    assert.equal(buildPlan(r, amwins).find(s => s.name === 'Radius').value, 100);
  }
  for (const written of ['100 in', '100in', '100 inches', '100 miles km', '100 in-state km']) {
    assert.deepEqual(parseRadius(written), { miles: null, kind: 'unit' }, written);
  }
  assert.deepEqual(parseRadius('100 miles in CA / 200 miles in NV'), { miles: null, kind: 'text' });
});

test('parseRadius and isLongHaul', () => {
  assert.deepEqual(parseRadius('between 100 and 500'), { miles: null, kind: 'range' });
  assert.deepEqual(parseRadius('50-mile radius'), { miles: 50, kind: 'miles' });
  assert.deepEqual(parseRadius('250 kilometers'), { miles: null, kind: 'unit' });
  assert.deepEqual(parseRadius('5 hours'), { miles: null, kind: 'text' });
  assert.deepEqual(parseRadius('100 miles / 500 miles'), { miles: null, kind: 'text' }, 'a second number is never dropped');
  assert.deepEqual(parseRadius('50 mi.'), { miles: 50, kind: 'miles' });
  assert.deepEqual(parseRadius('100 min'), { miles: null, kind: 'text' }, '"mi" only as a whole word');
  assert.deepEqual(parseRadius('N/A'), { miles: null, kind: 'missing' });
  for (const text of ['OTR', 'over the road', 'nationwide', 'National', 'anywhere', 'all 48', 'long-haul', 'longhaul', '48 contiguous states', '48 US states', 'contiguous 48', '48 state']) assert.ok(isLongHaul(text), text);
  assert.deepEqual(parseRadius('48 contiguous states'), { miles: null, kind: 'long-haul' }, 'never 48 miles');
  for (const text of ['48', '48 miles', 'company', 'longer trips', '', null, 'Regional']) assert.ok(!isLongHaul(text), String(text));
});

// Audit 2026-10-08: the first ownership word in the notes became the answer ("not leased; owned
// outright" → Leased). Only an unambiguous single mention is taken; the rest is quoted for the agent.
test('ownership from the claims notes: one plain word is the answer, anything else is the agent\'s', () => {
  const today = { today: new Date('2026-09-30') };
  const loanLease = (r) => buildPlan(r, progressive).find((s) => s.q === '2CA7').value;
  const codes = (w) => w.filter((x) => x.path === 'operations.vehicleOwnership').map((x) => x.code);
  const read = (notes, box = '') => normalizeIntake({ ...raw, veh_ownership: box, claims_details: `No\n${notes}` }, today);
  const financed = read('Financed');
  assert.equal(financed.record.operations.vehicleOwnership, 'Financed');
  assert.deepEqual(codes(financed.warnings), []);
  assert.equal(loanLease(financed.record), 'Yes - Loan');
  const leased = read('Leased');
  assert.equal(leased.record.operations.vehicleOwnership, 'Leased');
  assert.equal(loanLease(leased.record), 'Yes - Lease');
  const owned = read('owned');
  assert.equal(owned.record.operations.vehicleOwnership, 'Owned');
  assert.deepEqual(codes(owned.warnings), []);
  assert.equal(loanLease(owned.record), 'No');
  for (const notes of ['Not leased; owned outright', 'Vehicle is not leased; owned outright.', 'Trailer leased. Truck owned.', 'Leased trailer', 'Has a dry van trailer and a truck. Financed.', 'on a lease, truck owned']) {
    const { record: r, warnings: w } = read(notes);
    assert.equal(r.operations.vehicleOwnership, null, `${notes}: not read as an answer`);
    assert.deepEqual(codes(w), ['ownership.notes'], `${notes}: one warning, in place of ownership.missing`);
    const warning = w.find((x) => x.code === 'ownership.notes');
    assert.equal(warning.level, 'check');
    assert.ok(warning.msg.includes(notes.split('\n')[0]), `${notes}: the line is quoted`);
    assert.notEqual(loanLease(r), 'Yes - Lease', `${notes}: Progressive never plans a lease from it`);
  }
  const none = read('New venture');
  assert.equal(none.record.operations.vehicleOwnership, null);
  assert.deepEqual(codes(none.warnings), ['ownership.missing'], 'no ownership word: the plain missing check');
  const box = read('Leased', 'Owned');
  assert.equal(box.record.operations.vehicleOwnership, 'Owned', 'the ownership box wins over the notes');
  assert.deepEqual(codes(box.warnings), []);
  assert.deepEqual(ownershipFromNotes('No claims in 3 years\nTruck financed'), { value: 'Financed', lines: 'Truck financed' }, 'a negation on another line is not the mention\'s');
  assert.deepEqual(ownershipFromNotes('Truck owned, trailer too'), { value: null, lines: 'Truck owned, trailer too' }, 'a trailer in the same sentence: the agent reads it');
  assert.deepEqual(ownershipFromNotes('Trailer leased.\nTruck owned.'), { value: null, lines: 'Trailer leased. / Truck owned.' }, 'every line with a mention is quoted');
  assert.equal(ownershipFromNotes(null), null);
});

test('split trailer ownership notes never become vehicle ownership on either carrier', () => {
  const read = (notes, ownership = '') => normalizeIntake({ ...raw, veh_ownership: ownership, claims_details: `No\n${notes}` });
  const targets = (r) => {
    const p = buildPlan(r, progressive);
    const a = buildPlan(r, amwins);
    return [p.find((s) => s.q === '2CA7').value, ...a.filter((s) => /^Vehicles (leased|not owned)|^Additional interest/.test(s.name ?? '')).map((s) => s.value)];
  };
  const missingTargets = targets(read('New venture').record);
  for (const notes of ['Trailer.\nFinanced.', 'Trailer:\nLeased.', 'Trailer. Financed.', 'Financed.\nTrailer.', 'Dry van trailer\nOwned', 'Trailer.\nTruck.\nFinanced.', 'Trailer present.\nTruck financed.']) {
    const { record: r, warnings } = read(notes);
    assert.equal(r.operations.vehicleOwnership, null, notes);
    assert.equal(r.claims.notes, notes, 'the agent keeps the complete subject and ownership text');
    const check = warnings.find((w) => w.code === 'ownership.notes');
    assert.equal(check?.path, 'operations.vehicleOwnership');
    assert.equal(check?.level, 'check');
    assert.match(check?.msg ?? '', /don't settle it for the vehicles/);
    assert.deepEqual(targets(r), missingTargets, `${notes}: neither carrier receives an inferred vehicle fact`);
  }
  for (const notes of ['Financed', 'Truck financed.', 'Truck.\nFinanced.', 'No claims in 3 years\nVehicle financed.']) {
    const { record: r, warnings } = read(notes);
    assert.equal(r.operations.vehicleOwnership, 'Financed', `${notes}: safe existing inference preserved`);
    assert.equal(buildPlan(r, progressive).find((s) => s.q === '2CA7').value, 'Yes - Loan');
    assert.ok(!warnings.some((w) => w.code === 'ownership.notes'));
  }
  const answered = read('Trailer.\nFinanced.', 'Leased');
  assert.equal(answered.record.operations.vehicleOwnership, 'Leased', 'the explicit vehicle box wins');
  assert.equal(buildPlan(answered.record, progressive).find((s) => s.q === '2CA7').value, 'Yes - Lease');
  assert.ok(!answered.warnings.some((w) => w.code === 'ownership.notes'));
});

// Audit 2026-10-08: a panel edit set one field and left what was derived from it stale.
test('rederive recomputes a derived value from its edited source, never the other way round', () => {
  const today = { today: new Date('2026-09-30') };
  const r = normalizeIntake({ ...raw, avg_radius: '100', year_established: '2020' }, today).record;
  assert.equal(r.operations.radiusMiles, 100);
  assert.equal(r.applicant.yearsInBusiness, 6);
  r.operations.radius = 'Unlimited';
  assert.deepEqual(rederive(r, 'operations.radius', today), ['operations.radiusMiles']);
  assert.equal(r.operations.radiusMiles, null, 'long haul: no mileage, the carriers pick their widest band');
  assert.equal(buildPlan(r, progressive).find((s) => s.q === '2B9D').value, 501);
  r.operations.radius = '100-500 miles';
  rederive(r, 'operations.radius', today);
  assert.equal(r.operations.radiusMiles, null, 'a range stays the agent\'s');
  r.operations.radius = '250 miles';
  rederive(r, 'operations.radius', today);
  assert.equal(r.operations.radiusMiles, 250);
  r.operations.radiusMiles = 77;
  assert.deepEqual(rederive(r, 'operations.radiusMiles', today), [], 'the agent\'s own miles are kept');
  assert.equal(r.operations.radiusMiles, 77);
  r.applicant.yearEstablished = 2025;
  assert.deepEqual(rederive(r, 'applicant.yearEstablished', today), ['applicant.yearsInBusiness']);
  assert.equal(r.applicant.yearsInBusiness, 1);
  assert.equal(buildPlan(r, amwins).find((s) => s.selector === '#yrsInBusiness').value, '1', 'AmWINS years in business follows');
  r.applicant.yearEstablished = 'soon';
  rederive(r, 'applicant.yearEstablished', today);
  assert.equal(r.applicant.yearsInBusiness, null, 'not a year: no years in business');
  assert.deepEqual(rederive(r, 'applicant.name', today), [], 'nothing derives from the name');
  r.operations.radius = '300 miles';
  assert.deepEqual(rederive(r, 'operations.radius', { ...today, keep: new Set(['operations.radiusMiles']) }), [], 'miles the agent set are kept');
  assert.equal(r.operations.radiusMiles, 77);
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
  // A comma, period or country after the ZIP (2026-10-08: "… #235 <city>, MN <zip>," wasn't split
  // at all, and the agent retyped it).
  const split = (a) => (({ street, unit, city, state, zip }) => ({ street, unit, city, state, zip }))(parseAddress(a));
  for (const a of ['12345 67th Ave N #123 Springfield, MN 55000,', '12345 67th Ave N #123 Springfield, MN 55000.', '12345 67th Ave N #123 Springfield, MN 55000, USA', '12345 67th Ave N #123 Springfield MN 55000 , United States']) {
    assert.deepEqual(split(a), { street: '12345 67th Ave N', unit: '#123', city: 'Springfield', state: 'MN', zip: '55000' }, a);
  }
  assert.equal(parseAddress('100 Main St, Rock Hill, SC 29730-1234,').zip, '29730-1234');
  assert.equal(parseAddress('100 Sample Way, #12 Rock Hill, SC 29730').unit, '#12');
  assert.equal(parseAddress('100 Sample Way, #12 Rock Hill, SC 29730').city, 'Rock Hill');
  // A city that starts like a unit word stays whole.
  assert.equal(parseAddress('100 Main St, Ste Genevieve, MO 63670').city, 'Ste Genevieve');
  assert.equal(parseAddress('100 Main St, Ste Genevieve, MO 63670').unit, null);
  assert.equal(parseAddress('100 Main St Apt 4, Dover, DE 19901').unit, 'Apt 4');
  assert.equal(parseAddress('100 Main St Apt 4, Dover, DE 19901').city, 'Dover');
  // Trailing junk after the ZIP (county, leftover) is ignored; a directional stuck to the city
  // stays there for the agent to confirm (TNI, 2026-10-27: "… DR SWCARTERSVILLE, GA 30120-5877BARTOW").
  assert.deepEqual(split('107 BURNT HICKORY DR SWCARTERSVILLE, GA 30120-5877BARTOW'),
    { street: '107 BURNT HICKORY DR', unit: null, city: 'SWCARTERSVILLE', state: 'GA', zip: '30120-5877' });
  assert.equal(parseAddress('107 BURNT HICKORY DR SWCARTERSVILLE, GA 30120-5877BARTOW').confident, false);
  assert.deepEqual(split('100 Main St, Rock Hill, SC 29730 BARTOW'),
    { street: '100 Main St', unit: null, city: 'Rock Hill', state: 'SC', zip: '29730' });
  // All-caps cities that start like a direction stay whole, with or without commas.
  for (const city of ['NEWARK', 'SEATTLE', 'SALEM', 'EASTON', 'WESTMINSTER', 'NEW BERN']) {
    assert.equal(parseAddress(`1 MAIN ST ${city} NJ 07102`).city, city, city);
    assert.equal(parseAddress(`1 MAIN ST, ${city}, NJ 07102`).city, city, `${city} with commas`);
    assert.equal(parseAddress(`1 MAIN ST, ${city}, NJ 07102`).street, '1 MAIN ST', `${city} street`);
  }
  // Clean addresses and city names that only look like a direction stay as they were.
  assert.deepEqual(split('100 Main St, Rock Hill, SC 29730'),
    { street: '100 Main St', unit: null, city: 'Rock Hill', state: 'SC', zip: '29730' });
  assert.equal(parseAddress('100 Main St, Westminster, MD 21157').city, 'Westminster');
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
  assert.equal(byQ('1B7F').value, 'Jordan', 'NoHit: the first word only (TNI 2026-10-26, W44-30)');
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
  assert.equal(loan(null), null, 'no ownership on the intake: the agent\'s (2026-10-09)');
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
  // Without a limit too (TNI, 2026-10-26: answer to PR question 9: any box filled is proof of prior).
  const noLimit = structuredClone(commercial);
  noLimit.priorInsurance[0].limit = null;
  assert.equal(buildPlan(noLimit, carrier).find((s) => s.q === '198').value, true);
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
  // TNI 2026-10-10: continuous coverage Yes with current insurance; other business coverages None
  // unless the intake has general liability (then the agent's).
  assert.equal(byQ('83').value, true, 'current Progressive policy to 10/31/2026');
  assert.equal(byQ('A2').value, 'None', 'no general liability on the intake');
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
  noDot.applicant.mcDotWithin60Days = false;
  assert.equal(byQ('1ED', noDot).value, 'No - and the customer will not have a USDOT number');
  assert.equal(byQ('20F', noDot).ignore, true);
  assert.equal(byQ('20F').value, true, 'TNI\'s standard Yes once the lookup found the number (2026-10-20)');
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
  assert.deepEqual(actions.map((a) => a.action), ['verifyDot', 'verifyAddress', 'addVehicle:0', 'addDriver:0', 'businessTypeSearch', 'vehicleTile:0', 'lookupVin:0', 'ntlStillAdded', 'openCargo', 'addCargoCommodity', 'doneCargo', 'recalculate', 'billPlan', 'recalculateAgain', 'print']);
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

test('"NO POP" as the current carrier means not currently insured, without a warning, and stays on the panel', () => {
  const r = normalizeIntake({ ...raw, ins_type_1: 'Select*', ins_carrier_1: 'NO POP ', ins_limit_1: 'Select*', ins_exp_1: 'n/a' }, { today: new Date('2026-09-30') });
  assert.equal(r.record.priorInsurance.length, 1);
  assert.equal(r.record.priorInsurance[0].carrier, 'NO POP');
  assert.ok(noPriorInsurance(r.record.priorInsurance[0]));
  assert.ok(!r.warnings.some((w) => w.code === 'prior.incomplete'));
});

// WA run 2026-10-09: "Personal Auto", "no POP", "State Minimum", no expiration. TNI: no prior.
test('"no POP" or "No" as the carrier without an expiration date is no prior, whatever the type and limit', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  for (const carrier of ['no POP', 'No', 'NONE']) {
    const r = normalizeIntake({ ...raw, ins_type_1: 'Personal Auto', ins_carrier_1: ` ${carrier} `, ins_limit_1: 'State Minimum', ins_exp_1: '' }, { today: new Date('2026-10-09') });
    assert.deepEqual(r.record.priorInsurance, [{ type: 'Personal Auto', carrier, limit: 'State Minimum', expiration: null }], `${carrier}: shown as written`);
    assert.ok(noPriorInsurance(r.record.priorInsurance[0]), carrier);
    assert.ok(r.warnings.some((w) => w.code === 'prior.none'), carrier);
    assert.ok(!r.warnings.some((w) => /^prior\.(incomplete|personal-auto)$/.test(w.code)), carrier);
    const disclosure = buildPlan(r.record, amwins, {}).find((s) => /^Disclosure details/.test(s.name ?? ''));
    assert.doesNotMatch(disclosure.value ?? '', /POP|prior/i, `${carrier}: nothing about prior insurance in the disclosure`);
    const steps = buildPlan(r.record, progressive, {});
    assert.equal(steps.find((s) => s.name === 'Currently insured')?.value, false, `${carrier}: not currently insured`);
    for (const path of ['priorInsurance[0].limit', 'priorInsurance[0].expiration']) {
      assert.ok(steps.filter((s) => s.path === path).every((s) => s.ignore), `${carrier}: ${path} not filled`);
    }
    const generic = buildPlan(r.record, { name: 'generic', fields: [] }, {}).filter((s) => s.path?.startsWith('priorInsurance'));
    assert.ok(generic.length && generic.every((s) => !s.ignore && s.value == null && /no prior insurance/.test(s.note ?? '')), `${carrier}: generic prior questions left to the agent, not filled or skipped`);
  }
  // An expiration date means a policy: kept, as is a named carrier without one.
  const dated = normalizeIntake({ ...raw, ins_type_1: 'Personal Auto', ins_carrier_1: 'no POP', ins_limit_1: 'State Minimum', ins_exp_1: '12/01/2026' }, { today: new Date('2026-10-09') });
  assert.equal(dated.record.priorInsurance.length, 1);
  assert.ok(!noPriorInsurance(dated.record.priorInsurance[0]));
  const named = normalizeIntake({ ...raw, ins_type_1: 'Personal Auto', ins_carrier_1: 'Nationwide', ins_limit_1: 'State Minimum', ins_exp_1: '' }, { today: new Date('2026-10-09') });
  assert.equal(named.record.priorInsurance[0].carrier, 'Nationwide');
});

// TNI, 2026-10-26 (answers to PR #189's questions 9 and 18): the intake check screen, shown when the
// intake loads and before any carrier page, says in red when the current insurance is a commercial
// auto policy with a carrier the panel quotes (GEICO, Progressive: util.js sameCarrier), so the agent
// doesn't fill that carrier's pages for nothing. The intake isn't tied to one carrier: it names it.
test('the intake check says when the current commercial auto policy is with GEICO or Progressive', () => {
  const read = (type, carrier, exp = '12/31/2026') => normalizeIntake({ ...raw, ins_type_1: type, ins_carrier_1: carrier, ins_limit_1: '$1M CSL', ins_exp_1: exp }, { today: new Date('2026-10-26') })
    .warnings.filter((w) => w.code === 'prior.carrier-is-quoted');
  for (const [carrier, name] of [['GEICO', 'GEICO'], ['Gieco', 'GEICO'], ['Progresive', 'Progressive'], ['Progressive Commercial', 'Progressive']]) {
    const said = read('Commercial Auto', carrier);
    assert.equal(said.length, 1, carrier);
    assert.deepEqual([said[0].level, said[0].path, said[0].alert], ['check', 'priorInsurance[0].carrier', true], carrier);
    assert.match(said[0].msg, new RegExp(`^Current insurance is with ${name}: a ${name} quote may be declined or routed\\.`), carrier);
    if (carrier !== name) assert.doesNotMatch(said[0].msg, new RegExp(carrier), 'named as the carrier, not as the intake spells it');
  }
  // Undated, a policy of no type (only a warning), and expired (as the carrier page's card): said too.
  // Expired and of no type with Progressive too, whose own question is then No (T10).
  for (const [type, carrier, exp] of [['Commercial Auto', 'GEICO', ''], ['Select*', 'GEICO', '12/31/2026'], ['Commercial Auto', 'Progressive', '01/31/2026'],
    ['Select*', 'Progressive', '01/31/2026']]) {
    assert.equal(read(type, carrier, exp).length, 1, `${type} ${carrier} ${exp}`);
  }
  // Not: a personal auto, GL, cargo or other policy with it, another insurer, no prior insurance.
  for (const type of ['Personal Auto', 'General Liability', 'Cargo', 'Other']) assert.deepEqual(read(type, 'GEICO'), [], type);
  for (const carrier of ['Gainsco', 'Protective', 'Other Mutual']) assert.deepEqual(read('Commercial Auto', carrier), [], carrier);
  assert.deepEqual(read('Commercial Auto', 'No GEICO', ''), [], 'no prior insurance');
  // The sample intake's Progressive personal auto policy: nothing.
  assert.ok(!warnings.some((w) => w.code === 'prior.carrier-is-quoted'));
});

test('blank years in business and year established: a warning, and the record stays blank', () => {
  const r = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'N/A' }, { today: new Date('2026-10-09') });
  assert.equal(r.record.applicant.yearsInBusiness, null);
  assert.equal(r.record.applicant.yearEstablished, null);
  const w = r.warnings.find((x) => x.code === 'years-in-business.default');
  assert.equal(w?.level, 'check');
  assert.match(w.msg, /0 years \(New Venture\), established 2026/);
  for (const answered of [{ year_established: '2021' }, { years_experience: '4' }]) {
    assert.ok(!normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'N/A', ...answered }, { today: new Date('2026-10-09') })
      .warnings.some((x) => x.code === 'years-in-business.default'), JSON.stringify(answered));
  }
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
  // The first driver is the owner (TNI, 2026-10-27: answer to PR question V4): a first row under
  // another name is still the owner, with the check `drivers.owner-name-differs` (before V4: the
  // owner wasn't in the driver list, `drivers.owner-not-listed`, which now needs no driver rows).
  const differs = (r) => r.warnings.some((w) => w.code === 'drivers.owner-name-differs');
  const notListed = (r) => r.warnings.some((w) => w.code === 'drivers.owner-not-listed');
  const listed = normalizeIntake(people, { today: new Date('2026-09-30') });
  assert.ok(!differs(listed) && !notListed(listed), 'same person across the name boxes');
  const lastOnly = normalizeIntake({ ...people, owner_name_1: 'SAMPLE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(!differs(lastOnly), "owner's surname is one of the driver's last-name words");
  const other = normalizeIntake({ ...people, owner_name_1: 'SOMEONE ELSE' }, { today: new Date('2026-09-30') });
  assert.ok(differs(other) && !notListed(other), 'a different name still warns');
  const sharedWord = normalizeIntake({ ...people, owner_name_1: 'ALICE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(differs(sharedWord), 'a surname word with another first name still warns');
  // Audit 2026-10-08: a one-word surname alone linked another person ("Alice Sample" to "Bob Sample").
  const family = normalizeIntake({ ...people, owner_name_1: 'ALICE EXAMPLO', drv_first_1: 'BOB', drv_last_1: 'EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(differs(family), 'the same one-word surname with another first name is another name');
  const same = normalizeIntake({ ...people, owner_name_1: 'BOB EXAMPLO', drv_first_1: 'BOB', drv_last_1: 'EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(!differs(same));
});

// TNI, 2026-10-26 (W44-25): a blank "owner drives" box is TNI's Yes on the carriers, so an owner
// missing from the driver list is listed as a driver without their details, as with the intake's
// Yes. The record keeps the box as read. Since the owner is always the first driver (TNI, 2026-10-27:
// answer to PR question V4), the owner is missing only from an intake with no driver rows; a first
// row under another name is the owner, with its own check (the V4 test below).
test('a blank "owner drives" box: the record stays blank, and an owner missing from the driver list is a check', () => {
  const noDrivers = Object.fromEntries(Object.keys(raw).filter((k) => /^drv_/.test(k)).map((k) => [k, '']));
  const people = { ...raw, ...noDrivers, owner_name_1: 'SOMEONE ELSE' };
  const read = (extra) => normalizeIntake({ ...people, ...extra }, { today: new Date('2026-09-30') });
  const notListed = (r) => r.warnings.find((w) => w.code === 'drivers.owner-not-listed');
  const blank = read({ owner_drives: '' });
  assert.equal(blank.record.applicant.ownerDrives, null, 'blank stays blank on the record');
  assert.deepEqual([notListed(blank)?.level, notListed(blank)?.path], ['check', 'drivers']);
  assert.match(notListed(blank).msg, /"Owner drives" is blank.*TNI's standard Yes.*"SOMEONE ELSE" isn't in the driver list/);
  assert.match(notListed(read({ owner_drives: true })).msg, /^Owner drives, but "SOMEONE ELSE" isn't in the driver list\.$/);
  assert.equal(notListed(read({ owner_drives: false })), undefined, 'the intake\'s No: no driver details needed');
  assert.equal(notListed(read({ owner_drives: '', drv_first_1: 'SAMPLE', drv_last_1: 'EXAMPLO' })), undefined, 'a driver row: the owner\'s, the first');
});

// AR 2026-10-19 (live run): a driver's first-name box read "<first>, JR". Progressive's name box
// takes letters, digits, spaces, hyphens and apostrophes only, so it refused the comma and the
// agent retyped it twice. Another driver's "<first> L" went in whole, the initial in the first name.
test('a suffix or a middle initial written in a name box is kept apart from the name', () => {
  const today = { today: new Date('2026-09-30') };
  const one = (first, last = 'EXAMPLO', extra = {}) => normalizeIntake({ ...raw, drv_first_1: first, drv_last_1: last, ...extra }, today);
  const parts = (r) => { const d = r.record.drivers[0]; return [d.first, d.middle, d.last, d.suffix]; };
  const codes = (r) => r.warnings.filter((w) => w.path?.startsWith('drivers[0].')).map((w) => w.code);
  const jr = one('SAMPLE, JR');
  assert.deepEqual(parts(jr), ['SAMPLE', null, 'EXAMPLO', 'JR']);
  assert.ok(codes(jr).includes('name.suffix') && !codes(jr).includes('name.multi-word-first'), codes(jr).join(' '));
  assert.equal(jr.warnings.find((w) => w.code === 'name.suffix').level, 'info');
  assert.match(jr.warnings.find((w) => w.code === 'name.suffix').msg, /"SAMPLE, JR" read as first name SAMPLE and suffix JR/);
  const initial = one('JORDAN L');
  assert.deepEqual(parts(initial), ['JORDAN', 'L', 'EXAMPLO', null]);
  assert.ok(codes(initial).includes('name.middle-initial') && !codes(initial).includes('name.multi-word-first'));
  assert.deepEqual(parts(one('Jordan L.')), ['Jordan', 'L', 'EXAMPLO', null]);
  assert.deepEqual(parts(one('JORDAN A JR.')), ['JORDAN', 'A', 'EXAMPLO', 'JR']);
  const last = one('JORDAN', 'EXAMPLO III');
  assert.deepEqual(parts(last), ['JORDAN', null, 'EXAMPLO', 'III']);
  assert.match(last.warnings.find((w) => w.code === 'name.suffix').msg, /last-name box "EXAMPLO III" read as last name EXAMPLO/);
  // Not a suffix or an initial: left as written, and two words still ask the agent.
  for (const first of ['A J', 'JUAN CARLOS', 'JR', 'JUNIOR']) {
    const r = one(first);
    assert.deepEqual(parts(r), [first, null, 'EXAMPLO', null], first);
    assert.equal(codes(r).includes('name.multi-word-first'), /\s/.test(first), first);
  }
  // The owner box with the suffix is still this driver (the owner's date of birth is linked).
  const owned = one('SAMPLE, JR', 'EXAMPLO', { owner_drives: true, owner_name_1: 'SAMPLE EXAMPLO JR' });
  assert.ok(!owned.warnings.some((w) => w.code === 'drivers.owner-not-listed'));
  assert.equal(owner(owned.record).driver, owned.record.drivers[0]);
  assert.deepEqual([owner(owned.record).first, owner(owned.record).last], ['SAMPLE', 'EXAMPLO']);
  const plain = one('SAMPLE, JR', 'EXAMPLO', { owner_drives: true, owner_name_1: 'SAMPLE EXAMPLO' });
  assert.ok(!plain.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'the owner box without the suffix too');
  // Progressive's driver name box gets the name alone; its middle initial box is left as it is.
  const plan = buildPlan(initial.record, progressive, { drivers: 0 });
  assert.equal(plan.find((s) => s.path === 'drivers[0].first' && s.q === '2898').value, 'JORDAN');
  assert.equal(plan.find((s) => s.q === '2899').ignore, true);
});

// PA 2026-10-20 (live run): driver 1 of 4 had "Excluded" in the license-number box, meaning the
// client wants that driver excluded. It was cleaned into a license number, typed and refused after
// Continue, and Progressive's exclude question was answered No.
test('"Excluded" in a license-number box marks the driver excluded and is left out of the number', () => {
  const today = { today: new Date('2026-09-30') };
  const one = (box) => normalizeIntake({ ...raw, drv_lic_1: box }, today);
  const read = (r) => [r.record.drivers[0].licenseNumber, r.record.drivers[0].excluded];
  const codes = (r) => r.warnings.filter((w) => w.path?.startsWith('drivers[0].')).map((w) => w.code);
  for (const [box, number] of [
    ['Excluded', null], ['EXCLUDED', null], ['exclude', null], ['Excl', null], ['Excl.', null], ['EXC', null],
    ['12345678 EXCLUDED', '12345678'], ['D1234567 excl.', 'D1234567'], ['12345678, Excluded', '12345678'],
    ['12345678 (Excluded)', '12345678'], ['IL - S12345678901 Exc', 'ILS12345678901'],
    // A word before it is no number.
    ['Driver excluded', null],
  ]) {
    const r = one(box);
    assert.deepEqual(read(r), [number, true], box);
    const w = r.warnings.find((x) => x.code === 'license.excluded');
    assert.deepEqual([w?.level, w?.path], ['check', 'drivers[0].excluded'], box);
    assert.ok(w.msg.includes(`license-number box "${box}"`), `${box}: the item quotes the box`);
    // Nothing left is no license number, as for a blank box.
    assert.equal(codes(r).includes('license.missing'), number == null, box);
  }
  // The number before the word is cleaned like any other; the word itself is no cleanup.
  const dashed = one('D1234-567 excl.');
  assert.deepEqual(read(dashed), ['D1234567', true]);
  assert.match(dashed.warnings.find((w) => w.code === 'license.cleaned').msg, /written as "D1234-567", entered as D1234567/);
  assert.ok(!codes(one('12345678 EXCLUDED')).includes('license.cleaned'));
  // Anything else is read as before: a number, another word starting with "exc".
  for (const box of ['12345678', 'D1234567', 'EXCEPT', '12345678 EXCEPT', 'EXCLUSION']) {
    const r = one(box);
    assert.deepEqual(read(r), [parseLicense(box).number, null], box);
    assert.ok(!codes(r).includes('license.excluded'), box);
  }
  assert.ok(record.drivers.every((d) => d.excluded === null), 'the sample intake marks no one');
  // Progressive: the license number box gets the number before the word, or is the agent's; the
  // exclude question is Yes for this driver (TNI 2026-10-20).
  const step = (box, q) => buildPlan(one(box).record, progressive, { drivers: 0 }).find((s) => s.q === q);
  assert.equal(step('12345678 EXCLUDED', '28B9').value, '12345678');
  assert.equal(step('Excluded', '28B9').value, null);
  for (const box of ['Excluded', '12345678 EXCLUDED']) assert.deepEqual([step(box, '28C1').value, step(box, '28C1').manualOnly], [true, false], box);
  assert.equal(step('12345678', '28C1').value, false);
  // AmWINS has no exclude question: "(Excluded)" after the number; no number is the agent's.
  const amwinsLicense = (box) => buildPlan(one(box).record, amwins, {}).find((s) => s.path === 'drivers[0].licenseNumber');
  assert.equal(amwinsLicense('12345678 EXCLUDED').value, '12345678 (Excluded)');
  assert.deepEqual([amwinsLicense('Excluded').value, !!amwinsLicense('Excluded').note], [null, true]);
  assert.equal(amwinsLicense('12345678').value, '12345678');
  // The check item says what each carrier gets.
  const said = (box) => one(box).warnings.find((w) => w.code === 'license.excluded').msg;
  assert.match(said('12345678 EXCLUDED'), /Progressive's exclude question gets Yes; on AmWINS, which has no such question, their license number gets "\(Excluded\)" after it\./);
  assert.match(said('Excluded'), /on AmWINS, which has no such question, type "\(Excluded\)" after the license number you enter\./);
});

// TNI, 2026-10-26 (answer to PR question, R1): "owner drives" says only whether the owner drives;
// if the owner's row is marked Excluded, or the answer is No, the owner is excluded. So the intake's
// No makes the owner's driver row an excluded driver on every carrier, as an "Excluded" mark does,
// while the record keeps the row as read. The owner's row is the first (TNI, 2026-10-27: answer to PR
// question V4, which replaces T2's row by the owner's exact full name and its `drivers.owner-unclear`).
test('"owner drives" No: the owner\'s driver row, the first, is an excluded driver on every carrier; blank, Yes and other drivers unchanged', () => {
  const today = { today: new Date('2026-09-30') };
  // The sample intake's owner is its driver 1 (the same name), driver 2 someone else.
  const read = (extra) => normalizeIntake({ ...raw, ...extra }, today);
  const item = (r, i = 0) => r.warnings.find((w) => w.code === 'drivers.owner-excluded' && w.path === `drivers[${i}].excluded`);
  const exclude = (r, drivers) => buildPlan(r.record, progressive, { drivers }).find((s) => s.q === '28C1').value;
  const amwinsLicense = (r, drivers) => buildPlan(r.record, amwins, { drivers }).find((s) => s.path === `drivers[${drivers}].licenseNumber`);
  const no = read({ owner_drives: 'No' });
  // The record keeps the intake as read: the row isn't marked, the box stays No.
  assert.deepEqual([no.record.applicant.ownerDrives, no.record.drivers[0].excluded, no.record.drivers[1].excluded], [false, null, null]);
  // The Intake step says so, on the owner's row only, and what each carrier gets.
  assert.equal(item(no)?.level, 'check');
  assert.match(item(no).msg, /"Owner drives" is No, and the first driver is the owner.*excluded.*Progressive's exclude question gets Yes; on AmWINS, which has no such question, their license number gets "\(Excluded\)" after it\..*GEICO/);
  // GEICO's quote leaves the owner's row out (TNI, 2026-10-26: answer to PR question, T1).
  assert.match(item(no).msg, /GEICO's quote leaves the owner out: the fill doesn't add this driver/);
  assert.doesNotMatch(item(no).msg, /filled with a warning/);
  assert.equal(item(no, 1), undefined, 'another driver is never affected');
  assert.match(item(no).msg, /To keep this driver on the quote, set Excluded driver to No\.$/);
  // The owner's name on two rows (a Sr and a Jr), in either order: the No decides, and only the first
  // row is excluded (V4; before, T2's row with exactly the owner's full name, and the agent's for a Sr
  // and a Jr neither exactly it).
  for (const extra of [{ drv_first_2: 'Jordan Avery', drv_last_2: 'Sample Jr' }, { drv_last_1: 'Sample Sr', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample Jr' },
    { drv_last_1: 'Sample Jr', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample Sr' }]) {
    const family = read({ owner_drives: 'No', ...extra });
    const why = JSON.stringify(extra);
    assert.ok(item(family, 0), why);
    assert.equal(item(family, 1), undefined, `${why}: the second row isn't the owner`);
    assert.ok(!family.warnings.some((w) => w.code === 'drivers.owner-unclear'), `${why}: no unclear rows any more`);
    assert.deepEqual([exclude(family, 0), exclude(family, 1)], [true, false], why);
    assert.deepEqual([amwinsLicense(family, 0).value, amwinsLicense(family, 1).value], ['ILS12345678901 (Excluded)', 'E98765432101'], why);
  }
  // The owner's date of birth on AmWINS: the owner's row's (T3, asked of GEICO; AmWINS asks it too: V2).
  const ownerDob = (r) => buildPlan(r.record, amwins, {}).find((s) => s.selector === '#ownerDob');
  assert.equal(ownerDob(no).value, no.record.drivers[0].dob);
  const second = read({ owner_drives: 'No', drv_last_1: 'Sample Jr', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample' });
  assert.equal(ownerDob(second).value, second.record.drivers[0].dob, 'the first row\'s, even with the exact name on the second');
  // Progressive: the exclude question Yes for the owner's row, No for the other driver.
  assert.deepEqual([exclude(no, 0), exclude(no, 1)], [true, false]);
  // AmWINS: "(Excluded)" after the owner's license number, the other driver's as written.
  assert.deepEqual([amwinsLicense(no, 0).value, amwinsLicense(no, 0).source], ['ILS12345678901 (Excluded)', 'derived']);
  assert.equal(amwinsLicense(no, 1).value, 'E98765432101');
  // No license number on the owner's row: the box is the agent's, with the reason.
  const noNumber = read({ owner_drives: 'No', drv_lic_1: '' });
  assert.equal(amwinsLicense(noNumber, 0).value, null);
  assert.match(amwinsLicense(noNumber, 0).note, /owner doesn't drive.*type their license number yourself, then "\(Excluded\)" after it/);
  assert.match(item(noNumber).msg, /type "\(Excluded\)" after the license number you enter/);
  // A row the intake marks excluded keeps its own item (license.excluded), not this one.
  const marked = read({ owner_drives: 'No', drv_lic_1: 'IL - S12345678901 EXCLUDED' });
  assert.deepEqual([item(marked), exclude(marked, 0)], [undefined, true]);
  // ... which says GEICO's quote leaves the owner out (T1), also over a blank box or a Yes (TNI,
  // 2026-10-27: answer to PR question V3; before, "filled with a warning"); another driver's mark
  // keeps GEICO's warning.
  const licenseItem = (r, i) => r.warnings.find((w) => w.code === 'license.excluded' && w.path === `drivers[${i}].excluded`).msg;
  for (const box of ['No', '', 'Yes']) {
    const r = read({ owner_drives: box, drv_lic_1: 'IL - S12345678901 EXCLUDED' });
    assert.match(licenseItem(r, 0), /GEICO's quote leaves the owner out: the fill doesn't add this driver/, box);
    assert.doesNotMatch(licenseItem(r, 0), /filled with a warning/, box);
  }
  assert.match(licenseItem(read({ owner_drives: 'No', drv_lic_2: 'E98765432101 EXCLUDED' }), 1), /GEICO asks nothing about it: the driver's answers are filled with a warning/);
  assert.match(licenseItem(read({ owner_drives: '', drv_lic_2: 'E98765432101 EXCLUDED' }), 1), /filled with a warning/);
  // Counterexamples: a blank box or the intake's Yes leaves the owner's unmarked row a listed driver.
  for (const box of ['', 'Yes']) {
    const r = read({ owner_drives: box });
    assert.deepEqual([item(r), exclude(r, 0), exclude(r, 1), amwinsLicense(r, 0).value], [undefined, false, false, 'ILS12345678901'], box);
  }
  // No with an owner no driver row's name matches: the first row is the owner's all the same (V4;
  // before, nobody was excluded), with the name check (the V4 test below).
  const other = read({ owner_drives: 'No', owner_name_1: 'Someone Else' });
  assert.deepEqual([!!item(other), item(other, 1), exclude(other, 0), exclude(other, 1)], [true, undefined, true, false]);
});

// TNI, 2026-10-27 (answer to PR question V4): the owner is always the first driver on the intake's
// list. A first row whose name isn't the owner's is still the owner, with a check saying it was taken
// as the owner; a Sr, a Jr, a middle name, or an owner box holding only the first name is the owner's
// name. The item names no one (the row is its path).
test('the owner is the first driver (V4): a first row with another name is taken as the owner, with a check', () => {
  const today = { today: new Date('2026-09-30') };
  const read = (extra) => normalizeIntake({ ...raw, ...extra }, today);
  const item = (r) => r.warnings.find((w) => w.code === 'drivers.owner-name-differs');
  const excludedItem = (r, i) => r.warnings.find((w) => w.code === 'drivers.owner-excluded' && w.path === `drivers[${i}].excluded`);
  const exclude = (r, drivers) => buildPlan(r.record, progressive, { drivers }).find((s) => s.q === '28C1').value;
  // The sample intake: the owner box's name is driver 1's.
  assert.equal(item(read({})), undefined);
  // A first row with another name: the owner, with the check.
  const other = read({ drv_first_1: 'Riley', drv_last_1: 'Example' });
  assert.deepEqual([item(other)?.level, item(other)?.path], ['check', 'drivers[0]']);
  assert.match(item(other).msg, /first driver's name differs from the owner's.*taken as the owner/);
  assert.doesNotMatch(item(other).msg, /Riley|Example|Jordan|Avery|Sample/, 'no names in the item');
  assert.equal(other.warnings.find((w) => w.code === 'drivers.owner-not-listed'), undefined, 'the owner is on the list: the first row');
  // The owner's name on row 2 only: row 1 is still the owner (the check), row 2 an ordinary driver.
  const second = read({ owner_drives: 'No', drv_first_1: 'Riley', drv_last_1: 'Example', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample' });
  assert.ok(item(second));
  assert.deepEqual([!!excludedItem(second, 0), !!excludedItem(second, 1), exclude(second, 0), exclude(second, 1)], [true, false, true, false]);
  // A Sr and a Jr in either order, two rows with the exact name, a one-word owner box: no check.
  for (const extra of [{ drv_last_1: 'Sample Sr', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample Jr' },
    { drv_last_1: 'Sample Jr', drv_first_2: 'Jordan Avery', drv_last_2: 'Sample Sr' },
    { drv_first_2: 'Jordan Avery', drv_last_2: 'Sample' }, { owner_name_1: 'Jordan' }]) {
    assert.equal(item(read(extra)), undefined, JSON.stringify(extra));
  }
  // Another first name with the owner's surname is another name: the check.
  assert.ok(item(read({ owner_name_1: 'Alice Sample' })));
  // A blank owner box: no name to compare, no check.
  assert.equal(item(read({ owner_name_1: '' })), undefined);
  // No driver rows: no owner row, and no check; the owner missing from the list is the item it was.
  const noRows = read({ ...Object.fromEntries(Object.keys(raw).filter((k) => /^drv_/.test(k)).map((k) => [k, ''])), owner_drives: 'Yes' });
  assert.deepEqual([noRows.record.drivers.length, item(noRows)], [0, undefined]);
  assert.ok(noRows.warnings.some((w) => w.code === 'drivers.owner-not-listed'));
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

// TNI (2026-10-20): a company-name box saying there is no company means a sole proprietor.
test('a company name of NO / N/A / None is no company: a sole proprietor', () => {
  for (const name of ['NO', 'No.', 'N/A', 'NA', 'N.A.', 'n / a', 'None', 'NONE.', 'Not applicable', 'No company']) {
    const { record: r, warnings: w } = normalizeIntake({ ...raw, company_name: name }, { today: new Date('2026-09-30') });
    assert.equal(r.applicant.name, null, name);
    assert.equal(buildPlan(r, progressive, {}).find((s) => s.q === '22D').value, 'Individual / Sole Proprietor', name);
    if (!/^(n\/a|na|none)$/i.test(name)) assert.ok(w.some((x) => x.code === 'company.none'), name);
  }
  for (const name of ['Nova Freight LLC', 'NOA Trucking', 'Nolan Inc']) {
    assert.equal(normalizeIntake({ ...raw, company_name: name }, { today: new Date('2026-09-30') }).record.applicant.name, name);
  }
});

// The maintainer, 2026-10-26: the form's auto liability question has Select / Yes / No /
// Non-Trucking. Non-Trucking is the client's own answer that they want non-trucking liability
// (NTL), so it sets coverage.ntl, as the agent would after reading the notes. Before, only a note
// naming NTL asked the agent, and Progressive filled such a quote as ordinary liability.
test('Non-Trucking picked for auto liability on the form is an NTL request', () => {
  const today = { today: new Date('2026-10-26') };
  const r = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking', claims_details: 'No' }, today);
  assert.equal(r.record.coverage.autoLiability, 'Non-Trucking', 'the answer as written');
  assert.equal(r.record.coverage.ntl, true);
  const w = r.warnings.find((x) => x.code === 'coverage.ntl-form');
  assert.equal(w?.level, 'info');
  assert.equal(w.path, 'coverage.ntl');
  assert.ok(!r.warnings.some((x) => x.code === 'coverage.ntl'), 'decided by the form: no question about the notes');
  // Named in the notes too: still decided, still no question.
  const both = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking', additional_notes: 'Needs non-trucking liability (NTL) only' }, today);
  assert.equal(both.record.coverage.ntl, true);
  assert.ok(!both.warnings.some((x) => x.code === 'coverage.ntl'));
  // Written otherwise on older forms.
  for (const v of ['Non Trucking', 'non-trucking', 'NonTrucking']) assert.equal(normalizeIntake({ ...raw, auto_liability: v }, today).record.coverage.ntl, true, v);
  // Yes, No or blank: unset, as before.
  for (const v of ['Yes', 'No', '']) assert.equal(normalizeIntake({ ...raw, auto_liability: v, claims_details: 'No' }, today).record.coverage.ntl, null, v);
  // Progressive adds NTL on Rates for it, and leaves Rates to the agent.
  const actions = buildPlan(r.record, progressive).filter((s) => s.kind === 'action').map((a) => a.action);
  assert.ok(actions.includes('addNtl'));
});

// The review of PR #176. The NTL items told the agent the rest of Progressive's Rates is theirs,
// which is so only with cargo or GL: an NTL-only quote is done through Print. Non-Trucking with no
// limit is a missing limit, as Yes is. A CDL year with the CDL box blank is a check: TNI's blank-is-No
// standard doesn't apply to it.
test('NTL items say who does Rates; Non-Trucking with no limit and a CDL year without a CDL answer are checks', () => {
  const today = { today: new Date('2026-10-26') };
  const r = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking', claims_details: 'No\nAlso wants NTL' }, today);
  const form = r.warnings.find((x) => x.code === 'coverage.ntl-form').msg;
  const notes = normalizeIntake({ ...raw, auto_liability: 'Yes', claims_details: 'No\nAlso wants NTL' }, today).warnings.find((x) => x.code === 'coverage.ntl').msg;
  for (const msg of [form, notes]) {
    assert.doesNotMatch(msg, /; the rest of Rates is yours\./, msg);
    assert.match(msg, /with cargo or general liability too, the rest of Rates is yours/i, msg);
  }
  const noLimit = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking', auto_liab_limit: '' }, today);
  assert.equal(noLimit.warnings.find((x) => x.code === 'auto-limit.missing')?.path, 'coverage.autoLiabLimit');
  const year = normalizeIntake({ ...raw, drv_cdl_1: '', drv_cdl_yr_1: '2015' }, today);
  assert.equal(year.record.drivers[0].cdl, null);
  assert.equal(year.warnings.find((x) => x.code === 'cdl.blank-with-year')?.path, 'drivers[0].cdl');
  assert.ok(!normalizeIntake({ ...raw, drv_cdl_1: '', drv_cdl_yr_1: '' }, today).warnings.some((x) => x.code === 'cdl.blank-with-year'), 'blank and no year: TNI\'s No, no question');
});

test('the agent changing auto liability in the panel follows NTL, unless they set NTL themselves', () => {
  const r = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking' }, { today: new Date('2026-10-26') }).record;
  r.coverage.autoLiability = 'Yes';
  assert.deepEqual(rederive(r, 'coverage.autoLiability'), ['coverage.ntl']);
  assert.equal(r.coverage.ntl, null, 'no longer asked for: unset, the agent decides');
  r.coverage.autoLiability = 'Non-Trucking';
  rederive(r, 'coverage.autoLiability');
  assert.equal(r.coverage.ntl, true);
  r.coverage.ntl = false;
  r.coverage.autoLiability = 'Non-Trucking';
  assert.deepEqual(rederive(r, 'coverage.autoLiability', { keep: new Set(['coverage.ntl']) }), [], 'the agent\'s own NTL answer stays');
  assert.equal(r.coverage.ntl, false);
});

// The maintainer, 2026-10-26: filings asked for with no USDOT or MC number is a wrong intake.
// Filings are made under a number, so the agent checks it with the client.
test('filings requested without a USDOT or MC number asks the agent', () => {
  const today = { today: new Date('2026-10-26') };
  const r = normalizeIntake({ ...raw, fed_state_filings: 'Yes', dot_number: '', mc_number: '', mc_dot_60days: 'No' }, today);
  const w = r.warnings.find((x) => x.code === 'filings.no-number');
  assert.equal(w?.level, 'check');
  assert.equal(w.path, 'applicant.dot');
  assert.match(w.msg, /filings/i);
  // Within 60 days: still a question, said so.
  const soon = normalizeIntake({ ...raw, fed_state_filings: 'Yes', dot_number: '', mc_number: '', mc_dot_60days: 'Yes' }, today);
  assert.match(soon.warnings.find((x) => x.code === 'filings.no-number')?.msg ?? '', /within 60 days/);
  // A number given, no filings, or filings unanswered: nothing.
  for (const changes of [{ fed_state_filings: 'Yes', dot_number: '1234567', mc_number: '' }, { fed_state_filings: 'Yes', dot_number: '', mc_number: '7654321' },
    { fed_state_filings: 'No', dot_number: '', mc_number: '' }, { fed_state_filings: '', dot_number: '', mc_number: '' }]) {
    assert.ok(!normalizeIntake({ ...raw, ...changes }, today).warnings.some((x) => x.code === 'filings.no-number'), JSON.stringify(changes));
  }
});

// The maintainer, 2026-10-26: an NTL client is leased on to a motor carrier, which covers the
// cargo; NTL and cargo both asked for doesn't make sense. A check (yellow) for every carrier.
test('NTL with cargo asked for is a check for the agent, on every carrier', () => {
  const today = { today: new Date('2026-10-26') };
  const both = normalizeIntake({ ...raw, auto_liability: 'Non-Trucking', cargo_cov: 'Yes' }, today);
  const w = both.warnings.find((x) => x.code === 'coverage.ntl-cargo');
  assert.equal(w?.level, 'check');
  assert.equal(w.path, 'coverage.cargo');
  assert.match(w.msg, /non-trucking/i);
  assert.match(w.msg, /cargo/i);
  for (const changes of [{ auto_liability: 'Non-Trucking', cargo_cov: 'No' }, { auto_liability: 'Yes', cargo_cov: 'Yes' }, { auto_liability: 'Non-Trucking', cargo_cov: '' }]) {
    assert.ok(!normalizeIntake({ ...raw, ...changes }, today).warnings.some((x) => x.code === 'coverage.ntl-cargo'), JSON.stringify(changes));
  }
  assert.equal(ntlWithCargo({ coverage: { ntl: true, cargo: true } }), true);
  assert.equal(ntlWithCargo({ coverage: { ntl: null, cargo: true } }), false, 'NTL only mentioned, not decided: no');
});

// The maintainer, 2026-10-26 (W44-28): "US DOT is not added and filings not added if its NTL, in
// every case". An NTL intake asking for filings, or giving a USDOT number, says so (info): the
// carriers' filings answers then differ from the intake on purpose.
test('NTL with filings or a USDOT number on the intake: an info item says TNI adds neither', () => {
  const today = { today: new Date('2026-10-26') };
  const item = (changes) => normalizeIntake({ ...raw, ...changes }, today).warnings.find((x) => x.code === 'coverage.ntl-filings');
  const filings = item({ auto_liability: 'Non-Trucking', fed_state_filings: 'Yes', dot_number: '1234567' });
  assert.equal(filings?.level, 'info');
  assert.equal(filings.path, 'operations.filingsRequired');
  assert.match(filings.msg, /non-trucking liability/i);
  assert.match(filings.msg, /no filings/i);
  assert.match(filings.msg, /USDOT/);
  // A USDOT number without filings: said on the number.
  const dot = item({ auto_liability: 'Non-Trucking', fed_state_filings: 'No', dot_number: '1234567' });
  assert.equal(dot?.level, 'info');
  assert.equal(dot.path, 'applicant.dot');
  assert.match(dot.msg, /USDOT/);
  // Nothing to leave out (no USDOT, no filings), no NTL, or NTL with primary auto liability too
  // (not settled: filled as before): nothing.
  for (const changes of [{ auto_liability: 'Non-Trucking', fed_state_filings: 'No', dot_number: '' }, { auto_liability: 'Non-Trucking', fed_state_filings: '', dot_number: '' },
    { auto_liability: 'Yes', fed_state_filings: 'Yes', dot_number: '1234567' }]) {
    assert.equal(item(changes), undefined, JSON.stringify(changes));
  }
  assert.equal(ntlNoDotFilings({ coverage: { ntl: true, autoLiability: 'Non-Trucking' } }), true);
  assert.equal(ntlNoDotFilings({ coverage: { ntl: true, autoLiability: null } }), true, 'NTL set by the agent, auto liability blank');
  assert.equal(ntlNoDotFilings({ coverage: { ntl: true, autoLiability: 'Yes' } }), false, 'NTL and primary auto liability: not settled');
  assert.equal(ntlNoDotFilings({ coverage: { ntl: null, autoLiability: 'Non-Trucking' } }), false, 'NTL not set (the agent changed it): no');
  assert.equal(ntlNoDotFilings(null), false);
});

// (TNI, 2026-10-26: answer to PR question, #192 "intake checks on an NTL quote") On an NTL intake asking for filings, the
// "filings without a number" and "which filings" checks are dropped; the info item above says why
// the carriers answer No. Not NTL: both checks as before.
test('an NTL intake asking for filings: no "filings without a number" or "which filings" check', () => {
  const today = { today: new Date('2026-10-26') };
  const codes = (changes) => normalizeIntake({ ...raw, fed_state_filings: 'Yes', filings_which: '', dot_number: '', mc_number: '', mc_dot_60days: 'No', ...changes }, today).warnings.map((x) => x.code);
  const ntl = codes({ auto_liability: 'Non-Trucking' });
  assert.ok(!ntl.includes('filings.no-number'), 'filings without a number: dropped on NTL');
  assert.ok(!ntl.includes('filings-which.missing'), 'which filings: dropped on NTL');
  assert.ok(ntl.includes('coverage.ntl-filings'), 'the NTL info item explains instead');
  // Not NTL (auto liability Yes, NTL only mentioned in the notes, or nothing): both checks stay.
  for (const changes of [{ auto_liability: 'Yes' }, { auto_liability: 'Yes', additional_notes: 'Asked about NTL' }, {}]) {
    const c = codes(changes);
    assert.ok(c.includes('filings.no-number') && c.includes('filings-which.missing'), JSON.stringify(changes));
  }
});

// (TNI, 2026-10-26: answers to PR questions, #192 "NTL and primary auto liability" and "NTL not answered yet") NTL with primary auto liability (auto
// liability Yes) is an intake check naming the conflict, and its USDOT and filings questions are
// the agent's on every carrier; NTL mentioned and not answered yet makes them wait for the answer.
test('NTL with primary auto liability, or NTL mentioned and not answered: the USDOT and filings questions are the agent\'s', () => {
  assert.equal(ntlWithPrimary({ coverage: { ntl: true, autoLiability: 'Yes' } }), true);
  for (const coverage of [{ ntl: true, autoLiability: 'Non-Trucking' }, { ntl: true, autoLiability: null }, { ntl: false, autoLiability: 'Yes' }, { ntl: null, autoLiability: 'Yes' }]) {
    assert.equal(ntlWithPrimary({ coverage }), false, JSON.stringify(coverage));
  }
  // A mention in the claims box or the Additional Notes, or Luna's flag, with NTL not answered.
  assert.equal(ntlUndecided({ coverage: { ntl: null }, claims: { text: 'No\nNeeds NTL' } }), true);
  assert.equal(ntlUndecided({ coverage: { ntl: null }, notes: { text: 'bobtail coverage?' } }), true);
  assert.equal(ntlUndecided({ coverage: { ntl: null }, claims: { aiNtl: true } }), true);
  for (const ntl of [true, false]) assert.equal(ntlUndecided({ coverage: { ntl }, notes: { text: 'Needs NTL' } }), false, `answered ${ntl}`);
  assert.equal(ntlUndecided({ coverage: { ntl: null }, claims: { text: 'No' } }), false, 'no mention');
  // The note the carriers give their USDOT and filings questions: why, or nothing.
  assert.match(ntlDotFilingsHold({ coverage: { ntl: true, autoLiability: 'Yes' } }), /primary auto liability/);
  assert.match(ntlDotFilingsHold({ coverage: { ntl: null, autoLiability: 'Yes' }, notes: { text: 'Needs NTL' } }), /Intake step/);
  for (const r of [{ coverage: { ntl: true, autoLiability: 'Non-Trucking' } }, { coverage: { ntl: false, autoLiability: 'Yes' }, notes: { text: 'Needs NTL' } }, { coverage: { ntl: null, autoLiability: 'Yes' } }, null]) {
    assert.equal(ntlDotFilingsHold(r), null, JSON.stringify(r));
  }
  // The intake check: made with the others from the record (`coverage.ntl-primary`, on auto
  // liability). Today's form can't ask for both (Non-Trucking is its auto liability answer), so
  // from a PDF it is never made; the agent's NTL Yes in the panel makes it (sidepanel ntlPrimaryEdited).
  assert.match(NTL_PRIMARY_MESSAGE, /non-trucking liability \(NTL\)/i);
  assert.match(NTL_PRIMARY_MESSAGE, /primary auto liability/i);
  assert.match(NTL_PRIMARY_MESSAGE, /USDOT/);
  const today = { today: new Date('2026-10-26') };
  for (const changes of [{ auto_liability: 'Yes', additional_notes: 'Needs NTL' }, { auto_liability: 'Non-Trucking' }, { auto_liability: 'Yes' }]) {
    assert.ok(!normalizeIntake({ ...raw, ...changes }, today).warnings.some((x) => x.code === 'coverage.ntl-primary'), JSON.stringify(changes));
  }
});

// AmWINS has no NTL option the filler knows: TNI writes it in the disclosure details, the big box
// at the end of Underwriting where the cargo, radius, trailers and POP lines go (the maintainer,
// 2026-10-26). First, with the intake's liability limit.
test('AmWINS writes NTL as the first line of the disclosure details', () => {
  const today = { today: new Date('2026-10-26') };
  const disclosure = (changes) => buildPlan(normalizeIntake({ ...raw, ...changes }, today).record, amwins).find((s) => s.re === '^disclosure details$').value;
  const lines = disclosure({ auto_liability: 'Non-Trucking', auto_liab_limit: '$1M CSL' }).split('\n');
  assert.equal(lines[0], 'Non-Trucking Liability (NTL) - $1M CSL');
  assert.ok(lines.some((l) => /^POP /.test(l)), 'the other lines stay');
  assert.equal(disclosure({ auto_liability: 'Non-Trucking', auto_liab_limit: '' }).split('\n')[0], 'Non-Trucking Liability (NTL)', 'no limit: the line without it');
  assert.doesNotMatch(disclosure({ auto_liability: 'Yes' }), /Non-Trucking/, 'not asked for: no line');
  // Set by the agent after the notes (no form answer): the same line.
  const r = normalizeIntake({ ...raw, auto_liability: 'Yes', additional_notes: 'wants NTL' }, today).record;
  r.coverage.ntl = true;
  assert.match(buildPlan(r, amwins).find((s) => s.re === '^disclosure details$').value, /^Non-Trucking Liability \(NTL\) - \$1M CSL$/m);
});

// TNI, 2026-10-27: cargo with a limit but no deductible is the agent's on every carrier (until then
// Progressive and AmWINS took $1,000); the Intake step says what the deductible usually is.
test('cargo with a limit but no deductible is a check on the Intake step', () => {
  const today = { today: new Date('2026-10-27') };
  const check = (ded) => normalizeIntake({ ...raw, cargo_cov: 'Yes', cargo_limit_ded: ded }, today).warnings.find((w) => w.code === 'cargo-deductible.missing');
  const w = check('$100K');
  assert.deepEqual([w.level, w.path], ['check', 'coverage.cargoDeductible']);
  assert.match(w.msg, /usually \$1,000 or \$2,500/);
  assert.equal(check('$100K/$1K Ded'), undefined);
  assert.equal(check(''), undefined, 'no limit either: cargo-limit.missing instead');
});

// W44-09 (TNI, 2026-10-26: the reader takes it from the notes). A PA intake had year established
// and years under own authority N/A and "3+ years in business" in its notes: every quote got 0
// (AmWINS New Venture) until the agent typed 3. A form box with a value wins over the notes.
const W44 = { today: new Date('2026-10-26') };
const noYears = (notes, claims = 'No') => normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'N/A', claims_details: claims, additional_notes: notes }, W44);

test('years in business the notes state fill a blank form, with a check quoting them (W44-09)', () => {
  const r = noYears('In Biz for 3+ years \n\nPOP is for 1+ year\n\n');
  assert.equal(r.record.applicant.yearsInBusiness, 3, 'a plus is at least that many');
  assert.equal(r.record.applicant.yearEstablished, null);
  assert.equal(r.record.applicant.yearsExperience, null, 'years under own authority are never read from a business phrase');
  const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
  assert.equal(w?.level, 'check');
  assert.equal(w.path, 'applicant.yearsInBusiness');
  assert.match(w.msg, /Additional Notes.*"In Biz for 3\+ years"/);
  assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), 'not the blank standard');
  assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] });
  // Every carrier that asks it (Progressive doesn't).
  const amwinsYears = buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness');
  assert.equal(amwinsYears.value, '3');
  assert.equal(amwinsYears.source, 'derived');
  const geicoYears = buildPlan(r.record, geico).find((s) => s.name === 'Years in business');
  assert.equal(geicoYears.value, '3-6');
  assert.equal(geicoYears.note, null);
  // The claims box's other lines too.
  const claims = noYears('', 'No \n\nin Biz for 3+ years ');
  assert.equal(claims.record.applicant.yearsInBusiness, 3);
  assert.deepEqual(claims.readFrom, { 'applicant.yearsInBusiness': ['claims_details'] });
  assert.match(claims.warnings.find((x) => x.code === 'years-in-business.notes').msg, /claims box.*"in Biz for 3\+ years"/);
});

test('the notes\' wordings of years in business, and of a start year (W44-09)', () => {
  for (const [notes, years] of [['5 years in business', 5], ['in business for 5 years', 5], ['In business 2 yrs.', 2], ['6+ yrs in biz', 6],
    ['Owner operator, in business for 4 years, 2 trucks', 4], ['0 years in business', 0]]) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearsInBusiness, years, notes);
    assert.equal(r.record.applicant.yearEstablished, null, notes);
  }
  for (const notes of ['Established 2019', 'Business established in 2019', 'In business since 2019', 'Company founded in 2019']) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearEstablished, 2019, notes);
    assert.equal(r.record.applicant.yearsInBusiness, 7, notes);
    assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'], 'applicant.yearEstablished': ['additional_notes'] }, notes);
  }
  assert.equal(buildPlan(noYears('Established 2019').record, amwins).find((s) => s.selector === '#yearBusinessEstablished').value, 2019);
  // Two statements that agree are one answer.
  assert.equal(noYears('Established 2019\nIn business for 7 years').record.applicant.yearsInBusiness, 7);
});

test('numbers in the notes about something else stay out of years in business (W44-09)', () => {
  for (const notes of ['10 years driving', 'CDL for 5 years', '5 years experience in business', 'Driver experience: 3+ years in business', 'POP is for 1+ year',
    'WITH STATEFARM A YEAR', 'insured for 14 month', 'Policy term 1 year', 'Accident in 2019', 'Insured since 2019', '20 years in the business',
    'MC authority established 2020', 'less than 1 year driving', '3 Years', '11 Years']) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearsInBusiness, null, notes);
    assert.equal(r.record.applicant.yearEstablished, null, notes);
    assert.ok(r.warnings.some((x) => x.code === 'years-in-business.default'), `${notes}: still TNI's blank standard`);
    assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.notes'), notes);
    assert.deepEqual(r.readFrom, {}, notes);
  }
  // Statements of years in business it doesn't read are the agent's, named (round-6 answer 4, below): a
  // negation, a start year after this year, more than 100 years, "less than N" and "under N" (other
  // than R10, T8 and U1), "almost", "nearly", the signs, and figures that disagree, also in one clause.
  for (const notes of ['Not in business for 3 years yet', 'Established 2031', 'in business for 300 years',
    'under 3 years in business', 'in business for less than 3 years', 'In biz for under 2 yrs', 'almost 3 years in business',
    'in business for nearly 3 years', '~3 years in business', '>3 years in business']) leavesUnread(notes);
  for (const [notes, lines] of [['In biz for 3+ years\nIn business for 6 years', ['In biz for 3+ years', 'In business for 6 years']],
    ['In business for over 3 years\nIn business for 6 years', ['In business for over 3 years', 'In business for 6 years']],
    ['3 years in business and 4 years in business', undefined], ['in business for 3 years and in business for 4 years', undefined]]) leavesUnread(notes, lines);
  // A decimal is rounded down like months (round-6 answer 3): "2.5 years" is 2.
  readsYears('2.5 years in business', 2, '2.5 years');
});

test('a form box with years wins over the notes (W44-09)', () => {
  const est = normalizeIntake({ ...raw, year_established: '2021', years_experience: '5+ years', claims_details: 'No', additional_notes: 'In Biz for 6+ years' }, W44);
  assert.equal(est.record.applicant.yearsInBusiness, 5);
  assert.ok(!est.warnings.some((x) => /^years-in-business\./.test(x.code)));
  assert.deepEqual(est.readFrom, {});
  // Years under own authority given and the notes silent about the business's years: AmWINS' years
  // in business come from that box, as before.
  const authority = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: '4', claims_details: 'No', additional_notes: '10 years driving' }, W44);
  assert.equal(authority.record.applicant.yearsInBusiness, null);
  assert.ok(!authority.warnings.some((x) => /^years-in-business\./.test(x.code)));
  assert.equal(buildPlan(authority.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, '4');
});

// Q24 (TNI, 2026-10-26: answer to PR question): years under own authority on the form, year
// established blank, and years in business in the notes: the notes win for years in business. Years
// under own authority is a different fact and stays as the form gives it, for its own questions.
test('the notes\' years in business win over years under own authority, which stay for their own questions (W44-09)', () => {
  const r = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: '2', claims_details: 'No', additional_notes: 'In Biz for 6+ years' }, W44);
  assert.equal(r.record.applicant.yearsInBusiness, 6);
  assert.equal(r.record.applicant.yearsExperience, 2, 'years under own authority as the form gives them');
  assert.equal(r.record.applicant.yearEstablished, null);
  assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] });
  const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
  assert.equal(w?.level, 'check');
  assert.match(w.msg, /"In Biz for 6\+ years".*years in business is 6/);
  assert.match(w.msg, /years under own authority \(2\)/, 'the check says the authority years stay');
  const amwinsPlan = buildPlan(r.record, amwins);
  assert.equal(amwinsPlan.find((s) => s.selector === '#yrsInBusiness').value, '5+', 'the notes\' 6, not the authority\'s 2');
  assert.equal(amwinsPlan.find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, '2 TO 3 YEARS', 'the authority\'s own question keeps the form\'s 2');
  assert.equal(buildPlan(r.record, geico).find((s) => s.name === 'Years in business').value, '3-6');
  // A start year in the notes, the same way.
  const since = normalizeIntake({ ...raw, year_established: '', years_experience: '1', claims_details: 'No', additional_notes: 'In business since 2019' }, W44);
  assert.deepEqual([since.record.applicant.yearsInBusiness, since.record.applicant.yearEstablished, since.record.applicant.yearsExperience], [7, 2019, 1]);
  // Counterexamples: a filled year established still wins, and driving or CDL years are never business years.
  const est = normalizeIntake({ ...raw, year_established: '2024', years_experience: '2', claims_details: 'No', additional_notes: 'In Biz for 6+ years' }, W44);
  assert.equal(est.record.applicant.yearsInBusiness, 2);
  assert.ok(!est.warnings.some((x) => x.code === 'years-in-business.notes'));
  for (const notes of ['10 years driving', 'CDL for 5 years', 'Driver experience: 6+ years in business']) {
    const drv = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: '2', claims_details: 'No', additional_notes: notes }, W44);
    assert.equal(drv.record.applicant.yearsInBusiness, null, notes);
    assert.equal(buildPlan(drv.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, '2', notes);
  }
});

// Q25 (TNI, 2026-10-26: answer to PR question): "NEW" in the years-under-own-authority box is 0
// years. AmWINS' "federal authority active" is then LESS THAN 1 YEAR; GEICO and Progressive don't
// read the years under own authority.
test('"NEW" in years under own authority is 0 years (W44-15)', () => {
  for (const box of ['NEW', 'New', 'new.', ' NEW ']) {
    const r = normalizeIntake({ ...raw, years_experience: box }, W44);
    assert.equal(r.record.applicant.yearsExperience, 0, box);
    assert.ok(!r.warnings.some((x) => x.code === 'years-experience.invalid'), box);
    assert.equal(r.warnings.find((x) => x.code === 'years-experience.new')?.level, 'info', box);
  }
  const r = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'NEW', claims_details: 'No', additional_notes: '' }, W44);
  const amwinsPlan = buildPlan(r.record, amwins);
  assert.equal(amwinsPlan.find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, 'LESS THAN 1 YEAR');
  assert.equal(amwinsPlan.find((s) => s.selector === '#yrsInBusiness').value, 'New Venture', 'the authority\'s 0, as before from the blank standard');
  assert.equal(buildPlan(r.record, geico).find((s) => s.name === 'Years in business').value, null, 'GEICO reads years in business only');
  // The notes still give years in business (Q24).
  const notes = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'NEW', claims_details: 'No', additional_notes: 'in business for 3 years' }, W44);
  assert.deepEqual([notes.record.applicant.yearsInBusiness, notes.record.applicant.yearsExperience], [3, 0]);
  assert.equal(buildPlan(notes.record, amwins).find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, 'LESS THAN 1 YEAR');
  // Counterexamples: other words are still not a number, and a blank stays blank.
  for (const box of ['new trucks', 'Newark', 'abc']) {
    const other = normalizeIntake({ ...raw, years_experience: box }, W44);
    assert.equal(other.record.applicant.yearsExperience, null, box);
    assert.ok(other.warnings.some((x) => x.code === 'years-experience.invalid'), box);
  }
  assert.equal(normalizeIntake({ ...raw, years_experience: '' }, W44).record.applicant.yearsExperience, null);
});

// Q26 (TNI, 2026-10-26: answer to PR question): "no" in the USDOT or MC box is an explicit No, the
// client has no USDOT (or MC) number, which a blank box is not. The has-a-USDOT-number questions
// answer No.
test('"no" in the USDOT or MC box is an explicit No (W44-15)', () => {
  const intake = (fields) => normalizeIntake({ ...raw, mc_number: '', mc_dot_60days: '', ...fields }, W44);
  const progressiveDot = (r) => buildPlan(r.record, progressive).find((s) => s.q === '1ED').value;
  const geicoDot = (r) => buildPlan(r.record, geico).find((s) => s.name === 'Has a USDOT number').value;
  const amwinsStep = (r, sel) => buildPlan(r.record, amwins).find((s) => s.selector === sel).value;
  for (const box of ['no', 'No', 'NO', 'no.']) {
    const r = intake({ dot_number: box });
    assert.equal(r.record.applicant.dot, null, box);
    assert.equal(r.record.applicant.noDot, true, box);
    assert.ok(!r.warnings.some((x) => x.code === 'id.invalid'), box);
    assert.equal(r.warnings.find((x) => x.code === 'dot.none')?.level, 'info', box);
    assert.equal(progressiveDot(r), 'No - and the customer will not have a USDOT number', box);
    assert.equal(geicoDot(r), 'No', box);
    assert.equal(amwinsStep(r, '#hasDotNumber'), false, box);
    assert.equal(amwinsStep(r, '#noNumber'), true, box);
  }
  const mc = intake({ mc_number: 'NO' });
  assert.equal(mc.record.applicant.mc, null);
  assert.equal(mc.record.applicant.noMc, true);
  assert.ok(!mc.warnings.some((x) => x.code === 'id.invalid'));
  assert.equal(mc.warnings.find((x) => x.code === 'mc.none')?.level, 'info');
  assert.equal(amwinsStep(mc, '#hasMcNumber'), false);
  assert.equal(geicoDot(mc), 'Yes', 'the USDOT number is still the intake\'s');
  // The 60-day answer saying one is coming still decides: Progressive's Not Yet, GEICO's agent.
  const coming = intake({ dot_number: 'no', mc_dot_60days: 'Yes' });
  assert.equal(progressiveDot(coming), 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days');
  assert.equal(geicoDot(coming), 'Not yet, but the customer has applied for one.', '60-day Yes: Not yet on GEICO too (TNI, 2026-10-27)');
  // Counterexamples: a blank box is not a No, and a real number is unaffected.
  const blank = intake({ dot_number: '' });
  assert.equal(blank.record.applicant.noDot, null);
  assert.equal(progressiveDot(blank), null);
  assert.equal(geicoDot(blank), null);
  const number = intake({ dot_number: 'USDOT 1234567' });
  assert.deepEqual([number.record.applicant.dot, number.record.applicant.noDot], ['1234567', null]);
  assert.equal(progressiveDot(number), 'Yes - the customer has a USDOT number');
  assert.equal(geicoDot(number), 'Yes');
  assert.equal(amwinsStep(number, '#hasDotNumber'), true);
  assert.ok(intake({ dot_number: 'none yet' }).warnings.some((x) => x.code === 'id.invalid'), 'other words are still not a number');
});

// Q27 (TNI, 2026-10-26: answer to PR question): "over N", "about N", "around N", "more than N" and
// "approximately N" years in business in the notes are N, with the check quoting the phrase.
test('qualified years in business in the notes read as the figure, with the check quoting them (W44-09)', () => {
  for (const notes of ['over 3 years in business', 'In business for over 3 years', 'about 3 years in business', 'in biz for around 3 yrs',
    'More than 3 years in business', 'Approximately 3 years in business', 'in business for approx. 3 years', 'In business for about 3+ years']) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearsInBusiness, 3, notes);
    const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
    assert.ok(w?.msg.includes(`"${notes}"`), `${notes}: the check quotes the phrase`);
    assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), notes);
  }
  // A qualified figure and a plain one that agree are one answer.
  assert.equal(noYears('over 3 years in business\nIn business for 3 years').record.applicant.yearsInBusiness, 3);
});

// R10 (TNI, 2026-10-26: answer to PR question): "less than 1 year" or "under 1 year" in business,
// in the notes, is 0 years (New Venture). Any other "less than N" or "under N" stays the agent's.
test('"less than 1 year" or "under 1 year" in business in the notes is 0 years (W44-09, R10)', () => {
  for (const notes of ['less than 1 year in business', 'In business for less than 1 year', 'Under 1 yr in biz', 'in biz for under 1 year']) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearsInBusiness, 0, notes);
    assert.equal(r.record.applicant.yearEstablished, null, notes);
    const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
    assert.equal(w?.level, 'check', notes);
    assert.ok(w.msg.includes(`"${notes}"`), `${notes}: the check quotes the phrase`);
    assert.match(w.msg, /years in business is 0 \("(?:less than|under) 1 y\w*" read as 0\)/i, notes);
    assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), notes);
    assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] }, notes);
    const amwinsYears = buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness');
    assert.deepEqual([amwinsYears.value, amwinsYears.source], ['New Venture', 'derived'], notes);
    assert.equal(buildPlan(r.record, geico).find((s) => s.name === 'Years in business').value, 'Less than 1', notes);
  }
  // Counterexamples: any other figure after "less than" or "under" stays the agent's (named since
  // round-6 answer 4), as does a 0 disagreeing with a start year; a clause about something else is
  // silent.
  for (const notes of ['less than 3 years in business', 'In business for under 2 years', 'under 10 yrs in biz']) leavesUnread(notes);
  leavesUnread('less than 1 year in business\nEstablished 2019', ['less than 1 year in business', 'Established 2019']);
  leavesYears('less than 1 year driving');
});

// R11 (TNI, 2026-10-26: answer to PR question): a duration in months converts to whole years,
// rounded down ("18 months" is 1, "6 months" is 0). "almost", "nearly", "~" and ">" stay unread.
// T7 (TNI, 2026-10-26: answer to PR question, confirmed): "over 18 months" and "about 6 months" are
// those months, rounded down (1, 0), in either wording.
test('months in business in the notes are whole years, rounded down (W44-09, R11, T7)', () => {
  for (const [notes, years] of [['18 months in business', 1], ['In business for 6 months', 0], ['in biz 24 mos', 2], ['12 months in business', 1],
    ['11 months in business', 0], ['In business for 30+ months', 2], ['over 18 months in business', 1], ['in business for about 6 months', 0],
    ['In business for over 18 months', 1], ['about 6 months in business', 0]]) {
    const r = noYears(notes);
    assert.equal(r.record.applicant.yearsInBusiness, years, notes);
    assert.equal(r.record.applicant.yearEstablished, null, notes);
    const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
    assert.equal(w?.level, 'check', notes);
    assert.ok(w.msg.includes(`"${notes}"`), `${notes}: the check quotes the phrase`);
    assert.match(w.msg, new RegExp(`years in business is ${years} \\("[^"]*\\d+ mo\\w*" read as ${years}\\)`), `${notes}: says how it was read`);
  }
  for (const notes of ['18 months in business', 'over 18 months in business']) {
    const r = noYears(notes);
    assert.equal(buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, '1', notes);
    assert.equal(buildPlan(r.record, geico).find((s) => s.name === 'Years in business').value, '1', notes);
  }
  for (const notes of ['in business for 6 months', 'about 6 months in business']) {
    const r = noYears(notes);
    assert.equal(buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, 'New Venture', notes);
    assert.equal(buildPlan(r.record, geico).find((s) => s.name === 'Years in business').value, 'Less than 1', notes);
  }
  // Agreeing with a figure in years is one answer.
  assert.equal(noYears('18 months in business\nIn business for 1 year').record.applicant.yearsInBusiness, 1);
  // Counterexamples: the undecided qualifiers, "under" or "less than" more than 12 months (T8), and
  // months disagreeing with years stay the agent's (named since round-6 answer 4); months of something else
  // and a bare duration are silent. A decimal is rounded down (round-6 answer 3): "2.5 months" is 0.
  for (const notes of ['almost 18 months in business', 'in business for nearly 6 months', '~18 months in business', '>18 months in business',
    'In business for under 18 months']) leavesUnread(notes);
  leavesUnread('18 months in business\nIn business for 3 years', ['18 months in business', 'In business for 3 years']);
  for (const notes of ['18 months of driving experience', '18 months in business driving for Amazon', '18 months']) leavesYears(notes);
  readsYears('2.5 months in business', 0, '2.5 months');
});

// T8 (TNI, 2026-10-26: answer to PR question): three more forms of years in business in the notes
// are read: "less than N months" with N up to 12 is 0; a number in words is read as its digits
// ("less than a year" is 0, "two years" is 2); years plus months are the whole years ("1 year 6
// months" is 1). What the answer doesn't name stays as it was.
const readsYears = (notes, years, reading) => {
  const r = noYears(notes);
  assert.equal(r.record.applicant.yearsInBusiness, years, notes);
  assert.equal(r.record.applicant.yearEstablished, null, notes);
  const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
  assert.equal(w?.level, 'check', notes);
  assert.ok(w.msg.includes(`"${notes}"`), `${notes}: the check quotes the phrase`);
  if (reading) assert.ok(w.msg.includes(`years in business is ${years} ("${reading}" read as ${years})`), `${notes}: says how it was read: ${w.msg}`);
  assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), notes);
  assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] }, notes);
  return r;
};
const leavesYears = (notes) => {
  const r = noYears(notes);
  assert.equal(r.record.applicant.yearsInBusiness, null, notes);
  assert.ok(r.warnings.some((x) => x.code === 'years-in-business.default'), `${notes}: still TNI's blank standard`);
  assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.notes'), notes);
};
// The figure read from a note that holds another number too, and the phrase the check quotes.
const readsOnly = (notes, years, quote) => {
  const r = noYears(notes);
  assert.equal(r.record.applicant.yearsInBusiness, years, notes);
  assert.ok(r.warnings.find((x) => x.code === 'years-in-business.notes')?.msg.includes(`"${quote}"`), `${notes}: quotes "${quote}"`);
};
const plansYears = (notes) => {
  const r = noYears(notes).record;
  const step = buildPlan(r, amwins).find((s) => s.selector === '#yrsInBusiness');
  return [step.value, step.source, buildPlan(r, geico).find((s) => s.name === 'Years in business').value];
};

test('"less than N months" in business, N up to 12, is 0 years (W44-09, T8)', () => {
  for (const [notes, reading] of [['less than 6 months in business', 'less than 6 months'], ['In business for less than 6 months', 'less than 6 months'],
    ['less than 12 months in business', 'less than 12 months'], ['in biz for less than 1 month', 'less than 1 month'],
    ['Less than 11 mos in biz', 'Less than 11 mos'], ['less than six months in business', 'less than six months'],
    ['in business for less than twelve months', 'less than twelve months']]) {
    readsYears(notes, 0, reading);
    assert.deepEqual(plansYears(notes), ['New Venture', 'derived', 'Less than 1'], notes);
  }
  // Counterexamples: more than 12 months stays the agent's, as before (named since round-6 answer 4), and a
  // clause about something else is silent. "under" months: U1, below; "less than a month": V11, below.
  for (const notes of ['less than 13 months in business', 'In business for less than 18 months', 'less than 24 mos in biz']) leavesUnread(notes);
  leavesYears('less than 6 months driving');
  // Another number in the same note is not taken: a vehicle count, a driver's experience, a date.
  readsOnly('3 trucks, less than 6 months in business', 0, 'less than 6 months in business');
  readsOnly('Driver has 10 years experience; less than 6 months in business', 0, 'less than 6 months in business');
  readsOnly('less than 6 months in business, truck bought 03/2026', 0, 'less than 6 months in business');
});

test('numbers in words in the notes read as their digits (W44-09, T8)', () => {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  words.forEach((word, i) => {
    const unit = i === 0 ? 'year' : 'years';
    readsYears(`${word} ${unit} in business`, i + 1, `${word} ${unit}`);
    const capital = `${word[0].toUpperCase()}${word.slice(1)}`;
    readsYears(`In business for ${capital} ${unit}`, i + 1, `${capital} ${unit}`);
  });
  for (const [notes, years, reading] of [['eleven yrs in biz', 11, 'eleven yrs'], ['Twelve years in business', 12, 'Twelve years'],
    ['twenty-five years in business', 25, 'twenty-five years'], ['in business for twenty five years', 25, 'twenty five years'],
    ['over five years in business', 5, 'over five years'], ['in business for about two years', 2, 'about two years'],
    ['eighteen months in business', 1, 'eighteen months'], ['In business for six months', 0, 'six months'],
    ['less than a year in business', 0, 'less than a year'], ['In business for less than a year', 0, 'less than a year'],
    ['less than one year in business', 0, 'less than one year'], ['under one year in business', 0, 'under one year']]) {
    readsYears(notes, years, reading);
  }
  assert.deepEqual(plansYears('less than a year in business'), ['New Venture', 'derived', 'Less than 1']);
  assert.deepEqual(plansYears('two years in business'), ['2', 'derived', '2']);
  // In words and in digits, agreeing or not.
  assert.equal(noYears('two years in business\nIn business for 2 years').record.applicant.yearsInBusiness, 2);
  leavesUnread('two years in business\nIn business for 3 years', ['two years in business', 'In business for 3 years']);
  // Counterexamples: "a few years" and other qualifiers stay the agent's (named since round-6 answer 4), and
  // clauses about something else are silent. "a year", "half a year", "first year" (V11), ranges in
  // words (V7) and "one and a half years" (round-6 answer 3): below.
  for (const notes of ['a few years in business', 'several years in business', 'almost three years in business']) leavesUnread(notes);
  for (const notes of ['three years driving', 'CDL for two years', 'Driver experience: three years in business',
    'insured for two years', 'three years', 'less than a year driving']) leavesYears(notes);
  // Another number in the same note is not taken: a vehicle count, a driver's experience, a date.
  readsOnly('Two trucks, three years in business', 3, 'three years in business');
  readsOnly('Three drivers; in business for two years', 2, 'in business for two years');
  readsOnly('In business for two years, 3 trucks', 2, 'In business for two years');
  readsOnly('One driver with five years experience. In business for two years', 2, 'In business for two years');
  readsOnly('Owner has ten years driving, in business for one year', 1, 'in business for one year');
  readsOnly('in business for two years, started 10/2024', 2, 'in business for two years');
});

test('years plus months in business in the notes are the whole years (W44-09, T8)', () => {
  for (const [notes, years, reading] of [['1 year 6 months in business', 1, '1 year 6 months'], ['2 years, 6 months in business', 2, '2 years 6 months'],
    ['In business for 1 year 6 months', 1, '1 year 6 months'], ['in business for 2 years, 6 months', 2, '2 years 6 months'],
    ['3 years and 2 months in business', 3, '3 years 2 months'], ['1 yr 11 mos in biz', 1, '1 yr 11 mos'],
    ['one year six months in business', 1, 'one year six months'], ['two years and six months in business', 2, 'two years six months'],
    ['In business for 4 yrs. 3 mos.', 4, '4 yrs 3 mos']]) {
    readsYears(notes, years, reading);
  }
  assert.deepEqual(plansYears('1 year 6 months in business'), ['1', 'derived', '1']);
  assert.deepEqual(plansYears('2 years, 6 months in business'), ['2', 'derived', '2']);
  // Agreeing with months alone, or not agreeing with years.
  assert.equal(noYears('1 year 6 months in business\n18 months in business').record.applicant.yearsInBusiness, 1);
  leavesUnread('1 year 6 months in business\nIn business for 3 years', ['1 year 6 months in business', 'In business for 3 years']);
  // Counterexamples: a qualifier not read before years stays the agent's (named since round-6 answer 4);
  // "less than 1 year 6 months" is not under a year. A clause about something else and a bare
  // duration are silent.
  for (const notes of ['less than 1 year 6 months in business', 'almost 2 years 6 months in business']) leavesUnread(notes);
  for (const notes of ['1 year 6 months driving', 'Driver experience 10 years, 6 months in business', '1 year 6 months']) leavesYears(notes);
  // Another number in the same note is not taken: a vehicle count, a driver's experience, a date.
  readsOnly('3 trucks, 1 year 6 months in business', 1, '1 year 6 months in business');
  readsOnly('10 years driving experience, 2 years 6 months in business', 2, '2 years 6 months in business');
  readsOnly('1 year 6 months in business as of 10/2026', 1, '1 year 6 months in business as of 10/2026');
  readsOnly('2 trucks, 6 months in business', 0, '6 months in business');
});

// U1 (TNI, 2026-10-27: answer to PR question U1): "under" reads as "less than" does after T8.
// "under N months" with N from 1 to 12 is 0, "under a year" is 0, and numbers in words work after
// "under" too. R10's "under 1 year" stays 0. More than 12 months, "under 1 year 6 months", and
// "under" before another number in the same note (a vehicle count, a driver's experience, an age)
// are left as they were.
test('"under N months" (N up to 12) and "under a year" in business are 0 years (W44-09, U1)', () => {
  for (const [notes, reading] of [['under 6 months in business', 'under 6 months'], ['In business for under 6 months', 'under 6 months'],
    ['in business for under 12 months', 'under 12 months'], ['Under 1 month in biz', 'Under 1 month'], ['under 11 mos in biz', 'under 11 mos'],
    ['under six months in business', 'under six months'], ['in business for under twelve months', 'under twelve months'],
    ['under a year in business', 'under a year'], ['In business for under a year', 'under a year'], ['Under a yr in biz', 'Under a yr'],
    ['under one year in business', 'under one year'], ['Under 1 yr in biz', 'Under 1 yr']]) {
    readsYears(notes, 0, reading);
    assert.deepEqual(plansYears(notes), ['New Venture', 'derived', 'Less than 1'], notes);
  }
  // Agreeing with "less than", or with months alone, is one answer; disagreeing settles nothing.
  assert.equal(noYears('under 6 months in business\nIn business for less than a year').record.applicant.yearsInBusiness, 0);
  assert.equal(noYears('under a year in business\n6 months in business').record.applicant.yearsInBusiness, 0);
  leavesUnread('under 6 months in business\nIn business for 3 years', ['under 6 months in business', 'In business for 3 years']);
  // Counterexamples, unread as they were (named since round-6 answer 4): more than 12 months, years plus
  // months, other figures after "under", "a" before anything but a year or a month (V11, below). A
  // clause about something else is silent.
  for (const notes of ['under 13 months in business', 'In business for under 18 months', 'under 24 mos in biz', 'under eighteen months in business',
    'under 1 year 6 months in business', 'under a year 6 months in business', 'under one year six months in business',
    'under 2 years in business', 'under two years in business', 'under a few years in business']) leavesUnread(notes);
  leavesUnread('in business for under 1 year, 6 months', ['in business for under 1 year, 6 months']);
  for (const notes of ['under 6 months driving', 'under a year of driving experience']) leavesYears(notes);
  // "under" before another number in the same note is not taken: a vehicle count, a driver's
  // experience, an age. The years come only from the phrase beside "in business".
  readsOnly('under 5 trucks, 3 years in business', 3, '3 years in business');
  readsOnly('Driver has under 2 years experience; in business for 4 years', 4, 'in business for 4 years');
  readsOnly('Owner under 25 years old, in business for 2 years', 2, 'in business for 2 years');
  readsOnly('under 5 trucks, under 6 months in business', 0, 'under 6 months in business');
  readsOnly('Driver has under 2 years experience; under a year in business', 0, 'under a year in business');
  readsOnly('Owner under 25 years old, in business for under 6 months', 0, 'in business for under 6 months');
  for (const notes of ['under 5 trucks', 'Driver has under 2 years experience', 'Owner under 25 years old']) leavesYears(notes);
});

// V7 (TNI, 2026-10-27: answer to PR question V7): a range gives an answer only when both ends give
// the same one. Years in business is a number, so "2-3 years in business" is the agent's, with the
// years-in-business.notes check naming the line, in digits or in words. Before, "2-3 years in
// business" and "2 to 3 years in business" read the last figure (3). A range whose ends round to the
// same whole years ("18-20 months", both 1) gives that number.
const leavesRange = (notes, reading, fields = { year_established: 'N/A', years_experience: 'N/A' }, line = notes) => {
  const r = normalizeIntake({ ...raw, ...fields, claims_details: 'No', additional_notes: notes }, W44);
  assert.equal(r.record.applicant.yearsInBusiness, null, notes);
  assert.equal(r.record.applicant.yearEstablished, null, notes);
  assert.equal(r.record.applicant.yearsInBusinessRange, true, notes);
  const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
  assert.equal(w?.level, 'check', notes);
  assert.ok(w.msg.includes(`"${line}"`), `${notes}: the check names the line: ${w?.msg}`);
  assert.ok(w.msg.includes(`a range ("${reading}")`), `${notes}: says it is a range: ${w.msg}`);
  assert.match(w.msg, /left to you/, notes);
  assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), `${notes}: not the blank standard`);
  assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] }, notes);
  // The agent's on every carrier that asks it: AmWINS neither New Venture nor the authority years.
  const amwinsYears = buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness');
  assert.equal(amwinsYears.value, null, notes);
  assert.match(amwinsYears.note, /range/, notes);
  const geicoYears = buildPlan(r.record, geico).find((s) => s.name === 'Years in business');
  assert.equal(geicoYears.value, null, notes);
  assert.match(geicoYears.note, /range/, notes);
  return r;
};

test('a range of years in business in the notes gives an answer only when both ends give the same one (W44-09, V7)', () => {
  // Ends that differ: the agent's. In digits, and in words (ranges in words count too).
  for (const [notes, reading] of [['2-3 years in business', '2-3 years'], ['2 to 3 years in business', '2 to 3 years'],
    ['in business for 2-3 years', '2-3 years'], ['In business for 2 to 3 years', '2 to 3 years'], ['2–3 yrs in biz', '2–3 yrs'],
    ['2 - 3 years in business', '2 - 3 years'], ['2 or 3 years in business', '2 or 3 years'], ['between 2 and 3 years in business', 'between 2 and 3 years'],
    ['6-8 years in business', '6-8 years'], ['3-5+ years in business', '3-5+ years'], ['about 2-3 years in business', 'about 2-3 years'],
    ['in business for 18-24 months', '18-24 months'], ['6-18 months in business', '6-18 months'],
    ['two to three years in business', 'two to three years'], ['two-three years in business', 'two-three years'],
    ['in business for two to three years', 'two to three years'], ['two or three years in business', 'two or three years'],
    ['between two and three years in business', 'between two and three years'], ['two - three years in business', 'two - three years'],
    ['Twenty to thirty years in business', 'Twenty to thirty years'], ['in biz for 2 to three yrs', '2 to three yrs']]) {
    leavesRange(notes, reading);
  }
  // Years under own authority on the form: the notes still win for years in business (Q24), so the
  // range is the agent's, not the authority years.
  const authority = leavesRange('in business for 2-3 years', '2-3 years', { year_established: 'N/A', years_experience: '4' });
  assert.match(authority.warnings.find((x) => x.code === 'years-in-business.notes').msg, /years under own authority \(4\)/);
  assert.equal(buildPlan(authority.record, amwins).find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, 'MORE THAN 3 YEARS', 'the authority\'s own question keeps the form\'s 4');
  // A range beside a plain statement: still the agent's, the range named.
  leavesRange('In business for 3 years\n2-3 years in business', '2-3 years', undefined, '2-3 years in business');
  // Ends that round to the same whole years: that number, with the check saying how it was read.
  for (const [notes, years, reading] of [['18-20 months in business', 1, '18-20 months'], ['in business for 18-20 months', 1, '18-20 months'],
    ['6-8 months in business', 0, '6-8 months'], ['In business for 13 to 23 months', 1, '13 to 23 months'],
    ['eighteen to twenty months in business', 1, 'eighteen to twenty months'], ['about 18-20 months in business', 1, 'about 18-20 months']]) {
    const r = readsYears(notes, years, reading);
    assert.equal(r.record.applicant.yearsInBusinessRange, undefined, notes);
  }
  assert.deepEqual(plansYears('18-20 months in business'), ['1', 'derived', '1']);
  assert.deepEqual(plansYears('6-8 months in business'), ['New Venture', 'derived', 'Less than 1']);
  // Counterexamples: a range of something else isn't a range of years in business, nor are a
  // compound number in words ("twenty-five"), years plus months, or a range with no "in business".
  readsYears('twenty-five years in business', 25, 'twenty-five years');
  readsYears('3 years and 2 months in business', 3, '3 years 2 months');
  readsOnly('2-3 trucks, 4 years in business', 4, '4 years in business');
  readsOnly('Driver experience 2-3 years; in business for 5 years', 5, 'in business for 5 years');
  readsOnly('1 to 2 loads a week, in business for 2 years', 2, 'in business for 2 years');
  for (const notes of ['2-3 years driving', 'CDL for 2-3 years', '2-3 years', 'two to three years', 'Insured 2-3 years', '20-25 years in the business']) {
    leavesYears(notes);
    assert.equal(noYears(notes).record.applicant.yearsInBusinessRange, undefined, notes);
  }
});

// V10 (TNI, 2026-10-27: answer to PR question V10, confirmed): "over" or "about" before years plus
// months in business is the whole years: "over 1 year 6 months" is 1, "about 2 years, 3 months" is 2.
test('"over" or "about" before years plus months in business is the whole years (W44-09, V10)', () => {
  for (const [notes, years, reading] of [['over 1 year 6 months in business', 1, 'over 1 year 6 months'],
    ['about 2 years, 3 months in business', 2, 'about 2 years 3 months'], ['In business for over 1 year 6 months', 1, 'over 1 year 6 months'],
    ['in business for about 2 years 3 months', 2, 'about 2 years 3 months'], ['over one year six months in business', 1, 'over one year six months']]) {
    readsYears(notes, years, reading);
  }
  assert.deepEqual(plansYears('over 1 year 6 months in business'), ['1', 'derived', '1']);
  assert.deepEqual(plansYears('about 2 years, 3 months in business'), ['2', 'derived', '2']);
  // Counterexamples: a qualifier not read and "less than" before years plus months stay the agent's
  // (named since round-6 answer 4); a clause about something else is silent.
  for (const notes of ['almost 1 year 6 months in business', 'nearly 2 years, 3 months in business', 'less than 1 year 6 months in business']) leavesUnread(notes);
  leavesYears('over 1 year 6 months driving');
});

// V11 (TNI, 2026-10-27: answer to PR question V11): the definite phrases are read in business: "a
// year" is 1, "half a year" 0, "a year and a half" 1, "less than a month" and "under a month" 0, and
// "first year in business" 0. "a few years" and "several years" stay the agent's.
test('the definite phrases of years in business in the notes are read (W44-09, V11)', () => {
  for (const [notes, years, reading] of [['a year in business', 1, 'a year'], ['In business for a year', 1, 'a year'], ['A yr in biz', 1, 'A yr'],
    ['half a year in business', 0, 'half a year'], ['in business for half a year', 0, 'half a year'],
    ['a year and a half in business', 1, 'a year and a half'], ['In business for a year and a half', 1, 'a year and a half'],
    ['less than a month in business', 0, 'less than a month'], ['in business for less than a month', 0, 'less than a month'],
    ['under a month in business', 0, 'under a month'], ['In business for under a month', 0, 'under a month'],
    ['first year in business', 0, 'first year'], ['First year in biz', 0, 'First year'], ['In our first year in business', 0, 'first year'],
    // A word read as the figure before "a year" (answer 4 with V11; confirmed in round-6 answer 1).
    ['about a year in business', 1, 'about a year'], ['in business for over a year', 1, 'over a year'], ['More than a year in business', 1, 'More than a year']]) {
    readsYears(notes, years, reading);
  }
  assert.deepEqual(plansYears('a year in business'), ['1', 'derived', '1']);
  assert.deepEqual(plansYears('a year and a half in business'), ['1', 'derived', '1']);
  for (const notes of ['half a year in business', 'less than a month in business', 'under a month in business', 'first year in business']) {
    assert.deepEqual(plansYears(notes), ['New Venture', 'derived', 'Less than 1'], notes);
  }
  // Agreeing is one answer; disagreeing settles nothing ("a year" now reads, so it blocks 3).
  assert.equal(noYears('a year in business\nIn business for 1 year').record.applicant.yearsInBusiness, 1);
  assert.equal(noYears('half a year in business\n6 months in business').record.applicant.yearsInBusiness, 0);
  assert.equal(noYears('first year in business\nless than a year in business').record.applicant.yearsInBusiness, 0);
  leavesUnread('a year in business\nIn business for 3 years', ['a year in business', 'In business for 3 years']);
  // Stay the agent's (named since round-6 answer 4): "a few years", "several years", and what V11
  // and round-6 answer 3 don't read. What answer 3 reads ("a month", "one and a half years" …): its
  // test, below.
  for (const notes of ['a few years in business', 'In business for a few years', 'several years in business', 'in business for several years',
    'a couple of years in business', 'under a year and a half in business', 'almost a year in business']) leavesUnread(notes);
  // "a year" doesn't catch other phrases: alone, and beside a statement of years in business. Those
  // that state the business's time, though not as a figure read, are the agent's (round-6 answer 4).
  // "a year-old business" is 1 since round-7 answer 3 (its test, below).
  for (const notes of ['Started a year ago', 'Truck inspected once a year', 'Owns a year-old truck', 'Driver has a year of experience',
    'a year', 'first year driving', 'First year with Progressive']) leavesYears(notes);
  for (const notes of ['Went into business a year ago', 'in business a year ago']) leavesUnread(notes);
  readsOnly('Bought the truck a year ago, in business for 3 years', 3, 'in business for 3 years');
  readsOnly('Inspected once a year; 2 years in business', 2, '2 years in business');
  readsOnly('Owns a year-old truck, in business for 4 years', 4, 'in business for 4 years');
  readsOnly('Driver has a year of experience. In business for 2 years', 2, 'In business for 2 years');
  readsOnly('first year driving, in business for 5 years', 5, 'in business for 5 years');
  readsOnly('Truck is a year old; in business for 6 years', 6, 'in business for 6 years');
});

// Round-6 answer 4 (TNI, 2026-10-27): an in-business statement the reader doesn't
// take leaves AmWINS' years in business to the agent, with the years-in-business.notes check naming
// the line, like a range (V7): not the blank standard's New Venture with years-in-business.default.
// GEICO's years band is the agent's, as it already was, with its note unchanged.
const leavesUnread = (notes, lines = [notes], fields = { year_established: 'N/A', years_experience: 'N/A' }) => {
  const r = normalizeIntake({ ...raw, ...fields, claims_details: 'No', additional_notes: notes }, W44);
  const a = r.record.applicant;
  assert.equal(a.yearsInBusiness, null, notes);
  assert.equal(a.yearEstablished, null, notes);
  assert.equal(a.yearsInBusinessUnread, true, notes);
  assert.equal(a.yearsInBusinessRange, undefined, notes);
  const w = r.warnings.find((x) => x.code === 'years-in-business.notes');
  assert.equal(w?.level, 'check', notes);
  for (const line of lines) assert.ok(w.msg.includes(`"${line}"`), `${notes}: the check names "${line}": ${w.msg}`);
  assert.match(w.msg, /so years in business is left to you/, notes);
  assert.ok(!r.warnings.some((x) => x.code === 'years-in-business.default'), `${notes}: not the blank standard`);
  assert.deepEqual(r.readFrom, { 'applicant.yearsInBusiness': ['additional_notes'] }, notes);
  const amwinsYears = buildPlan(r.record, amwins).find((s) => s.selector === '#yrsInBusiness');
  assert.equal(amwinsYears.value, null, `${notes}: AmWINS leaves it to the agent, not New Venture`);
  assert.match(amwinsYears.note, /answer it yourself/, notes);
  assert.doesNotMatch(amwinsYears.note, /range/, notes);
  const geicoYears = buildPlan(r.record, geico).find((s) => s.name === 'Years in business');
  assert.equal(geicoYears.value, null, notes);
  assert.match(geicoYears.note, /^The intake has no years in business/, `${notes}: GEICO as before`);
  return r;
};

// Round-6 answer 3 (TNI, 2026-10-27): the clear phrases V11 doesn't name are read,
// with the check saying how: "a month", "about a month", "1st year" and "less than half a year" in
// business are 0; "one and a half years", "1 year and a half", "1.5 years" and "second year in
// business" are 1, rounded down like months. The vague ones, "a couple of years" and "under a year
// and a half", stay unread: the agent's (round-6 answer 4).
test('the clear phrases V11 doesn\'t name are read, the vague ones left to the agent (W44-09, round-6 answer 3)', () => {
  for (const [notes, years, reading] of [['a month in business', 0, 'a month'], ['In business for a month', 0, 'a month'], ['A month in biz', 0, 'A month'],
    ['about a month in business', 0, 'about a month'], ['in business for about a month', 0, 'about a month'],
    ['1st year in business', 0, '1st year'], ['In our 1st year in biz', 0, '1st year'],
    ['less than half a year in business', 0, 'less than half a year'], ['In business for less than half a year', 0, 'less than half a year'],
    ['one and a half years in business', 1, 'one and a half years'], ['In business for one and a half years', 1, 'one and a half years'],
    ['1 year and a half in business', 1, '1 year and a half'], ['in business for 1 year and a half', 1, '1 year and a half'],
    ['1.5 years in business', 1, '1.5 years'], ['In business for 1.5 yrs', 1, '1.5 yrs'],
    ['second year in business', 1, 'second year'], ['In our second year in business', 1, 'second year']]) {
    readsYears(notes, years, reading);
  }
  for (const notes of ['a month in business', 'about a month in business', '1st year in business', 'less than half a year in business']) {
    assert.deepEqual(plansYears(notes), ['New Venture', 'derived', 'Less than 1'], notes);
  }
  for (const notes of ['one and a half years in business', '1 year and a half in business', '1.5 years in business', 'second year in business']) {
    assert.deepEqual(plansYears(notes), ['1', 'derived', '1'], notes);
  }
  // The same readings with the rules already decided: "under" as "less than" (U1), digits and words
  // alike (T8), and rounded down like months for any whole years.
  readsYears('under half a year in business', 0, 'under half a year');
  readsYears('2nd year in business', 1, '2nd year');
  readsYears('2.5 years in business', 2, '2.5 years');
  readsYears('two and a half years in business', 2, 'two and a half years');
  readsYears('about 1.5 years in business', 1, 'about 1.5 years');
  // Agreeing is one answer.
  assert.equal(noYears('1.5 years in business\n18 months in business').record.applicant.yearsInBusiness, 1);
  assert.equal(noYears('a month in business\nfirst year in business').record.applicant.yearsInBusiness, 0);
  // Still unread, as the vague ones and what has more than a year after "under" or "less than": the
  // agent's, with the check naming the line (round-6 answer 4).
  for (const notes of ['a couple of years in business', 'In business for a couple of years', 'under a year and a half in business',
    'under one and a half years in business', 'less than 1.5 years in business', 'almost a month in business']) leavesUnread(notes);
  // "a month", the ordinals and the halves catch nothing else.
  for (const notes of ['Started a month ago', 'Truck serviced once a month', 'Owns a month-old truck', 'Driver has a month of experience',
    'a month', 'second year driving', '1st year with Progressive', '1.5 years driving', 'one and a half years of experience']) leavesYears(notes);
  readsOnly('Serviced once a month, in business for 3 years', 3, 'in business for 3 years');
  readsOnly('2 trucks, 1.5 years in business', 1, '1.5 years in business');
});

test('an in-business statement the reader doesn\'t take leaves years in business to the agent, like a range (W44-09, round-6 answer 4)', () => {
  for (const notes of ['a few years in business', 'In business for a few years', 'several years in business', 'in business for several years',
    'less than 3 years in business', 'In business for under 2 years', 'almost 3 years in business', 'in business for nearly 3 years',
    '~3 years in business', '>3 years in business', '<2 years in business', 'almost a year in business', 'less than 18 months in business',
    'under 1 year 6 months in business', 'third year in business', 'in business for 300 years', 'In business since last year',
    'In business a long time', 'Went into business a year ago', 'Not in business for 3 years yet', 'Established 2031']) {
    const r = leavesUnread(notes);
    assert.match(r.warnings.find((x) => x.code === 'years-in-business.notes').msg, /not read as a number of years/, notes);
  }
  // Two figures that disagree, on two lines or in one clause: each named.
  for (const [notes, lines] of [['In biz for 3+ years\nIn business for 6 years', ['In biz for 3+ years', 'In business for 6 years']],
    ['3 years in business and 4 years in business', ['3 years in business and 4 years in business']],
    ['a year in business\nIn business for 3 years', ['a year in business', 'In business for 3 years']],
    ['less than 1 year in business\nEstablished 2019', ['less than 1 year in business', 'Established 2019']]]) {
    const r = leavesUnread(notes, lines);
    assert.match(r.warnings.find((x) => x.code === 'years-in-business.notes').msg, /figures that disagree/, notes);
  }
  // A figure not read beside one read: the agent's, the one not read named.
  leavesUnread('In business for 3 years\nalmost 4 years in business', ['almost 4 years in business']);
  // In the claims box, named there.
  const claims = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'N/A', claims_details: 'No\nin business for several years', additional_notes: '' }, W44);
  assert.equal(claims.record.applicant.yearsInBusinessUnread, true);
  assert.match(claims.warnings.find((x) => x.code === 'years-in-business.notes').msg, /claims box says "in business for several years"/);
  assert.deepEqual(claims.readFrom, { 'applicant.yearsInBusiness': ['claims_details'] });
  // Years under own authority on the form: the notes still win for years in business (Q24), so the
  // agent's, not the authority years, which stay for the authority's own question.
  const authority = leavesUnread('in business for several years', undefined, { year_established: 'N/A', years_experience: '4' });
  assert.match(authority.warnings.find((x) => x.code === 'years-in-business.notes').msg, /years under own authority \(4\)/);
  assert.equal(buildPlan(authority.record, amwins).find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, 'MORE THAN 3 YEARS');
  // Counterexamples: notes silent about the business's years keep the blank standard, as before: no
  // notes, other subjects, "in the business" (a career in the trade), a bare duration, and "in
  // business" with no time.
  for (const notes of ['', 'Needs cargo', '10 years driving', 'CDL for 5 years', 'Driver experience: 3+ years in business',
    '18 months in business driving for Amazon', '20 years in the business', '3 Years', 'Started a year ago',
    'Owner operator, new in business', 'Insured 2-3 years']) {
    leavesYears(notes);
    assert.equal(noYears(notes).record.applicant.yearsInBusinessUnread, undefined, notes);
  }
  // Years under own authority and silent notes: AmWINS takes the authority years, as before.
  const silent = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: '4', claims_details: 'No', additional_notes: '10 years driving' }, W44);
  assert.equal(buildPlan(silent.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, '4');
  // A statement with no figure beside one read: the agent's too since round-7 answer 2 (its test, below).
});

// Round-7 answer 2 (TNI, 2026-10-27): a statement of years in business the reader doesn't take
// stops a figure it reads beside it, as two figures that disagree do: the agent's, with the check
// naming the lines. Before, "In business for 3 years" with "several years in business" read 3.
test('a statement not read beside a figure read leaves years in business to the agent (W44-09, round-7 answer 2)', () => {
  for (const [notes, lines] of [['In business for 3 years\nseveral years in business', ['In business for 3 years', 'several years in business']],
    ['a couple of years in business\nIn business for 5 years', ['a couple of years in business', 'In business for 5 years']],
    ['In business for 3 years. A few years in business', ['In business for 3 years', 'A few years in business']],
    ['Not in business for 3 years yet\nIn business for 2 years', ['Not in business for 3 years yet', 'In business for 2 years']],
    ['In business for 3 years\nalmost 4 years in business', ['In business for 3 years', 'almost 4 years in business']]]) {
    const r = leavesUnread(notes, lines);
    assert.match(r.warnings.find((x) => x.code === 'years-in-business.notes').msg, /not all read as a number of years/, notes);
  }
  // Across the two boxes: both named, and the answer points at both.
  const both = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: 'N/A', claims_details: 'No\nin business for 3 years', additional_notes: 'several years in business' }, W44);
  assert.equal(both.record.applicant.yearsInBusinessUnread, true);
  assert.match(both.warnings.find((x) => x.code === 'years-in-business.notes').msg, /the claims box and the Additional Notes box say "in business for 3 years" and "several years in business"/);
  assert.deepEqual(both.readFrom, { 'applicant.yearsInBusiness': ['claims_details', 'additional_notes'] });
  assert.equal(buildPlan(both.record, amwins).find((s) => s.selector === '#yrsInBusiness').value, null);
  // Counterexamples: a figure beside notes about something else, or agreeing figures, still reads.
  for (const notes of ['In business for 3 years\n10 years driving', 'In business for 3 years\nStarted a year ago', 'In business for 3 years\n20 years in the business',
    'In business for 3 years\nNeeds cargo', 'In business for 3 years\n3 years in business']) {
    readsOnly(notes, 3, 'In business for 3 years');
  }
});

// Round-7 answer 3 (TNI, 2026-10-27): "a year-old business" is 1 and "N-year-old business" is N, with
// the check saying how it was read. A vehicle's or a person's age stays out, as before.
test('"a year-old business" and "N-year-old business" read as 1 and N (W44-09, round-7 answer 3)', () => {
  for (const [notes, years, reading] of [['a year-old business', 1, 'a year-old'], ['A year old business', 1, 'A year old'],
    ['3-year-old business', 3, '3-year-old'], ['a 3-year-old business', 3, '3-year-old'], ['3 year old business', 3, '3 year old'],
    ['three-year-old business', 3, 'three-year-old'], ['5 yr old business', 5, '5 yr old'], ['We are a 10-year-old business', 10, '10-year-old'],
    ['twenty-five-year-old business', 25, 'twenty-five-year-old'], ['2.5-year-old business', 2, '2.5-year-old']]) {
    readsYears(notes, years, reading);
  }
  assert.deepEqual(plansYears('a year-old business'), ['1', 'derived', '1']);
  assert.deepEqual(plansYears('3-year-old business'), ['3', 'derived', '3-6']);
  // Agreeing is one answer; disagreeing is the agent's.
  assert.equal(noYears('a year-old business\nIn business for 1 year').record.applicant.yearsInBusiness, 1);
  leavesUnread('a 3-year-old business\nIn business for 5 years', ['a 3-year-old business', 'In business for 5 years']);
  // Not read, so the agent's: a qualifier, a range.
  for (const notes of ['almost a year-old business', '2-3 year old business']) leavesUnread(notes);
  // A vehicle's or a person's age stays out: silent, or only the business's age taken.
  for (const notes of ['Truck is 10 years old', 'Owns a year-old truck', '10-year-old business truck', 'a 5 year old trailer', 'Driver is 45 years old',
    'Owner is 40 years old']) leavesYears(notes);
  readsOnly('Truck is 10 years old, 3-year-old business', 3, '3-year-old business');
});

// The maintainer, 2026-10-27 (answer to PR #191's open question): a company, and up to two words between
// "old" and the business ("a 3-year-old trucking business"), read too; a vehicle word between stays out.
test('"a 3-year-old company" and "a 3-year-old trucking business" read as 3', () => {
  for (const [notes, years, reading] of [['a 3-year-old company', 3, '3-year-old'], ['a 3-year-old trucking business', 3, '3-year-old'],
    ['We are a five year old family trucking company', 5, 'five year old'], ['a year-old hauling biz', 1, 'a year-old']]) {
    readsYears(notes, years, reading);
  }
  for (const notes of ['almost a 3-year-old trucking company', 'almost a 3-year-old business']) leavesUnread(notes);
  for (const notes of ['10-year-old company truck', 'a 3-year-old truck business', 'Owns a 5 year old box truck company']) leavesYears(notes);
  // Glue or person words between "old" and the business are not a description of the business
  // (Claude review on #203): they must not become years in business.
  for (const notes of ['Equipment is 10 years old and company pays', 'The trailer is 8 years old with company logo',
    'Owner is 45 years old for company events', 'A van is 5 years old of company fleet']) leavesYears(notes);
});

// R12 (TNI, 2026-10-26: answer to PR question): "no" in the USDOT box with an MC number on the
// intake: GEICO's has-a-USDOT-number answers No too, as Progressive's already did. A 60-day Yes
// still decides (R13).
test('"no" in the USDOT box answers GEICO\'s USDOT question No also with an MC number (W44-15, R12)', () => {
  const intake = (fields) => normalizeIntake({ ...raw, mc_number: '7654321', mc_dot_60days: '', ...fields }, W44);
  const geicoStep = (r) => buildPlan(r.record, geico).find((s) => s.name === 'Has a USDOT number');
  const progressiveDot = (r) => buildPlan(r.record, progressive).find((s) => s.q === '1ED').value;
  for (const box of ['no', 'NO', 'No.']) {
    const r = intake({ dot_number: box });
    assert.equal(r.record.applicant.mc, '7654321', box);
    assert.equal(geicoStep(r).value, 'No', box);
    assert.equal(geicoStep(r).note, null, box);
    assert.deepEqual(geicoStep(r).from, ['applicant.noDot'], `${box}: read from the USDOT box`);
    assert.equal(progressiveDot(r), 'No - and the customer will not have a USDOT number', box);
  }
  // R13: the 60-day answer saying one is coming still decides (GEICO's agent, Progressive's Not Yet).
  const coming = intake({ dot_number: 'no', mc_dot_60days: 'Yes' });
  assert.equal(geicoStep(coming).value, 'Not yet, but the customer has applied for one.', '60-day Yes wins over the box\'s No (R13), also with an MC');
  assert.equal(progressiveDot(coming), 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days');
  // Counterexamples: a blank USDOT box with an MC number is still the agent's, also with the
  // 60-day No; a real USDOT number is Yes.
  for (const fields of [{ dot_number: '' }, { dot_number: '', mc_dot_60days: 'No' }]) {
    const r = intake(fields);
    assert.equal(geicoStep(r).value, null, JSON.stringify(fields));
    assert.match(geicoStep(r).note, /MC number but no USDOT number/, JSON.stringify(fields));
  }
  assert.equal(geicoStep(intake({ dot_number: '1234567' })).value, 'Yes');
});

// R14 (TNI, 2026-10-26: answer to PR question): "None" or "N/A" in the USDOT or MC box, in any
// case, with or without a dot or slash, is an explicit No, exactly like "no".
test('"None" or "N/A" in the USDOT or MC box is an explicit No (W44-15, R14)', () => {
  const intake = (fields) => normalizeIntake({ ...raw, mc_number: '', mc_dot_60days: '', ...fields }, W44);
  const progressiveDot = (r) => buildPlan(r.record, progressive).find((s) => s.q === '1ED').value;
  const geicoDot = (r) => buildPlan(r.record, geico).find((s) => s.name === 'Has a USDOT number').value;
  const amwinsStep = (r, sel) => buildPlan(r.record, amwins).find((s) => s.selector === sel).value;
  const boxes = ['None', 'none', 'NONE.', 'N/A', 'n/a', 'NA', 'N.A.', 'n.a', 'N/A.'];
  for (const box of boxes) {
    const r = intake({ dot_number: box });
    assert.equal(r.record.applicant.dot, null, box);
    assert.equal(r.record.applicant.noDot, true, box);
    assert.ok(!r.warnings.some((x) => x.code === 'id.invalid'), box);
    const w = r.warnings.find((x) => x.code === 'dot.none');
    assert.equal(w?.level, 'info', box);
    assert.ok(w.msg.includes(`"${box}"`), `${box}: the note quotes the box`);
    assert.equal(progressiveDot(r), 'No - and the customer will not have a USDOT number', box);
    assert.equal(geicoDot(r), 'No', box);
    assert.equal(amwinsStep(r, '#hasDotNumber'), false, box);
    // With an MC number too (R12).
    assert.equal(geicoDot(intake({ dot_number: box, mc_number: '7654321' })), 'No', `${box} with an MC number`);
  }
  for (const box of boxes) {
    const mc = intake({ mc_number: box });
    assert.equal(mc.record.applicant.mc, null, box);
    assert.equal(mc.record.applicant.noMc, true, box);
    assert.ok(!mc.warnings.some((x) => x.code === 'id.invalid'), box);
    assert.ok(mc.warnings.find((x) => x.code === 'mc.none')?.msg.includes(`"${box}"`), box);
    assert.equal(amwinsStep(mc, '#hasMcNumber'), false, box);
  }
  // Counterexamples: a real number is unaffected, a blank box is not a No, a cut-off "N/" stays as
  // it is (W44-08, not decided), and other words are still not a number.
  const number = intake({ dot_number: 'USDOT 1234567', mc_number: 'MC 7654321' });
  assert.deepEqual([number.record.applicant.dot, number.record.applicant.noDot, number.record.applicant.mc, number.record.applicant.noMc], ['1234567', null, '7654321', null]);
  assert.equal(progressiveDot(number), 'Yes - the customer has a USDOT number');
  const blank = intake({ dot_number: '' });
  assert.deepEqual([blank.record.applicant.noDot, progressiveDot(blank), geicoDot(blank)], [null, null, null]);
  const cut = intake({ dot_number: 'N/' });
  assert.equal(cut.record.applicant.noDot, null);
  assert.ok(cut.warnings.some((x) => x.code === 'id.invalid'), '"N/" as before');
  for (const box of ['none yet', 'Nan', 'N/A pending']) {
    const other = intake({ dot_number: box });
    assert.equal(other.record.applicant.noDot, null, box);
    assert.ok(other.warnings.some((x) => x.code === 'id.invalid'), box);
  }
});

// R15 (TNI, 2026-10-26: answer to PR question): "New", "New authority", "Brand new" and "New
// venture" as the whole answer in years under own authority are 0 years, as "NEW" is.
test('"New authority", "Brand new" and "New venture" in years under own authority are 0 years (W44-15, R15)', () => {
  for (const box of ['New authority', 'NEW AUTHORITY.', 'Brand new', 'brand new.', 'New venture', 'NEW VENTURE', 'New']) {
    const r = normalizeIntake({ ...raw, year_established: 'N/A', years_experience: box, claims_details: 'No', additional_notes: '' }, W44);
    assert.equal(r.record.applicant.yearsExperience, 0, box);
    assert.ok(!r.warnings.some((x) => x.code === 'years-experience.invalid'), box);
    assert.ok(r.warnings.find((x) => x.code === 'years-experience.new')?.msg.includes(`"${box.trim()}"`), box);
    assert.equal(buildPlan(r.record, amwins).find((s) => s.selector === '#howLongFederalOperatingAuthorityActive').value, 'LESS THAN 1 YEAR', box);
  }
  // Counterexamples: "new" in a longer answer or a sentence is not 0.
  for (const box of ['new trucks', 'Brand new trucks', 'New authority pending', 'new venture soon', 'Not new']) {
    const r = normalizeIntake({ ...raw, years_experience: box }, W44);
    assert.equal(r.record.applicant.yearsExperience, null, box);
    assert.ok(r.warnings.some((x) => x.code === 'years-experience.invalid'), box);
    assert.ok(!r.warnings.some((x) => x.code === 'years-experience.new'), box);
  }
});

// W44-32 (TNI, 2026-10-26: "CLEAN" claims = none): CLEAN as the claims box's answer is an explicit
// No for claims and losses, for every carrier, as "Clean record" already counted for Progressive.
test('"CLEAN" as the claims box\'s answer is no claims; "clean" in a sentence is not (W44-32)', () => {
  const claims = (box, notes = '') => normalizeIntake({ ...raw, claims_details: box, additional_notes: notes }, W44).record;
  for (const box of ['CLEAN ', 'Clean.', 'clean record', 'Clean MVR', 'Clean driving record', 'all clean \r']) {
    assert.equal(claims(box).claims.hasClaims, false, box);
    assert.equal(claims(box).claims.notes, null, box);
  }
  const more = claims('CLEAN\nFinanced');
  assert.equal(more.claims.hasClaims, false);
  assert.equal(more.claims.notes, 'Financed', 'the other lines stay notes');
  assert.equal(more.operations.vehicleOwnership, 'Financed');
  for (const box of ['Clean-up company', 'Clean record except 1 speeding ticket', 'Accident 2024, otherwise clean', 'Cleaning supplies\nNo', 'Clean up']) {
    assert.equal(claims(box).claims.hasClaims, null, box);
  }
  assert.equal(claims('', 'CLEAN').claims.hasClaims, null, 'only the claims box answers the claims question');
  // Every carrier that asks it: AmWINS prior loss No (was the agent's), Progressive's driver
  // question from the intake (was its standard No). GEICO maps no claims question.
  const r = claims('CLEAN');
  const loss = buildPlan(r, amwins).find((s) => s.name === 'Any prior loss');
  assert.equal(loss.value, false);
  assert.equal(loss.note, null);
  const driver = buildPlan(r, progressive).find((s) => s.q === '28F5');
  assert.equal(driver.value, false);
  assert.equal(driver.source, 'intake');
});

// W44-15: "no" in the FEIN box is no FEIN, as "N/A" is, not a malformed number.
test('"no" in the FEIN box is no FEIN (W44-15)', () => {
  for (const box of ['no', 'NO', 'No.']) {
    const r = normalizeIntake({ ...raw, fein: box }, W44);
    assert.equal(r.record.applicant.fein, null, box);
    assert.ok(!r.warnings.some((w) => w.code === 'fein.invalid'), box);
  }
  assert.equal(normalizeIntake({ ...raw, fein: '12-345' }, W44).warnings.find((w) => w.code === 'fein.invalid')?.level, 'check', 'a short number is still checked');
  assert.equal(normalizeIntake({ ...raw, fein: '12-3456789' }, W44).record.applicant.fein, '12-3456789');
});
