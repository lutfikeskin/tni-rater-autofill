// TNI's sales from Bitrix24, for the quoting history warehouse (docs/quoting-history-database.md,
// Sales). `npm run bitrix` (scripts/bitrix-pull.mjs) pulls the deals of one pipeline through a
// read-only use of an inbound webhook: each deal's stage, its stage history and a SHA-256 of every
// intake file attached to it. The warehouse joins a quote to its deal when the deal holds the very
// PDF the agent loaded: the hash is the quote's intake_id (src/usage.js). No name, phone, email,
// title or note is pulled or kept, only ids, stages, times and hashes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * What a pull keeps (server-data/bitrix/deals.json).
 * @typedef {{id: number, category: number|null, stage: string|null, created: string|null, updated: string|null, closed: boolean|null, intakes: {fileId: number, sha: string|null}[]}} BitrixDeal
 * @typedef {{id: number, deal: number, stage: string|null, at: string|null}} BitrixMove
 * @typedef {{id: string, name: string, semantics: string|null, category: number}} BitrixStage
 * @typedef {{pulledAt: string|null, since: string|null, category: number, intakeFields: string[], stages: BitrixStage[], deals: Record<string, BitrixDeal>, history: Record<string, BitrixMove>}} BitrixState
 */

export const WEBHOOK_FILE = path.join(os.homedir(), '.config', 'tni-rater', 'bitrix-webhook');
// Before the extension logged intake_profile; a first pull starts here unless told otherwise.
export const FIRST_SINCE = '2026-10-01T00:00:00Z';
// Only reading: a method that could change Bitrix is refused before it is sent.
const READ_ONLY = /\.(fields|list|get)$/;

/** The webhook's URL: RATER_BITRIX_WEBHOOK, else ~/.config/tni-rater/bitrix-webhook. It is a credential: never print it. */
export function webhookUrl() {
  const fromEnv = process.env.RATER_BITRIX_WEBHOOK?.trim();
  const url = fromEnv || (fs.existsSync(WEBHOOK_FILE) ? fs.readFileSync(WEBHOOK_FILE, 'utf8').trim() : '');
  return url ? url.replace(/\/?$/, '/') : null;
}

/**
 * A read-only Bitrix REST client on a webhook. Errors name the method, never the URL.
 * @param {string} base  the webhook URL, ending in /
 * @param {typeof fetch} [fetcher]
 */
