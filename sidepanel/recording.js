// The developer recording's store in the side panel (docs/developer-recording.md). While recording,
// the trace's events are written in chunks to the extension's origin private file system (OPFS), so
// a panel closed or reloaded mid-quote loses at most the last few seconds, and the next panel offers
// to save what was written. Stop and save zips the recording (fflate) for Downloads. Where that file
// system can't be used, the events are kept in memory only (`durable` false), and the panel says so.

import { zipSync, strToU8 } from '../lib/fflate.mjs';
import { recordingFiles } from '../src/recording.js';

/** @import { TraceEvent, RecordingManifest } from '../types.js' */

const FOLDER = 'recordings';
// A chunk is written every 200 events or 5 s, whichever comes first.
const CHUNK_EVENTS = 200;
const CHUNK_MS = 5000;
// A live recording's folder holds live.json, rewritten every 10 s while its panel records: one
// written in the last 30 s is another panel's recording under way, never offered as unfinished
// (saving it there would delete the folder it is writing to; REC-15).
const BEAT_MS = 10_000;
const LIVE_MS = 30_000;

// Where the files live: the origin private file system (a test puts a stand-in here).
export const fileSystem = { root: () => navigator.storage.getDirectory() };

async function recordingsFolder() {
  try {
    const root = await fileSystem.root();
    return await root.getDirectoryHandle(FOLDER, { create: true });
  } catch { return null; }
}

async function writeText(dir, name, text) {
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  await out.write(text);
  await out.close();
}

async function readText(dir, name) {
  return (await (await dir.getFileHandle(name)).getFile()).text();
}

async function names(dir) {
  const out = [];
  for await (const [name] of dir.entries()) out.push(name);
  return out.sort();
}

export class RecordingStore {
  /** @param {RecordingManifest} manifest @param {any} dir */
  constructor(manifest, dir) {
    this.manifest = manifest;
    this.dir = dir;
    /** @type {TraceEvent[]} */
    this.pending = [];
    // Kept in memory: everything when there's no folder, else a chunk whose write failed.
    /** @type {TraceEvent[]} */
    this.memory = [];
    this.chunks = 0;
    // Reopened from a closed panel: its end is not known (zip).
    this.cutShort = false;
    this.count = 0;
    this.lastWrite = Date.now();
    this.chain = Promise.resolve();
    // Events a failed chunk write left in memory only (a full disk, a quota): said in the panel.
    this.writeFailures = 0;
    // The page layouts taken at a recording's moments (REC-05), by number: files beside the
    // events, in memory where there is no folder.
    this.layouts = 0;
    /** @type {Map<string, string>} */
    this.memoryLayouts = new Map();
    this.beatAt = 0;
  }

  get durable() { return !!this.dir; }

  /** A new recording, with its manifest written first. @param {RecordingManifest} manifest */
  static async start(manifest) {
    const parent = await recordingsFolder();
    let dir = null;
    if (parent) {
      try {
        dir = await parent.getDirectoryHandle(manifest.id, { create: true });
        await writeText(dir, 'recording.json', JSON.stringify(manifest));
      } catch { dir = null; }
    }
    const store = new RecordingStore(manifest, dir);
    await store.beat();
    return store;
  }

  /** Says this recording is under way (live.json), at most every 10 s. @param {number} [now] */
  async beat(now = Date.now()) {
    if (!this.dir || now - this.beatAt < BEAT_MS) return;
    this.beatAt = now;
    try { await writeText(this.dir, 'live.json', JSON.stringify({ at: now })); } catch { /* the next beat tries again */ }
  }

  /**
   * Recordings a closed or reloaded panel left unsaved, newest first: none another panel is
   * recording now (its live.json under 30 s old).
   * @param {number} [now]
   * @returns {Promise<RecordingManifest[]>}
   */
  static async unfinished(now = Date.now()) {
    const parent = await recordingsFolder();
    if (!parent) return [];
    const found = [];
    for (const id of await names(parent)) {
      try {
        const dir = await parent.getDirectoryHandle(id);
        const live = await readText(dir, 'live.json').then((t) => JSON.parse(t).at).catch(() => null);
        if (Number.isFinite(live) && now - live < LIVE_MS) continue;
        found.push(JSON.parse(await readText(dir, 'recording.json')));
      } catch { /* not a recording */ }
    }
    return found.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  }

