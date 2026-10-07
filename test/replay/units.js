// The vehicles and trailers the replay page fills a layout with. Progressive's Rates gives every
// unit a row of the same questions, named after it ("2025 RAM PROMASTER 2500", a trailer's
// "2019 Wilson"), and the fill finds a unit's row by its year, make and model, so a layout's rows
// are only answered by an intake with those units. Loaded by index.html and by
// test/replay-units.test.mjs.
const REPLAY_UNIT_CAPTION = /^(19|20)\d{2}\s+\S/;
const replayCaption = (c) => String(c ?? '').replace(/\s+/g, ' ').trim();
const replayRow = (row) => /^\d+_\d+$/.test(row ?? '');

// The units (vehicles, then trailers) a page shows a row of questions for: one per recorded row, in
// row order; on a page without rows (layouts recorded before them), one per name. The page with the
// most of them counts. A row is named by the first name the layout shows for it. Fields named after
// a unit but recorded before rows, on a page whose units have rows, are `apart`: which unit's they
// were isn't known.
globalThis.replayUnitRows = function replayUnitRows(layout) {
  const rowNumber = (row) => row.split('_').map(Number);
  let best = { page: null, names: new Map(), apart: new Set() };
  for (const [page, p] of Object.entries(layout?.pages ?? {})) {
    const units = (p.fields ?? []).filter((f) => REPLAY_UNIT_CAPTION.test(replayCaption(f.caption)));
    const rowed = units.filter((f) => replayRow(f.row));
    const names = new Map();
    for (const f of rowed.length ? rowed : units) {
      const unit = rowed.length ? f.row : replayCaption(f.caption);
      if (!names.has(unit)) names.set(unit, replayCaption(f.caption));
    }
    if (names.size <= best.names.size) continue;
    best = {
      page,
      names: rowed.length ? new Map([...names].sort(([a], [b]) => rowNumber(a)[0] - rowNumber(b)[0] || rowNumber(a)[1] - rowNumber(b)[1])) : names,
      apart: new Set(rowed.length ? units.filter((f) => !rowed.includes(f)) : []),
    };
  }
  return { ...best, list: [...best.names.values()] };
};

// A row shows one name, as on the live page: its unit's (above), also where a layout merging
// several quotes recorded others in that row.
globalThis.replayUnitCaption = function replayUnitCaption(f, units, page) {
  if (!units || units.page !== page || !REPLAY_UNIT_CAPTION.test(replayCaption(f.caption))) return f.caption;
  return units.names.get(replayRow(f.row) ? f.row : replayCaption(f.caption)) ?? f.caption;
};

// The sample intake with the vehicles and trailers of the layout's quote: as many vehicles as its
// context recorded and a trailer when it had trailers, more when its rows (`rows`, their names)
// show more units: trailers when it had trailers, else vehicles. Vehicles past the sample's repeat
// its own with another VIN; its trailer is a made-up one. With several units, each is named after
// its row in order; the rest of it is the sample's. One unit keeps the sample's name: no row is
// found by it then.
const REPLAY_SAMPLE_TRAILER = { type: 'Dry Van', year: 2019, make: 'WABASH', model: 'DURAPLATE', vin: '1JJV532D8KL300001', value: 18000 };
globalThis.replayWithUnits = function replayWithUnits(record, context = {}, rows = []) {
  const own = { vehicles: record.vehicles ?? [], trailers: record.trailers?.length ? record.trailers : [REPLAY_SAMPLE_TRAILER] };
  const count = {
    vehicles: Number.isInteger(context.vehicles) && context.vehicles > 0 ? context.vehicles : own.vehicles.length,
    trailers: context.trailers === true ? Math.max(1, record.trailers?.length ?? 0) : context.trailers === false ? 0 : record.trailers?.length ?? 0,
  };
  const extra = rows.length - count.vehicles - count.trailers;
  if (extra > 0) count[count.trailers ? 'trailers' : 'vehicles'] += extra;
  const more = (list, n) => Array.from({ length: list.length ? n : 0 }, (_, k) => {
    const u = list[k % list.length];
    return k < list.length ? u : { ...u, vin: u.vin ? `${u.vin.slice(0, -3)}${String(k).padStart(3, '0')}` : null };
  });
  const vehicles = more(own.vehicles, count.vehicles);
  const units = [...vehicles, ...more(own.trailers, count.trailers)];
  const named = units.length < 2 ? units : units.map((u, k) => {
    if (!rows[k]) return u;
    const [year, make, ...model] = rows[k].split(' ');
    return { ...u, year: Number(year), make, model: model.join(' ') || null };
  });
  return { ...record, vehicles: named.slice(0, vehicles.length), trailers: named.slice(vehicles.length) };
};
