// Guards for things that broke (or would break) silently when one part changes without another:
// event types the server doesn't accept, carrier hosts the manifest doesn't allow, versions out of
// step, committed fixtures with client data, docs naming commands that don't exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EVENT_FIELDS, COMMON, RUN_FIELDS, PROFILE, PROFILE_UNITS, ID_LIKE, LIMIT, MATCH_KINDS } from '../server/index.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { redactionTerms } from '../src/plan.js';
import { CARRIERS } from '../src/carriers.js';
import { DEFAULT_SERVER } from '../sidepanel/usage-log.js';
import { fillEvents, fieldChangeEvent, intakeProfile, redactor, ID_LIKE as EXTENSION_ID_LIKE, LIMIT as EXTENSION_LIMIT, PROFILE_UNITS as EXTENSION_UNITS } from '../src/usage.js';
import { findPii } from '../scripts/lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

test('every usage event type the extension sends is one the server accepts', () => {
  const sources = ['src/usage.js', ...walk('sidepanel').filter((f) => f.endsWith('.js')), ...walk('src/ai').filter((f) => f.endsWith('.js'))];
  const types = new Set(sources.flatMap((f) => [...read(f).matchAll(/type: '([a-z]+_[a-z_]+)'/g)].map((m) => m[1])).filter((t) => t !== 'json_schema'));
  assert.ok(types.size >= 10, `found ${types.size} event types`);
  for (const t of types) assert.ok(EVENT_FIELDS[t], `the server would refuse "${t}" events: add it to EVENT_FIELDS in server/index.mjs`);
});

test('fill events carry only fields the server keeps (nothing silently dropped)', () => {
  const frames = [{ fields: 3, rounds: 2, filled: [{ label: 'A', key: 'a', q: '1', path: 'x', controlKind: 'text', shown: 'v', timing: { ms: 1 } }],
    unknown: [{ label: 'B', key: 'b', controlKind: 'radio', options: ['Yes', 'No'] }], failed: [], noData: [], kept: [], leftRequired: [],
    actions: [{ id: 'act', text: 'Go' }], blockers: ['unfamiliar: B'], advanced: 'Continue', checks: [] }];
  // With the run-identity fields too (Contract 1, audit 2026-10-08): the server must keep them.
  const settings = { autoAdvance: true, autoFollowUps: true, autoPages: false, overwrite: false };
  for (const e of fillEvents(frames, { carrier: 'amwins', page: 'P', overwrite: false, ms: 5, redact: (s) => s, run: '4c1e0b7a-run-id', rules: 'abcdef012345', settings, step: 'Vehicles' })) {
    const keep = new Set([...COMMON, ...(EVENT_FIELDS[e.type] ?? [])]);
    const dropped = Object.keys(e).filter((k) => !keep.has(k) && e[k] !== undefined);
    assert.deepEqual(dropped, [], `${e.type}: the server drops ${dropped.join(', ')}`);
    for (const [k, valid] of Object.entries(RUN_FIELDS)) if (e[k] !== undefined) assert.ok(valid(e[k]), `${e.type}.${k} as the extension sends it would be refused`);
  }
  assert.deepEqual(Object.keys(RUN_FIELDS).sort(), ['rules', 'run', 'settings', 'step']);
  for (const f of ['run', 'rules', 'settings', 'step']) assert.ok(EVENT_FIELDS.fill_run.includes(f), `fill_run keeps ${f}`);
  for (const f of ['run', 'step']) assert.ok(EVENT_FIELDS.fill_field.includes(f), `fill_field keeps ${f}`);
  for (const f of ['run', 'rules', 'settings']) assert.ok(EVENT_FIELDS.fill_error.includes(f), `fill_error keeps ${f} without a fill_run result`);
  assert.ok(EVENT_FIELDS.field_change.includes('step'));
});

// Audit 2026-10-08: field changes too, text and choice alike.
test('field change events carry only fields the server keeps', () => {
  const ctx = { record: { drivers: [{ dob: '01/02/1980' }] }, filled: new Map([['k', { path: 'x', shown: 'a' }]]), redact: (s) => s, keySalt: 'salt' };
  const changes = [
    { key: 'k', q: '1', label: 'A', kind: 'text', before: 'a', after: '01/02/1980', agent: true },
    { key: 'k', q: '1', label: 'A', kind: 'select', before: 'a', after: 'b', agent: false },
  ];
  for (const c of changes) {
    const e = { carrier: 'progressive', page: 'P', view: 't1', ...fieldChangeEvent(c, { ...ctx, step: 'Vehicles' }) };
    assert.ok(RUN_FIELDS.step(e.step), 'the step as the extension sends it is kept');
    const keep = new Set([...COMMON, ...EVENT_FIELDS[e.type]]);
    const dropped = Object.keys(e).filter((k) => !keep.has(k) && e[k] !== undefined);
    assert.deepEqual(dropped, [], `${c.kind}: the server drops ${dropped.join(', ')}`);
  }
});

