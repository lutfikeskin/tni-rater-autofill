# Progressive Commercial Auto: live walkthrough

Historical evidence from the dated walkthrough, including decisions that were later superseded. Read only when investigating that scenario; do not use its conflicting navigation/default instructions as current global policy. Current behavior and change guidance are in [browser filling](browser-filling.md) and [intake and rules](intake-and-rules.md).

Observed on 2026-10-01 in the authenticated Progressive agent portal. This
document records page structure and workflow behavior only; it excludes client
details, quote numbers, credentials, session URLs, real PDFs, and screenshots.
The observations apply to Progressive Commercial Auto. GEICO and personal-lines
flows are outside this note's scope.

The agent drives navigation. The extension may fill supported answers and use
the intended quote helpers, but it must wait for the agent before advancing to
another page. After every server response or redraw, reacquire the controls and
verify that the portal accepted the value before reporting success. Preserve
agent corrections. If a relevant question is unfamiliar, a value is rejected,
or the displayed answer does not match the intake, stop automatic filling and
helpers and tell the agent. Known ignored optional fields do not require a
stop.

## Launch

- Start Maryland from the intake's garaging state, then choose Select Products.
- Under Business, select Commercial Auto and use Add Products to Quote. This
  opens the Progressive quote in a separate tab at
  `clpolicy.foragentsonly.com/Express/Default.aspx`.
- The launch therefore does use Add Products to Quote; it is the action that
  opens the commercial quote tab in this workflow.
- `pageName` identifies the quote page. A `-Reload` suffix denotes the same
  page after a server response. Other query parameters contain transient
  session data and must not be saved with page captures.

## Named insured and business overview (`BusinessOwnerInfo`)

- Preserve the prefilled agent code and policy start date.
- Count existing Progressive Commercial Auto coverage only. A Progressive
  personal auto policy does not establish commercial coverage.
- When a DOT number is supplied, choose the DOT path, use Verify USDOT, and
  wait for the registered lookup before filling dependent fields.
- Ownership confirmation is a factual attestation. Answer Yes only when the
  intake or agent supplies evidence; never attest blindly.
- The demonstrated business structure is Corporation or LLC / Non-Profit.
  Use the registered business name and the registered DOT primary business
  address when those are available.
- Primary Business Address and Home Address are separate groups. Selecting
  the registered primary address reveals an additional Home Address option
  labelled `(Primary Business Address)`. The latest user instruction is to select
  that option whenever it is offered, including quotes without a DOT number.
  Otherwise use the offered USDOT address, or retain manual entry if neither
  suggestion exists. Manual address boxes collapse after a suggested address
  is selected. Match each answer to its group.
- The owner name comes from the intake/driver. Preserve a multiword given name
  and surname; leave middle initial and suffix blank when they are not supplied.
  Owner-as-driver follows the intake (Yes in this walkthrough), and DOB comes
  from the intake. The optional phone is deliberately blank.
- Hazmat is No for this walkthrough. The information disclosure and `Ok, start
  quote.` actions remain agent-controlled navigation.

## Vehicle information (`AddVehicle`)

- Map Van to Cargo Van, then use the active VIN path and Lookup VIN. Wait for
  the decoded year, make, and model before continuing.
- Preserve a correct prefilled garaging ZIP. The demonstrated distance is More
  than 500 miles and the use is Business Only.
- For-hire is Yes for this target workflow. Vehicle loan/lease starts at No for
  the standard initial quote; explicit intake or agent evidence takes
  precedence, and the extension must not claim an unverified rate effect.
- Physical damage uses Yes for comprehensive and collision. Equipment is the
  standard `$0 to $2,000` choice. Keep actual vehicle value in the separate
  vehicle-value field; never use it as the equipment amount. If the intake does
  not provide an exact equipment value, leave that value for agent review
  rather than inventing one.
- Continue, Back, and Save & Return Later are agent-controlled actions.

## Drivers (`AddDriver`)

- The portal creates the owner-as-driver record for this walkthrough. Verify
  license state from the driver intake, not from the quote's garaging state.
