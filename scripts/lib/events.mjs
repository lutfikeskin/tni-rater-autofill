// Loads usage events for the review scripts from any mix of:
//  - the collection server's data folder (server-data/ or server-data/events/*.jsonl),
//  - JSON-lines files,
//  - "Export log" files from the side panel (rater-usage-*.json).
// Events are de-duplicated by id and sorted by time. Older exports get the export's agent
// initials, and "<Page>-Reload" pages are merged into "<Page>".

import fs from 'node:fs';
import path from 'node:path';

function* files(p) {
  const stat = fs.statSync(p);
  if (!stat.isDirectory()) { yield p; return; }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(jsonl|json)$/i.test(entry.name)) yield full;
  }
}

function readFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) {
    return text.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const data = JSON.parse(text);
  if (data?.kind !== 'usage-log') return [];
  return (data.events ?? []).map((e) => ({ ...e, agent: e.agent ?? data.agent ?? null }));
}

// Every event in the files once per id, as stored: the quoting history warehouse keeps them all
// (scripts/lib/warehouse.mjs).
export function readEvents(paths) {
  const byId = new Map();
  const noId = [];
  for (const p of paths) {
    for (const f of files(p)) {
      for (const e of readFile(f)) {
        // The same event from the server and from an export: keep when the server received it.
        const prev = e.id ? byId.get(e.id) : null;
        if (e.id) byId.set(e.id, prev?.receivedAt && !e.receivedAt ? { ...e, receivedAt: prev.receivedAt } : e); else noId.push(e);
      }
    }
  }
  return [...byId.values(), ...noId];
}

// `stored`: readEvents(paths), when the caller already read them.
export function loadEvents(paths, stored = readEvents(paths)) {
  const all = stored.map((e) => ({ ...e, page: e.page ? e.page.replace(/-Reload$/, '') : e.page })).filter((e) => e.page !== 'blank');
  // The local test page (stored before the server refused it) is no agent's work: its events, and a
  // quote that only ever filled it whole (its intake events have no carrier). A quote that also
  // worked on a carrier keeps everything else.
  const onTest = new Set(all.filter((e) => e.carrier === 'test' && e.session).map((e) => e.session));
  const onCarrier = new Set(all.filter((e) => isCarrierEvent(e) && e.session).map((e) => e.session));
  return all.filter((e) => e.carrier !== 'test' && !(onTest.has(e.session) && !onCarrier.has(e.session)))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// An event on a real carrier's page (not the local test page).
export const isCarrierEvent = (e) => !!e.carrier && e.carrier !== 'test';

// A layout of a page's questions. A Recalculate's trace (page_layout, reason 'recalculate', W43-44)
// holds the kept answers over time instead, and isn't one.
export const isPageLayout = (e) => e.type === 'page_layout' && e.reason !== 'recalculate';

// The quotes: intakes loaded in a session that worked on a carrier's page. A PDF loaded and never
// taken to a carrier (a sample retried, a test-page session whose test events the server refused)
// is no quote. `events`: all of them, so a quote whose fills come later still counts.
export function quoteSessions(events) {
  const onCarrier = new Set(events.filter((e) => isCarrierEvent(e) && e.session).map((e) => e.session));
  return new Set(events.filter((e) => e.type === 'intake_loaded' && onCarrier.has(e.session)).map((e) => e.session));
}

// session id -> intake_loaded event (state, business class, vehicle types, …)
export function sessionContexts(events) {
  const out = new Map();
  for (const e of events) if (e.type === 'intake_loaded' && e.session) out.set(e.session, e);
  return out;
}
