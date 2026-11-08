// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WHATS_NEW, WHATS_NEW_LINE_MAX, compareVersions, whatsNewSince } from '../src/whats-new.js';

// "What's new in vX" (audit 2026-11-07, UX-12 c): the lines written at a release, and which an agent
// is told once after an update.

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test("what's new: each version's lines are short plain lines, for a version already released or this one", () => {
  for (const [version, lines] of Object.entries(WHATS_NEW)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, version);
    assert.ok(compareVersions(version, manifest.version) <= 0, `${version} is newer than the manifest's ${manifest.version}`);
    assert.ok(Array.isArray(lines) && lines.length >= 1 && lines.length <= 5, `${version}: 1 to 5 lines`);
    for (const line of lines) {
      assert.equal(typeof line, 'string');
      assert.ok(line.trim() && line.length <= WHATS_NEW_LINE_MAX, `${version}: "${line}"`);
      assert.doesNotMatch(line, /[<>]/, `${version}: plain text`);
    }
  }
});

test('versions compare by their numbers, not as text', () => {
  assert.ok(compareVersions('0.9.10', '0.9.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.32') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('0.9.32', '0.9.33') < 0);
});

test('an agent is told what changed since the version last said, newest first, and once caught up nothing', () => {
  const notes = { '0.9.30': ['a'], '0.9.31': [], '0.9.32': ['b', 'c'], '0.9.33': ['d'], '0.10.0': ['e'] };
  // Updated from 0.9.30 to 0.10.0: everything after 0.9.30, newest first, the empty 0.9.31 left out.
  assert.deepEqual(whatsNewSince('0.9.30', '0.10.0', notes), [
    { version: '0.10.0', lines: ['e'] }, { version: '0.9.33', lines: ['d'] }, { version: '0.9.32', lines: ['b', 'c'] }]);
  // Never said (an update from before the card): this version's own only.
  assert.deepEqual(whatsNewSince(null, '0.9.32', notes), [{ version: '0.9.32', lines: ['b', 'c'] }]);
  assert.deepEqual(whatsNewSince(null, '0.9.31', notes), []);
  // Already said, or a version later than the one running (a rollback): nothing.
  assert.deepEqual(whatsNewSince('0.9.33', '0.9.33', notes), []);
  assert.deepEqual(whatsNewSince('0.10.0', '0.9.33', notes), []);
});

// background.js's onInstalled, run with a stub chrome: where the card starts.
async function installed(details, stored = {}) {
  const bg = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const start = bg.indexOf('chrome.runtime.onInstalled.addListener(');
  const end = bg.indexOf('\n});', start) + 4;
  let listener;
  const data = { ...stored };
  const chrome = { runtime: { getManifest: () => ({ version: '0.9.40' }), onInstalled: { addListener: (f) => { listener = f; } } },
    storage: { local: { get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } } } };
  new Function('chrome', bg.slice(start, end))(chrome);
  listener(details);
  await new Promise((r) => setTimeout(r, 0));
  return data.whatsNewSeen;
}

test('a new install starts from its own version; an update with none said yet from the version it updated from', async () => {
  assert.equal(await installed({ reason: 'install' }), '0.9.40', "a new install isn't told what changed before it");
  // An update the panel wasn't opened after: every version since the one updated from is said.
  assert.equal(await installed({ reason: 'update', previousVersion: '0.9.31' }), '0.9.31');
  // A version already said stays: the card says what is new since it.
  assert.equal(await installed({ reason: 'update', previousVersion: '0.9.38' }, { whatsNewSeen: '0.9.35' }), '0.9.35');
  assert.equal(await installed({ reason: 'chrome_update' }), undefined);
});
