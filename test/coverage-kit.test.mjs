import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLocator } from '../src/kit/locator.js';
import { humanize, isPlaceholderOption, squash, STATE_NAMES } from '../src/kit/text.js';
import { optionsOf, safeMatches, shownControl } from '../src/kit/dom.js';
import { unitFormsOf } from '../src/kit/units.js';
import { stepIs } from '../src/kit/adapter.js';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { claimingRule } from '../scripts/lib/coverage.mjs';

// Audit 2026-11-07, LEARN-06: coverage (scripts/lib/coverage.mjs) pairs a layout's fields with the
// rules "the way the fill engine pairs them", but by a copy of the locator's assign with no test
// that they agree. Here the kit's own assign (src/kit/locator.js) runs on every committed Progressive
// layout, each field as the control the kit would read, with a synthetic intake's plan; coverage must
// claim the same fields the kit claims and leave the same ones unfamiliar. Coverage's "unsure" (a
// selector only a DOM can judge) says it can't tell, so it is left out. Which rule claims a field
// isn't compared (two rules may ask the same text, as Progressive's two "None of the above"), nor
// filled against ignored (a rule's ignore may depend on the intake).
let page = null;
const { assign } = createLocator({ squash, humanize, STATE_NAMES, isPlaceholderOption, optionsOf, safeMatches, shownControl, unitFormsOf, stepIs,
  stepKey: () => '', currentPage: () => page, extraRowKeys: new Map() });

// A layout's field as the kit reads the control (dom.js PageControl): its question's text squashed,
// a combo a select and a date a text box. No DOM: a selector matches nothing (coverage's "unsure").
const KIND = { combo: 'select', date: 'text' };
const control = (f) => ({
  kind: KIND[f.kind] ?? f.kind ?? 'text', type: f.kind, q: f.q ?? null, ref: f.ref ?? null, row: null, text: squash(f.caption), label: f.caption ?? null,
  required: !!f.req, nameOnly: !f.caption, options: (f.opts ?? []).map((o) => ({ text: o, value: o })),
  el: { id: f.id ?? '', name: '', value: '', matches: () => false, closest: () => null, getAttribute: () => null, querySelectorAll: () => [] },
});

// A synthetic intake (test/progressive.test.mjs's): one van, one driver, cargo, Federal filing.
const record = {
  loadedOn: '10/01/2026',
  applicant: { name: 'Synthetic Expediter LLC', dot: null, mc: null, mcDotWithin60Days: null, owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', email: 'client@example.test', fein: null },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'MD', zip: '21000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', radiusMiles: null, personalUse: false, hazPlacard: false, filingsRequired: true, filingsWhich: 'Federal Liability Filing', usesEld: null },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'MD1234567', licenseState: 'MD' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other', limit: '$500k CSL', expiration: '10/31/2099' }],
  coverage: { autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, glLimit: null, comprehensiveDeductible: null, collisionDeductible: null },
  claims: { hasClaims: false },
};

// Whether the kit claims a page's field: paired with a step, or kept as a held form's. A layout is
// merged from several visits, so it may hold conditional fields (`cond`) the page never shows
// together, such as the two "Apt, Building, Floor, Suite, etc." of Progressive's two address blocks.
// A label rule answers one field a page, so a conditional field is also judged without the fields
// reading the same, as it would be on its own on the page.
function kitClaims(fields, i, plan) {
  const claimed = (list, at) => {
    const controls = list.map(control);
    const pairs = assign(controls, plan);
    return pairs.some((p) => p.control === controls[at]) || pairs.held.has(controls[at]);
  };
  if (claimed(fields, i)) return true;
  if (!fields[i].cond) return false;
  const alone = fields.filter((f, j) => j === i || squash(f.caption) !== squash(fields[i].caption));
  return claimed(alone, alone.indexOf(fields[i]));
}

const FIXTURES = new URL('./fixtures/progressive/', import.meta.url);
const layouts = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(new URL(f, FIXTURES), 'utf8'))]);

test('coverage claims the fields of the committed Progressive layouts the kit\'s locator claims, and no others', () => {
  assert.ok(layouts.length >= 8, 'the committed layouts');
  const plan = buildPlan(record, progressive);
  const differ = [];
  let compared = 0;
  for (const [file, layout] of layouts) {
    for (const [name, p] of Object.entries(layout.pages ?? {})) {
      page = name;
      const fields = p.fields ?? [];
      fields.forEach((f, i) => {
        const cov = claimingRule(f, progressive, name, fields).status;
        if (cov === 'unsure') return;
        compared++;
        const kit = kitClaims(fields, i, plan);
        if (kit !== (cov !== 'none')) differ.push(`${file} ${name} "${f.caption}": kit ${kit ? 'claims' : 'leaves it unfamiliar'}, coverage ${cov}`);
      });
    }
  }
  assert.ok(compared > 500, `fields compared: ${compared}`);
  assert.deepEqual(differ, []);
});
