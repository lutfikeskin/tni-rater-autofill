#!/usr/bin/env node
// Usage-log collection server for the rater autofill extension.
//
//   node server/index.mjs                  # http://127.0.0.1:8787, data in ./server-data
//   PORT=8787 HOST=0.0.0.0 DATA_DIR=/srv/rater RATER_TOKEN=secret node server/index.mjs
//
// POST /v1/events   { agent, version, events: [...] }  -> { accepted, duplicates }
// GET  /v1/health                                       -> { ok, events }
// GET  /v1/days      (admin token)                      -> { days: [{ day, bytes }] }
// GET  /v1/export?since=YYYY-MM-DD[&until=YYYY-MM-DD] (admin token) -> the days' JSONL, in order
//
// Events are appended to DATA_DIR/events/YYYY-MM-DD.jsonl (by day received), one JSON object
// per line; the review scripts (scripts/*.mjs) read that folder directly. Each event carries an
// id, so an extension retrying an upload never creates duplicates.
//
// The extension never sends client data (see src/usage.js); as a second line of defence the
// server only accepts known event types and drops fields it doesn't expect.
//
// Listens on 127.0.0.1 unless HOST says otherwise. When exposed beyond this computer, set
// RATER_TOKEN and put it behind HTTPS (Railway does: see docs/hosting.md). RATER_TOKEN is the
// upload token the extension ships with; reading the logs back needs RATER_ADMIN_TOKEN, which
// only TNI (and the daily review job) has. Without RATER_ADMIN_TOKEN the export is switched off.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_EVENTS_PER_REQUEST = 2000;
const MAX_EVENT_BYTES = 32 * 1024;

// Event type -> fields kept. Anything else in an event is dropped.
export const COMMON = ['id', 't', 'v', 'agent', 'session', 'intakeId', 'type', 'carrier', 'page'];
export const EVENT_FIELDS = {
  intake_loaded: ['formVersion', 'answers', 'state', 'businessClass', 'vehicleTypes', 'counts', 'coverages', 'warnings'],
  intake_closed: ['reason'],
  intake_edit: ['path', 'kind', 'change', 'warnings'],
  warning_checked: ['code', 'path', 'checked'],
  page_view: ['from', 'fields'],
  page_layout: ['context', 'fields', 'buttons'],
  fill_run: ['overwrite', 'auto', 'ms', 'fields', 'rounds', 'filled', 'kept', 'noData', 'failed', 'leftRequired', 'unknown', 'clicked', 'blockers', 'blockerList', 'advanced'],
  fill_field: ['result', 'q', 'label', 'path', 'controlKind', 'shown', 'reason', 'options', 'timing'],
  fill_error: ['auto', 'error'],
  field_change: ['q', 'label', 'kind', 'by', 'autofilled', 'change', 'vsAutofill', 'matchesIntake', 'from', 'to'],
  problem_report: ['text'],
  // AI assistant: one per request to the model, one per suggestion the agent (or the auto-select
  // setting) acted on. Choices are option texts; typed text suggestions are never logged.
  ai_suggest: ['model', 'ms', 'items', 'suggested', 'leave', 'autoOk', 'blocked', 'error', 'tokensIn', 'tokensOut', 'cached'],
  ai_decision: ['q', 'label', 'controlKind', 'decision', 'choice', 'confidence', 'basis', 'intakePath', 'reason'],
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
  const authorized = (req) => !token || matches(req, token);
  const isAdmin = (req) => !!adminToken && matches(req, adminToken);
  const dayFiles = () => fs.readdirSync(eventsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();

  function clean(e, agent) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'event is not an object' };
    const keep = EVENT_FIELDS[e.type];
    if (!keep) return { error: `unknown event type "${String(e.type).slice(0, 40)}"` };
    if (typeof e.id !== 'string' || !/^[\w-]{8,64}$/.test(e.id)) return { error: 'event id missing or invalid' };
    if (typeof e.t !== 'string' || Number.isNaN(Date.parse(e.t))) return { error: 'event time missing or invalid' };
    if (JSON.stringify(e).length > MAX_EVENT_BYTES) return { error: 'event too large' };
    const out = {};
    for (const k of [...COMMON, ...keep]) if (e[k] !== undefined) out[k] = e[k];
    // Layouts: never keep option lists naming agency staff (agent of record, producer codes).
    if (out.type === 'page_layout' && Array.isArray(out.fields)) {
      out.fields = out.fields.map((f) => (/agent|producer/i.test(f?.label ?? '') ? { ...f, options: undefined } : f));
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
    if (req.method === 'GET' && url.pathname === '/v1/health') return done(200, { ok: true, events: seen.size });
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
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = path.resolve(process.env.DATA_DIR || 'server-data');
  const server = createServer({ dataDir, token: process.env.RATER_TOKEN || '', adminToken: process.env.RATER_ADMIN_TOKEN || '' });
  server.listen(port, host, () => {
    console.log(`rater usage server on http://${host}:${port}  data: ${dataDir}${process.env.RATER_TOKEN ? '  (token required)' : ''}${process.env.RATER_ADMIN_TOKEN ? '  (export on)' : ''}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
