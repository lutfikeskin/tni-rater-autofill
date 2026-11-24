// @ts-check
// The TNI Personal Auto Insurance Quote Application: its fields, and how a PDF is known to be it.
// The form TNI shares names its fields (drv_first_1, veh_vin_1, prior_bi_limit, …). Its first
// version, still in use for a while, has the PDF editor's own names (text_1prsv, dropdown_7deil, …)
// and holds some answers in one box (a driver's name and date of birth, the license number and its
// state, one lienholder and one commute for every vehicle): OLD_FIELDS gives each of its names the
// name the answer has now, or the name of the one box it shared. Remove OLD_FIELDS, and the reading
// of those shared boxes in read.js, once no agent sends the old form (TNI, 2026-11-23).

export const DRIVER_ROWS = [1, 2, 3, 4, 5];
export const VEHICLE_ROWS = [1, 2, 3, 4];
export const LIENHOLDER_ROWS = [1, 2];

/** The fields of the form TNI shares. */
export const FIELDS = new Set([
  'date_of_application', 'phone_number', 'email', 'garaging_address', 'time_at_address', 'prior_address', 'home_own_rent',
  'currently_insured', 'prior_carrier', 'prior_bi_limit', 'prior_insured_for', 'prior_expiration',
  'liability_limit', 'comp_deductible', 'coll_deductible', 'additional_notes',
  ...LIENHOLDER_ROWS.flatMap((n) => ['vehicle', 'name', 'street', 'city', 'state', 'zip'].map((f) => `lien_${f}_${n}`)),
  ...DRIVER_ROWS.flatMap((n) => ['first', 'last', 'dob', 'gender', 'marital', 'relation', 'lic', 'state', 'year_licensed', 'occupation',
    'education', 'mature_course', 'good_student', 'distant_student'].map((f) => `drv_${f}_${n}`)),
  ...VEHICLE_ROWS.flatMap((n) => ['year', 'make', 'model', 'vin', 'use', 'ownership', 'value', 'owned_for', 'annual_miles', 'commute_miles',
    'commute_days', 'damage', 'full_coverage'].map((f) => `veh_${f}_${n}`)),
]);

/**
 * The first version's field names, each with the name its answer is read by: the field's name on
 * the form TNI shares, or one of the boxes that version held several answers in (drv_name_dob_<n>,
 * drv_lic_state_<n>, commute_miles, commute_days, lienholder_name, lienholder_address,
 * vehicle_damage, comp_coverage, coll_coverage, mature_driver_course, good_students,
 * distant_students).
 * @type {Record<string, string>}
 */
