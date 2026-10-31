// The side panel's decision logic for the live fill view: the answers and items in the page's
// order, and what the fill is doing. No DOM: LiveView (live-view.jsx) draws it.
// One part of the panel; sidepanel.js wires the parts together.

// The live list's entries in the page's order: the answers in so far (`rows`) and the items judged
// (`items`, pagekit progress), each by its frame (`frames`, the page's frames in order) and its place
// on the page as the fill's last round read it (`order`); those with no place after them, as they
// came. [{ row } | { item }].
function liveEntries(rows, items, frames = []) {
  const all = [...rows.map((x, i) => ({ row: x, x, i })), ...items.map((x, i) => ({ item: x, x, i: rows.length + i }))];
  const rank = (e) => { const at = frames.indexOf(e.x.frame); return at < 0 ? frames.length : at; };
  const placed = (e) => Number.isInteger(e.x.order);
  return [...all.filter(placed).sort((a, b) => rank(a) - rank(b) || a.x.order - b.x.order || a.i - b.i), ...all.filter((e) => !placed(e))]
    .map(({ row, item }) => (row ? { row } : { item }));
}

// The live list's last row, and the dock while a long wait is on: what the kit is doing (pagekit
// `phase`), so a fill waiting on GEICO's Recalculate or a quiet page doesn't read as stuck on
// "Working…" (the maintainer, 2026-10-23). `n`: answers in so far.
function phaseSaid(phase, n = 0) {
  const what = phase?.what ? `: ${phase.what}` : '';
  switch (phase?.name) {
    case 'reading': return ['Reading the page', 'Waiting for it to settle…'];
    case 'waiting': return ['Waiting for the page', 'It’s working on the last answer…'];
    case 'helper': return [`Clicked${what}`, 'Waiting for the page to answer…'];
    case 'premium': return ['Waiting for the premium', 'The rater is rating the quote…'];
    case 'continue': return ['Clicking Continue', 'Waiting for the page to settle…'];
    default: return [n ? 'Next answer' : 'Reading the page', 'Working…'];
  }
}

// The waits long enough to name in the dock's title (not the quiet wait after each answer, which
// would flicker with "Just filled").
const DOCK_PHASES = new Set(['reading', 'helper', 'premium', 'continue']);

// An item's reading among liveItems', by its key and label as it was asked.
function liveOf(live, key, label) {
  return live.find((y) => y.key === key && (y.label || null) === (label || null)) ?? null;
}

export { DOCK_PHASES, liveEntries, liveOf, phaseSaid };
