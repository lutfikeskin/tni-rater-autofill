// Builds the list of "put this value in the field that looks like this" steps that gets sent into
// the rater page. Values are resolved here so the page script only has to match and type.

import { GENERIC_RULES } from './rules.js';
import { fieldInfo } from './schema.js';
import { get, listOf } from './util.js';

/**
 * @param {object} record   client record from normalizeIntake()
 * @param {object|null} carrier  entry from CARRIERS
 * @param {{drivers?: number, vehicles?: number, trailers?: number}} active  which driver/vehicle/trailer this page is about
 */
export function buildPlan(record, carrier, active = {}) {
  const rules = [...(carrier?.rules ?? []), ...(carrier?.useGenericRules === false ? [] : GENERIC_RULES)];
  return [...fieldSteps(rules, record, carrier, active), ...actionSteps(carrier, record, active)];
}

const withIndex = (path, active) => {
  const list = listOf(path);
  return list ? path.replace('[]', `[${active[list] ?? 0}]`) : path;
};

// Buttons to click (carrier.actions), resolved for this client. The page script clicks each at
// most once per quote, on its page, once its `after` fields have values.
function actionSteps(carrier, record, active) {
  const resolve = (v) => (typeof v === 'function' ? v(record, active) : v);
  return (carrier?.actions ?? [])
    .filter((a) => !a.when || a.when(record, active))
    .map((a, i) => ({
      id: `action:${a.id}:${i}`,
      kind: 'action',
      // Vehicle helpers must be tracked per active vehicle so one VIN lookup cannot satisfy a
      // later vehicle. Other workflow actions remain quote-scoped and keep their stable names.
      action: a.scope === 'vehicle' ? `${a.id}:${active.vehicles ?? 0}` : a.scope === 'driver' ? `${a.id}:${active.drivers ?? 0}` : a.id,
      baseAction: a.id,
      path: `action.${a.id}`,
      name: `Click ${a.id}`,
      pages: [].concat(a.page ?? []),
      text: resolve(a.text) ?? null,
      token: a.token ?? null,
      near: a.near ?? null,
      opener: a.opener ?? null,
      immediate: !!a.immediate,
      after: (resolve(a.after) ?? []).map((p) => withIndex(p, active)),
      afterAny: (resolve(a.afterAny) ?? []).map((p) => withIndex(p, active)),
      unless: (resolve(a.unless) ?? []).map((p) => withIndex(p, active)),
      unlessActions: (resolve(a.unlessActions) ?? []).map((id) => (/:driver$/.test(id) || (a.scope === 'driver' && !/:/.test(id))
        ? `${id.replace(/:driver$/, '')}:${active.drivers ?? 0}`
        : a.scope === 'vehicle' || /:vehicle$/.test(id) ? `${id.replace(/:vehicle$/, '')}:${active.vehicles ?? 0}` : id)),
      afterActions: resolve(a.afterActions) ?? [],
      afterPages: resolve(a.afterPages) ?? [],
      afterValue: resolve(a.afterValue) ?? null,
      needsPremium: !!resolve(a.needsPremium),
      needsRecalculation: !!resolve(a.needsRecalculation),
      verify: resolve(a.verify) ?? null,
      scope: resolve(a.scope) ?? null,
      scopeIndex: resolve(a.scopeIndex),
      value: null,
    }))
    .filter((s) => s.text || s.token);
}

function fieldSteps(rules, record, carrier, active) {
  return rules.map((rule, id) => {
    const list = rule.path ? listOf(rule.path) : null;
    const path = rule.path
      ? (list ? rule.path.replace('[]', `[${active[list] ?? 0}]`) : rule.path)
      : `${carrier?.id ?? 'carrier'}.q${rule.q ?? id}`;
    const info = rule.path ? fieldInfo(rule.path) : { label: rule.name ?? path, kind: 'text' };
    const note = typeof rule.note === 'function' ? rule.note(record, active) : rule.note ?? null;
    let value = null;
    if (!note) {
      try {
        value = rule.value ? rule.value(record, active) : get(record, path);
      } catch {
        value = null;
      }
    }
    const ignore = typeof rule.ignore === 'function' ? !!rule.ignore(record, active) : !!rule.ignore;
    const scope = typeof rule.scope === 'function' ? rule.scope(record, active) : rule.scope ?? null;
    const scopeIndex = typeof rule.scopeIndex === 'function' ? rule.scopeIndex(record, active) : rule.scopeIndex;
    // Per-vehicle questions repeat once per vehicle, labelled "2021 MERCEDES-BENZ SPRINTER": the
    // active vehicle's year/make/model picks its row when there are several.
    const v = scope === 'vehicle' && (record.vehicles?.length ?? 0) > 1 ? record.vehicles[active.vehicles ?? 0] : null;
    const vehicleHint = v ? [v.year, v.make, v.model].filter(Boolean).map((x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter((x) => x.length >= 2) : null;
    return {
      id,
      path,
      name: rule.name ?? info.label,
      kind: rule.kind ?? info.kind,
      q: rule.q ?? null,
      selector: rule.selector ?? null,
      re: rule.label ?? null,
      ex: rule.not ?? null,
      note,
      ignore,
      verifyOnly: !!rule.verifyOnly,
      summaryAfter: typeof rule.summaryAfter === 'function' ? rule.summaryAfter(record, active) : rule.summaryAfter ?? null,
      choiceAliases: typeof rule.choiceAliases === 'function' ? rule.choiceAliases(record, active) : rule.choiceAliases ?? [],
      scope,
      scopeIndex,
      vehicleHint: vehicleHint?.length ? vehicleHint : null,
      // What an address box gets when the page offers no suggestion (e.g. just the street).
      fallback: typeof rule.fallback === 'function' ? rule.fallback(record, active) : rule.fallback ?? null,
      // Type-ahead lists: what to type (the value is what the chosen result must contain).
      search: typeof rule.search === 'function' ? rule.search(record, active) : rule.search ?? null,
      withOption: rule.withOption ?? null,
      value: value === undefined || value === '' ? null : value,
    };
  });
}

// Strings from the client record that must never leave the machine in a page capture: names,
// contact details, ID numbers, street address. (Not makes/models/states, which would blank out
// the rater's own dropdown options.)
export function redactionTerms(record) {
  const a = record.applicant ?? {};
  const g = record.garaging ?? {};
  const names = [a.name, a.owner1, a.owner2, ...(record.drivers ?? []).flatMap((d) => [d.first, d.middle, d.last])];
  const exact = [
    a.email, a.phone, a.phone?.replace(/\D/g, ''), a.dot, a.mc, a.fein, g.street, g.unit, g.city, g.zip,
    record.operations?.licensePlate,
    ...(record.drivers ?? []).flatMap((d) => [d.dob, d.licenseNumber]),
    ...[...(record.vehicles ?? []), ...(record.trailers ?? [])].map((u) => u.vin),
  ];
  const out = new Set();
  for (const n of names.filter(Boolean)) {
    out.add(String(n));
    // Also word by word, so "Jane Q Sample" catches "Jane" and "Sample" on their own.
    String(n).split(/\s+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase())).forEach((w) => out.add(w));
  }
  for (const v of exact) if (v != null && String(v).trim().length >= 3) out.add(String(v).trim());
  return [...out].sort((x, y) => y.length - x.length);
}

const GENERIC_WORDS = new Set(['llc', 'inc', 'corp', 'co', 'the', 'and', 'trucking', 'transport', 'transportation', 'logistics', 'freight', 'express', 'services', 'group', 'carriers', 'lines']);
