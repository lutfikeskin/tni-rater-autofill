import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { canRecord, recordingId, stampEvents, newManifest, recordingFiles } from '../src/recording.js';
import { RecordingStore, fileSystem } from '../sidepanel/recording.js';
import { readRecording, recordingReport } from '../scripts/lib/recording.mjs';

// The developer recording's plain parts, the panel's store on a stand-in for the browser's origin
// private file system, and the report (docs/developer-recording.md).

const build = { version: '0.9.22', channel: 'unpacked', commit: 'abc1234567' };
const manifestFor = (id = 'geico-fl-van-20261023-1412-ab12') => newManifest({ id, carrier: 'geico', scenario: 'FL van', started: '2026-10-23T14:12:00.000Z', build, intake: 'f00d', test: true });

test('only builds that aren\'t the store\'s may record', () => {
  assert.deepEqual(['source', 'unpacked', 'store', null, undefined].map(canRecord), [true, true, false, false, false]);
});

test('a recording is named by carrier, scenario, local time and four hex digits', () => {
  assert.equal(recordingId('geico', 'FL van, hazmat yes/no', new Date(2026, 9, 23, 14, 7), () => 0.5), 'geico-fl-van-hazmat-yes-no-20261023-1407-8000');
  assert.equal(recordingId('amwins', '', new Date(2026, 0, 2, 3, 4), () => 0), 'amwins-unnamed-20260102-0304-0000');
});

test('the panel stamps the trace\'s events with their frame and a fill, and redacts the words', () => {
  const redact = (s) => s.replace(/Sam Smith/g, '[client]');
  const events = stampEvents([
    { kind: 'change', t: 1, seq: 1, field: { key: 'ref:GiveOwner', label: 'Is Sam Smith a driver?', rect: null }, value: 'Sam Smith' },
    { kind: 'click', t: 2, seq: 2, button: { text: 'Save Sam Smith', rect: null } },
    { kind: 'page', t: 3, seq: 3, page: '/quote', title: 'Quote for Sam Smith' },
    { nonsense: true },
  ], { frame: 2, filling: true, redact });
  assert.equal(events.length, 3, 'one without a kind or a time is dropped');
  assert.deepEqual(events.map((e) => [e.frame, e.filling]), [[2, true], [2, true], [2, true]]);
  assert.deepEqual([events[0].field.label, events[0].value, events[0].field.key, events[1].button.text, events[2].title],
    ['Is [client] a driver?', '[client]', 'ref:GiveOwner', 'Save [client]', 'Quote for [client]']);
});

test('a saved recording is its manifest and its events in the order they happened', () => {
  const files = recordingFiles(manifestFor(), [
    { kind: 'click', t: 20, seq: 1, frame: 0 }, { kind: 'gap', t: 15, frame: 0, dropped: 4 }, { kind: 'page', t: 10, seq: 1, frame: 1 },
  ]);
  const manifest = JSON.parse(files['recording.json']);
  assert.deepEqual([manifest.kind, manifest.events, manifest.dropped, manifest.test, manifest.build.channel], ['recording', 3, 4, true, 'unpacked']);
  assert.deepEqual(files['events.jsonl'].trim().split('\n').map((l) => JSON.parse(l).kind), ['page', 'gap', 'click']);
});

// The origin private file system's handles, as much of them as the store uses.
class FakeFile {
  constructor() { this.content = ''; }
  async createWritable() { let buf = ''; return { write: async (t) => { buf += t; }, close: async () => { this.content = buf; } }; }
  async getFile() { const content = this.content; return { text: async () => content }; }
}
class FakeDir {
  constructor() { this.items = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) { return this.#get(name, create, FakeDir); }
  async getFileHandle(name, { create = false } = {}) { return this.#get(name, create, FakeFile); }
  #get(name, create, Kind) {
    if (!this.items.has(name)) { if (!create) throw new Error(`${name}: not found`); this.items.set(name, new Kind()); }
    return this.items.get(name);
  }
  async *entries() { yield* this.items.entries(); }
  async removeEntry(name) { this.items.delete(name); }
}
const unzipText = async (blob) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(([n, b]) => [n, strFromU8(b)]));
const clicks = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ kind: 'click', t: 1000 + from + i, seq: from + i + 1, frame: 0 }));

test('the store writes chunks as it goes, zips the recording as one folder, and forgets it once saved', async () => {
  const root = new FakeDir();
  fileSystem.root = async () => root;
  const store = await RecordingStore.start(manifestFor());
  assert.equal(store.durable, true);
  for (let i = 0; i < 9; i++) await store.add(clicks(50, i * 50));
  const folder = await (await root.getDirectoryHandle('recordings')).getDirectoryHandle(store.manifest.id);
  assert.deepEqual([...folder.items.keys()].sort(), ['events-00001.jsonl', 'events-00002.jsonl', 'recording.json'], 'a chunk every 200 events');
  assert.deepEqual((await RecordingStore.unfinished()).map((m) => m.id), [store.manifest.id]);
  const { blob, events } = await store.zip(new Date('2026-10-23T14:30:00Z'));
  assert.equal(events, 450);
  const files = await unzipText(blob);
  assert.deepEqual(Object.keys(files).sort(), [`${store.manifest.id}/events.jsonl`, `${store.manifest.id}/recording.json`]);
  assert.equal(files[`${store.manifest.id}/events.jsonl`].trim().split('\n').length, 450);
  assert.equal(JSON.parse(files[`${store.manifest.id}/recording.json`]).ended, '2026-10-23T14:30:00.000Z');
  await store.discard();
  assert.deepEqual(await RecordingStore.unfinished(), []);
});

