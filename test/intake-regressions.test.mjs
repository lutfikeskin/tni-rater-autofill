import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { priorPolicyExpired, sameCarrier } from '../src/util.js';

const record = () => ({
  applicant: { name: 'Sample Test LLC', owner1: 'Alex Example', applicationDate: '10/02/2026' },
  operations: { businessClass: 'Expediter' }, garaging: {}, coverage: {}, claims: {}, trailers: [],
  drivers: [{ first: 'Alex', last: 'Example', licenseNumber: 'SYNTHETIC-ONE' },
    { first: 'Jamie', last: 'Example', licenseNumber: 'SYNTHETIC-TWO' }],
  vehicles: [{ value: 34000 }, { value: 36000 }],
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Progressive', limit: '$1M CSL', expiration: '09/01/2026' }],
});

test('expired policy is not currently insured; proof availability is independent', () => {
  const r = record();
  assert.equal(priorPolicyExpired(r), true);
  assert.equal(buildPlan(r, progressive).find(s => s.q === '198').value, false);
  assert.equal(buildPlan(r, progressive).find(s => s.q === '81').value, false);
  const disclosure = () => buildPlan(r, amwins).find(s => s.re === '^disclosure details$').value;
  assert.match(disclosure(), /EXPIRED/);
  r.priorInsurance[0].expiration = '12/01/2026';
  r.claims.notes = 'POP document unavailable';
  assert.equal(buildPlan(r, progressive).find(s => s.q === '198').value, true);
  assert.match(disclosure(), /POP document unavailable/);
  assert.doesNotMatch(disclosure(), /EXPIRED/);
  r.priorInsurance[0].expiration = '02/31/2026';
  assert.equal(priorPolicyExpired(r), false);
});

// Audit 2026-10-08: AmWINS imports owner() from the Progressive rules, so a borrowed identity
// reached both carriers. A non-driving owner keeps the owner box's name and no date of birth.
test('an owner who shares a surname with a driver keeps their own identity on both carriers', () => {
  const r = record();
  r.applicant.owner1 = 'Alice Example';
  r.applicant.ownerDrives = false;
  r.drivers = [{ first: 'Bob', last: 'Example', dob: '01/02/1990', licenseNumber: 'SYNTHETIC-ONE' }];
  const progressivePlan = buildPlan(r, progressive);
  assert.equal(progressivePlan.find((s) => s.q === '295').value, 'Alice');
  assert.equal(progressivePlan.find((s) => s.q === '2BB').value, null);
  const amwinsPlan = buildPlan(r, amwins);
  assert.equal(amwinsPlan.find((s) => s.selector === '#ownerName').value, 'Alice Example');
  assert.equal(amwinsPlan.find((s) => s.selector === '#ownerDob').value, null);
  assert.equal(amwinsPlan.find((s) => s.selector === '#inspectionContactName').value, 'Alice Example');
  r.applicant.ownerDrives = true;
  r.drivers.push({ first: 'Alice', last: 'Example', dob: '03/04/1985', licenseNumber: 'SYNTHETIC-TWO' });
  assert.equal(buildPlan(r, amwins).find((s) => s.selector === '#ownerDob').value, '03/04/1985', 'the driver with the same full name');
  assert.equal(buildPlan(r, progressive).find((s) => s.q === '2BB').value, '03/04/1985');
});

test('AmWINS maps each repeated row independently and adds only missing driver rows', () => {
  const plan = buildPlan(record(), amwins, { drivers: 1, vehicles: 1 });
  const firstNames = plan.filter(s => s.selector?.includes('firstName'));
  assert.deepEqual(firstNames.map(s => s.value), ['Alex', 'Jamie']);
  assert.match(firstNames[0].selector, /data-id="0"/);
  assert.match(firstNames[1].selector, /data-id="1"/);
  const values = plan.filter(s => s.selector?.includes('costNew'));
  assert.deepEqual(values.map(s => s.value), [34000, 36000]);
  const actions = plan.filter(s => s.baseAction?.startsWith('addDriver'));
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].after, []);
  // The previous row being filled is enough: a driver without a license number can't block later rows.
  assert.deepEqual(actions[0].afterAny, ['drivers[0].first', 'drivers[0].last', 'drivers[0].dob', 'drivers[0].licenseNumber']);
  assert.match(actions[0].unlessSelector, /data-id="1"/);
});

