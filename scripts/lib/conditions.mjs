// When a question shows, inferred from page layouts one at a time. Each layout (page_layout,
// since 0.9.5) lists the questions on the page and the choice each had picked (`selected`).
// "F shows when T is one of V" is kept only if, over every layout of the page where T had a pick,
// F was there exactly when T's pick was in V, and both sides were seen. Layouts are taken one by
// one, so this doesn't depend on the order of events, on tabs or on timing. It is an observation
// from the layouts gathered, not a rule from the carrier: picks never seen are listed as unseen,
// and a question with no consistent trigger is "shows sometimes, condition unknown".

const tidy = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// A question's identity on a page: its question id, else its element id, data-id or name, else its
// kind and label. One with none of them (no label either), or one that repeats on the page (a row
// per vehicle), can't be told apart and is left out (null).
export function fieldId(f) {
  if (f.q) return f.q;
  if (f.id) return `#${f.id}`;
  if (f.dataId) return `data:${f.dataId}`;
  if (f.name) return `name:${f.name}`;
  const label = tidy(f.label ?? f.caption).toLowerCase();
  return label ? `${f.kind ?? ''}:${label}` : null;
}

// Layouts on each side (question showing, question hidden) a condition needs before it's kept.
export const MIN_LAYOUTS = 2;

// A list's prompt ("Select one", "--") isn't an answer to try.
const isPlaceholder = (o) => /^(-+|select\b|choose\b|please\b)/i.test(o);

// Picks compare as the layout's options are deduplicated, and as the replay compares answers:
// spacing and case aside ("Yes" and "YES" are one answer).
const sameAnswer = (v) => v.toLowerCase();

const pickOf = (f) => (f?.selected === undefined || f.selected === null || tidy(f.selected) === '' ? null : tidy(f.selected));

/**
 * @param {{fields: object[]}[]} snapshots  layouts of one page (same carrier, context group, step)
 * @param {{min?: number}} opts  layouts needed on each side
 * @returns {Map<string, null | {trigger: string, triggerField: object, is: string[], shown: number, hidden: number, unseen: string[]}>}
 *   for each question that is missing from some layout: its condition, or null when no trigger
 *   explains it. Questions on every layout aren't in the map.
 */
export function inferShowWhen(snapshots, { min = MIN_LAYOUTS } = {}) {
  const ambiguous = new Set();
  const order = [];
  const latest = new Map();
  const snaps = snapshots.map((s) => {
    const m = new Map();
    for (const f of s.fields ?? []) {
      const id = fieldId(f);
      if (id === null) continue;
      if (m.has(id)) { ambiguous.add(id); continue; }
      m.set(id, f);
      if (!latest.has(id)) order.push(id);
      latest.set(id, f);
    }
    return m;
  });
  // Layouts that recorded picks at all (0.9.5+): in those, a trigger without a pick was unanswered.
  const withPicks = snapshots.map((s) => (s.fields ?? []).some((f) => f.selected !== undefined));
  const out = new Map();
  for (const target of order) {
    if (ambiguous.has(target)) continue;
    const present = snaps.map((m) => m.has(target));
    if (present.every(Boolean)) continue;
    let best = null;
    for (const trigger of order) {
      if (trigger === target || ambiguous.has(trigger)) continue;
      const shown = new Map();
      const hidden = new Map();
      let ok = true;
      snaps.forEach((m, i) => {
        const t = m.get(trigger);
        // The question was there without the trigger: not this trigger's follow-up.
        if (!t) { if (present[i]) ok = false; return; }
        const v = pickOf(t);
        // The question was there while the trigger was unanswered (or showed something that isn't
        // one of its choices): the replay would hide it in that state, so this trigger can't be it.
        if (v === null) { if (present[i] && withPicks[i]) ok = false; return; }
        const side = present[i] ? shown : hidden;
        const key = sameAnswer(v);
        const was = side.get(key);
        side.set(key, { spelling: was?.spelling ?? v, count: (was?.count ?? 0) + 1 });
      });
      const count = (side) => [...side.values()].reduce((a, b) => a + b.count, 0);
      if (!ok || count(shown) < min || count(hidden) < min || [...shown.keys()].some((v) => hidden.has(v))) continue;
      const candidate = { trigger, is: [...shown.values()].map((x) => x.spelling), shown: count(shown), hidden: count(hidden), above: order.indexOf(trigger) < order.indexOf(target) };
      const support = (c) => c.shown + c.hidden;
      // Most layouts behind it; then a trigger above the question (follow-ups sit below what
      // they follow); then the fewest picks.
      if (!best || support(candidate) > support(best)
        || (support(candidate) === support(best) && (candidate.above && !best.above
          || (candidate.above === best.above && candidate.is.length < best.is.length)))) best = candidate;
    }
    if (!best) { out.set(target, null); continue; }
    const triggerField = latest.get(best.trigger);
    const seen = new Set(snaps.map((m) => pickOf(m.get(best.trigger))).filter((v) => v !== null).map(sameAnswer));
    const options = [...new Set(snapshots.flatMap((s) => (s.fields ?? []).filter((f) => fieldId(f) === best.trigger).flatMap((f) => f.options ?? [])).map(tidy))];
    out.set(target, { trigger: best.trigger, triggerField, is: best.is, shown: best.shown, hidden: best.hidden,
      unseen: options.filter((o) => o && !isPlaceholder(o) && !seen.has(sameAnswer(o))) });
  }
  return out;
}

// The same inference within each group of layouts (quotes asking for the same coverages), so a
// question that shows only for some coverages can't be pinned on an unrelated answer that happened
// to go with them. A question keeps a condition only if every group that saw it come and go found
// the same trigger; the counts add up and an answer is unseen only if no group saw it.
export function inferShowWhenByGroup(groups, opts) {
  const results = groups.map((snapshots) => inferShowWhen(snapshots, opts));
  const out = new Map();
  for (const id of new Set(results.flatMap((r) => [...r.keys()]))) {
    const found = results.map((r) => r.get(id)).filter((x) => x !== undefined);
    if (found.some((x) => x === null) || new Set(found.map((x) => x.trigger)).size > 1) { out.set(id, null); continue; }
    const is = new Map();
    for (const x of found) for (const v of x.is) if (!is.has(sameAnswer(v))) is.set(sameAnswer(v), v);
    const unseen = found.map((x) => new Set(x.unseen.map(sameAnswer)));
    out.set(id, { ...found[0], is: [...is.values()],
      shown: found.reduce((n, x) => n + x.shown, 0), hidden: found.reduce((n, x) => n + x.hidden, 0),
      unseen: found[0].unseen.filter((v) => unseen.every((u) => u.has(sameAnswer(v))) && !is.has(sameAnswer(v))) });
  }
  return out;
}