export function bitrixClient(base, fetcher = fetch) {
  const origin = new URL(base).origin;
  /** @param {string} method @param {object} [params] @returns {Promise<any>} */
  async function call(method, params = {}) {
    if (!READ_ONLY.test(method)) throw new Error(`${method}: not a read method, refused`);
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetcher(`${base}${method}.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
      const body = await res.json().catch(() => ({}));
      // Bitrix allows about two calls a second on a webhook.
      if (body.error === 'QUERY_LIMIT_EXCEEDED' || res.status === 503) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      if (!res.ok || body.error) throw new Error(`${method}: HTTP ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
      return body;
    }
    throw new Error(`${method}: Bitrix kept answering that the call limit was reached`);
  }
  /** Every page of a list method. @param {string} method @param {object} [params] @returns {Promise<any[]>} */
  async function all(method, params = {}) {
    const out = [];
    let start = 0;
    for (;;) {
      const b = await call(method, { ...params, start });
      out.push(...(Array.isArray(b.result) ? b.result : b.result?.items ?? []));
      if (b.next === undefined) return out;
      start = b.next;
    }
  }
  /** Each page of a list method as it comes. @param {string} method @param {object} [params] @returns {AsyncGenerator<any[]>} */
  async function* pages(method, params = {}) {
    let start = 0;
    for (;;) {
      const b = await call(method, { ...params, start });
      yield Array.isArray(b.result) ? b.result : b.result?.items ?? [];
      if (b.next === undefined) return;
      start = b.next;
    }
  }
  /** A file's bytes from its machine URL (crm.item's urlMachine, which the webhook opens). @param {string} url */
  async function download(url) {
    const res = await fetcher(url.startsWith('http') ? url : origin + url);
    if (!res.ok) throw new Error(`file download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return { call, all, pages, download };
}

/**
 * The item API's name for a deal field: UF_CRM_1743591562344 -> ufCrm_1743591562344, UF_CRM_MY_FILE -> ufCrmMyFile.
 * @param {string} name
 */
export function itemFieldName(name) {
  const rest = name.replace(/^UF_CRM_/, '');
  if (/^\d/.test(rest)) return `ufCrm_${rest}`;
  return `ufCrm${rest.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase())}`;
}

/**
 * The deal's file fields that hold intakes: a file field whose label says "intake".
 * @param {Record<string, {type?: string, formLabel?: string, listLabel?: string, title?: string}>} fields  crm.deal.fields
 */
export function intakeFields(fields) {
  return Object.entries(fields)
    .filter(([, f]) => f.type === 'file' && /intake/i.test(`${f.formLabel ?? ''} ${f.listLabel ?? ''} ${f.title ?? ''}`))
    .map(([name]) => name);
}

/** @returns {BitrixState} */
export const emptyState = (category = 0) => ({ pulledAt: null, since: null, category, intakeFields: [], stages: [], deals: {}, history: {} });

/** @param {string} file @returns {BitrixState|null} */
export function readBitrixState(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Written beside the old file and swapped in, so a failed pull leaves the last good one. @param {string} file @param {BitrixState} state */
export function writeBitrixState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

const num = (/** @type {any} */ v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (/** @type {any} */ v) => (typeof v === 'string' && v ? v : null);

/**
 * Pulls the deals of one pipeline changed since the last pull (less a day, for clocks), with their
 * stage history and intake hashes, into `state`. A file already hashed isn't downloaded again.
 * @param {ReturnType<typeof bitrixClient>} bx
 * @param {BitrixState} state
 * @param {{since?: string|null, now?: Date, log?: (msg: string) => void}} [opts]
 * @returns {Promise<{deals: number, files: number, hashed: number, failed: number, moves: number}>}
 */
export async function pullBitrix(bx, state, { since = null, now = new Date(), log = () => {} } = {}) {
  const from = since ?? (state.pulledAt ? new Date(Date.parse(state.pulledAt) - 86400000).toISOString() : FIRST_SINCE);
  const fields = (await bx.call('crm.deal.fields')).result;
  const found = intakeFields(fields);
  if (!found.length) throw new Error('No deal file field whose label says "intake": nothing to match quotes with.');
  state.intakeFields = found;
  const prefix = state.category ? `DEAL_STAGE_${state.category}` : 'DEAL_STAGE';
  state.stages = (await bx.all('crm.status.list', { filter: { ENTITY_ID: prefix } })).map((s) => ({
    id: String(s.STATUS_ID), name: String(s.NAME ?? ''), semantics: text(s.EXTRA?.SEMANTICS ?? s.SEMANTICS), category: state.category,
  }));

  const select = ['id', 'stageId', 'categoryId', 'createdTime', 'updatedTime', 'closed', ...found.map(itemFieldName)];
  /** @type {Map<number, string>} */
  const known = new Map();
  for (const d of Object.values(state.deals)) for (const f of d.intakes) if (f.sha) known.set(f.fileId, f.sha);
  // A file left without a hash by an earlier pull, on a deal not changed since: listed again by id.
  const retry = Object.values(state.deals).filter((d) => d.intakes.some((f) => !f.sha)).map((d) => d.id);
  let files = 0, hashed = 0, failed = 0;
  /** @type {Set<number>} */
  const ids = new Set();

  // A page's files are downloaded as soon as it is listed: urlMachine links don't last.
  /** @param {any[]} page */
  const take = async (page) => {
    /** @type {{deal: BitrixDeal, fileId: number, url: string}[]} */
    const jobs = [];
    for (const it of page) {
      /** @type {BitrixDeal} */
      const deal = { id: Number(it.id), category: num(it.categoryId), stage: text(it.stageId), created: text(it.createdTime), updated: text(it.updatedTime), closed: typeof it.closed === 'boolean' ? it.closed : it.closed === 'Y' ? true : it.closed === 'N' ? false : null, intakes: [] };
      for (const name of found) {
        for (const f of [it[itemFieldName(name)]].flat()) {
          const fileId = num(f?.id);
          if (fileId === null || deal.intakes.some((x) => x.fileId === fileId)) continue;
          files++;
          const sha = known.get(fileId);
          if (sha) deal.intakes.push({ fileId, sha });
          else if (typeof f.urlMachine === 'string') jobs.push({ deal, fileId, url: f.urlMachine });
          else deal.intakes.push({ fileId, sha: null });
        }
      }
      ids.add(deal.id);
      state.deals[String(deal.id)] = deal;
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        try {
          const bytes = await bx.download(j.url);
          j.deal.intakes.push({ fileId: j.fileId, sha: createHash('sha256').update(bytes).digest('hex') });
          hashed++;
        } catch {
          // Kept without a hash, and tried again on the next pull.
          j.deal.intakes.push({ fileId: j.fileId, sha: null });
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  };

  for await (const page of bx.pages('crm.item.list', { entityTypeId: 2, filter: { '>=updatedTime': from, categoryId: state.category }, select, order: { id: 'ASC' } })) await take(page);
  const changed = ids.size;
  const again = retry.filter((id) => !ids.has(id));
  for (let i = 0; i < again.length; i += 50) {
    for await (const page of bx.pages('crm.item.list', { entityTypeId: 2, filter: { '@id': again.slice(i, i + 50) }, select })) await take(page);
  }
  log(`${changed} deals changed since ${from.slice(0, 10)}, ${again.length} listed again for a missing hash`);
  log(`${files} intake files: ${hashed} downloaded and hashed, ${failed} failed (tried again next time)`);

  let moves = 0;
  const listed = [...ids];
  for (let i = 0; i < listed.length; i += 50) {
    const rows = await bx.all('crm.stagehistory.list', { entityTypeId: 2, filter: { OWNER_ID: listed.slice(i, i + 50) }, select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME'] });
    for (const r of rows) {
      const id = num(r.ID), deal = num(r.OWNER_ID);
      if (id === null || deal === null) continue;
      state.history[String(id)] = { id, deal, stage: text(r.STAGE_ID), at: text(r.CREATED_TIME) };
      moves++;
    }
  }
  state.pulledAt = now.toISOString();
  state.since = state.since && state.since < from ? state.since : from;
  return { deals: changed, files, hashed, failed, moves };
}

/**
 * The warehouse's sales rows from a pull: deals, their stage moves and intake hashes, and which
 * quote went with which deal (its intake PDF's hash on the deal).
 * @param {BitrixState|null} state
 * @param {{session: string, intake_id: string|null}[]} quotes  the warehouse's quotes rows
 */
export function bitrixRows(state, quotes) {
  const rows = { deals: /** @type {object[]} */ ([]), deal_stages: /** @type {object[]} */ ([]), deal_intakes: /** @type {object[]} */ ([]), quote_deals: /** @type {object[]} */ ([]) };
  if (!state) return rows;
  const stages = new Map(state.stages.map((s) => [s.id, s]));
  /** @type {Map<string, Set<number>>} */
  const bySha = new Map();
  for (const d of Object.values(state.deals)) {
    const s = d.stage ? stages.get(d.stage) : null;
    rows.deals.push({ deal_id: d.id, category: d.category, stage: d.stage, stage_name: s?.name ?? null, stage_semantics: s?.semantics ?? null, created_at: iso(d.created), updated_at: iso(d.updated), closed: d.closed });
    for (const f of d.intakes) {
      rows.deal_intakes.push({ deal_id: d.id, file_id: f.fileId, intake_id: f.sha });
      if (f.sha) bySha.set(f.sha, (bySha.get(f.sha) ?? new Set()).add(d.id));
    }
  }
  for (const m of Object.values(state.history)) {
    if (!state.deals[String(m.deal)]) continue;
    const s = m.stage ? stages.get(m.stage) : null;
    rows.deal_stages.push({ move_id: m.id, deal_id: m.deal, stage: m.stage, stage_name: s?.name ?? null, stage_semantics: s?.semantics ?? null, moved_at: iso(m.at) });
  }
  for (const q of quotes) {
    for (const deal of bySha.get(String(q.intake_id ?? '').toLowerCase()) ?? []) rows.quote_deals.push({ session: q.session, deal_id: deal, matched_by: 'intake_pdf' });
  }
  return rows;
}

const iso = (/** @type {any} */ v) => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
