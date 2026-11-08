// Audit 2026-11-07, CARR-12: a carrier config's mistakes that only a live page would show, where one
// throw ends the whole fill: a pattern that doesn't compile (a '^\+$' written '^+$' stopped every
// fill on Rates once, PR #213), a selector that doesn't parse, a helper waiting for an action or
// answer no rule gives, helpers waiting on each other. Run over every registered carrier, with the
// function-valued fields evaluated on a few synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CARRIERS } from '../src/carriers.js';

const base = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', mc: 'MC-765432', owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', yearsInBusiness: 5 },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'NJ', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', vehicleOwnership: 'Owned', filingsRequired: true, filingsWhich: 'Federal Liability Filing' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'NJ', cdl: true, cdlYear: 2015 }],
  vehicles: [{ type: 'Box Truck', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }, { type: 'Semi Truck', year: 2019, make: 'FREIGHTLINER', model: 'Cascadia', vin: '1FUJGLDR0KLAA0000', value: 60000 }],
  trailers: [{ type: 'Dry Van', year: 2015, make: 'GREAT DANE', vin: '1GRAA0621FB700000', value: 25000 }],
  trailerInfo: { ownership: 'Owned', interchange: true, interchangeLimit: '$50,000' },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other', limit: '$500k CSL', expiration: '10/31/2099' }],
  coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: true, glLimit: '$1M/$2M', ntl: null },
  claims: { hasClaims: false, text: 'No' },
  notes: { text: null },
});
const RECORDS = [base(), { ...base(), coverage: { ...base().coverage, ntl: true, autoLiability: 'Non-Trucking', cargo: false, gl: false } },
  { ...base(), applicant: { ...base().applicant, dot: null, mc: null }, garaging: { ...base().garaging, state: 'TX' }, trailers: [] }];
const ACTIVE = [{}, { vehicles: 1, drivers: 0, trailers: 0 }];
// A field's values: itself, or what its function returns on the records (one that throws on a
// record it isn't meant for gives nothing there).
const values = (v) => (typeof v !== 'function' ? [v] : RECORDS.flatMap((r) => ACTIVE.map((a) => { try { return v(r, a); } catch { return undefined; } })));
const strings = (v) => values(v).flat().filter((x) => typeof x === 'string');

const { document } = new JSDOM('<!doctype html><body></body>').window;
const parses = (selector) => { try { document.querySelector(selector); return true; } catch { return false; } };
const compiles = (pattern) => { try { new RegExp(pattern, 'i'); return true; } catch { return false; } };
const name = (x) => x.id ?? x.name ?? x.q ?? x.field ?? x.selector ?? x.label ?? x.path;

// Which fields hold a pattern, and which a selector.
const RULE_PATTERNS = ['label', 'not', 'firstNot'];
const RULE_SELECTORS = ['selector', 'repeatSelector', 'waitFor'];
const ACTION_PATTERNS = ['text', 'resolvedBy', 'opener'];
const ACTION_SELECTORS = ['within', 'unlessSelector', 'ratedBy'];

// What is wrong with a carrier's patterns and selectors, and with its helpers' references.
function patternProblems(carrier) {
  const bad = [];
  for (const rule of carrier.rules) {
    for (const k of RULE_PATTERNS) for (const p of strings(rule[k])) if (!compiles(p)) bad.push(`rule ${name(rule)}: ${k} /${p}/`);
    for (const k of RULE_SELECTORS) for (const s of strings(rule[k])) if (!parses(s)) bad.push(`rule ${name(rule)}: ${k} "${s}"`);
  }
  for (const a of carrier.actions ?? []) {
    for (const k of ACTION_PATTERNS) for (const p of strings(a[k])) if (!compiles(p)) bad.push(`action ${a.id}: ${k} /${p}/`);
    for (const k of ACTION_SELECTORS) for (const s of strings(a[k])) if (!parses(s)) bad.push(`action ${a.id}: ${k} "${s}"`);
    for (const s of values(a.verify).map((v) => v?.appears).filter(Boolean)) if (!parses(s)) bad.push(`action ${a.id}: verify.appears "${s}"`);
  }
  if (carrier.advance) for (const p of [carrier.advance.text, carrier.advance.listed].filter(Boolean)) if (!compiles(p)) bad.push(`advance /${p}/`);
  if (carrier.advance?.notWithin && !parses(carrier.advance.notWithin)) bad.push(`advance.notWithin "${carrier.advance.notWithin}"`);
  for (const [k, b] of Object.entries(carrier.stopButtons ?? {})) if (!compiles(b.button)) bad.push(`stopButtons.${k} /${b.button}/`);
  for (const u of carrier.unitNames ?? []) if (!compiles(u.text)) bad.push(`unitNames ${u.page} /${u.text}/`);
  if (carrier.unitPager && !compiles(carrier.unitPager.text)) bad.push(`unitPager /${carrier.unitPager.text}/`);
  if (carrier.unitPager?.current && !parses(carrier.unitPager.current)) bad.push(`unitPager.current "${carrier.unitPager.current}"`);
  for (const u of carrier.unitLists ?? []) if (!parses(u.selector)) bad.push(`unitLists "${u.selector}"`);
  for (const s of carrier.rowSections ?? []) if (!parses(s)) bad.push(`rowSections "${s}"`);
  return [...new Set(bad)];
}

