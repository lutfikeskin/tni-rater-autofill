// Answer provenance (Contract 2, docs/intake-and-rules.md): every carrier rule that computes an
// answer says where it comes from; facts and attestations the intake doesn't supply are never
// filled; standards are marked, and become check items for a business class the rules weren't
// written for (review mode). Plus: every intake field is read by both carriers, or its absence is
// listed here with the reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan, supportedClass, reviewWarn, SOURCES, AGENT_SOURCES } from '../src/plan.js';
import { SECTIONS } from '../src/schema.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';

const CARRIERS = [progressive, amwins];

// An expediter with everything the intake can give (the shape of test/progressive.test.mjs).
const expediter = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', mc: 'MC-765432', mcDotWithin60Days: null, owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', email: 'client@example.test', fein: null, yearEstablished: 2019, yearsInBusiness: 5, yearsExperience: 3 },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'NJ', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', radiusMiles: null, vehicleOwnership: 'Owned', personalUse: false, hazmat: false, hazPlacard: false, filingsRequired: true, filingsWhich: 'Federal Liability Filing', usesEld: false, equipVehicle: null },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'NJ', cdl: true, cdlYear: 2015, maritalStatus: 'Married' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [{ type: 'Dry Van', year: 2015, make: 'GREAT DANE', model: null, vin: '1GRAA0621FB700000', value: 25000 }],
  trailerInfo: { ownership: 'Owned', equipTrailer: null },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other', limit: '$500k CSL', expiration: '10/31/2026' }],
  coverage: { autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, glLimit: null, reeferBreakdown: null, ntl: null },
  claims: { hasClaims: false, text: 'No', notes: null },
});
const with_ = (changes) => {
  const r = expediter();
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.');
    let cur = r;
    for (const k of keys.slice(0, -1)) cur = cur[k];
    cur[keys.at(-1)] = value;
  }
  return r;
};
const byQ = (plan, q) => plan.find((s) => s.q === q);
const named = (plan, re) => plan.find((s) => re.test(s.name ?? ''));
const bySel = (plan, sel) => plan.find((s) => s.selector === sel);
const field = (plan) => plan.filter((s) => s.kind !== 'action');
const agentsNote = (step) => { assert.equal(step.value, null, `${step.name}: not filled`); assert.ok(step.note, `${step.name}: has a note`); };

// The records the plan is checked against: facts and attestations stay unfilled on every one.
const RECORDS = () => [
  expediter(),
  with_({ 'applicant.dot': null, 'applicant.name': null, 'operations.vehicleOwnership': 'Leased', 'claims.hasClaims': true, 'operations.equipVehicle': 5000 }),
  with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel', 'trailerInfo.ownership': null, 'drivers.0.maritalStatus': null, 'applicant.yearEstablished': null }),
];

test('every rule that computes an answer declares a valid source', () => {
  for (const carrier of CARRIERS) {
    for (const rule of carrier.rules) {
      const where = `${carrier.id}: ${rule.name ?? rule.q ?? rule.selector ?? rule.label ?? rule.path}`;
      // A source may depend on the record: every record's must be valid.
      const sources = typeof rule.source === 'function' ? RECORDS().map((r) => rule.source(r, {})) : [rule.source];
      for (const source of sources) {
        if (rule.source !== undefined) assert.ok(SOURCES.includes(source), `${where}: source "${source}"`);
        if (rule.value !== undefined) assert.ok(SOURCES.includes(source), `${where}: a rule with a value declares its source`);
      }
      // A path alone reads the intake; declaring another source for it would be a contradiction.
      if (rule.path && rule.value === undefined && rule.source) assert.ok(['intake', ...AGENT_SOURCES].includes(rule.source), `${where}: a path rule is intake (or the agent's)`);
    }
  }
});

