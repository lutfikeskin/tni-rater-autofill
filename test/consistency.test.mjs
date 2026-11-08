// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
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
import crypto from 'node:crypto';
import { EVENT_FIELDS, COMMON, COMMON_SHAPES, RUN_FIELDS, FIELD_SOURCES, PROFILE, PROFILE_UNITS, ID_LIKE, LIMIT, SCHEMA_VERSION as SERVER_SCHEMA } from '../server/index.mjs';
import * as SCHEMA from '../src/usage-schema.js';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { redactionTerms, SOURCES } from '../src/plan.js';
import { CARRIERS } from '../src/carriers.js';
import { DEFAULT_SERVER } from '../sidepanel/usage-log.js';
import { fillEvents, fieldChangeEvent, intakeProfile, redactor, ID_LIKE as EXTENSION_ID_LIKE, LIMIT as EXTENSION_LIMIT, PROFILE_UNITS as EXTENSION_UNITS } from '../src/usage.js';
import { findPii } from '../scripts/lib/privacy.mjs';
import { PANEL_SOURCE } from './panel-source.mjs';

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
  assert.deepEqual(Object.keys(RUN_FIELDS).sort(), ['defaultsHash', 'rules', 'run', 'settings', 'step']);
  for (const f of ['run', 'rules', 'settings', 'step']) assert.ok(EVENT_FIELDS.fill_run.includes(f), `fill_run keeps ${f}`);
  for (const f of ['run', 'step']) assert.ok(EVENT_FIELDS.fill_field.includes(f), `fill_field keeps ${f}`);
  for (const f of ['run', 'rules', 'settings']) assert.ok(EVENT_FIELDS.fill_error.includes(f), `fill_error keeps ${f} without a fill_run result`);
  assert.ok(EVENT_FIELDS.field_change.includes('step'));
});

