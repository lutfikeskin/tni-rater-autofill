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
// Stamped by scripts/package.mjs: the store zip or the unpacked copy, and its commit. A version
// number alone can't tell a development copy from the release (audit 2026-10-08).
const PROVENANCE = { channel: 'source', commit: null };

let session = null; // { id, intakeId } for the intake currently loaded
let queue = Promise.resolve();
// Whether the last events could be saved on this computer (ok | error): a write that fails, such
// as storage full, loses them, and the panel says so instead of only the console (audit 2026-10-08).
let saveStatus = { state: 'ok' };
export const lastSave = () => saveStatus;

// keySalt stays on this computer (never in an event): it keeps redacted field keys apart
// without identifying anyone (fieldChangeEvent in src/usage.js).
export function startSession(intakeId) {
  session = { id: crypto.randomUUID(), intakeId, keySalt: crypto.randomUUID() };
  return session;
}
// A session saved before keys had a salt gets one for as long as this panel is open.
export const restoreSession = (s) => { session = s ? { keySalt: crypto.randomUUID(), ...s } : null; };
export const currentSession = () => session;

export async function settings() {
  return (await local.get('settings')) ?? {};
}
export async function migrateAssistantSettings() {
  const saved = await settings();
  const obsolete = ['aiKey', 'jevKey', 'jevModel', 'aiProvider', 'aiAuto'];
  if (!obsolete.some(key => Object.hasOwn(saved, key))) return saved;
  const clean = { ...saved };
  for (const key of obsolete) delete clean[key];
  await local.set('settings', clean);
  return clean;
}
export async function saveSettings(patch) {
  await local.set('settings', { ...(await settings()), ...patch });
}

const SEQ_KEY = 'usageSeq';
// A random id for this copy of the extension on this computer, made once and stamped on every
// event (`install`): with `seq`, which numbers this computer's events, a review tells two computers
// sharing initials apart and sees events lost on the way (a gap in one install's numbers).
const INSTALL_KEY = 'usageInstall';
async function installId() {
  let id = await local.get(INSTALL_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await local.set(INSTALL_KEY, id);
  }
  return id;
}

// Panels open in two windows keep a queue each but share the stored log and its numbering. A Web
// Lock (shared by all of the extension's pages) lets one of them read and write it at a time.
const exclusive = (fn) => (globalThis.navigator?.locks ? navigator.locks.request('usage-log', fn) : fn());

// Appends events in order, even when called from several places at once. The time and the quote
// (session) are taken when log() is called, not when the queue gets to the event: Clear and
// Replace log intake_closed just before the panel moves to another session. `seq` numbers every
// event this computer logs, so a quote's events keep their order even when they share a time.
// An event that names its own session and intakeId keeps them: a fill's results that come back
// after another intake was loaded are logged as the quote they began in (noteStaleFill).
export function log(...events) {
  const t = new Date().toISOString();
  const { id: sessionId = null, intakeId = null } = session ?? {};
  queue = queue.then(() => exclusive(async () => {
    const { agent = null } = await settings();
    const install = await installId();
    let list = (await local.get(LOG_KEY)) ?? [];
    let seq = (await local.get(SEQ_KEY)) ?? 0;
    const stamp = () => ({ id: crypto.randomUUID(), t, v: version, channel: PROVENANCE.channel, ...(PROVENANCE.commit ? { commit: PROVENANCE.commit } : {}), agent, install, session: sessionId, intakeId, seq: ++seq });
    for (const e of events) list.push({ ...stamp(), ...e });
    // Oldest events go first if nobody has exported in a long time; how many is logged in their
    // place (usage_lost), so a review knows the log is missing some.
    if (list.length > MAX_EVENTS) {
      const lost = list.length - MAX_EVENTS + 1;
      list = [...list.slice(lost), { ...stamp(), session: null, intakeId: null, type: 'usage_lost', count: lost }];
    }
    // Saved first: a failed write leaves a gap in the numbers, never a number used twice.
    await local.set(SEQ_KEY, seq);
    await local.set(LOG_KEY, list);
    saveStatus = { state: 'ok' };
  })).catch((e) => {
    saveStatus = { state: 'error', at: new Date().toISOString(), message: String(e?.message ?? e).slice(0, 160) };
    console.error('usage log:', e);
  });
  return queue;
}

