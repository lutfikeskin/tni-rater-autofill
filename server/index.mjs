#!/usr/bin/env node
// Usage-log collection server for the rater autofill extension.
//
//   node server/index.mjs                  # http://127.0.0.1:8787, data in ./server-data
//   PORT=8787 HOST=0.0.0.0 DATA_DIR=/srv/rater RATER_TOKEN=secret node server/index.mjs
//
// POST /v1/events   { agent, version, events: [...] }  -> { accepted, duplicates }
// GET  /v1/health                                       -> { ok, server } (+ events with the admin token)
// GET  /v1/days      (admin token)                      -> { days: [{ day, bytes }] }
// GET  /v1/export?since=YYYY-MM-DD[&until=YYYY-MM-DD] (admin token) -> the days' JSONL, in order
// POST /v1/luna     (upload token) a Luna request (src/ai/luna.js)  -> OpenAI's response
//
// Events are appended to DATA_DIR/events/YYYY-MM-DD.jsonl (by day received), one JSON object
// per line; the review scripts (scripts/*.mjs) read that folder directly. Each event carries an
// id, so an extension retrying an upload never creates duplicates.
//
// The extension never sends client data (see src/usage.js); as a second line of defence the
// server only accepts known event types and drops fields it doesn't expect. What it drops is
// named on the stored event (`dropped`), so a review can tell a field the extension never sent
// from one an older server threw away. /v1/health names this file's version (`server`, a hash of
// it), so the daily review sees when the deployed server isn't the one in the repository.
//
// Listens on 127.0.0.1 unless HOST says otherwise. Without RATER_TOKEN every upload is accepted,
// which is fine on this computer only: bound to any other address the server refuses to start
// (audit 2026-10-08: an unset variable made the deployment an open write endpoint). When exposed
// beyond this computer, set RATER_TOKEN and put it behind HTTPS (Railway does: see
// docs/hosting.md). RATER_TOKEN is the upload token the extension ships with; reading the logs
// back needs RATER_ADMIN_TOKEN, which only TNI (and the daily review job) has. Without
// RATER_ADMIN_TOKEN the export is switched off. PORT=0 takes a free port (the startup line names it).
//
// /v1/luna lets agents use Luna without an OpenAI key of their own: OPENAI_API_KEY stays in the
// server's variables and is added here. Only a request shaped like the panel's (lunaRequestError)
// goes on, at most RATER_LUNA_DAILY_LIMIT a day (UTC); neither the request nor OpenAI's answer is
// stored or logged. Without OPENAI_API_KEY it answers 501 and the panel says Luna isn't set up.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_EVENTS_PER_REQUEST = 2000;
const MAX_EVENT_BYTES = 32 * 1024;
// A page's layout lists every question and its choices (up to 250 per question).
const MAX_LAYOUT_BYTES = 128 * 1024;
// Which version of this file is running: the daily review compares it with the repository's.
export const SERVER_HASH = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
// Names of dropped fields kept on an event: field-like names only, at most this many.
const DROPPED_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
const MAX_DROPPED = 20;

// What /v1/luna passes on: the fixed model and the bounds src/ai/luna.js keeps (request()), so the
// server's key can't be used for anything else. Kept here: the deployed server has no src/.
export const LUNA_MODEL = 'gpt-6-luna';
const LUNA_FIELDS = new Set(['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text']);
const LUNA_MAX_CHARS = 48_000;
const LUNA_MAX_OUTPUT = 4096;
const LUNA_TIMEOUT_MS = 60_000;
export const LUNA_DAILY_LIMIT = 3000;

