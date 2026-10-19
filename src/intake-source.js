// Where an answer of the client record was read on the intake PDF: the form field(s) normalize.js
// took it from, and their place on the page (readIntakePlaces). The panel uses it to show a check
// item or a filled answer on the form. Only the reading: nothing here decides an answer.

import { ROWS, MARITAL_FIELDS } from './normalize.js';

// Record path -> the form fields it is read from (normalizeIntake). A derived answer points at the
// field it is derived from (years in business: the year established; radius miles: the radius).
const FIELDS = {
  'applicant.name': ['company_name'],
  'applicant.dot': ['dot_number'],
  'applicant.mc': ['mc_number'],
  'applicant.mcDotWithin60Days': ['mc_dot_60days'],
  'applicant.fein': ['fein'],
  'applicant.yearEstablished': ['year_established'],
  'applicant.yearsInBusiness': ['year_established'],
  'applicant.phone': ['phone_number'],
  'applicant.email': ['email'],
  'applicant.owner1': ['owner_name_1'],
  'applicant.owner2': ['owner_name_2'],
  'applicant.ownerDrives': ['owner_drives'],
  'applicant.yearsExperience': ['years_experience'],
  'applicant.applicationDate': ['date_of_application'],
  garaging: ['garaging_address'],
  'operations.businessClass': ['biz_class'],
  'operations.whatHaul': ['what_haul'],
  'operations.radius': ['avg_radius'],
  'operations.radiusMiles': ['avg_radius'],
  'operations.vehicleOwnership': ['veh_ownership'],
  'operations.personalUse': ['vehicle_personal_use'],
  'operations.usesEld': ['use_eld'],
  'operations.eldBrand': ['eld_brand'],
  'operations.needSr22': ['need_sr22'],
  'operations.filingsRequired': ['fed_state_filings'],
  'operations.filingsWhich': ['filings_which'],
  'operations.hazmat': ['haul_hazmat'],
  'operations.hazPlacard': ['hazardous_placard'],
  'operations.movingState': ['moving_state'],
  'operations.canadaLoads': ['loads_to_canada'],
  'operations.licensePlate': ['license_plate'],
  'operations.equipVehicle': ['equip_vehicle'],
  'trailerInfo.ownership': ['trl_ownership'],
  'trailerInfo.hitch': ['trl_hitch_type'],
  'trailerInfo.interchange': ['trl_interchange'],
  'trailerInfo.interchangeLimit': ['trl_interchange_limit', 'interchange_limit'],
  'trailerInfo.equipTrailer': ['equip_trailer'],
  priorInsurance: ['ins_type_1', 'ins_carrier_1', 'ins_limit_1', 'ins_exp_1'],
  'priorInsurance[0].type': ['ins_type_1'],
  'priorInsurance[0].carrier': ['ins_carrier_1'],
  'priorInsurance[0].limit': ['ins_limit_1'],
  'priorInsurance[0].expiration': ['ins_exp_1'],
  'coverage.autoLiability': ['auto_liability'],
  'coverage.autoLiabLimit': ['auto_liab_limit'],
  'coverage.cargo': ['cargo_cov'],
  'coverage.cargoLimit': ['cargo_limit_ded'],
  'coverage.cargoDeductible': ['cargo_limit_ded'],
  'coverage.gl': ['gen_liability'],
  'coverage.glLimit': ['gen_liab_limit'],
  'coverage.reeferBreakdown': ['reefer_breakdown'],
  // Not a form field: only the claims box or the Additional Notes box names it.
  'coverage.ntl': ['claims_details', 'additional_notes'],
  'coverage.hasGl': ['claims_details', 'additional_notes'],
  claims: ['claims_details'],
  notes: ['additional_notes'],
};
FIELDS['priorInsurance[0]'] = FIELDS.priorInsurance;

