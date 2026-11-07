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
// GET  /dashboard   (dashboard token, HTTP Basic) the maintainer's live usage page (server/dashboard.mjs)
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
//
// /dashboard is for the maintainer only: RATER_DASHBOARD_TOKEN (at least 16 characters) is its
// password, with any user name; unset or shorter, the page is off (404). RATER_TEST_INTAKES
// (optional, intake fingerprints) names test runs the panel didn't mark, as reviews/test-intakes.txt.
//
// /v1/events takes at most UPLOAD_LIMITS from one address (429 with retry-after), by the socket's
// address or RATER_CLIENT_IP_HEADER's (x-real-ip on Railway), and none while DATA_DIR has less than
// RATER_MIN_FREE_MB free (default 500; 507, logged when it starts and ends).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MIN_DASHBOARD_TOKEN, WINDOWS, eventReader, renderDashboard, summarize, testIntakesFrom } from './dashboard.mjs';
// agent defaults: everything about them is in that module (removal steps at its top).
import { AGENT_DEFAULT_FIELDS, AGENT_DEFAULT_RUN_FIELDS, AGENT_DEFAULT_SOURCE, cleanAgentDefaults } from './agent-defaults.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_EVENTS_PER_REQUEST = 2000;
const MAX_EVENT_BYTES = 32 * 1024;
// A page's layout lists every question and its choices (up to 250 per question).
const MAX_LAYOUT_BYTES = 128 * 1024;
// How long one dashboard page serves every request for its period: building it reads and sums 31
// days of events on the process that takes uploads, and each open tab reloads it every minute.
const DASHBOARD_CACHE_MS = 30_000;
// Which version of the server is running (this file and the dashboard's): the daily review
// compares it with the repository's.
export const SERVER_HASH = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .update(fs.readFileSync(new URL('./dashboard.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./agent-defaults.mjs', import.meta.url))).digest('hex').slice(0, 12);
// Uploads from one address (audit 2026-11-07, SRV-13: the upload token ships in the extension, so
// anyone could fill the volume). Two token buckets per address, in memory: requests and bytes. An
// agent's panel posts at most once a minute plus a few prompt uploads (an intake loaded, a problem
// report), each of at most 500 events and a million characters (sidepanel/usage-log.js), and a
// backlog drains in back-to-back requests. The pilot's log (2026-10 to 11-06) peaked at 9 requests
// and 4.8 MB in a minute, 111 requests in an hour and 8.3 MB in a day, all agents together; an
// office's agents may share one address. Refused with 429 and retry-after; the extension keeps
// the events queued and tries again the next minute.
const MB = 1024 * 1024;
export const UPLOAD_LIMITS = {
  requests: { size: 120, perMinute: 60 },
  bytes: { size: 100 * MB, perMinute: (25 * MB) / 60 },
};
// At most this many addresses remembered; the longest idle is forgotten first (a full bucket again).
const LIMIT_ADDRESSES = 10_000;
// Uploads stop (507) while DATA_DIR has less free space than this, so the server, the stored log and
// the volume's other files survive a flood; RATER_MIN_FREE_MB sets it, 0 switches the guard off.
export const MIN_FREE_MB = 500;
// RATER_MIN_FREE_MB: unset or blank is MIN_FREE_MB; a number of megabytes from 0 is the threshold.
// Anything else keeps the default, so a mistyped value never switches the guard off.
export function minFreeBytesFrom(raw) {
  if (raw == null || String(raw).trim() === '') return MIN_FREE_MB * MB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * MB : MIN_FREE_MB * MB;
}
// Names of dropped fields kept on an event: field-like names only, at most this many.
const DROPPED_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
const MAX_DROPPED = 20;

