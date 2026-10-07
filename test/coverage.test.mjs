import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage, fieldStatus, idsInHtml } from '../scripts/lib/coverage.mjs';
import { findPii } from '../scripts/lib/privacy.mjs';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';

test('coverage: Progressive questions by data-model name or text, AmWINS by id / data-id, and what no rule claims', () => {
  assert.equal(fieldStatus({ q: '1D97', caption: 'Bodily Injury and Property Damage Liability' }, progressive).status, 'filled');
  assert.equal(fieldStatus({ q: '2BCB', caption: 'Annual Mileage' }, progressive).status, 'ignored');
  // Renumbered (2026-10-07): 267 is Business Name now. Its data-model name says which rule it is.
  assert.equal(fieldStatus({ q: '267', ref: 'AccountInput.BusinessName', caption: 'Business Name' }, progressive, 'BusinessOwnerInfo').rule, 'Business / sole proprietor name');
  // A question id alone claims nothing, and a name no rule knows is unclaimed whatever its number.
  assert.equal(fieldStatus({ q: '1D97', caption: 'A reworded liability question' }, progressive, 'CoveragesRates').status, 'none');
  assert.equal(fieldStatus({ q: '1D97', ref: 'LineInput.SomethingNew', caption: 'Something new' }, progressive, 'CoveragesRates').status, 'none');
  // Text claims only on the question's page: "Zip Code" on NoHit is NoHit's.
  assert.equal(fieldStatus({ caption: 'Zip Code' }, progressive, 'NoHit').rule, 'Owner home ZIP (NoHit)');
  assert.equal(fieldStatus({ q: 'ZZZZ', caption: 'A brand new Progressive question' }, progressive).status, 'none');
  // Codex on PR #43: two kinds of field read "Business Type"; the kind decides, as when filling.
  assert.equal(fieldStatus({ caption: 'Business Type', kind: 'combo' }, progressive, 'BusinessOwnerInfo').rule, 'Business type');
  assert.equal(fieldStatus({ caption: 'Business Type', kind: 'text' }, progressive, 'BusinessOwnerInfo').status, 'ignored');
  // The trailer page carries the vehicle's data-model names: there they are the trailer's.
  assert.equal(fieldStatus({ ref: 'RiskInput.VIN', caption: 'VIN', kind: 'text' }, progressive, 'AddTrailer').rule, 'trailers[].vin');
  assert.equal(fieldStatus({ ref: 'RiskInput.VIN', caption: 'Vehicle Identification Number (VIN)', kind: 'text' }, progressive, 'AddVehicle').rule, 'vehicles[].vin');
  assert.equal(fieldStatus({ id: 'ownerDob', caption: 'owner dob' }, amwins).status, 'filled');
  assert.equal(fieldStatus({ dataId: 'gender', caption: 'Gender', kind: 'combo' }, amwins).status, 'filled');
  assert.equal(fieldStatus({ id: 'agnecyName', caption: 'agnecy name' }, amwins).status, 'ignored');
  assert.equal(fieldStatus({ id: 'brandNewField', caption: 'Brand new question' }, amwins).status, 'none');
  assert.equal(fieldStatus({ caption: 'yrs in business' }, amwins).status, 'unsure', 'recorded without ids: id rules cannot be checked');
  assert.equal(fieldStatus({ caption: 'Owner Date of Birth' }, amwins).generic, true, 'generic label rules still apply to AmWINS');
});

test('coverage: AmWINS fields whose ids are not in the mock are reported as drift', () => {
  const mockIds = idsInHtml(new URL('./fixtures/amwins/application.html', import.meta.url));
  assert.ok(mockIds.has('ownerDob') && mockIds.has('martialStatus'));
  const layout = { carrier: 'amwins', pages: { '/application/businessauto': { fields: [
    { id: 'ownerDob', caption: 'owner dob' }, { id: 'renamedField', caption: 'Brand new question' },
  ] } } };
  const r = coverage(layout, amwins, { mockIds });
  assert.equal(r.totals.notInMock, 1);
  assert.equal(r.totals.none, 1);
});

test('privacy scan catches client-looking data and lets synthetic values through', () => {
  assert.deepEqual(findPii('VIN 1HGCM82633A004352, call (312) 555-8899, mail jo@gmail.com, 617 Wheaton Rd, SSN 123-45-6789, USDOT 1234567').map((h) => h.kind).sort(),
    ['email', 'phone', 'ssn', 'street', 'usdot', 'vin']);
  assert.deepEqual(findPii('client@example.test (402) 555-0100 1 Test Way 54DC4W1B5KS800000 2025 RAM PROMASTER 2500'), []);
});
