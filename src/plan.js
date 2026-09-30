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
  const rules = [...(carrier?.rules ?? []), ...GENERIC_RULES];
  return rules.map((rule, id) => {
    const list = rule.path ? listOf(rule.path) : null;
    const path = rule.path
      ? (list ? rule.path.replace('[]', `[${active[list] ?? 0}]`) : rule.path)
      : `${carrier?.id ?? 'carrier'}.q${rule.q ?? id}`;
    const info = rule.path ? fieldInfo(rule.path) : { label: rule.name ?? path, kind: 'text' };
    let value = null;
    if (!rule.note) {
      try {
        value = rule.value ? rule.value(record, active) : get(record, path);
      } catch {
        value = null;
      }
    }
    return {
      id,
      path,
      name: rule.name ?? info.label,
      kind: rule.kind ?? info.kind,
      q: rule.q ?? null,
      selector: rule.selector ?? null,
      re: rule.label ?? null,
      ex: rule.not ?? null,
      note: rule.note ?? null,
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
    a.email, a.phone, a.phone?.replace(/\D/g, ''), a.dot, a.mc, a.fein, g.street, g.unit, g.city,
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
