// Guards for things that broke (or would break) silently when one part changes without another:
// event types the server doesn't accept, carrier hosts the manifest doesn't allow, versions out of
// step, committed fixtures with client data, docs naming commands that don't exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_FIELDS, COMMON } from '../server/index.mjs';
import { CARRIERS } from '../src/carriers.js';
import { DEFAULT_SERVER } from '../sidepanel/usage-log.js';
import { fillEvents } from '../src/usage.js';
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
  for (const e of fillEvents(frames, { carrier: 'progressive', page: 'P', overwrite: false, ms: 5, redact: (s) => s })) {
    const keep = new Set([...COMMON, ...(EVENT_FIELDS[e.type] ?? [])]);
    const dropped = Object.keys(e).filter((k) => !keep.has(k) && e[k] !== undefined);
    assert.deepEqual(dropped, [], `${e.type}: the server drops ${dropped.join(', ')}`);
  }
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

test('commands named in CLAUDE.md and the README exist', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const doc of ['CLAUDE.md', 'README.md', 'docs/hosting.md']) {
    if (!fs.existsSync(path.join(root, doc))) continue;
    for (const [, name] of read(doc).matchAll(/npm run ([a-z][\w:-]*)/g)) assert.ok(scripts[name], `${doc} names "npm run ${name}", which package.json doesn't have`);
  }
});
