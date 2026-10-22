// Merges page_layout events into one layout per carrier, state and product: every page (and step
// of a one-address application), every question seen, its options, and whether it only sometimes
// shows (a follow-up question), with the condition the layouts show for it when there is one
// (conditions.mjs). Same shape as the hand-made captures in captures/<carrier>/, so the replay
// test page can load either.

import { fieldId, inferShowWhenByGroup } from './conditions.mjs';
import { CARRIERS } from '../../src/carriers.js';
import { knownStep } from '../../src/usage.js';
import { isPageLayout } from './events.mjs';

// Carriers whose steps share one address (AmWINS): their layouts from before 0.9.6 name no step,
// so every step looks like one page whose questions come and go. Those are kept in the page's
// list of questions but not used to tell when a question shows.
export const STEPPED = new Set(CARRIERS.filter((c) => c.layoutSteps).map((c) => c.id));

// The step a layout names, as the carrier's own step name (knownStep), as layouts send it
// from PR #65 on. Older layouts sent the raw visible heading
// ("Draft Application Saved! / Insured Info"): one that holds a step name joins that step; any
// other heading is kept as it was, so it still groups as before.
const BY_ID = new Map(CARRIERS.map((c) => [c.id, c]));
export function layoutStep(e) {
  if (!e.step) return undefined;
  return knownStep(BY_ID.get(e.carrier), e.step) ?? e.step;
}

// Pages about one vehicle or driver (Progressive's AddVehicle, AddDriver): their layouts come from
// different vehicles and drivers, which can differ in ways no answer on the page explains, and the
// layouts don't say which one they were about. Left out of conditions.
export const ENTITY_PAGES = new Map(CARRIERS.map((c) => [c.id, new Set([...(c.vehiclePages ?? []), ...(c.trailerPages ?? []), ...(c.driverPage ? [c.driverPage] : [])])]));

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

// The fallback (no id of any kind) is the caption with the kind, as the inference tells them apart.
function triggerIdentity(f, kind) {
  if (f.q) return { q: f.q };
  if (f.id) return { q: null, id: f.id };
  if (f.dataId) return { q: null, dataId: f.dataId };
  if (f.name) return { q: null, name: f.name };
  return { q: null, kind };
}

