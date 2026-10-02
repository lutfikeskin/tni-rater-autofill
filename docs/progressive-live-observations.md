# Progressive commercial auto: observed workflow

Observed 2026-10-01 from an agent-driven Maryland walkthrough. This records UI
behavior and the user's quoting conventions, not independent verification of
underwriting facts or premium effects. No client identifiers or session URLs
are included. Historical practice scores are not live accuracy evidence.

## Navigation boundary

FAO home: choose intake state, Commercial Auto under Business, then **Add Products
to Quote**. This opens a separate Express quote tab. Autofill remains scoped to
that quote flow. The agent controls Start Quote, Continue, Next and final
navigation; the extension never buys, binds, submits, saves or orders reports.

## Business and owner

Preserve prefilled agent code and start date. Personal Progressive coverage is
not current Progressive Commercial Auto. Enter USDOT, Verify USDOT, wait for
lookup; registered business ownership requires confirmation. Corporation/LLC,
registered name, blank DBA were used. Expediter/general trucking maps to For Hire
Trucking / Other For-Hire Trucking. Both business and home used the first
registered USDOT address; home did not preferentially use the later Primary
Business Address option. Owner name and DOB come from the matching intake driver;
keep multiword given names. Owner drives comes from intake. Middle initial,
suffix and optional phone stay blank. Hazmat No comes from the intake.

## Vehicles and drivers

Van selects Cargo Van. VIN mode and Lookup VIN precede details; ZIP is preserved
if it agrees. Unlimited radius maps to More than 500 miles. This intake used
Business Only. User standards: for-hire Yes, preliminary loan/lease No,
comprehensive/collision Yes, attached equipment $0 to $2,000. This does not
establish rate impact. Equipment range is separate from actual vehicle value;
never invent an equipment amount. Vehicle value belongs to the active VIN.

The agent reviews vehicle and driver summaries and chooses additions/navigation.
Explicit active driver/vehicle selection is necessary for multiple records.
Duplicate coverage question IDs without confirmed column/VIN scope require
review rather than copying the first vehicle's values across columns.

Driver license state comes from that driver's intake. Strip punctuation from
license number but retain every letter/digit, including state prefix. Exclusion
No is the demonstrated default. Three-year history needs driver-specific evidence
or agent review; a global claims answer is not proof for each driver. MVR/CLUE
ordering stays agent-controlled.

## More about business and filings

Optional email stays blank. Current insurance is Yes when the intake section is
filled; continuous coverage Yes and other business insurance None are user
standards. Use actual liability and expiration. An expired expiration must be
reviewed; the agent's demonstration date adjustment is not a transformation to
automate. Preserve zero named endorsement counts and No blanket endorsements.
ELD requires intake evidence, not a new default.

Filings requires both a USDOT number and an affirmative intake answer. Missing
USDOT with requested filings requires review. The all-commercial-vehicles question
is a factual attestation, not implied by a filings request. Agent confirmation is
required without independent quote inventory evidence. The demonstrated federal
filing and MCS-90 selection does not establish all filing types for every intake;
MCS-90's automatic behavior remains unresolved. Preserve it for review; do not
select state filings automatically.

## Rates, cargo, payment and print

Requested liability replaces the portal's initial limit. Target workflow UM/UIM
is $100k CSL; preserve $2,500 Full PIP. Use requested deductibles when identified.
Rental is $40/day, $1,200 maximum; roadside Selected; Fire/Theft Not selected;
equipment $0–$2,000. Exact IDs and vehicle column scope absent from the observations
must not be invented.

GL only when requested. The GL questions were narrated hypothetically, not live
verified, so absent mappings require review. Cargo uses its own expand control,
mobile/modular homes No and business documents/securities No, then Add a commodity,
Consumer Goods / Other Consumer Goods for generic general freight, requested
limit/deductible, and Done with this coverage. Other freight requires review.

Recalculate after coverage changes and closing cargo. Masked premiums are stale;
bill plans must wait for refreshed premium evidence and an enabled control.
Choose Automatic payments from checking account for quote preparation; it is not
bank enrollment. The agent continues back to Rates. Print, Email, Fax opens the
document page: Insurance Quote (with all bill plans), Print checked, Email/Fax
unchecked. Agent Fax Cover Page behavior remains unresolved. Print/Send generates
a quote document, not a sale. Completion is downloadable PDF availability, not
merely a successful click. No actual generated quote PDF has been identified or
verified in this task.

## Review behavior and verification limits

Unknown editable questions, missing evidence, ambiguous repeated controls,
conflicting text prefills, failed option matching and values lost during redraw
halt filling and downstream helpers. Known optional/preserved controls are
explicitly ignored. Automatic follow-ups and new-page filling remain paused until
the agent reviews/corrects the quote and explicitly retries Fill this page.
For an existing answer that is already correct, Keep current answer acknowledges
that field without forcing the agent to change it twice. Empty required answers
and ambiguous repeated vehicle fields still block filling.
Agent field identities and helper history are saved per tab/intake in Chrome
session storage; no new client values are stored by this workflow state.

Synthetic regression tests exercise actual fill-engine code, including redraw
rejection and unknown-field halts. They cannot establish compatibility with every
live ExtJS layout. A transformed/disappearing field whose acceptance cannot be
proven intentionally requires review. Existing simplified replay/bakeoff pages
are development aids, not an independently verified answer key.


## Local verification

The final regression run passed all 59 tests with `node --test "test/*.test.mjs"`.
The existing HTTP-server tests needed permission to bind localhost outside the
sandbox; they passed with that permission. New engine tests use synthetic native
and ExtJS component/DOM behavior, including unknown and changed questions, lost
answers, repeated IDs, stale premiums, disabled helpers, print channels, and newly
exposed versus preexisting PDF links. Normalization/plan tests cover the corrected
standards and missing-evidence gates. JavaScript syntax and `git diff --check`
passed. No production quote was changed and no real quote PDF was inspected.

To try this version, load the isolated worktree as an unpacked Chrome extension
(disable the old copy first), or integrate its changed source files into the
original extension folder and reload that extension. No commit, push or release
was made. The original folder and its notes were not edited by this worktree task.
