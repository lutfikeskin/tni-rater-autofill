# Bake-off task: quote a trucking client on the practice Progressive pages

You are an insurance agent at Truckers National Insurance (TNI). Fill in a Progressive commercial auto quote for the client in **`test/bakeoff/intake.md`** (a made-up test client), following TNI's rules below.

**Where:** http://localhost:8792/test/replay/?bakeoff=1&runner=codex. These are practice copies of Progressive's quote pages, not the real site.

## How to work the practice pages

1. Press **Start** at the top before anything else. It starts the timer.
2. Fill each page, clicking the buttons the rules call for. Some questions only appear after you click a button.
3. Move to the next page with **Next page ›**.
4. Click **"Continue ›"** only when the page has nothing left to check (every question you could answer is answered). Clicking it with open questions counts as a mistake.
5. On the last page (PrintEmailFax), finish that page, then press **Finish & save results** at the top. That saves your answers; the run is over.
6. Don't change the "Page" dropdown or anything else in the grey bar except Start and Finish.

Leave a question as it is when the rules and the intake don't say anything about it. The page's own pre-selected answers are not always right: change them when the rules say so.

## TNI's rules, page by page

### BusinessOwnerInfo (named insured and business)
- **Is the customer currently insured with Progressive Commercial Auto?** Yes only if the intake's current insurance is a Progressive **commercial** auto policy with a limit and an expiration date. A personal auto policy doesn't count.
- **Does the customer have a USDOT number?** "Yes" if the intake has one. If not, "Not Yet…" if they'll have one within 60 days, "No…" if the intake says they won't; no answer there: leave it to the agent.
- Enter the USDOT number (digits only), then click **Verify DOT**.
- **Does this USDOT Number belong to the customer's business?** Yes.
- **Business Name** and **Business Address**: pick the USDOT-registered option, not "Enter a different…".
- **Home Address**: always the first option. If it's "Enter a different address", type the whole address in the address box and pick the first suggestion.
- **How is the business structured?** "Corporation or LLC / Non-Profit" when the company name ends in LLC, Inc, Corp or Co.
- **Business type list**: "For Hire Trucking" for expediters. **Type of Trucker**: "Other For-Hire Trucking" for expediters. For other businesses, use what the intake says.
- **Business owner's first and last name** and **date of birth**: from the intake. The owner is the driver with the same last name; use that driver row's first name exactly as written.
- **Phone**: split into area code, prefix and line number.
- **Hazardous material placard?**: from the intake. Left blank: No (TNI standard), unless the intake says they haul hazardous material, or what they haul may need a placard (fuel, propane, chemicals and the like); then leave it to the agent.
- Leave empty: middle initial, suffix, DBA name (always), quote vendor code. Don't touch agent code or policy start date.

### MostCommonVehicles (vehicle picker)
- Click the tile for the intake's vehicle type: "Van" is **Cargo Van**, "Semi Truck" is **Truck Tractor**, "Flatbed" is **Flatbed Truck**; Box Truck and Pickup Truck by their names. "Reefer Truck" is the refrigerated tile only when the intake's business class is also Reefer. Tanker, Dump Truck and Other, or more than one matching tile: leave the tile to the agent.

### AddVehicle
- Enter the VIN, then click **Lookup VIN** right away, before the other questions.
- **ZIP where the vehicle is located**: the garaging address ZIP.
- **Farthest one-way distance**: the intake's radius in miles. "Unlimited" or long haul is **More than 500 miles**.
- **Business, personal or both?**: "Business Only" unless the intake says the vehicle is also for personal use.
- **Haul goods for hire?**: Yes for expediters and freight haulers (the business class, not the MC number); any other class: leave it to the agent.
- **Loan/lease?**: "Yes - Loan" when the intake says the vehicle is financed (the claims box sometimes says so), "Yes - Lease" when leased, No when owned; no ownership answer: leave it to the agent.
- **Comprehensive or collision?**: Yes.
- **Total value of permanently attached equipment**: the intake's attached equipment value. None, or up to $2,000: "$0 to $2,000", and tick **Vehicle has no equipment**. More: leave the band to the agent.
- **If this vehicle was sold today, how much would it be?**: the intake's vehicle value, as a plain number (e.g. 45000).
- **Has the insured or their hired driver had the vehicle less than one (1) year?**: No (TNI standard), except a vehicle of this model year or later: leave it to the agent.

