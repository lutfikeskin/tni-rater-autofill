import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, parseAddress, parseLicense, toMoney, toDate, vinProblem, parseLimitDeductible, parseRadius, isLongHaul, ownershipFromNotes, rederive, ntlWithCargo } from '../src/normalize.js';
import { buildPlan, redactionTerms } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { noPriorInsurance } from '../src/util.js';
import { progressive, owner } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';

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
  assert.deepEqual(actions.map((a) => a.action), ['verifyDot', 'addVehicle:0', 'addDriver:0', 'businessTypeSearch', 'vehicleTile:0', 'lookupVin:0', 'ntlStillAdded', 'openCargo', 'addCargoCommodity', 'doneCargo', 'recalculate', 'billPlan', 'recalculateAgain', 'print']);
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
  const listed = normalizeIntake(people, { today: new Date('2026-09-30') });
  assert.ok(!listed.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'same person across the name boxes');
  const lastOnly = normalizeIntake({ ...people, owner_name_1: 'SAMPLE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(!lastOnly.warnings.some((w) => w.code === 'drivers.owner-not-listed'), "owner's surname is one of the driver's last-name words");
  const other = normalizeIntake({ ...people, owner_name_1: 'SOMEONE ELSE' }, { today: new Date('2026-09-30') });
  assert.ok(other.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'a different person still warns');
  const sharedWord = normalizeIntake({ ...people, owner_name_1: 'ALICE EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(sharedWord.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'a surname word with another first name still warns');
  // Audit 2026-10-08: a one-word surname alone linked another person ("Alice Sample" to "Bob Sample").
  const family = normalizeIntake({ ...people, owner_name_1: 'ALICE EXAMPLO', drv_first_1: 'BOB', drv_last_1: 'EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(family.warnings.some((w) => w.code === 'drivers.owner-not-listed'), 'the same one-word surname with another first name is another person');
  const same = normalizeIntake({ ...people, owner_name_1: 'BOB EXAMPLO', drv_first_1: 'BOB', drv_last_1: 'EXAMPLO' }, { today: new Date('2026-09-30') });
  assert.ok(!same.warnings.some((w) => w.code === 'drivers.owner-not-listed'));
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
