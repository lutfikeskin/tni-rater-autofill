import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { canRecord, recordingId, stampEvents, newManifest, recordingFiles } from '../src/recording.js';
import { RecordingStore, fileSystem } from '../sidepanel/recording.js';
import { cliArgs, readRecording, recordingReport } from '../scripts/lib/recording.mjs';

// The developer recording's plain parts, the panel's store on a stand-in for the browser's origin
// private file system, and the report (docs/developer-recording.md).

const build = { version: '0.9.22', channel: 'unpacked', commit: 'abc1234567' };
const manifestFor = (id = 'geico-fl-van-20261023-1412-ab12') => newManifest({ id, carrier: 'geico', scenario: 'FL van', started: '2026-10-23T14:12:00.000Z', build, intake: 'f00d', test: true });

// Live recording, 2026-10-23: `npm run recording -- <zip>` said "Usage" (the first argument was
// skipped when there was no --out).
test('npm run recording takes the recording as the first argument, with or without --out', () => {
  assert.deepEqual(cliArgs(['a.zip']), { source: 'a.zip', out: null });
  assert.deepEqual(cliArgs(['a.zip', '--out', 'r.md']), { source: 'a.zip', out: 'r.md' });
  assert.deepEqual(cliArgs(['--out', 'r.md', 'a.zip']), { source: 'a.zip', out: 'r.md' });
  assert.deepEqual(cliArgs([]), { source: null, out: null });
});

test('only builds that aren\'t the store\'s may record', () => {
  assert.deepEqual(['source', 'unpacked', 'store', null, undefined].map(canRecord), [true, true, false, false, false]);
});

test('a recording is named by carrier, scenario, local time and four hex digits', () => {
  assert.equal(recordingId('geico', 'FL van, hazmat yes/no', new Date(2026, 9, 23, 14, 7), () => 0.5), 'geico-fl-van-hazmat-yes-no-20261023-1407-8000');
  assert.equal(recordingId('amwins', '', new Date(2026, 0, 2, 3, 4), () => 0), 'amwins-unnamed-20260102-0304-0000');
});

test('the panel stamps the trace\'s events with their frame and a fill by their own time, and redacts the words', () => {
  const redact = (s) => s.replace(/Sam Smith/g, '[client]');
  const events = stampEvents([
    { kind: 'change', t: 1, seq: 1, field: { key: 'ref:GiveOwner', label: 'Is Sam Smith a driver?', rect: null }, value: 'Sam Smith' },
    { kind: 'click', t: 2, seq: 2, button: { text: 'Save Sam Smith', rect: null } },
    { kind: 'page', t: 3, seq: 3, page: '/quote', title: 'Quote for Sam Smith' },
    { nonsense: true },
  ], { frame: 2, fillingAt: (t) => t >= 2, redact });
  assert.equal(events.length, 3, 'one without a kind or a time is dropped');
  assert.deepEqual(events.map((e) => [e.frame, e.filling ?? false]), [[2, false], [2, true], [2, true]]);
  assert.deepEqual([events[0].field.label, events[0].value, events[0].field.key, events[1].button.text, events[2].title],
    ['Is [client] a driver?', '[client]', 'ref:GiveOwner', 'Save [client]', 'Quote for [client]']);
});

