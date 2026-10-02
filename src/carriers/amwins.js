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
// Not automated yet: the class code search box (a type-ahead widget), the VIN import buttons,
// and Save & Continue (moving on stays the agent's).

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

const yearsInBusiness = (r) => {
  const n = r.applicant.yearsInBusiness;
  if (n == null) return null;
  return n < 1 ? 'New Venture' : n >= 5 ? '5+' : String(n);
};
const yearEstablished = (r) => r.applicant.yearEstablished
  ?? (r.applicant.yearsInBusiness != null ? new Date().getFullYear() - r.applicant.yearsInBusiness : null);

const filings = (r) => (r.operations.filingsRequired === true ? true : r.operations.filingsRequired === false ? false : null);

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
  rules: [
    // --- Start (/commerciallines) --------------------------------------------------------------
    { name: 'Risk state', label: 'select a risk state', path: 'garaging.state' },

    // --- Insured Info --------------------------------------------------------------------------
    // The agency's own details, effective dates and inspection contacts are left as the page has them.
    ...['#agnecyName', '#contactName', '#phone', '#email', '#website', '#effectiveDate', '#expirationDate', '#dba',
      '#inspectionContactName', '#inspectionContactEmail', '#inspectionContactOfficePhone', '#inspectionContactMobilePhone']
      .map((selector) => ({ selector, name: `Left as the page has it (${selector.slice(1)})`, ignore: true })),
    { selector: '#name', name: 'Named insured', value: (r) => r.applicant.name || r.applicant.owner1 || null },
    { selector: '#ownerName', name: 'Owner name', value: (r) => r.applicant.owner1 ?? null },
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
    { name: 'Filings required', label: '^filling required$', kind: 'bool', value: filings },
    { selector: '#hasDotNumber', name: 'Has a DOT number', kind: 'bool', value: (r) => !!r.applicant.dot },
    { selector: '#hasMcNumber', name: 'Has an MC number', kind: 'bool', value: (r) => !!r.applicant.mc },
    { selector: '#noNumber', name: 'No DOT / MC number', kind: 'bool', value: (r) => !r.applicant.dot && !r.applicant.mc },
    { name: 'Valued loss runs (standard: No)', label: '^valued loss runs$', kind: 'bool', value: () => false },
    { name: 'Any prior loss', label: '^any prior loss$', kind: 'bool', path: 'claims.hasClaims' },

    // --- Vehicles --------------------------------------------------------------------------------
    { selector: '#vehLookupVin', name: 'VINs to look up (one per line)', value: (r) => r.vehicles.map((v) => v.vin).filter(Boolean).join('\n') || null },
    { name: 'Vehicle location (the first, the insured)', label: '^location$', kind: 'first-option', value: () => 'first option' },
    { selector: '#marketValue', path: 'vehicles[].value', name: 'Vehicle value', note: vehicleValueNote },
    { name: 'Usage type (standard: For hire)', label: '^usage type$', kind: 'choice', value: () => 'FOR HIRE' },
    { name: 'Radius', label: '^radius$', kind: 'int', value: radius },
    { name: 'Permanently attached equipment (standard: No)', label: '^permanently attached equipment', kind: 'bool', value: () => false },

    // --- Coverages -------------------------------------------------------------------------------
    { name: 'CSL liability limit', label: '^csl liability limit$', path: 'coverage.autoLiabLimit' },
    { name: 'Uninsured motorists (standard: Yes)', label: '^uninsured motorists$', kind: 'bool', value: () => true },
    { name: 'Rental reimbursement (standard: $40/day, $1,200)', label: 'transportation expense|rental reimbursement', kind: 'choice', value: () => '$40 day / $1,200 total' },

    // --- Underwriting questions --------------------------------------------------------------------
    { name: 'Vehicles not owned (standard: No)', label: '^any vehicle not owned$', kind: 'bool', value: () => false },
    { name: 'Vehicles leased', label: '^vehicle leased$', kind: 'bool', value: (r) => /leas/i.test(r.operations.vehicleOwnership ?? '') },
    { name: 'MVR verification (agent answer: No)', label: '^mvr verification$', kind: 'bool', value: () => false },
    { name: 'Owned unscheduled vehicles (standard: No)', label: '^owned unscheduled vehicle$', kind: 'bool', value: () => false },
    { name: 'Hazardous material', label: '^transporting hazardous material$', kind: 'bool', path: 'operations.hazmat' },
    // The declaration is the agent's to make.
    { name: 'Declaration', label: 'i declare|true,? complete', note: 'The declaration is yours to confirm; never filled.' },
  ],
};
