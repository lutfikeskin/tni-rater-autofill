// Where the usage log lives for the pilot: chrome.storage.local on the agent's computer, until
// exported. Events are built by src/usage.js and never contain client data.

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
      list.push({ t: now, v: version, agent, session: session?.id ?? null, intakeId: session?.intakeId ?? null, ...e });
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

export async function clearLog() {
  await queue;
  await local.set(LOG_KEY, []);
}
