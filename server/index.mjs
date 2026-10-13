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

// Addresses only this computer can reach: the one place an upload needs no token.
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;
// Why the server must not start with this host and token: null when it may. Fail closed: a
// deployment that lost its RATER_TOKEN variable stops, rather than taking anyone's events.
export function startupError({ host, token }) {
  if (token || LOOPBACK.test(String(host))) return null;
  return `RATER_TOKEN is not set and HOST=${host} is not loopback: refusing to start an open upload endpoint. Set RATER_TOKEN (docs/hosting.md), or bind HOST to 127.0.0.1 for local use.`;
}

// Event type -> fields kept. Anything else in an event is dropped.
export const COMMON = ['id', 't', 'v', 'channel', 'commit', 'agent', 'session', 'intakeId', 'seq', 'type', 'carrier', 'page', 'view'];
export const EVENT_FIELDS = {
  intake_loaded: ['formVersion', 'answers', 'state', 'businessClass', 'vehicleTypes', 'counts', 'coverages', 'warnings'],
  intake_closed: ['reason'],
  intake_edit: ['path', 'kind', 'change', 'warnings'],
  warning_checked: ['code', 'path', 'checked'],
  page_view: ['from', 'fields'],
  // messages: what the page said about the answers (validation, errors, help), redacted by the panel.
  page_layout: ['context', 'fields', 'buttons', 'reason', 'step', 'messages'],
  // A page layout the panel couldn't record (why it was asked for, and the error's first words).
  layout_error: ['reason', 'error'],
  // pageChanged: the carrier probably changed the page; reworded: known fields whose question reads
  // differently; renamed: known questions whose data-model name isn't on the page (rule, names).
  // run: one fill invocation, shared with its fill_field events; rules: the rule files'
  // fingerprint; settings: the panel's filling switches; step: a one-address application's step
  // (AmWINS). Their shapes are checked below (RUN_FIELDS): a malformed value refuses the event.
  fill_run: ['run', 'rules', 'settings', 'step', 'overwrite', 'auto', 'ms', 'fields', 'rounds', 'filled', 'kept', 'noData', 'failed', 'leftRequired', 'unknown', 'clicked', 'blockers', 'blockerList', 'advanced', 'pageChanged', 'reworded', 'renamed'],
  // how: what found the field (field = data-model name, text, option, selector, label, name).
  fill_field: ['run', 'step', 'result', 'q', 'key', 'label', 'path', 'controlKind', 'shown', 'reason', 'options', 'timing', 'how'],
  fill_error: ['run', 'rules', 'settings', 'auto', 'error'],
  field_change: ['step', 'q', 'key', 'label', 'kind', 'by', 'autofilled', 'change', 'vsAutofill', 'matchesIntake', 'from', 'to'],
  problem_report: ['text'],
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

export function createServer({ dataDir, token = '', adminToken = '' } = {}) {
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
    // A page's messages: at most 40 lines of at most 200 characters.
    if (out.messages !== undefined && !(Array.isArray(out.messages) && out.messages.length <= 40 && out.messages.every((m) => typeof m === 'string' && m.length <= 200))) drop('messages');
    // A crash: where, a bounded message, and frames inside the extension's files only.
    if (out.type === 'client_error') {
      if (out.where !== undefined && out.where !== 'panel') drop('where');
      if (out.error !== undefined && !(typeof out.error === 'string' && out.error.length <= 300)) drop('error');
      if (out.stack !== undefined && !(Array.isArray(out.stack) && out.stack.length <= 4 && out.stack.every((x) => typeof x === 'string' && x.length <= 160 && /^[\w./-]+:\d+:\d+$/.test(x)))) drop('stack');
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
    if (url.pathname !== '/v1/events') return done(404, { error: 'not found' });
    if (req.method !== 'POST') return done(405, { error: 'use POST' });
    if (!authorized(req)) return done(401, { error: 'missing or wrong token' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return done(415, { error: 'send application/json' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { done(413, { error: 'request too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, { error: 'body is not valid JSON' }); }
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
  const server = createServer({ dataDir, token, adminToken: process.env.RATER_ADMIN_TOKEN || '' });
  server.listen(port, host, () => {
    console.log(`rater usage server on http://${host}:${server.address().port}  data: ${dataDir}${token ? '  (token required)' : '  (no token: loopback only)'}${process.env.RATER_ADMIN_TOKEN ? '  (export on)' : ''}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
