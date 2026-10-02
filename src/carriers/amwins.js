// AmWINS Admitted Placement, Commercial Lines Business Auto
// (myagency.amwinsadmittedplacement.com/application/businessauto).
//
// A single-page application: one address for the whole application, with steps (Insured Info,
// Drivers, Vehicles, Coverages, underwriting questions) shown one at a time. Fields have stable
// element ids (#ownerDob, #mailingZip, #entityType …), so rules target them by selector; radio
// groups and unlabelled fields are matched by their name read as words ("is non profit").
// Mapped from the first recorded quote (2026-10-02): the answers below are the agent's own on
// that quote. The generic label rules still cover the rest (driver details and the like).
//
// Second quote (2026-10-02): the agent's notes became the rules below (years under own authority,
// class code search, description, NO PRIOR, gender, license year, VIN import, coverages, the
// underwriting questions all No except "other topics", and the disclosure text). The quote stops
// at the declaration: Save & Continue, Save & Exit and Submit stay the agent's.

import { owner } from './progressive.js';

const street = (r) => [r.garaging?.street, r.garaging?.unit].filter(Boolean).join(' ') || null;
const digits = (v) => (v ? String(v).replace(/\D/g, '') || null : null);

// Entity type from the business name, as on Progressive: LLC / Inc / Corp, otherwise a sole
// proprietor. Partnerships are never guessed.
const entityType = (r) => {
  const name = r.applicant.name ?? '';
  if (/\b(llc|l\.l\.c)\.?$/i.test(name)) return 'LLC';
  if (/\b(inc|corp|corporation|incorporated|co)\.?$/i.test(name)) return 'CORPORATION';
  return 'SOLE PROPRIETOR';
};

// Owner's full name from their driver row when found (the owner box sometimes has only the first
// name); a lone middle initial is left out.
const ownerFull = (r) => {
  const o = owner(r);
  const first = o.driver?.first ? o.driver.first.replace(/\s+[A-Za-z]\.?$/, '') : o.first;
  const name = [first, o.last].filter(Boolean).join(' ');
  return name || r.applicant.owner1 || null;
};

// Years in business: the intake's years in business, else its years under own authority.
const yearsInBusiness = (r) => {
  const n = r.applicant.yearsInBusiness ?? r.applicant.yearsExperience;
  if (n == null) return null;
  return n < 1 ? 'New Venture' : n >= 5 ? '5+' : String(n);
};
// Year established left blank on the intake means this year (TNI).
const yearEstablished = (r) => r.applicant.yearEstablished ?? new Date().getFullYear();

// Expediters and general freight haulers are 484122 (general freight trucking, long-distance,
// LTL); anything else is searched as the intake writes it, and only a single clear match is
// taken. The description follows the same split.
const isFreight = (r) => /expedit|general\s*freight/i.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);
const classSearch = (r) => (isFreight(r) ? '484122' : r.operations.businessClass ?? null);
const operationsDescription = (r) => (isFreight(r) ? 'Trucking for Hire - Other for hire trucking' : r.operations.businessClass ?? null);

