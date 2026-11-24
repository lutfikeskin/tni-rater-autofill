// @ts-check
// Reads the TNI Personal Auto Insurance Quote Application into the personal-auto client record,
// with what the agent should check. As the commercial-auto reader does: clean up formatting, never
// guess at meaning; an answer that can't be read as the form means it stays as written, with a check.
// Values are read with the shared parsers only (src/shared/); nothing here is commercial auto's.
//
// The record shares its paths with the other product where an answer means the same thing
// (applicant, garaging, drivers, vehicles, priorInsurance, coverage, notes), so the engine, the
// panel and the log read them alike; personal auto's own answers have their own paths (residence,
// a driver's relation, occupation and discounts, a vehicle's use, mileage and lienholder).

import { parseAddress, readGaraging } from '../../shared/address.js';
import { clean, cleanMultiline, parseLicense, splitName, toDate, toInt, toMoney, toPhone, vinProblem, yesNo } from '../../shared/parse.js';
import { STATES } from '../../states.js';
import { DRIVER_ROWS, LIENHOLDER_ROWS, OLD_FIELDS, VEHICLE_ROWS, fieldsOf } from './form.js';

/** @import { IntakeResult, IntakeWarning } from '../../../types.js' */

export const UNKNOWN_FORM_ERROR = "This PDF doesn't look like the TNI Personal Auto Insurance Quote Application. Make sure you selected the fillable intake PDF.";

const DATE_IN = /(\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2}))/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const OLD_NAME = Object.fromEntries(Object.entries(OLD_FIELDS).map(([old, now]) => [now, old]));

/**
 * One box holding a driver's name and date of birth, as the first version of the form asks:
 * "Jane Q Sample 01/02/1980", "Sample, Jane - 1/2/80". The date anywhere in it; the name is the
 * rest: "Last, First" with a comma, else the first word and the rest as the last name.
 * @param {string | null} box
 */
export function splitNameAndBirth(box) {
  const s = clean(box);
  if (s == null) return { first: null, last: null, dob: null, date: null };
  const m = s.match(DATE_IN);
  const date = m ? m[1] : null;
  const name = (m ? s.replace(m[1], ' ') : s).replace(/\b(?:dob|d\.o\.b\.?|born)\b:?/gi, ' ').replace(/[\s,;:-]+$/, '').replace(/^[\s,;:-]+/, '').replace(/\s+/g, ' ').trim();
  let first = null;
  let last = null;
  if (name.includes(',')) {
    const [l, ...f] = name.split(',');
    last = l.trim() || null;
    first = f.join(' ').trim() || null;
  } else if (name) {
    const words = name.split(' ');
    first = words[0];
    last = words.slice(1).join(' ') || null;
  }
  return { first, last, dob: date ? toDate(date) : null, date };
}

/**
 * One box holding a license number and its state ("TN 123456789", "123456789 TN"): the state when
 * it is written before (parseLicense) or after the number, and the number without it. (The
 * commercial reader keeps a leading state in the number, as agents entered it there; personal
 * auto's form has a state box of its own.)
 * @param {string | null} box
 */
export function splitLicense(box) {
  const s = clean(box);
  if (s == null) return { state: null, number: null };
  const lead = parseLicense(s);
  if (lead.state) return { state: lead.state, number: lead.number?.slice(2) ?? null };
  const m = s.match(/^(.*\d.*?)[\s,;:-]+([A-Za-z]{2})\.?$/);
  if (m && STATES[m[2].toUpperCase()]) return { state: m[2].toUpperCase(), number: parseLicense(m[1]).number };
  return { state: null, number: lead.number };
}

/**
 * @param {Record<string, string | boolean>} raw  the PDF's field map (readIntakeFields)
 * @param {{ today?: Date }} [opts]
 * @returns {IntakeResult | { error: string }}
 */
