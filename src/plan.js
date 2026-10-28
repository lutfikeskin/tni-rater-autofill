// @ts-check
// Builds the list of "put this value in the field that looks like this" steps that gets sent into
// the rater page. Values are resolved here so the page script only has to match and type.

import { GENERIC_RULES } from './rules.js';
import { fieldInfo } from './schema.js';
import { get, listOf } from './util.js';

/** @import { ActionStep, ActiveUnits, CarrierConfig, CarrierRule, ClientRecord, ClientValue, FieldStep, ListCondition, PlanStep } from '../types.js' */

// Where a rule's answer comes from (Contract 2, docs/intake-and-rules.md):
//   intake       a record path, no computed value (the default for a rule with `path` only)
//   derived      computed from intake facts, with the evidence in the rule
//   standard     a TNI coverage or workflow standard; the step is marked `standard`
//   fact         a client fact the intake doesn't supply: never filled, left to the agent with a note
//   attestation  something the agent must assert: never filled, left to the agent with a note
// Every rule with a `value` declares one (test/provenance.test.mjs). Fact and attestation steps are
// `manualOnly`: the AI assistant never suggests or picks them. So is a `clientFact` rule's step
// (marital status, vehicle ownership, …) whenever the intake leaves it without an answer.
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
 * @param {ClientRecord} record   client record from normalizeIntake()
 * @param {CarrierConfig|null} carrier  entry from CARRIERS
 * @param {ActiveUnits} active  which driver/vehicle/trailer this page is about
 * @returns {PlanStep[]}
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
/**
 * @param {CarrierConfig|null} carrier
 * @param {ClientRecord} record
 * @param {ActiveUnits} active
 * @returns {ActionStep[]}
 */