// A field's key across a page's layouts: its data-model name (recorded since 0.9.9); a Duck Creek
// question without one by its text, as its number is reassigned (Progressive, 2026-10-07: the same
// question recorded on both sides would show up twice); rows named after a vehicle by their number
// (their text names the vehicle, not the question); else its element id, data-id, or kind and
// caption. Two questions of a page reading the same (the business's and the owner's "City") are
// told apart by the nearest question before them that every layout of the page shows once, so
// one missing from a layout doesn't take the other's place. A data-model name some layout of the
// page shows more than once is a question asked per vehicle or trailer (Progressive's Rates: a
// row of the same questions for each): each row is its own field, by its Duck Creek row (`row`,
// "<page>_<row>"), so rows line up across quotes by number (one vehicle's with the same row of a
// quote with three). The decision is the page's, as for repeated texts.
const VEHICLE_CAPTION = /^(19|20)\d{2}\s+\S/;
const textOf = (f) => String(f.label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const byText = (f) => !f.ref && !!f.q && !!textOf(f) && !VEHICLE_CAPTION.test(textOf(f));
function snapshotKeys(snapshots) {
  const repeated = new Set();
  const perRow = new Set();
  for (const s of snapshots) {
    const seen = new Set();
    for (const f of s.fields.filter(byText)) {
      const k = `${f.kind}:${textOf(f)}`;
      if (seen.has(k)) repeated.add(k);
      seen.add(k);
    }
    const refs = new Set();
    for (const f of s.fields.filter((x) => x.ref)) {
      if (refs.has(f.ref)) perRow.add(f.ref);
      refs.add(f.ref);
    }
  }
  // A per-row field recorded before rows has only its order among its name's fields in its layout
  // (`ref:<name>#<n>`): it joins the row first seen in that order when that is one row, else it
  // stays one field per name, as before rows.
  const rowsAt = new Map();
  const placed = new Set();
  for (const s of snapshots) {
    const nth = new Map();
    for (const f of s.fields.filter((x) => perRow.has(x.ref))) {
      nth.set(f.ref, (nth.get(f.ref) ?? 0) + 1);
      const key = `ref:${f.ref}@${f.row}`;
      if (!f.row || placed.has(key)) continue;
      placed.add(key);
      const order = `ref:${f.ref}#${nth.get(f.ref)}`;
      rowsAt.set(order, (rowsAt.get(order) ?? new Set()).add(key));
    }
  }
  const unrowed = (ref, n) => {
    const keys = rowsAt.get(`ref:${ref}#${n}`);
    return keys?.size === 1 ? [...keys][0] : `ref:${ref}`;
  };
  const counts = snapshots.filter((s) => s.fields.length).map((s) => {
    const c = new Map();
    for (const f of s.fields) if (textOf(f)) c.set(textOf(f), (c.get(textOf(f)) ?? 0) + 1);
    return c;
  });
  const anchors = new Set([...(counts[0]?.keys() ?? [])].filter((t) => counts.every((c) => c.get(t) === 1)));
  // Where each named field sits (its text after its anchor), so a repeated text recorded before
  // names joins the named field in the same place.
  const placeOf = new Map();
  const keys = snapshots.map((s) => {
    let anchor = '';
    const seen = new Map();
    const nth = new Map();
    return s.fields.map((f) => {
      // Two after the same anchor (rows of one block): their order there.
      const group = `${f.kind}:${textOf(f)}@${anchor}`;
      seen.set(group, (seen.get(group) ?? 0) + 1);
      const place = `${group}#${seen.get(group)}`;
      let key;
      if (f.ref) {
        if (perRow.has(f.ref)) nth.set(f.ref, (nth.get(f.ref) ?? 0) + 1);
        key = !perRow.has(f.ref) ? `ref:${f.ref}` : f.row ? `ref:${f.ref}@${f.row}` : unrowed(f.ref, nth.get(f.ref));
        if (!placeOf.has(key)) placeOf.set(key, place);
      } else if (byText(f)) key = repeated.has(`${f.kind}:${textOf(f)}`) ? `text:${place}` : `text:${f.kind}:${textOf(f)}`;
      else key = f.q ?? (f.id ? `#${f.id}` : f.dataId ? `${f.dataId}:${f.label}` : `${f.kind}:${f.label}`);
      if (anchors.has(textOf(f))) anchor = textOf(f);
      return key;
    });
  });
  return { keys, placeOf };
}

// One field of a page, merged over its layouts.
function addField(fields, k, f) {
  const prev = fields.get(k);
  fields.set(k, {
    q: f.q ?? null,
    ref: f.ref ?? prev?.ref ?? undefined,
    id: f.id ?? prev?.id ?? undefined,
    dataId: f.dataId ?? prev?.dataId ?? undefined,
    name: f.name ?? prev?.name ?? undefined,
    // Its Duck Creek row while every layout that recorded one agrees (null once two disagree): a
    // per-row field's always does, and the replay draws the field in it.
    row: !f.row ? prev?.row : prev?.row === undefined || prev.row === f.row ? f.row : null,
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

// Fields kept under their text (recorded before data-model names) join the one named field of the
// page with the same kind and text; a text two questions share joins the one in the same place
// (after the same anchor). Never a field drawn beside it in one layout: two controls reading the
// same at once (Rates' cargo section and cargo row) are two questions (Codex on PR #56). `keys`:
// each layout's field keys. Returns which text keys joined which named field.
function mergeUnnamed(fields, placeOf = new Map(), keys = []) {
  const merged = new Map();
  const named = [...fields].filter(([k]) => k.startsWith('ref:'));
  const together = (a, b) => keys.some((ks) => ks.includes(a) && ks.includes(b));
  for (const [k, f] of [...fields]) {
    if (!k.startsWith('text:')) continue;
    let same = named.filter(([nk, n]) => n.kind === f.kind && String(n.caption ?? '').trim().toLowerCase() === String(f.caption ?? '').trim().toLowerCase() && !together(k, nk));
    if (same.length > 1 && k.includes('@')) same = same.filter(([nk]) => placeOf.get(nk) === k.slice('text:'.length));
    if (same.length !== 1) continue;
    const [nk, n] = same[0];
    fields.set(nk, { ...n, opts: dedupe([...(n.opts ?? []), ...(f.opts ?? [])]), seen: n.seen + f.seen, required: n.required + f.required, mapped: n.mapped ?? f.mapped });
    fields.delete(k);
    merged.set(k, nk);
  }
  return merged;
}

// The layouts of a page name one question the same way for the inference too: by its data-model
// name when it has one, else by its latest number (recorded before names, or under two numbers
// around Progressive's renumbering), so its answers on both sides count together.
function sameIdentities(p, merged) {
  for (const [k, f] of p.fields) if (k.startsWith('ref:') || k.startsWith('text:')) f.cid = fieldId(f);
  for (const s of p.snapshots) {
    s.fields = s.fields.map((f, i) => {
      const k = merged.get(s.keys[i]) ?? s.keys[i];
      const field = p.fields.get(k);
      if (!field || (!k.startsWith('text:') && !k.startsWith('ref:'))) return f;
      // Its latest number too: the replay finds a trigger by it.
      return { ...f, ref: f.ref ?? field.ref, q: field.q ?? f.q };
    });
  }
}

// A question's identity without its row or its order among its name's rows: `ref:<name>` (or a
// text key, kept whole: it tells the business's and the owner's "City" apart).
const baseId = (k) => (String(k).startsWith('ref:') ? String(k).replace(/[@#].*$/, '') : String(k));

// Which question each recorded field of a quote was, across Progressive's renumbering (2026-10-07)
// and across products, for the learner: the same keys and joins as buildLayouts (snapshotKeys,
// mergeUnnamed), with every layout of a page together. A field recorded before names joins the
// named field with its text (in its place, when the text repeats).
//   byField:   `<session>|<page>|<q>` -> { id, ref, caption, kind }; id is a data-model name
//              (ref:<name>) or the question's text on its page (text:…), a number only when it has
//              neither (no text: a bare number)
//   byCaption: `<carrier>|<page>|<text>` -> the one question a text names on the page, else null
export function fieldIdentities(events) {
  const pages = new Map();
  for (const e of events) {
    if (!isPageLayout(e) || !e.carrier || !e.page || !e.session) continue;
    if (e.carrier === 'progressive' && e.page.startsWith('/')) continue;
    const name = e.step ? `${e.page} › ${layoutStep(e)}` : e.page;
    const p = pages.get(`${e.carrier}|${name}`) ?? { carrier: e.carrier, page: e.page, snapshots: [] };
    const fields = (e.fields ?? []).filter((f) => !/^Rater Autofill:|^Su Mo Tu We/.test(f.label ?? ''));
    if (fields.length) p.snapshots.push({ session: e.session, fields });
    pages.set(`${e.carrier}|${name}`, p);
  }
  const byField = new Map();
  const byCaption = new Map();
  for (const p of pages.values()) {
    const { keys, placeOf } = snapshotKeys(p.snapshots);
    const fields = new Map();
    p.snapshots.forEach((s, j) => s.fields.forEach((f, i) => addField(fields, keys[j][i], f)));
    const merged = mergeUnnamed(fields, placeOf, keys);
    const identity = (k) => {
      const field = fields.get(k);
      return field && { id: baseId(k), ref: field.ref ?? null, caption: field.caption ?? null, kind: field.kind, opts: field.opts };
    };
    // One id drawn once per vehicle (Rates rows recorded before names: their order among the
    // rows, `…#2`) is that question's: its first row's identity, so a quote with three vehicles and
    // one with one name it the same. Which row an answer is in comes from the answer's own key.
    p.snapshots.forEach((s, j) => {
      const seen = new Set();
      s.fields.forEach((f, i) => {
        if (!f.q || seen.has(f.q)) return;
        seen.add(f.q);
        const found = identity(merged.get(keys[j][i]) ?? keys[j][i]);
        if (found) byField.set(`${s.session}|${p.page}|${f.q}`, found);
      });
    });
    const captions = new Map();
    for (const k of fields.keys()) {
      const text = textOf({ label: fields.get(k).caption });
      if (text) captions.set(text, [...(captions.get(text) ?? []), k]);
    }
    for (const [text, ks] of captions) {
      const key = `${p.carrier}|${p.page}|${text}`;
      byCaption.set(key, new Set(ks.map(baseId)).size === 1 && !byCaption.has(key) ? identity(ks[0]) : null);
    }
  }
  return { byField, byCaption };
}

export function buildLayouts(events, { stepped = STEPPED, entityPages = ENTITY_PAGES } = {}) {
  const layouts = new Map();
  for (const e of events) {
    if (!isPageLayout(e) || !e.carrier || !e.page) continue;
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
    const name = e.step ? `${e.page} › ${layoutStep(e)}` : e.page;
    const page = layout.pages.get(name) ?? { snapshots: [], buttons: [] };
    // Our own mark tooltips got into early layouts as captions; they aren't questions.
    const fields = (e.fields ?? []).filter((f) => !/^Rater Autofill:|^Su Mo Tu We/.test(f.label ?? ''));
    page.snapshots.push({ fields, coverages: [...(e.context?.coverages ?? [])].sort().join('+'), noInference: (stepped.has(e.carrier) && !e.step) || !!entityPages.get(e.carrier)?.has(e.page) });
    for (const b of e.buttons ?? []) if (!page.buttons.includes(b)) page.buttons.push(b);
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
        // Keys once every layout of the page is in (a repeated text's anchor is a question all of
        // them show), then the fields merged in the order the layouts came.
        const { keys, placeOf } = snapshotKeys(p.snapshots);
        p.fields = new Map();
        p.snapshots.forEach((snap, j) => {
          snap.keys = keys[j];
          snap.fields.forEach((f, i) => addField(p.fields, snap.keys[i], f));
        });
        sameIdentities(p, mergeUnnamed(p.fields, placeOf, keys));
        // Per coverage request: a question that shows for some coverages only is not one answer's
        // follow-up across them (inferShowWhenByGroup).
        const groups = new Map();
        for (const s of p.snapshots.filter((x) => !x.noInference)) groups.set(s.coverages, [...(groups.get(s.coverages) ?? []), s]);
        const conditions = inferShowWhenByGroup([...groups.values()]);
        const captionOf = (cid) => [...p.fields.values()].find((f) => f.cid === cid);
        return [name, {
          fields: [...p.fields.values()].map((f) => {
            const cond = f.seen < p.snapshots.length;
            const when = conditions.get(f.cid);
            const trigger = when && captionOf(when.trigger);
            return {
              ...f,
              row: f.row ?? undefined,
              opts: f.opts.length ? f.opts : undefined,
              req: f.required > 0 || undefined,
              // Required in some layouts only (after certain answers, like a follow-up).
              reqSometimes: (f.required > 0 && f.required < f.seen) || undefined,
              // Not on every snapshot of the page: shows only after certain answers.
              cond: cond || undefined,
              // The answer it showed with in every layout (conditions.mjs): an observation.
              // The trigger by the identity the inference used (question id, element id, data-id or
              // name; the caption only for a field with none), so the replay finds that control.
              showWhen: cond && when ? { ...triggerIdentity(when.triggerField, trigger?.kind), caption: trigger?.caption ?? when.triggerField.label,
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
