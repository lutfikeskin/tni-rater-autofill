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

test('Reload now reloads into the new version, except while a fill runs or the AI assistant answers', () => {
  let reloads = 0;
  const sandbox = { state: { filling: true, aiAsking: new Map(), notes: {} }, chrome: { runtime: { reload: () => { reloads++; } } }, updateCard: (v, held) => ({ v, held }) };
  vm.createContext(sandbox);
  vm.runInContext(fn('reloadHeldBy') + fn('reloadNow'), sandbox);
  assert.equal(sandbox.reloadNow('0.9.34'), false);
  assert.equal(reloads, 0);
  assert.match(sandbox.state.notes.updateReady.held, /A fill is running/);
  // The review of #505: an AI answer on its way holds it too (the page's questions, the notes, the names).
  sandbox.state.filling = false;
  for (const asking of [{ aiAsking: new Map([['sig', Promise.resolve()]]) }, { notesAsking: {} }, { namesAsking: {} }]) {
    Object.assign(sandbox.state, { aiAsking: new Map(), notesAsking: null, namesAsking: null }, asking);
    assert.equal(sandbox.reloadNow('0.9.34'), false, Object.keys(asking)[0]);
    assert.match(sandbox.state.notes.updateReady.held, /AI assistant is still answering/);
  }
  Object.assign(sandbox.state, { aiAsking: new Map(), notesAsking: null, namesAsking: null });
  assert.equal(sandbox.reloadNow('0.9.34'), true);
  assert.equal(reloads, 1);
});

// The review of #505: a reload clears the panel's session. With a client loaded, the card says so, and
// that the corrections and checks kept on this computer (kept-work, FLOW-17: test/kept-work.test.mjs)
// come back with the same PDF.
test('the card says what a reload costs when a client is loaded', () => {
  const sandbox = { state: { intake: null }, issueSaid: (x) => x, reloadNow: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(fn('updateCard'), sandbox);
  assert.match(sandbox.updateCard('0.9.34').text, /^Reload now to use it/);
  sandbox.state.intake = { record: {} };
  assert.match(sandbox.updateCard('0.9.34').text, /clears this client from it\. Drop the same PDF again after: your corrections and checks come back/);
  assert.match(sandbox.updateCard('0.9.34', 'held').text, /^held$/);
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