function actionSteps(carrier, record, active) {
  // Typed for what it gives each field (the body takes any value or function).
  /** @type {<T>(v: ClientValue<T>) => T} */
  const resolve = /** @param {any} v @returns {any} */ (v) => (typeof v === 'function' ? v(record, active) : v);
  return (carrier?.actions ?? [])
    .filter((a) => !a.when || a.when(record, active))
    .map(/** @returns {ActionStep} */ (a, i) => ({
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
      // The carrier's steps it is clicked on, on a one-address application whose step is read from
      // the page (GEICO's progress bar): never on another step, whose button may read the same.
      steps: a.steps ? [].concat(a.steps) : null,
      text: resolve(a.text) ?? null,
      token: a.token ?? null,
      near: a.near ?? null,
      // `within`: only a button inside this container (GEICO's add icon of one list); `moveOn`
      // with it: a Next there that opens a form, no step's move (GEICO's chooser), which pagekit
      // checks against NEVER_ADVANCE instead of NEVER_CLICK. `loads`: its click draws a new view,
      // waited for as a step's load.
      within: a.within ?? null,
      moveOn: !!(a.moveOn && a.within),
      loads: !!a.loads,
      unique: !!a.unique,
      // A helper the agent must otherwise do by hand: what the panel says when it can't be clicked.
      label: a.label ?? null,
      missing: resolve(a.missing) ?? null,
      // Its reminder can be marked done by the agent (carrier `markable`: Progressive's ntlRates).
      markable: !!a.markable,
      // `heldBy`: helpers (by id) whose open "needs you" item holds this one; `resolvedBy`: the
      // button whose return on the page settles that item (the Add NTL link, NTL removed).
      heldBy: resolve(a.heldBy) ?? [],
      resolvedBy: a.resolvedBy ?? null,
      // `settledByPages`: pages whose visit settles that item too (none uses it since Progressive's
      // General Liability became automatic, 2026-10-20).
      settledByPages: resolve(a.settledByPages) ?? [],
      opener: a.opener ?? null,
      nudge: a.nudge ?? null,
      immediate: !!a.immediate,
      // A helper that answers many questions at once: not clicked while an answer the agent gave
      // is on the page (it would reset it).
      skipIfProtected: !!a.skipIfProtected,
      after: (resolve(a.after) ?? []).map((p) => withIndex(p, active)),
      afterAny: (resolve(a.afterAny) ?? []).map((p) => withIndex(p, active)),
      unless: (resolve(a.unless) ?? []).map((p) => withIndex(p, active)),
      unlessSelector: resolve(a.unlessSelector) ?? null,
      // Clicked, but what it adds isn't in until one of these is done (a trailer entered): until
      // then the page says `unfinished` (Continue waits).
      doneWhen: resolve(a.doneWhen) ?? [],
      // Waits while a required question on the page is empty (the carrier would refuse the click).
      waitRequired: !!a.waitRequired,
      // Waits until the fill has left nothing on the page for the agent (GEICO's Recalculate, View
      // More Payment Plans and Print Quote Proposal: TNI, 2026-10-21).
      whenClear: !!a.whenClear,
      // How long the page is quiet before the click (GEICO's Recalculate: W43-31).
      quietMs: resolve(a.quietMs) ?? null,
      // Clicked once a quote, never due again after a later answer (GEICO's Recalculate: W43-31).
      once: !!a.once,
      // The answers on the page are read as it is clicked and checked once its result shows: one
      // the fill gave that changed is given back once, and every change is the agent's (W43-31).
      keepAnswers: !!a.keepAnswers,
      // Clicked by the kit itself where the carrier's buttons are pressed from the page's own world
      // (`pressInPage`): GEICO's Print Quote Proposal opened nothing pressed from there (2026-10-23).
      kitClick: !!a.kitClick,
      // Clicked on its page even while the page shows no field (a page of tiles, where the pick is
      // all there is): any other helper on a page the plan has questions for waits for them (W44-03).
      onBlankPage: !!a.onBlankPage,
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
      // With `verify: 'premium'`: rated only once this selector is drawn too (GEICO's pay plans).
      ratedBy: resolve(a.ratedBy) ?? null,
      // `shownBy`: the questions that show the helper's result (`all` of them, or `any`; with
      // `answered`, each with an answer). Shown already for the unit's own value: done, unclicked.
      shownBy: a.shownBy ? { all: (a.shownBy.all ?? []).map((p) => withIndex(p, active)), any: (a.shownBy.any ?? []).map((p) => withIndex(p, active)), answered: !!a.shownBy.answered } : null,
      scope: resolve(a.scope) ?? null,
      scopeIndex: resolve(a.scopeIndex),
      value: null,
    }))
    .filter((s) => s.text || s.token || s.missing);
}

// Rows of one question for several vehicles or trailers (Progressive's Rates shows every unit's
// coverages on one page): each step finds its own row by the unit's year, make and model.
const unitRows = (record) => (record.vehicles?.length ?? 0) > 1 || (record.trailers?.length ?? 0) > 0;

// A form told by a question only it asks (`whenShown` / `unlessShown`, GEICO's vehicle, trailer
// and driver forms): its data-model name, a pattern its text must match, and the unit it is for
// ('vehicles', 'drivers', 'trailers'). A function gets the record and the active units.
function shownOn(cond, record, active) {
  const c = typeof cond === 'function' ? cond(record, active) : cond;
  return c?.field ? { field: c.field, label: c.label ?? null, unit: c.unit ?? null } : null;
}

/** @param {ListCondition[] | null | undefined} conditions */
function onlyIfOf(conditions) {
  return conditions?.length ? conditions.map((x) => ({ path: x.path ?? null, limit: !!x.limit, value: x.value ?? null })) : null;
}

/**
 * @param {CarrierRule[]} rules
 * @param {ClientRecord} record
 * @param {CarrierConfig|null} carrier
 * @param {ActiveUnits} active
 * @returns {FieldStep[]}
 */
