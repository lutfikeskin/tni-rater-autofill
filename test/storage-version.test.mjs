import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIGRATIONS, STORAGE_VERSION, STORAGE_VERSION_KEY, migrateStorage } from '../src/storage-version.js';
import { PANEL_SOURCE } from './panel-source.mjs';

// chrome.storage.local as the migrations use it: get (a key, a list of keys, or null for all), set
// (a patch) and remove (a key or a list), each value copied in and out as Chrome does.
function storageArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  const pick = (keys) => (keys == null ? Object.keys(data) : [].concat(keys)).filter((k) => Object.hasOwn(data, k));
  return {
    data, writes,
    get: async (keys) => Object.fromEntries(pick(keys).map((k) => [k, structuredClone(data[k])])),
    set: async (patch) => { writes.push(['set', Object.keys(patch).sort()]); Object.assign(data, structuredClone(patch)); },
    remove: async (keys) => { writes.push(['remove', [].concat(keys)]); for (const k of [].concat(keys)) delete data[k]; },
  };
}

// What every other stored key holds stays as it was: the agent's corrections, pending AI picks,
// the usage queue and the rest (synthetic values).
const KEPT = {
  agentEditedKeys: [{ scope: 'intake-1', tabId: 4, page: 'Drivers', keys: ['ref:maritalStatus'] }],
  'doneActions:intake-1:4': ['lookupVin:0'],
  aiPendingDecisions: [{ version: 1, scope: 'intake-1', tabId: 4, page: 'Drivers', key: 'k', choice: 'No', done: 'auto', approved: false }],
  usageLog: [{ type: 'intake_loaded', seq: 1 }],
  usageSeq: 1,
  panelWindow: { left: 10, top: 20, width: 420, height: 860 },
};

// A saved copy of what each earlier version stored, and what it is in the latest one.
const SNAPSHOTS = {
  0: {
    before: { ...KEPT, settings: { aiOn: true, lunaKey: 'synthetic-openai', lunaAuto: true, autoAdvance: false, agent: 'agent',
      aiKey: 'synthetic-legacy', jevKey: 'synthetic-retired', jevModel: 'retired-model', aiProvider: 'jev', aiAuto: true } },
    after: { ...KEPT, settings: { aiOn: true, lunaKey: 'synthetic-openai', lunaAuto: true, autoAdvance: false, agent: 'agent' } },
  },
};

test('the migrations are in order, one per version, each reading only the keys it names', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.to), MIGRATIONS.map((_, i) => i + 1));
  assert.equal(STORAGE_VERSION, MIGRATIONS.length);
  for (const m of MIGRATIONS) assert.ok(Array.isArray(m.keys) && m.keys.length, `version ${m.to} names its keys`);
  assert.deepEqual(Object.keys(SNAPSHOTS).map(Number), [...Array(STORAGE_VERSION).keys()], 'a saved copy of every earlier version');
});

test('every earlier version\'s data comes up to the latest, with nothing else changed, and once', async () => {
  for (const [version, { before, after }] of Object.entries(SNAPSHOTS)) {
    const area = storageArea(Number(version) ? { ...before, [STORAGE_VERSION_KEY]: Number(version) } : before);
    assert.deepEqual(await migrateStorage(area), { from: Number(version), to: STORAGE_VERSION });
    assert.deepEqual(area.data, { ...after, [STORAGE_VERSION_KEY]: STORAGE_VERSION }, `from version ${version}`);
    area.writes.length = 0;
    assert.deepEqual(await migrateStorage(area), { from: STORAGE_VERSION, to: STORAGE_VERSION });
    assert.deepEqual(area.writes, [], 'at the latest version: nothing is written');
  }
});