test('facts and attestations are never filled; standards are marked', () => {
  for (const carrier of CARRIERS) {
    let facts = 0, standards = 0;
    for (const record of RECORDS()) {
      for (const active of [{}, { vehicles: 0, drivers: 0, trailers: 0 }]) {
        for (const step of field(buildPlan(record, carrier, active))) {
          if (AGENT_SOURCES.includes(step.source)) { facts++; agentsNote(step); assert.equal(step.standard, false); }
          // Codex on c31942e: the agent's, never the AI's (pagekit report -> collectItems).
          if (AGENT_SOURCES.includes(step.source)) assert.equal(step.manualOnly, true, `${carrier.id} ${step.name}: manualOnly`);
          else if (step.manualOnly) assert.equal(step.value, null, `${carrier.id} ${step.name}: manualOnly only while unanswered`);
          assert.equal(step.standard, step.source === 'standard', `${carrier.id} ${step.name}: standard iff source standard`);
          if (step.standard) standards++;
          if (!step.path?.startsWith(`${carrier.id}.`) && !step.source && step.value != null && !step.selector) assert.fail(`${carrier.id} ${step.name}: a filled step without a source`);
        }
      }
    }
    assert.ok(facts > 0 && standards > 0, `${carrier.id}: both kinds are present`);
  }
});

test('an intake-only rule reads the intake (source intake) and nothing else', () => {
  const plan = buildPlan(expediter(), progressive, {});
  assert.equal(byQ(plan, '2B20').source, 'intake');
  assert.equal(byQ(plan, '2B20').value, '1FTBR3X87MKA12345');
  assert.equal(byQ(plan, '2B20').standard, false);
});

// --- Schema coverage ------------------------------------------------------------------------------
// A rule consumes an intake path when it names it (`path`) or the carrier's rule source reads it
// (`.leaf` / `?.leaf`, comments stripped). The rest is listed, each with its reason, so a new
// intake field no rule reads (equipVehicle until 2026-10-09) can't go unnoticed.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SOURCE = {
  progressive: stripComments(fs.readFileSync(new URL('../src/carriers/progressive.js', import.meta.url), 'utf8')),
  amwins: stripComments(fs.readFileSync(new URL('../src/carriers/amwins.js', import.meta.url), 'utf8')),
};
// Not mapped on purpose, with the reason.
const NOT_MAPPED = {
  progressive: {
    'applicant.mc': 'Progressive asks for the USDOT number only; the MC number is never entered',
    'applicant.fein': 'Progressive asks the EIN on the finish flow, which is the agent\'s (AdditionalDetails is ignored)',
    'applicant.yearEstablished': 'Progressive does not ask when the business was established',
    'applicant.yearsInBusiness': 'Progressive does not ask the years in business',
    'applicant.phone': 'the optional phone boxes are deliberately left blank (TNI workflow)',
    'applicant.email': 'the optional customer email is deliberately left blank (TNI workflow)',
    'applicant.owner2': 'Progressive asks for one business owner',
    'applicant.yearsExperience': 'Progressive does not ask the years under own authority',
    'operations.eldBrand': 'Progressive asks only whether an ELD is required',
    'operations.needSr22': 'Progressive\'s commercial quote has no SR-22 question in the mapped flow',
    'operations.filingsWhich': 'on the Filings page Federal is ticked whenever filings are required; State is left as the page has it',
    'operations.hazmat': 'Progressive asks whether a placard is required (operations.hazPlacard)',
    'operations.movingState': 'not asked by Progressive',
    'operations.licensePlate': 'not asked by Progressive',
    'drivers[].maritalStatus': 'Progressive\'s commercial driver page does not ask it',
    'trailerInfo.hitch': 'not asked by Progressive',
    'trailerInfo.interchange': 'trailer interchange is not mapped (no live quote has asked it)',
    'trailerInfo.interchangeLimit': 'trailer interchange is not mapped (no live quote has asked it)',
    'coverage.autoLiability': 'liability is always quoted; only its limit is entered',
    'coverage.glLimit': 'General Liability is not validated on Progressive: the agent reviews it (glNote)',
  },
  amwins: {
    'applicant.mcDotWithin60Days': 'AmWINS asks for the numbers themselves (has DOT / has MC / no number)',
    'applicant.fein': 'not asked on the Business Auto application',
    'applicant.email': 'the contact email box is the agency\'s / left as the page has it',
    'applicant.owner2': 'AmWINS asks for one owner',
    'operations.personalUse': 'not asked; usage is For Hire (derived) or the agent\'s',
    'operations.usesEld': 'not asked on the Business Auto application',
    'operations.eldBrand': 'not asked on the Business Auto application',
    'operations.needSr22': 'not asked on the Business Auto application',
    'operations.hazPlacard': 'AmWINS asks about transporting hazardous material (operations.hazmat)',
    'operations.movingState': 'not asked on the Business Auto application',
    'operations.licensePlate': 'not asked on the Business Auto application',
    'drivers[].cdl': 'AmWINS has no CDL question; the license year is the agent\'s',
    'drivers[].cdlYear': 'AmWINS has no CDL question; the license year is the agent\'s',
    'trailerInfo.ownership': 'AmWINS has no trailer section (the trailer is a disclosure line)',
    'trailerInfo.hitch': 'AmWINS has no trailer section',
    'trailerInfo.interchange': 'AmWINS has no trailer section',
    'trailerInfo.interchangeLimit': 'AmWINS has no trailer section',
    'trailerInfo.equipTrailer': 'AmWINS has no trailer section',
    'coverage.autoLiability': 'liability is always quoted; only its CSL limit is entered',
    'coverage.gl': 'AmWINS Business Auto has no general liability section',
    'coverage.glLimit': 'AmWINS Business Auto has no general liability section',
    'coverage.reeferBreakdown': 'no reefer breakdown question on the Business Auto application',
    'coverage.ntl': 'AmWINS has no known NTL option',
    'claims.text': 'the claims box is read by the intake reader into hasClaims and notes',
  },
};
// Read by a helper in another module, so the text search of the carrier file can't see it.
const READ_INDIRECTLY = {
  progressive: {
    'applicant.applicationDate': 'util.priorPolicyExpired (currently insured, insured with Progressive)',
  },
  amwins: {
    'applicant.applicationDate': 'util.priorPolicyExpired (the disclosure\'s expired-policy flag)',
    'applicant.ownerDrives': 'owner() in progressive.js (the owner\'s driver row)',
  },
};

