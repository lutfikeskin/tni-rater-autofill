# Intake and extension report review

Historical review from 2026-10-01. Statements about missing features describe that revision, not current support. Read only when tracing these reports; use [corrections](corrections.md) for the current investigation workflow.

Reviewed the supplied intake with the production PDF reader and normalizer,
the `layouts/` captures, and the six `problem_report` events in the October 1 log.
No customer identifiers or typed values are included here.

## Confirmed fixes

- Freight Hauler is present in the intake. General freight maps to General Freight
  Hauler, with General Freight Trucking accepted as the portal wording. The remote
  dropdown search is tested when the initial alphabetic list lacks the option.
- Blank company name means Individual / Sole Proprietor. Use the owner name when
  the portal asks for the sole proprietor's insured name.
- The supplied intake repeats the first name in the sole driver's surname box.
  Match its DOB only when the owner explicitly drives and that sole driver's first
  name agrees; retain the surname from the owner section. Ambiguous driver matches
  remain unresolved.
- A prefilled insurance type without limit and expiry means currently insured No.
  The hidden dependent current-policy questions should not request missing data.
- Currency formatting such as `$25,000.00` equals the intake amount `25000`;
  `$250,000.00` does not. This prevents formatting-only acceptance failures.
- The Print/Send predecessor-history blocker was already fixed. The captured
  insurance quote and Print selections now establish readiness on that page.
- Newly encountered coverage IDs remain yellow warnings and are logged. The
  captures do not establish an agency default for UMPD or medical payments.

## Remaining reports

- ChangePaymentPlan Continue: the capture confirms this button exists. Automatic
  navigation is not implemented; the existing global Continue exclusion remains.
- VehicleSummary Add Vehicle: the capture distinguishes Add, Add Vehicle and Add
  Trailer. No automatic Add Vehicle action is currently implemented.
- ELD answer rejection: a subsequent capture retains No. A value-free layout
  cannot establish why a prior server response rejected or redrew the answer.
  No acceptance check has been bypassed based on this evidence.
