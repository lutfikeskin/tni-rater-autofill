// Each plan step's and report item's `resolution` (src/resolution.js) agrees with the old fields it
// is built from (source, standard, manualOnly, reviewRequired / review, note, warn): for every
// carrier, on the fixture intakes, a blank one and one in review mode. The page kit's report items
// are held to the same in test/pagekit.test.mjs (every fill it runs), and the mocks' in
// scripts/amwins-mock.mjs and scripts/geico-mock.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { buildPlan } from '../src/plan.js';
import { CARRIERS } from '../src/carriers.js';
import { unitMissingItem } from '../src/units.js';
import { agentsAlone, isStandard, itemResolution, resolutionOf, stepResolution } from '../src/resolution.js';
import { collectItems, manualOnlyReason } from '../src/ai/common.js';
import { assertStepResolution, assertItemResolution, assertEventsAgree } from './resolution-check.mjs';
import { fillEvents } from '../src/usage.js';

const FIXTURES = ['sample-intake.pdf', 'sample-intake-2026-10.pdf', 'multi-vehicle-intake.pdf'];
const today = new Date('2026-10-30');

async function records() {
  const out = [];
  for (const file of FIXTURES) {
    const raw = await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url))));
    const record = normalizeIntake(raw, { today }).record;
    out.push([file, record]);
    // Review mode: a business class no carrier's rules were written for.
    out.push([`${file} (review mode)`, { ...record, operations: { ...record.operations, businessClass: 'Other' } }]);
  }
  const [, sample] = out[0];
  // Cargo without a deductible: an answer the agent confirms (AmWINS' disclosure details warn).
  out.push(['cargo, no deductible', { ...sample, coverage: { ...sample.coverage, cargo: true, cargoLimit: 100000, cargoDeductible: null } }]);
  // An intake that leaves most of it blank: the agent's and open answers.
  out.push(['sparse intake', { ...sample, operations: { businessClass: sample.operations.businessClass }, coverage: {}, claims: {}, priorInsurance: [], trailerInfo: {},
    drivers: sample.drivers.map((d) => ({ first: d.first, last: d.last })), vehicles: sample.vehicles.map((v) => ({ year: v.year, make: v.make })) }]);
  return out;
}

test('every plan step\'s resolution agrees with its source, flags, note and warn, for every carrier', async () => {
  const seen = {};
  for (const [file, record] of await records()) {
    for (const carrier of Object.values(CARRIERS)) {
      const units = [{}, ...(record.vehicles?.length > 1 ? [{ vehicles: 1 }] : []), ...(record.drivers?.length > 1 ? [{ drivers: 1 }] : [])];
      for (const active of units) {
        for (const step of buildPlan(record, carrier, active).filter((s) => s.kind !== 'action')) {
          assertStepResolution(step, `${carrier.id} ${file} ${JSON.stringify(active)}`);
          seen[step.resolution.status] = (seen[step.resolution.status] ?? 0) + 1;
        }
      }
    }
  }
  // Each status a plan can give came up, so none of the checks above is idle.
  for (const status of ['answered', 'confirm', 'review', 'open', 'agent', 'kept']) assert.ok(seen[status] > 0, `no step was ${status}: ${JSON.stringify(seen)}`);
});

test('a review-mode standard is given and reviewed; a fact the intake lacks is the agent\'s, with its note', () => {
  const step = { value: 'Yes', source: 'standard', manualOnly: false, reviewRequired: true, ignore: false, verifyOnly: false, note: null, warn: 'Review mode: confirm.' };
  assert.deepEqual(stepResolution(step), { answer: 'Yes', method: 'standard', explanation: 'Review mode: confirm.', status: 'review' });
  assert.deepEqual(stepResolution({ ...step, value: null, source: 'fact', manualOnly: true, note: 'Ask the client.', warn: null }),
    { answer: null, method: 'fact', explanation: 'Ask the client.', status: 'agent' });
});

