// Audit 2026-11-07, GAP-07: a panel kept open ran the old build until Chrome swapped it, and nobody was
// told. The worker keeps the version Chrome downloaded; the panel says it with Reload now, which never
// reloads under a running fill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../sidepanel/panel/update-ready.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
};

test('Reload now reloads into the new version, except while a fill runs', () => {
  let reloads = 0;
  const sandbox = { state: { filling: true, notes: {} }, chrome: { runtime: { reload: () => { reloads++; } } }, updateCard: (v, busy) => ({ v, busy }) };
  vm.createContext(sandbox);
  vm.runInContext(fn('reloadNow'), sandbox);
  assert.equal(sandbox.reloadNow('0.9.34'), false);
  assert.deepEqual([reloads, sandbox.state.notes.updateReady], [0, { v: '0.9.34', busy: true }], 'a fill runs: the card says to wait');
  sandbox.state.filling = false;
  assert.equal(sandbox.reloadNow('0.9.34'), true);
  assert.equal(reloads, 1);
});

test('the card shows only a version newer than the one running', async () => {
  const { compareVersions } = await import('../src/whats-new.js');
  const sandbox = { state: { notes: {} }, compareVersions, chrome: { runtime: { getManifest: () => ({ version: '0.9.33' }) } }, updateCard: (v) => ({ v }) };
  vm.createContext(sandbox);
  vm.runInContext(fn('say'), sandbox);
  sandbox.say('0.9.34');
  assert.deepEqual(sandbox.state.notes.updateReady, { v: '0.9.34' });
  for (const old of ['0.9.33', '0.9.2', undefined, 7]) {
    sandbox.say(old);
    assert.equal(sandbox.state.notes.updateReady, null, String(old));
  }
});

test('the worker keeps a downloaded version and drops it once one is installed', () => {
  const worker = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(worker, /chrome\.runtime\.onUpdateAvailable\.addListener\(\(\{ version \}\) => \{\s*chrome\.storage\.local\.set\(\{ updateReady: version \}\)/);
  assert.match(worker, /chrome\.runtime\.onInstalled\.addListener\(\(\) => \{ chrome\.storage\.local\.remove\('updateReady'\)/);
  const panel = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /mountNote\(\$\('update-ready'\), 'updateReady'\)/);
  assert.match(panel, /showUpdateReady\(\);/);
});