- Normalize a license number by removing hyphens and other punctuation while
  retaining every letter and digit, including a state prefix.
- Do not add a driver exclusion or incident history when the intake has none.
  MVR and CLUE must not be filled or ordered automatically; the agent decides
  after Rates.
- Driver summary actions such as Edit, Remove, Add Driver, and Continue remain
  agent-controlled.

## More about business (`MoreAboutBusiness`)

- Leave the optional email blank.
- If the intake says the business is currently insured, default continuous
  coverage to Yes subject to agent exceptions. Copy the liability limit and
  expiration literally. Warn on an expired or inconsistent date; do not
  transform a date to make the page continue. A date was manually corrected
  during the demonstration, and that intervention is not an automation rule.
- Other business coverage is None in this walkthrough. Existing additional
  insured and waiver counts remain 0, and blanket endorsements remain No;
  these are known ignored optional fields.
- Filings are Yes only when the intake requests filings and a DOT number is
  present. A DOT number by itself is insufficient. Requested filings without a
  DOT number require agent review. For ELD, use the actual intake answer or
  stop for review; no new default was established here.

## Filings (`Filings`)

- The question about all commercially owned or operated vehicles must be
  answered from quote tracking/intake evidence. A No warns that filings cannot
  be issued; a Yes reveals the filing choices. Do not infer this attestation
  solely from a filings request.
- The demonstrated selections are Federal Liability Filing and MCS-90. State
  filing is unchecked. Do not blanket-select every filing. The exact automatic
  versus manual MCS-90 mapping was not established; preserve unclear portal
  selections and stop for agent review.

## Rates and coverage (`CoveragesRates`)

- Liability is `$1 million CSL` and UM/UIM is `$100k CSL` for this requested
  workflow. Existing Full PIP `$2,500` is ignored here.
- Scope every selection to the correct vehicle/VIN row. The demonstrated
  comprehensive and collision deductibles are `$1,000`; Rental is `$40 per
  day, $1,200 max`.
- Preserve a selected roadside option. If a roadside choice is needed and the
  intake has no selection, use the first option the portal marks Selected.
  Fire/theft additional coverage is Not selected. Equipment remains `$0 to
  $2,000`.
- The captured Rates dropdown `200F` is this additional coverage field. Its
  portal label is the vehicle description, not the coverage name; map it by
  question ID to `Not selected`. Keep the same manual row review for multiple
  vehicles as the other per-vehicle coverage choices.
- Add Motor Truck Cargo only when the intake requests it. Expand the
  Motor Truck Cargo row, answer No for special mobile/modular homes and for
  business documents/nonnegotiable securities, and add a separate commodity.
  Generic freight/general freight hauler maps to Consumer Goods, then Other
  Consumer Goods, subject to agent exceptions. The demonstrated cargo choice
  is `$100k` with a `$1,000` deductible. Use Done with this coverage and verify
  that the collapsed row retains the result.
- If General Liability is requested, the narrated defaults are 100% income for
  hire, with warehouse, setup/installation, oil/gas, and other business all No,
  and a limit taken from the intake (`$1m/$1m` or `$1m/$2m`). No live GL
  question IDs were established, so do not invent IDs or make unattended GL
  assertions; route unsupported mappings to review.

After all coverage changes, including cargo, use Recalculate. Wait until the
stale `****`/warning state is gone, the premium is refreshed, and the bill-plan
button is enabled before using View bill plan options. The prefilled 12-month
installment plan is preserved. Automatic payments from a checking account is
the standard quote payment method; wait for the EFT premium/payment schedule
update, then let the agent Continue back to Rates. This is a quote method, not
bank authorization or enrollment.

## Print, email, and fax (`PrintEmailFax`)

- Choose Insurance Quote (with all bill plans), choose Print, and leave
  Email/Fax unchecked.
- A Fax Cover Page checkbox appeared after Print; whether it is portal-driven
  automatically is unknown, so preserve the portal state for agent review.
