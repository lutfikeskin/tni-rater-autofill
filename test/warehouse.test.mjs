import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadEvents, readEvents } from '../scripts/lib/events.mjs';
import { TABLES, VIEWS, eventRows, warehouseRows, writeWarehouse } from '../scripts/lib/warehouse.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-'));

function profile(over = {}) {
  return {
    business: { state: 'TX', businessClass: 'General freight', dot: 'blank', mc: 'blank', fein: 'given', dotWithin60Days: true, yearsInBusiness: 0, yearsExperience: 0, ownerDrives: true },
    operations: { whatHaul: 'Dry goods', radiusMiles: 500, vehicleOwnership: 'Owned', personalUse: false, usesEld: true, eldBrand: 'Motive', needSr22: null, filingsRequired: true, filingsWhich: 'MCS-90', hazmat: false, hazPlacard: null, movingState: false, teamDriving: false, canadaLoads: null, equipVehicle: 0 },
    vehicles: [{ type: 'Semi Truck', year: 2019, make: 'Freightliner', model: 'Cascadia', value: 85000 }, { type: 'Pickup Truck', year: 2021, make: 'Ford', model: 'F-350', value: 40000 }],
    trailers: [{ type: 'Dry Van', year: 2018, make: 'Utility', model: null, value: 30000 }],
    trailerInfo: { ownership: 'Owned', hitch: 'Fifth wheel', interchange: false, interchangeLimit: null, equipTrailer: null },
    drivers: [{ age: 41, licenseState: 'TX', cdl: true, cdlYear: 2010, excluded: false, maritalStatus: 'Married', gender: null }],
    coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, hasGl: null, glLimit: null, reeferBreakdown: null, ntl: null },
    priorInsurance: [{ type: 'Auto liability', carrier: 'Acme Mutual', limit: '$750,000', expires: '2026-12' }],
    hasClaims: false,
    ...over,
  };
}

// Three quotes and a PDF never taken to a carrier: a client's Progressive quote with two profiles
// (the agent corrected the intake), a quote marked as a test on GEICO, a listed test intake, and
// events of the local test page.
// Each session's intake fingerprint (SHA-256 hex of its PDF in real logs).
const INTAKE = { client: 'c1'.repeat(32), marked: 'a2'.repeat(32), listed: 'b3'.repeat(32), pdfonly: 'd4'.repeat(32), testpage: 'e5'.repeat(32) };
const LISTED = 'b3b3b3b3';

function history() {
  const events = [];
  let t = Date.parse('2026-11-02T14:00:00Z');
  const e = (session, x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), receivedAt: new Date(t + 500).toISOString(), session, v: '0.9.21', channel: 'store', agent: 'AB', install: 'i1', intakeId: INTAKE[session], ...x });
  e('client', { type: 'intake_loaded', state: 'TX', businessClass: 'General freight', vehicleTypes: ['Semi Truck', 'Pickup Truck'], counts: { drivers: 1, vehicles: 2, trailers: 1 }, coverages: ['autoLiability', 'cargo'] });
  e('client', { type: 'intake_profile', ...profile() });
  e('client', { type: 'page_view', carrier: 'progressive', page: 'BusinessOwnerInfo' });
  e('client', { type: 'fill_field', carrier: 'progressive', page: 'BusinessOwnerInfo', q: '1A', key: 'ref:Policy.PriorCarrier', label: 'Prior carrier?', controlKind: 'select', result: 'filled', shown: 'No', source: 'standard', path: 'priorInsurance' });
  e('client', { type: 'fill_field', carrier: 'progressive', page: 'BusinessOwnerInfo', q: '1B', key: 'ref:Policy.Radius', label: 'Radius', controlKind: 'select', result: 'filled', shown: '500 miles', source: 'intake', path: 'operations.radiusMiles' });
  e('client', { type: 'fill_field', carrier: 'progressive', page: 'BusinessOwnerInfo', q: '1C', key: 'ref:Policy.Agent', label: 'Agent Code', result: 'unfamiliar' });
  e('client', { type: 'field_change', carrier: 'progressive', page: 'BusinessOwnerInfo', q: '1A', key: 'ref:Policy.PriorCarrier', label: 'Prior carrier?', kind: 'select', by: 'agent', autofilled: true, vsAutofill: 'different', from: 'No', to: 'Yes' });
  e('client', { type: 'fill_run', carrier: 'progressive', page: 'BusinessOwnerInfo', blockers: 0, blockerList: [] });
  // The agent fixed the USDOT number in the panel: the last profile is the quote's.
  e('client', { type: 'intake_profile', ...profile({ business: { ...profile().business, dot: 'given', dotWithin60Days: false }, coverage: undefined, dropped: ['coverage'] }) });
  e('client', { type: 'page_view', carrier: 'progressive', page: 'Quote', from: 'BusinessOwnerInfo' });
  e('client', { type: 'fill_run', carrier: 'progressive', page: 'Quote', blockers: 0, blockerList: [] });

  e('marked', { type: 'intake_loaded', test: true, state: 'FL', businessClass: 'Towing', vehicleTypes: ['Tow Truck'], counts: { drivers: 2, vehicles: 1, trailers: 0 }, coverages: [] });
  e('marked', { type: 'page_view', carrier: 'geico', page: 'quote', step: 'Vehicles' });
  e('listed', { type: 'intake_loaded', state: 'GA', vehicleTypes: [], counts: { drivers: 1, vehicles: 1, trailers: 0 }, coverages: [] });
  e('listed', { type: 'page_view', carrier: 'amwins', page: 'application', step: 'Coverages' });
  // Loaded, never taken to a carrier: no quote.
  e('pdfonly', { type: 'intake_loaded', state: 'NC', vehicleTypes: [], counts: { drivers: 0, vehicles: 0, trailers: 0 }, coverages: [] });
  // The local test page: stored, but no agent's work.
  e('testpage', { type: 'intake_loaded', state: 'MD' });
  e('testpage', { type: 'page_view', carrier: 'test', page: 'index' });
  return events;
}