### AddDriver
- **License state**: full state name.
- **License number**: letters and digits only, no dashes or spaces. If the intake writes the state in front ("IL - S123…"), keep those letters in the number ("ILS123…").
- **Has a CDL?**: the intake's answer; left blank it is No, unless the intake gives a CDL year (then leave it to the agent).
- **Exclude this driver?**: No for a driver listed on the intake; Yes for one the intake marks excluded ("Excluded" in their license-number box).
- **Accidents, claims or violations in the past 3 (or 5) years?**: from the intake's claims answer. The claims box sometimes has extra lines that answer other questions; the first line is the claims answer. When it is neither Yes nor No: No (TNI standard), unless the intake's notes mention an accident, claim, violation, ticket or points, or the intake says an SR-22 is needed; then leave it to the agent.

### MoreAboutBusiness
- **Customer email**: from the intake.
- **Currently insured?**: Yes when the intake lists current insurance with a limit and an expiration that is not before the application date.
- **Continuous coverage?**: Yes when the customer is currently insured; otherwise leave it to the agent.
- **Current bodily injury limit** and **current policy expiration**: from the intake, as written ("State Minimum" is "State Minimum or less").
- **Other coverages for the business?**: None, unless the customer has general liability (then leave them to the agent). General liability asked for on the intake alone keeps None.
- Leave the additional insured and waiver questions as they are.
- **State or federal filings required?**: Yes when the intake says filings are required, No when it says they aren't. The page pre-selects No. Left blank: No (TNI standard) when the intake has no USDOT or MC number, also when one is coming within 60 days; with either number, filings named on the intake, or an SR-22 needed, leave it to the agent.
- **ELD required?**: from the intake.

### Filings (only when filings are required)
- **Will this quote include all the customer's commercially owned and operated vehicles?**: Yes.
- Tick **Federal** and **MCS-90**.

### CoveragesRates
- **Bodily injury and property damage liability**: the intake's requested limit. "$1M CSL" is "$1 million CSL". The page pre-selects $750k.
- **Rental** (the "$… per day" dropdown): "$40 per day, $1,200 max". **Rental with Downtime** (offered for a truck tractor): Not selected.
- With several vehicles, each vehicle's coverages are listed under its name: the same per-vehicle answers apply to every vehicle.
- **Total value of permanently attached equipment**: "$0 to $2,000".
- Cargo, when the intake asks for it: click the **+** in the **Motor Truck Cargo** row (not another row's +). Then:
  - Special cargo (mobile/modular homes; business documents): both No.
  - Commodity category "Consumer Goods", commodity "Other Consumer Goods" for "General freight".
  - Motor truck cargo limit: the intake's limit and deductible, e.g. "$100K/$1K Ded" is "$100k with a $1,000 Deductible" (both cargo dropdowns). No deductible on the intake: leave the cargo limit to the agent (the deductible is usually $1,000 or $2,500).
- Leave the other coverages as they are.
- **UMPD limit**: Not selected. Comprehensive and collision deductibles: $1,000.
- Then click **View Bill plan options** (no GL requested).

### ChangePaymentPlan
- **Payment method**: Automatic payments. Then go back to the rates page (Continue), click **Recalculate**, then **Print, Email, Fax**.

### PrintEmailFax
- Choose **Insurance Quote (with all bill plans)** and tick **Print**. Click **Print/Send**, then press **Finish & save results**.