test('a profile with nothing to change only gets its version', async () => {
  const area = storageArea({ ...KEPT, settings: { aiOn: false, autoAdvance: true } });
  await migrateStorage(area);
  assert.deepEqual(area.writes, [['set', [STORAGE_VERSION_KEY]]]);
  assert.deepEqual(area.data, { ...KEPT, settings: { aiOn: false, autoAdvance: true }, [STORAGE_VERSION_KEY]: STORAGE_VERSION });
  const empty = storageArea();
  await migrateStorage(empty);
  assert.deepEqual(empty.data, { [STORAGE_VERSION_KEY]: STORAGE_VERSION }, 'a new install');
});

test('a migration that fails keeps the data as the last one left it, and the next run goes on from there', async () => {
  let broken = true;
  const steps = [
    { to: 1, keys: ['a'], run: ({ a }) => ({ set: { a: a + 1 } }) },
    { to: 2, keys: ['b'], run: ({ b }) => { if (broken) throw new TypeError('synthetic'); return { set: { b: b * 2 }, remove: ['old'] }; } },
    { to: 3, keys: ['b'], run: ({ b }) => ({ set: { b: b + 1 } }) },
  ];
  const area = storageArea({ a: 1, b: 10, old: true, keep: 'x' });
  const result = await migrateStorage(area, steps);
  assert.deepEqual([result.from, result.to, result.failedAt, result.error?.name], [0, 1, 2, 'TypeError']);
  assert.deepEqual(area.data, { a: 2, b: 10, old: true, keep: 'x', [STORAGE_VERSION_KEY]: 1 }, 'never reset: only the first step\'s change, and its version');
  broken = false;
  assert.deepEqual(await migrateStorage(area, steps), { from: 1, to: 3 });
  assert.deepEqual(area.data, { a: 2, b: 21, keep: 'x', [STORAGE_VERSION_KEY]: 3 });
});

// A key moved under another name is written, with the version, before the old one goes: a panel
// closed between the two leaves the old key, never the data lost.
test('a migration\'s write goes before its removals, so stopping between them loses nothing', async () => {
  const steps = [{ to: 1, keys: ['old'], run: ({ old }) => ({ set: { renamed: old }, remove: ['old'] }) }];
  const area = storageArea({ old: 'token' });
  area.remove = async () => { throw new Error('the panel closed'); };
  const result = await migrateStorage(area, steps);
  assert.deepEqual([result.to, result.failedAt], [1, 1]);
  assert.deepEqual(area.data, { old: 'token', renamed: 'token', [STORAGE_VERSION_KEY]: 1 }, 'written; only the old key is left over');
  assert.deepEqual(await migrateStorage(area, steps), { from: 1, to: 1 });
  assert.equal(area.data.renamed, 'token');
});

test('data from a newer build, or with a version that isn\'t one, is left as it is', async () => {
  for (const version of [STORAGE_VERSION + 5, '2', 1.5]) {
    const area = storageArea({ ...SNAPSHOTS[0].before, [STORAGE_VERSION_KEY]: version });
    assert.deepEqual(await migrateStorage(area), { from: version, to: version });
    assert.deepEqual(area.writes, []);
  }
});

test('the panel migrates the stored data first, one copy at a time, and logs a failure without its message', () => {
  const panel = PANEL_SOURCE;
  assert.match(panel, /async function init\(\) \{\s+\/\/[^\n]*\n\s+await migrateStoredData\(\);\s+wire\(\);/);
  assert.match(panel, /navigator\.locks\.request\('rater-storage-version', run\)/);
  const logged = panel.match(/if \(result\.error\) logCrash\(new Error\((.*)\)\);/)?.[1] ?? '';
  assert.match(logged, /^`stored data not migrated.*: \$\{result\.error\?\.name \?\? 'Error'\}`$/);
  assert.doesNotMatch(logged, /message|stack|settings/);
  assert.doesNotMatch(fs.readFileSync(new URL('../sidepanel/usage-log.js', import.meta.url), 'utf8'), /aiKey|jevKey/, 'the readers know only the latest shape');
});