// The business profile: every value the extension sends fits the server's shape for it, and each
// side knows the other's fields, so nothing is dropped on the way and nothing is sent unchecked.
const profileFits = (v, spec, where) => {
  if (typeof spec === 'function') return assert.ok(spec(v), `${where}: the server would leave out ${JSON.stringify(v)}`);
  if (Array.isArray(spec)) {
    assert.ok(Array.isArray(v) && v.length <= PROFILE_UNITS, `${where}: not a list of at most ${PROFILE_UNITS}`);
    return v.forEach((x, i) => profileFits(x, spec[0], `${where}[${i}]`));
  }
  assert.deepEqual(Object.keys(v).sort(), Object.keys(spec).sort(), `${where}: the extension sends every field the server has a shape for, and no other`);
  for (const k of Object.keys(v)) profileFits(v[k], spec[k], `${where}.${k}`);
};
// The contact isn't kept but turned into match codes: every value the server takes is text.
const keptWhole = (p, label) => {
  for (const group of Object.keys(PROFILE)) profileFits(p[group], PROFILE[group], `${label}: ${group}`);
  assert.deepEqual(Object.keys(p.contact), MATCH_KINDS, `${label}: contact`);
  for (const k of MATCH_KINDS) assert.ok(p.contact[k] === null || (typeof p.contact[k] === 'string' && p.contact[k].length <= 200), `${label}: contact.${k}`);
};

test('the business profile the extension builds is one the server keeps whole', () => {
  const unit = { type: 'Semi Truck', year: 2019, make: 'Freightliner', model: 'Cascadia', vin: 'x', value: 65000 };
  const record = {
    applicant: { dot: '1234567', mc: '654321', fein: '12-3456789', mcDotWithin60Days: false, yearsInBusiness: 4, yearsExperience: 6, ownerDrives: true,
      email: 'owner@sample-trucking.test', phone: '(555) 010-0199' },
    garaging: { state: 'TX' },
    operations: { businessClass: 'Freight Hauler', whatHaul: 'General freight', radius: '500 miles', radiusMiles: 500, vehicleOwnership: 'Owned', personalUse: false, usesEld: true, eldBrand: 'Motive',
      needSr22: false, filingsRequired: true, filingsWhich: 'MCS-90', hazmat: false, hazPlacard: false, movingState: false, teamDriving: false, canadaLoads: false, equipVehicle: 5000 },
    vehicles: Array(PROFILE_UNITS + 1).fill(unit), trailers: [{ ...unit, type: 'Dry Van' }],
    trailerInfo: { ownership: 'Owned', hitch: 'Fifth wheel', interchange: true, interchangeLimit: '$20,000', equipTrailer: 2000 },
    drivers: [{ dob: '02/03/1985', licenseState: 'TX', cdl: true, cdlYear: 2010, excluded: false, maritalStatus: 'Married', gender: 'FEMALE' }],
    coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: true, hasGl: false, glLimit: '$1M/$2M', reeferBreakdown: false, ntl: false },
    priorInsurance: [{ type: 'Commercial Auto', carrier: 'Progressive', limit: '$1M CSL', expiration: '11/30/2026' }],
    claims: { hasClaims: false },
  };
  const p = intakeProfile(record, { today: new Date('2026-10-22') });
  assert.deepEqual(Object.keys(p).filter((k) => k !== 'type'), EVENT_FIELDS.intake_profile.filter((k) => k !== 'match'), 'the server makes the codes');
  assert.equal(EXTENSION_UNITS, PROFILE_UNITS);
  assert.equal(String(EXTENSION_ID_LIKE), String(ID_LIKE), 'the extension and the server refuse the same text');
  assert.equal(String(EXTENSION_LIMIT), String(LIMIT), 'and take the same limits as written');
  keptWhole(p, 'synthetic');
  assert.deepEqual([p.business.dot, p.business.mc, p.business.fein], ['given', 'given', 'given']);
  // The record above fills every value, so a value the extension can't send in its shape shows.
  const leaves = (v) => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v]);
  assert.ok(!leaves(p).includes(null), `a value came out null: ${JSON.stringify(p)}`);
});

// Real intakes as normalizeIntake reads them, with what agents' intakes hold: an invalid date kept
// as written, "Pending" in an ID box, limits typed by hand, identifiers in free text. A hand-built
// record missed the invalid expiry month (review of PR #149).
test('profiles of real intakes, odd values included, are ones the server keeps whole', async () => {
  const fixtures = ['test/fixtures/sample-intake.pdf', 'test/fixtures/sample-intake-2026-10.pdf'];
  const odd = [
    {},
    { ins_exp_1: '13/01/2026', ins_limit_1: '25/50/25', dot_number: 'Pending', mc_number: 'applied for', fein: '12345', auto_liab_limit: '$1000000 CSL', gen_liab_limit: '1000000' },
    { what_haul: 'Steel, call 312-555-0142 or (312) 555-0142', eld_brand: 'Motive 123-45-6789', filings_which: 'MCS-90, BMC-91 policy CA-0193-4471', ins_carrier_1: 'Progressive S123-4567-8901', ins_limit_1: '100/300/100' },
    { drv_dob_1: '01-05-1980', ins_exp_1: '02/30/2026', veh_make_1: 'Ford 01.05.1980', ins_limit_1: '123-45-6789', ins_carrier_1: 'None' },
  ];
  for (const file of fixtures) {
    const raw = await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(path.join(root, file))));
    for (const [i, over] of odd.entries()) {
      const { record } = normalizeIntake({ ...raw, ...over }, { today: new Date('2026-10-22') });
      const p = intakeProfile(record, { redact: redactor(redactionTerms(record)), today: new Date('2026-10-22') });
      keptWhole(p, `${file} #${i}`);
      for (const leak of ['555-0142', '123-45-6789', '01-05-1980', '01.05.1980', 'S123-4567', 'CA-0193']) assert.ok(!JSON.stringify({ ...p, contact: undefined }).includes(leak), `${file} #${i} leaks ${leak}`);
    }
  }
});