- Print/Send produces an insurance quote PDF. It does not sell, bind, or submit
  the policy. Completion should verify that the generated PDF is available
  when a safely identifiable download is exposed, rather than treating the
  click alone as proof.
- The real generated PDF and its filename were not verified locally during
  this walkthrough. Do not rummage through unrelated Downloads or claim that
  PDF verification has completed.

## Extension requirements exposed by the walkthrough

- Live Duck Creek question IDs can begin with uppercase component prefixes such
  as `f_U...` and `f_P...` as well as lowercase prefixes. The parser must accept
  both.
- Server responses redraw controls. Reacquire DOM nodes and verify accepted
  values after each response; never report a field as filled merely because an
  event was dispatched.
- Unfamiliar fields are yellow warnings and remain unchanged while known fields
  and ready helpers continue. Failed acceptance and intake/portal mismatches
  remain stop conditions.
- Helper ordering is part of correctness: finish cargo, recalculate, wait for
  a refreshed premium and enabled bill-plan action, then view bill plans.
  Never treat any filled coverage as sufficient readiness.
- Keep navigation agent-controlled. Helpers may cover supported Lookup/Verify,
  cargo Add commodity/Done, Recalculate, bill-plan viewing, and Print actions;
  they must not click Continue, Next, Start Quote, Finish, Buy, Bind, Submit,
  or Save.

## Decisions taken on 2026-10-01 (supersede the stricter notes above)

TNI reviewed the walkthrough notes and decided: an unfamiliar or unanswerable question is marked
yellow and the rest of the page still fills (filling never stops for one question; it stops only
when the page is stuck or the agent edits a field during a fill). "USDOT belongs to the
business" and "all vehicles on this quote" are answered Yes; filings follow the intake and
Federal is ticked (MCS-90 comes with it); comprehensive/collision deductibles default to $1,000;
"vehicle has no equipment" is ticked; GVW and annual mileage are left to the VIN lookup; and
when a page has nothing left for the agent, the filler clicks its Continue ("Ok, start quote." on
page 1), never Finish/Buy/Bind/Submit. The rest of this document describes the walkthrough as
observed; where it conflicts with this section, this section wins.

## Local implementation and validation boundary

The extension highlights unfamiliar questions in yellow without pausing, and logs
them as `fill_field` events with result `unfamiliar`, alongside captured layouts
and later agent corrections for training. Typed answers are not included in these
warning events. It pauses when an answer is rejected or changes after a redraw, or helper readiness
cannot be verified. After reviewing and correcting the flagged controls, the
agent can click **Fill this page** to retry. Known optional contact fields and
prefilled administrative choices are explicitly preserved. Corrections and
pause state are retained when switching tabs during the same panel session.

Repeated question IDs and unvalidated multi-vehicle coverage columns require
manual review; selecting an intake vehicle alone does not prove the portal's
column identity. Requested GL also requires manual completion. Comprehensive
and collision deductibles need an explicit requested value; the walkthrough's
$1,000 examples are not a universal default. A disappeared control without a
verifiable retained value is a review stop, even when disappearance may be a
normal portal behavior.

Local tests use synthetic intake data and a small DOM/ExtJS replay executing the
actual injected engine. They do not establish live portal compatibility or
verify a generated customer PDF. Print/Send reports document confirmation as
pending. No live quotes are changed by these tests.

To use this checkout, open Chrome's Extensions page, enable Developer mode,
and load unpacked `/Users/lutfikeskin/Documents/GitHub/tni-rater-autofill` (or
click Reload on the existing TNI Rater Autofill extension). Reload the relevant
rater tab so both the engine and recorder use the updated scripts, then reopen
the side panel and load the intake. Review existing quote answers after reload;
agent-edit tracking begins in the new panel session.

Validation on 2026-10-01: the complete `npm test` suite passed 61 tests with zero
failures after allowing the server tests to bind localhost. The final targeted
normalization/Progressive rule run passed all 22 tests, and JavaScript syntax
checks plus `git diff --check` passed. No commit, push, or publication was made.
