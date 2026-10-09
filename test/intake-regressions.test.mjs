import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { priorPolicyExpired } from '../src/util.js';

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