// Earlier AI clients emitted decision scores; current builders omit them, but ingestion must
// retain valid historical evidence without expanding the fields accepted on other event types.
test('legacy AI evidence is accepted only on decisions and current clients do not emit it', () => {
  const builder = read('sidepanel/sidepanel.js').match(/function aiDecisionEvent[\s\S]*?\n}/)[0];
  for (const legacy of ['probability', 'support', 'evidenceProbability', 'confidence']) {
    assert.ok(EVENT_FIELDS.ai_decision.includes(legacy));
    assert.doesNotMatch(builder, new RegExp(`\\b${legacy}\\s*:`), `current decisions omit ${legacy}`);
    for (const [type, fields] of Object.entries(EVENT_FIELDS)) if (type !== 'ai_decision') assert.ok(!fields.includes(legacy), `${type} does not accept ${legacy}`);
  }
  assert.ok(!Object.values(EVENT_FIELDS).flat().includes('cached'));
});

// The store's Privacy practices tab asks why for each permission (docs/chrome-web-store.md has the text).
test('every permission the manifest asks for has its justification in the store guide', () => {
  const guide = read('docs/chrome-web-store.md');
  for (const p of JSON.parse(read('manifest.json')).permissions) assert.ok(guide.includes(`- \`${p}\`:`), `docs/chrome-web-store.md: say why the extension needs ${p}`);
});

test('the manifest allows every carrier site and the usage server', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const hosts = manifest.host_permissions.map((h) => new URL(h.replace('*.', 'x.').replace(/\/\*$/, '/')).hostname.replace(/^x\./, ''));
  for (const c of CARRIERS.filter((x) => x.id !== 'test')) {
    for (const re of c.hosts) assert.ok(hosts.some((h) => re.test(h) || re.test(`www.${h}`)), `${c.id}: no host permission matches ${re}`);
  }
  assert.ok(hosts.includes(new URL(DEFAULT_SERVER).hostname), 'the usage server needs a host permission');
});

test('the manifest fits the Chrome Web Store limits', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} characters; the store allows 132`);
  assert.ok(manifest.name.length <= 75, 'name over 75 characters');
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, 'version must be up to four dot-separated numbers');
});

test('manifest and package versions match', () => {
  assert.equal(JSON.parse(read('manifest.json')).version, JSON.parse(read('package.json')).version);
});

test('committed fixtures and captures hold no client data', () => {
  // captures/ may hold only ignored generated layouts, so a fresh checkout has none.
  const captures = fs.existsSync(path.join(root, 'captures')) ? walk('captures').filter((f) => !f.includes('generated')) : [];
  const files = [...walk('test/fixtures'), ...captures].filter((f) => /\.(json|html|js|md)$/.test(f));
  for (const f of files) {
    const hits = findPii(read(f));
    assert.deepEqual(hits.slice(0, 5), [], `${f} looks like it holds client data`);
  }
});

// Audit 2026-10-08 (finding 14): raw captures live in ignored layouts/; 16 were committed the day
// before the ignore rule and stayed tracked. Nothing under layouts/ may be tracked, and whatever is
// gets the scanner too. The message names files and hit counts only, never what matched.
test('no file under layouts/ is tracked in git', (t) => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--', 'layouts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    t.skip('git is not available here (a packaged copy, or no repository)');
    return;
  }
  const report = tracked.map((f) => {
    let hits = 0;
    try { hits = findPii(read(f)).length; } catch { hits = -1; }
    return `${f}${hits > 0 ? ` (${hits} possible client-data hit${hits === 1 ? '' : 's'})` : hits < 0 ? ' (unreadable)' : ''}`;
  });
  assert.deepEqual(report, [], `tracked under layouts/, which .gitignore reserves for raw captures: run git rm --cached on these:\n${report.join('\n')}`);
});

test('commands named in CLAUDE.md and the README exist', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const doc of ['CLAUDE.md', 'README.md', 'docs/hosting.md']) {
    if (!fs.existsSync(path.join(root, doc))) continue;
    for (const [, name] of read(doc).matchAll(/npm run ([a-z][\w:-]*)/g)) assert.ok(scripts[name], `${doc} names "npm run ${name}", which package.json doesn't have`);
  }
});
