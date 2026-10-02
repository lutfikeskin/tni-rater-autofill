// Merges page_layout events (recorded after every fill) into one layout per carrier, state and
// product: every page, every question seen, its options, and whether it only sometimes shows
// (a follow-up question). Same shape as the hand-made captures in captures/<carrier>/, so the
// replay test page can load either.

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

export function buildLayouts(events) {
  const layouts = new Map();
  for (const e of events) {
    if (e.type !== 'page_layout' || !e.carrier || !e.page) continue;
    // Progressive's portal pages outside the quote flow (home, quote search) are recorded by
    // path, not by page name; they're never filled. Other carriers' pages are all paths.
    if (e.carrier === 'progressive' && e.page.startsWith('/')) continue;
    const key = layoutKey(e.carrier, e.context);
    const layout = layouts.get(key) ?? {
      carrier: e.carrier, context: { ...e.context }, sessions: new Set(), from: e.t, to: e.t, pages: new Map(),
    };
    layout.sessions.add(e.session);
    layout.to = e.t;
    const page = layout.pages.get(e.page) ?? { snapshots: 0, fields: new Map() };
    page.snapshots++;
    for (const f of e.fields ?? []) {
      // Our own mark tooltips got into early layouts as captions; they aren't questions.
      if (/^Rater Autofill:|^Su Mo Tu We/.test(f.label ?? '')) continue;
      const k = f.q ?? (f.id ? `#${f.id}` : f.dataId ? `${f.dataId}:${f.label}` : `${f.kind}:${f.label}`);
      const prev = page.fields.get(k);
      page.fields.set(k, {
        q: f.q ?? null,
        id: f.id ?? prev?.id ?? undefined,
        dataId: f.dataId ?? prev?.dataId ?? undefined,
        name: f.name ?? prev?.name ?? undefined,
        kind: f.type === 'dctinputdatefield' ? 'date' : KIND[f.kind] ?? 'text',
        caption: f.label,
        req: f.required || undefined,
        opts: dedupe([...(prev?.opts ?? []), ...(f.options ?? [])]),
        mapped: f.mapped ?? prev?.mapped ?? null,
        seen: (prev?.seen ?? 0) + 1,
      });
    }
    layout.pages.set(e.page, page);
    layouts.set(key, layout);
  }

  return [...layouts].map(([key, l]) => ({
    key,
    layout: {
      carrier: l.carrier,
      context: l.context,
      generated: { from: l.from, to: l.to, quotes: l.sessions.size, by: 'scripts/build-layouts.mjs' },
      pages: Object.fromEntries([...l.pages].map(([name, p]) => [name, {
        fields: [...p.fields.values()].map((f) => ({
          ...f,
          opts: f.opts.length ? f.opts : undefined,
          // Not on every snapshot of the page: shows only after certain answers.
          cond: f.seen < p.snapshots || undefined,
          seen: undefined,
        })),
      }])),
    },
  }));
}
