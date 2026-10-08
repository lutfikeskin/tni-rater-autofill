import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssistError,
  LEAVE,
  assistContextKey,
  collectItems,
  evidenceFor,
  manualOnlyReason,
  neverReason,
  scopedIntake,
} from '../src/ai/common.js';

// These records are synthetic. The two entity rows make sure common context
// helpers keep only the active driver and vehicle.
const record = {
  applicant: {
    name: 'Synthetic Hauler LLC',
    dot: 'DOT-SYNTHETIC',
    mc: 'MC-SYNTHETIC',
    phone: '555-0100',
    fein: '99-0000000',
  },
  operations: { businessClass: 'Expediter', radius: 600 },
  garaging: { street: '12 Synthetic Way', city: 'Sampleton', state: 'TX', zip: '75001' },
  coverage: { reeferBreakdown: false },
  claims: { text: 'Zorvald Quenby had a minor accident in Sampleton. Wants NTL.', hasClaims: true },
  drivers: [
    { first: 'Firstly', last: 'Driverson', dob: '01/01/1980', phone: '555-0101' },
    { first: 'Zorvald', last: 'Quenby', dob: '02/02/1982', licenseState: 'TX', cdl: true, phone: '555-0102' },
  ],
  vehicles: [
    { type: 'Cargo Van', vin: 'SYNTHETIC-VIN-0', value: 20000 },
    { type: 'Truck Tractor', year: 2019, vin: 'SYNTHETIC-VIN-1', value: 40000 },
  ],
  trailers: [{ type: 'Dry Van' }],
  extraPrivateValue: 'must not be sent',
};

const context = {
  record,
  carrier: 'progressive',
  page: 'BusinessOwnerInfo',
  active: { drivers: 1, vehicles: 1, trailers: 0 },
};

function item(key, label = 'Synthetic question', options = ['Yes', 'No'], extra = {}) {
  return { key, q: key, label, controlKind: 'radio', options, ...extra };
}

test('context keys include the intake and active rows', () => {
  const key = assistContextKey(record, context.active);
  assert.equal(key, assistContextKey(structuredClone(record), { ...context.active }));
  assert.notEqual(key, assistContextKey(record, { ...context.active, vehicles: 0 }));
  assert.notEqual(key, assistContextKey({ ...record, coverage: { reeferBreakdown: true } }, context.active));
});

test('payment and billing choices stay agent-owned while Medical Payments coverage remains eligible', () => {
  for (const label of ['Automatic payments from checking account', 'Payment plan', 'Billing method', 'ACH debit', 'Pay in full']) {
    assert.ok(neverReason(item('pay', label)), label);
    assert.equal(collectItems([{ unknown: [item('pay', label)] }]).items.length, 0);
  }
  assert.equal(neverReason(item('med', 'Medical Payments coverage')), null);
});

test('collectItems sends only bounded choices and blocks unsafe or unsupported fields', () => {
  const frames = [{
    failed: [
      item('choice', 'Hauls goods for others?'),
      item('duplicate', 'Duplicated question'),
    ],
    unknown: [
      item('duplicate', 'Duplicated question'),
      { key: 'typed', label: 'VIN', controlKind: 'text', options: [] },
      { key: 'mvr', label: 'Order the MVR report?', controlKind: 'radio', options: ['Yes', 'No'] },
      { key: 'exclusions', label: 'Driver exclusions?', controlKind: 'radio', options: ['Yes', 'No'] },
      { key: 'excluding', label: 'Are any drivers being excluded?', controlKind: 'radio', options: ['Yes', 'No'] },
      { key: 'lookup', label: 'Does this DOT belong to the business?', controlKind: 'radio', options: ['Yes', 'No'], reviewOnly: true },
      { key: 'empty', label: 'Business type', controlKind: 'select', options: [] },
      { key: 'too-many', label: 'Synthetic long list', controlKind: 'select', options: Array.from({ length: 255 }, (_, i) => `Option ${i}`) },
    ],
    noData: [{ key: 'check', label: 'Synthetic checkbox', controlKind: 'checkbox' }],
  }];

  const { items, blocked } = collectItems(frames);
  assert.deepEqual(items.map(x => x.key), ['choice', 'duplicate', 'check']);
  assert.deepEqual(items.find(x => x.key === 'check').options, ['checked', 'unchecked']);
  assert.deepEqual(blocked.map(x => x.key).sort(), ['empty', 'excluding', 'exclusions', 'lookup', 'mvr', 'too-many', 'typed']);
  assert.match(blocked.find(x => x.key === 'lookup').why, /review/i);
  assert.match(blocked.find(x => x.key === 'typed').why, /identifier/i);
  assert.match(blocked.find(x => x.key === 'too-many').why, /choices/i);
  assert.ok(neverReason({ section: 'Reports', label: 'Order CLUE report?' }));
  assert.ok(neverReason({ section: 'Reports', label: 'Driver exclusions?', controlKind: 'radio' }));
  assert.ok(neverReason({ section: 'Reports', label: 'Are any drivers being excluded?', controlKind: 'radio' }));
  assert.equal(neverReason({ section: 'Business', label: 'Has a USDOT number?', controlKind: 'radio' }), null);
});

