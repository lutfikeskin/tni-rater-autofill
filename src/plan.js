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
      unique: !!a.unique,
      // A helper the agent must otherwise do by hand: what the panel says when it can't be clicked.
      label: a.label ?? null,
      missing: resolve(a.missing) ?? null,
      // `heldBy`: helpers (by id) whose open "needs you" item holds this one; `resolvedBy`: the
      // button whose return on the page settles that item (the Add NTL link, NTL removed).
      heldBy: resolve(a.heldBy) ?? [],
      resolvedBy: a.resolvedBy ?? null,
      opener: a.opener ?? null,
      nudge: a.nudge ?? null,
      immediate: !!a.immediate,
      after: (resolve(a.after) ?? []).map((p) => withIndex(p, active)),
      afterAny: (resolve(a.afterAny) ?? []).map((p) => withIndex(p, active)),
      unless: (resolve(a.unless) ?? []).map((p) => withIndex(p, active)),
      unlessSelector: resolve(a.unlessSelector) ?? null,
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
    .filter((s) => s.text || s.token || s.missing);
}

function fieldSteps(rules, record, carrier, active) {
  const expanded = rules.flatMap((rule) => {
    if (rule.repeat) return (record[rule.repeat] ?? []).map((_, index) => ({ rule, active: { ...active, [rule.repeat]: index } }));
    // A per-vehicle question with several vehicles: a step for each vehicle, which finds its own
    // row (Progressive's Rates shows every vehicle's coverages on one page). On a page showing one
    // vehicle at a time, only the active vehicle's step answers.
    const scope = typeof rule.scope === 'function' ? rule.scope(record, active) : rule.scope;
    if (scope === 'vehicle' && (record.vehicles?.length ?? 0) > 1) {
      return record.vehicles.map((_, index) => ({ rule, active: { ...active, vehicles: index }, activeVehicle: index === (active.vehicles ?? 0) }));
    }
    return [{ rule, active }];
  });
  return expanded.map(({ rule, active, activeVehicle = null }, id) => {
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
    // step's vehicle's year/make/model picks its row when there are several.
    const v = scope === 'vehicle' && (record.vehicles?.length ?? 0) > 1 ? record.vehicles[active.vehicles ?? 0] : null;
    const vehicleHint = v ? [v.year, v.make, v.model].filter(Boolean).map((x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter((x) => x.length >= 2) : null;
    return {
      id,
      path,
      name: rule.name ?? info.label,
      kind: rule.kind ?? info.kind,
      // The carrier's question id when the rule was written: only the rule's name (its path), never
      // how its field is found (Progressive renumbers questions). These find it (pagekit assign):
      q: rule.q ?? null,
      // the field's data-model name (Duck Creek fieldref),
      field: rule.field ?? null,
      // else its question on the page: exact text(s), or `label` (re) on these pages,
      ask: rule.ask ? [].concat(rule.ask) : null,
      pages: rule.page ? [].concat(rule.page) : null,
      // a select, radio, checkbox or text box, when a text is shared by two kinds of field,
      control: rule.control ?? null,
      // the first one after this question when its text repeats on the page,
      askAfter: rule.askAfter ?? null,
      // one field each for steps of a question repeated in several groups.
      each: !!rule.each,
      // Never "needs you" when empty (middle initial, suffix, DBA).
      optional: !!rule.optional,
      // The registered business names a USDOT lookup offers (checked against the intake).
      registeredName: !!rule.registeredName,
      // Progressive's cargo questions: 'section' (the commodity section), 'limit', or true.
      cargo: rule.cargo ?? null,
      selector: rule.repeatSelector ? rule.repeatSelector(record, active) : rule.selector ?? null,
      re: rule.label ?? null,
      ex: rule.not ?? null,
      note,
      ignore,
      verifyOnly: !!rule.verifyOnly,
      // Our answer replaces what the page put there (e.g. a lookup's body type).
      replace: !!rule.replace,
      // What a lookup put there wins over the intake's wording (no "page differs" flag).
      trustPage: !!rule.trustPage,
      // May fill its field while it isn't on screen (an earlier step's question added later).
      hidden: !!rule.hidden,
      // An ignored field the page fills itself (a lookup): flagged only if it stays empty.
      emptyNote: rule.emptyNote ?? null,
      // A default the agent should confirm: filled, but marked yellow with this note.
      warn: typeof rule.warn === 'function' ? rule.warn(record, active) : rule.warn ?? null,
      summaryAfter: typeof rule.summaryAfter === 'function' ? rule.summaryAfter(record, active) : rule.summaryAfter ?? null,
      choiceAliases: typeof rule.choiceAliases === 'function' ? rule.choiceAliases(record, active) : rule.choiceAliases ?? [],
      scope,
      scopeIndex,
      vehicleHint: vehicleHint?.length ? vehicleHint : null,
      activeVehicle,
      businessNames: rule.businessNames ? rule.businessNames(record, active) : null,
      // What an address box gets when the page offers no suggestion (e.g. just the street).
      fallback: typeof rule.fallback === 'function' ? rule.fallback(record, active) : rule.fallback ?? null,
      // Type-ahead lists: what to type (the value is what the chosen result must contain).
      search: typeof rule.search === 'function' ? rule.search(record, active) : rule.search ?? null,
      withOption: typeof rule.withOption === 'function' ? rule.withOption(record, active) : rule.withOption ?? null,
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