// Live recording, 2026-10-23: Progressive's page headings were kept as steps, splitting its pages
// and naming the drivers ("A few more questions about …").
test('a step is kept only as one of the carrier\'s step names, redacted; a step event naming none goes', () => {
  const steps = ['Business Class & USDOT', 'Vehicles'];
  const stepName = (headings) => headings.split(' / ').find((h) => steps.includes(h)) ?? null;
  const events = stampEvents([
    { kind: 'page', t: 1, page: 'AddDriver', step: 'A few more questions about SAM / Driving History' },
    { kind: 'step', t: 2, step: 'A few more questions about SAM: / Driving History', from: 'A few more questions about SAM / Driving History' },
    { kind: 'page', t: 3, page: '/quote', step: 'Dashboard / Business Class & USDOT' },
    { kind: 'step', t: 4, step: 'Vehicles', from: 'Business Class & USDOT' },
  ], { stepName, redact: (s) => s.replace('SAM', '[client]') });
  assert.deepEqual(events.map((e) => [e.kind, e.step, e.from ?? null]), [
    ['page', null, null], ['page', 'Business Class & USDOT', null], ['step', 'Vehicles', 'Business Class & USDOT'],
  ]);
  assert.ok(!JSON.stringify(events).includes('SAM'), 'no heading with a name in it is kept');
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

// Review of PR #166: a recording saved the next day from a panel closed mid-recording said it ran a
// day. Its end isn't known: none in its manifest, and the report says it was cut short.
test('a recording saved from a closed panel has no end, and the report says it was cut short', async () => {
  const root = new FakeDir();
  fileSystem.root = async () => root;
  const store = await RecordingStore.start(manifestFor('amwins-x-20261023-0900-0002'));
  await store.add(clicks(250));
  const again = await RecordingStore.reopen('amwins-x-20261023-0900-0002');
  const files = await unzipText((await again.zip()).blob);
  const manifest = JSON.parse(files['amwins-x-20261023-0900-0002/recording.json']);
  assert.equal(manifest.ended, null);
  assert.match(recordingReport({ manifest, events: [] }), /cut short \(no end\)/);
});

test('without the file system the recording is kept in memory, and still saved', async () => {
  fileSystem.root = async () => { throw new Error('no OPFS here'); };
  const store = await RecordingStore.start(manifestFor());
  assert.equal(store.durable, false);
  await store.add(clicks(250));
  assert.equal((await store.zip()).events, 250);
  assert.deepEqual(await RecordingStore.unfinished(), []);
});

// Live recording, 2026-10-23: the fill's radio picks read as the agent's (a script's click on a radio
// fires trusted events), its typing as "0 keys", and each frame said the tab was hidden.
test('the report tells the flow and each step\'s actions: whose each is, typing as one line, an answer above the last one, a pause', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const field = (key, label, docY) => ({ key, q: null, kind: 'text', label, rect: { x: 0, y: 0, w: 100, h: 20, docY } });
  const choice = (key, label, docY) => ({ ...field(key, label, docY), kind: 'radio' });
  const events = [
    { kind: 'page', t: t0 + 100, seq: 1, frame: 0, page: '/quote', step: 'Business Class & USDOT', top: true },
    { kind: 'change', t: t0 + 1000, seq: 2, frame: 0, trusted: true, gestureMs: 120, field: choice('ref:Team', 'Team driving?', 600), value: 'No' },
    { kind: 'input', t: t0 + 1001, seq: 3, frame: 0, trusted: true, gestureMs: 121, field: choice('ref:Team', 'Team driving?', 600), value: 'No' },
    { kind: 'fill', t: t0 + 1100, frame: 0, on: true },
    { kind: 'change', t: t0 + 1200, seq: 4, frame: 0, trusted: true, gestureMs: null, filling: true, field: choice('ref:Haz', 'Hazmat placard?', 700), value: 'No' },
    { kind: 'input', t: t0 + 1250, seq: 5, frame: 0, trusted: false, gestureMs: null, filling: true, len: 7, field: field('ref:Name', 'Business name', 650) },
    { kind: 'fill', t: t0 + 1400, frame: 0, on: false },
    { kind: 'key', t: t0 + 1500, seq: 6, frame: 0, printable: true, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'key', t: t0 + 1600, seq: 7, frame: 0, printable: true, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'input', t: t0 + 1610, seq: 8, frame: 0, trusted: true, gestureMs: 10, len: 2, field: field('ref:Dot', 'USDOT number', 300) },
    { kind: 'note', t: t0 + 6000, frame: 0, text: 'waiting too long' },
    { kind: 'click', t: t0 + 6500, seq: 9, frame: 0, trusted: true, button: { text: 'Next', rect: null } },
    { kind: 'click', t: t0 + 6600, seq: 10, frame: 0, trusted: false, button: { text: 'Recalculate', rect: null } },
    { kind: 'visible', t: t0 + 6700, seq: 11, frame: 0, state: 'hidden' },
    { kind: 'visible', t: t0 + 6700, seq: 1, frame: 3, state: 'hidden' },
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

  assert.match(report, /\| 1 \| \/quote · Business Class & USDOT \| 0:00\.1 \| 6\.9 s \| 10 \| "Next" \(you\) \|/);
  assert.match(report, /\| 2 \| \/quote · Business & Owner Info \| 0:07\.0 \| 2\.0 s \| 1 \| — \|/);
  assert.match(report, /0:01\.0 \(\+0\.9 s\) picked "No" for "Team driving\?"\n/, 'yours, with your gesture; input and change of one pick: one line');
  assert.match(report, /0:01\.1 \(\+0\.1 s\) a fill started\n.*set "No" for "Hazmat placard\?" \(not you, during a fill\)\n.*↑ set "Business name" \(length 7\) \(not you, during a fill\)\n.*the fill ended \(it ran 0\.3 s\)/,
    'a trusted pick with no gesture of yours is not yours; typing with no keys is set');
  assert.match(report, /0:01\.5 \(\+0\.1 s\) ↑ typed into "USDOT number": 2 keys, length 2 over 0\.1 s/, 'above the answer before it');
  assert.match(report, /0:06\.0 \(\+4\.5 s, a pause\) NOTE: waiting too long/);
  assert.match(report, /clicked the "Next" button\n.*clicked the "Recalculate" button \(the page\)/);
  assert.equal(report.match(/the tab became hidden/g)?.length, 1, 'once, from the top frame');
  assert.match(report, /scrolled to y=800 of 2400/);
  assert.ok(!/scrolled to y=400/.test(report), 'a scroll run is one line, where it ended');
});

// The page's own changes and requests and the extension's account (docs/developer-recording.md):
// what may name the client is redacted as a field's label is.
test('the questions a page drew, a request\'s path and what the fill answered are redacted as a field is', () => {
  const redact = (s) => s.replace(/Sam Smith/g, '[client]');
  const [burst, request, answer, press] = stampEvents([
    { kind: 'burst', t: 1, end: 2, records: 3, drawn: [{ key: 'ref:Lic', kind: 'text', label: 'Sam Smith\'s license' }], drawnCount: 1 },
    { kind: 'request', t: 1, end: 5, ms: 4, path: '/drivers/Sam Smith/save', via: 'xhr' },
    { kind: 'kit', t: 3, what: 'answer', field: { key: 'ref:Lic', label: 'Sam Smith\'s license' }, stepKind: 'text', ok: true, start: 2, applyMs: 1 },
    { kind: 'kit', t: 4, what: 'press', button: { text: 'Save Sam Smith' }, how: 'page' },
  ], { redact });
  assert.deepEqual([burst.drawn[0].label, burst.drawn[0].key, request.path, answer.field.label, press.button.text],
    ['[client]\'s license', 'ref:Lic', '/drivers/[client]/save', '[client]\'s license', 'Save [client]']);
  // A key that is no data-model name, built from a control's name or id, is redacted too (review of
  // PR #257); a data-model name is kept as it is, as above.
  const [change, drew] = stampEvents([
    { kind: 'change', t: 5, field: { key: 'name:Sam Smith-dob', label: 'Date of birth', rect: null }, value: '' },
    { kind: 'burst', t: 6, end: 7, records: 1, drawn: [{ key: 'id:Sam Smith_license', kind: 'text', label: 'License' }], drawnCount: 1 },
  ], { redact });
  assert.deepEqual([change.field.key, drew.drawn[0].key], ['name:[client]-dob', 'id:[client]_license']);
});

test('the report tells what the fill answered and waited for, what the page drew and when, and where each step\'s time went', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const at = (ms) => t0 + ms;
  const events = [
    { kind: 'page', t: at(100), seq: 1, frame: 0, page: '/quote', step: 'Vehicles', top: true },
    { kind: 'fill', t: at(1000), frame: 0, on: true },
    { kind: 'kit', t: at(1000), seq: 2, frame: 0, what: 'run', on: true, steps: 2 },
    { kind: 'kit', t: at(1700), seq: 3, frame: 0, what: 'answer', field: { key: 'ref:Year', label: 'Vehicle year' }, stepKind: 'choice', ok: true, start: at(1100), applyMs: 400,
      timing: { ms: 600, settleMs: 200, ajax: 1, revealed: 2, removed: 0, changed: 0 } },
    { kind: 'kit', t: at(1700), seq: 4, frame: 0, what: 'wait', why: 'answer', quietMs: 150, maxMs: 3000, requests: false, start: at(1500), ms: 200, ended: 'quiet' },
    { kind: 'request', t: at(1550), seq: 5, frame: 0, path: '/api/vin', end: at(1650), ms: 100, via: 'xhr' },
    { kind: 'burst', t: at(1600), seq: 6, frame: 0, end: at(1640), records: 9, drawn: [{ key: 'ref:Make', kind: 'select', label: 'Make' }, { key: 'ref:Model', kind: 'select', label: 'Model' }], drawnCount: 3 },
    { kind: 'kit', t: at(4000), seq: 7, frame: 0, what: 'wait', why: 'continue', quietMs: 500, maxMs: 6000, requests: false, start: at(2000), ms: 2000, ended: 'quiet' },
    { kind: 'kit', t: at(4100), seq: 8, frame: 0, what: 'press', button: { text: 'Continue' }, how: 'page' },
    { kind: 'kit', t: at(10200), seq: 9, frame: 0, what: 'wait', why: 'rated', quietMs: 250, maxMs: 6000, requests: true, start: at(4200), ms: 6000, ended: 'limit', settled: false, held: { busy: true, changing: false, requests: false } },
    { kind: 'burst', t: at(4300), seq: 10, frame: 0, end: at(4310), records: 1 },
    { kind: 'kit', t: at(10300), seq: 11, frame: 0, what: 'run', on: false, filled: 1, halted: false },
    { kind: 'fill', t: at(10300), frame: 0, on: false },
    { kind: 'step', t: at(12000), seq: 12, frame: 0, step: 'Drivers', from: 'Vehicles' },
    { kind: 'click', t: at(13000), seq: 13, frame: 0, trusted: true, button: { text: 'Next', rect: null } },
  ];
  const files = recordingFiles({ ...manifestFor(), ended: '2026-10-23T14:12:14.000Z' }, events);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  const report = recordingReport(readRecording(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(report, /0:01\.1 \(\+0\.1 s\) the extension answered "Vehicle year" in 0\.4 s, then waited 0\.2 s for the page, 1 request, it drew 2\n/, 'by when it began, its own wait folded in');
  assert.ok(!/waited 0\.2 s after an answer/.test(report), 'an answer\'s wait is on its answer\'s line');
  assert.match(report, /the page drew 3 questions \("Make", "Model", …\), 0\.5 s after the last action/);
  assert.equal(report.match(/the page (drew|took away)/g).length, 1, 'a burst that drew no question is no line');
  assert.match(report, /0:02\.0 \(\+0\.4 s\) the extension waited 2\.0 s before pressing Continue \(quiet 500 ms\): the page was quiet; the page did nothing during it\n/, 'nothing changed during it: all slack');
  assert.match(report, /the extension pressed the "Continue" button/);
  assert.match(report, /the extension waited 6\.0 s for the premium \(quiet 250 ms and its requests\): at its limit of 6\.0 s, the page still busy; 5\.9 s after the page's last change/);
  assert.match(report, /## Where the time went/);
  assert.match(report, /\| 1 \| \/quote · Vehicles \| 11\.9 s \| 9\.3 s \| 1 \| 8\.2 s \| 7\.9 s \| 1 \(0\.1 s\) \| 2\.6 s \|/);
  assert.match(report, /\| 2 \| \/quote · Drivers \| 2\.0 s \| 0\.0 s \| 0 \| 0\.0 s \| 0\.0 s \| 0 \(0\.0 s\) \| 2\.0 s \|/);
  assert.match(report, /\| \| All \| 13\.9 s \| 9\.3 s \| 1 \| 8\.2 s \| 7\.9 s \| 1 \(0\.1 s\) \| 4\.6 s \|/);
  // A recording without the extension's account has no such table.
  const older = recordingReport({ manifest: manifestFor(), events: events.filter((e) => e.kind !== 'kit') });
  assert.ok(!/Where the time went/.test(older));
});

// Review of PR #257: a wait begun on one step and ended on the next counted whole on the next, which
// could then show more waiting than time on screen.
test('a wait that crosses into the next step counts on each step by the part of it there', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const events = [
    { kind: 'page', t: t0, seq: 1, frame: 0, page: '/quote', step: 'Vehicles', top: true },
    { kind: 'fill', t: t0 + 100, frame: 0, on: true },
    { kind: 'kit', t: t0 + 200, seq: 2, frame: 0, what: 'answer', field: { key: 'ref:Year', label: 'Year' }, ok: true, start: t0 + 150, applyMs: 50 },
    { kind: 'step', t: t0 + 2000, seq: 3, frame: 0, step: 'Drivers', from: 'Vehicles' },
    { kind: 'kit', t: t0 + 2500, seq: 4, frame: 0, what: 'wait', why: 'continue', quietMs: 500, maxMs: 6000, start: t0 + 1000, ms: 1500, ended: 'quiet' },
    { kind: 'fill', t: t0 + 2600, frame: 0, on: false },
  ];
  const report = recordingReport({ manifest: { ...manifestFor(), ended: '2026-10-23T14:12:03.000Z' }, events });
  // Nothing of the page during the wait: all of it slack, 1.0 s on Vehicles and 0.5 s on Drivers.
  assert.match(report, /\| 1 \| \/quote · Vehicles \| 2\.0 s \| 1\.9 s \| 1 \| 1\.0 s \| 1\.0 s \| 0 \(0\.0 s\) \| 0\.1 s \|/);
  assert.match(report, /\| 2 \| \/quote · Drivers \| 1\.0 s \| 0\.6 s \| 0 \| 0\.5 s \| 0\.5 s \| 0 \(0\.0 s\) \| 0\.4 s \|/);
  assert.match(report, /\| \| All \| 3\.0 s \| 2\.5 s \| 1 \| 1\.5 s \| 1\.5 s \| 0 \(0\.0 s\) \| 0\.5 s \|/);
  // Told on the step it began on, after the answer before it, never before the step's start.
  const vehicles = report.split('## 1. ')[1].split('## 2. ')[0];
  assert.match(vehicles, /answered "Year"[^\n]*\n- 0:01\.0 \(\+0\.8 s\) the extension waited 1\.5 s /);
  assert.doesNotMatch(report.split('## 2. ')[1], /waited 1\.5 s/);
  assert.doesNotMatch(report, /\+-/);
  // The same wait in another frame at the same time (the fill runs in every frame): counted once.
  const framed = recordingReport({ manifest: { ...manifestFor(), ended: '2026-10-23T14:12:03.000Z' },
    events: [...events, { ...events[4], seq: 1, frame: 2, start: t0 + 1200, ms: 1000 }] });
  assert.match(framed, /\| \| All \| 3\.0 s \| 2\.5 s \| 1 \| 1\.5 s \| 1\.5 s \| 0 \(0\.0 s\) \| 0\.5 s \|/);
});

// Review of PR #166: the store ZIP ships lib/, and MIT asks that a copy keep its notice.
test('the vendored fflate keeps its MIT copyright and permission notice', () => {
  const vendored = fs.readFileSync(new URL('../lib/fflate.mjs', import.meta.url), 'utf8');
  const license = fs.readFileSync(new URL('../node_modules/fflate/LICENSE', import.meta.url), 'utf8');
  const head = vendored.slice(0, 2000);
  for (const line of [license.match(/^Copyright.*$/m)[0], 'Permission is hereby granted, free of charge']) assert.ok(head.includes(line), line);
});

// Progressive's recordings of 2026-11-04: its hidden "Current Page Errored" box (no size, at the top of
// the page) is ticked and unticked by every Continue; each was marked ↑, above the answer before it.
test('a box with no size is never marked above an answer, and the order goes on from the answer before it', () => {
  const t0 = Date.parse('2026-11-04T13:21:00.000Z');
  const field = (key, label, docY, w = 100, h = 20) => ({ key, q: null, kind: 'text', label, rect: { x: 0, y: 0, w, h, docY } });
  const events = [
    { kind: 'page', t: t0 + 100, seq: 1, frame: 0, page: 'MoreAboutBusiness', step: null, top: true },
    { kind: 'input', t: t0 + 1000, seq: 2, frame: 0, trusted: false, gestureMs: null, len: 3, field: field('ref:A', 'Upper question', 500) },
    { kind: 'change', t: t0 + 1100, seq: 3, frame: 0, trusted: true, gestureMs: null, field: { ...field('ref:Errored', 'Current Page Errored', 0, 0, 0), kind: 'checkbox' }, value: 'checked' },
    { kind: 'input', t: t0 + 1200, seq: 4, frame: 0, trusted: false, gestureMs: null, len: 3, field: field('ref:B', 'Lower question', 600) },
    { kind: 'input', t: t0 + 1300, seq: 5, frame: 0, trusted: false, gestureMs: null, len: 3, field: field('ref:C', 'Middle question', 550) },
  ];
  const files = recordingFiles({ ...manifestFor(), ended: '2026-11-04T13:21:05.000Z' }, events);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  const report = recordingReport(readRecording(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(report, /\) set "checked" for "Current Page Errored"/);
  assert.doesNotMatch(report, /↑ set "checked" for "Current Page Errored"/);
  assert.doesNotMatch(report, /↑ set "Lower question"/);
  assert.match(report, /↑ set "Middle question"/, 'above the lower one, the answer before it');
});

// REC-20 (audit 2026-11-07): the report showed a failed request as one that finished.
test('a page request its server answered with an error is in the step\'s timeline, its table row and up front', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const events = [
    { kind: 'page', t: t0, seq: 1, frame: 0, page: '/quote', step: 'Vehicles', top: true },
    { kind: 'fill', t: t0 + 100, frame: 0, on: true },
    { kind: 'kit', t: t0 + 200, seq: 2, frame: 0, what: 'answer', field: { key: 'ref:Year', label: 'Year' }, ok: true, start: t0 + 150, applyMs: 50 },
    { kind: 'request', t: t0 + 300, seq: 3, frame: 0, path: '/api/rate', end: t0 + 1500, ms: 1200, via: 'fetch', status: 503 },
    { kind: 'request', t: t0 + 400, seq: 4, frame: 0, path: '/api/save', end: t0 + 500, ms: 100, via: 'xhr', status: 200 },
    { kind: 'request', t: t0 + 600, seq: 5, frame: 0, path: '/api/old', end: t0 + 700, ms: 100, via: 'xhr' },
    { kind: 'fill', t: t0 + 2000, frame: 0, on: false },
  ];
  const report = recordingReport({ manifest: { ...manifestFor(), ended: '2026-10-23T14:12:03.000Z' }, events });
  assert.match(report, /the page's request to `\/api\/rate` failed: HTTP 503 after 1\.2 s/);
  assert.equal(report.match(/failed: HTTP/g).length, 1, 'a 200 or a request with no status is no line');
  // Review of PR #379: a decoded path holding a line break and Markdown stays code on its one line.
  const odd = recordingReport({ manifest: manifestFor(), events: events.map((e) => (e.status === 503 ? { ...e, path: '/api/\n\n# Extra `x`' } : e)) });
  assert.match(odd, /the page's request to `\/api\/ # Extra 'x'` failed: HTTP 503/);
  assert.doesNotMatch(odd, /^# Extra/m);
  assert.match(report, /\| 3 \(1\.4 s\), 1 failed \|/);
  assert.match(report, /The page's server answered 1 request with an error \(HTTP 503 ×1\)/);
  assert.ok(!/with an error/.test(recordingReport({ manifest: manifestFor(), events: events.filter((e) => e.status !== 503) })));
});

// REC-13 (audit 2026-11-07): "Left by" named the agent's earlier click (Add vehicle) when the fill
// pressed Continue, and a step only the fill left showed none.
test('a step is left by the last button pressed on it, the agent\'s or the extension\'s', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const events = [
    { kind: 'page', t: t0, seq: 1, frame: 0, page: '/quote', step: 'Vehicles', top: true },
    { kind: 'click', t: t0 + 1000, seq: 2, frame: 0, trusted: true, button: { text: 'Add vehicle', rect: null } },
    { kind: 'click', t: t0 + 1900, seq: 3, frame: 0, trusted: false, button: { text: 'Continue', rect: null } },
    { kind: 'kit', t: t0 + 2000, seq: 4, frame: 0, what: 'press', button: { text: 'Continue' }, how: 'page' },
    { kind: 'step', t: t0 + 3000, seq: 5, frame: 0, step: 'Drivers', from: 'Vehicles' },
    { kind: 'kit', t: t0 + 4000, seq: 6, frame: 0, what: 'press', button: { text: 'Continue' }, how: 'kit' },
    { kind: 'step', t: t0 + 5000, seq: 7, frame: 0, step: 'Coverages', from: 'Drivers' },
    { kind: 'kit', t: t0 + 5500, seq: 8, frame: 0, what: 'press', button: { text: 'Recalculate' }, how: 'kit' },
    { kind: 'click', t: t0 + 6000, seq: 9, frame: 0, trusted: true, button: { text: 'Next', rect: null } },
    { kind: 'step', t: t0 + 7000, seq: 10, frame: 0, step: 'Summary', from: 'Coverages' },
  ];
  const report = recordingReport({ manifest: { ...manifestFor(), ended: '2026-10-23T14:12:08.000Z' }, events });
  assert.match(report, /\| 1 \| \/quote · Vehicles \|[^\n]*\| "Continue" \(extension\) \|/);
  assert.match(report, /\| 2 \| \/quote · Drivers \|[^\n]*\| "Continue" \(extension\) \|/, 'a step only the fill left');
  assert.match(report, /\| 3 \| \/quote · Coverages \|[^\n]*\| "Next" \(you\) \|/);
  assert.match(report, /\| 4 \| \/quote · Summary \|[^\n]*\| — \|/);
});

// REC-02 (audit 2026-11-07): a wait held by GEICO's `active-index`, a radio's `checked` or a busy page
// read as "the page did nothing during it", a safe speed-up to the review, from the trace's observer.
test('a wait\'s slack counts what the wait saw itself, and says when the trace saw less', () => {
  const t0 = Date.parse('2026-10-23T14:12:00.000Z');
  const wait = { kind: 'kit', t: t0 + 3000, seq: 2, frame: 0, what: 'wait', why: 'continue', quietMs: 500, maxMs: 6000, requests: false, start: t0 + 1000, ms: 2000, ended: 'quiet' };
  const page = { kind: 'page', t: t0, seq: 1, frame: 0, page: '/quote', step: 'Vehicles', top: true };
  const report = (more) => recordingReport({ manifest: { ...manifestFor(), ended: '2026-10-23T14:12:04.000Z' }, events: [page, { ...wait, ...more }] });
  // The page changed an attribute until 2.4 s: 0.6 s of slack, not 2.0 s.
  const seen = report({ lastChange: t0 + 2400, lastHeld: t0 + 1000 });
  assert.match(seen, /the extension waited 2\.0 s before pressing Continue \(quiet 500 ms\): the page was quiet; 0\.6 s after the page's last change \(the wait saw the page change or busy 1\.4 s after the trace's last change: not slack\)/);
  // Busy until 2.2 s, no change seen.
  assert.match(report({ lastChange: t0 + 1000, lastHeld: t0 + 2200 }), /; 0\.8 s after the page's last change \(the wait saw/);
  // Nothing seen by either: all slack, as before; and a recording from before REC-02: the trace's alone.
  assert.match(report({ lastChange: t0 + 1000, lastHeld: t0 + 1000 }), /the page did nothing during it\n/);
  assert.match(report({}), /the page did nothing during it\n/);
});