const query = async (file, sql) => {
  const instance = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
  const db = await instance.connect();
  try { return (await db.runAndReadAll(sql)).getRowObjectsJS(); } finally { db.closeSync(); instance.closeSync(); }
};

test('warehouseRows counts quotes as the reviews do, with the last profile and the final answers', () => {
  const rows = warehouseRows(history(), { testIntakes: [LISTED] });
  const quotes = Object.fromEntries(rows.quotes.map((q) => [q.session, q]));
  // The PDF never taken to a carrier and the local test page aren't quotes.
  assert.deepEqual(Object.keys(quotes).sort(), ['client', 'listed', 'marked']);
  assert.deepEqual(Object.fromEntries(rows.quotes.map((q) => [q.session, q.is_test])), { client: false, marked: true, listed: true });

  const c = quotes.client;
  assert.equal(c.profile_source, 'event');
  assert.equal(c.dot, 'given', 'the last profile, after the agent fixed the USDOT number');
  assert.equal(c.dot_within_60_days, false);
  assert.equal(c.fein, 'given');
  assert.equal(c.radius_miles, 500);
  assert.equal(c.state, 'TX');
  assert.deepEqual(c.profile_dropped, ['coverage']);
  // The server dropped the coverage group: no limits, not "no coverage".
  assert.equal(c.auto_liab_limit, null);
  assert.equal(c.cargo, null);
  assert.deepEqual(c.requested, ['autoLiability', 'cargo']);
  assert.deepEqual(c.vehicle_types, ['Semi Truck', 'Pickup Truck']);
  assert.deepEqual([c.drivers, c.vehicles, c.trailers], [1, 2, 1]);
  assert.equal(c.has_claims, false);
  assert.ok(!('dropped' in c.profile) && !('id' in c.profile), 'the profile column holds the profile only');

  // A quote without a profile keeps the summary logged on load, and nulls for the rest.
  const m = quotes.marked;
  assert.equal(m.profile_source, null);
  assert.equal(m.state, 'FL');
  assert.equal(m.business_class, 'Towing');
  assert.equal(m.dot, null);
  assert.equal(m.hazmat, null);
  assert.deepEqual(m.vehicle_types, ['Tow Truck']);
  assert.deepEqual([m.drivers, m.vehicles, m.trailers], [2, 1, 0]);

  assert.deepEqual(rows.quote_vehicles.map((v) => [v.kind, v.n, v.type, v.year]), [['vehicle', 1, 'Semi Truck', 2019], ['vehicle', 2, 'Pickup Truck', 2021], ['trailer', 1, 'Dry Van', 2018]]);
  assert.deepEqual(rows.quote_drivers, [{ session: 'client', n: 1, age: 41, license_state: 'TX', cdl: true, cdl_year: 2010, excluded: false, marital_status: 'Married', gender: null }]);
  assert.deepEqual(rows.quote_prior_insurance, [{ session: 'client', n: 1, type: 'Auto liability', insurer: 'Acme Mutual', policy_limit: '$750,000', expires: '2026-12' }]);

  const carriers = Object.fromEntries(rows.quote_carriers.map((q) => [q.session, q]));
  assert.equal(carriers.client.outcome, 'done');
  assert.equal(carriers.client.last_page, 'Quote');
  assert.equal(carriers.marked.outcome, 'stopped');
  assert.equal(carriers.marked.last_page, 'quote › Vehicles');

  const answers = Object.fromEntries(rows.answers.map((a) => [a.label, a]));
  assert.equal(answers['Prior carrier?'].question, 'progressive|BusinessOwnerInfo|ref:Policy.PriorCarrier');
  // No vehicle, driver or trailer (`view`), first row.
  assert.equal(answers['Prior carrier?'].unit, '@1');
  assert.deepEqual(
    ['value', 'answered_by', 'rule_source', 'corrected', 'intake_path'].map((k) => answers['Prior carrier?'][k]),
    ['Yes', 'agent', 'standard', true, 'priorInsurance'],
    "the agent's answer, and the TNI standard it replaced",
  );
  assert.deepEqual(['value', 'answered_by', 'rule_source', 'corrected'].map((k) => answers.Radius[k]), ['500 miles', 'autofill', 'intake', false]);
  assert.deepEqual(['value', 'answered_by', 'left_to_agent'].map((k) => answers['Agent Code'][k]), [null, null, true]);
});