export function readPersonalAuto(raw, { today = new Date() } = {}) {
  const { version, fields } = fieldsOf(raw);
  if (!version) return { error: UNKNOWN_FORM_ERROR };
  const first = version === 'first';
  /** @type {IntakeWarning[]} */
  const warnings = [];
  const check = (code, path, msg) => warnings.push({ code, path, level: 'check', msg });
  const info = (code, path, msg) => warnings.push({ code, path, level: 'info', msg });
  const txt = (k) => clean(fields[k]);
  const box = (k) => (typeof fields[k] === 'boolean' ? fields[k] : null);
  // The PDF's own name of a field (the first version's names differ), for where the panel shows it.
  const pdfName = (k) => (first ? OLD_NAME[k] ?? k : k);
  const year = today.getFullYear();
  const rows = { drivers: [], vehicles: [], trailers: [] };
  /** @type {Record<string, string[]>} */
  const readFrom = {};

  // --- The applicant: who the policy is for, and how to reach them --------------------------------
  const phoneAsWritten = txt('phone_number');
  const applicant = {
    name: null,
    phone: toPhone(phoneAsWritten) ?? phoneAsWritten,
    email: txt('email')?.toLowerCase() ?? null,
    applicationDate: toDate(fields.date_of_application),
  };
  if (phoneAsWritten && !toPhone(phoneAsWritten)) check('phone.invalid', 'applicant.phone', `"${phoneAsWritten}" isn't a 10-digit US number.`);
  if (applicant.email && !EMAIL.test(applicant.email)) check('email.invalid', 'applicant.email', `"${applicant.email}" looks malformed.`);

  const garaging = readGaraging(fields.garaging_address);
  for (const [code, path, msg] of garaging.checks) check(code, path, msg);

  // --- Drivers -------------------------------------------------------------------------------------
  /** @type {any[]} */
  const drivers = [];
  for (const n of DRIVER_ROWS) {
    let boxes = { first: txt(`drv_first_${n}`), last: txt(`drv_last_${n}`), dob: txt(`drv_dob_${n}`) };
    let splitFromOne = null;
    if (first) {
      const one = txt(`drv_name_dob_${n}`);
      const s = splitNameAndBirth(one);
      boxes = { first: s.first, last: s.last, dob: s.date };
      if (one) splitFromOne = one;
    }
    let license = { number: txt(`drv_lic_${n}`), state: clean(fields[`drv_state_${n}`]) };
    const licenseOne = first ? txt(`drv_lic_state_${n}`) : null;
    if (first) {
      const l = splitLicense(licenseOne);
      license = { number: l.number, state: l.state };
    }
    const rowFields = [boxes.first, boxes.last, boxes.dob, license.number, txt(`drv_relation_${n}`), txt(`drv_gender_${n}`), txt(`drv_occupation_${n}`)];
    if (!rowFields.some(Boolean)) continue;
    const i = drivers.length;
    const p = (f) => `drivers[${i}].${f}`;
    const name = splitName(boxes.first, boxes.last);
    // General personal-auto rule (TNI, 2026-11-24): when a driver or owner has a second name in
    // the first-name box (e.g. first + middle/patronymic), keep the first word in First Name and
    // put the second name's first letter in Middle Initial. Single-letter first words ("A J") and
    // hyphenated single words ("Mary-Ann") stay untouched.
    if (!name.middle && name.first) {
      const words = String(name.first).trim().split(/\s+/);
      if (words.length >= 2 && (words[0].match(/\p{L}/gu) ?? []).length >= 2) {
        const secondLetter = words[1].match(/\p{L}/u)?.[0] ?? null;
        if (secondLetter) {
          name.first = words[0];
          name.middle = secondLetter.toUpperCase();
        }
      }
    }
    const who = [name.first, name.last].filter(Boolean).join(' ') || `Driver ${n}`;
    const d = {
      first: name.first, middle: name.middle, last: name.last, suffix: name.suffix,
      dob: null,
      gender: txt(`drv_gender_${n}`),
      maritalStatus: txt(`drv_marital_${n}`),
      relation: txt(`drv_relation_${n}`),
      licenseNumber: license.number,
      licenseState: license.state,
      yearLicensed: toInt(fields[`drv_year_licensed_${n}`]),
      occupation: txt(`drv_occupation_${n}`),
      education: txt(`drv_education_${n}`),
      // A ticked box is Yes; an unticked one is unanswered, not No.
      matureCourse: box(`drv_mature_course_${n}`) || null,
      goodStudent: box(`drv_good_student_${n}`) || null,
      distantStudent: box(`drv_distant_student_${n}`) || null,
    };
    if (!name.first || !name.last) check('name.missing-part', p(name.first ? 'last' : 'first'), `${who}: no ${name.first ? 'last' : 'first'} name.`);
    if (boxes.dob) {
      d.dob = toDate(boxes.dob);
      if (!d.dob) { d.dob = boxes.dob; check('dob.invalid', p('dob'), `${who}: "${boxes.dob}" isn't a valid date.`); }
      else {
        const age = year - Number(d.dob.slice(6));
        if (age < 15 || age > 100) check('dob.unusual-age', p('dob'), `${who}: age ~${age}. Typo?`);
      }
    } else check('dob.missing', p('dob'), `${who}: no date of birth.`);
    if (!d.licenseNumber) check('license.missing', p('licenseNumber'), `${who}: no driver's license number.`);
    if (!d.licenseState) check('license-state.missing', p('licenseState'), `${who}: no license state.`);
    if (d.yearLicensed != null && (d.yearLicensed < 1930 || d.yearLicensed > year)) check('year-licensed.invalid', p('yearLicensed'), `${who}: licensed in ${d.yearLicensed}?`);
    // The first version's one boxes: split here, so the agent confirms the split.
    if (splitFromOne) {
      check('driver.name-dob-one-box', p('first'), `${who}: "${splitFromOne}" was one box, read as first name "${name.first ?? ''}", last name "${name.last ?? ''}", date of birth ${d.dob ?? 'none'}. Confirm.`);
      for (const f of ['first', 'last', 'dob']) readFrom[p(f)] = [pdfName(`drv_name_dob_${n}`)];
    }
    if (licenseOne) {
      check('driver.license-one-box', p('licenseNumber'), `${who}: "${licenseOne}" was one box, read as license ${d.licenseNumber ?? 'none'}, state ${d.licenseState ?? 'none'}. Confirm.`);
      for (const f of ['licenseNumber', 'licenseState']) readFrom[p(f)] = [pdfName(`drv_lic_state_${n}`)];
    }
    drivers.push(d);
    rows.drivers.push(n);
  }
  if (!drivers.length) check('drivers.none', 'drivers', 'No drivers on the form.');
  // The named insured: the driver marked Insured.
  const insured = drivers.filter((d) => /^insured$/i.test(d.relation ?? ''));
  if (insured.length) applicant.name = [insured[0].first, insured[0].last].filter(Boolean).join(' ') || null;
  if (insured.length !== 1 && drivers.length) {
    check('insured.unclear', 'drivers', insured.length ? `${insured.length} drivers are marked Insured: the first is taken as the named insured. Confirm.` : 'No driver is marked Insured: who is the named insured?');
  }

  // --- Vehicles ------------------------------------------------------------------------------------
  /** @type {any[]} */
  const vehicles = [];
  /** @type {string[]} */
  const named = [];
  for (const n of VEHICLE_ROWS) {
    const at = (f) => txt(`veh_${f}_${n}`);
    if (!['year', 'make', 'model', 'vin', 'value'].some((f) => at(f))) continue;
    const i = vehicles.length;
    const p = (f) => `vehicles[${i}].${f}`;
    const what = [at('year'), at('make'), at('model')].filter(Boolean).join(' ') || `Vehicle ${n}`;
    const vin = at('vin')?.replace(/[\s-]/g, '').toUpperCase() ?? null;
    const v = {
      year: toInt(at('year')),
      make: at('make'),
      model: at('model'),
      vin,
      use: at('use'),
      ownership: at('ownership'),
      value: toMoney(at('value')) ?? at('value'),
      ownedFor: at('owned_for'),
      // An amount from the list ("12,000"), or as written ("50,000+": the agent's).
      annualMiles: toMoney(at('annual_miles')) ?? at('annual_miles'),
      commuteMiles: toInt(at('commute_miles')) != null && /^\d+$/.test(at('commute_miles') ?? '') ? toInt(at('commute_miles')) : at('commute_miles'),
      commuteDays: toInt(at('commute_days')),
      damage: at('damage') == null ? null : /^no$/i.test(at('damage') ?? '') ? false : /^yes\b/i.test(at('damage') ?? '') ? true : null,
      fullCoverage: at('full_coverage') == null ? null : /^yes\b/i.test(at('full_coverage') ?? '') ? true : /^no\b/i.test(at('full_coverage') ?? '') ? false : null,
      lienholder: { name: null, street: null, city: null, state: null, zip: null },
    };
    if (v.year == null && at('year')) check('vehicle-year.invalid', p('year'), `${what}: "${at('year')}" isn't a year.`);
    else if (v.year != null && (v.year < 1950 || v.year > year + 1)) check('vehicle-year.invalid', p('year'), `${what}: model year ${v.year}?`);
    if (vin) {
      const problem = vinProblem(vin);
      if (problem) check('vin.invalid', p('vin'), `${what}: VIN ${vin} ${problem}.`);
    } else check('vin.missing', p('vin'), `${what}: no VIN.`);
    if (typeof v.value === 'string') check('vehicle-value.invalid', p('value'), `${what}: value "${v.value}" isn't an amount.`);
    vehicles.push(v);
    named.push(what);
    rows.vehicles.push(n);
  }
  if (!vehicles.length) check('vehicles.none', 'vehicles', 'No vehicles on the form.');
  const financed = vehicles.map((v, i) => (/^(financed|leased)$/i.test(v.ownership ?? '') ? i : -1)).filter((i) => i >= 0);
  // The lienholder is asked once, for the financed or leased vehicle: with one such vehicle it is
  // that vehicle's; with none, the only vehicle's, said so; otherwise the agent's, quoted.
  const lienholderFor = financed.length ? financed : vehicles.map((_, i) => i);

  // The first version asks once for every vehicle: the commute, the lienholder and any damage. With
  // one vehicle (or one financed or leased, for the lienholder) the answer is that vehicle's, said
  // so; with more, the agent's, quoted.
  if (first) {
    const once = (key, label, set, candidates = vehicles.map((_, i) => i)) => {
      const said = txt(key);
      if (!said) return;
      if (candidates.length === 1) {
        const i = candidates[0];
        const paths = set(vehicles[i], said);
        for (const path of paths) readFrom[`vehicles[${i}].${path}`] = [pdfName(key)];
        info(`vehicles.${key.replace(/_/g, '-')}-one-box`, `vehicles[${i}].${paths[0]}`, `${label} "${said}" was asked once for every vehicle: read as vehicle ${i + 1}'s.`);
      } else check(`vehicles.${key.replace(/_/g, '-')}-one-box`, 'vehicles', `${label} "${said}" was asked once for every vehicle: whose is it?`);
    };
    once('commute_miles', 'Commute miles', (v, s) => { v.commuteMiles = toInt(s) ?? s; return ['commuteMiles']; });
    once('commute_days', 'Commute days a week', (v, s) => { v.commuteDays = toInt(s); return ['commuteDays']; });
    once('lienholder_name', 'Lienholder', (v, s) => { v.lienholder.name = s; return ['lienholder.name']; }, lienholderFor);
    once('lienholder_address', 'Lienholder address', (v, s) => {
      // Split as the garaging address is; what doesn't split stays whole in the street.
      const a = parseAddress(s);
      if (!a?.state || !a.city) { v.lienholder.street = s; return ['lienholder.street']; }
      Object.assign(v.lienholder, { street: [a.street, a.unit].filter(Boolean).join(' '), city: a.city, state: a.state, zip: a.zip });
      return ['lienholder.street', 'lienholder.city', 'lienholder.state', 'lienholder.zip'];
    }, lienholderFor);
    const damage = txt('vehicle_damage');
    // No or None is the client's No for every vehicle; N/A is not (clean already reads N/A and a bare
    // None as blank: unanswered), and anything else is that vehicle's, or the agent's.
    if (damage && /^(no|none)\.?$/i.test(damage)) vehicles.forEach((v, i) => { v.damage = false; readFrom[`vehicles[${i}].damage`] = [pdfName('vehicle_damage')]; });
    else once('vehicle_damage', 'Damage', (v, s) => { v.damage = yesNo(s); return ['damage']; });
  } else {
    // Two lienholder rows, each naming its vehicle (1..4). Without a vehicle chosen, assign when
    // unambiguous (the only financed/leased vehicle, or the only vehicle on the form); otherwise
    // raise a check quoting the lienholder.
    let unassignedLienholder = false;
    for (const n of LIENHOLDER_ROWS) {
      const lien = {
        name: txt(`lien_name_${n}`),
        street: txt(`lien_street_${n}`),
        city: txt(`lien_city_${n}`),
        state: txt(`lien_state_${n}`),
        zip: txt(`lien_zip_${n}`),
      };
      const said = Object.values(lien).filter(Boolean).join(', ');
      if (!said) continue;
      const pickedRow = toInt(txt(`lien_vehicle_${n}`));
      if (pickedRow != null) {
        const idx = rows.vehicles.indexOf(pickedRow);
        if (idx >= 0) {
          Object.assign(vehicles[idx].lienholder, lien);
          for (const f of Object.keys(lien)) readFrom[`vehicles[${idx}].lienholder.${f}`] = [`lien_${f}_${n}`];
          if (!financed.includes(idx)) {
            info('lienholder.not-financed', `vehicles[${idx}].lienholder.name`, `Lienholder "${said}" assigned to ${named[idx]}, which isn't marked financed or leased.`);
          }
        } else {
          unassignedLienholder = true;
          check('lienholder.whose', 'vehicles', `Lienholder "${said}" names vehicle ${pickedRow}, which isn't on the form. Whose is it?`);
        }
      } else if (lienholderFor.length === 1) {
        const [i] = lienholderFor;
        Object.assign(vehicles[i].lienholder, lien);
        for (const f of Object.keys(lien)) readFrom[`vehicles[${i}].lienholder.${f}`] = [`lien_${f}_${n}`];
        if (!financed.length) info('lienholder.not-financed', `vehicles[${i}].lienholder.name`, `Lienholder "${said}" with no vehicle marked financed or leased: read as ${named[i]}'s.`);
      } else if (lienholderFor.length) {
        unassignedLienholder = true;
        check('lienholder.whose', 'vehicles', `Lienholder "${said}": ${financed.length ? `${financed.length} vehicles are financed or leased` : 'no vehicle is marked financed or leased'} and no vehicle was picked. Whose is it?`);
      }
    }
    // A financed or leased vehicle with no lienholder, unless an unassigned lienholder is waiting on the agent.
    if (!unassignedLienholder) {
      for (const i of financed) {
        if (!vehicles[i].lienholder.name) check('lienholder.missing', `vehicles[${i}].lienholder.name`, `${named[i]} is ${vehicles[i].ownership.toLowerCase()}: no lienholder.`);
      }
    }
  }

  // --- Residence -----------------------------------------------------------------------------------
  const residence = { timeAtAddress: txt('time_at_address'), priorAddress: txt('prior_address'), ownership: txt('home_own_rent') };

  // --- Current insurance ---------------------------------------------------------------------------
  const policy = {
    currentlyInsured: yesNo(fields.currently_insured),
    carrier: txt('prior_carrier'),
    limit: txt('prior_bi_limit'),
    insuredFor: txt('prior_insured_for'),
    expiration: null,
  };
  const exp = txt('prior_expiration');
  if (exp) {
    policy.expiration = toDate(exp) ?? exp;
    if (!toDate(exp)) check('prior-expiration.invalid', 'priorInsurance[0].expiration', `Current policy's expiration "${exp}" isn't a date.`);
  }
  const priorInsurance = Object.values(policy).some((v) => v != null) ? [policy] : [];

  // --- Requested coverage --------------------------------------------------------------------------
  const coverage = { liabilityLimit: txt('liability_limit'), compDeductible: txt('comp_deductible'), collDeductible: txt('coll_deductible') };
  if (first) {
    // The first version asks Yes / No Coverage beside the deductible: no coverage is the "No Coverage" deductible.
    for (const [key, path, label] of [['comp_coverage', 'compDeductible', 'Comprehensive'], ['coll_coverage', 'collDeductible', 'Collision']]) {
      const wanted = txt(key);
      if (/^no coverage$/i.test(wanted ?? '') && coverage[path] == null) coverage[path] = 'No Coverage';
      else if (/^yes$/i.test(wanted ?? '') && /^no coverage$/i.test(coverage[path] ?? '')) check('coverage.conflict', `coverage.${path}`, `${label}: Yes, with the deductible "No Coverage". Which is it?`);
      else if (/^yes$/i.test(wanted ?? '') && coverage[path] == null) check('coverage.deductible-missing', `coverage.${path}`, `${label}: Yes, with no deductible chosen.`);
    }
  }

  // --- Discounts: the first version asks which drivers, in words ------------------------------------
  if (first) {
    for (const [key, field, label] of [['mature_driver_course', 'matureCourse', 'Mature driving course'], ['good_students', 'goodStudent', 'Good student'], ['distant_students', 'distantStudent', 'Distant student']]) {
      const said = txt(key);
      if (!said || /^(no|none)\.?$/i.test(said)) continue;
      const words = said.toLowerCase().split(/[^a-z']+/).filter(Boolean);
      const named = drivers.map((d, i) => ((d.first && words.includes(d.first.toLowerCase())) || (d.last && words.includes(d.last.toLowerCase())) ? i : -1)).filter((i) => i >= 0);
      if (named.length) {
        for (const i of named) { drivers[i][field] = true; readFrom[`drivers[${i}].${field}`] = [pdfName(key)]; }
        info(`discount.${field}-by-name`, `drivers[${named[0]}].${field}`, `${label}: "${said}" read as ${named.map((i) => [drivers[i].first, drivers[i].last].filter(Boolean).join(' ')).join(', ')}. Confirm.`);
      } else check(`discount.${field}-unmatched`, 'drivers', `${label}: "${said}" names no driver on the form. Who is it?`);
    }
  }

  const record = {
    product: 'personal-auto',
    applicant,
    garaging: garaging.garaging,
    residence,
    drivers,
    vehicles,
    // Personal auto quotes no trailers: the list is empty, not unanswered.
    trailers: [],
    priorInsurance,
    coverage,
    notes: { text: cleanMultiline(typeof fields.additional_notes === 'string' ? fields.additional_notes : null) },
  };
  const known = Object.keys(raw).filter((k) => (first ? k in OLD_FIELDS : true));
  const filled = known.filter((k) => (typeof raw[k] === 'boolean' ? raw[k] : clean(raw[k]) != null)).length;
  return { record, warnings, stats: { fields: known.length, filled }, rows, readFrom };
}
