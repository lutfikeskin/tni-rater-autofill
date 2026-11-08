// Shared intake scoping and field restrictions for Luna assistance.
// Exact answers, calculations and page execution remain in code.
import { rulebookFor } from './tni-rules.js';
import { rulebookRewriteFor } from '../agent-defaults/index.js';
import { noPriorInsurance, priorPolicyExpired } from '../util.js';
import { redactionTerms } from '../plan.js';
import { redactor } from '../usage.js';
import { agentsAlone, resolutionOf } from '../resolution.js';

export const LEAVE = '__leave__';
const CHOICE_KINDS = new Set(['radio', 'select', 'checkbox']);
const MAX_OPTIONS = 254; // Keep per-field choices and evidence context bounded.

// JSON with every object's keys in sorted order. chrome.storage gives an object back with its keys
// sorted, not in the order they were set: a key that compares an intake before and after the panel
// reopens must not see that as an edit.
export function stableJson(value) {
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(value));
}

// What decides Luna's answers on a carrier, as one key: the intake as Luna can see it (every row,
// with scopedIntake's identifier removal and redaction), the active rows, and the carrier's TNI rules
// as they are sent, an agent's own defaults included (evidenceFor). Suggestions are cached on it, and
// an answer asked under another key is not used: a defaults or rulebook change asks again, an edit
// Luna never sees (a phone number) does not (audit 2026-11-07, AI-05).
export function assistContextKey(record, active, carrier = null) {
  const rules = carrier ? rulesSent(carrier).map((rule) => [rule.id, rule.text]) : null;
  return stableJson([record ? visibleIntake(record) : null, active, rules]);
}