// What /v1/luna passes on: the fixed model and the bounds src/ai/luna.js keeps (request()), so the
// server's key can't be used for another model, tools, stored responses or a larger request. The
// instructions, the message and the schema are the caller's: whoever has the upload token (it ships
// in the extension) can ask questions of their own, within the daily limit, and use up that day's
// limit for every agent. Kept here: the deployed server has no src/.
export const LUNA_MODEL = 'gpt-6-luna';
const LUNA_FIELDS = new Set(['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text']);
// Above the panel's own bound (MAX_REQUEST_CHARS in src/ai/luna.js, 120,000), so whatever it sends
// passes; 48,000 until 2026-11-07 (audit AI-01). Raise it here, and deploy, before the panel's.
export const LUNA_MAX_CHARS = 160_000;
const LUNA_MAX_OUTPUT = 4096;
const LUNA_TIMEOUT_MS = 60_000;
export const LUNA_DAILY_LIMIT = 5000;

// RATER_LUNA_DAILY_LIMIT: unset or blank is LUNA_DAILY_LIMIT; a whole number is the limit, 0
// refusing every request (429). Anything else is 0 too, so a mistyped limit spends nothing.
export function lunaDailyLimitFrom(raw) {
  if (raw == null || String(raw).trim() === '') return LUNA_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

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
  // source: where the answer comes from (plan.js; FIELD_SOURCES below); standard, manualOnly,
  // review: a TNI standard, the agent's only, a review-mode answer the agent confirms.
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
  // An error nothing in the panel or the page's recorder caught: where (panel, recorder), its message (redacted, 300 characters)
  // and up to four frames inside the extension's own files.
  client_error: ['where', 'error', 'stack'],
  // AI assistant: one per request to the model, one per suggestion the agent (or the auto-select
  // setting) acted on. Choices are option texts; typed text suggestions are never logged.
  // leave*: why questions were left, as counts (missing information, a conflict, Luna's own leave,
  // no usable citation, an answer the evidence check refused, a question too large to ask).
  ai_suggest: ['model', 'ms', 'items', 'suggested', 'leave', 'autoOk', 'blocked', 'error', 'tokensIn', 'tokensOut', 'modelCalls', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens',
    'leaveMissing', 'leaveConflict', 'leaveChose', 'leaveNoSource', 'leaveUnverified', 'leaveTooLarge'],
  // Earlier clients emitted these scores (and categorical confidence); ingestion retains them only.
  ai_decision: ['model', 'policy', 'probability', 'support', 'evidenceProbability', 'confidence', 'q', 'label', 'controlKind', 'decision', 'choice', 'basis', 'intakePath', 'reason'],
};
// agent defaults: their fields on agent_settings, fill_run and fill_error.
for (const [type, fields] of Object.entries(AGENT_DEFAULT_FIELDS)) EVENT_FIELDS[type].push(...fields);

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
  // agent defaults: the fingerprint of the defaults a fill ran with.
  ...AGENT_DEFAULT_RUN_FIELDS,
};