const moneyK = (n) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}K` : `$${n}`);
// "Any other topics to disclose" text, from the intake, one line per item:
//   Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods
//   More than 500 miles radius of operation
//   POP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026
const disclosure = (r) => {
  const c = r.coverage;
  const lines = [];
  if (c.cargo && c.cargoLimit) {
    const goods = /general\s*freight/i.test(r.operations.whatHaul ?? '') ? 'Consumer Goods / Other Consumer Goods' : r.operations.whatHaul;
    lines.push(`Motor Truck Cargo ${moneyK(c.cargoLimit)} with ${moneyK(c.cargoDeductible ?? 1000)} Ded${goods ? ` - ${goods}` : ''}`);
  }
  const miles = radius(r);
  if (miles) lines.push(miles > 500 ? 'More than 500 miles radius of operation' : `${miles} miles radius of operation`);
  const p = r.priorInsurance?.[0];
  if (p?.carrier) {
    const kind = /commercial/i.test(p.type ?? '') ? 'Commercial' : /personal/i.test(p.type ?? '') ? 'Personal' : p.type;
    const carrier = p.carrier.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
    lines.push(['POP', kind].filter(Boolean).join(' ') + ` - ${carrier}${p.limit ? ` - ${p.limit}` : ''}${p.expiration ? ` - Exp Date ${p.expiration}` : ''}`);
  }
  return lines.join('\n') || null;
};

// Body type as on the intake: a Van is a Cargo Van.
const bodyType = (r, a) => {
  const t = r.vehicles?.[a.vehicles ?? 0]?.type ?? null;
  return t && /^van$/i.test(t.trim()) ? 'Cargo Van' : t;
};
const licenseYear = (r, a) => {
  const dob = r.drivers?.[a.drivers ?? 0]?.dob;
  const y = dob ? Number(String(dob).slice(-4)) : NaN;
  return Number.isFinite(y) ? String(y + 17) : null;
};

// Underwriting questions TNI answers No (both sections), by the field names AmWINS uses.
const UNDERWRITING_NO = [
  'subsidiary to other', 'subsidiary', 'safety info', 'hazard exposure', 'other insurance', 'coverage denial',
  'past criminal activity', 'criminal activity in past ?5 ?years', 'code vo?i?olation', 'finacial default', 'financial default',
  'finacial judgement', 'financial judgement', 'trust', 'foreign operations', 'other venture', 'own drones',
  'hire other to operate drones', 'use their auto', 'vehicle maintenance program', 'vehicle used by family',
  'recruiting method', 'covered by wc', 'convictions moving violations',
];

const filings = (r) => (r.operations.filingsRequired === true ? true : r.operations.filingsRequired === false ? false : null);
const noFilingCounts = (r) => filings(r) !== true || (!r.applicant.dot && !r.applicant.mc);

// Radius bands: "< 50 MILES", "51 - 100 MILES", "101- 200 MILES", "201 + MILES". Unlimited / long
// haul is the top band.
const radius = (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null);

const vehicleValueNote = (r, a) => {
  const v = r.vehicles?.[a.vehicles ?? 0]?.value;
  return v != null && typeof v !== 'number' ? `The intake's vehicle value "${v}" isn't a dollar amount: enter it yourself.` : null;
};

export const amwins = {
  id: 'amwins',
  name: 'AmWINS',
  hosts: [/(^|\.)amwinsadmittedplacement\.com$/],
  // Import Data right after the VIN list is filled, before the vehicle boxes, which it fills.
  actions: [
    { id: 'importVins', text: '^import data$', after: ['amwins.vinList'], immediate: true },
  ],
  rules: [
    // --- Start (/commerciallines) --------------------------------------------------------------
    { name: 'Risk state', label: 'select a risk state', path: 'garaging.state' },

    // --- Insured Info --------------------------------------------------------------------------
    // The agency's own details, effective dates and inspection contacts are left as the page has them.
    ...['#agnecyName', '#contactName', '#phone', '#email', '#website', '#effectiveDate', '#expirationDate', '#dba',
      '#inspectionContactName', '#inspectionContactEmail', '#inspectionContactOfficePhone', '#inspectionContactMobilePhone']
      .map((selector) => ({ selector, name: `Left as the page has it (${selector.slice(1)})`, ignore: true })),
    { selector: '#name', name: 'Named insured (company, else the owner)', value: (r) => r.applicant.name || ownerFull(r) },
    { selector: '#ownerName', name: 'Owner full name', value: ownerFull },
    { selector: '#ownerDob', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    { selector: '#mailingAddress', name: 'Mailing street', value: street },
    { selector: '#mailingCity', path: 'garaging.city' },
    { selector: '#mailingState', path: 'garaging.state' },
    { selector: '#mailingZip', path: 'garaging.zip' },
    { selector: '#businessPhone', name: 'Business phone', value: (r) => digits(r.applicant.phone) },
    { selector: '#entityType', name: 'Entity type', kind: 'choice', value: entityType },
    { selector: '#yrsInBusiness', name: 'Years in business', kind: 'choice', value: yearsInBusiness },
    { selector: '#yearBusinessEstablished', name: 'Year established', value: yearEstablished },
    { name: 'Non-profit (standard: No)', label: '^is non profit$', kind: 'bool', value: () => false },
    { name: 'Single contact (standard: Yes)', label: '^is single contact$', kind: 'bool', value: () => true },
    { name: 'Garage address same as mailing (standard)', label: '^same as mailing address', kind: 'bool', value: () => true },
    { selector: '#natureOfBusiness', name: 'Nature of business', kind: 'choice', value: () => 'TRANSPORTATION' },
    { selector: '#retailOrServiceOperationPert', name: 'Retail / service operations % (trucking: 0)', value: () => '0' },
    { selector: '#classCodeAndDescription', name: 'Classification (484122 for expediters / general freight)', kind: 'search-select', search: classSearch, value: classSearch },
    { selector: '#operationDescription', name: 'Description of operations', value: operationsDescription },
    { name: 'Additional interest (standard: No)', label: '^has additional interest$', kind: 'bool', value: () => false },
    { selector: '#waiverType', name: 'Waiver type (standard: NONE)', kind: 'choice', value: () => 'NONE' },
    // Filing counts only matter with filings and a DOT/MC number.
    ...['#stateFillings', '#stateCargoFillings', '#otherFillings'].map((selector) => ({ selector, name: 'Filing count', ignore: noFilingCounts })),
    { name: 'Prior carrier (standard: NO PRIOR)', withOption: 'NO PRIOR', kind: 'choice', value: () => 'NO PRIOR' },
    { name: 'Filings required', label: '^filling required$', kind: 'bool', value: filings },
    { selector: '#hasDotNumber', name: 'Has a DOT number', kind: 'bool', value: (r) => !!r.applicant.dot },
    { selector: '#hasMcNumber', name: 'Has an MC number', kind: 'bool', value: (r) => !!r.applicant.mc },
    { selector: '#noNumber', name: 'No DOT / MC number', kind: 'bool', value: (r) => !r.applicant.dot && !r.applicant.mc },
    { name: 'Valued loss runs (standard: No)', label: '^valued loss runs$', kind: 'bool', value: () => false },
    { name: 'Any prior loss', label: '^any prior loss$', kind: 'bool', path: 'claims.hasClaims' },

    // --- Drivers ---------------------------------------------------------------------------------
    { name: 'Gender (standard: MALE)', label: '^gender$', kind: 'choice', value: () => 'MALE' },
    { name: 'Year licensed (birth year + 17)', label: 'year (first )?licen[cs]ed|licen[cs]e(d)? (issue(d)? )?year|year licen[cs]e issued|licensed since', value: licenseYear },
    { name: 'Middle name (only when the intake has one)', label: '^middle name$', path: 'drivers[].middle', ignore: (r, a) => !r.drivers?.[a.drivers ?? 0]?.middle },

    // --- Vehicles --------------------------------------------------------------------------------
    { name: 'File upload (not used)', label: '^select file', ignore: true },
    { selector: '#vehLookupVin', path: 'amwins.vinList', name: 'VINs to look up (one per line)', value: (r) => r.vehicles.map((v) => v.vin).filter(Boolean).join('\n') || null },
    { name: 'Body type (as on the intake)', label: '^body type$', value: bodyType },
    { name: 'Vehicle location (the first, the insured)', label: '^location$', kind: 'first-option', value: () => 'first option' },
    { selector: '#marketValue', path: 'vehicles[].value', name: 'Vehicle value', note: vehicleValueNote },
    { name: 'Usage type (standard: For hire)', label: '^usage type$', kind: 'choice', value: () => 'FOR HIRE' },
    { name: 'Radius', label: '^radius$', kind: 'int', value: radius },
    { name: 'Permanently attached equipment (standard: No)', label: '^permanently attached equipment', kind: 'bool', value: () => false },

    // --- Coverages -------------------------------------------------------------------------------
    { name: 'CSL liability limit', label: '^csl liability limit$', path: 'coverage.autoLiabLimit' },
    { name: 'Uninsured motorists (standard: Yes)', label: '^uninsured motorists$', kind: 'bool', value: () => true },
    { name: 'Rental reimbursement (standard: $40/day, $1,200)', label: 'transportation expense|rental reimbursement', kind: 'choice', value: () => '$40 day / $1,200 total' },
    { selector: '#uninsuredMotoristsLimit', name: 'UM limit (standard: $100K)', kind: 'choice', value: () => '$100K' },
    { selector: '#medicalPayment', name: 'Medical payments (standard: $5,000)', kind: 'choice', value: () => '$5,000' },
    { selector: '#comprehensiveDeductible', name: 'Comprehensive deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000' },
    { selector: '#collisionDeductible', name: 'Collision deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000' },
    { name: 'Waiver of collision (standard: No)', label: '^has waiver of collision$', kind: 'bool', value: () => false },
    { selector: '#towingAndLaborReimbursement', name: 'Towing and labor (standard: $75)', kind: 'choice', value: () => '$75' },
    // Liability auto symbol: 6 only.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ selector: `#autoSymbol${n}`, name: `Auto symbol ${n}${n === 6 ? ' (TNI: 6)' : ''}`, kind: 'bool', value: () => n === 6 })),
    // Nothing is excluded (the page spells it Exclude / Exlucde / Exlude).
    { name: 'Exclusions (standard: none)', label: '^ex\\w*de\\b', kind: 'bool', value: () => false },

    // --- Underwriting questions --------------------------------------------------------------------
    { name: 'Vehicles not owned (standard: No)', label: '^any vehicle not owned$', kind: 'bool', value: () => false },
    { name: 'Vehicles leased', label: '^vehicle leased$', kind: 'bool', value: (r) => /leas/i.test(r.operations.vehicleOwnership ?? '') },
    { name: 'MVR verification (agent answer: No)', label: '^mvr verification$', kind: 'bool', value: () => false },
    { name: 'Owned unscheduled vehicles (standard: No)', label: '^owned unscheduled vehicle$', kind: 'bool', value: () => false },
    { name: 'Hazardous material', label: '^transporting hazardous material$', kind: 'bool', path: 'operations.hazmat' },
    ...UNDERWRITING_NO.map((q) => ({ name: `Underwriting: ${q.replace(/[?\\]/g, '')} (standard: No)`, label: `^${q}$`, kind: 'bool', value: () => false })),
    { name: 'Other topics to disclose (standard: Yes)', label: '^other topic$', kind: 'bool', value: () => true },
    { name: 'Disclosure details (from the intake)', label: '^disclosure details$', value: disclosure },
    // The declaration is the agent's to make.
    { name: 'Declaration', label: 'i declare|true,? complete', note: 'The declaration is yours to confirm; never filled.' },
  ],
};