// The intake's current carrier names the carrier being quoted (TNI, 2026-10-26, W44-27, W44-06):
// GEICO and Progressive, spelling variants and suffixes included; another insurer with a similar
// name never. AmWINS, a wholesaler, is never the intake's current carrier.
test('sameCarrier: a carrier\'s name, misspelled or with a suffix, and never another insurer', () => {
  const yes = {
    geico: ['GEICO', 'Geico', 'Geico Commercial', 'GEICO Ins.', 'GICO', 'Gieco', 'Geico Indemnity Co', 'GEICO/Berkshire', 'Government Employees Insurance Company'],
    progressive: ['Progressive', 'PROGRESSIVE COMMERCIAL', 'Progresive', 'Progessive', 'Porgressive', 'Progressive Casualty Ins Co', 'Progressive Express', 'progressive commercial auto'],
  };
  const no = {
    geico: ['Gainsco', 'Gateway', 'GAIC', 'Great West Casualty', 'Gecko Mutual', 'Progressive', 'Other Mutual', 'Employees Mutual', 'None', 'N/A', '', null, undefined],
    progressive: ['Protective', 'Protective Insurance', 'Professional Ins', 'Prime Insurance', 'Preferred', 'Progress Mutual', 'Aggressive', 'GEICO', 'Other Mutual', 'No', '', null],
  };
  for (const [carrier, names] of Object.entries(yes)) for (const name of names) assert.equal(sameCarrier(name, carrier), true, `${name} is ${carrier}`);
  for (const [carrier, names] of Object.entries(no)) for (const name of names) assert.equal(sameCarrier(name, carrier), false, `${name} isn't ${carrier}`);
  // A carrier with no names to match (AmWINS, the local test page, an unknown id): never.
  for (const carrier of ['amwins', 'test', 'nobody', 'toString', null]) assert.equal(sameCarrier('AmWINS', carrier), false, String(carrier));
});

test('Progressive: a misspelled Progressive commercial auto policy is currently insured with Progressive', () => {
  const insured = (carrier) => {
    const r = record();
    r.priorInsurance[0].carrier = carrier;
    r.priorInsurance[0].expiration = '12/01/2026';
    return buildPlan(r, progressive).find((s) => s.q === '198').value;
  };
  for (const name of ['Progressive', 'Progresive', 'Progressive Commercial', 'PROGESSIVE']) assert.equal(insured(name), true, name);
  for (const name of ['Protective', 'GEICO', 'Other Mutual']) assert.equal(insured(name), false, name);
});

// TNI, 2026-10-26: answer to PR question 9 (#189, #194): a commercial auto policy with Progressive
// itself is "currently insured with Progressive Commercial Auto" also without a usable expiration
// date or a limit, as W44-29 reads proof of prior insurance (any box filled, no date already
// passed). TNI's answer, so a standard; with a limit and a date it stays derived. Expired stays No.
test('Progressive: an undated Progressive commercial auto policy is currently insured with Progressive (TNI, 2026-10-26)', () => {
  const step = (more) => {
    const r = record();
    Object.assign(r.priorInsurance[0], { expiration: '12/01/2026', ...more });
    return buildPlan(r, progressive).find((s) => s.q === '198');
  };
  for (const more of [{ expiration: null }, { expiration: 'see notes' }, { limit: null }, { limit: null, expiration: null }, { carrier: 'Progresive', expiration: null }]) {
    assert.deepEqual([step(more).value, step(more).source], [true, 'standard'], JSON.stringify(more));
  }
  assert.deepEqual([step({}).value, step({}).source], [true, 'derived'], 'a limit and a date: derived, as before');
  // Unchanged, No: expired, a personal auto policy, another insurer, and no prior insurance ("No
  // Progressive" without a date). A policy of no type is the agent's since R9 (next test).
  for (const more of [{ expiration: '09/01/2026' }, { type: 'Personal Auto', expiration: null }, { carrier: 'Protective', expiration: null },
    { carrier: 'No Progressive', expiration: null }]) {
    assert.deepEqual([step(more).value, step(more).source], [false, 'derived'], JSON.stringify(more));
  }
});

// TNI, 2026-10-26: answer to PR question R9 (#189): a policy with Progressive itself whose policy type
// is left blank is the agent's (a `fact`, never filled), with a note that the type isn't on the
// intake, dated, undated or expired: Progressive no longer answers No. A commercial auto policy with
// Progressive keeps its Yes; personal auto and another insurer keep No.
test('Progressive: a Progressive policy of no type is the agent\'s (TNI, 2026-10-26, R9)', () => {
  const step = (more) => {
    const r = record();
    Object.assign(r.priorInsurance[0], { type: null, expiration: '12/01/2026', ...more });
    return buildPlan(r, progressive).find((s) => s.q === '198');
  };
  for (const more of [{}, { type: '' }, { type: '  ' }, { carrier: 'Progresive' }, { expiration: null }, { limit: null, expiration: 'see notes' }, { expiration: '09/01/2026' }]) {
    const s = step(more);
    assert.deepEqual([s.value, s.source, s.manualOnly], [null, 'fact', true], JSON.stringify(more));
    assert.match(s.note, /policy type isn't on the intake/, JSON.stringify(more));
  }
  // Counterexamples: commercial auto with Progressive keeps Yes; personal auto, another insurer (of
  // no type too) and no prior insurance ("No Progressive" without a date) keep No.
  assert.deepEqual([step({ type: 'Commercial Auto' }).value, step({ type: 'Commercial Auto' }).source], [true, 'derived']);
  assert.deepEqual([step({ type: 'Commercial Auto', expiration: null }).value, step({ type: 'Commercial Auto', expiration: null }).source], [true, 'standard']);
  for (const more of [{ type: 'Personal Auto' }, { type: 'Commercial Auto', carrier: 'Protective' }, { carrier: 'Protective' }, { carrier: 'GEICO' },
    { carrier: 'No Progressive', limit: null, expiration: null }]) {
    const s = step(more);
    assert.deepEqual([s.value, s.source, s.note], [false, 'derived', null], JSON.stringify(more));
  }
});
