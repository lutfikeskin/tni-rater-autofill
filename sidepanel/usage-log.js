// Where the usage log lives: chrome.storage.local on the agent's computer until it's uploaded to
// the collection server (server/index.mjs) or exported. Events are built by src/usage.js and
// never contain client data.

import { LOG_KEY, MAX_EVENTS } from '../src/usage.js';

const hasChrome = !!globalThis.chrome?.storage?.local;
const memory = { [LOG_KEY]: [], settings: {} };
const local = hasChrome
  ? { get: async (k) => (await chrome.storage.local.get(k))[k], set: (k, v) => chrome.storage.local.set({ [k]: v }) }
  : { get: async (k) => memory[k], set: async (k, v) => { memory[k] = v; } };

const version = hasChrome ? chrome.runtime.getManifest().version : 'dev';

let session = null; // { id, intakeId } for the intake currently loaded
let queue = Promise.resolve();

export function startSession(intakeId) {
  session = { id: crypto.randomUUID(), intakeId };
  return session;
}
export const restoreSession = (s) => { session = s ?? null; };
export const currentSession = () => session;

export async function settings() {
  return (await local.get('settings')) ?? {};
}
export async function saveSettings(patch) {
  await local.set('settings', { ...(await settings()), ...patch });
}

// Appends events in order, even when called from several places at once.
export function log(...events) {
  queue = queue.then(async () => {
    const { agent = null } = await settings();
    const now = new Date().toISOString();
    const list = (await local.get(LOG_KEY)) ?? [];
    for (const e of events) {
      list.push({ id: crypto.randomUUID(), t: now, v: version, agent, session: session?.id ?? null, intakeId: session?.intakeId ?? null, ...e });
    }
    // Oldest events go first if nobody has exported in a long time.
    await local.set(LOG_KEY, list.length > MAX_EVENTS ? list.slice(-MAX_EVENTS) : list);
  }).catch((e) => console.error('usage log:', e));
  return queue;
}

export async function count() {
  await queue;
  return ((await local.get(LOG_KEY)) ?? []).length;
}

export async function exportLog() {
  await queue;
  const events = (await local.get(LOG_KEY)) ?? [];
  const { agent } = await settings();
  const data = { tool: 'tni-rater-autofill', kind: 'usage-log', version, exportedAt: new Date().toISOString(), agent: agent ?? null, events };
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rater-usage-${agent || 'agent'}-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await saveSettings({ lastExport: new Date().toISOString(), lastExportCount: events.length });
  return events.length;
}

// ---------------------------------------------------------------------------------------------
// Upload to the collection server

export const DEFAULT_SERVER = 'http://localhost:8787';
const BATCH = 500;
let uploadStatus = { state: 'idle' }; // idle | ok | error | off

export const lastUpload = () => uploadStatus;

// Sends pending events in batches. Events leave this computer's list only after the server has
// stored them (or already had them), so a server outage loses nothing.
export function upload() {
  queue = queue.then(async () => {
    const { serverUrl = DEFAULT_SERVER, serverToken = '', agent = null } = await settings();
    if (!serverUrl) { uploadStatus = { state: 'off' }; return; }
    let sent = 0;
    for (;;) {
      const list = (await local.get(LOG_KEY)) ?? [];
      const batch = list.slice(0, BATCH);
      if (!batch.length) break;
      let res;
      try {
        res = await fetch(new URL('/v1/events', serverUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(serverToken ? { authorization: `Bearer ${serverToken}` } : {}) },
          body: JSON.stringify({ agent, version, events: batch }),
        });
      } catch {
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: `can't reach ${serverUrl}` };
        return;
      }
      if (!res.ok) {
        const msg = await res.json().then((b) => b.error).catch(() => res.statusText);
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: `server said ${res.status}: ${msg}` };
        return;
      }
      const body = await res.json().catch(() => ({}));
      // Rejected events would be rejected again; drop them too, but say so.
      const ids = new Set(batch.map((e) => e.id));
      await local.set(LOG_KEY, list.filter((e) => !ids.has(e.id)));
      sent += batch.length;
      if (body.rejected?.length) console.warn('usage upload: server rejected', body.rejected);
    }
    uploadStatus = { state: 'ok', at: new Date().toISOString(), sent };
  }).catch((e) => { uploadStatus = { state: 'error', message: String(e.message) }; });
  return queue;
}

export async function clearLog() {
  await queue;
  await local.set(LOG_KEY, []);
}
