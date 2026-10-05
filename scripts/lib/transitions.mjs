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

function diff(before, after) {
  const byId = (e) => new Map((e.fields ?? []).map((f) => [fieldId(f), f]).filter(([id]) => id !== null));
  const a = byId(before);
  const b = byId(after);
  const appeared = [...b].filter(([id]) => !a.has(id)).map(([, f]) => label(f));
  const removed = [...a].filter(([id]) => !b.has(id)).map(([, f]) => label(f));
  const options = [];
  const required = [];
  for (const [id, f] of b) {
    const g = a.get(id);
    if (!g) continue;
    const was = new Set(g.options ?? []);
    const now = new Set(f.options ?? []);
    const added = [...now].filter((o) => !was.has(o));
    const gone = [...was].filter((o) => !now.has(o));
    if (added.length || gone.length) options.push({ question: label(f), added, removed: gone });
    if (!!g.required !== !!f.required) required.push({ question: label(f), required: !!f.required });
  }
  return { appeared, removed, options, required };
}

export function layoutTransitions(events, { stepped = STEPPED } = {}) {
  const contexts = sessionContexts(events);
  const bySession = new Map();
  for (const e of events) {
    if (!e.session) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const out = [];
  for (const [session, list] of bySession) {
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
            out.push({ session, carrier: e.carrier, page, state: contexts.get(session)?.state ?? e.context?.state ?? null,
              after: last.changes, ...d });
          }
        }
        last = { page, layout: e, changes: [] };
      } else if (e.type === 'page_view' && last && e.page !== last.layout.page) {
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
    const cause = t.after.map((c) => `${c.question}: ${c.from ?? '∅'} → ${c.to ?? '∅'}`).join('; ');
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