test('a panel closed mid-recording leaves what it wrote, which the next panel saves', async () => {
  const root = new FakeDir();
  fileSystem.root = async () => root;
  const store = await RecordingStore.start(manifestFor('amwins-x-20261023-0900-0001'));
  await store.add(clicks(250));
  await store.add(clicks(30, 250));
  // The panel goes: the 30 events not yet written go with it.
  const again = await RecordingStore.reopen('amwins-x-20261023-0900-0001');
  const { events } = await again.zip();
  assert.equal(events, 250);
});

test('without the file system the recording is kept in memory, and still saved', async () => {
  fileSystem.root = async () => { throw new Error('no OPFS here'); };
  const store = await RecordingStore.start(manifestFor());
  assert.equal(store.durable, false);
  await store.add(clicks(250));
  assert.equal((await store.zip()).events, 250);
  assert.deepEqual(await RecordingStore.unfinished(), []);
});

test('the report tells the flow and each step\'s actions: typing as one line, an answer above the last one, a pause', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const field = (key, label, docY) => ({ key, q: null, kind: 'text', label, rect: { x: 0, y: 0, w: 100, h: 20, docY } });
  const choice = (key, label, docY) => ({ ...field(key, label, docY), kind: 'radio' });
  const events = [
    { kind: 'page', t: t0 + 100, seq: 1, frame: 0, page: '/quote', step: 'Business Class & USDOT', top: true },
    { kind: 'change', t: t0 + 1000, seq: 2, frame: 0, trusted: true, field: choice('ref:Team', 'Team driving?', 600), value: 'No' },
    { kind: 'input', t: t0 + 1001, seq: 3, frame: 0, trusted: true, field: choice('ref:Team', 'Team driving?', 600), value: 'No' },
    { kind: 'key', t: t0 + 1500, seq: 4, frame: 0, printable: true, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'key', t: t0 + 1600, seq: 5, frame: 0, printable: true, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'input', t: t0 + 1610, seq: 6, frame: 0, trusted: true, len: 2, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'note', t: t0 + 6000, frame: 0, text: 'waiting too long' },
    { kind: 'click', t: t0 + 6500, seq: 7, frame: 0, trusted: true, button: { text: 'Next', rect: null } },
    { kind: 'click', t: t0 + 6600, seq: 8, frame: 0, trusted: false, button: { text: 'Recalculate', rect: null } },
    { kind: 'step', t: t0 + 7000, seq: 9, frame: 0, step: 'Business & Owner Info', from: 'Business Class & USDOT' },
    { kind: 'scroll', t: t0 + 7100, seq: 10, frame: 0, x: 0, y: 400, height: 2400 },
    { kind: 'scroll', t: t0 + 7200, seq: 11, frame: 0, x: 0, y: 800, height: 2400 },
  ];
  const files = recordingFiles({ ...manifestFor(), ended: '2026-10-23T14:12:09.000Z' }, events);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-'));
  const zipFile = path.join(dir, 'recording.zip');
  fs.writeFileSync(zipFile, zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [`r/${n}`, strToU8(t)]))));
  const report = recordingReport(readRecording(zipFile));
  // The same from the folder unzipped.
  fs.mkdirSync(path.join(dir, 'r'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'r', n), t);
  assert.equal(recordingReport(readRecording(dir)), report);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(report, /\| 1 \| \/quote · Business Class & USDOT \| 0:00\.1 \| 6\.9 s \| 5 \| "Next" \|/);
  assert.match(report, /\| 2 \| \/quote · Business & Owner Info \| 0:07\.0 \| 2\.0 s \| 1 \| — \|/);
  assert.match(report, /0:01\.0 \(\+0\.9 s\) picked "No" for "Team driving\?"\n/, 'input and change of one pick: one line');
  assert.match(report, /0:01\.5 \(\+0\.5 s\) ↑ typed into "USDOT number": 2 keys, length 2 over 0\.1 s/, 'above the answer before it');
  assert.match(report, /0:06\.0 \(\+4\.5 s, a pause\) NOTE: waiting too long/);
  assert.match(report, /clicked the "Recalculate" button \(not trusted: the page or the extension\)/);
  assert.match(report, /scrolled to y=800 of 2400/);
  assert.ok(!/scrolled to y=400/.test(report), 'a scroll run is one line, where it ended');
});