// Why this body may not go to OpenAI: null when it may.
export function lunaRequestError(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body is not an object';
  const extra = Object.keys(b).find((k) => !LUNA_FIELDS.has(k));
  if (extra) return `${extra} is not allowed`;
  if (b.model !== LUNA_MODEL) return `model must be ${LUNA_MODEL}`;
  if (b.store !== false) return 'store must be false';
  if (!(b.reasoning && Object.keys(b.reasoning).length === 1 && b.reasoning.effort === 'low')) return 'reasoning must be { effort: low }';
  if (!(Number.isSafeInteger(b.max_output_tokens) && b.max_output_tokens > 0 && b.max_output_tokens <= LUNA_MAX_OUTPUT)) return `max_output_tokens must be 1..${LUNA_MAX_OUTPUT}`;
  if (typeof b.instructions !== 'string') return 'instructions must be text';
  if (!(Array.isArray(b.input) && b.input.length === 1 && b.input[0]?.role === 'user' && typeof b.input[0].content === 'string'
    && Object.keys(b.input[0]).length === 2)) return 'input must be one user message';
  if (b.text?.format?.type !== 'json_schema' || b.text.format.strict !== true) return 'text.format must be a strict json_schema';
  if (JSON.stringify(b).length > LUNA_MAX_CHARS) return 'request too large';
  return null;
}

// Addresses only this computer can reach: the one place an upload needs no token.
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;
// Why the server must not start with this host and token: null when it may. Fail closed: a
// deployment that lost its RATER_TOKEN variable stops, rather than taking anyone's events.
export function startupError({ host, token }) {
  if (token || LOOPBACK.test(String(host))) return null;
  return `RATER_TOKEN is not set and HOST=${host} is not loopback: refusing to start an open upload endpoint. Set RATER_TOKEN (docs/hosting.md), or bind HOST to 127.0.0.1 for local use.`;
}

