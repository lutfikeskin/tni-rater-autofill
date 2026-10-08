// Builds the list of "put this value in the field that looks like this" steps that gets sent into
// the rater page. Values are resolved here so the page script only has to match and type.

import { GENERIC_RULES } from './rules.js';
import { fieldInfo } from './schema.js';
import { get, listOf } from './util.js';

// Where a rule's answer comes from (Contract 2, docs/intake-and-rules.md):
//   intake       a record path, no computed value (the default for a rule with `path` only)
//   derived      computed from intake facts, with the evidence in the rule
//   standard     a TNI coverage or workflow standard; the step is marked `standard`
//   fact         a client fact the intake doesn't supply: never filled, left to the agent with a note
//   attestation  something the agent must assert: never filled, left to the agent with a note
// Every rule with a `value` declares one (test/provenance.test.mjs).
export const SOURCES = ['intake', 'derived', 'standard', 'fact', 'attestation'];
export const AGENT_SOURCES = ['fact', 'attestation'];

// The business classes a carrier's rules were written and checked for (`supportedClasses`: regexes
// on the intake's business class; one marked `whatHaul` is also tried on what they haul, as the
// general-freight helpers do). Outside them the quote still fills, in review mode: every standard
// answer becomes a check item (Continue waits) and the panel says so. A missing class is
// unsupported. A carrier that declares no classes has no gate.
export function supportedClass(record, carrier) {
  const classes = carrier?.supportedClasses;
  if (!classes?.length) return true;
  const cls = String(record?.operations?.businessClass ?? '').trim();
  if (!cls) return false;
  const haul = String(record?.operations?.whatHaul ?? '').trim();
  return classes.some((c) => {
    const re = c instanceof RegExp ? c : c.re;
    return re.test(cls) || (!(c instanceof RegExp) && c.whatHaul && haul && re.test(haul));
  });
}

export function reviewWarn(record, carrier) {
  const cls = String(record?.operations?.businessClass ?? '').trim() || 'not given';
  return `Review mode: the business class "${cls}" isn't validated for ${carrier?.name ?? 'this carrier'}; confirm this standard answer.`;
}

/**
 * @param {object} record   client record from normalizeIntake()
 * @param {object|null} carrier  entry from CARRIERS
 * @param {{drivers?: number, vehicles?: number, trailers?: number}} active  which driver/vehicle/trailer this page is about
 */