function fieldSteps(rules, record, carrier, active) {
  const review = !supportedClass(record, carrier);
  const reviewNote = review ? reviewWarn(record, carrier) : null;
  const expanded = rules.flatMap((rule) => {
    if (rule.repeat) return (record[rule.repeat] ?? []).map((_, index) => ({ rule, active: { ...active, [rule.repeat]: index } }));
    // A per-vehicle question with several vehicles (or a vehicle and a trailer): a step for each
    // vehicle, which finds its own row. On a page showing one vehicle at a time, only the active
    // vehicle's step answers. A per-trailer question: a step for each trailer, the same way. A
    // per-vehicle question asked of trailers too (`trailers`: GEICO's comprehensive, collision and
    // fire and theft rows list the trailer among the vehicles) has a step for each trailer after
    // the vehicles', which finds the trailer's row by its year and make, never by a count of rows
    // the trailer shifts.
    const scope = typeof rule.scope === 'function' ? rule.scope(record, active) : rule.scope;
    if (scope === 'vehicle' && unitRows(record)) {
      return [
        ...record.vehicles.map((_, index) => ({ rule, active: { ...active, vehicles: index }, activeVehicle: index === (active.vehicles ?? 0), unit: 'vehicles' })),
        ...(rule.trailers ? (record.trailers ?? []).map((_, index) => ({ rule, active: { ...active, trailers: index }, activeVehicle: false, unit: 'trailers' })) : []),
      ];
    }
    if (scope === 'trailer') {
      return (record.trailers ?? []).map((_, index) => ({ rule, active: { ...active, trailers: index }, activeVehicle: index === (active.trailers ?? 0) }));
    }
    return [{ rule, active }];
  });
  return expanded.map(/** @returns {FieldStep} */ ({ rule, active, activeVehicle = null, unit = null }, id) => {
    const list = rule.path ? listOf(rule.path) : null;
    const path = rule.path
      ? (list ? rule.path.replace('[]', `[${active[list] ?? 0}]`) : rule.path)
      : `${carrier?.id ?? 'carrier'}.q${rule.q ?? id}`;
    const info = rule.path ? fieldInfo(rule.path) : { label: rule.name ?? path, kind: 'text' };
    const name = rule.name ?? info.label;
    // A rule with a path and no computed value reads the intake; the rest declare their source.
    // A rule's source may depend on the record (a TNI standard when the intake is silent, derived
    // when it answers).
    const source = (typeof rule.source === 'function' ? rule.source(record, active) : rule.source) ?? (rule.path && rule.value === undefined ? 'intake' : null);
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
    // A derived answer's evidence: the intake facts its rule read (the panel shows them on the PDF).
    const from = source === 'derived' && rule.value && value != null && value !== '' ? readsOf(rule.value, record, active, value) : null;
    const ignore = typeof rule.ignore === 'function' ? !!rule.ignore(record, active) : !!rule.ignore;
    // The agent's, never the AI's: a fact or attestation, or a client fact the intake didn't answer.
    const manualOnly = agents || (!!rule.clientFact && (value === null || value === undefined || value === ''));
    const scope = typeof rule.scope === 'function' ? rule.scope(record, active) : rule.scope ?? null;
    const scopeIndex = typeof rule.scopeIndex === 'function' ? rule.scopeIndex(record, active) : rule.scopeIndex;
    // Per-vehicle questions repeat once per vehicle, labelled "2021 MERCEDES-BENZ SPRINTER" (a
    // trailer's "2019 Wilson"): the step's unit's year/make/model picks its row.
    const v = scope === 'vehicle' && unitRows(record) ? (unit === 'trailers' ? record.trailers?.[active.trailers ?? 0] : record.vehicles[active.vehicles ?? 0])
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
      // Review mode requires confirmation even when a retained carrier answer differs.
      reviewRequired: standard && !!reviewNote,
      // The agent's to answer: the report says so and the AI assistant leaves it (ai/common.js).
      manualOnly,
      // The carrier's question id when the rule was written: only the rule's name (its path), never
      // how its field is found (Progressive renumbers questions). These find it (pagekit assign):
      q: rule.q ?? null,
      // the field's data-model name (Duck Creek fieldref),
      field: rule.field ?? null,
      // else its question on the page: exact text(s), or `label` (re) on these pages,
      ask: rule.ask ? [].concat(rule.ask) : null,
      pages: rule.page ? [].concat(rule.page) : null,
      // on these steps of a one-address application (read from the page: GEICO's progress bar),
      steps: rule.steps ? [].concat(rule.steps) : null,
      // while a form's own question is on the page (or isn't), for the unit that form is for,
      whenShown: shownOn(rule.whenShown, record, active),
      unlessShown: shownOn(rule.unlessShown, record, active),
      // a select, radio, checkbox or text box, when a text is shared by two kinds of field,
      control: rule.control ?? null,
      // Its data-model name only on its own pages (`pageOnly`: a trailer's questions carry the
      // vehicle's names), and never on `notPages` (the vehicle's questions on the trailer pages).
      pageOnly: !!rule.pageOnly,
      notPages: rule.notPages ? [].concat(rule.notPages) : null,
      // the first one after this question when its text repeats on the page,
      askAfter: rule.askAfter ?? null,
      // Not answered while this question (a data-model name) is on the page unanswered: the page is
      // still working it out (GEICO's VIN decode, which redraws the vehicle form).
      waitFor: (typeof rule.waitFor === 'function' ? rule.waitFor(record, active) : rule.waitFor) ?? null,
      // one field each for steps of a question repeated in several groups.
      each: !!rule.each,
      // Never "needs you" when empty (middle initial, suffix, DBA).
      optional: !!rule.optional,
      // The registered business names a USDOT lookup offers (checked against the intake).
      registeredName: !!rule.registeredName,
      // Progressive's cargo questions: 'section' (the commodity section), 'limit', or true.
      cargo: rule.cargo ?? null,
      // Its general liability questions the same way: 'section' or 'limit'.
      gl: rule.gl ?? null,
      selector: rule.repeatSelector ? rule.repeatSelector(record, active) : rule.selector ?? null,
      re: rule.label ?? null,
      ex: rule.not ?? null,
      // A label rule that never answers a field inside these (the carrier's `rowSections`).
      notWithin: rule.notWithin ?? null,
      note,
      ignore,
      // An ignored selector rule that takes every match it finds, not only its first.
      every: !!rule.every,
      // Checked against the intake, never typed (a VIN decode's year): may depend on the unit.
      verifyOnly: typeof rule.verifyOnly === 'function' ? !!rule.verifyOnly(record, active) : !!rule.verifyOnly,
      // Our answer replaces what the page put there (e.g. a lookup's body type); may depend on the
      // client (AmWINS' hazard exposure: only the intake's Yes replaces Default all answers to No's No).
      replace: typeof rule.replace === 'function' ? !!rule.replace(record, active) : !!rule.replace,
      // What a lookup put there wins over the intake's wording (no "page differs" flag).
      trustPage: !!rule.trustPage,
      // A differing choice already on the page is kept and flagged, never replaced (`replaceChoices`).
      keepChoice: !!rule.keepChoice,
      // A choice the carrier already made is kept as it is, without a check; only an empty one is
      // answered (Progressive's anti-theft device: W44-32).
      keepPreset: !!rule.keepPreset,
      // A list without the answer keeps the page's own choice, with a check (GEICO's cities for the ZIP).
      keepUnlisted: !!rule.keepUnlisted,
      // A choice whose option a helper shows (GEICO's 11 Payments, behind View More Payment Plans):
      // not offered yet, it waits instead of failing; never offered, it is the agent's.
      whenOffered: !!rule.whenOffered,
      // Never offered once a helper has shown every option (`after`: its id), the option with the
      // highest count instead (`count`: a pattern whose first group is the count; `one`: an option
      // that counts 1), named in the report as `name` (GEICO's pay plan: W43-32).
      orMost: rule.orMost ? { count: rule.orMost.count, one: rule.orMost.one ?? null, after: rule.orMost.after, name: rule.orMost.name } : null,
      // May fill its field while it isn't on screen (an earlier step's question added later).
      hidden: !!rule.hidden,
      // One question asked as several boxes (AmWINS' auto symbols 1 to 9): the panel lists it once,
      // with the boxes ticked.
      group: rule.group ?? null,
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
      // Words the question's own text must show for the answer to be given (GEICO's USDOT record:
      // the intake's house number, street and ZIP, W43-24), and the note when it doesn't.
      labelHas: rule.labelHas ? rule.labelHas(record, active) : null,
      labelNote: rule.labelNote ?? null,
      // Answered only when one of these holds: a list, its own or another question's (`path`),
      // offers a limit or none (GEICO's Basic PIP reads Medical Payments'), with the first one's
      // `value` if it has one; otherwise the agent's, with the note.
      onlyIf: onlyIfOf(typeof rule.onlyIf === 'function' ? rule.onlyIf(record, active) : rule.onlyIf),
      onlyNote: rule.onlyNote ?? null,
      // A list without the answer, which no helper shows later: the agent's at once, with this note.
      unofferedNote: typeof rule.unofferedNote === 'function' ? rule.unofferedNote(record, active) : rule.unofferedNote ?? null,
      // What an address box gets when the page offers no suggestion (e.g. just the street).
      fallback: typeof rule.fallback === 'function' ? rule.fallback(record, active) : rule.fallback ?? null,
      // An address the page already shows agrees only with the intake's house number (GEICO fills
      // the street from its USDOT record).
      checkNumber: !!rule.checkNumber,
      // Type-ahead lists: what to type (the value is what the chosen result must contain).
      search: typeof rule.search === 'function' ? rule.search(record, active) : rule.search ?? null,
      withOption: typeof rule.withOption === 'function' ? rule.withOption(record, active) : rule.withOption ?? null,
      value: value === undefined || value === '' ? null : value,
      from: from?.length ? from : null,
      // Which row of a repeated question is this unit's: the one holding a control matching
      // `selector` that reads as the unit's `value` (AmWINS' vehicle rows by their VIN). The path
      // is resolved for the unit so the page kit can name it ("vehicle 2"); never its position.
      witness: rule.witness ? { selector: rule.witness.selector, path: withIndex(rule.witness.path, active), value: get(record, withIndex(rule.witness.path, active)) ?? null } : null,
    };
  });
}

