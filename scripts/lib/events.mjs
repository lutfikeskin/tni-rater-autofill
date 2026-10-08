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

export function loadEvents(paths) {
  const byId = new Map();
  const noId = [];
  for (const p of paths) {
    for (const f of files(p)) {
      for (const e of readFile(f)) {
        const ev = { ...e, page: e.page ? e.page.replace(/-Reload$/, '') : e.page };
        if (ev.page === 'blank') continue;
        // The local test page's events (stored before the server refused them) are no agent's work.
        if (ev.carrier === 'test') continue;
        // The same event from the server and from an export: keep when the server received it.
        const prev = ev.id ? byId.get(ev.id) : null;
        if (ev.id) byId.set(ev.id, prev?.receivedAt && !ev.receivedAt ? { ...ev, receivedAt: prev.receivedAt } : ev); else noId.push(ev);
      }
    }
  }
  return [...byId.values(), ...noId].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// session id -> intake_loaded event (state, business class, vehicle types, …)
export function sessionContexts(events) {
  const out = new Map();
  for (const e of events) if (e.type === 'intake_loaded' && e.session) out.set(e.session, e);
  return out;
}
