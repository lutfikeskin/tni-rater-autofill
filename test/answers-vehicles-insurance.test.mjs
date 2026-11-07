// TNI's carrier-neutral decisions (src/answers/): the answer, null when the intake doesn't settle
// it, and the agent's note then. Progressive's wording of them is tested in progressive.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentModel, financing, vehicleFinancing, vehicleFinancingNote, trailerFinancing, trailerFinancingNote } from '../src/answers/vehicles.js';
import { currentlyInsured, currentlyInsuredSource, priorLimit, priorBoxNote } from '../src/answers/insurance.js';

test('a vehicle of this model year or later is recent; an older or yearless one is not', () => {
  const year = new Date().getFullYear();
  const r = { vehicles: [{ year: String(year) }, { year: String(year - 1) }, {}] };
  assert.equal(recentModel(r, { vehicles: 0 }), r.vehicles[0]);
  assert.equal(recentModel(r, {}), r.vehicles[0], 'the first vehicle without an active one');
  assert.equal(recentModel(r, { vehicles: 1 }), null);
  assert.equal(recentModel(r, { vehicles: 2 }), null);
});

test('loan / lease from the ownership answer: no answer, or another one, is the agent\'s', () => {
  assert.equal(financing('Financed'), 'loan');
  assert.equal(financing('loan'), 'loan');
  assert.equal(financing(' Leased '), 'lease');
  assert.equal(financing('Owned'), 'owned');
  assert.equal(financing('Rented'), null);
  assert.equal(financing(''), null);
  assert.equal(financing(undefined), null);
  assert.equal(vehicleFinancing({ operations: { vehicleOwnership: 'Leased' } }), 'lease');
  assert.equal(vehicleFinancingNote({ operations: { vehicleOwnership: 'Leased' } }), null);
  assert.match(vehicleFinancingNote({ operations: { vehicleOwnership: 'Rented' } }), /vehicle ownership "Rented" isn't owned, financed or leased/);
  assert.match(vehicleFinancingNote({}), /no vehicle ownership answer/);
  assert.equal(trailerFinancing({ trailerInfo: { ownership: 'Owned' } }), 'owned');
  assert.match(trailerFinancingNote({ trailerInfo: {} }), /no trailer ownership answer/);
});

test('currently insured: derived with a limit and a date, TNI\'s standard on any box filled, No when expired', () => {
  const dated = { loadedOn: '10/01/2026', applicant: { applicationDate: '10/01/2026' }, priorInsurance: [{ type: 'Commercial Auto', carrier: 'Acme', limit: '1,000,000', expiration: '12/01/2026' }] };
  assert.equal(currentlyInsured(dated), true);
  assert.equal(currentlyInsuredSource(dated), 'derived');
  const undated = { loadedOn: '10/01/2026', applicant: { applicationDate: '10/01/2026' }, priorInsurance: [{ type: 'Commercial Auto', carrier: 'Acme', limit: '1,000,000', expiration: '' }] };
  assert.equal(currentlyInsured(undated), true);
  assert.equal(currentlyInsuredSource(undated), 'standard');
  assert.match(priorBoxNote(undated, 'expiration'), /no expiration date/);
  const expired = { loadedOn: '10/01/2026', applicant: { applicationDate: '10/01/2026' }, priorInsurance: [{ type: 'Commercial Auto', carrier: 'Acme', limit: '1,000,000', expiration: '01/01/2026' }] };
  assert.equal(currentlyInsured(expired), false);
  assert.equal(currentlyInsuredSource(expired), 'derived');
  assert.equal(priorBoxNote(expired, 'limit'), null, 'not asked when not currently insured');
  assert.equal(currentlyInsured({ priorInsurance: [] }), false);
});

test('the current limit, unless it is the form\'s "Other", which is the agent\'s', () => {
  const r = (limit) => ({ loadedOn: '10/01/2026', applicant: { applicationDate: '10/01/2026' }, priorInsurance: [{ type: 'Commercial Auto', limit, expiration: '12/01/2026' }] });
  assert.equal(priorLimit(r(' 1,000,000 ')), '1,000,000');
  assert.equal(priorLimit(r('Other')), null);
  assert.match(priorBoxNote(r('other'), 'limit'), /"Other", with no amount/);
  assert.equal(priorLimit(r('')), null);
  assert.match(priorBoxNote(r(''), 'limit'), /has no limit/);
  assert.equal(priorBoxNote(r('1,000,000'), 'limit'), null);
});