test('a malformed value from an unchecked export becomes null instead of stopping the build', () => {
  const events = history();
  const p = events.find((e) => e.type === 'intake_profile');
  Object.assign(p, { business: { ...p.business, yearsInBusiness: '12', state: 7 }, drivers: [{ age: 1e12, gender: 'MALE' }, 'not a driver'], vehicles: 'none' });
  // The later profile wins; make it the malformed one.
  events.filter((e) => e.type === 'intake_profile')[1].business = p.business;
  const rows = warehouseRows(events);
  const c = rows.quotes.find((q) => q.session === 'client');
  assert.equal(c.years_in_business, null);
  assert.equal(c.state, '7', 'a number as text, never a crash');
  const first = warehouseRows([...events.slice(0, 2), ...events.slice(2).filter((e) => e.type !== 'intake_profile')]);
  const d = first.quote_drivers.filter((x) => x.session === 'client');
  assert.deepEqual(d.map((x) => [x.age, x.gender]), [[null, 'MALE']]);
  assert.equal(first.quote_vehicles.filter((v) => v.session === 'client' && v.kind === 'vehicle').length, 0);
});

test('writeWarehouse builds a DuckDB file whose tables, views and comments follow TABLES', async () => {
  const dir = tmp();
  const file = path.join(dir, 'w.duckdb');
  const events = history();
  const rows = warehouseRows(events, { testIntakes: [LISTED] });
  await writeWarehouse(file, { events: eventRows(events), ...rows, build_info: [{ built_at: '2026-11-03T00:00:00Z', commit: 'abc', dirty: false, sources: ['x'], events: events.length, quotes: 3, test_quotes: 2, test_list: 'list.txt', first_event: null, last_event: null }] });

  const columns = await query(file, 'SELECT table_name, column_name, data_type FROM duckdb_columns() ORDER BY table_name, column_index');
  for (const [name, { columns: want }] of Object.entries(TABLES)) {
    assert.deepEqual(columns.filter((c) => c.table_name === name).map((c) => c.column_name), want.map(([c]) => c), name);
  }
  const comments = await query(file, "SELECT count(*) AS n FROM duckdb_columns() WHERE comment IS NOT NULL AND table_name = 'quote_drivers' AND column_name = 'gender'");
  assert.equal(comments[0].n, 1n);
  const views = await query(file, 'SELECT view_name FROM duckdb_views() WHERE NOT internal');
  assert.deepEqual(views.map((v) => v.view_name), Object.keys(VIEWS));

  // Every stored event, the local test page's too; only the client's quote in v_quotes.
  assert.equal((await query(file, 'SELECT count(*) AS n FROM events'))[0].n, BigInt(events.length));
  assert.deepEqual((await query(file, 'SELECT session, state, dot, requested, vehicle_types FROM v_quotes')), [{ session: 'client', state: 'TX', dot: 'given', requested: ['autoLiability', 'cargo'], vehicle_types: ['Semi Truck', 'Pickup Truck'] }]);
  const [loaded] = await query(file, "SELECT body->>'state' AS state, typeof(t) AS t FROM events WHERE session = 'client' AND type = 'intake_loaded'");
  assert.deepEqual(loaded, { state: 'TX', t: 'TIMESTAMP WITH TIME ZONE' });
  const [answer] = await query(file, "SELECT answered_by, rule_source, corrected FROM answers WHERE label = 'Prior carrier?'");
  assert.deepEqual(answer, { answered_by: 'agent', rule_source: 'standard', corrected: true });
  const [profileJson] = await query(file, "SELECT profile->>'$.business.dot' AS dot FROM quotes WHERE session = 'client'");
  assert.equal(profileJson.dot, 'given');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The ```sql blocks in a section of docs/quoting-history-database.md.
const docSql = (heading) => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'quoting-history-database.md'), 'utf8');
  const section = doc.split(/^## /m).find((s) => s.startsWith(`${heading}\n`));
  assert.ok(section, `no "## ${heading}" section`);
  return [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
};

test("every query in the document's Example SQL runs on the warehouse, and the coverage map's proposed tables fit it", async () => {
  const dir = tmp();
  const file = path.join(dir, 'w.duckdb');
  const events = history();
  await writeWarehouse(file, { events: eventRows(events), ...warehouseRows(events, { testIntakes: [LISTED] }), build_info: [] });
  const examples = docSql('Example SQL');
  assert.ok(examples.length >= 10, `${examples.length} examples`);
  for (const sql of examples) {
    await assert.doesNotReject(query(file, sql), sql);
  }
  // Test runs are left out.
  const months = await query(file, examples[0]);
  assert.deepEqual(months.map((r) => [r.state, Number(r.quotes)]), [['TX', 1]]);

  // The coverage map isn't built: its proposed table and views must still fit the tables they read.
  const proposed = docSql('Design');
  assert.equal(proposed.length, 1);
  const instance = await DuckDBInstance.create(file);
  const db = await instance.connect();
  try {
    await db.run(proposed[0]);
    assert.equal((await db.runAndReadAll('SELECT count(*) FROM unmapped_coverage_questions')).getRows().length, 1);
  } finally { db.closeSync(); instance.closeSync(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm run warehouse builds the file from a log folder and replaces it on the next run', () => {
  const dir = tmp();
  const data = path.join(dir, 'server-data');
  fs.mkdirSync(path.join(data, 'events'), { recursive: true });
  const events = history();
  fs.writeFileSync(path.join(data, 'events', '2026-11-02.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const list = path.join(dir, 'test-intakes.txt');
  fs.writeFileSync(list, `# test runs\n${LISTED}\n`);
  const out = path.join(data, 'warehouse.duckdb');
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'warehouse.mjs'), data, '--tests', list, '--out', out], { cwd: dir, encoding: 'utf8' });

  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${events.length} events, 3 quotes \\(2 test runs, left out of v_quotes\\)`));
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(`${out}.building`));
  // Its own file isn't read back as usage data.
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${events.length} events, 3 quotes`));

  r = spawnSync(process.execPath, [path.join(root, 'scripts', 'warehouse.mjs'), data, '--tests', path.join(dir, 'missing.txt'), '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readEvents keeps every stored event once; loadEvents reads the same events as before', () => {
  const dir = tmp();
  const events = history();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [...events, events[0]].map((e) => JSON.stringify(e)).join('\n'));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify({ id: 'r1', t: '2026-11-02T15:00:00Z', session: 'client', carrier: 'progressive', type: 'page_view', page: 'Quote-Reload' }) + '\n'
    + JSON.stringify({ id: 'b1', t: '2026-11-02T15:00:01Z', session: 'client', carrier: 'progressive', type: 'page_view', page: 'blank' }));
  const stored = readEvents([dir]);
  assert.equal(stored.length, events.length + 2);
  assert.equal(stored.find((e) => e.id === 'r1').page, 'Quote-Reload', 'as stored');
  const loaded = loadEvents([dir], stored);
  assert.deepEqual(loaded, loadEvents([dir]));
  assert.equal(loaded.find((e) => e.id === 'r1').page, 'Quote');
  assert.ok(!loaded.some((e) => e.id === 'b1' || e.carrier === 'test'));
  fs.rmSync(dir, { recursive: true, force: true });
});
