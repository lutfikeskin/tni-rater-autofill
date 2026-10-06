// What changed on a page between two of its layouts in one quote, with the answers changed in
// between: for review ("after Hauls hazmat? → Yes, Placards carried appeared"). Unlike
// conditions.mjs this follows the order of events, so it pairs only what it can trust: two
// layouts of the same page (and step) in a row, with answers changed on that page between them
// (by the agent, the page or a fill), and nothing else in between: no other page, no arrival, no
// vehicle or driver picked, no layout of another page. Events are ordered by `seq` (0.9.4+), else
// time. What it lists happened once; it isn't a rule.

import { fieldId } from './conditions.mjs';
import { sessionContexts } from './events.mjs';
import { STEPPED } from './layouts.mjs';

const pageOf = (e) => (e.step ? `${e.page} › ${e.step}` : e.page);
const reasons = (e) => String(e.reason ?? '').split('+');
const label = (f) => f.label ?? f.caption ?? f.q ?? '';

// What changed between two layouts of a page (also used for manual captures, scripts/captures.mjs).
export function diff(before, after) {
  // A question repeated on either layout (a row per vehicle) can't be matched row to row: left
  // out of both, or a row going away would look like the question appearing.
  const pairsOf = (e) => (e.fields ?? []).map((f) => [fieldId(f), f]).filter(([id]) => id !== null);
  const repeated = new Set();
  for (const e of [before, after]) {
    const seen = new Set();
    for (const [id] of pairsOf(e)) { if (seen.has(id)) repeated.add(id); seen.add(id); }
  }
  const byId = (e) => new Map(pairsOf(e).filter(([id]) => !repeated.has(id)));
  const a = byId(before);
  const b = byId(after);
  const appeared = [...b].filter(([id]) => !a.has(id)).map(([, f]) => label(f));
  const removed = [...a].filter(([id]) => !b.has(id)).map(([, f]) => label(f));
  const options = [];
  const required = [];
  for (const [id, f] of b) {
    const g = a.get(id);
    if (!g) continue;
    // Options compare as layouts deduplicate them: spacing and case aside.
    const norm = (o) => String(o).replace(/\s+/g, ' ').trim().toLowerCase();
    const was = new Map((g.options ?? []).map((o) => [norm(o), o]));
    const now = new Map((f.options ?? []).map((o) => [norm(o), o]));
    const added = [...now].filter(([k]) => !was.has(k)).map(([, o]) => o);
    const gone = [...was].filter(([k]) => !now.has(k)).map(([, o]) => o);
    if (added.length || gone.length) options.push({ question: label(f), added, removed: gone });
    if (!!g.required !== !!f.required) required.push({ question: label(f), required: !!f.required });
  }
  return { appeared, removed, options, required };
}

export function layoutTransitions(events, { stepped = STEPPED } = {}) {
  const contexts = sessionContexts(events);
  // One sequence per quote and view: the tab and vehicle/driver an event was on (`view`, 0.9.7+).
  // Events without a view (older ones) share one sequence per quote, so two tabs on the same page
  // can be mixed there.
  const bySession = new Map();
  for (const e of events) {
    if (!e.session) continue;
    const key = `${e.session}|${e.view ?? ''}`;
    if (!bySession.has(key)) bySession.set(key, { session: e.session, list: [] });
    bySession.get(key).list.push(e);
  }
  const out = [];
  for (const { session, list } of bySession.values()) {
    const ordered = list.every((e) => Number.isInteger(e.seq)) ? [...list].sort((x, y) => x.seq - y.seq) : list;
    let last = null; // { page, layout, changes }
    for (const e of ordered) {
      if (e.type === 'page_layout') {
        // A one-address application's layout without its step (before 0.9.6): can't be paired.
        if (stepped.has(e.carrier) && !e.step) { last = null; continue; }
        const page = pageOf(e);
        const fresh = reasons(e).some((r) => r === 'arrived' || r === 'picked');
        if (last && last.page === page && !fresh && last.changes.length) {
          const d = diff(last.layout, e);
          if (d.appeared.length || d.removed.length || d.options.length || d.required.length) {
            // The layout's own state: the agent may have corrected the intake's since it loaded.
            out.push({ session, carrier: e.carrier, page, state: e.context?.state ?? contexts.get(session)?.state ?? null,
              after: last.changes, ...d });
          }
        }
        last = { page, layout: e, changes: [] };
      } else if (e.type === 'page_view' && last && e.page !== last.layout.page) {
        last = null;
      } else if (e.type === 'layout_error' && last && e.page === last.layout.page) {
        // The page changed but couldn't be read: the next layout isn't one step after the last.
        last = null;
      } else if (last && e.page === last.layout.page && (e.type === 'field_change' || (e.type === 'fill_field' && e.result === 'filled'))) {
        // A typed value is never logged: it shows as "edited".
        const to = e.type === 'fill_field' ? (e.shown ?? 'filled') : (e.to ?? e.change ?? null);
        last.changes.push({ question: e.label ?? e.q ?? '', from: e.from ?? null, to, by: e.type === 'fill_field' ? 'fill' : e.by });
      }
    }
  }
  return out;
}

// The same change with the same effect, counted across quotes.
export function summarizeTransitions(list) {
  const groups = new Map();
  for (const t of list) {
    // Who answered (the agent, the page, or the extension's fill) is part of the cause.
    const cause = t.after.map((c) => `${c.question}: ${c.from ?? '∅'} → ${c.to ?? '∅'} (${c.by ?? '?'})`).join('; ');
    const effect = [
      ...t.appeared.map((x) => `+ ${x}`), ...t.removed.map((x) => `− ${x}`),
      ...t.options.map((o) => `${o.question}: choices ${o.added.map((x) => `+${x}`).concat(o.removed.map((x) => `−${x}`)).join(' ')}`),
      ...t.required.map((r) => `${r.question}: ${r.required ? 'now required' : 'no longer required'}`),
    ].join('; ');
    const key = `${t.carrier}|${t.page}|${cause}|${effect}`;
    const g = groups.get(key) ?? { carrier: t.carrier, page: t.page, cause, effect, quotes: new Set(), states: new Set() };
    g.quotes.add(t.session);
    if (t.state) g.states.add(t.state);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, quotes: g.quotes.size, states: [...g.states].sort() }))
    .sort((a, b) => b.quotes - a.quotes || a.page.localeCompare(b.page));
}