// Events waiting on this computer: the upload queue, and the ones a server refused or that were
// too large to send (kept aside for export). Export writes both and Clear deletes both, so the
// panel's count and its "haven't been exported" check cover both (audit 2026-10-08).
export async function counts() {
  await queue;
  return { queued: ((await local.get(LOG_KEY)) ?? []).length, rejected: ((await local.get(REJECTED_KEY)) ?? []).length };
}
export async function count() {
  const { queued, rejected } = await counts();
  return queued + rejected;
}

export async function exportLog() {
  await queue;
  const events = [...((await local.get(REJECTED_KEY)) ?? []), ...((await local.get(LOG_KEY)) ?? [])];
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

// TNI's central usage server (Railway, see docs/hosting.md). The upload token ships with every copy
// of the extension: it only lets an extension add events (which the server cleans); reading them
// back needs the admin token, which never leaves TNI.
export const DEFAULT_SERVER = 'https://usage-server-production.up.railway.app';
export const DEFAULT_TOKEN = 'f1bc92546c9f329c321dbc6a33611c07';

// The server and token in use: the agent's own settings when set (a local server for testing),
// otherwise the central one. A blank server setting means "no server" (export only).
export async function serverConfig() {
  const { serverUrl, serverToken = '' } = await settings();
  const url = serverUrl === undefined ? DEFAULT_SERVER : serverUrl;
  return { serverUrl: url, serverToken: serverToken || (url === DEFAULT_SERVER ? DEFAULT_TOKEN : '') };
}
const REJECTED_KEY = 'usageRejected';
const BATCH = 500;
// Keeps a request well under the server's 4 MB body limit: a million characters is at most 3 MB
// of UTF-8. Page layouts can be tens of KB each.
const BATCH_CHARS = 1_000_000;
let uploadStatus = { state: 'idle' }; // idle | ok | error | off
// A request that hangs (a proxy, a half-open connection) is given up after this long: the status
// says so and the events stay queued for the next upload (audit 2026-10-08, finding 11). The time
// covers reading the reply too (`read`): a reply whose body stalls after its headers held the
// queue (Codex on PR #65).
export const UPLOAD_TIMEOUT_MS = 20_000;
const timedFetch = (url, init, timeoutMs, read = (res) => res) => {
  const control = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { control.abort(); reject(Object.assign(new Error('timed out'), { name: 'AbortError' })); }, timeoutMs);
  });
  return Promise.race([fetch(url, { ...init, signal: control.signal }).then(read), timeout]).finally(() => clearTimeout(timer));
};

export const lastUpload = () => uploadStatus;

// The first events of the queue that fit in one request (always at least one).
function nextBatch(list, max) {
  const batch = [];
  let chars = 0;
  for (const e of list) {
    const size = JSON.stringify(e).length;
    if (batch.length >= max || (batch.length && chars + size > BATCH_CHARS)) break;
    batch.push(e);
    chars += size;
  }
  return batch;
}

