// Shared intake scoping and field restrictions for Luna assistance.
// Exact answers, calculations and page execution remain in code.
import { TNI_RULES } from './tni-rules.js';
import { noPriorInsurance, priorPolicyExpired } from '../util.js';
import { redactionTerms } from '../plan.js';
import { redactor } from '../usage.js';

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

export function assistContextKey(record, active) {
  return stableJson([record, active]);
}

const NEVER = [
  /\b(mvr|clue)\b|motor vehicle (record|report)|loss history report/i,
  /\bexclu(?:de|ded|des|ding|sions?)\b/i,
  /\b(signature|sign here|e-?sign|attest|acknowledg|i agree|i certify|i declare|declare that|true,? (and )?complete|consent|authori[sz])/i,
  /\b(bank|routing|account (number|no)|card (number|no)|credit card|cvv|ssn|social security|password)\b/i,
  /\b(payments?|billing|bill\s*plan|ach|eft|autopay|checking\s*account|direct\s*debit|pay\s*in\s*full)\b/i,
  // Progressive's NTL section has not been seen on a live quote: its questions are the agent's.
  /\bnon[\s-]*trucking\b|\bntl\b|\bbob[\s-]*tail/i,
];
const TYPED_ID = /\b(vin|license|licence|usdot|dot (number|no|#)|mc (number|no|#)|fein|ein|tax id|policy (number|no|#))\b/i;
// These require exact calculations or independent lookup identity checks, not semantic guesses.
// `manualOnly`/`fieldType` are explicit metadata for callers that know the field semantics;
// labels remain a compatibility fallback for reports produced by older page kits.
const MANUAL_FIELD_TYPES = new Set(['number', 'numeric', 'date', 'limit', 'identity', 'identifier']);
const REVIEW = /\b(age|date|dob|birth|years?|months?|days?|miles?|mileage|radius|limit|deductible|value|amount|premium|gvw|weight|count|distance|csl)\b|\b(?:dot|vin)\b.*\b(belong|match|registered|correct|valid|verified|identity|same)\b/i;
export function manualOnlyReason(item) {
  if (item.manualOnly === true) return 'this field requires agent review';
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
      flags.manualOnly ||= x.manualOnly === true;
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

// Keep only the active row of repeating entities. Identifiers are represented by presence,
// never guessed or copied by the assistant. Other sensitive fields are not needed for option matching.
// Every string the model sees is redacted with the same terms as the claims-box review and the
// usage log (redactionTerms: the client's names, dates of birth, street, city, ZIP, contact and ID
// numbers become `[client]`), in the evidence sources and in the verification call's intake alike
// (audit 2026-10-08: names, DOB, address and claims text went verbatim). Numbers and booleans
// stay; the prior carrier's name and the garaging state are not terms and are still sent.
export function scopedIntake(record, active) {
  const privateKey = /^(vin|licenseNumber|licensePlate|fein|ssn|socialSecurity|phone|email|policyNumber|accountNumber|routingNumber|password)$/i;
  const redact = redactor(redactionTerms(record));
  const clean = (obj) => {
    if (Array.isArray(obj)) return obj.map(clean);
    if (typeof obj === 'string') return redact(obj);
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !privateKey.test(k)).map(([k, v]) =>
      ['dot', 'mc'].includes(k) ? [`has${k.toUpperCase()}`, !!v] : [k, clean(v)]));
  };
  const out = {};
  for (const key of ['applicant', 'operations', 'garaging', 'coverage', 'claims', 'notes', 'trailerInfo', 'priorInsurance']) {
    if (record[key]) out[key] = clean(record[key]);
  }
  for (const key of ['drivers', 'vehicles', 'trailers']) {
    const index = active[key] ?? 0;
    if (Number.isInteger(index) && index >= 0 && record[key]?.[index]) out[`${key}[${index}]`] = clean(record[key][index]);
  }
  if (record.priorInsurance?.length) out.computed = { priorPolicyExpired: priorPolicyExpired(record), noPriorInsurance: noPriorInsurance(record.priorInsurance[0]) };
  return out;
}

export function evidenceFor(context) {
  const facts = scopedIntake(context.record, context.active ?? {});
  const sources = {};
  const flatten = (obj, path = '') => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      const p = Array.isArray(obj) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (value && typeof value === 'object') flatten(value, p);
      else if (value !== null && value !== undefined && value !== '') {
        sources[`s${Object.keys(sources).length + 1}`] = { basis: 'intake', path: p, value };
      }
    }
  };
  flatten(facts);
  const [progressive, amwins] = TNI_RULES.split('# AmWINS Admitted Placement (Business Auto)');
  const text = context.carrier === 'progressive' ? progressive : context.carrier === 'amwins' ? amwins : '';
  for (const line of (text || '').split('\n').filter(l => l.startsWith('- '))) {
    sources[`s${Object.keys(sources).length + 1}`] = { basis: 'tni_rule', rule: line.slice(2) };
  }
  if (Object.keys(sources).length > MAX_OPTIONS) throw new AssistError('Too much intake context for one decision. Answer this page manually.');
  return { facts, sources };
}

export class AssistError extends Error {}
