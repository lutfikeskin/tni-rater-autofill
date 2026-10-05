// Merges page_layout events into one layout per carrier, state and product: every page (and step
// of a one-address application), every question seen, its options, and whether it only sometimes
// shows (a follow-up question), with the condition the layouts show for it when there is one
// (conditions.mjs). Same shape as the hand-made captures in captures/<carrier>/, so the replay
// test page can load either.

import { fieldId, inferShowWhen } from './conditions.mjs';
import { CARRIERS } from '../../src/carriers.js';

// Carriers whose steps share one address (AmWINS): their layouts from before 0.9.6 name no step,
// so every step looks like one page whose questions come and go. Those are kept in the page's
// list of questions but not used to tell when a question shows.
export const STEPPED = new Set(CARRIERS.filter((c) => c.layoutSteps).map((c) => c.id));

const KIND = { select: 'combo', radio: 'radio', checkbox: 'checkbox' };

// Same option seen with different spacing/markup in different quotes: keep one.
const tidy = (o) => String(o).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function dedupe(options) {
  const seen = new Set();
  return options.map(tidy).filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
}

export const layoutKey = (carrier, c = {}) => [
  carrier,
  c.state ?? 'XX',
  (c.businessClass ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  (c.vehicleTypes ?? []).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')).sort().join('+') || 'no-vehicles',
  c.trailers ? 'trailers' : null,
].filter(Boolean).join('_');

export function buildLayouts(events, { stepped = STEPPED } = {}) {
  const layouts = new Map();
  for (const e of events) {
    if (e.type !== 'page_layout' || !e.carrier || !e.page) continue;
    // Progressive's portal pages outside the quote flow (home, quote search) are recorded by
    // path, not by page name; they're never filled. Other carriers' pages are all paths.
    if (e.carrier === 'progressive' && e.page.startsWith('/')) continue;
    // An empty layout is a page whose questions all went away, or (before 0.9.6) a fill that ran
    // before the page drew its questions; only the first is evidence.
    if (!(e.fields ?? []).length && !String(e.reason ?? '').split('+').includes('removed')) continue;
    const key = layoutKey(e.carrier, e.context);
    const layout = layouts.get(key) ?? {
      carrier: e.carrier, context: { ...e.context }, sessions: new Set(), from: e.t, to: e.t, pages: new Map(),
    };
    layout.sessions.add(e.session);
    layout.to = e.t;
    // A one-address application's steps (AmWINS) are pages of their own.
    const name = e.step ? `${e.page} › ${e.step}` : e.page;
    const page = layout.pages.get(name) ?? { snapshots: [], fields: new Map(), buttons: [] };
    const fields = (e.fields ?? []).filter((f) => !/^Rater Autofill:|^Su Mo Tu We/.test(f.label ?? ''));
    page.snapshots.push({ fields, mixedSteps: stepped.has(e.carrier) && !e.step });
    for (const b of e.buttons ?? []) if (!page.buttons.includes(b)) page.buttons.push(b);
    for (const f of fields) {
      // Our own mark tooltips got into early layouts as captions; they aren't questions.
      const k = f.q ?? (f.id ? `#${f.id}` : f.dataId ? `${f.dataId}:${f.label}` : `${f.kind}:${f.label}`);
      const prev = page.fields.get(k);
      page.fields.set(k, {
        q: f.q ?? null,
        id: f.id ?? prev?.id ?? undefined,
        dataId: f.dataId ?? prev?.dataId ?? undefined,
        name: f.name ?? prev?.name ?? undefined,
        kind: f.type === 'dctinputdatefield' ? 'date' : KIND[f.kind] ?? 'text',
        caption: f.label,
        opts: dedupe([...(prev?.opts ?? []), ...(f.options ?? [])]),
        // Some capture cut the list short (very long lists): the choices here aren't all of them.
        optsTruncated: f.optionsTruncated || prev?.optsTruncated || undefined,
        mapped: f.mapped ?? prev?.mapped ?? null,
        seen: (prev?.seen ?? 0) + 1,
        required: (prev?.required ?? 0) + (f.required ? 1 : 0),
        cid: prev?.cid ?? fieldId(f),
      });
    }
    layout.pages.set(name, page);
    layouts.set(key, layout);
  }

  return [...layouts].map(([key, l]) => ({
    key,
    layout: {
      carrier: l.carrier,
      context: l.context,
      generated: { from: l.from, to: l.to, quotes: l.sessions.size, by: 'scripts/build-layouts.mjs' },
      pages: Object.fromEntries([...l.pages].map(([name, p]) => {
        const conditions = inferShowWhen(p.snapshots.filter((s) => !s.mixedSteps));
        const captionOf = (cid) => [...p.fields.values()].find((f) => f.cid === cid);
        return [name, {
          fields: [...p.fields.values()].map((f) => {
            const cond = f.seen < p.snapshots.length;
            const when = conditions.get(f.cid);
            const trigger = when && captionOf(when.trigger);
            return {
              ...f,
              opts: f.opts.length ? f.opts : undefined,
              req: f.required > 0 || undefined,
              // Required in some layouts only (after certain answers, like a follow-up).
              reqSometimes: (f.required > 0 && f.required < f.seen) || undefined,
              // Not on every snapshot of the page: shows only after certain answers.
              cond: cond || undefined,
              // The answer it showed with in every layout (conditions.mjs): an observation.
              showWhen: cond && when ? { q: trigger?.q ?? when.triggerField.q ?? null, caption: trigger?.caption ?? when.triggerField.label,
                is: when.is, seen: { shown: when.shown, hidden: when.hidden }, unseen: when.unseen.length ? when.unseen : undefined } : undefined,
              // Shows sometimes, and no single answer on the page explains when (or too few layouts).
              condition: cond && !when ? 'unknown' : undefined,
              seen: undefined,
              required: undefined,
              cid: undefined,
            };
          }),
          // Every button and link seen on the page: evidence for writing button actions. Not
          // `buttons`, which the replay page draws and the fill engine would click.
          seenButtons: p.buttons.length ? p.buttons.slice(0, 80) : undefined,
        }];
      })),
    },
  }));
}