export const OLD_FIELDS = {
  text_1prsv: 'date_of_application', text_2diuh: 'phone_number', text_3jopv: 'email', text_4qjau: 'garaging_address',
  text_5guse: 'time_at_address', text_94yzys: 'prior_address', dropdown_66hwpu: 'currently_insured', text_67um: 'prior_carrier',
  dropdown_68iixr: 'prior_bi_limit', text_69bbix: 'prior_insured_for', text_70eqvv: 'prior_expiration', dropdown_92lbda: 'liability_limit',
  dropdown_94eqeh: 'comp_coverage', dropdown_96mmqd: 'comp_deductible', dropdown_95mcag: 'coll_coverage', dropdown_97kfkq: 'coll_deductible',
  text_74mhcl: 'commute_miles', text_75rt: 'commute_days', text_76xnrs: 'lienholder_name', text_77ijpl: 'lienholder_address',
  text_78imnp: 'vehicle_damage', Explanation: 'additional_notes', text_81fzjx: 'mature_driver_course', text_80npil: 'good_students',
  text_79sajl: 'distant_students', dropdown_102istk: 'home_own_rent',
  text_6xetx: 'drv_name_dob_1', text_11kvkh: 'drv_name_dob_2', text_12ufsl: 'drv_name_dob_3', text_13xfzv: 'drv_name_dob_4', text_14awxf: 'drv_name_dob_5',
  dropdown_7deil: 'drv_gender_1', dropdown_15hzxk: 'drv_gender_2', dropdown_16ttts: 'drv_gender_3', dropdown_17jw: 'drv_gender_4', dropdown_18yxb: 'drv_gender_5',
  dropdown_8yroq: 'drv_marital_1', dropdown_19gxup: 'drv_marital_2', dropdown_20bxht: 'drv_marital_3', dropdown_21htkd: 'drv_marital_4', dropdown_22olka: 'drv_marital_5',
  dropdown_9uaba: 'drv_relation_1', dropdown_23xcba: 'drv_relation_2', dropdown_24kfxe: 'drv_relation_3', dropdown_25imsy: 'drv_relation_4', dropdown_26ogyf: 'drv_relation_5',
  text_10gumn: 'drv_lic_state_1', text_27ogfz: 'drv_lic_state_2', text_28mvdn: 'drv_lic_state_3', text_29gbzu: 'drv_lic_state_4', text_30oxrq: 'drv_lic_state_5',
  year_licensed_1: 'drv_year_licensed_1', year_licensed_2: 'drv_year_licensed_2', year_licensed_3: 'drv_year_licensed_3',
  year_licensed_4: 'drv_year_licensed_4', year_licensed_5: 'drv_year_licensed_5',
  text_82jcuh: 'drv_occupation_1', text_83kqcg: 'drv_occupation_2', text_84vhfv: 'drv_occupation_3', text_85dwda: 'drv_occupation_4', text_86cdvn: 'drv_occupation_5',
  dropdown_87thll: 'drv_education_1', dropdown_88nowc: 'drv_education_2', dropdown_89ejka: 'drv_education_3', dropdown_90xvir: 'drv_education_4', dropdown_91jlbs: 'drv_education_5',
  text_31glmx: 'veh_year_1', text_38smcu: 'veh_year_2', text_39rorn: 'veh_year_3', text_40mdjs: 'veh_year_4',
  text_32cfgj: 'veh_make_1', text_41kajm: 'veh_make_2', text_42vmhx: 'veh_make_3', text_43fcvn: 'veh_make_4',
  text_33lndq: 'veh_model_1', text_46nxds: 'veh_model_2', text_47nro: 'veh_model_3', text_48aqdu: 'veh_model_4',
  text_34eeqt: 'veh_vin_1', text_50wobl: 'veh_vin_2', text_51mkzx: 'veh_vin_3', text_52wahg: 'veh_vin_4',
  dropdown_35fqzm: 'veh_use_1', dropdown_54upjy: 'veh_use_2', dropdown_55zog: 'veh_use_3', dropdown_56zwbf: 'veh_use_4',
  dropdown_36nadh: 'veh_ownership_1', dropdown_58xwru: 'veh_ownership_2', dropdown_59ntca: 'veh_ownership_3', dropdown_60rsng: 'veh_ownership_4',
  text_37bwtf: 'veh_value_1', text_62ldlv: 'veh_value_2', text_63wpay: 'veh_value_3', text_64wipa: 'veh_value_4',
  dropdown_98kyrv: 'veh_owned_for_1', dropdown_99gbwc: 'veh_owned_for_2', dropdown_100bmcx: 'veh_owned_for_3', dropdown_101iwap: 'veh_owned_for_4',
  text_94vgb: 'veh_annual_miles_1', text_95fbfz: 'veh_annual_miles_2', text_96vyjz: 'veh_annual_miles_3', text_97mfjm: 'veh_annual_miles_4',
};

const share = (raw, names) => Object.keys(raw).filter((k) => names.has(k)).length / names.size;
const OLD_NAMES = new Set(Object.keys(OLD_FIELDS));

/**
 * Which version of the form a PDF's field map is: 'current', 'first', or null for another PDF.
 * Like the commercial form's, by most of the form's own field names being there.
 * @param {Record<string, string | boolean>} raw
 * @returns {'current' | 'first' | null}
 */
export function formVersion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (share(raw, FIELDS) >= 0.6) return 'current';
  if (share(raw, OLD_NAMES) >= 0.6) return 'first';
  return null;
}

/**
 * The field map with the answers under the names read.js reads (OLD_FIELDS for the first version).
 * @param {Record<string, string | boolean>} raw
 * @returns {{ version: 'current' | 'first' | null, fields: Record<string, string | boolean> }}
 */
export function fieldsOf(raw) {
  const version = formVersion(raw);
  if (version !== 'first') return { version, fields: raw };
  return { version, fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [OLD_FIELDS[k] ?? k, v])) };
}
