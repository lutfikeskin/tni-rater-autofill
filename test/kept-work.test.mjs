// Audit 2026-11-07, FLOW-17 (the maintainer: kept on this computer for 24 hours): a browser restart
// mid-quote emptied the session's intake, and with it every correction and check the agent made in
// the panel. Each corrected field's path and value and each check done are kept in local storage,
// one key per intake, for a day from their last change (src/kept-work.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEPT_WORK_MS, KEPT_WORK_PREFIX, checksOn, keptFresh, keptWorkOf, pruneKeptWork } from '../src/kept-work.js';
import { get } from '../src/util.js';

const warnings = [
  { code: 'drivers.cdl', path: 'drivers[0].cdl' },
  { code: 'drivers.cdl', path: 'drivers[1].cdl' },
  { code: 'garaging.zip', path: 'garaging.zip' },
  { code: 'drivers.cdl', path: 'drivers[1].cdl' },
];

test('kept: each corrected value by its path and each check by its warning, nothing else of the record', () => {
  const intake = { record: { garaging: { zip: '33101', city: 'Miami' }, drivers: [{ first: 'Ann' }] }, warnings, agentEdited: ['garaging.zip', 'drivers[0].dob'], done: [3, 2, 9] };
  const kept = keptWorkOf(intake, get, 1000);
  assert.deepEqual(kept, { at: 1000, edits: [['garaging.zip', '33101'], ['drivers[0].dob', null]], checks: [
    { code: 'drivers.cdl', path: 'drivers[1].cdl', n: 1 }, { code: 'garaging.zip', path: 'garaging.zip', n: 0 }] });
  assert.ok(!JSON.stringify(kept).includes('Miami') && !JSON.stringify(kept).includes('Ann'), 'only corrected values');
  assert.equal(keptWorkOf({ record: {}, warnings, agentEdited: [], done: [] }, get), null, 'nothing to keep');
});

test('the checks are found again on the same intake read again, whatever was added to its list', () => {
  const checks = [{ code: 'drivers.cdl', path: 'drivers[1].cdl', n: 1 }, { code: 'garaging.zip', path: 'garaging.zip', n: 0 }, { code: 'gone', path: 'x', n: 0 }];
  assert.deepEqual(checksOn(warnings, checks), [3, 2]);
  // A warning added before them (Luna's, say) moves their indexes, not their identities.
  assert.deepEqual(checksOn([{ code: 'notes.claims', path: 'claims.text' }, ...warnings], checks), [4, 3]);
});

test('a day from the last change: an older one, or one from the future, is not fresh', () => {
  const now = 10 * KEPT_WORK_MS;
  assert.ok(keptFresh({ at: now - KEPT_WORK_MS + 1 }, now));
  assert.ok(!keptFresh({ at: now - KEPT_WORK_MS }, now));
  assert.ok(!keptFresh({ at: now + 1 }, now));
  assert.ok(!keptFresh(null, now));
});

test('pruned: past its day, and every other intake\'s for a new client, all of them for a cleared one', async () => {
  const now = 10 * KEPT_WORK_MS;
  const store = {
    [`${KEPT_WORK_PREFIX}a`]: { at: now - 1000 }, [`${KEPT_WORK_PREFIX}b`]: { at: now - KEPT_WORK_MS - 1 }, [`${KEPT_WORK_PREFIX}c`]: { at: now - 5 },
    usageLog: [1, 2, 3],
  };
  const read = [];
  const local = {
    getKeys: async () => Object.keys(store),
    get: async (k) => { read.push(k); return Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, store[x]])); },
    remove: async (k) => { for (const x of k) delete store[x]; },
  };
  assert.deepEqual(await pruneKeptWork(local, { now }), [`${KEPT_WORK_PREFIX}b`]);
  assert.ok(read.every((k) => Array.isArray(k) && !k.includes('usageLog')), 'the usage queue is never read');
  assert.deepEqual(await pruneKeptWork(local, { now, except: 'c' }), [`${KEPT_WORK_PREFIX}a`]);
  assert.deepEqual(Object.keys(store).sort(), [`${KEPT_WORK_PREFIX}c`, 'usageLog']);
  assert.deepEqual(await pruneKeptWork(local, { now, all: true }), [`${KEPT_WORK_PREFIX}c`]);
  assert.deepEqual(Object.keys(store), ['usageLog']);
});

// #436 review: a Clear that failed is tried again later, for what was kept before it only (`before`):
// a correction made since, for the next client, stays.
test('a Clear tried again deletes what was kept before it, nothing kept since', async () => {
  const now = Date.now();
  const store = { [`${KEPT_WORK_PREFIX}a`]: { at: now - 5000, edits: [], checks: [] }, [`${KEPT_WORK_PREFIX}b`]: { at: now - 10, edits: [], checks: [] } };
  const local = { getKeys: async () => Object.keys(store), get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, store[x]])), remove: async (k) => { for (const x of k) delete store[x]; } };
  assert.deepEqual(await pruneKeptWork(local, { now, before: now - 1000 }), [`${KEPT_WORK_PREFIX}a`]);
  assert.deepEqual(Object.keys(store), [`${KEPT_WORK_PREFIX}b`]);
});

test('Chrome starting deletes what is past its day, panel open or not', () => {
  const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /import \{ pruneKeptWork \} from '\.\/src\/kept-work\.js';/);
  assert.match(background, /chrome\.runtime\.onStartup\.addListener\(\(\) => \{ pruneKeptWork\(chrome\.storage\.local\)/);
});