export function buildPlan(record, carrier, active = {}) {
  // A carrier's `rowSections`: repeating sections its own rules answer row by row, where a generic
  // label rule never answers (a row the intake doesn't describe stays the agent's).
  const generic = carrier?.useGenericRules === false ? [] : carrier?.rowSections?.length
    ? GENERIC_RULES.map((rule) => ({ ...rule, notWithin: carrier.rowSections })) : GENERIC_RULES;
  const rules = [...(carrier?.rules ?? []), ...generic];
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
      action: a.scope === 'vehicle' ? `${a.id}:${active.vehicles ?? 0}` : a.scope === 'driver' ? `${a.id}:${active.drivers ?? 0}`
        : a.scope === 'trailer' ? `${a.id}:${active.trailers ?? 0}` : a.id,
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
      // Clicked, but what it adds isn't in until one of these is done (a trailer entered): until
      // then the page says `unfinished` (Continue waits).
      doneWhen: resolve(a.doneWhen) ?? [],
      // Waits while a required question on the page is empty (the carrier would refuse the click).
      waitRequired: !!a.waitRequired,
      unfinished: resolve(a.unfinished) ?? null,
      unlessActions: (resolve(a.unlessActions) ?? []).map((id) => (/:driver$/.test(id) || (a.scope === 'driver' && !/:/.test(id))
        ? `${id.replace(/:driver$/, '')}:${active.drivers ?? 0}`
        : /:trailer$/.test(id) || (a.scope === 'trailer' && !/:/.test(id)) ? `${id.replace(/:trailer$/, '')}:${active.trailers ?? 0}`
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

// Rows of one question for several vehicles or trailers (Progressive's Rates shows every unit's
// coverages on one page): each step finds its own row by the unit's year, make and model.
const unitRows = (record) => (record.vehicles?.length ?? 0) > 1 || (record.trailers?.length ?? 0) > 0;

function fieldSteps(rules, record, carrier, active) {
  const review = !supportedClass(record, carrier);
  const reviewNote = review ? reviewWarn(record, carrier) : null;
  const expanded = rules.flatMap((rule) => {
    if (rule.repeat) return (record[rule.repeat] ?? []).map((_, index) => ({ rule, active: { ...active, [rule.repeat]: index } }));
    // A per-vehicle question with several vehicles (or a vehicle and a trailer): a step for each
    // vehicle, which finds its own row. On a page showing one vehicle at a time, only the active
    // vehicle's step answers. A per-trailer question: a step for each trailer, the same way.
    const scope = typeof rule.scope === 'function' ? rule.scope(record, active) : rule.scope;
    if (scope === 'vehicle' && unitRows(record)) {
      return record.vehicles.map((_, index) => ({ rule, active: { ...active, vehicles: index }, activeVehicle: index === (active.vehicles ?? 0) }));
    }
    if (scope === 'trailer') {
      return (record.trailers ?? []).map((_, index) => ({ rule, active: { ...active, trailers: index }, activeVehicle: index === (active.trailers ?? 0) }));
    }
    return [{ rule, active }];
  });
  return expanded.map(({ rule, active, activeVehicle = null }, id) => {
    const list = rule.path ? listOf(rule.path) : null;
    const path = rule.path
      ? (list ? rule.path.replace('[]', `[${active[list] ?? 0}]`) : rule.path)
      : `${carrier?.id ?? 'carrier'}.q${rule.q ?? id}`;
    const info = rule.path ? fieldInfo(rule.path) : { label: rule.name ?? path, kind: 'text' };
    const name = rule.name ?? info.label;
    // A rule with a path and no computed value reads the intake; the rest declare their source.
    const source = rule.source ?? (rule.path && rule.value === undefined ? 'intake' : null);
    // A fact or attestation the intake doesn't supply is the agent's: never filled, whatever the
    // rule's value says, with the rule's note or a plain one.
    const agents = AGENT_SOURCES.includes(source);
    const ruleNote = typeof rule.note === 'function' ? rule.note(record, active) : rule.note ?? null;
    const note = agents ? ruleNote ?? `${name} isn't on the intake: answer it yourself.` : ruleNote;
    const standard = source === 'standard';
    const ruleWarn = typeof rule.warn === 'function' ? rule.warn(record, active) : rule.warn ?? null;
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
    // Per-vehicle questions repeat once per vehicle, labelled "2021 MERCEDES-BENZ SPRINTER" (a
    // trailer's "2019 Wilson"): the step's unit's year/make/model picks its row.
    const v = scope === 'vehicle' && unitRows(record) ? record.vehicles[active.vehicles ?? 0]
      : scope === 'trailer' ? record.trailers?.[active.trailers ?? 0] : null;
    const vehicleHint = v ? [v.year, v.make, v.model].filter(Boolean).map((x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter((x) => x.length >= 2) : null;
    return {
      id,
      path,
      name,
      kind: rule.kind ?? info.kind,
      source,
      // A TNI standard, not an intake fact: the panel tags it, and in review mode (an unvalidated
      // business class) it is a check item.
      standard,
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
      // Its data-model name only on its own pages (`pageOnly`: a trailer's questions carry the
      // vehicle's names), and never on `notPages` (the vehicle's questions on the trailer pages).
      pageOnly: !!rule.pageOnly,
      notPages: rule.notPages ? [].concat(rule.notPages) : null,
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
      // A label rule that never answers a field inside these (the carrier's `rowSections`).
      notWithin: rule.notWithin ?? null,
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
      emptyNote: typeof rule.emptyNote === 'function' ? rule.emptyNote(record, active) : rule.emptyNote ?? null,
      // A default the agent should confirm: filled, but marked yellow with this note.
      warn: standard && reviewNote ? [reviewNote, ruleWarn].filter(Boolean).join(' ') : ruleWarn,
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
