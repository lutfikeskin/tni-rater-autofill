// @ts-check
// What each carrier question is about, in TNI's words and for every carrier: its concept. Every
// carrier rule names one (`concept` on src/carriers/<carrier>.js and src/rules.js rules), from this
// catalog, so one concept can be followed across carriers and products: where it is asked, by which
// question, from which rule (`npm run concepts` writes docs/concepts.md, the concept × carrier
// matrix). test/concepts.test.mjs checks that every rule names a concept listed here and that every
// concept listed here is asked somewhere.
//
// A concept is the question's meaning, not its wording or the intake field it reads: Progressive's
// "Business Owner's Name" and GEICO's "Business Owner First Name" are both `owner.name`; a ZIP box
// asked about the owner's home is `owner.home-address` though it reads the garaging ZIP. Its id is
// '<subject>.<name>'; a new concept goes under its subject, with what it means. Nothing at fill time
// reads it.

/** @type {Readonly<Record<string, string>>} */
export const CONCEPTS = Object.freeze({
  // The quote itself and the carrier's workflow (not a client fact)
  'quote.state': 'The state the quote is for (a risk state box).',
  'quote.product': 'Which carrier product the quote is for, or copied to.',
  'quote.navigation': "The carrier's own search and settings boxes on its start pages.",
  'quote.agency': "The agency's and agent's own details (agent code, agency name, agent of record, vendor code, the agent's email).",
  'quote.effective-date': "The policy's start and end dates.",
  'quote.policy-term': "The policy's length.",
  'quote.payment': 'How the customer pays: plan, method, schedule.',
  'quote.print': 'Which quote documents are printed, emailed or faxed.',
  'quote.save': 'The contact details Save Quote asks for.',
  'quote.reports': 'Ordering MVR and CLUE reports (the agent decides).',
  'quote.attachments': 'Files uploaded with the submission.',
  'quote.declaration': "The applicant's declaration before Submit (the agent's).",
  'quote.unit-entry': 'How the next vehicle or trailer is added (by VIN, or which unit next).',
  'quote.all-vehicles': "Whether the quote includes all the customer's commercially owned vehicles.",
  'quote.snapshot-pro': "Progressive's Snapshot Pro enrolment.",

  // The business
  'business.name': 'The business or named insured name.',
  'business.dba': 'A doing-business-as name.',
  'business.structure': 'The legal structure (sole proprietor, LLC, corporation).',
  'business.class': 'The business type or classification the carrier offers (its lists and searches).',
  'business.operations-description': 'A description of operations in words.',
  'business.years': 'Years in business, or the year established.',
  'business.address': 'The business (mailing or garaging) address.',
  'business.contact': "The customer's contact details: phone, email, contact name.",
  'business.usdot': 'Whether the business has a USDOT number, and the number.',
  'business.usdot-new': 'Whether the USDOT number was obtained recently.',
  'business.usdot-record': "What the carrier's USDOT lookup found: the registered name and address, and whether they are the client's.",
  'business.mc': 'The motor carrier (MC) number.',
  'business.ein': 'The federal employer identification number.',
  'business.employees': 'The number of employees.',
  'business.nonprofit': 'Whether the business is a non-profit.',
  'business.retail-percent': 'The share of retail or service operations.',

  // The business owner
  'owner.name': "The owner's name.",
  'owner.dob': "The owner's date of birth.",
  'owner.home-address': "The owner's home address.",
  'owner.marital-status': "The owner's marital status.",
  'owner.ssn': "The owner's Social Security number (never filled).",
  'owner.drives': 'Whether the owner is a driver on the policy.',
  'owner.daily-ops': 'Whether the owner is involved in daily operations.',

  // Operations
  'operations.radius': 'How far the vehicles travel (radius, farthest one-way distance).',
  'operations.personal-use': 'Personal use of the vehicles.',
  'operations.for-hire': 'Hauling for hire, and the kind of trucker.',
  'operations.hazmat': 'Hauling hazardous material.',
  'operations.hazmat-placard': 'A hazardous material placard required.',
  'operations.eld': 'An electronic logging device.',
  'operations.telematics': 'Telematics devices in the vehicles.',
  'operations.dashcams': 'Dashcams in the vehicles.',
  'operations.team-driving': 'Team driving or slip seating.',
  'operations.delivery': 'Package or food delivery, delivery programs (Amazon, UberEats).',
  'operations.special-hauls': 'Special hauls: oil and gas fields, coiled steel, towing or repossession.',
  'operations.passengers': 'Transporting people: clients, children, workers.',
  'operations.brokerage': 'Brokered trips, acting as a freight broker or forwarder.',
  'operations.non-owned-vehicles': 'Vehicles the business uses but does not own.',

  // Filings
  'filings.required': 'Whether state or federal filings are required.',
  'filings.which': 'Which filings (federal, state, MCS-90, BMC-91, BMC-32) and how many.',
  'filings.authority-age': 'How long the federal operating authority has been active.',

  // Prior and current insurance
  'prior.currently-insured': 'Whether the customer is currently insured.',
  'prior.continuous': 'Whether coverage has been continuous.',
  'prior.same-carrier': 'Whether the customer is insured with the carrier being quoted.',
  'prior.carrier': 'The prior or current carrier.',
  'prior.limit': 'The current liability limit.',
  'prior.expiration': "The current policy's expiration date.",
  'prior.tenure': 'How long the customer has been with the current carrier.',
  'prior.deployed': 'Insurance before a military deployment.',
  'prior.other-coverages': 'Other business coverages the customer has (general liability, BOP, workers comp).',
  'prior.loss-runs': 'Loss runs the customer can provide.',
  'prior.losses': 'Prior losses.',

  // Drivers
  'driver.name': "A driver's name.",
  'driver.dob': "A driver's date of birth.",
  'driver.license-state': "A driver's license state.",
  'driver.license-number': "A driver's license number.",
  'driver.cdl': 'Whether a driver has a CDL.',
  'driver.cdl-year': 'The year a CDL was issued.',
  'driver.year-licensed': 'The year a driver was first licensed.',
  'driver.gender': "A driver's gender.",
  'driver.marital-status': "A driver's marital status.",
  'driver.relationship': "A driver's relationship to the business.",
  'driver.excluded': 'Whether a driver is excluded from the policy.',
  'driver.sr22': 'Whether a driver needs an SR-22 (certificate of financial responsibility).',
  'driver.defensive-course': 'A defensive driving course or discount.',
  'driver.claims': "A driver's accidents, claims or violations.",

  // Vehicles
  'vehicle.vin': "A vehicle's VIN.",
  'vehicle.year': "A vehicle's model year.",
  'vehicle.make': "A vehicle's make.",
  'vehicle.model': "A vehicle's model.",
  'vehicle.type': "A vehicle's type or body type.",
  'vehicle.value': "A vehicle's value (stated amount, worth if sold today).",
  'vehicle.cost-new': "A vehicle's cost new.",
  'vehicle.equipment': 'Permanently attached equipment or customizations, and their value.',
  'vehicle.gvw': "A vehicle's gross vehicle weight.",
  'vehicle.annual-mileage': "A vehicle's annual mileage.",
  'vehicle.safety-features': "A vehicle's safety features (anti-lock brakes, airbags, traction control).",
  'vehicle.anti-theft': "A vehicle's anti-theft devices.",
  'vehicle.loan-lease': 'A loan or lease on a vehicle.',
  'vehicle.registrant': "A vehicle's registrant.",
  'vehicle.registered-state': 'Whether a vehicle is registered in the garaging state.',
  'vehicle.ownership-length': 'How long the insured has had a vehicle.',
  'vehicle.garaging': 'Where a vehicle is garaged or parked.',
  'vehicle.use': "A vehicle's use in the business (business operations, primary income).",

  // Trailers
  'trailer.vin': "A trailer's VIN.",
  'trailer.year': "A trailer's model year.",
  'trailer.make': "A trailer's make.",
  'trailer.type': "A trailer's type.",
  'trailer.value': "A trailer's value.",
  'trailer.equipment': "A trailer's attached equipment or customizations.",
  'trailer.loan-lease': 'A loan or lease on a trailer.',
  'trailer.garaging': 'Where a trailer is garaged or parked.',
  'trailer.registered-state': 'Whether a trailer is registered in the garaging state.',

  // Coverages
  'coverage.liability': 'Auto liability (bodily injury and property damage) and its limit.',
  'coverage.ntl': 'Non-trucking liability.',
  'coverage.um': 'Uninsured and underinsured motorist bodily injury.',
  'coverage.umpd': 'Uninsured motorist property damage.',
  'coverage.medpay': 'Medical payments.',
  'coverage.pip': "Personal injury protection and a state's first-party benefits.",
  'coverage.comp-coll': 'Comprehensive and collision, and their deductibles.',
  'coverage.fire-theft': 'Fire and theft coverage.',
  'coverage.rental': 'Rental reimbursement.',
  'coverage.rental-downtime': 'Rental reimbursement with downtime.',
  'coverage.roadside': 'Towing, labor and road service.',
  'coverage.cargo': 'Motor truck cargo, its limit, deductible and special cargo questions.',
  'coverage.reefer-breakdown': 'Refrigeration breakdown.',
  'coverage.gl': 'General liability, and its limit.',
  'coverage.hired-auto': 'Hired auto coverage.',
  'coverage.non-owned-auto': 'Non-owned auto liability.',
  'coverage.intermodal': 'An intermodal (UIIA) endorsement.',
  'coverage.additional-insured': 'Named or blanket additional insureds, additional interests.',
  'coverage.waiver-of-subrogation': 'Named or blanket waivers of subrogation.',
  'coverage.waiver-of-collision': 'A waiver of collision.',
  'coverage.auto-symbol': 'The covered auto symbols.',
  'coverage.exclusions': "A vehicle's coverage exclusions.",
  'cargo.commodity': 'What is hauled: the cargo commodities.',

  // General liability's trucking questions
  'gl.trucking-income': 'Whether all income comes from for-hire trucking.',
  'gl.premises': 'A warehouse or premises customers visit.',
  'gl.setup-installation': 'Set-up or installation work.',
  'gl.other-business': 'Other businesses than for-hire trucking.',
  'gl.oil-gas': 'Work in oil and gas fields or production.',

  // Trailer interchange
  'interchange.wanted': 'Whether trailer interchange coverage is wanted.',
  'interchange.agreement': 'A trailer interchange agreement.',
  'interchange.agreement-on-request': 'Providing the interchange agreement on request.',
  'interchange.trailer-count': 'The number of non-owned trailers.',
  'interchange.trailer-type': 'The most common non-owned trailer type.',
  'interchange.limit': 'The trailer interchange limit.',
  'interchange.non-owned-trailer-pd': 'Non-owned trailer physical damage.',

  // Underwriting questions
  'underwriting.leased-to-others': 'Vehicles leased to others.',
  'underwriting.mvr-verification': 'MVR verification of drivers.',
  'underwriting.unscheduled-vehicles': 'Owned vehicles not scheduled on the policy.',
  'underwriting.convictions': 'Convictions or moving violations.',
  'underwriting.hazard-exposure': 'Exposure to hazards.',
  'underwriting.subsidiary': 'Being a subsidiary of, or having, another company.',
  'underwriting.safety-program': 'Safety information or a safety program.',
  'underwriting.other-insurance': 'Other insurance.',
  'underwriting.coverage-denial': 'Coverage denied, cancelled or not renewed.',
  'underwriting.criminal-activity': 'Past criminal activity.',
  'underwriting.code-violation': 'Code violations.',
  'underwriting.financial-default': 'A financial default.',
  'underwriting.financial-judgement': 'A financial judgement.',
  'underwriting.trust': 'Being held in a trust.',
  'underwriting.foreign-operations': 'Foreign operations.',
  'underwriting.other-venture': 'Another venture.',
  'underwriting.drones': 'Owning drones, or hiring others to operate them.',
  'underwriting.use-their-auto': 'Others using their autos for the business.',
  'underwriting.maintenance-program': 'A vehicle maintenance program.',
  'underwriting.family-use': 'Vehicles used by family members.',
  'underwriting.driver-recruiting': 'How drivers are recruited.',
  'underwriting.workers-comp': 'Coverage by workers compensation.',
  'underwriting.other-disclosures': 'Other topics to disclose, and their details.',
});
