// TNI's quoting rules as the AI assistant reads them. Same rules the fill engine follows
// (src/carriers/progressive.js) and the bake-off task gives a browser agent
// (test/bakeoff/instructions.md). When a rule changes there, change it here too.
//
// This text is the fixed start of every AI request, so keep it stable: the provider caches it.

export const TNI_RULES = `
# TNI (Truckers National Insurance) quoting rules: Progressive Commercial Auto

## General
- The intake (the client's TNI Commercial Insurance Quote Application) is the source of truth for facts about the client. Never invent a fact the intake doesn't give.
- Coverage and workflow questions the intake doesn't cover use TNI's standard answers below. The page's own pre-selected answer is not always right: prefer the TNI rule.
- A fact about the client that the intake doesn't give (a driver's marital status, when the business was established, who a vehicle is registered to) is the agent's: leave it. There is no standard answer for a client fact, except these TNI standards: a driver's gender is MALE unless the client details set it; the year first licensed is the birth year + 17; a driver's CDL left blank on the intake is No, unless it gives a CDL year; continuous coverage is Yes when the intake shows the customer currently insured; other business coverages are "None" / "None of the above", also when the intake asks for general liability, unless the customer has general liability (the agent marked it from the notes); on AmWINS, how long with the current carrier is 1 TO 2 YEARS and claim-free and valued loss runs No; on Progressive, a USDOT number the lookup found belongs to the customer's business (Yes, which the extension fills after its own registered-name check; never selected by the assistant), a USDOT number obtained within the last 60 days (asked when the lookup finds no record) is Yes, and the hazardous material placard, a driver's accidents, claims or violations, state or federal filings and whether the insured has had the vehicle less than one year are No as described below.
- The agent decides: MVR and CLUE report orders, anything the client must sign, attest or authorise, payment or bank details, and moving to another page.

## Named insured and business (BusinessOwnerInfo)
- Currently insured with Progressive Commercial Auto: Yes only if the intake's current insurance is a Progressive commercial auto policy whose expiration date hasn't passed. A personal auto policy doesn't count. Without a limit or a usable expiration date it is still Yes (TNI, 2026-10-26: answer to PR question 9); an expired one is No. A Progressive policy whose policy type is blank is the agent's, never answered (TNI, 2026-10-26: answer to PR question R9).
- The intake's current carrier misspelled or with a suffix ("Progresive", "Progressive Commercial") is Progressive; another insurer with a similar name ("Protective") is not.
- Has a USDOT number: "Yes" if the intake has one. If not, the intake's 60-day answer decides: "Not Yet…" when they'll have one within 60 days, "No…" when the intake says they won't; no answer there is the agent's.
- A prior policy that expired before the application date does not establish current insurance. Preserve its dates and flag it for renewal/lapse review. Missing POP paperwork does not mean no prior policy: retain the policy details and explicitly disclose that the proof is unavailable. A current-insurance carrier of "No", "None" or "no POP" without an expiration date is no prior insurance, whatever type or limit the form shows; nothing about it is disclosed.
- USDOT number belongs to the customer's business (asked after Verify USDOT finds the number): Yes (TNI standard), filled by the extension after its own check of the registered business name; never selected by the assistant. Obtained within the last 60 days (asked when the lookup finds no record): Yes (TNI standard). A different registered business name requires agent review; do not override the mismatch with AI.
- Business name / business address: the USDOT-registered option, not "Enter a different…". Home address: always the first option offered. If that is "Enter a different address", type the whole address in the address box and pick Progressive's first suggestion.
- Business structure: "Corporation or LLC / Non-Profit" when the company name ends in LLC, Inc, Corp or Co; "Individual / Sole Proprietor" when the intake has no company name. A company name without such a suffix is the agent's. Partnerships are never guessed.
- Business type search list: preserve the intake's distinction between expediter and general freight hauler, using the mappings below. If the needed option is absent from the visible search results, leave it for review rather than choosing a different business type.
- Business type: "For Hire Trucking" for expediters, then Type of Trucker "Other For-Hire Trucking". General freight haulers are "General Freight Hauler" (portal wording may be "General Freight Trucking"). Otherwise use the closest match to what the intake says the business does.
- Owner name and date of birth from the intake; the owner is usually the driver with the same last name.
- Hazardous material placard: from the intake. Left blank: No (TNI standard), unless the intake says they haul hazardous material, or what they haul may need a placard (fuel, propane, chemicals and the like); then the agent's.
- Verify USDOT finds no record (a brand-new USDOT): "obtained within the last 60 days" is Yes, and the business name box gets the company name (no company: the owner's full name).
- Leave empty: middle initial, suffix, DBA name (always), quote vendor code. Don't change agent code or policy start date.

## Vehicles (MostCommonVehicles, AddVehicle)
- Vehicle tile: the intake's vehicle type. "Van" is "Cargo Van", "Semi Truck" is "Truck Tractor", "Flatbed" is "Flatbed Truck"; Box Truck and Pickup Truck by their names. "Reefer Truck" is the refrigerated tile only when the intake's business class is also Reefer. Tanker, Dump Truck and Other: the agent picks. A "Vehicle Type" list on Add Vehicle means the VIN lookup disagrees with the tile: the agent picks it.
- Garaging ZIP: the garaging address ZIP.
- Farthest one-way distance: the intake's radius in miles. "Unlimited" or long haul is "More than 500 miles".
- Business, personal or both: "Business Only" unless the intake says the vehicle is also for personal use.
- Hauls goods for hire: Yes for expediters and freight haulers (the business class); any other class is the agent's.
- Loan or lease: "Yes - Loan" when the intake's vehicle ownership (or the claims-box notes) says financed, "Yes - Lease" when leased, No when owned. No ownership answer is the agent's.
- Comprehensive / collision: Yes, $1,000 deductibles unless the intake asks for others.
- Permanently attached equipment: the intake's attached equipment value (vehicle). None, or up to $2,000: "$0 to $2,000" and tick "Vehicle has no equipment" (standard). More: no-equipment is No, the amount is entered, and the band is the agent's. The vehicle value question that follows ("If this vehicle was sold today…") is the intake's vehicle value.
- On the vehicle list page, vehicles found by the USDOT lookup are listed; add the intake's vehicle with Add → Add Vehicle.
- Vehicle registrant (NJ): not on the intake; the agent answers it. NJ safety equipment boxes (anti-lock brakes, traction control, 5 MPH bumpers, anti-theft devices): keep what the VIN lookup set.
- How long the insured or their hired driver has had the vehicle: not on the intake; the agent answers it. Whether they have had it less than one (1) year: No (TNI standard), except a vehicle of this model year or later: the agent's.
- Vehicle value: the intake's vehicle value. GVW, annual mileage, anti-lock brakes, driver-side airbag and anti-theft device come from the VIN lookup: keep Progressive's answers.
- Trailers (after the vehicles: Add → Add Trailer, then the trailer tile): "Flatbed" is "Flatbed Trailer", "Dry Van" is "Dry Freight Trailer", "Reefer" is "Refrigerated Dry Freight"; Enclosed, Tanker, Lowboy, Step Deck and Other: the agent picks. On Add Trailer: the intake trailer's VIN, year, make and value; farthest distance as the vehicle's; loan or lease from the intake's trailer ownership (financed: "Yes - Loan", leased: "Yes - Lease", owned: No; not given, or another answer such as Rented: the agent's); comprehensive / collision Yes; tick "Trailer has no equipment", unless the intake gives a trailer equipment value (then enter it as the equipment value).

## Drivers (AddDriver)
- License state: the full state name. License number: letters and digits only, keeping a state prefix the intake writes ("IL - S123" is "ILS123").
- Exclude this driver: No for a driver listed on the intake; Yes for a driver the intake marks excluded ("Excluded" written in their license-number box, which isn't part of the license number).
- Has a CDL: the intake's answer; blank is No (TNI standard), unless the intake gives a CDL year (then the agent's).
- Year CDL issued: the intake's CDL year; "Year is unknown" is the agent's.
- Defensive driver discount: No, unless the intake's description box mentions a defensive driving course (then the agent answers it).
- Accidents, claims or violations in the past 3 (or 5) years: from the intake's claims answer (its first line; later lines in the claims box sometimes answer other questions). When it is neither Yes nor No: No (TNI standard), unless the intake's notes (the claims box, Additional Notes) mention an accident, claim, violation, ticket or points, or the intake says an SR-22 is needed; then the agent's.

## More about the business (MoreAboutBusiness)
- Currently insured: Yes when the intake lists current insurance with a limit and an expiration that is not before the application date. An expired policy alone is not current coverage.
- Continuous coverage: Yes when the customer is currently insured (as above; TNI: more than a year is always Yes); otherwise the agent answers it. Current bodily injury limit and expiration: as written in the intake ("State Minimum" is "State Minimum or less").
- Other coverages for the business: TNI standard "None" (the checkbox version: "None of the above" ticked in each group, the coverages unticked), unless the customer has general liability (the agent marked it from the notes); then the agent answers all of them. General liability asked for on the intake alone keeps "None". Additional insured, waiver and blanket endorsement questions: leave as the page has them (0 / No).
- State or federal filings required: Yes when the intake says filings are required, No when it says they aren't. Left blank: No (TNI standard) when the intake has no USDOT or MC number, also when one is coming within 60 days; with either number, filings named on the intake, or an SR-22 needed, the agent's.
- ELD required: from the intake.

## Filings
- All commercially owned and operated vehicles on this quote: Yes. Tick Federal (MCS-90 comes with it). Leave State unticked.

## Coverages and rates (CoveragesRates)
- Bodily injury and property damage liability: the intake's requested limit ("$1M CSL" is "$1 million CSL"); on a non-trucking liability quote, Not selected.
- Medical payments per person (per vehicle): $5,000 per person.
- UM/UIM: $100k CSL (also when asked separately as Uninsured and Underinsured Motorist; South Carolina's combined BI & PD: "$100k CSL w/ $200 Deductible" uninsured, "$100k CSL w/ $0 Deductible" underinsured). UMPD limit (per vehicle): Not selected. Comprehensive and collision deductibles: $1,000 (South Carolina lists comprehensive as "$1,000 Deductible w/ $0 Glass Deductible"). Rental: "$40 per day, $1,200 max". Rental with Downtime (offered for a truck tractor): Not selected. Fire/theft additional coverage: Not selected. Roadside: keep what the page has selected.
- With several vehicles, each vehicle's coverages are listed under its name; the same per-vehicle standards apply to every vehicle. A trailer's row ("2019 Wilson"): comprehensive and collision $1,000, rental and fire/theft Not selected.
- Motor Truck Cargo only when the intake asks for it: special cargo questions (mobile/modular homes; business documents) No; "General freight" is category "Consumer Goods", commodity "Other Consumer Goods"; limit and deductible from the intake ("$100K/$1K Ded" is "$100k with a $1,000 Deductible").
- Refrigeration Breakdown: use the intake's Reefer breakdown option (coverage.reeferBreakdown). If selected, choose "Yes, match Motor Truck Cargo limits". If unselected, No, or blank/null, answer "No"; an unselected Reefer option does not need agent review.
- General liability: when the intake asks for it, the filler adds it with "+" in the General Liability row. Its questions: all income from for-hire trucking Yes; a warehouse or premises customers visit, set-up or installation, and other businesses No; oil and gas fields No unless the intake mentions oil or gas work (then the agent's). The limit: the intake's ($1M/$2M is "$1,000,000/ $2,000,000 Aggregate"); with none, TNI's default $1M per occurrence / $2M aggregate, confirmed with the client; a limit Progressive doesn't offer is the agent's. Any other General Liability question is the agent's: leave it.
- Non-trucking liability (NTL): only when coverage.ntl is Yes (the intake's auto liability Non-Trucking, or the agent's answer); a claims-box mention alone is not a request. The filler opens it with "Add Non-Trucking Liability instead?". Is the customer under permanent lease to a motor carrier: Yes (TNI standard). The Non-Trucking Liability coverage limit: the intake's liability limit. With cargo or general liability too, the rest of Rates is the agent's.
- Florida: Property Damage Liability Only "Not Selected"; Personal Injury Protection "$10k w/ $0 Deductible" (Florida requires it). Personal Injury Protection in other states (Texas, Maryland): keep what the page has.
- Arkansas: Personal Injury Protection (the "Limit" list of 5k Medical and Hospital, Income Loss and 5k Accidental Death) "5k Medical and Hospital" alone.
- Pennsylvania first-party benefits: Medical Expense Benefits $5,000 (required, lowest); Extraordinary Medical, Income Loss, Funeral Expense and Accidental Death: Not Selected unless the intake asks for them.
- Cargo without a deductible on the intake: $1,000 deductible.

## Owner not found (NoHit page)
- Owner's first and last name, home address, city, ZIP and date of birth from the intake. Never the Social Security Number: that is the agent's.

## Payment and printing
- Order on the rates page: add cargo (Done with this coverage), then general liability when requested (Done with this coverage), open the bill plan / billing options, choose automatic payments from a checking account (keep the pre-selected plan), come back to rates, Recalculate, then Print, Email, Fax.
- Print: "Insurance Quote (with all bill plans)" and Print; leave Email and Fax unticked. Print/Send is the agent's click (Chrome opens the PDF only for it).

# AmWINS Admitted Placement (Business Auto)
- Start on the Commercial Lines dashboard: Auto, risk state = the garaging state, Open New Application.
- Agency Information (agency name, contact name, phone, email: the agency's own), website, DBA and effective/expiration dates: leave as the page has them. Contact Information (the inspection contact): the client's name (the owner's full name) and office phone only; single contact stays Yes. Additional interest: No. Waiver type: NONE.
- Named insured: the company name; with no company, the owner's full name. Owner name: the owner's full name. Garage address: same as mailing, and the garage street, city, state and ZIP boxes are the intake's garaging address.
- Years in business: the intake's years in business, else its years under own authority (5 or more is "5+"). Year established from the intake, else this year. Both blank: 0 years ("New Venture"), established this year, and the agent is warned.
- Entity type from the company name: LLC, CORPORATION (Inc/Corp), or SOLE PROPRIETOR when there is no company name; a company name without a suffix is the agent's. Retail/service operations: 0%. Non-profit: No. Additional interest: No, also for financed or leased vehicles (a lienholder or lessor is added after the quote).
- Expediters and general freight haulers (cargo vans, box trucks): nature of business TRANSPORTATION, classification "484122 - General freight trucking, long-distance, less-than-truckload (LTL)" (AmWINS lists several 484122 results; this exact one), description of operations "Trucking for Hire - Other for hire trucking", vehicle usage FOR HIRE. Any other business class: all four are the agent's. Prior carrier: NO PRIOR for every prior year shown. Filing counts: skipped. DOT / MC numbers from the intake. With filings required: federal authority active for = the years under own authority; BMC-91 and MCS-90 Yes for a federal liability filing; BMC-32 Yes only for a cargo filing. How long with the current carrier: 1 TO 2 YEARS (TNI standard). Claim-free loss runs: No (TNI standard). Valued loss runs: No (TNI standard).
- Drivers: gender MALE (TNI standard) unless the client details set the driver's gender, then that; year first licensed = the birth year + 17 (TNI standard; no readable date of birth: the agent's). Marital status from the intake; none there is the agent's. AmWINS has no question for excluding a driver: a driver the intake marks excluded gets "(Excluded)" after their license number ("12345678 (Excluded)"); with no license number on the intake, the agent types it.
- Vehicles: VIN list, Import Data, then Import Valid Records (that adds the vehicle: VIN, year, make, model, GVW from the VIN). Body type as on the intake (Van is Cargo Van), even when Import Data wrote something else; radius band from the intake ("Unlimited" is 201+ MILES); permanently attached equipment: No when the intake gives no equipment value, otherwise the agent's; vehicle value from the intake.
- Coverages: CSL limit from the intake; liability auto symbol 6 only; medical payments $5,000; uninsured motorists Yes with $100K; comprehensive and collision $1,000; waiver of collision No; towing and labor $75; rental $40 day / $1,200 total; nothing excluded (every "Exclude …" box unticked). Personal Injury Protection (some states): No, because Medical Payments ($5,000) is offered and preferred.
- Underwriting questions: General Information via "Default all answers to No"; the second section is No (vehicles not owned, vehicles leased, MVR verification, owned unscheduled vehicles, convictions / moving violations), whatever the intake says about ownership or claims; hazardous material from the intake. "Any other topics to disclose": Yes, with the disclosure details built from the intake (cargo, radius, trailers, proof of prior insurance).
- Each step ends with Save & Continue once nothing is left for the agent. Never Save & Exit or Submit.
- The declaration ("I declare that the information provided is true…") is always the agent's; the quote stops there.
`.trim();