// An action named with a unit (`lookupVin:vehicle`, `addDriver:0`) is the action. Besides the
// carrier's actions, a helper may wait on the panel's own marks of a unit on its list
// (`<unit>Entered:<i>`: sidepanel/panel/fill.js, src/units.js).
const actionOf = (id) => String(id).replace(/:(?:driver|vehicle|trailer|\d+)$/, '');
const PANEL_MARKS = new Set(['vehicleEntered', 'driverEntered', 'trailerEntered']);
function referenceProblems(carrier) {
  const actions = carrier.actions ?? [];
  const ids = new Set(actions.map((a) => a.id));
  const known = (id) => ids.has(actionOf(id)) || PANEL_MARKS.has(actionOf(id));
  const paths = new Set(carrier.rules.flatMap((r) => [...strings(r.path), r.q != null ? `${carrier.id}.q${r.q}` : null]).filter(Boolean)
    .map((p) => p.replace(/\[\d+\]/g, '[]')));
  const bad = [];
  for (const a of actions) {
    for (const k of ['afterActions', 'unlessActions', 'heldBy', 'doneWhen']) for (const id of strings(a[k])) if (!known(id)) bad.push(`${a.id}: ${k} names "${id}", no action of ${carrier.id}`);
    for (const k of ['after', 'afterAny', 'unless']) {
      for (const p of strings(a[k])) if (!paths.has(p.replace(/\[\d+\]/g, '[]'))) bad.push(`${a.id}: ${k} names "${p}", which no rule of ${carrier.id} answers`);
    }
  }
  // No helper waits, through afterActions, on itself.
  const after = new Map(actions.map((a) => [a.id, new Set(strings(a.afterActions).map(actionOf))]));
  const cycle = (id, seen = []) => (seen.includes(id) ? [...seen, id] : [...(after.get(id) ?? [])].map((next) => cycle(next, [...seen, id])).find(Boolean) ?? null);
  for (const a of actions) { const c = cycle(a.id); if (c) bad.push(`${a.id}: afterActions go round (${c.join(' > ')})`); }
  return [...new Set(bad)];
}

for (const carrier of CARRIERS) {
  test(`${carrier.id}: every pattern compiles and every selector parses`, () => {
    assert.deepEqual(patternProblems(carrier), []);
  });
  test(`${carrier.id}: helpers wait only for actions it has and answers its rules give, and never on each other`, () => {
    assert.deepEqual(referenceProblems(carrier), []);
  });
}

// The lint itself finds what it is for.
test('the lint catches a broken pattern, an unparsed selector, a dangling reference and helpers waiting on each other', () => {
  const broken = {
    id: 'x', hosts: [], useGenericRules: false,
    rules: [{ name: 'A', path: 'applicant.name', label: '^+$' }, { name: 'B', selector: '#a >> b' }, { name: 'C', path: 'applicant.dot' }],
    actions: [
      { id: 'one', text: '^\\+$', afterActions: ['two'], after: ['applicant.dot'] },
      { id: 'two', text: (r) => (r.applicant.dot ? '^(' : '^ok$'), afterActions: ['one'], unless: ['applicant.mcc'] },
      { id: 'three', text: '^go$', unlessActions: ['missing:driver'], within: 'div[' },
    ],
    advance: { text: '^continue$', notWithin: '#ok' },
  };
  assert.deepEqual(patternProblems(broken), ['rule A: label /^+$/', 'rule B: selector "#a >> b"', 'action two: text /^(/', 'action three: within "div["']);
  assert.deepEqual(referenceProblems(broken), ['two: unless names "applicant.mcc", which no rule of x answers', 'three: unlessActions names "missing:driver", no action of x',
    'one: afterActions go round (one > two > one)', 'two: afterActions go round (two > one > two)']);
});
