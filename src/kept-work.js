// @ts-check
// The agent's corrections and checks of an intake, kept on this computer for a day (the maintainer,
// 2026-11-07, audit FLOW-17): the intake itself is kept in session storage, which a browser restart
// empties, and the agent then lost every correction and check made in the panel. Only these are kept
// (each corrected field's path and value, and each check marked done), in chrome.storage.local under
// one key per intake (its fingerprint), and only for KEPT_WORK_MS after the last change: an older one
// is deleted when Chrome starts (background.js), when the panel opens, and when it is read. A new
// client's intake, or Clear this client, deletes the last client's. The intake PDF and the rest of
// the record never go there.

export const KEPT_WORK_PREFIX = 'keptWork:';
export const KEPT_WORK_MS = 24 * 60 * 60 * 1000;

/**
 * A check's identity on its intake: its warning's code and path, and which of the warnings with both
 * it is (`n`), so it is found again on the same PDF read again, whatever was added to the list since.
 * @param {{ code?: string, path?: string }[]} warnings
 * @param {number} i
 */
function checkId(warnings, i) {
  const w = warnings[i];
  const n = warnings.slice(0, i).filter((x) => x.code === w.code && x.path === w.path).length;
  return { code: w.code ?? null, path: w.path ?? null, n };
}

/**
 * What is kept of an intake's work: `{ at, edits: [path, value][], checks }`, or null when there is
 * nothing to keep.
 * @param {{ record: any, warnings?: any[], agentEdited?: string[], done?: number[] }} intake
 * @param {(record: any, path: string) => any} get
 * @param {number} [now]
 */
export function keptWorkOf(intake, get, now = Date.now()) {
  const edits = (intake.agentEdited ?? []).filter((p) => typeof p === 'string' && p).map((p) => [p, get(intake.record, p) ?? null]);
  const warnings = intake.warnings ?? [];
  const checks = (intake.done ?? []).filter((i) => Number.isInteger(i) && warnings[i]).map((i) => checkId(warnings, i));
  return edits.length || checks.length ? { at: now, edits, checks } : null;
}

/**
 * The warnings' indexes the kept checks are on this intake's warnings (a check not found is left).
 * @param {any[]} warnings
 * @param {{ code: string | null, path: string | null, n: number }[]} checks
 */
export function checksOn(warnings, checks) {
  const out = [];
  for (const c of Array.isArray(checks) ? checks : []) {
    let seen = 0;
    const i = warnings.findIndex((w) => (w.code ?? null) === c?.code && (w.path ?? null) === c?.path && seen++ === c.n);
    if (i >= 0) out.push(i);
  }
  return out;
}

/** Whether a kept entry is still within its day. */
export const keptFresh = (kept, now = Date.now()) => !!kept && Number.isFinite(kept.at) && kept.at <= now && now - kept.at < KEPT_WORK_MS;

/**
 * Deletes what is kept past its day, and with `except` (an intake's fingerprint) or `all` every other
 * intake's too: a new client's intake keeps only its own, a cleared client keeps none.
 * @param {{ get: (k: any) => Promise<Record<string, any>>, remove: (k: string[]) => Promise<void>, getKeys?: () => Promise<string[]> }} local  chrome.storage.local
 * @param {{ now?: number, except?: string, all?: boolean }} [options]
 */
export async function pruneKeptWork(local, { now = Date.now(), except, all = false } = {}) {
  // The keys only where Chrome can (130 and later): the usage queue shares this storage.
  const keys = (typeof local.getKeys === 'function' ? await local.getKeys() : Object.keys(await local.get(null))).filter((k) => k.startsWith(KEPT_WORK_PREFIX));
  if (!keys.length) return [];
  const others = all ? keys : except !== undefined ? keys.filter((k) => k !== `${KEPT_WORK_PREFIX}${except}`) : [];
  const rest = keys.filter((k) => !others.includes(k));
  const values = rest.length ? await local.get(rest) : {};
  const gone = [...others, ...rest.filter((k) => !keptFresh(values[k], now))];
  if (gone.length) await local.remove(gone);
  return gone;
}
