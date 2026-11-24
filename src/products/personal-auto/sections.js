// @ts-check
// Every field of the personal-auto client record: where it lives, what to call it, what kind of
// value it is (kinds as the commercial record's: text, int, money, date, bool, state, phone, choice,
// textarea). A choice lists the intake form's own dropdown options, so client details offer the same.

const STATE = 'state';
const MILES = ['2,000', '4,000', '6,000', '8,000', '10,000', '12,000', '14,000', '16,000', '18,000', '20,000', '22,000', '24,000', '26,000', '28,000', '30,000', '35,000', '40,000', '45,000', '50,000', '50,000+'];

/** @type {{ id: string, title: string, list?: string, item?: string, fields: any[][] }[]} */
export const SECTIONS = [
  { id: 'applicant', title: 'Named insured', fields: [
    ['applicant.name', 'Named insured'],
    ['applicant.phone', 'Phone', 'phone'],
    ['applicant.email', 'Email'],
    ['applicant.applicationDate', 'Application date', 'date'],
  ] },
  { id: 'garaging', title: 'Garaging address', fields: [
    ['garaging.street', 'Street'],
    ['garaging.unit', 'Apt / suite'],
    ['garaging.city', 'City'],
    ['garaging.state', 'State', STATE],
    ['garaging.zip', 'ZIP'],
  ] },
  { id: 'residence', title: 'Residence', fields: [
    ['residence.timeAtAddress', 'Time at this address'],
    ['residence.priorAddress', 'Prior address (under 2 months here)'],
    ['residence.ownership', 'Own or rent the home', 'choice', ['Own', 'Rent']],
  ] },
  { id: 'drivers', title: 'Drivers in household', list: 'drivers', item: 'Driver', fields: [
    ['drivers[].first', 'First name'],
    ['drivers[].middle', 'Middle name'],
    ['drivers[].last', 'Last name'],
    ['drivers[].suffix', 'Suffix (Jr, Sr, II…)'],
    ['drivers[].dob', 'Date of birth', 'date'],
    ['drivers[].gender', 'Gender', 'choice', ['Male', 'Female', 'Other']],
    ['drivers[].maritalStatus', 'Marital status', 'choice', ['Single', 'Married', 'Separated', 'Widowed', 'Divorced']],
    ['drivers[].relation', 'Relation to insured', 'choice', ['Insured', 'Spouse', 'Child', 'Parent', 'Other']],
    ['drivers[].licenseNumber', 'License #'],
    ['drivers[].licenseState', 'License state', STATE],
    ['drivers[].yearLicensed', 'Year licensed', 'int'],
    ['drivers[].occupation', 'Occupation'],
    ['drivers[].education', 'Highest education', 'choice', ['No high school diploma or GED', 'High school diploma or GED', 'Some College', 'Currently in College',
      "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'PHD']],
    ['drivers[].matureCourse', 'Mature driving course', 'bool'],
    ['drivers[].goodStudent', 'Good student', 'bool'],
    ['drivers[].distantStudent', 'Distant student', 'bool'],
  ] },
  { id: 'vehicles', title: 'Vehicles', list: 'vehicles', item: 'Vehicle', fields: [
    ['vehicles[].year', 'Year', 'int'],
    ['vehicles[].make', 'Make'],
    ['vehicles[].model', 'Model'],
    ['vehicles[].vin', 'VIN'],
    ['vehicles[].use', 'Use', 'choice', ['Pleasure/Personal', 'Commute to/from work or school', 'Business', 'Other']],
    ['vehicles[].ownership', 'Ownership', 'choice', ['Owned', 'Financed', 'Leased']],
    ['vehicles[].value', 'Value ($)', 'money'],
    ['vehicles[].ownedFor', 'Owned for', 'choice', ['Less than 6 months', '6 months - 1 year', '1 year - 3 years', '3+ years']],
    ['vehicles[].annualMiles', 'Annual mileage', 'choice', MILES],
    ['vehicles[].commuteMiles', 'One-way commute miles'],
    ['vehicles[].commuteDays', 'Commute days a week', 'int'],
    ['vehicles[].damage', 'Existing damage', 'bool'],
    ['vehicles[].fullCoverage', 'Full coverage', 'bool'],
    ['vehicles[].lienholder.name', 'Lienholder'],
    ['vehicles[].lienholder.street', 'Lienholder street'],
    ['vehicles[].lienholder.city', 'Lienholder city'],
    ['vehicles[].lienholder.state', 'Lienholder state', STATE],
    ['vehicles[].lienholder.zip', 'Lienholder ZIP'],
  ] },
  { id: 'priorInsurance', title: 'Current insurance', list: 'priorInsurance', item: 'Policy', fields: [
    ['priorInsurance[].currentlyInsured', 'Currently insured', 'bool'],
    ['priorInsurance[].carrier', 'Carrier'],
    ['priorInsurance[].limit', 'Bodily injury limits', 'choice', ['State Minimum or less', '$25k/$50k', '$50k/$100k', '$100k CSL', '$100k/$300k', '$300k CSL', '$350k CSL',
      '$250k/$500k', '$500k CSL', '$750k CSL', '$1,000,000 CSL']],
    ['priorInsurance[].insuredFor', 'Insured with them for'],
    ['priorInsurance[].expiration', 'Expiration', 'date'],
  ] },
  { id: 'coverage', title: 'Requested coverage', fields: [
    ['coverage.liabilityLimit', 'Liability limit', 'choice', ['None', 'State Minimum or less', '25/50/25', '50/100/50', '100/300/50', '100/300/100', '250/500/100', '100 CSL', '300 CSL', '500 CSL']],
    ['coverage.compDeductible', 'Comprehensive deductible', 'choice', ['No Coverage', '$100', '$250', '$500', '$750', '$1,000', '$2,000', '$100 w/$50 Glass',
      '$250 w/$50 Glass', '$500 w/$50 Glass', '$1,000 w/$50 Glass', '$2,000 w/$50 Glass']],
    ['coverage.collDeductible', 'Collision deductible', 'choice', ['No Coverage', '$100', '$250', '$500', '$750', '$1,000', '$2,000']],
  ] },
  { id: 'notes', title: 'Additional notes', fields: [
    ['notes.text', 'Additional notes, as written', 'textarea'],
  ] },
];

/** @type {Map<string, { path: string, label: string, kind: string, options?: string[], section: object }>} */
const FIELDS = new Map(
  SECTIONS.flatMap((s) => s.fields.map(([path, label, kind = 'text', options]) => [path, { path, label, kind, section: s, ...(options ? { options } : {}) }])),
);

/**
 * A field of the record by its path ("drivers[0].first" or "drivers[].first").
 * @param {string} path
 */
export function fieldInfo(path) {
  return FIELDS.get(path.replace(/\[\d+\]/, '[]')) ?? { path, label: path, kind: 'text' };
}
