// Every field in the client record: where it lives, what to call it, and what kind of value it is.
// Kinds: text, int, money, date, bool, state, phone, choice, textarea. A choice lists the intake
// form's own dropdown options (the TNI intake PDF, 2026-10), so client details offer the same list.

const LIMITS = ['$25K/$50K', '$50K/$100K', '$100K/$300K', '$250K/$500K', '$500K/$1M', '$1M CSL', 'Other'];
const OWNERSHIP = ['Owned', 'Leased', 'Financed', 'Rented'];

export const SECTIONS = [
  { id: 'applicant', title: 'Business', fields: [
    ['applicant.name', 'Company name'],
    ['applicant.dot', 'USDOT #'],
    ['applicant.mc', 'MC #'],
    ['applicant.mcDotWithin60Days', 'No DOT/MC: will have in 60 days', 'bool'],
    ['applicant.fein', 'FEIN'],
    ['applicant.yearEstablished', 'Year established', 'int'],
    ['applicant.yearsInBusiness', 'Years in business', 'int'],
    ['applicant.phone', 'Phone', 'phone'],
    ['applicant.email', 'Email'],
    ['applicant.owner1', 'Owner'],
    ['applicant.owner2', 'Owner 2'],
    ['applicant.ownerDrives', 'Owner drives', 'bool'],
    ['applicant.yearsExperience', 'Years under own authority', 'int'],
    ['applicant.applicationDate', 'Application date', 'date'],
  ] },
  { id: 'garaging', title: 'Garaging address', fields: [
    ['garaging.street', 'Street'],
    ['garaging.unit', 'Apt / suite'],
    ['garaging.city', 'City'],
    ['garaging.state', 'State', 'state'],
    ['garaging.zip', 'ZIP'],
  ] },
  { id: 'operations', title: 'Operations', fields: [
    ['operations.businessClass', 'Business class', 'choice', ['Expediter', 'Freight Hauler', 'Reefer', 'Auto Hauler', 'Hotshot', 'Hazmat', 'Household Goods Mover', 'Oversize Loads', 'Tanker', 'Boat Hauler', 'Flat Bed/Step Deck', 'Dry Van', 'Other']],
    ['operations.whatHaul', 'What they haul'],
    ['operations.radius', 'Radius (as written)'],
    ['operations.radiusMiles', 'Radius (miles)', 'int'],
    ['operations.vehicleOwnership', 'Vehicle ownership', 'choice', OWNERSHIP],
    ['operations.personalUse', 'Vehicle for personal use', 'bool'],
    ['operations.usesEld', 'Uses ELD', 'bool'],
    ['operations.eldBrand', 'ELD brand'],
    ['operations.needSr22', 'Needs SR-22', 'bool'],
    ['operations.filingsRequired', 'Needs federal/state filings', 'bool'],
    ['operations.filingsWhich', 'Which filings'],
    ['operations.hazmat', 'Hazmat / tobacco / Rx', 'bool'],
    ['operations.hazPlacard', 'Hazmat placard', 'bool'],
    ['operations.movingState', 'Moving states within 6 months', 'bool'],
    ['operations.teamDriving', 'Team driving / slip seating', 'bool'],
    ['operations.canadaLoads', 'Takes loads to Canada', 'bool'],
    ['operations.licensePlate', 'License plate'],
    ['operations.equipVehicle', 'Attached equipment value (vehicle)', 'money'],
  ] },
  { id: 'drivers', title: 'Drivers', list: 'drivers', item: 'Driver', fields: [
    ['drivers[].first', 'First name'],
    ['drivers[].middle', 'Middle name'],
    ['drivers[].last', 'Last name'],
    // Read off the end of a name box ("SAMPLE, JR"). GEICO's Add Driver form has a Suffix list
    // for it; Progressive's and AmWINS' driver pages have no box for it.
    ['drivers[].suffix', 'Suffix (Jr, Sr, II…)'],
    ['drivers[].dob', 'Date of birth', 'date'],
    ['drivers[].licenseNumber', 'License #'],
    ['drivers[].licenseState', 'License state', 'state'],
    ['drivers[].cdl', 'CDL', 'bool'],
    ['drivers[].cdlYear', 'CDL year', 'int'],
    ['drivers[].maritalStatus', 'Marital status', 'choice', ['Married', 'Single']],
    // Not on the intake PDF (NOT_ON_INTAKE): the agent sets it (MALE / FEMALE) in client details or
    // by accepting an AI suggestion; normalizeIntake leaves it null.
    ['drivers[].gender', 'Gender', 'choice', ['MALE', 'FEMALE']],
    // "Excluded" written in the license-number box: the client wants this driver excluded.
    // Progressive's exclude question is Yes; AmWINS has none and gets "(Excluded)" after the license
    // number (TNI 2026-10-20). GEICO's Add Driver form asks nothing about it: filled, with a warning.
    ['drivers[].excluded', 'Excluded driver', 'bool'],
  ] },
  { id: 'vehicles', title: 'Vehicles', list: 'vehicles', item: 'Vehicle', fields: [
    ['vehicles[].type', 'Type', 'choice', ['Van', 'Box Truck', 'Reefer Truck', 'Semi Truck', 'Pickup Truck', 'Flatbed', 'Tanker', 'Dump Truck', 'Other']],
    ['vehicles[].year', 'Year', 'int'],
    ['vehicles[].make', 'Make'],
    ['vehicles[].model', 'Model'],
    ['vehicles[].vin', 'VIN'],
    ['vehicles[].value', 'Value ($)', 'money'],
  ] },
  { id: 'trailers', title: 'Trailers', list: 'trailers', item: 'Trailer', fields: [
    ['trailers[].type', 'Type', 'choice', ['Flatbed', 'Enclosed', 'Reefer', 'Tanker', 'Lowboy', 'Step Deck', 'Dry Van', 'Other']],
    ['trailers[].year', 'Year', 'int'],
    ['trailers[].make', 'Make'],
    ['trailers[].model', 'Model'],
    ['trailers[].vin', 'VIN'],
    ['trailers[].value', 'Value ($)', 'money'],
  ] },
  { id: 'trailerInfo', title: 'Trailer details', fields: [
    ['trailerInfo.ownership', 'Trailer ownership', 'choice', OWNERSHIP],
    ['trailerInfo.hitch', 'Hitch type', 'choice', ['Gooseneck', '5th Wheel', 'Bumper Pull', 'Pintle', 'Other']],
    ['trailerInfo.interchange', 'Trailer interchange needed', 'bool'],
    ['trailerInfo.interchangeLimit', 'Interchange limit'],
    ['trailerInfo.equipTrailer', 'Attached equipment value (trailer)', 'money'],
  ] },
  { id: 'priorInsurance', title: 'Current insurance', list: 'priorInsurance', item: 'Policy', fields: [
    ['priorInsurance[].type', 'Policy type', 'choice', ['Commercial Auto', 'Personal Auto', 'General Liability', 'Cargo', 'Other']],
    ['priorInsurance[].carrier', 'Carrier'],
    ['priorInsurance[].limit', 'Liability limit', 'choice', LIMITS],
    ['priorInsurance[].expiration', 'Expiration', 'date'],
  ] },
  { id: 'coverage', title: 'Requested coverage', fields: [
    ['coverage.autoLiability', 'Auto liability', 'choice', ['Yes', 'No', 'Non-Trucking']],
    ['coverage.autoLiabLimit', 'Auto liability limit', 'choice', LIMITS],
    ['coverage.cargo', 'Cargo', 'bool'],
    ['coverage.cargoLimit', 'Cargo limit', 'money'],
    ['coverage.cargoDeductible', 'Cargo deductible', 'money'],
    ['coverage.gl', 'General liability', 'bool'],
    ['coverage.hasGl', 'Already has general liability (claims box)', 'bool'],
    ['coverage.glLimit', 'GL limit', 'choice', ['$1M/$2M', '$500K/$1M', '$300K/$600K', 'Other']],
    ['coverage.reeferBreakdown', 'Reefer breakdown', 'bool'],
    ['coverage.ntl', 'Non-trucking liability (NTL)', 'bool'],
  ] },
  { id: 'claims', title: 'Claims (last 36 months)', fields: [
    ['claims.hasClaims', 'Any claims / violations', 'bool'],
    ['claims.text', 'Claims box, as written', 'textarea'],
    ['claims.notes', 'Notes (other answers in the claims box)', 'textarea'],
  ] },
  // The Additional Notes box, on the intake form since 2026-10 (empty on older intakes).
  { id: 'notes', title: 'Additional notes', fields: [
    ['notes.text', 'Additional notes, as written', 'textarea'],
  ] },
];

// Fields the intake PDF has no box for: never read by normalizeIntake (null until the agent sets
// one), so no place on the form (intake-source.js sourceFields gives []).
export const NOT_ON_INTAKE = new Set(['drivers[].gender']);

const FIELDS = new Map(
  SECTIONS.flatMap((s) => s.fields.map(([path, label, kind = 'text', options]) => [path, { path, label, kind, section: s, ...(options ? { options } : {}) }])),
);

// Accepts "drivers[0].first" or "drivers[].first".
export function fieldInfo(path) {
  return FIELDS.get(path.replace(/\[\d+\]/, '[]')) ?? { path, label: path, kind: 'text' };
}
