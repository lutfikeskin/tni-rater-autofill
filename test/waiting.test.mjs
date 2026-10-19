// The panel's "Waiting to click" card: helper buttons by their names on the page and what they
// wait for in the agent's words, never an action id or a record path (SC live run, 2026-10-19:
// "Buttons waiting lookupVin (waiting for vehicles[1].vin)", which the agent didn't want to see).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { waitingText, helperName } from '../src/waiting.js';

const record = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: null, mc: null },
  garaging: { state: 'SC', zip: '29000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited' },
  drivers: [{ first: 'Amina', last: 'Kone' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345' }, { type: 'Van', year: 2019, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA54321' }],
  trailers: [],
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000 },
  claims: { hasClaims: false },
});

test('a waiting helper is named as on the page, with what it waits for in plain words', () => {
  const plan = buildPlan(record(), progressive, { vehicles: 1 });
  const said = [
    waitingText({ id: 'lookupVin:1', why: 'waiting for vehicles[1].vin', waits: [{ path: 'vehicles[1].vin' }] }, plan),
    waitingText({ id: 'billPlan', why: 'waiting for doneCargo clicked', waits: [{ action: 'doneCargo' }] }, plan),
    waitingText({ id: 'recalculate', why: 'waiting for billPlan clicked, ChangePaymentPlan visited', waits: [{ action: 'billPlan' }, { pages: ['ChangePaymentPlan'] }] }, plan),
    waitingText({ id: 'print', why: 'Email or Fax is ticked; untick it to print' }, plan),
    waitingText({ id: 'billPlan', why: 'waiting for Bodily Injury answered', waits: [{ say: 'Bodily Injury answered' }] }, plan),
  ];
  assert.deepEqual(said, [
    'Look up VIN: waiting for VIN',
    'Bill plan options: waiting for Done with this coverage to be clicked',
    'Recalculate: waiting for Bill plan options to be clicked, the Change Payment Plan page',
    'Print, Email, Fax: Email or Fax is ticked; untick it to print',
    'Bill plan options: waiting for Bodily Injury answered',
  ]);
  for (const text of said) assert.doesNotMatch(text, /lookupVin|billPlan|doneCargo|vehicles\[|ChangePaymentPlan/, text);
});

test('every helper of every carrier has a name the panel can show', () => {
  for (const carrier of [progressive, amwins]) {
    for (const a of carrier.actions) assert.ok(a.button || a.label, `${carrier.id} ${a.id}: button or label`);
  }
  assert.equal(helperName([], 'unknownHelper:2'), 'A button on this page');
});