// The common fields' shapes (audit 2026-11-07, SRV-07), as the extension stamps them (log() in
// sidepanel/usage-log.js, the panel's pageOf): reviews group, join and order events by them, so an
// event with one out of its shape is refused, like a malformed run id, never stored with it or
// trimmed. null (no intake loaded, no carrier tab) is allowed for all but t. t: an ISO time in UTC,
// from 2025 to 30 days ahead of the server's clock (queued and re-uploaded events are older; a
// computer's clock may run a little ahead). agent: initials as typed (letters, digits, space, . '
// -; at most 12, the request's own limit). session: a UUID (startSession). intakeId: the intake
// PDF's SHA-256 (intakeSummary). carrier: a carrier id's shape (lowercase, at most 20), so a new
// carrier needs no server change. page: a page name or path (letters, digits and _ . : / ~ % + ( ) , -
// and space; at most 200). v: the extension's version number, or `dev` outside Chrome.
const EARLIEST_T = Date.parse('2025-01-01T00:00:00Z');
const T_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const orNull = (test) => (v) => v === null || (typeof v === 'string' && test.test(v));
export const COMMON_SHAPES = {
  // Date.parse rolls an impossible date or time over (2025-02-30 is March 2, 24:00 the next day):
  // the time it reads must write back as the same date and time.
  t: (v, now = Date.now()) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)
    && Date.parse(v) >= EARLIEST_T && Date.parse(v) <= now + T_AHEAD_MS && new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19),
  agent: orNull(/^[\p{L}\p{N} .'-]{1,12}$/u),
  session: orNull(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  intakeId: orNull(/^[0-9a-f]{64}$/),
  carrier: orNull(/^[a-z][a-z0-9-]{0,19}$/),
  page: orNull(/^[\w .:/~%+(),-]{0,200}$/),
  v: orNull(/^(\d{1,4}(\.\d{1,6}){0,3}|dev)$/),
};
const COMMON_SAID = { agent: 'agent initials', session: 'session id', intakeId: 'intake fingerprint', carrier: 'carrier id', page: 'page name', v: 'version' };

// Where a filled answer came from: the rules' sources (SOURCES in src/plan.js), and, for agent
// defaults, a TNI standard the agent replaced with their own default.
export const FIELD_SOURCES = ['intake', 'derived', 'standard', 'fact', 'attestation', AGENT_DEFAULT_SOURCE];

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

// One token bucket per key: `size` at most, refilled at `perMinute`. take(key, n) spends n and
// answers 0, or, when the bucket holds less than n, spends nothing and answers the seconds to wait.
function rateLimiter({ size, perMinute }, clock) {
  const perMs = perMinute / 60_000;
  const buckets = new Map();
  return (key, n) => {
    const now = clock();
    const b = buckets.get(key) ?? { tokens: size, at: now };
    b.tokens = Math.min(size, b.tokens + Math.max(0, now - b.at) * perMs);
    b.at = now;
    // Most recently used last, so the first is the longest idle.
    buckets.delete(key);
    buckets.set(key, b);
    if (buckets.size > LIMIT_ADDRESSES) buckets.delete(buckets.keys().next().value);
    if (b.tokens >= n) { b.tokens -= n; return 0; }
    return Math.max(1, Math.ceil((n - b.tokens) / perMs / 1000));
  };
}

// Free bytes on the file system holding `dir`.
const freeSpaceOf = (dir) => () => {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
};

export function createServer({ dataDir, token = '', adminToken = '', openaiKey = '', openaiUrl = 'https://api.openai.com/v1/responses',
  lunaDailyLimit = LUNA_DAILY_LIMIT, fetchImpl = globalThis.fetch, dashboardToken = '', testIntakes = [], dashboardCacheMs = DASHBOARD_CACHE_MS, clock = Date.now,
  uploadLimits = UPLOAD_LIMITS, clientIpHeader = '', minFreeBytes = MIN_FREE_MB * MB, freeSpace = freeSpaceOf(dataDir) } = {}) {
  const eventsDir = path.join(dataDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const requestLimit = rateLimiter(uploadLimits.requests, clock);
  const byteLimit = rateLimiter(uploadLimits.bytes, clock);
  // Who is uploading: behind a proxy that names the client (Railway's edge sets X-Real-IP, so the
  // image sets RATER_CLIENT_IP_HEADER=x-real-ip), that header's last value; otherwise the socket's.
  const ipHeader = clientIpHeader.toLowerCase();
  const clientIp = (req) => (ipHeader && String(req.headers[ipHeader] ?? '').split(',').at(-1)?.trim()) || req.socket.remoteAddress || '-';
  // Whether DATA_DIR is too full to take uploads: logged when it starts and when it ends. A free-space
  // reading that fails never stops uploads (the guard is a safeguard, the append still reports).
  let diskLow = false;
  let unreadableSaid = false;
  const tooFull = () => {
    if (!minFreeBytes) return false;
    let free;
    try { free = freeSpace(); } catch (e) {
      if (!unreadableSaid) console.error(`${new Date().toISOString()} free space on ${dataDir} unreadable (${e?.name ?? 'error'}): uploads go on without the disk guard`);
      unreadableSaid = true;
      return false;
    }
    const low = free < minFreeBytes;
    if (low !== diskLow) {
      const said = `free space on ${dataDir} is ${Math.round(free / MB)} MB, the guard ${Math.round(minFreeBytes / MB)} MB (RATER_MIN_FREE_MB)`;
      if (low) console.error(`${new Date().toISOString()} DISK LOW: ${said}: refusing uploads (507) until space is freed`);
      else console.log(`${new Date().toISOString()} disk ok again: ${said}: taking uploads`);
      diskLow = low;
    }
    return low;
  };

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
  // The dashboard's password (HTTP Basic, so a browser asks for it; any user name), or the token
  // as a Bearer for scripts. Too short a token keeps the page off rather than easy to guess.
  const dashboardOn = dashboardToken.length >= MIN_DASHBOARD_TOKEN;
  const dashboardAuthorized = (req) => {
    if (!dashboardOn) return false;
    const header = String(req.headers.authorization ?? '');
    const basic = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    const given = basic ? Buffer.from(basic[1], 'base64').toString('utf8').replace(/^[^:]*:/, '') : header.replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(dashboardToken).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const readRecent = eventReader(eventsDir);
  const dashboardPages = new Map();
  const dayFiles = () => fs.readdirSync(eventsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();

  function clean(e, agent) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'event is not an object' };
    // Own keys only: a type such as constructor or __proto__ is unknown, not Object.prototype's member.
    const keep = typeof e.type === 'string' && Object.hasOwn(EVENT_FIELDS, e.type) ? EVENT_FIELDS[e.type] : null;
    if (!keep) return { error: `unknown event type "${String(e.type).slice(0, 40)}"` };
    // The local test page (src/carriers.js `test`, localhost) is never a quote: refused, as before
    // a reviewer has to tell its fills from agents' (audit 2026-10-08: 453 such events).
    if (e.carrier === 'test') return { error: 'events from the local test page are not collected' };
    if (typeof e.id !== 'string' || !/^[\w-]{8,64}$/.test(e.id)) return { error: 'event id missing or invalid' };
    if (typeof e.t !== 'string' || Number.isNaN(Date.parse(e.t))) return { error: 'event time missing or invalid' };
    if (!COMMON_SHAPES.t(e.t)) return { error: 'event time is not an ISO time in UTC from 2025 to 30 days ahead' };
    for (const [k, said] of Object.entries(COMMON_SAID)) if (e[k] !== undefined && !COMMON_SHAPES[k](e[k])) return { error: `${k} is not a valid ${said}` };
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
    if (out.source !== undefined && !FIELD_SOURCES.includes(out.source)) drop('source');
    for (const k of ['standard', 'manualOnly', 'review']) if (out[k] !== undefined && out.type === 'fill_field' && typeof out[k] !== 'boolean') drop(k);
    if (out.type === 'check_dismissed' && out.mark !== undefined && !(out.mark === null || (typeof out.mark === 'string' && /^[a-z-]{1,20}$/.test(out.mark)))) drop('mark');
    if (out.install !== undefined && !(typeof out.install === 'string' && /^[0-9a-f-]{36}$/.test(out.install))) drop('install');
    if (out.platform !== undefined && !(out.platform && typeof out.platform === 'object' && !Array.isArray(out.platform) && Object.keys(out.platform).every((k) => ['os', 'chrome'].includes(k))
      && (out.platform.os === null || (typeof out.platform.os === 'string' && out.platform.os.length <= 20))
      && (out.platform.chrome === null || (Number.isSafeInteger(out.platform.chrome) && out.platform.chrome > 0 && out.platform.chrome < 1000)))) drop('platform');
    if (out.type === 'usage_lost' && out.count !== undefined && !(Number.isSafeInteger(out.count) && out.count > 0)) drop('count');
    // agent defaults: a list of defaults out of its shape goes whole.
    cleanAgentDefaults(out, drop);
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
      if (out.where !== undefined && !['panel', 'recorder'].includes(out.where)) drop('where');
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
    // OpenAI's error bodies can echo the request: only the status goes back, and only its error code
    // (an identifier such as insufficient_quota) is read, for the mapping and the log. The server's
    // own key refused (401/403/404) or out of credit or over its budget (429 insufficient_quota) is
    // 424, so the panel tells the agent to tell TNI, not to check a key they don't have or retry.
    if (!upstream.ok) {
      let code = '';
      try { const e = (await upstream.json())?.error?.code; if (typeof e === 'string' && /^[a-z0-9_]{1,40}$/.test(e)) code = e; } catch { /* no JSON */ }
      const status = [401, 403, 404].includes(upstream.status) || code === 'insufficient_quota' ? 424 : upstream.status;
      const retry = upstream.headers.get('retry-after');
      if (retry && status !== 424) res.setHeader('retry-after', retry);
      return done(status, { error: `OpenAI returned HTTP ${upstream.status}` }, `luna upstream ${upstream.status}${code ? ` ${code}` : ''}`);
    }
    let json;
    try { json = await upstream.json(); } catch { return done(502, { error: 'OpenAI sent an unreadable answer' }, 'luna unreadable'); }
    done(200, json, `luna ${lunaDay.count}/${lunaDailyLimit}`);
  }

  // One request's exception is that request's 500, never the end of the server (audit 2026-11-07,
  // SRV-01: a single request used to stop it for every agent). The log gets the error's name and
  // where it was thrown, not its message.
  const failed = (req, res, e) => {
    const where = String(e?.stack ?? '').split('\n').slice(1, 3).map((s) => s.trim()).join(' | ');
    console.error(`${new Date().toISOString()} ${req.method} ${req.url} failed: ${e?.name ?? 'error'}${where ? ` ${where}` : ''}`);
    if (res.headersSent) res.destroy();
    else send(res, 500, { error: 'server error' }, corsHeaders(req));
  };
  // A request callback (sync or async) with that guard.
  const guarded = (req, res, fn) => (...args) => {
    try {
      const out = fn(...args);
      if (out && typeof out.catch === 'function') out.catch((e) => failed(req, res, e));
    } catch (e) { failed(req, res, e); }
  };

  return http.createServer((req, res) => guarded(req, res, respond)(req, res));

  function respond(req, res) {
    const started = Date.now();
    const cors = corsHeaders(req);
    const done = (status, body, note = '') => {
      send(res, status, body, cors);
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${status} ${Date.now() - started}ms ${note}`);
    };
    // A request target that isn't a URL (GET http://[::1/) is the client's mistake, before any check.
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return done(400, { error: 'bad request target' }); }

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
    // The maintainer's usage page: 404 when it is off, so the server says nothing of it.
    if (url.pathname === '/dashboard') {
      if (!dashboardOn) return done(404, { error: 'not found' });
      if (req.method !== 'GET') return done(405, { error: 'use GET' });
      if (!dashboardAuthorized(req)) {
        res.setHeader('www-authenticate', 'Basic realm="Rater usage", charset="UTF-8"');
        return done(401, { error: 'dashboard password required' });
      }
      const window = url.searchParams.get('window') ?? '7d';
      if (!Object.hasOwn(WINDOWS, window)) return done(400, { error: `window must be ${Object.keys(WINDOWS).join(', ')}` });
      const includeTests = url.searchParams.get('tests') === '1';
      const now = clock();
      const key = `${window}|${includeTests}`;
      let page = dashboardPages.get(key);
      if (!page || now - page.at >= dashboardCacheMs) {
        // A page that can't be built is a 500, never an exception that stops the server.
        try {
          page = { at: now, html: renderDashboard(summarize(readRecent(Math.max(...Object.values(WINDOWS)) + 1, now), { now, window, includeTests, testIntakes })) };
        } catch (e) {
          return done(500, { error: 'could not build the dashboard' }, `dashboard ${e?.name ?? 'error'}`);
        }
        dashboardPages.set(key, page);
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
        'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(page.html);
      console.log(`${new Date().toISOString()} GET dashboard ${window}${includeTests ? ' tests' : ''} 200 ${Date.now() - started}ms${page.at === now ? '' : ' cached'}`);
      return;
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
    // In bytes: UTF-8 takes up to 3 per character of the check's count (JSON's length).
    const maxBody = luna ? LUNA_MAX_CHARS * 3 : MAX_BODY;
    // Uploads: at most so many requests and bytes from one address, and none while the disk is too
    // full. The extension keeps refused events queued (any answer but 200 and a receipt).
    const ip = clientIp(req);
    const tooMany = (wait, what) => {
      res.setHeader('retry-after', String(wait));
      return done(429, { error: `too many uploads from this address (${what}); try again in ${wait} s` }, `rate limit ${what} ${ip}`);
    };
    if (!luna) {
      const wait = requestLimit(ip, 1);
      if (wait) return tooMany(wait, 'requests');
      if (tooFull()) {
        res.setHeader('retry-after', '3600');
        return done(507, { error: 'the server is out of space for uploads; the events stay queued' }, 'disk low');
      }
    }

    let size = 0;
    const chunks = [];
    req.on('data', guarded(req, res, (c) => {
      size += c.length;
      if (size > maxBody) { done(413, { error: 'request too large' }); req.destroy(); return; }
      chunks.push(c);
    }));
    req.on('end', guarded(req, res, () => {
      if (res.writableEnded) return;
      if (!luna) {
        const wait = byteLimit(ip, size);
        if (wait) return tooMany(wait, 'bytes');
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, { error: 'body is not valid JSON' }); }
      if (luna) return askLuna(body, done, res);
      if (!Array.isArray(body?.events)) return done(400, { error: 'body.events must be an array' });
      if (body.events.length > MAX_EVENTS_PER_REQUEST) return done(413, { error: `at most ${MAX_EVENTS_PER_REQUEST} events per request` });
      // The request's agent, for events that don't name theirs: in the shape of an event's, or none.
      const agent = typeof body.agent === 'string' && COMMON_SHAPES.agent(body.agent) ? body.agent : null;
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
    }));
  }
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
  const lunaDailyLimit = lunaDailyLimitFrom(process.env.RATER_LUNA_DAILY_LIMIT);
  const dashboardToken = process.env.RATER_DASHBOARD_TOKEN || '';
  if (dashboardToken && dashboardToken.length < MIN_DASHBOARD_TOKEN) console.error(`RATER_DASHBOARD_TOKEN is shorter than ${MIN_DASHBOARD_TOKEN} characters: the dashboard stays off.`);
  const server = createServer({ dataDir, token, adminToken: process.env.RATER_ADMIN_TOKEN || '', openaiKey: process.env.OPENAI_API_KEY || '', lunaDailyLimit,
    dashboardToken, testIntakes: testIntakesFrom(process.env.RATER_TEST_INTAKES),
    clientIpHeader: process.env.RATER_CLIENT_IP_HEADER || '', minFreeBytes: minFreeBytesFrom(process.env.RATER_MIN_FREE_MB) });
  server.listen(port, host, () => {
    console.log(`rater usage server on http://${host}:${server.address().port}  data: ${dataDir}${token ? '  (token required)' : '  (no token: loopback only)'}${process.env.RATER_ADMIN_TOKEN ? '  (export on)' : ''}${process.env.OPENAI_API_KEY ? `  (Luna on, ${lunaDailyLimit}/day)` : ''}${dashboardToken.length >= MIN_DASHBOARD_TOKEN ? '  (dashboard on: /dashboard)' : ''}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
  // Anything outside a request's guard still stops the server, visibly: a timestamped log line and a
  // non-zero exit, so the platform restarts it.
  for (const kind of ['uncaughtException', 'unhandledRejection']) {
    process.on(kind, (e) => {
      console.error(`${new Date().toISOString()} ${kind}: ${e?.stack ?? e}`);
      process.exit(1);
    });
  }
}