const NEVER = [
  /\b(mvr|clue)\b|motor vehicle (record|report)|loss history report/i,
  /\bexclu(?:de|ded|des|ding|sions?)\b/i,
  /\b(signature|sign here|e-?sign|attest|acknowledg|i agree|i certify|i declare|declare that|true,? (and )?complete|consent|authori[sz])/i,
  /\b(bank|routing|account (number|no)|card (number|no)|credit card|cvv|ssn|social security|password)\b/i,
  /\b(payments?|billing|bill\s*plan|ach|eft|autopay|checking\s*account|direct\s*debit|pay\s*in\s*full)\b/i,
  // Progressive's NTL section has not been seen on a live quote: its questions are the agent's.
  /\bnon[\s-]*trucking\b|\bntl\b|\bbob[\s-]*tail/i,
  // Whether the USDOT number belongs to the business: the extension fills it after its own
  // registered-name check (Progressive, TNI 2026-10-20); one it couldn't answer is the agent's.
  /\b(?:us)?dot\b.*\bbelong/i,
];
const TYPED_ID = /\b(vin|license|licence|usdot|dot (number|no|#)|mc (number|no|#)|fein|ein|tax id|policy (number|no|#))\b/i;
// These require exact calculations or independent lookup identity checks, not semantic guesses.
// `manualOnly`/`fieldType` are explicit metadata for callers that know the field semantics;
// labels remain a compatibility fallback for reports produced by older page kits.
const MANUAL_FIELD_TYPES = new Set(['number', 'numeric', 'date', 'limit', 'identity', 'identifier']);
const REVIEW = /\b(age|date|dob|birth|years?|months?|days?|miles?|mileage|radius|limit|deductible|value|amount|premium|gvw|weight|count|distance|csl)\b|\b(?:(?:us)?dot|vin)\b.*\b(belong|match|registered|correct|valid|verified|identity|same)\b/i;
export function manualOnlyReason(item) {
  if (agentsAlone(item)) return 'this field requires agent review';
  if (item.reviewOnly === true) return 'this field requires agent review';
  const fieldType = String(item.fieldType ?? item.valueType ?? item.semanticType ?? '').trim().toLowerCase();
  if (MANUAL_FIELD_TYPES.has(fieldType)) return `${fieldType} fields require agent review`;
  return REVIEW.test(`${item.section || ''} ${item.label || ''} ${item.q || ''}`)
    ? 'numeric, date, limit and identity fields require agent review' : null;
}
export function neverReason(item) {
  // Medical Payments is insurance coverage, not authorization to pay or debit an account.
  const text = `${item.section || ''} ${item.label || ''}`.replace(/\bmedical payments?\b/gi, 'medical coverage');
  if (NEVER.some(re => re.test(text))) return 'TNI leaves this question to the agent';
  if (item.controlKind === 'text' && TYPED_ID.test(text)) return 'identifiers come only from the intake';
  return null;
}

export function collectItems(frames) {
  const seen = new Set(), items = [], blocked = [];
  const groups = [['failed', 'failed'], ['unknown', 'unfamiliar'], ['noData', 'not_on_intake'], ['leftRequired', 'required']];
  const restrictions = new Map();
  // One control can be both invalid and missing an intake fact. Retain the strictest
  // safety flags before report priority deduplicates those entries.
  for (const [group] of groups) {
    for (const x of frames.flatMap(f => f?.[group] ?? [])) {
      const sig = `${x.key}|${x.label}`;
      const flags = restrictions.get(sig) ?? { manualOnly: false, reviewOnly: false };
      // The agent's alone: its resolution says so (resolution.js; rebuilt for a report kept from before).
      flags.manualOnly ||= resolutionOf(x, group).status === 'agent';
      flags.reviewOnly ||= x.reviewOnly === true;
      restrictions.set(sig, flags);
    }
  }
  for (const [group, status] of groups) {
    for (const x of frames.flatMap(f => f?.[group] ?? [])) {
      const sig = `${x.key}|${x.label}`;
      if (!x.key || seen.has(sig)) continue;
      seen.add(sig);
      const options = x.controlKind === 'checkbox' ? ['checked', 'unchecked']
        : [...new Set((x.options ?? []).map(o => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean))];
      const item = { key: x.key, q: x.q ?? null, label: x.label ?? '', section: x.section || null,
        controlKind: x.controlKind ?? null, required: !!x.required, status, reason: x.reason ?? x.note ?? null,
        // The intake field the rules map this question to (the fill's `path`), when it is one.
        rulePath: intakePathOf(x.path),
        current: x.current ?? null, options, applyable: CHOICE_KINDS.has(x.controlKind) && options.length > 0,
        ...restrictions.get(sig),
        fieldType: x.fieldType ?? x.valueType ?? x.semanticType ?? null };
      // A client fact or attestation the rules leave to the agent (plan.js manualOnly): never the AI's.
      const why = item.reviewOnly ? 'lookup identity mismatch requires agent review'
        : item.manualOnly ? 'TNI leaves this client fact to the agent' : neverReason(item)
        || (!item.applyable ? 'The assistant needs visible choices; enter this answer on the page' : null)
        || (options.length > MAX_OPTIONS ? 'too many choices; narrow the list on the page first' : null);
      if (why) blocked.push({ ...item, why });
      else items.push({ ...item, id: `f${items.length + 1}` });
    }
  }
  return { items, blocked };
}

const SECTION_KEYS = ['applicant', 'operations', 'garaging', 'coverage', 'claims', 'notes', 'trailerInfo', 'priorInsurance'];
const UNIT_LISTS = ['drivers', 'vehicles', 'trailers'];
const UNIT_PATH = /^(drivers|vehicles|trailers)\[(\d+)\]/;

// A fill path that names an intake field ("operations.needSr22", "drivers[1].cdl"); a carrier's own
// key ("geico.qLiabilityCoverage", Progressive's question codes) is none.
export function intakePathOf(path) {
  if (typeof path !== 'string' || path.length > 120) return null;
  return SECTION_KEYS.some((k) => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[`)) || UNIT_PATH.test(path) ? path : null;
}

// The intake value at a path ("drivers[1].cdl"), undefined when the record has none.
export function intakeValue(record, path) {
  let value = record;
  for (const part of String(path).split(/\.|\[(\d+)\]/).filter(Boolean)) value = value == null ? undefined : value[part];
  return value;
}

// Which driver, vehicle or trailer row a question is about: its intake path's, else a vehicle whose
// year and make are in the question's text (GEICO's per-vehicle questions start "2020 RAM 3500"),
// when exactly one is. Code matches; the model is told the row, never asked to find it.
export function entityOf(item, record) {
  const m = UNIT_PATH.exec(item.rulePath ?? '');
  if (m) return record?.[m[1]]?.[Number(m[2])] ? `${m[1]}[${m[2]}]` : null;
  const text = ` ${item.label ?? ''} ${item.section ?? ''} `.toLowerCase().replace(/\s+/g, ' ');
  const named = (record?.vehicles ?? []).flatMap((v, i) => (v?.year && String(v?.make ?? '').trim()
    && text.includes(` ${String(v.year).trim()} ${String(v.make).trim().toLowerCase().replace(/\s+/g, ' ')} `) ? [i] : []));
  return named.length === 1 ? `vehicles[${named[0]}]` : null;
}

// Rows the questions name beyond the active ones, at most MAX_EXTRA_ROWS per list.
const MAX_EXTRA_ROWS = 2;
export function rowsFor(items, record, active = {}) {
  const rows = {};
  for (const item of items) {
    const m = UNIT_PATH.exec(entityOf(item, record) ?? '');
    if (!m || Number(m[2]) === (active[m[1]] ?? 0)) continue;
    rows[m[1]] ??= [];
    if (!rows[m[1]].includes(Number(m[2])) && rows[m[1]].length < MAX_EXTRA_ROWS) rows[m[1]].push(Number(m[2]));
  }
  return rows;
}

// Questions whose choices name the client's people or place: a driver, an owner, or the garaging
// street, unit, city or ZIP, as the redactor would replace them (redactionTerms). Luna gets those facts
// as [client], so such a choice goes as a placeholder naming whose it is ("Driver 1 (intake
// drivers[0])", "Owner (intake applicant.owner1)", "Garaging city"), and code maps the pick back by its
// place in the list: no name or address is sent (the maintainer, 2026-11-07; audit AI-13). A choice
// is a driver's when it holds each word of their first and last name, an owner's when it holds each
// word of the name. A question stays with the agent, never asked, when code can't tell whose a choice
// is: part of a name only, two drivers or two owners, a person and the address, two choices for the
// same placeholder, or a current answer naming the client that is none of its choices. Picking
// between people is an identity match, so a pick made so is never an automatic one. The business's
// own name doesn't count: its words are often a business class or cargo ("Reefer Express").
//   items:   what to send (the others as they are)
//   held:    questions kept from Luna
//   restore: a suggestion back with the page's own choices
//   toSend:  what goes to Luna for one of `items`' originals (itself unless its choices name the client)
const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
export function pseudonymizeChoices(items, record) {
  const a = record?.applicant ?? {}, g = record?.garaging ?? {};
  const drivers = record?.drivers ?? [];
  const names = redactor(redactionTerms({ applicant: { owner1: a.owner1, owner2: a.owner2 },
    drivers: drivers.map((d) => ({ first: d?.first, middle: d?.middle, last: d?.last })) }));
  const people = [
    ...drivers.map((d, i) => ({ driver: true, said: `Driver ${i + 1} (intake drivers[${i}])`, words: [...wordsOf(d?.first), ...wordsOf(d?.last)] })),
    { driver: false, said: 'Owner (intake applicant.owner1)', words: wordsOf(a.owner1) },
    { driver: false, said: 'Owner 2 (intake applicant.owner2)', words: wordsOf(a.owner2) },
  ].filter((p) => p.words.length);
  // A garaging value as a value of its own, never part of a larger number or an amount: unit 100 is
  // in "Suite 100", not in "$100,000/$300,000" (CodeRabbit on PR #418). A ZIP with its four more
  // digits ("62704-1234") is the ZIP.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const places = [['street', 'Garaging street'], ['unit', 'Garaging unit'], ['city', 'Garaging city'], ['zip', 'Garaging ZIP']]
    .map(([k, said]) => [k, String(g[k] ?? '').replace(/\s+/g, ' ').trim(), said]).filter(([, v]) => v.length >= 2)
    .map(([k, v, said]) => ({ said, re: new RegExp(`(?<![\\p{L}\\p{N}$.,/-])${escape(v).replace(/ /g, '\\s+')}${k === 'zip' ? '(?:-\\d{4})?' : ''}(?![\\p{L}\\p{N}]|[.,/-]\\p{N})`, 'iu') }));
  const named = (o) => typeof o === 'string' && (names(o) !== o || places.some((p) => p.re.test(o)));
  // A choice's placeholder; the choice itself when it names no one; null when code can't tell whose.
  const placeholder = (o) => {
    if (!named(o)) return o;
    const words = new Set(wordsOf(o));
    const who = people.filter((p) => p.words.every((w) => words.has(w)));
    const where = places.filter((p) => p.re.test(o));
    const [drv, own] = [who.filter((p) => p.driver), who.filter((p) => !p.driver)];
    if (drv.length > 1 || own.length > 1 || (who.length && where.length)) return null;
    if (where.length) return where.length === 1 ? where[0].said : 'Garaging address';
    if (!who.length) return null;
    return drv.length ? `${drv[0].said}${own.length ? `, also ${own[0].said}` : ''}` : own[0].said;
  };
  const sent = [], held = [], back = new Map(), copies = new Map();
  const sig = (x) => `${x?.id ?? ''}|${x?.key}|${x?.label}`;
  for (const x of items) {
    const options = x.options ?? [];
    if (!options.some(named) && !named(x.current)) { sent.push(x); continue; }
    const shown = options.map(placeholder);
    const at = options.indexOf(x.current);
    const current = at >= 0 ? shown[at] : x.current;
    if (shown.includes(null) || new Set(shown).size !== shown.length || named(current)) { held.push(x); continue; }
    const copy = { ...x, options: shown, current };
    sent.push(copy);
    copies.set(x, copy);
    back.set(sig(x), { options, shown, current: x.current });
  }
  const restore = (s) => {
    const b = back.get(sig(s));
    if (!b) return s;
    const at = s.choice == null ? -1 : b.shown.indexOf(s.choice);
    return { ...s, options: b.options, current: b.current, choice: at >= 0 ? b.options[at] : null, autoOk: false, pseudonymized: true,
      ...(s.choice != null && at < 0 ? { leave: true } : {}) };
  };
  return { items: sent, held, restore, toSend: (x) => copies.get(x) ?? x };
}

// The page's other choice questions and what they show now, as the agent sees them: context for
// consistency, never evidence. From the panel's decision snapshot (pagekit decisionSnapshot, one JSON
// string per frame). Never a typed value, nor a question on the never-list or about identifiers,
// names or addresses; labels and answers are redacted like the intake.
const PAGE_LABEL_PRIVATE = /\b(name|names|address|street|city|zip|phone|e-?mail|birth|dob|vin|licen[cs]e|plate|ssn|fein|ein|policy (number|no|#)|account|routing|usdot|dot (number|no|#)|mc (number|no|#)|suffix)\b/i;
const MAX_PAGE_ANSWERS = 40;
const MAX_PAGE_CHARS = 6000;
export function pageAnswers(snapshots, items, record) {
  const asked = new Set(items.map((x) => `${x.key}|${x.label}`));
  const redact = redactor(redactionTerms(record ?? {}));
  const clip = (s, n) => { const t = redact(String(s ?? '').replace(/\s+/g, ' ').trim()); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const out = [], seen = new Set();
  let size = 0;
  for (const frame of snapshots ?? []) {
    let controls;
    try { controls = JSON.parse(frame?.result ?? 'null')?.[1]; } catch { controls = null; }
    for (const c of Array.isArray(controls) ? controls : []) {
      if (!CHOICE_KINDS.has(c?.kind) || asked.has(`${c.key}|${c.label}`) || c.current == null || String(c.current).trim() === '') continue;
      const text = `${c.section ?? ''} ${c.label ?? ''}`;
      if (!String(c.label ?? '').trim() || neverReason({ section: c.section, label: c.label, controlKind: c.kind }) || TYPED_ID.test(text) || PAGE_LABEL_PRIVATE.test(text)) continue;
      const entry = { ...(c.section ? { section: clip(c.section, 60) } : {}), label: clip(c.label, 120), answer: clip(c.current, 60) };
      const sig = JSON.stringify(entry);
      if (seen.has(sig)) continue;
      if (out.length >= MAX_PAGE_ANSWERS || size + sig.length > MAX_PAGE_CHARS) return out;
      seen.add(sig);
      size += sig.length;
      out.push(entry);
    }
  }
  return out;
}

// Keep only the active row of repeating entities, and the rows the questions name (`rows`, from
// rowsFor). Identifiers are represented by presence, never guessed or copied by the assistant. Other sensitive fields are not needed for option matching.
// Every string the model sees is redacted with the same terms as the claims-box review and the
// usage log (redactionTerms: the client's names, dates of birth, street, city, ZIP, contact and ID
// numbers become `[client]`), in the evidence sources and in the verification call's intake alike
// (audit 2026-10-08: names, DOB, address and claims text went verbatim). Numbers and booleans
// stay; the prior carrier's name and the garaging state are not terms and are still sent.
export function scopedIntake(record, active, rows = {}) {
  const clean = cleaner(record);
  const out = {};
  for (const key of SECTION_KEYS) {
    if (record[key]) out[key] = clean(record[key]);
  }
  for (const key of UNIT_LISTS) {
    for (const index of [active[key] ?? 0, ...(rows[key] ?? []).slice(0, MAX_EXTRA_ROWS)]) {
      if (Number.isInteger(index) && index >= 0 && record[key]?.[index]) out[`${key}[${index}]`] = clean(record[key][index]);
    }
  }
  if (record.priorInsurance?.length) out.computed = { priorPolicyExpired: priorPolicyExpired(record), noPriorInsurance: noPriorInsurance(record.priorInsurance[0]) };
  return out;
}

// A copy of an intake value as Luna may see it: identifiers dropped (DOT and MC as present or not),
// client terms redacted.
function cleaner(record) {
  const privateKey = /^(vin|licenseNumber|licensePlate|fein|ssn|socialSecurity|phone|email|policyNumber|accountNumber|routingNumber|password)$/i;
  const redact = redactor(redactionTerms(record));
  const clean = (obj) => {
    if (Array.isArray(obj)) return obj.map(clean);
    if (typeof obj === 'string') return redact(obj);
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !privateKey.test(k)).map(([k, v]) =>
      ['dot', 'mc'].includes(k) ? [`has${k.toUpperCase()}`, !!v] : [k, clean(v)]));
  };
  return clean;
}

// All Luna could see of an intake: scopedIntake with every driver, vehicle and trailer row.
function visibleIntake(record) {
  const clean = cleaner(record);
  const out = {};
  for (const key of SECTION_KEYS) if (record[key]) out[key] = clean(record[key]);
  for (const key of UNIT_LISTS) (record[key] ?? []).forEach((row, i) => { if (row) out[`${key}[${i}]`] = clean(row); });
  if (record.priorInsurance?.length) out.computed = { priorPolicyExpired: priorPolicyExpired(record), noPriorInsurance: noPriorInsurance(record.priorInsurance[0]) };
  return out;
}

// The carrier's TNI rules as Luna gets them: an agent's own default rewrites the entries stating the
// standard it replaces (src/agent-defaults/).
export function rulesSent(carrier) {
  return rulebookFor(carrier, { rewrite: rulebookRewriteFor(carrier) });
}

export function evidenceFor(context) {
  const facts = scopedIntake(context.record, context.active ?? {}, context.rows ?? {});
  // TNI's rules first, keyed by their ids: the general part and this carrier's (none for a carrier
  // without a part), the same for every request on that carrier, so its requests share one start.
  const sources = {};
  for (const rule of rulesSent(context.carrier)) sources[rule.id] = { basis: 'tni_rule', rule: rule.text };
  let n = 0;
  const flatten = (obj, path = '') => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      const p = Array.isArray(obj) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (value && typeof value === 'object') flatten(value, p);
      else if (value !== null && value !== undefined && value !== '') {
        sources[`s${++n}`] = { basis: 'intake', path: p, value };
      }
    }
  };
  flatten(facts);
  // Too much for one request: the planner splits the group (fewer questions name fewer rows).
  if (Object.keys(sources).length > MAX_OPTIONS) throw new RequestTooLarge('Too much intake context for one decision. Answer this page manually.');
  return { facts, sources };
}

export class AssistError extends Error {}
export class RequestTooLarge extends AssistError {}