test('scoped intake strips identifiers, keeps explicit No, and includes only carrier rules', () => {
  const facts = scopedIntake(record, context.active);
  assert.equal(facts.coverage.reeferBreakdown, false);
  assert.equal(facts.coverage.missingFact, undefined);
  assert.ok(facts['drivers[1]']);
  assert.ok(facts['vehicles[1]']);
  assert.equal(facts['drivers[0]'], undefined);
  assert.equal(facts['vehicles[0]'], undefined);
  assert.equal(facts.applicant.hasDOT, true);
  assert.equal(facts.applicant.hasMC, true);
  assert.equal(facts.applicant.phone, undefined);
  assert.equal(facts.applicant.fein, undefined);
  assert.equal(facts['vehicles[1]'].vin, undefined);
  assert.equal(facts.extraPrivateValue, undefined);

  // Audit 2026-10-08: the same redaction as the claims-box review, on every string the model sees.
  assert.equal(facts.applicant.name, '[client]', 'the business name');
  assert.deepEqual([facts['drivers[1]'].first, facts['drivers[1]'].last, facts['drivers[1]'].dob], ['[client]', '[client]', '[client]']);
  assert.deepEqual([facts.garaging.street, facts.garaging.city, facts.garaging.zip, facts.garaging.state], ['[client]', '[client]', '[client]', 'TX']);
  assert.equal(facts.claims.text, '[client] [client] had a minor accident in [client]. Wants NTL.');
  assert.deepEqual([facts.claims.hasClaims, facts['drivers[1]'].cdl, facts['drivers[1]'].licenseState], [true, true, 'TX'], 'booleans and the license state stay');
  assert.deepEqual([facts['vehicles[1]'].year, facts['vehicles[1]'].value, facts.operations.radius], [2019, 40000, 600], 'numbers stay numbers');
  assert.equal(facts.operations.businessClass, 'Expediter');
  const wire = JSON.stringify(evidenceFor(context));
  for (const term of ['Synthetic Hauler', 'Zorvald', 'Quenby', '02/02/1982', '75001', 'Sampleton', '12 Synthetic Way']) {
    assert.equal(wire.includes(term), false, `${term} must not reach the model`);
  }
  assert.ok(Object.values(evidenceFor(context).sources).some(x => x.path === 'claims.text' && x.value.includes('[client]')), 'redacted notes are still evidence');

  const progressiveRules = Object.values(evidenceFor(context).sources)
    .filter(x => x.basis === 'tni_rule').map(x => x.rule);
  assert.ok(progressiveRules.some(rule => /vehicle tile/i.test(rule)));
  assert.ok(progressiveRules.every(rule => !/AmWINS lists|Commercial Lines dashboard/i.test(rule)));

  const amwins = evidenceFor({ ...context, carrier: 'amwins' });
  const amwinsRules = Object.values(amwins.sources)
    .filter(x => x.basis === 'tni_rule').map(x => x.rule);
  assert.ok(amwinsRules.some(rule => /Commercial Lines dashboard/i.test(rule)));
  assert.ok(amwinsRules.every(rule => !/vehicle tile/i.test(rule)));
  assert.ok(Object.values(amwins.sources).some(x => x.path === 'coverage.reeferBreakdown' && x.value === false));
  assert.equal(Object.values(amwins.sources).some(x => x.path === 'coverage.missingFact'), false);
});

test('manual-only metadata and labels stay agent-owned', () => {
  for (const metadata of [
    { manualOnly: true }, { reviewOnly: true }, { fieldType: 'number' }, { fieldType: 'numeric' },
    { fieldType: 'date' }, { fieldType: 'limit' }, { fieldType: 'identity' }, { fieldType: 'identifier' },
    { valueType: 'date' }, { semanticType: 'identity' }, { label: 'Annual distance' },
    { label: 'Liability CSL' }, { label: 'Does VIN belong to this vehicle?' },
  ]) {
    assert.match(manualOnlyReason({ label: 'Synthetic bounded field', ...metadata }) ?? '', /review|manual|require/i, JSON.stringify(metadata));
  }
  assert.equal(manualOnlyReason(item('ok', 'Synthetic bounded field')), null);
});

test('common errors remain typed for callers', () => {
  assert.equal(typeof AssistError, 'function');
  assert.equal(typeof LEAVE, 'string');
});
