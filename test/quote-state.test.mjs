import test from 'node:test';
import assert from 'node:assert/strict';
import { stateCode, quoteStatePick, stateMismatch } from '../src/quote-state.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';

// 2026-10-08: a Florida intake on a Progressive quote started in Utah; nothing said so until the
// Florida ZIP was refused on Add Vehicle.
test('quote state: the state picked on the carrier page, by code or name, against the intake', () => {
  assert.equal(stateCode('Utah'), 'UT');
  assert.equal(stateCode(' new  york '), 'NY');
  assert.equal(stateCode('fl'), 'FL');
  assert.equal(stateCode('Select a state'), null);
  assert.equal(stateCode(''), null);
  // Progressive's home page and AmWINS' start page; no other page or control.
  assert.equal(quoteStatePick(progressive, '/home/', { key: 'QuoteStateList', after: 'Utah' }), 'UT');
  assert.equal(quoteStatePick(progressive, '/home/', { key: 'QuoteStateList', after: '' }), null, 'back to the placeholder');
  assert.equal(quoteStatePick(progressive, 'BusinessOwnerInfo', { key: 'QuoteStateList', after: 'Utah' }), undefined);
  assert.equal(quoteStatePick(progressive, '/home/', { key: 'ZipCode', after: '84101' }), undefined);
  assert.equal(quoteStatePick(amwins, '/CommercialLines', { key: 'riskState', after: 'Virginia' }), 'VA');
  assert.equal(quoteStatePick(amwins, '/application/businessauto', { key: 'mailingState', after: 'Virginia' }), undefined, 'an address, not the quote state');
  assert.equal(quoteStatePick({ id: 'test' }, '/home/', { key: 'QuoteStateList', after: 'Utah' }), undefined);
  assert.deepEqual(stateMismatch('UT', { garaging: { state: 'FL' } }), { picked: 'Utah', intake: 'Florida' });
  assert.equal(stateMismatch('FL', { garaging: { state: 'FL' } }), null);
  assert.equal(stateMismatch('FL', { garaging: { state: 'Florida' } }), null);
  assert.equal(stateMismatch('UT', { garaging: { state: null } }), null, 'an address the intake couldn\'t split: nothing to compare');
});
