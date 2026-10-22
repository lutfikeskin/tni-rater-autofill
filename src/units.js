// The unit a fill adds on a one-address application's lists of the units on the quote
// (carrier.unitLists: GEICO's Vehicles and Trailers, Drivers). Pure: the side panel
// (pickUnitToAdd) reads the lists through the kit and keeps the state, and the GEICO mock plays the
// panel with this same code.

const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = (d) => [d?.first, d?.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
// What the list is read for, per unit (pagekit unitList): a vehicle's or trailer's VIN, a driver's
// first and last name, on one line. A driver whose every name word another driver's name also
// holds (John Smith beside John Smith Jr) is read for nothing: the list can't tell them apart.
function itemsOf(record, lists) {
  const drivers = (record.drivers ?? []).map(words);
  const idOf = (list, u, i) => (list !== 'drivers' ? word(u?.vin)
    : drivers.some((other, j) => j !== i && drivers[i].every((w) => other.includes(w))) ? [] : [u?.first, u?.last].filter(Boolean));
  return lists.flatMap((list) => (record[list] ?? []).map((u, i) => idOf(list, u, i)));
}
// An item the list can show (as pagekit unitList matches it): a VIN of 11 characters or more, a name
// of two words or more.
const readable = (item) => (Array.isArray(item) ? item.map(word).filter((w) => w.length >= 2).length >= 2 : word(item).length >= 11);

// The carrier's unit lists with what each is read for (what goes to the page: selector, items).
export function unitListSpecs(carrier, record) {
  return (carrier?.unitLists ?? []).map((s) => ({ ...s, items: itemsOf(record ?? {}, s.lists) }));
}

const MARKER = { vehicles: 'vehicleEntered', trailers: 'trailerEntered', drivers: 'driverEntered' };

// On step `step`, with `seen` what the kit read there ({ forms, lists }: the unit forms on screen,
// and each list in unitListSpecs' order, null off screen), `unitForms` the forms fills answered per
// unit, and `done` the quote's done actions: the unit to add next, `adding` ({ list, index }), by the
// intake's order (vehicles, then trailers), and the `marks` to add to the done actions
// (`<unit>Entered:<i>`, as Progressive's are). A unit is on the quote once a fill answered a form for
// it or the list shows it; the driver GEICO lists itself (listedDriver) is never added. Nothing is
// added while the list holds as many units as the intake or more. A unit the list can't be read for
// (no VIN, a name another driver's holds), while the list has a row no intake unit is known to be
// on, may be that row (added by hand): it is taken as on the quote, left to the agent, never added
// twice. `move`: no unit form on screen (the list, the chooser), so the picker may move to that unit.
// `complete`: the list is on screen, holds exactly as many units as the intake, and each intake
// unit is on it: shown (as it can be read for), the driver GEICO lists itself, or saved from a
// form a fill answered for it (`unitForms`: W43-40, GEICO FL 2026-10-21 and 2026-10-22, Looks Good
// never clicked on a list that needed a VIN or name read, 0 of 8, while the captured lists and the
// mock read right): the list may be left (advanceFor). `read`: the counts behind it, for the usage
// log. Null off the carrier's unit-list steps.
export function unitToAdd(carrier, record, step, seen, { unitForms = {}, done = new Set() } = {}) {
  const specs = unitListSpecs(carrier, record);
  const at = specs.findIndex((s) => s.steps.includes(step));
  if (at < 0 || !seen) return null;
  const spec = specs[at];
  const shown = seen.lists?.[at] ?? null;
  const listed = spec.lists.includes('drivers') ? carrier.listedDriver?.(record) ?? -1 : -1;
  const bound = (list, i) => Object.values(unitForms[list] ?? {}).includes(i);
  const units = [];
  let offset = 0;
  for (const list of spec.lists) {
    (record[list] ?? []).forEach((_, i) => units.push({ list, i, item: spec.items[offset + i], shown: !!shown?.shown?.[offset + i] }));
    offset += record[list]?.length ?? 0;
  }
  const mark = (u) => `${MARKER[u.list]}:${u.i}`;
  const isListed = (u) => u.list === 'drivers' && u.i === listed;
  const marks = [];
  if (shown) {
    for (const u of units) if (u.shown || bound(u.list, u.i)) marks.push(mark(u));
    const known = units.filter((u) => u.shown || bound(u.list, u.i) || isListed(u)).length;
    if (shown.rows > known) {
      for (const u of units) if (!readable(u.item) && !isListed(u) && !marks.includes(mark(u))) marks.push(mark(u));
    }
  }
  const entered = (u) => isListed(u) || bound(u.list, u.i) || done.has(mark(u)) || marks.includes(mark(u));
  const complete = !!shown && shown.rows === units.length && units.every((u) => u.shown || isListed(u) || !readable(u.item) || bound(u.list, u.i));
  const read = shown ? { rows: shown.rows, units: units.length, shown: units.filter((u) => u.shown).length, saved: units.filter((u) => bound(u.list, u.i)).length } : null;
  if (shown && shown.rows >= units.length) return { marks, adding: null, move: false, complete, read };
  const next = units.find((u) => !entered(u));
  return { marks, adding: next ? { list: next.list, index: next.i } : null, move: Array.isArray(seen.forms) && !seen.forms.length, complete: false, read };
}

// The carrier's Continue for one fill (fill `advance`), or null without one: its `listed` button
// (GEICO's Looks Good, which leaves a unit list) is among its words only when `unitsListed`, the
// list on screen holding every intake unit (unitToAdd `complete`).
export function advanceFor(carrier, unitsListed = false) {
  const advance = carrier?.advance ?? null;
  if (!advance?.listed) return advance;
  const { listed, ...rest } = advance;
  return unitsListed ? { ...rest, text: `(?:${rest.text})|(?:${listed})` } : rest;
}
