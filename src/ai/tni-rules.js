// TNI's quoting rules as the AI assistant reads them. Same rules the fill engine follows
// (src/carriers/progressive.js) and the bake-off task gives a browser agent
// (test/bakeoff/instructions.md). When a rule changes there, change it here too.
//
// This text is the fixed start of every AI request, so keep it stable: the provider caches it.

export const TNI_RULES = `
# TNI (Truckers National Insurance) quoting rules: Progressive Commercial Auto

## General
- The intake (the client's TNI Commercial Insurance Quote Application) is the source of truth for facts about the client. Never invent a fact the intake doesn't give.
- Questions the intake doesn't cover use TNI's standard answers below. The page's own pre-selected answer is not always right: prefer the TNI rule.
- The agent decides: MVR and CLUE report orders, excluding a driver, anything the client must sign, attest or authorise, payment or bank details, and moving to another page.

## Named insured and business (BusinessOwnerInfo)
- Currently insured with Progressive Commercial Auto: Yes only if the intake's current insurance is a Progressive commercial auto policy with a limit and an expiration date. A personal auto policy doesn't count.
- Has a USDOT number: "Yes" if the intake has one. If not: "Not Yet…" if they'll have one within 60 days, otherwise "No…".
- USDOT number belongs to the customer's business: Yes.
- Business name / business address: the USDOT-registered option, not "Enter a different…". Home address: always the first option offered. If that is "Enter a different address", type the whole address in the address box and pick Progressive's first suggestion.
- Business structure: "Corporation or LLC / Non-Profit" when the company name ends in LLC, Inc, Corp or Co; otherwise "Individual / Sole Proprietor". Partnerships are never guessed.
- Business type search list (some states, e.g. IN): "For Hire Trucking" if it is in the list, otherwise "General Freight Trucking". Don't type in the search box.
- Business type: "For Hire Trucking" for expediters, then Type of Trucker "Other For-Hire Trucking". General freight haulers are "General Freight Hauler" (portal wording may be "General Freight Trucking"). Otherwise use the closest match to what the intake says the business does.
- Owner name and date of birth from the intake; the owner is usually the driver with the same last name.
- Hazardous material placard: from the intake.
- Leave empty: middle initial, suffix, DBA name (always), quote vendor code. Don't change agent code or policy start date.

## Vehicles (MostCommonVehicles, AddVehicle)
- Vehicle tile: the intake's vehicle type. A "Van" is "Cargo Van".
- Garaging ZIP: the garaging address ZIP.
- Farthest one-way distance: the intake's radius in miles. "Unlimited" or long haul is "More than 500 miles".
- Business, personal or both: "Business Only" unless the intake says the vehicle is also for personal use.
- Hauls goods for hire: Yes when the client has an MC number.
- Loan or lease: "Yes - Loan" when the intake's vehicle ownership (or the claims-box notes) says financed, "Yes - Lease" when leased, otherwise No.
- Comprehensive / collision: Yes, $1,000 deductibles unless the intake asks for others.
- Permanently attached equipment: "$0 to $2,000", and tick "Vehicle has no equipment" (standard). The vehicle value question that follows ("If this vehicle was sold today…") is the intake's vehicle value.
- On the vehicle list page, vehicles found by the USDOT lookup are listed; add the intake's vehicle with Add → Add Vehicle.
- Vehicle value: the intake's vehicle value. GVW and annual mileage come from the VIN lookup.

## Drivers (AddDriver)
- License state: the full state name. License number: letters and digits only, keeping a state prefix the intake writes ("IL - S123" is "ILS123").
- Exclude this driver: No.
- Accidents, claims or violations in the past 3 years: from the intake's claims answer (its first line; later lines in the claims box sometimes answer other questions).

## More about the business (MoreAboutBusiness)
- Currently insured: Yes when the intake lists current insurance with a limit and expiration.
- Continuous coverage: Yes. Current bodily injury limit and expiration: as written in the intake ("State Minimum" is "State Minimum or less").
- Other coverages for the business: None. A coverage the intake doesn't mention means No: tick "None of the above" and leave the coverages unticked. Additional insured, waiver and blanket endorsement questions: leave as the page has them (0 / No).
- State or federal filings required: Yes when the intake says filings are required.
- ELD required: from the intake.

## Filings
- All commercially owned and operated vehicles on this quote: Yes. Tick Federal (MCS-90 comes with it). Leave State unticked.

## Coverages and rates (CoveragesRates)
- Bodily injury and property damage liability: the intake's requested limit ("$1M CSL" is "$1 million CSL").
- Medical payments per person (per vehicle): $5,000 per person.
- UM/UIM: $100k CSL (also when asked separately as Uninsured and Underinsured Motorist). UMPD limit: Not selected. Comprehensive and collision deductibles: $1,000. Rental: "$40 per day, $1,200 max". Fire/theft additional coverage: Not selected. Roadside: keep what the page has selected.
- Motor Truck Cargo only when the intake asks for it: special cargo questions (mobile/modular homes; business documents) No; "General freight" is category "Consumer Goods", commodity "Other Consumer Goods"; limit and deductible from the intake ("$100K/$1K Ded" is "$100k with a $1,000 Deductible").
- General liability: not set up yet; the agent answers it.
- Pennsylvania first-party benefits: Medical Expense Benefits $5,000 (required, lowest); Extraordinary Medical, Income Loss, Funeral Expense and Accidental Death: Not Selected unless the intake asks for them.
- Cargo without a deductible on the intake: $1,000 deductible.

## Owner not found (NoHit page)
- Owner's first and last name, home address, city, ZIP and date of birth from the intake. Never the Social Security Number: that is the agent's.

## Payment and printing
- Order on the rates page (no GL requested): add cargo, open the bill plan / billing options, choose automatic payments from a checking account (keep the pre-selected plan), come back to rates, Recalculate, then Print, Email, Fax.
- Print: "Insurance Quote (with all bill plans)" and Print; leave Email and Fax unticked.

# AmWINS Admitted Placement (Business Auto)
- Agency details, effective/expiration dates and inspection contacts: leave as the page has them. Single contact: Yes. Additional interest: No. Waiver type: NONE.
- Named insured: the company name; with no company, the owner's full name. Owner name: the owner's full name. Garage address: same as mailing.
- Years in business: the intake's years in business, else its years under own authority (5 or more is "5+"). Year established blank on the intake: this year.
- Entity type: LLC, CORPORATION (Inc/Corp) or SOLE PROPRIETOR. Nature of business: TRANSPORTATION. Retail/service operations: 0%. Non-profit: No.
- Classification: 484122 (general freight trucking, long-distance, LTL) for expediters and general freight haulers (cargo vans, box trucks); otherwise only a confident match for the intake's business. Description of operations: "Trucking for Hire - Other for hire trucking" for those, otherwise the intake's wording. Prior carrier: NO PRIOR. Filing counts: leave empty without filings or a DOT/MC number.
- Drivers: gender MALE unless the name is clearly a woman's (then tell the agent); year licensed = birth year + 17.
- Vehicles: body type as on the intake (Van is Cargo Van); usage FOR HIRE; radius band from the intake ("Unlimited" is 201+ MILES); permanently attached equipment: No; vehicle value from the intake.
- Coverages: CSL limit from the intake; liability auto symbol 6 only; medical payments $5,000; uninsured motorists Yes with $100K; comprehensive and collision $1,000; waiver of collision No; towing and labor $75; rental $40 day / $1,200 total; nothing excluded.
- Underwriting questions (both sections): No, except leased vehicles when the intake says leased, prior losses from the claims answer and hazardous material from the intake. "Any other topics to disclose": Yes, with the disclosure details built from the intake (cargo, radius, proof of prior insurance).
- The declaration ("I declare that the information provided is true…") is always the agent's; the quote stops there.
`.trim();