// A report kept from a build before resolutions (session storage, restoreReports) has none: the
// panel and the AI rebuild it from the item's fields and read the same.
const ITEMS = {
  filled: [{ key: 'a', label: 'Liability', source: 'standard', standard: true, manualOnly: false, review: false }, { key: 'b', label: 'Name', source: 'intake', standard: false, manualOnly: false, review: false }],
  kept: [{ key: 'c', label: 'Deductible', source: 'standard', standard: true, manualOnly: false, review: false }],
  noData: [{ key: 'd', label: 'Prior loss', source: 'fact', standard: false, manualOnly: true, review: false, note: 'Ask the client.', controlKind: 'radio', options: ['Yes', 'No'] },
    { key: 'e', label: 'Marital status', source: 'derived', standard: false, manualOnly: false, review: false, note: 'Not on the intake.', controlKind: 'select', options: ['Single', 'Married'] }],
  checks: [{ key: 'f', label: 'Medical payments', source: 'standard', standard: true, manualOnly: false, review: true, note: 'Review mode: confirm.' }],
  failed: [{ key: 'g', label: 'Radius', source: 'intake', standard: false, manualOnly: false, review: false, reason: 'no such option', controlKind: 'select', options: ['50 miles'] }],
  leftRequired: [{ key: 'h', label: 'Garaging ZIP', controlKind: 'text' }],
  unknown: [{ key: 'i', label: 'New question', controlKind: 'radio', options: ['Yes', 'No'] }],
};
const withResolutions = () => [Object.fromEntries(Object.entries(ITEMS).map(([list, xs]) => [list, xs.map((x) => ({ ...x, resolution: itemResolution(x, list, null) }))]))];
const without = () => [structuredClone(ITEMS)];

test('a kept report from before resolutions reads the same: each item\'s is rebuilt from its fields', () => {
  for (const [list, xs] of Object.entries(withResolutions()[0])) {
    for (const x of xs) {
      const { resolution, ...old } = x;
      assert.deepEqual(resolutionOf(old, list), resolution, `${list} ${x.label}`);
      assert.equal(resolutionOf(x, list), resolution, 'its own when it has one');
      assert.equal(agentsAlone(old), agentsAlone(x));
      assert.equal(isStandard(old, list), isStandard(x, list));
    }
  }
  // A build before items carried `source` marked a standard by `standard` alone.
  assert.equal(isStandard({ label: 'Gender', standard: true }, 'filled'), true);
  assert.equal(isStandard({ label: 'Name' }, 'filled'), false);
});

test('Luna\'s items, and the fields it is never given, are the same with resolutions or without', () => {
  assert.deepEqual(collectItems(withResolutions()), collectItems(without()));
  const { items, blocked } = collectItems(withResolutions());
  assert.deepEqual(blocked.filter((x) => x.manualOnly).map((x) => x.key), ['d'], 'the agent\'s alone, never the AI\'s');
  assert.ok(items.some((x) => x.key === 'e'), 'an open answer is the AI\'s to suggest');
  for (const x of [...ITEMS.noData, ...ITEMS.failed]) {
    assert.equal(manualOnlyReason({ ...x, resolution: itemResolution(x, 'noData', null) }), manualOnlyReason(x), x.label);
  }
});

test('the usage log\'s events are the same with resolutions or without, and say what the old flags said', () => {
  const ctx = { carrier: 'amwins', page: 'p', view: 'v', overwrite: false, ms: 0, redact: (s) => s, run: 'r' };
  assert.deepEqual(fillEvents(withResolutions(), ctx), fillEvents(without(), ctx));
  assertEventsAgree(withResolutions()[0], 'with');
  assertEventsAgree(without()[0], 'without');
  // A build before items carried `source`: still logged a standard, and no source it never had.
  const [legacy] = fillEvents([{ filled: [{ key: 'k', label: 'Gender', standard: true }] }], ctx).filter((e) => e.type === 'fill_field');
  assert.deepEqual([legacy.source, legacy.standard], [undefined, true]);
});

test('the panel\'s own item for a unit missing from the list carries a resolution like the kit\'s', () => {
  const item = unitMissingItem({ name: 'GEICO', unitLists: [] }, {}, { list: 'drivers', index: 1 });
  assertItemResolution(item, 'noData', null, 'unitMissingItem');
  assert.equal(item.resolution.status, 'open');
});