test('every intake field is consumed by each carrier, or its absence is explained here', () => {
  const paths = SECTIONS.flatMap((s) => s.fields.map(([path]) => path));
  for (const carrier of CARRIERS) {
    const byPath = new Set(carrier.rules.map((r) => r.path?.replace(/\[\d+\]/, '[]')).filter(Boolean));
    const consumed = (path) => {
      if (byPath.has(path)) return true;
      const leaf = path.split('.').at(-1);
      return new RegExp(`\\??\\.${leaf}\\b`).test(SOURCE[carrier.id]);
    };
    const notMapped = NOT_MAPPED[carrier.id];
    const indirect = READ_INDIRECTLY[carrier.id];
    for (const path of paths) {
      const listed = path in notMapped || path in indirect;
      if (consumed(path)) assert.ok(!(path in notMapped), `${carrier.id}: ${path} is consumed; drop it from NOT_MAPPED`);
      else assert.ok(listed, `${carrier.id}: no rule reads ${path} and it isn't listed as not mapped`);
    }
    for (const path of [...Object.keys(notMapped), ...Object.keys(indirect)]) assert.ok(paths.includes(path), `${carrier.id}: ${path} is no longer in the schema`);
    // The 2026-10-08 audit's omission: the vehicle's attached equipment value.
    assert.ok(consumed('operations.equipVehicle'), `${carrier.id} reads operations.equipVehicle`);
  }
});

// --- Counter-examples: the intake wins over a default, and a missing fact is the agent's ----------