// Event type -> fields kept. Anything else in an event is dropped.
// install: a random id for one copy of the extension on one computer (with seq: gaps show loss).
export const COMMON = ['id', 't', 'v', 'channel', 'commit', 'agent', 'install', 'session', 'intakeId', 'seq', 'type', 'carrier', 'page', 'view'];
export const EVENT_FIELDS = {
  // test: the agent marked this intake as a test run before (on this computer).
  // platform: the computer's system and Chrome's major version.
  intake_loaded: ['formVersion', 'answers', 'state', 'businessClass', 'vehicleTypes', 'counts', 'coverages', 'warnings', 'test', 'platform'],
  // What the client's business looks like, never who it is (src/usage.js intakeProfile): when the
  // intake is loaded and after the agent corrects it. Each group is kept in its shape (PROFILE).
  intake_profile: ['business', 'operations', 'vehicles', 'trailers', 'trailerInfo', 'drivers', 'coverage', 'priorInsurance', 'hasClaims'],
  // Events the computer's log dropped (full, oldest first): how many.
  usage_lost: ['count'],
  intake_closed: ['reason'],
  // The agent marked the loaded intake as a test run, or unmarked it.
  intake_marked: ['test'],
  // The agent's settings, all of them each time (values: booleans and where usage goes).
  agent_settings: ['reason', 'changed', 'values'],
  intake_edit: ['path', 'kind', 'change', 'warnings'],
  warning_checked: ['code', 'path', 'checked'],
  page_view: ['from', 'fields'],
  // messages: what the page said about the answers (validation, errors, help), redacted by the panel.
  page_layout: ['context', 'fields', 'buttons', 'reason', 'step', 'messages'],
  // The premium a carrier page quoted (src/premium.js): amounts, the term in months and the payments.
  quote_premium: ['step', 'total', 'termMonths', 'dueToday', 'payments', 'payment'],
  // A page layout the panel couldn't record (why it was asked for, and the error's first words).
  layout_error: ['reason', 'error'],
  // pageChanged: the carrier probably changed the page; reworded: known fields whose question reads
  // differently; renamed: known questions whose data-model name isn't on the page (rule, names).
  // run: one fill invocation, shared with its fill_field events; rules: the rule files'
  // fingerprint; settings: the panel's filling switches; step: a one-address application's step
  // (AmWINS). Their shapes are checked below (RUN_FIELDS): a malformed value refuses the event.
  fill_run: ['run', 'rules', 'settings', 'step', 'overwrite', 'auto', 'ms', 'fields', 'rounds', 'filled', 'kept', 'noData', 'failed', 'leftRequired', 'unknown', 'clicked', 'blockers', 'blockerList', 'advanced', 'pageChanged', 'reworded', 'renamed'],
  // how: what found the field (field = data-model name, text, option, selector, label, name).
  // source: where the answer comes from (plan.js); standard, manualOnly, review: a TNI standard,
  // the agent's only, a review-mode answer the agent confirms.
  fill_field: ['run', 'step', 'result', 'q', 'key', 'label', 'path', 'controlKind', 'shown', 'reason', 'options', 'timing', 'how', 'source', 'standard', 'manualOnly', 'review'],
  // A button the agent clicked themselves: its text (60 characters), and the step on screen.
  agent_click: ['text', 'step'],
  // The agent dismissed a "needs you" item (×): the question, and why it needed them.
  check_dismissed: ['q', 'key', 'label', 'mark'],
  fill_error: ['run', 'rules', 'settings', 'auto', 'error'],
  field_change: ['step', 'q', 'key', 'label', 'kind', 'by', 'autofilled', 'change', 'vsAutofill', 'matchesIntake', 'from', 'to'],
  // With what it is about: the last fill on that tab and page (run, step, what held Continue, how
  // many seconds before the report).
  problem_report: ['text', 'run', 'step', 'blockerList', 'since'],
  // An error nothing in the panel caught: where (panel), its message (redacted, 300 characters)
  // and up to four frames inside the extension's own files.
  client_error: ['where', 'error', 'stack'],
  // AI assistant: one per request to the model, one per suggestion the agent (or the auto-select
  // setting) acted on. Choices are option texts; typed text suggestions are never logged.
  ai_suggest: ['model', 'ms', 'items', 'suggested', 'leave', 'autoOk', 'blocked', 'error', 'tokensIn', 'tokensOut', 'modelCalls', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens'],
  // Earlier clients emitted these scores (and categorical confidence); ingestion retains them only.
  ai_decision: ['model', 'policy', 'probability', 'support', 'evidenceProbability', 'confidence', 'q', 'label', 'controlKind', 'decision', 'choice', 'basis', 'intakePath', 'reason'],
};

// The run-identity fields (audit 2026-10-08, finding 7; Contract 1): their exact shapes, since a
// review joins events by them. An event with one of these present but malformed is refused, not
// trimmed: a wrong run id or rules hash would join the wrong events.
const SETTINGS_KEYS = ['autoAdvance', 'autoFollowUps', 'autoPages', 'overwrite'];
export const RUN_FIELDS = {
  run: (v) => typeof v === 'string' && /^[\w-]{8,64}$/.test(v),
  rules: (v) => typeof v === 'string' && /^[0-9a-f]{6,16}$/.test(v),
  settings: (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === SETTINGS_KEYS.length && SETTINGS_KEYS.every((k) => typeof v[k] === 'boolean'),
  step: (v) => typeof v === 'string' && v.length <= 120,
};

// The business profile (intake_profile): no name, number, address, date of birth or VIN, and every
// value in its exact shape. A yes/no is true, false or null (unanswered, never No); a dollar amount
// is whole; USDOT, MC and FEIN are `given` (a valid number), `other` (something else written:
// "Pending", "Applied for") or `blank`. Text is bounded and never holds what could identify the
// client (ID_LIKE: an @; a date with /, - or . between its parts; seven or more digits, even with
// spaces, dashes, dots, slashes or brackets between them, as in a phone, SSN, licence or policy
// number; five digits in a row; a word of eight or more letters and digits mixed, as in a VIN). A
// limit may also be a limit as written (LIMIT: $1M CSL, $1,000,000, 1000000, $1M/$2M, 25/50/25,
// State Minimum), which can hold such digits. src/usage.js applies the same tests before sending.
// A value that isn't in its shape is left out and its group named in `dropped`; a group that isn't
// the right kind of object or list is dropped whole.
export const ID_LIKE = /@|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d(?:[\s()./-]{0,2}\d){6,}|\d{5,}|\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{8,}\b/i;
// An amount: with thousands commas, round thousands written plainly, or up to four digits with an
// optional K or M; a pair of amounts with a slash ($1M/$2M); a split limit (25/50/25, 100/300/100,
// whose first part is 15 or more, so a date isn't one); a word; & + -.
const MONEY = String.raw`\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d{1,6}000|\$?\d{1,4}(?:\.\d+)?[km]?`;
const LIMIT_PART = String.raw`(?:1[5-9]|[2-9]\d|[1-9]\d{2})(?:\/\d{1,3}){1,2}|(?:${MONEY})(?:\s*\/\s*(?:${MONEY}))?|[a-z]+\.?|[&+-]`;
// Two numbers with only a space, &, + or - between them aren't a limit (an SSN or a phone written
// with spaces: 123 45 6789).
export const LIMIT = new RegExp(String.raw`^(?![\s\S]*\d[\s&+-]+\$?\d)(?:${LIMIT_PART})(?:\s+(?:${LIMIT_PART}))*$`, 'i');
const yesNo = (v) => v === null || typeof v === 'boolean';
const whole = (min, max) => (v) => v === null || (Number.isSafeInteger(v) && v >= min && v <= max);
const text = (max) => (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= max && !ID_LIKE.test(v));
const limit = (max) => (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= max && (LIMIT.test(v) || !ID_LIKE.test(v)));
const oneOf = (...values) => (v) => v === null || values.includes(v);
const usState = (v) => v === null || (typeof v === 'string' && /^[A-Z]{2}$/.test(v));
const dollars = whole(0, 99_999_999);
const year = whole(1900, 2100);
const given = oneOf('given', 'other', 'blank');
const UNIT = { type: text(40), year, make: text(40), model: text(40), value: dollars };
export const PROFILE_UNITS = 50;
export const PROFILE = {
  business: {
    state: usState, businessClass: text(80), dot: given, mc: given, fein: given, dotWithin60Days: yesNo,
    yearsInBusiness: whole(0, 200), yearsExperience: whole(0, 100), ownerDrives: yesNo,
  },
  operations: {
    whatHaul: text(120), radius: text(40), radiusMiles: whole(0, 10_000), vehicleOwnership: text(40), personalUse: yesNo, usesEld: yesNo,
    eldBrand: text(60), needSr22: yesNo, filingsRequired: yesNo, filingsWhich: text(60), hazmat: yesNo, hazPlacard: yesNo,
    movingState: yesNo, teamDriving: yesNo, canadaLoads: yesNo, equipVehicle: dollars,
  },
  vehicles: [UNIT],
  trailers: [UNIT],
  trailerInfo: { ownership: text(40), hitch: text(40), interchange: yesNo, interchangeLimit: dollars, equipTrailer: dollars },
  drivers: [{
    age: whole(0, 120), licenseState: usState, cdl: yesNo, cdlYear: year, excluded: yesNo, maritalStatus: text(30),
    gender: oneOf('MALE', 'FEMALE'),
  }],
  coverage: {
    autoLiability: text(20), autoLiabLimit: limit(40), cargo: yesNo, cargoLimit: dollars, cargoDeductible: dollars,
    gl: yesNo, hasGl: yesNo, glLimit: limit(40), reeferBreakdown: yesNo, ntl: yesNo,
  },
  priorInsurance: [{ type: text(40), carrier: text(60), limit: limit(40), expires: (v) => v === null || v === 'none' || (typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) }],
  hasClaims: yesNo,
};

// A profile value kept in its shape: { value, trimmed } (trimmed: something inside wasn't in its
// shape and was left out), or null when it isn't the right kind of object or list at all.
function keepShape(v, spec) {
  if (typeof spec === 'function') return spec(v) ? { value: v, trimmed: false } : null;
  if (Array.isArray(spec)) {
    if (!Array.isArray(v) || v.length > PROFILE_UNITS) return null;
    const items = v.map((x) => keepShape(x, spec[0]));
    return items.includes(null) ? null : { value: items.map((x) => x.value), trimmed: items.some((x) => x.trimmed) };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const value = {};
  for (const [k, x] of Object.entries(v)) if (Object.hasOwn(spec, k) && spec[k](x)) value[k] = x;
  return { value, trimmed: Object.keys(value).length !== Object.keys(v).length };
}

export function createServer({ dataDir, token = '', adminToken = '', openaiKey = '', openaiUrl = 'https://api.openai.com/v1/responses',
  lunaDailyLimit = LUNA_DAILY_LIMIT, fetchImpl = globalThis.fetch } = {}) {
  const eventsDir = path.join(dataDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  // Ids already stored, so retried uploads are ignored. Fine at pilot scale (a few million ids).
  const seen = new Set();
  for (const f of fs.readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(eventsDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { seen.add(JSON.parse(line).id); } catch { /* skip a torn last line */ }
    }
  }

  const matches = (req, secret) => {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(secret);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };
  // No token configured: every upload is taken. The CLI allows that on loopback only (startupError);
  // a caller of createServer (tests, the e2e harness) binds 127.0.0.1 itself.
  const authorized = (req) => !token || matches(req, token);
  const isAdmin = (req) => !!adminToken && matches(req, adminToken);
  const dayFiles = () => fs.readdirSync(eventsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();

  function clean(e, agent) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'event is not an object' };
    const keep = EVENT_FIELDS[e.type];
    if (!keep) return { error: `unknown event type "${String(e.type).slice(0, 40)}"` };
    // The local test page (src/carriers.js `test`, localhost) is never a quote: refused, as before
    // a reviewer has to tell its fills from agents' (audit 2026-10-08: 453 such events).
    if (e.carrier === 'test') return { error: 'events from the local test page are not collected' };
    if (typeof e.id !== 'string' || !/^[\w-]{8,64}$/.test(e.id)) return { error: 'event id missing or invalid' };
    if (typeof e.t !== 'string' || Number.isNaN(Date.parse(e.t))) return { error: 'event time missing or invalid' };
    if (JSON.stringify(e).length > (e.type === 'page_layout' ? MAX_LAYOUT_BYTES : MAX_EVENT_BYTES)) return { error: 'event too large' };
    const out = {};
    const allowed = new Set([...COMMON, ...keep]);
    for (const k of allowed) if (e[k] !== undefined) out[k] = e[k];
    // Older page_layout events used null when no step was recognized. Keep only that legacy
    // representation exempt; non-null steps still pass the ordinary shape check.
    for (const [k, valid] of Object.entries(RUN_FIELDS)) {
      if (k === 'step' && out.type === 'page_layout' && out.step === null) continue;
      if (out[k] !== undefined && keep.includes(k) && !valid(out[k])) return { error: `${k} is not a valid ${k === 'settings' ? 'settings object' : k === 'step' ? 'step name' : k === 'run' ? 'run id' : 'rules hash'}` };
    }
    // A re-upload of stored events (npm run push-logs) keeps what an earlier server dropped.
    const before = Array.isArray(e.dropped) ? e.dropped.filter((k) => typeof k === 'string' && DROPPED_NAME.test(k)) : [];
    const beforeMore = Number.isSafeInteger(e.droppedMore) && e.droppedMore > 0 ? e.droppedMore : 0;
    const dropped = Object.keys(e).filter((k) => !allowed.has(k) && k !== 'dropped' && k !== 'droppedMore' && e[k] !== undefined);
    const drop = (k) => { delete out[k]; dropped.push(k); };
    // An order number and a field key (an element id or name), nothing else in those places.
    if (out.seq !== undefined && !(Number.isSafeInteger(out.seq) && out.seq > 0)) drop('seq');
    if (out.key != null && !(typeof out.key === 'string' && out.key.length <= 256)) drop('key');
    // Which tab and vehicle/driver/trailer (t1, t2:v0, t2:tr0): an order number and an index, nothing else.
    if (out.view !== undefined && !(typeof out.view === 'string' && /^t\d{1,3}(:(?:v|d|tr)\d{1,3})?$/.test(out.view))) drop('view');
    // Historical AI evidence is a score, null (unavailable), or the original confidence enum.
    // It never becomes a place to retain arbitrary text from an older/malformed client.
    if (out.type === 'ai_decision') for (const k of ['probability', 'support', 'evidenceProbability', 'confidence']) {
      if (out[k] !== undefined && !(out[k] === null || (typeof out[k] === 'number' && Number.isFinite(out[k]) && out[k] >= 0 && out[k] <= 1)
        || (k === 'confidence' && ['high', 'medium', 'low'].includes(out[k])))) drop(k);
    }
    if (out.test !== undefined && typeof out.test !== 'boolean') drop('test');
    if (out.type === 'agent_click' && out.text !== undefined && !(typeof out.text === 'string' && out.text.length <= 60)) drop('text');
    if (out.type === 'problem_report') {
      if (out.blockerList !== undefined && !(Array.isArray(out.blockerList) && out.blockerList.length <= 12 && out.blockerList.every((b) => typeof b === 'string' && b.length <= 120))) drop('blockerList');
      if (out.since !== undefined && !(Number.isSafeInteger(out.since) && out.since >= 0)) drop('since');
    }
    if (out.source !== undefined && !['intake', 'derived', 'standard', 'fact', 'attestation'].includes(out.source)) drop('source');
    for (const k of ['standard', 'manualOnly', 'review']) if (out[k] !== undefined && out.type === 'fill_field' && typeof out[k] !== 'boolean') drop(k);
    if (out.type === 'check_dismissed' && out.mark !== undefined && !(out.mark === null || (typeof out.mark === 'string' && /^[a-z-]{1,20}$/.test(out.mark)))) drop('mark');
    if (out.install !== undefined && !(typeof out.install === 'string' && /^[0-9a-f-]{36}$/.test(out.install))) drop('install');
    if (out.platform !== undefined && !(out.platform && typeof out.platform === 'object' && !Array.isArray(out.platform) && Object.keys(out.platform).every((k) => ['os', 'chrome'].includes(k))
      && (out.platform.os === null || (typeof out.platform.os === 'string' && out.platform.os.length <= 20))
      && (out.platform.chrome === null || (Number.isSafeInteger(out.platform.chrome) && out.platform.chrome > 0 && out.platform.chrome < 1000)))) drop('platform');
    if (out.type === 'usage_lost' && out.count !== undefined && !(Number.isSafeInteger(out.count) && out.count > 0)) drop('count');
    if (out.type === 'agent_settings') {
      const v = out.values;
      const ok = !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 12
        && Object.entries(v).every(([k, x]) => /^[a-zA-Z]{1,24}$/.test(k) && (typeof x === 'boolean' || (k === 'uploads' && ['central', 'other', 'off'].includes(x))));
      if (v !== undefined && !ok) drop('values');
      if (out.reason !== undefined && !['intake', 'opened', 'changed'].includes(out.reason)) drop('reason');
      if (out.changed !== undefined && !(typeof out.changed === 'string' && /^[a-zA-Z,]{1,60}$/.test(out.changed))) drop('changed');
    }
    // A page's messages: at most 40 lines of at most 200 characters.
    if (out.messages !== undefined && !(Array.isArray(out.messages) && out.messages.length <= 40 && out.messages.every((m) => typeof m === 'string' && m.length <= 200))) drop('messages');
    // A crash: where, a bounded message, and frames inside the extension's files only.
    if (out.type === 'client_error') {
      if (out.where !== undefined && out.where !== 'panel') drop('where');
      if (out.error !== undefined && !(typeof out.error === 'string' && out.error.length <= 300)) drop('error');
      if (out.stack !== undefined && !(Array.isArray(out.stack) && out.stack.length <= 4 && out.stack.every((x) => typeof x === 'string' && x.length <= 160 && /^[\w./-]+:\d+:\d+$/.test(x)))) drop('stack');
    }
    if (out.type === 'quote_premium') {
      // A premium without its total says nothing: refused, so the loss is counted.
      if (!(typeof out.total === 'number' && Number.isFinite(out.total) && out.total > 0 && out.total < 100_000_000)) return { error: 'quote_premium needs a total' };
      const amount = (x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 100_000_000);
      const count = (max) => (x) => x === null || (Number.isSafeInteger(x) && x > 0 && x <= max);
      for (const [k, ok] of [['total', amount], ['dueToday', amount], ['payment', amount], ['termMonths', count(36)], ['payments', count(60)]]) if (out[k] !== undefined && !ok(out[k])) drop(k);
    }
    if (out.type === 'intake_profile') {
      for (const group of Object.keys(PROFILE)) {
        if (out[group] === undefined) continue;
        const kept = keepShape(out[group], PROFILE[group]);
        if (!kept) drop(group);
        else { out[group] = kept.value; if (kept.trimmed) dropped.push(group); }
      }
    }
    // Which copy and commit logged it (scripts/package.mjs): those values, nothing else in their place.
    if (out.channel !== undefined && !['store', 'unpacked', 'source'].includes(out.channel)) drop('channel');
    if (out.commit !== undefined && !(typeof out.commit === 'string' && /^[0-9a-f]{7,12}(\+dirty)?$/.test(out.commit))) drop('commit');
    // Their names only, never their values; anything that doesn't look like a field name is counted.
    if (dropped.length || before.length || beforeMore) {
      const valid = dropped.filter((k) => DROPPED_NAME.test(k));
      const names = [...new Set([...before, ...valid])];
      out.dropped = names.slice(0, MAX_DROPPED);
      const more = beforeMore + (dropped.length - valid.length) + (names.length - out.dropped.length);
      if (more) out.droppedMore = more;
    }
    // Layouts: never keep option lists or picks naming agency staff (agent of record, producer codes).
    if (out.type === 'page_layout' && Array.isArray(out.fields)) {
      out.fields = out.fields.map((f) => (/agent|producer/i.test(f?.label ?? '') ? { ...f, options: undefined, selected: undefined } : f));
    }
    out.agent ??= agent ?? null;
    return { event: out };
  }

  function store(events) {
    const receivedAt = new Date().toISOString();
    const file = path.join(eventsDir, `${receivedAt.slice(0, 10)}.jsonl`);
    const lines = events.map((e) => JSON.stringify({ ...e, receivedAt })).join('\n');
    if (lines) fs.appendFileSync(file, `${lines}\n`);
  }

  // Browsers may ask permission (CORS preflight) before an extension posts JSON. Only browser
  // extensions get it; web pages still can't send or read anything.
  const corsHeaders = (req) => {
    const origin = String(req.headers.origin ?? '');
    if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, GET',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  // Luna requests today (UTC day): a leaked upload token can't spend more than the limit.
  const lunaDay = { day: '', count: 0 };
  async function askLuna(body, done, res) {
    const problem = lunaRequestError(body);
    if (problem) return done(400, { error: problem });
    const today = new Date().toISOString().slice(0, 10);
    if (lunaDay.day !== today) Object.assign(lunaDay, { day: today, count: 0 });
    if (lunaDay.count >= lunaDailyLimit) {
      res.setHeader('retry-after', '3600');
      return done(429, { error: 'daily Luna limit reached' }, `luna limit ${lunaDailyLimit}`);
    }
    lunaDay.count++;
    let upstream;
    try {
      upstream = await fetchImpl(openaiUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(LUNA_TIMEOUT_MS) });
    } catch (e) {
      return done(504, { error: 'OpenAI did not answer' }, `luna ${e?.name ?? 'error'}`);
    }
    // OpenAI's error bodies can echo the request: only the status goes back. The server's own key
    // refused (401/403/404) is 424, so the panel doesn't tell the agent to check a key they don't have.
    if (!upstream.ok) {
      const status = [401, 403, 404].includes(upstream.status) ? 424 : upstream.status;
      const retry = upstream.headers.get('retry-after');
      if (retry) res.setHeader('retry-after', retry);
      return done(status, { error: `OpenAI returned HTTP ${upstream.status}` }, `luna upstream ${upstream.status}`);
    }
    let json;
    try { json = await upstream.json(); } catch { return done(502, { error: 'OpenAI sent an unreadable answer' }, 'luna unreadable'); }
    done(200, json, `luna ${lunaDay.count}/${lunaDailyLimit}`);
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    const cors = corsHeaders(req);
    const done = (status, body, note = '') => {
      send(res, status, body, cors);
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${status} ${Date.now() - started}ms ${note}`);
    };
    const url = new URL(req.url, 'http://x');

    if (req.method === 'OPTIONS') {
      if (!cors['access-control-allow-origin']) return done(403, { error: 'not allowed' });
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // Public privacy policy page (linked from the Chrome Web Store listing).
    if (req.method === 'GET' && url.pathname === '/privacy') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(fs.readFileSync(new URL('./privacy.html', import.meta.url)));
      return;
    }
    // What the daily server check reads (scripts/lib/central.mjs: `server`) and the panel's "is it
    // there" probe need, for anyone; how many events are stored, for TNI only.
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return done(200, { ok: true, server: SERVER_HASH, ...(isAdmin(req) ? { events: seen.size } : {}) });
    }
    if (req.method === 'GET' && (url.pathname === '/v1/days' || url.pathname === '/v1/export')) {
      if (!isAdmin(req)) return done(401, { error: 'admin token required' });
      if (url.pathname === '/v1/days') {
        return done(200, { days: dayFiles().map((f) => ({ day: f.slice(0, 10), bytes: fs.statSync(path.join(eventsDir, f)).size })) });
      }
      const since = url.searchParams.get('since') ?? '0000-00-00';
      const until = url.searchParams.get('until') ?? '9999-99-99';
      if (![since, until].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return done(400, { error: 'since/until must be YYYY-MM-DD' });
      const files = dayFiles().filter((f) => f.slice(0, 10) >= since && f.slice(0, 10) <= until);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      for (const f of files) res.write(fs.readFileSync(path.join(eventsDir, f)));
      res.end();
      console.log(`${new Date().toISOString()} GET export ${since}..${until} ${files.length} days ${Date.now() - started}ms`);
      return;
    }
    if (url.pathname !== '/v1/events' && url.pathname !== '/v1/luna') return done(404, { error: 'not found' });
    if (req.method !== 'POST') return done(405, { error: 'use POST' });
    if (!authorized(req)) return done(401, { error: 'missing or wrong token' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return done(415, { error: 'send application/json' });
    const luna = url.pathname === '/v1/luna';
    if (luna && !openaiKey) return done(501, { error: 'Luna is not set up on this server' });
    const maxBody = luna ? LUNA_MAX_CHARS * 2 : MAX_BODY;

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) { done(413, { error: 'request too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, { error: 'body is not valid JSON' }); }
      if (luna) return askLuna(body, done, res);
      if (!Array.isArray(body?.events)) return done(400, { error: 'body.events must be an array' });
      if (body.events.length > MAX_EVENTS_PER_REQUEST) return done(413, { error: `at most ${MAX_EVENTS_PER_REQUEST} events per request` });
      const agent = typeof body.agent === 'string' ? body.agent.slice(0, 12) : null;
      const accepted = [];
      const rejected = [];
      let duplicates = 0;
      for (const [i, raw] of body.events.entries()) {
        const { event, error } = clean(raw, agent);
        if (error) { rejected.push({ index: i, error }); continue; }
        if (seen.has(event.id)) { duplicates++; continue; }
        seen.add(event.id);
        accepted.push(event);
      }
      try {
        store(accepted);
      } catch (e) {
        for (const ev of accepted) seen.delete(ev.id);
        return done(500, { error: 'could not store events' }, String(e.message));
      }
      done(200, { accepted: accepted.length, duplicates, rejected }, `agent=${agent ?? '-'} +${accepted.length} dup=${duplicates} bad=${rejected.length}`);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  const token = process.env.RATER_TOKEN || '';
  const problem = startupError({ host, token });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const dataDir = path.resolve(process.env.DATA_DIR || 'server-data');
  const lunaDailyLimit = Number(process.env.RATER_LUNA_DAILY_LIMIT) || LUNA_DAILY_LIMIT;
  const server = createServer({ dataDir, token, adminToken: process.env.RATER_ADMIN_TOKEN || '', openaiKey: process.env.OPENAI_API_KEY || '', lunaDailyLimit });
  server.listen(port, host, () => {
    console.log(`rater usage server on http://${host}:${server.address().port}  data: ${dataDir}${token ? '  (token required)' : '  (no token: loopback only)'}${process.env.RATER_ADMIN_TOKEN ? '  (export on)' : ''}${process.env.OPENAI_API_KEY ? `  (Luna on, ${lunaDailyLimit}/day)` : ''}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