// A source the server didn't know would be dropped from every fill_field that carries it. For agent
// defaults (server/agent-defaults.mjs) the server also keeps agent-default, a TNI standard the agent
// replaced with their own default, ahead of any build that sends it.
test('the server keeps every answer source the plan gives, and agent-default', () => {
  assert.deepEqual(FIELD_SOURCES, [...SOURCES, 'agent-default']);
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

// Audit 2026-11-07, SRV-07: the server refuses an event whose common fields are out of their shape.
// Every carrier id and the extension's version fit, or every event naming them would be refused.
test('carrier ids and the extension\'s version are in the shapes the server keeps', () => {
  for (const c of CARRIERS) assert.ok(COMMON_SHAPES.carrier(c.id), `carrier id "${c.id}"`);
  assert.ok(COMMON_SHAPES.v(JSON.parse(read('manifest.json')).version));
  assert.ok(COMMON_SHAPES.v(JSON.parse(read('package.json')).version));
  assert.deepEqual(Object.keys(COMMON_SHAPES).sort(), COMMON.filter((k) => ['t', 'agent', 'session', 'intakeId', 'carrier', 'page', 'v'].includes(k)).sort(),
    'id, channel, commit, install, seq, type and view keep their own checks');
});

// Audit 2026-11-07, SRV-14: the event contract is one module both sides import
// (src/usage-schema.js). A change to it (an event type, a field, a profile group or field) changes
// the fingerprint, and the schema's version must go up with it: an extension that sends the new
// fields is then refused by an older server in words it retries, never stored with them dropped.
const profileShape = (spec) => (typeof spec === 'function' ? true : Array.isArray(spec) ? [profileShape(spec[0])]
  : Object.fromEntries(Object.keys(spec).sort().map((k) => [k, profileShape(spec[k])])));
const schemaFingerprint = () => crypto.createHash('sha256').update(JSON.stringify({
  common: COMMON, events: Object.keys(EVENT_FIELDS).sort().map((t) => [t, EVENT_FIELDS[t]]), profile: profileShape(PROFILE),
})).digest('hex').slice(0, 12);
// Every schema version's fingerprint, one entry a version. A version's entry is never rewritten:
// a contract that changed is a new version with its own entry, so the fingerprint can't be brought
// up to date while the version stays (the review of #378).
const VERSION_FINGERPRINTS = { 1: '4e730dd257f0', 2: '0d8e25c99e6d' };
test('the event contract is shared, and its version goes up whenever it changes', () => {
  assert.equal(COMMON, SCHEMA.COMMON, 'the server keeps the shared COMMON');
  assert.deepEqual(Object.keys(EVENT_FIELDS), Object.keys(SCHEMA.EVENT_FIELDS), 'the server knows every shared event type, and only those');
  for (const [type, fields] of Object.entries(SCHEMA.EVENT_FIELDS)) assert.deepEqual(EVENT_FIELDS[type].slice(0, fields.length), [...fields], type);
  assert.equal(EXTENSION_ID_LIKE, SCHEMA.ID_LIKE);
  assert.equal(SERVER_SCHEMA, SCHEMA.SCHEMA_VERSION);
  const versions = Object.keys(VERSION_FINGERPRINTS).map(Number);
  assert.deepEqual(versions, Array.from({ length: SCHEMA.SCHEMA_VERSION }, (_, i) => i + 1), 'one fingerprint for each version up to the current one');
  assert.equal(new Set(Object.values(VERSION_FINGERPRINTS)).size, versions.length, 'each version a different contract');
  const next = SCHEMA.SCHEMA_VERSION + 1;
  assert.equal(VERSION_FINGERPRINTS[SCHEMA.SCHEMA_VERSION], schemaFingerprint(),
    `the event contract changed: raise SCHEMA_VERSION in src/usage-schema.js to ${next} and add ${next}: '${schemaFingerprint()}' to VERSION_FINGERPRINTS here, leaving the earlier entries as they are`);
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
const keptWhole = (p, label) => { for (const group of EVENT_FIELDS.intake_profile) profileFits(p[group], PROFILE[group], `${label}: ${group}`); };

test('the business profile the extension builds is one the server keeps whole', () => {
  const unit = { type: 'Semi Truck', year: 2019, make: 'Freightliner', model: 'Cascadia', vin: 'x', value: 65000 };
  const record = {
    applicant: { dot: '1234567', mc: '654321', fein: '12-3456789', mcDotWithin60Days: false, yearsInBusiness: 4, yearsExperience: 6, ownerDrives: true },
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
  assert.deepEqual(Object.keys(p).filter((k) => k !== 'type'), EVENT_FIELDS.intake_profile);
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
      for (const leak of ['555-0142', '123-45-6789', '01-05-1980', '01.05.1980', 'S123-4567', 'CA-0193']) assert.ok(!JSON.stringify(p).includes(leak), `${file} #${i} leaks ${leak}`);
    }
  }
});

// Earlier AI clients emitted decision scores; current builders omit them, but ingestion must
// retain valid historical evidence without expanding the fields accepted on other event types.
test('legacy AI evidence is accepted only on decisions and current clients do not emit it', () => {
  const builder = PANEL_SOURCE.match(/function aiDecisionEvent[\s\S]*?\n}/)[0];
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
  const manifest = JSON.parse(read('manifest.json'));
  for (const p of [...manifest.permissions, ...(manifest.optional_permissions ?? [])]) assert.ok(guide.includes(`- \`${p}\`:`), `docs/chrome-web-store.md: say why the extension needs ${p}`);
  // tabGroups warns on install ("View and manage your tab groups"): required, a store update would be
  // disabled for every agent until they accepted it. It is asked for from Settings (src/tab-mark.js).
  assert.ok(!manifest.permissions.includes('tabGroups'));
});

test('the manifest allows every carrier site and the usage server', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const hosts = manifest.host_permissions.map((h) => new URL(h.replace('*.', 'x.').replace(/\/\*$/, '/')).hostname.replace(/^x\./, ''));
  for (const c of CARRIERS.filter((x) => x.id !== 'test')) {
    for (const re of c.hosts) assert.ok(hosts.some((h) => re.test(h) || re.test(`www.${h}`)), `${c.id}: no host permission matches ${re}`);
  }
  assert.ok(hosts.includes(new URL(DEFAULT_SERVER).hostname), 'the usage server needs a host permission');
});

// Audit ENG-01 (the maintainer, 2026-11-07): automatic Continue only on pages the carrier knows. Every
// carrier's advance lists where it may continue (`pages` or `steps`), each a page or step its config
// knows already (its quote strip or layout steps), and none is a page where the carrier stops the
// quote, a step that is the agent's, or one of its fenced pages. The fill log names a page that wasn't.
test('every carrier\'s Continue lists the known pages or steps it may continue on, and no stop or fenced one', () => {
  for (const c of CARRIERS.filter((x) => x.advance)) {
    const { pages = [], steps = [], exceptPages = [] } = c.advance;
    assert.ok(pages.length || steps.length, `${c.id}: advance lists no page or step`);
    const knownPages = new Set((c.quoteSteps ?? []).flatMap((s) => s.pages ?? []));
    for (const p of pages) {
      assert.ok(knownPages.has(p), `${c.id}: ${p} isn't a page of its quote strip`);
      assert.ok(!exceptPages.includes(p) && !c.stopPages?.[p], `${c.id}: ${p} is fenced or a stop page`);
    }
    for (const s of steps) {
      assert.ok((c.layoutSteps ?? []).includes(s), `${c.id}: ${s} isn't one of its steps`);
      assert.ok(!c.stopSteps?.[s], `${c.id}: ${s} is the agent's step`);
    }
    for (const s of c.finishedAt?.steps ?? []) assert.ok(!steps.includes(s), `${c.id}: ${s} ends the quote`);
  }
  const progressive = CARRIERS.find((c) => c.id === 'progressive');
  for (const p of ['AdditionalDetails', 'SaveQuote', 'Quote', 'PrintEmailFax', 'PrintEmailFaxConfirm', 'NoHit', 'BECAPopup', 'DeclinationNotice']) {
    assert.ok(!progressive.advance.pages.includes(p), p);
  }
  const blockers = fillEvents([{ fields: 0, filled: [], blockers: [], unlisted: true }], { carrier: 'progressive', page: 'PaymentDetails', view: 't1', overwrite: false, ms: 1, redact: (s) => s })[0].blockerList;
  assert.deepEqual(blockers, ['continue: page not listed']);
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

test('commands named in AGENTS.md and the README exist', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const doc of ['AGENTS.md', 'README.md', 'docs/hosting.md']) {
    if (!fs.existsSync(path.join(root, doc))) continue;
    for (const [, name] of read(doc).matchAll(/npm run ([a-z][\w:-]*)/g)) assert.ok(scripts[name], `${doc} names "npm run ${name}", which package.json doesn't have`);
  }
});

// Audit 2026-11-07, ORG-12: the README named capture folders that were never committed. A
// repository path a document names in backticks (one under the repository's own folders, with no
// placeholder) or links to is a tracked file or folder, or one of these, each named as what it is.
const NOT_TRACKED = {
  'src/content/pagekit.js': 'built from src/kit/ by scripts/lib/kit.mjs',
  'docs/HANDOFF.md': 'a local note, named as local',
  'docs/kesif-plani.md': 'a local file outside the repository, named as such',
  'src/content/page-watch.js': "developer-recording.md's proposal, not built",
  'test/fixtures/recording': "developer-recording.md's proposal, not built",
  'summary.json': "a file inside a developer recording's zip",
  'recording.json': "a file inside a developer recording's zip",
  '.claude/worktrees': 'local git worktrees agents work in, ignored',
  'THIRD_PARTY_NOTICES.txt': 'written into each packaged copy by scripts/package.mjs',
};
// A document's paths that aren't in the repository: backticked ones under its own folders, backticked
// file names with no folder (a root file, or a tracked file's own name), and relative links.
function unknownPaths(text, doc, tracked, names) {
  const ticked = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/[),.;:]+$/, '').replace(/#L?\d.*$/, '').replace(/:\d+(-\d+)?$/, ''))
    .filter((p) => !/[<>*{}$|]/.test(p));
  const named = ticked.filter((p) => /^(src|scripts|test|docs|server|sidepanel|lib|icons|captures|\.github|\.claude)\//.test(p));
  // A file name: one of the repository's extensions, or a root file's stem with another one
  // (`manifest.jso`), never a property like `state.aiAsking`.
  const stems = new Set([...tracked].filter((f) => !f.includes('/') && f.includes('.')).map((n) => n.replace(/\.[^.]+$/, '')));
  const bare = ticked.filter((p) => /^[\w-]+(\.[\w-]+)*\.\w+$/.test(p) && !tracked.has(p) && !names.has(p)
    && (/\.(?:js|mjs|cjs|jsx|json|md|ya?ml|html|toml|txt)$/.test(p) || stems.has(p.replace(/\.[^.]+$/, ''))));
  const linked = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:|^#/.test(l))
    // A link starting with / is from the repository's root, as GitHub reads it.
    .map((l) => decodeURIComponent(l.replace(/#.*$/, '')))
    .map((l) => path.posix.normalize(l.startsWith('/') ? l.slice(1) : path.posix.join(path.posix.dirname(doc), l)));
  return [...named, ...linked, ...bare].map((x) => x.replace(/\/$/, '')).filter((p) => !tracked.has(p) && !NOT_TRACKED[p]);
}
test('a misspelled path is found, in a folder, at the root or in a link', () => {
  const tracked = new Set(['manifest.json', 'src', 'src/usage.js', 'docs', 'docs/testing.md']);
  const names = new Set(['manifest.json', 'usage.js', 'testing.md']);
  const text = '`src/usag.js`, `manifest.jso`, `usage.js`, `manifest.json`, `fill_run`, `README.md` [x](testng.md) [y](testing.md) [z](/manifest.json) [w](/docs/testng.md)';
  assert.deepEqual(unknownPaths(text, 'docs/a.md', tracked, names), ['src/usag.js', 'docs/testng.md', 'docs/testng.md', 'manifest.jso', 'README.md']);
});
test('paths the README, AGENTS.md and docs/ name are in the repository', (t) => {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    t.skip('git is not available here (a packaged copy, or no repository)');
    return;
  }
  const tracked = new Set(files);
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) tracked.add(f.slice(0, i));
  const names = new Set(files.map((f) => path.posix.basename(f)));
  const docs = ['README.md', 'AGENTS.md', ...files.filter((f) => /^docs\/[^/]+\.md$/.test(f))];
  const missing = docs.flatMap((doc) => unknownPaths(read(doc), doc, tracked, names).map((p) => `${doc}: ${p}`));
  assert.deepEqual([...new Set(missing)], [], 'not in the repository: fix the path, or say it is local or built and add it to NOT_TRACKED');
});