// Codex on c31942e: a client fact the intake leaves unanswered is manualOnly (the AI assistant
// leaves it); answered, it's filled from the intake as before.
test('a client fact the intake does not answer is manualOnly; answered, it is filled', () => {
  const blank = with_({ 'drivers.0.maritalStatus': null, 'applicant.yearEstablished': null, 'operations.vehicleOwnership': null, 'trailerInfo.ownership': null, 'applicant.dot': null, 'applicant.mcDotWithin60Days': null, 'claims.hasClaims': null });
  const a = buildPlan(blank, amwins, { drivers: 0, vehicles: 0 });
  const p = buildPlan(blank, progressive, { drivers: 0, vehicles: 0, trailers: 0 });
  const unanswered = [named(a, /^Marital status/), bySel(a, '#yearBusinessEstablished'), named(a, /^Vehicles leased/), named(a, /^Vehicles not owned/),
    named(a, /^Additional interest/), named(a, /convictions/i), byQ(p, '2CA7'), byQ(p, '2AD0'), byQ(p, '1ED')];
  for (const step of unanswered) {
    assert.ok(step, 'step present');
    assert.equal(step.value, null, step.name);
    assert.equal(step.manualOnly, true, step.name);
  }
  const full = expediter();
  const fa = buildPlan(full, amwins, { drivers: 0, vehicles: 0 });
  const fp = buildPlan(full, progressive, { drivers: 0, vehicles: 0, trailers: 0 });
  for (const step of [named(fa, /^Marital status/), bySel(fa, '#yearBusinessEstablished'), named(fa, /^Vehicles not owned/), named(fa, /convictions/i), byQ(fp, '2CA7'), byQ(fp, '1ED')]) {
    assert.notEqual(step.value, null, step.name);
    assert.equal(step.manualOnly, false, step.name);
  }
  // A standard or intake answer is never manualOnly.
  assert.equal(named(fa, /^Waiver type/).manualOnly, false);
});

test('a leased vehicle: AmWINS not-owned Yes, leased to others the agent\'s, Progressive loan/lease "Yes - Lease"', () => {
  const r = with_({ 'operations.vehicleOwnership': 'Leased' });
  const a = buildPlan(r, amwins, {});
  assert.equal(named(a, /^Vehicles not owned/).value, true);
  // Codex on 2dcd1e8: "Are any vehicles leased to others?" isn't answered by leasing from a lessor.
  const toOthers = named(a, /^Vehicles leased to others/);
  agentsNote(toOthers);
  assert.deepEqual([toOthers.source, toOthers.manualOnly], ['fact', true]);
  assert.match(toOthers.note, /leased to others/);
  agentsNote(named(a, /^Additional interest/));
  assert.match(named(a, /^Additional interest/).note, /lienholder|lessor|leased/i);
  assert.equal(byQ(buildPlan(r, progressive, {}), '2CA7').value, 'Yes - Lease');
  const owned = buildPlan(expediter(), amwins, {});
  assert.deepEqual([named(owned, /^Vehicles leased to others/).value, named(owned, /^Vehicles not owned/).value, named(owned, /^Additional interest/).value], [null, false, false]);
  agentsNote(named(owned, /^Vehicles leased to others/));
  const financed = buildPlan(with_({ 'operations.vehicleOwnership': 'Financed' }), amwins, {});
  assert.deepEqual([named(financed, /^Vehicles leased to others/).value, named(financed, /^Vehicles not owned/).value], [null, false]);
  agentsNote(named(financed, /^Additional interest/));
  assert.equal(byQ(buildPlan(with_({ 'operations.vehicleOwnership': 'Financed' }), progressive, {}), '2CA7').value, 'Yes - Loan');
});

test('claims Yes: convictions are the agent\'s (a combined claims / violations Yes is not convictions), prior loss Yes', () => {
  const plan = buildPlan(with_({ 'claims.hasClaims': true }), amwins, {});
  const convictions = named(plan, /convictions/i);
  agentsNote(convictions);
  assert.equal(convictions.source, 'derived');
  assert.equal(named(plan, /^Any prior loss/).value, true);
  const none = buildPlan(expediter(), amwins, {});
  assert.equal(named(none, /convictions/i).value, false);
  assert.equal(named(none, /^Any prior loss/).value, false);
  agentsNote(named(buildPlan(with_({ 'claims.hasClaims': null }), amwins, {}), /convictions/i));
  // Never Yes, whatever the intake says.
  for (const r of RECORDS()) assert.notEqual(named(buildPlan(r, amwins, {}), /convictions/i).value, true);
});

