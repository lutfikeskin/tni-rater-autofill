// Every field in the client record: where it lives, what to call it, and what kind of value it is.
// Kinds: text, int, money, date, bool, state, phone, choice, textarea.

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
    ['operations.businessClass', 'Business class', 'choice'],
    ['operations.whatHaul', 'What they haul'],
    ['operations.radius', 'Radius (as written)'],
    ['operations.radiusMiles', 'Radius (miles)', 'int'],
    ['operations.vehicleOwnership', 'Vehicle ownership', 'choice'],
    ['operations.personalUse', 'Vehicle for personal use', 'bool'],
    ['operations.usesEld', 'Uses ELD', 'bool'],
    ['operations.eldBrand', 'ELD brand'],
    ['operations.needSr22', 'Needs SR-22', 'bool'],
    ['operations.filingsRequired', 'Needs federal/state filings', 'bool'],
    ['operations.filingsWhich', 'Which filings'],
    ['operations.hazmat', 'Hazmat / tobacco / Rx', 'bool'],
    ['operations.hazPlacard', 'Hazmat placard', 'bool'],
    ['operations.movingState', 'Moving states within 6 months', 'bool'],
    ['operations.licensePlate', 'License plate'],
    ['operations.equipVehicle', 'Attached equipment value (vehicle)', 'money'],
  ] },
  { id: 'drivers', title: 'Drivers', list: 'drivers', item: 'Driver', fields: [
    ['drivers[].first', 'First name'],
    ['drivers[].middle', 'Middle name'],
    ['drivers[].last', 'Last name'],
    ['drivers[].dob', 'Date of birth', 'date'],
    ['drivers[].licenseNumber', 'License #'],
    ['drivers[].licenseState', 'License state', 'state'],
    ['drivers[].cdl', 'CDL', 'bool'],
    ['drivers[].cdlYear', 'CDL year', 'int'],
    ['drivers[].maritalStatus', 'Marital status', 'choice'],
    // Not on the intake PDF (NOT_ON_INTAKE): the agent sets it (MALE / FEMALE) in client details or
    // by accepting an AI suggestion; normalizeIntake leaves it null.
    ['drivers[].gender', 'Gender', 'choice'],
  ] },
  { id: 'vehicles', title: 'Vehicles', list: 'vehicles', item: 'Vehicle', fields: [
    ['vehicles[].type', 'Type', 'choice'],
    ['vehicles[].year', 'Year', 'int'],
    ['vehicles[].make', 'Make'],
    ['vehicles[].model', 'Model'],
    ['vehicles[].vin', 'VIN'],
    ['vehicles[].value', 'Value ($)', 'money'],
  ] },
  { id: 'trailers', title: 'Trailers', list: 'trailers', item: 'Trailer', fields: [
    ['trailers[].type', 'Type', 'choice'],
    ['trailers[].year', 'Year', 'int'],
    ['trailers[].make', 'Make'],
    ['trailers[].model', 'Model'],
    ['trailers[].vin', 'VIN'],
    ['trailers[].value', 'Value ($)', 'money'],
  ] },
  { id: 'trailerInfo', title: 'Trailer details', fields: [
    ['trailerInfo.ownership', 'Trailer ownership', 'choice'],
    ['trailerInfo.hitch', 'Hitch type', 'choice'],
    ['trailerInfo.interchange', 'Trailer interchange needed', 'bool'],
    ['trailerInfo.interchangeLimit', 'Interchange limit'],
    ['trailerInfo.equipTrailer', 'Attached equipment value (trailer)', 'money'],
  ] },
  { id: 'priorInsurance', title: 'Current insurance', list: 'priorInsurance', item: 'Policy', fields: [
    ['priorInsurance[].type', 'Policy type', 'choice'],
    ['priorInsurance[].carrier', 'Carrier'],
    ['priorInsurance[].limit', 'Liability limit', 'choice'],
    ['priorInsurance[].expiration', 'Expiration', 'date'],
  ] },
  { id: 'coverage', title: 'Requested coverage', fields: [
    ['coverage.autoLiability', 'Auto liability', 'choice'],
    ['coverage.autoLiabLimit', 'Auto liability limit', 'choice'],
    ['coverage.cargo', 'Cargo', 'bool'],
    ['coverage.cargoLimit', 'Cargo limit', 'money'],
    ['coverage.cargoDeductible', 'Cargo deductible', 'money'],
    ['coverage.gl', 'General liability', 'bool'],
    ['coverage.hasGl', 'Already has general liability (claims box)', 'bool'],
    ['coverage.glLimit', 'GL limit', 'choice'],
    ['coverage.reeferBreakdown', 'Reefer breakdown', 'bool'],
    ['coverage.ntl', 'Non-trucking liability (NTL)', 'bool'],
  ] },
  { id: 'claims', title: 'Claims (last 36 months)', fields: [
    ['claims.hasClaims', 'Any claims / violations', 'bool'],
    ['claims.text', 'Claims box, as written', 'textarea'],
    ['claims.notes', 'Notes (other answers in the claims box)', 'textarea'],
  ] },
];

// Fields the intake PDF has no box for: never read by normalizeIntake (null until the agent sets
// one), so no place on the form (intake-source.js sourceFields gives []).
export const NOT_ON_INTAKE = new Set(['drivers[].gender']);

const FIELDS = new Map(
  SECTIONS.flatMap((s) => s.fields.map(([path, label, kind = 'text']) => [path, { path, label, kind, section: s }])),
);

// Accepts "drivers[0].first" or "drivers[].first".
export function fieldInfo(path) {
  return FIELDS.get(path.replace(/\[\d+\]/, '[]')) ?? { path, label: path, kind: 'text' };
}