// The server's reply accounts for every event sent, once each: stored, already stored, or refused
// by its index. Anything else, e.g. a proxy's page answering 200, is no proof the events arrived.
function receiptFor(body, sent) {
  const rejected = body?.rejected ?? [];
  return [body?.accepted, body?.duplicates].every((n) => Number.isInteger(n) && n >= 0) && Array.isArray(rejected)
    && rejected.every((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < sent)
    && new Set(rejected.map((r) => r.index)).size === rejected.length
    && body.accepted + body.duplicates + rejected.length === sent;
}

async function park(events) {
  await local.set(REJECTED_KEY, [...((await local.get(REJECTED_KEY)) ?? []), ...events].slice(-MAX_EVENTS));
}

// Sends pending events in batches. Events leave this computer's list only after the server has
// stored them (or already had them), so a server outage loses nothing.
// `timeoutMs`: per request (tests shorten it).
export function upload({ timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  queue = queue.then(() => exclusive(async () => {
    const { agent = null } = await settings();
    const { serverUrl, serverToken } = await serverConfig();
    if (!serverUrl) { uploadStatus = { state: 'off' }; return; }
    let sent = 0;
    // Events an older server refused because it didn't know their type yet (e.g. the AI events)
    // go back in the queue: a newer server takes them, an old one refuses them again.
    const parked = (await local.get(REJECTED_KEY)) ?? [];
    const retry = parked.filter((e) => /unknown event type/.test(e.rejectedBecause ?? ''));
    if (retry.length) {
      const queued = (await local.get(LOG_KEY)) ?? [];
      const ids = new Set(queued.map((e) => e.id));
      await local.set(LOG_KEY, [...retry.filter((e) => !ids.has(e.id)).map(({ rejectedBecause, ...e }) => e), ...queued]);
      await local.set(REJECTED_KEY, parked.filter((e) => !retry.includes(e)));
    }
    // Nothing to send: still check the server is there, so a stopped server shows up in the
    // panel before a quote's events start piling up on this computer.
    if (!((await local.get(LOG_KEY)) ?? []).length) {
      try {
        const res = await timedFetch(new URL('/v1/health', serverUrl), { headers: serverToken ? { authorization: `Bearer ${serverToken}` } : {} }, timeoutMs);
        uploadStatus = res.ok ? { state: 'ok', at: new Date().toISOString(), sent: 0 } : { state: 'error', at: new Date().toISOString(), message: `server said ${res.status}` };
      } catch (e) {
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: e?.name === 'AbortError' ? `${serverUrl} didn't answer in time` : `can't reach ${serverUrl}` };
      }
      return;
    }
    // Events recorded before ids existed get one now (the server needs ids to skip duplicates).
    const pending = (await local.get(LOG_KEY)) ?? [];
    if (pending.some((e) => !e.id)) await local.set(LOG_KEY, pending.map((e) => (e.id ? e : { ...e, id: crypto.randomUUID() })));
    let max = BATCH;
    for (;;) {
      const list = (await local.get(LOG_KEY)) ?? [];
      const batch = nextBatch(list, max);
      if (!batch.length) break;
      let res, body;
      try {
        ({ res, body } = await timedFetch(new URL('/v1/events', serverUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(serverToken ? { authorization: `Bearer ${serverToken}` } : {}) },
          body: JSON.stringify({ agent, version, events: batch }),
        }, timeoutMs, async (r) => ({ res: r, body: r.status === 413 ? null : await r.json().catch(() => null) })));
      } catch (e) {
        // Given up or unreachable: the events stay here for the next upload.
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: e?.name === 'AbortError' ? `${serverUrl} didn't answer in time; the events stay here` : `can't reach ${serverUrl}` };
        return;
      }
      // Too large for this server (or a proxy in front of it): send fewer at a time. One event
      // that is too large on its own is set aside like a refused one, so the rest still go.
      if (res.status === 413 && batch.length > 1) { max = Math.ceil(batch.length / 2); continue; }
      if (res.status === 413) {
        await park([{ ...batch[0], rejectedBecause: 'request too large' }]);
        await local.set(LOG_KEY, list.filter((e) => e.id !== batch[0].id));
        continue;
      }
      if (!res.ok) {
        const msg = body ? body.error : res.statusText;
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: `server said ${res.status}: ${msg}` };
        return;
      }
      if (!receiptFor(body, batch.length)) {
        uploadStatus = { state: 'error', at: new Date().toISOString(), message: "the server's reply didn't confirm the upload; the events stay here" };
        return;
      }
      // Events the server refused would be refused again, so they leave the upload queue, but
      // they're kept aside (and still exported) rather than deleted.
      const refused = (body.rejected ?? []).map((r) => ({ ...batch[r.index], rejectedBecause: r.error }));
      if (refused.length) {
        console.warn('usage upload: server rejected', body.rejected);
        await park(refused);
      }
      const ids = new Set(batch.map((e) => e.id));
      await local.set(LOG_KEY, list.filter((e) => !ids.has(e.id)));
      sent += batch.length - refused.length;
    }
    uploadStatus = { state: 'ok', at: new Date().toISOString(), sent };
  })).catch((e) => { uploadStatus = { state: 'error', message: String(e.message) }; });
  return queue;
}

// Deletes the upload queue and the events kept aside for export: what Export wrote (audit
// 2026-10-08: Clear left the refused events, which Export kept including).
export async function clearLog() {
  await queue;
  await exclusive(async () => {
    await local.set(LOG_KEY, []);
    await local.set(REJECTED_KEY, []);
  });
}