test('attached equipment of $5,000 on the intake: entered, never "no equipment"', () => {
  const r = with_({ 'operations.equipVehicle': 5000 });
  const p = buildPlan(r, progressive, {});
  assert.equal(byQ(p, '2CE3').value, false, 'Vehicle has no equipment: No');
  assert.equal(byQ(p, '2CE3').source, 'derived');
  assert.equal(byQ(p, '2CE3').standard, false);
  assert.deepEqual([byQ(p, '2CE0').value, byQ(p, '2CE0').ignore, byQ(p, '2CE0').kind], [5000, false, 'money']);
  agentsNote(byQ(p, '2CCE'));
  assert.match(byQ(p, '2CCE').note, /5,?000/);
  const a = buildPlan(r, amwins, {});
  agentsNote(named(a, /^Permanently attached equipment/));
  assert.match(named(a, /^Permanently attached equipment/).note, /5,?000/);
  // Blank or small: TNI's standard band, no equipment.
  for (const amount of [null, undefined, 0, 1500, 2000]) {
    const q = buildPlan(with_({ 'operations.equipVehicle': amount }), progressive, {});
    assert.deepEqual([byQ(q, '2CE3').value, byQ(q, '2CCE').value, byQ(q, '2CE0').ignore], [true, '$0 to $2,000', true], String(amount));
    assert.equal(byQ(q, '2CCE').standard, true);
    assert.equal(byQ(q, '2CCE').note, null);
    // Codex on 2dcd1e8: no value on the intake is TNI's standard, not a client fact; a value up to
    // $2,000 on the intake is derived from it.
    const blank = amount == null;
    assert.deepEqual([byQ(q, '2CE3').source, byQ(q, '2CE3').standard], blank ? ['standard', true] : ['derived', false], String(amount));
  }
  // Review mode makes the blank-intake answer a check item; the intake's $1,500 stays derived.
  const review = (amount) => byQ(buildPlan(with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel', 'operations.equipVehicle': amount }), progressive, {}), '2CE3');
  assert.match(review(null).warn ?? '', /Review mode/);
  assert.equal(review(1500).warn ?? null, null);
  assert.equal(named(buildPlan(with_({ 'operations.equipVehicle': 1500 }), amwins, {}), /^Permanently attached equipment/).value, null, 'any amount on the intake is the agent\'s on AmWINS');
  // Same pattern as 2CE3: no value on the intake is TNI's standard No; an explicit $0 is derived.
  const blankAmwins = named(buildPlan(expediter(), amwins, {}), /^Permanently attached equipment/);
  assert.deepEqual([blankAmwins.value, blankAmwins.source, blankAmwins.standard, blankAmwins.manualOnly], [false, 'standard', true, false]);
  const zeroAmwins = named(buildPlan(with_({ 'operations.equipVehicle': 0 }), amwins, {}), /^Permanently attached equipment/);
  assert.deepEqual([zeroAmwins.value, zeroAmwins.source, zeroAmwins.standard], [false, 'derived', false]);
  assert.equal(named(buildPlan(with_({ 'operations.equipVehicle': 5000 }), amwins, {}), /^Permanently attached equipment/).source, 'derived');
  assert.match(named(buildPlan(with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' }), amwins, {}), /^Permanently attached equipment/).warn ?? '', /Review mode/);
  // Progressive trailer "no equipment" (2AFF): the same.
  const trailer = (amount, extra = {}) => byQ(buildPlan(with_({ 'trailerInfo.equipTrailer': amount, ...extra }), progressive, { trailers: 0 }), '2AFF');
  assert.deepEqual([trailer(null).value, trailer(null).source, trailer(null).standard], [true, 'standard', true]);
  assert.deepEqual([trailer(0).value, trailer(0).source, trailer(0).standard], [true, 'derived', false]);
  assert.deepEqual([trailer(3000).value, trailer(3000).source], [false, 'derived']);
  assert.match(trailer(null, { 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' }).warn ?? '', /Review mode/);
  assert.equal(trailer(3000, { 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' }).warn ?? null, null);
  // Its Rates row (TR2CE3) too.
  const rates = (amount) => buildPlan(with_({ 'trailerInfo.equipTrailer': amount }), progressive, { trailers: 0 }).find((x) => x.q === 'TR2CE3');
  assert.deepEqual([rates(null).source, rates(null).standard, rates(2500).source, rates(2500).value], ['standard', true, 'derived', false]);
});

test('missing ownership: loan / lease, leased, not owned and additional interest are the agent\'s', () => {
  const r = with_({ 'operations.vehicleOwnership': null, 'trailerInfo.ownership': null });
  const p = buildPlan(r, progressive, { trailers: 0 });
  agentsNote(byQ(p, '2CA7'));
  agentsNote(byQ(p, '2AD0'));
  assert.match(byQ(p, '2AD0').note, /trailer ownership/i);
  const a = buildPlan(r, amwins, {});
  for (const re of [/^Vehicles leased to others/, /^Vehicles not owned/, /^Additional interest/]) agentsNote(named(a, re));
  // Owned stays No (vehicle and trailer).
  const owned = buildPlan(expediter(), progressive, { trailers: 0 });
  assert.deepEqual([byQ(owned, '2CA7').value, byQ(owned, '2AD0').value], ['No', 'No']);
});

test('no USDOT number and no 60-day answer: "Has a USDOT number" is the agent\'s', () => {
  const r = with_({ 'applicant.dot': null, 'applicant.mcDotWithin60Days': null });
  agentsNote(byQ(buildPlan(r, progressive, {}), '1ED'));
  r.applicant.mcDotWithin60Days = false;
  assert.match(byQ(buildPlan(r, progressive, {}), '1ED').value, /^No - and/);
  r.applicant.mcDotWithin60Days = true;
  assert.match(byQ(buildPlan(r, progressive, {}), '1ED').value, /^Not Yet/);
  assert.match(byQ(buildPlan(expediter(), progressive, {}), '1ED').value, /^Yes/);
});

test('business structure: a suffix is a corporation, no company is a sole proprietor, a bare name is the agent\'s', () => {
  const structure = (name, carrier, q) => { const s = carrier === progressive ? byQ(buildPlan(with_({ 'applicant.name': name }), progressive, {}), '22D') : bySel(buildPlan(with_({ 'applicant.name': name }), amwins, {}), '#entityType'); return s; };
  assert.equal(structure('Synthetic Expediter LLC', progressive).value, 'Corporation or LLC / Non-Profit');
  assert.equal(structure('Synthetic Expediter Inc.', progressive).value, 'Corporation or LLC / Non-Profit');
  assert.equal(structure(null, progressive).value, 'Individual / Sole Proprietor');
  agentsNote(structure('Synthetic Expediter', progressive));
  // Codex on 2dcd1e8: a bare name's structure is the agent's, never the AI's (clientFact).
  assert.equal(structure('Synthetic Expediter', progressive).manualOnly, true);
  assert.equal(structure('Synthetic Expediter LLC', progressive).manualOnly, false);
  assert.equal(structure(null, progressive).manualOnly, false);
  assert.equal(structure('Synthetic Expediter', amwins).manualOnly, true);
  assert.equal(structure('Synthetic Expediter LLC', amwins).value, 'LLC');
  assert.equal(structure('Synthetic Expediter Corp', amwins).value, 'CORPORATION');
  assert.equal(structure(null, amwins).value, 'SOLE PROPRIETOR');
  agentsNote(structure('Synthetic Expediter', amwins));
});

test('facts the intake lacks are left to the agent: Progressive attestations, AmWINS driver and loss-run questions', () => {
  const p = buildPlan(expediter(), progressive, {});
  for (const q of ['21E', '20F', '83', 'A2', 'AA', 'B2', 'A7', 'A8', 'A9', 'AF', 'B0', '2C97']) {
    assert.ok(AGENT_SOURCES.includes(byQ(p, q).source), `q${q} is the agent's`);
    agentsNote(byQ(p, q));
  }
  assert.match(byQ(p, '20F').note, /belong/i);
  const a = buildPlan(with_({ 'drivers.0.maritalStatus': null, 'applicant.yearEstablished': null }), amwins, {});
  for (const re of [/^Gender/, /^Year licensed/, /^How long with the current carrier/, /^Claim-free loss runs/, /^Valued loss runs/]) {
    const step = named(a, re);
    assert.equal(step.source, 'fact', step.name);
    agentsNote(step);
    assert.match(step.note, /isn't on the intake|yourself/);
  }
  assert.equal(bySel(a, '#driversPanel [data-id="martialStatus"]').value, null, 'no marital status on the intake: left blank, no Married default');
  assert.equal(bySel(a, '#driversPanel [data-id="martialStatus"]').warn, null);
  assert.equal(bySel(a, '#yearBusinessEstablished').value, null, 'no year established: no current-year default');
  const given = buildPlan(expediter(), amwins, {});
  assert.equal(bySel(given, '#driversPanel [data-id="martialStatus"]').value, 'Married', 'the intake\'s marital status is filled');
  assert.equal(bySel(given, '#yearBusinessEstablished').value, 2019);
});

test('derived values that did not move: exclude driver No, for-hire Yes for expediters and freight haulers, note otherwise', () => {
  const p = buildPlan(expediter(), progressive, {});
  assert.deepEqual([byQ(p, '28C1').value, byQ(p, '28C1').source], [false, 'derived']);
  assert.deepEqual([byQ(p, '2C1A').value, byQ(p, '2C1A').source], [true, 'derived']);
  assert.equal(byQ(buildPlan(with_({ 'operations.businessClass': 'Freight Hauler' }), progressive, {}), '2C1A').value, true);
  agentsNote(byQ(buildPlan(with_({ 'operations.businessClass': 'Dump Truck' }), progressive, {}), '2C1A'));
  const a = buildPlan(with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' }), amwins, {});
  for (const sel of ['#natureOfBusiness', '#classCodeAndDescription', '#operationDescription']) agentsNote(bySel(a, sel));
  agentsNote(named(a, /^Usage type/));
  const e = buildPlan(expediter(), amwins, {});
  assert.deepEqual([bySel(e, '#natureOfBusiness').value, bySel(e, '#classCodeAndDescription').search, bySel(e, '#operationDescription').value, named(e, /^Usage type/).value],
    ['TRANSPORTATION', '484122', 'Trucking for Hire - Other for hire trucking', 'FOR HIRE']);
});

test('deductibles are TNI\'s standard $1,000 (no intake deductible field exists)', () => {
  const p = buildPlan(expediter(), progressive, {});
  for (const q of ['1FCD', '1FD2']) assert.deepEqual([byQ(p, q).value, byQ(p, q).standard], ['$1,000 Deductible', true], q);
  assert.ok(byQ(p, '1FCD').choiceAliases.includes('$1,000 Deductible w/ $0 Glass Deductible'));
});

// --- Review mode ------------------------------------------------------------------------------------

test('supportedClass: expediter, freight hauler and general freight; a missing class is unsupported', () => {
  for (const carrier of CARRIERS) {
    assert.equal(supportedClass(expediter(), carrier), true, carrier.id);
    // Codex on 2dcd1e8: AmWINS's freight answers (isFreight) need expediting or general freight.
    assert.equal(supportedClass(with_({ 'operations.businessClass': 'Freight Hauler', 'operations.whatHaul': 'Furniture' }), carrier), carrier === progressive, carrier.id);
    assert.equal(supportedClass(with_({ 'operations.businessClass': 'Freight Hauler', 'operations.whatHaul': 'General freight' }), carrier), true, carrier.id);
    // Progressive's for-hire / business-type answers need an expediter or a freight hauler class;
    // AmWINS's freight answers also read general freight on what they haul.
    assert.equal(supportedClass(with_({ 'operations.businessClass': 'General Freight' }), carrier), carrier === amwins, carrier.id);
    assert.equal(supportedClass(with_({ 'operations.businessClass': 'Dry Van', 'operations.whatHaul': 'General freight' }), carrier), carrier === amwins, carrier.id);
    assert.equal(supportedClass(with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' }), carrier), false);
    assert.equal(supportedClass(with_({ 'operations.businessClass': null, 'operations.whatHaul': 'General freight' }), carrier), false, 'a missing class is unsupported');
    assert.equal(supportedClass(with_({ 'operations.businessClass': '' }), carrier), false);
  }
  assert.equal(supportedClass(with_({ 'operations.businessClass': 'Dump Truck' }), { id: 'geico', rules: [] }), true, 'no classes declared: no gate');
  assert.equal(supportedClass(expediter(), null), true);
});

test('AmWINS: review mode exactly when its freight answers are the agent\'s (one predicate)', () => {
  const classes = [['Expediter', 'Furniture'], ['Freight Hauler', 'Furniture'], ['Freight Hauler', 'General freight'], ['General Freight', null],
    ['Dry Van', 'General freight'], ['Dump Truck', 'Gravel'], ['Box Truck', 'Expedited loads']];
  for (const [cls, haul] of classes) {
    const r = with_({ 'operations.businessClass': cls, 'operations.whatHaul': haul });
    const plan = buildPlan(r, amwins, {});
    const nature = bySel(plan, '#natureOfBusiness');
    assert.equal(supportedClass(r, amwins), nature.note == null, `${cls} / ${haul}`);
    // Outside the class, the standards are check items.
    assert.equal(field(plan).filter((s) => s.standard).every((s) => /Review mode/.test(s.warn ?? '')), !supportedClass(r, amwins), `${cls} / ${haul}`);
  }
});

test('Progressive: review mode exactly when its for-hire answer is the agent\'s (one predicate)', () => {
  const classes = [['Expediter', 'Furniture'], ['Freight Hauler', 'Furniture'], ['General Freight Hauling', null], ['General Freight', null],
    ['Dry Van', 'General freight'], ['Dump Truck', 'Gravel'], ['Box Truck', 'Expedited loads']];
  for (const [cls, haul] of classes) {
    const r = with_({ 'operations.businessClass': cls, 'operations.whatHaul': haul });
    const plan = buildPlan(r, progressive, {});
    assert.equal(supportedClass(r, progressive), byQ(plan, '2C1A').note == null, `${cls} / ${haul}`);
    assert.equal(field(plan).filter((s) => s.standard).every((s) => /Review mode/.test(s.warn ?? '')), !supportedClass(r, progressive), `${cls} / ${haul}`);
  }
});

test('review mode: every standard step is a check item naming the class and carrier; none for an expediter', () => {
  const dump = with_({ 'operations.businessClass': 'Dump Truck', 'operations.whatHaul': 'Gravel' });
  for (const carrier of CARRIERS) {
    const want = `Review mode: the business class "Dump Truck" isn't validated for ${carrier.name}; confirm this standard answer.`;
    assert.equal(reviewWarn(dump, carrier), want);
    const plan = field(buildPlan(dump, carrier, { trailers: 0 }));
    const standards = plan.filter((s) => s.standard);
    assert.ok(standards.length > 5, `${carrier.id}: standards present`);
    for (const s of standards) assert.equal(s.warn, want, `${carrier.id} ${s.name}`);
    for (const s of plan.filter((s) => !s.standard)) assert.ok(!/Review mode/.test(s.warn ?? ''), `${carrier.id} ${s.name}: only standards carry the review warn`);
    const ok = field(buildPlan(expediter(), carrier, { trailers: 0 }));
    for (const s of ok.filter((s) => s.standard)) assert.equal(s.warn, null, `${carrier.id} ${s.name}: no review mode for an expediter`);
  }
  const missing = with_({ 'operations.businessClass': null });
  assert.equal(reviewWarn(missing, progressive), 'Review mode: the business class "not given" isn\'t validated for Progressive; confirm this standard answer.');
  assert.ok(field(buildPlan(missing, progressive, {})).filter((s) => s.standard).every((s) => /"not given"/.test(s.warn)));
});