// The record paths a rule's value function reads (`drivers[0].dob`, `applicant.dot`): it runs once
// more on a view of the record that notes every value looked up. Only for the evidence; the answer
// is the one computed from the record itself, so a rule that throws here changes nothing. Blank
// answers it looked at (a unit number, the notes) are left out, unless they're all it read: an
// answer worked out from what the intake left blank points at those blanks. A list the rule
// searched (every driver, for the owner's row) keeps only the items whose answers are in `value`.
function readsOf(fn, record, active, value) {
  const read = new Map();
  const view = (obj, at) => new Proxy(obj, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || typeof v === 'function') return v;
      // A list's own properties (length) aren't facts; its items are.
      const path = Array.isArray(target) ? (/^\d+$/.test(key) ? `${at}[${key}]` : null) : at ? `${at}.${key}` : key;
      if (path === null) return v;
      if (v && typeof v === 'object') return view(v, path);
      read.set(path, v);
      return v;
    },
  });
  try { fn(view(record, ''), active); } catch { /* evidence only */ }
  const filled = [...read].filter(([, v]) => v != null && v !== '');
  if (!filled.length) return [...read.keys()];
  // Words and digits only: "(555) 010-0100" is in "5550100100".
  const bare = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const answer = typeof value === 'string' || typeof value === 'number' ? bare(value) : '';
  const echoed = ([, v]) => (typeof v === 'string' || typeof v === 'number') && bare(v).length >= 2 && answer.includes(bare(v));
  const itemOf = (path) => path.match(/^(.*?)\[\d+\]/)?.[0] ?? null;
  const listOf = (item) => item.replace(/\[\d+\]$/, '');
  const inAnswer = new Set(filled.filter(echoed).map(([p]) => itemOf(p)).filter(Boolean));
  const searched = new Set([...inAnswer].map(listOf));
  return filled.map(([p]) => p).filter((p) => {
    const item = itemOf(p);
    return !item || !searched.has(listOf(item)) || inAnswer.has(item);
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