// A driver's, vehicle's or trailer's answer is in its form row (`rows`, from normalizeIntake).
const DRIVER = {
  first: ['drv_first'], middle: ['drv_first'], last: ['drv_last'], dob: ['drv_dob'], licenseNumber: ['drv_lic'],
  licenseState: ['drv_state', 'drv_lic'], cdl: ['drv_cdl'], cdlYear: ['drv_cdl_yr'],
};
const UNIT = ['type', 'year', 'make', 'model', 'vin', 'value'];
const LISTS = { drivers: 'drv', vehicles: 'veh', trailers: 'trl' };
const rowFields = (list, n) => (list === 'drivers'
  ? [...Object.values(DRIVER).map(([f]) => `${f}_${n}`), MARITAL_FIELDS[n - 1]]
  : UNIT.map((k) => `${LISTS[list]}_${k}_${n}`));

/**
 * The intake form fields a record path was read from, [] when none (a TNI standard, an answer
 * only the agent gives).
 * @param {string} path   e.g. 'applicant.dot', 'drivers[1].dob', 'vehicles'
 * @param {{ drivers?: number[], vehicles?: number[], trailers?: number[] }} [rows]  form row per item
 */
export function sourceFields(path, rows = {}) {
  const p = String(path ?? '');
  const item = /^(drivers|vehicles|trailers)(?:\[(\d+)\](?:\.(\w+))?)?$/.exec(p);
  if (item) {
    const [, list, index, key] = item;
    // A whole list (no drivers listed, the owner not among them): its rows on the form.
    if (index == null) return ROWS.flatMap((n) => rowFields(list, n));
    const n = rows[list]?.[Number(index)] ?? Number(index) + 1;
    if (!ROWS.includes(n)) return [];
    if (key == null) return rowFields(list, n);
    if (list === 'drivers') {
      if (key === 'maritalStatus') return [MARITAL_FIELDS[n - 1]];
      return (DRIVER[key] ?? []).map((f) => `${f}_${n}`);
    }
    return UNIT.includes(key) ? [`${LISTS[list]}_${key}_${n}`] : [];
  }
  if (FIELDS[p]) return FIELDS[p];
  // The garaging address is one box; the claims box holds the claims answer and the notes.
  const section = p.split('.')[0];
  return ['garaging', 'claims', 'notes'].includes(section) ? FIELDS[section] : [];
}

// The box around some rectangles (PDF units).
const around = (rects) => [
  Math.min(...rects.map((r) => Math.min(r[0], r[2]))), Math.min(...rects.map((r) => Math.min(r[1], r[3]))),
  Math.max(...rects.map((r) => Math.max(r[0], r[2]))), Math.max(...rects.map((r) => Math.max(r[1], r[3]))),
];

/**
 * Where a record path is on the intake PDF: its page (0-based), the rectangle around its fields
 * there (PDF units), and one rectangle per path in `rects`; null when the PDF doesn't show it.
 * Several paths (a derived answer's evidence, plan.js `from`) are each marked on the first one's
 * page; `rect` is the box around all of them.
 * @param {string | string[]} paths
 * @param {{ rows?: object, places?: { fields: Record<string, { page: number, rect: number[] }> } }} intake
 */
export function sourcePlace(paths, intake) {
  const fields = intake?.places?.fields;
  if (!fields) return null;
  const groups = [].concat(paths ?? []).map((path) => sourceFields(path, intake.rows).map((name) => fields[name]).filter(Boolean))
    .filter((found) => found.length);
  if (!groups.length) return null;
  // Several fields of one path (an address split in four, a whole driver row): the box around
  // those on the first one's page.
  const page = groups[0][0].page;
  const rects = [];
  for (const found of groups) {
    const on = found.filter((f) => f.page === page);
    const rect = on.length ? around(on.map((f) => f.rect)) : null;
    if (rect && !rects.some((r) => r.every((n, i) => n === rect[i]))) rects.push(rect);
  }
  return { page, rect: around(rects), rects };
}