  /** One of those, to save or discard. @param {string} id */
  static async reopen(id) {
    const parent = await recordingsFolder();
    const dir = await parent.getDirectoryHandle(id);
    const store = new RecordingStore(JSON.parse(await readText(dir, 'recording.json')), dir);
    const files = await names(dir);
    store.chunks = files.filter((n) => n.startsWith('events-')).length;
    store.layouts = files.filter((n) => n.startsWith('layout-')).length;
    // Its end isn't known (the panel closed): saved with none, it reads as cut short.
    store.cutShort = true;
    return store;
  }

  /** @param {TraceEvent[]} events */
  add(events) {
    if (!events.length) return this.chain;
    this.pending.push(...events);
    this.count += events.length;
    this.beat();
    return this.pending.length >= CHUNK_EVENTS || Date.now() - this.lastWrite >= CHUNK_MS ? this.persist() : this.chain;
  }

  /** Writes what is pending as the next chunk (in order: one write at a time). */
  persist() {
    this.chain = this.chain.then(async () => {
      if (!this.pending.length) return;
      const batch = this.pending;
      this.pending = [];
      this.lastWrite = Date.now();
      if (!this.dir) { this.memory.push(...batch); return; }
      try {
        await writeText(this.dir, `events-${String(this.chunks + 1).padStart(5, '0')}.jsonl`, batch.map((e) => JSON.stringify(e)).join('\n') + '\n');
        this.chunks++;
      } catch { this.memory.push(...batch); this.writeFailures += batch.length; }
    });
    return this.chain;
  }

  /**
   * Keeps a page layout of this moment (the kit's capture, as Alt+Shift+C saves it) and says the
   * name it has in the zip (`layouts/0001.json`).
   * @param {object} layout
   * @returns {Promise<string>}
   */
  async addLayout(layout) {
    const id = String(++this.layouts).padStart(4, '0');
    const text = JSON.stringify(layout, null, 1);
    let kept = false;
    if (this.dir) { try { await writeText(this.dir, `layout-${id}.json`, text); kept = true; } catch { /* in memory below */ } }
    if (!kept) this.memoryLayouts.set(id, text);
    return `layouts/${id}.json`;
  }

  /** The layouts kept, by their name in the zip. @returns {Promise<{ [name: string]: string }>} */
  async layoutFiles() {
    /** @type {{ [name: string]: string }} */
    const out = {};
    if (this.dir) {
      for (const name of (await names(this.dir)).filter((n) => n.startsWith('layout-'))) {
        try { out[`layouts/${name.slice('layout-'.length)}`] = await readText(this.dir, name); } catch { /* gone */ }
      }
    }
    for (const [id, text] of this.memoryLayouts) out[`layouts/${id}.json`] = text;
    return out;
  }

  /** Every event kept so far. @returns {Promise<TraceEvent[]>} */
  async events() {
    await this.persist();
    const out = [];
    if (this.dir) {
      for (const name of (await names(this.dir)).filter((n) => n.startsWith('events-'))) {
        for (const line of (await readText(this.dir, name)).split('\n')) {
          if (line.trim()) try { out.push(JSON.parse(line)); } catch { /* a chunk cut short */ }
        }
      }
    }
    return [...out, ...this.memory];
  }

  /** The recording as one zip: a folder named by its id holding recording.json, events.jsonl and its moments' layouts/. */
  async zip(ended = this.cutShort ? null : new Date()) {
    const events = await this.events();
    const files = recordingFiles({ ...this.manifest, ended: ended ? ended.toISOString() : null }, events, await this.layoutFiles());
    const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [`${this.manifest.id}/${name}`, strToU8(text)])));
    return { blob: new Blob([zipped], { type: 'application/zip' }), events: events.length };
  }

  /** Deletes what the file system holds of this recording (after it was saved). */
  async discard() {
    this.dir = null;
    const parent = await recordingsFolder();
    try { await parent?.removeEntry(this.manifest.id, { recursive: true }); } catch { /* already gone */ }
  }
}
