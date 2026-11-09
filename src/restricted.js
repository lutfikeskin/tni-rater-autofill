// @ts-check
// The words of a button the extension never clicks itself: binding, buying, paying, submitting,
// saving, deleting, ordering, signing or agreeing to something, or logging out (AGENTS.md: no
// binding, purchasing, submitting, ordering reports or signing). One list for the fill engine
// (src/kit/actions.js, built into the page kit) and the weekly signals (scripts/lib/signals.mjs),
// which counts a click reading as one of them as a safety finding. No imports: the kit's build
// takes it in as it is.
//
// Audit 2026-11-07, CARR-13: also issue, pay / payment, accept, agree, confirm, finalize, complete,
// authorize, certify and attest, words a new carrier or product can put on a commit button ("Issue
// Policy", "Pay Now", "Accept & Continue", "I Agree", "Confirm Quote", "Finalize Application").
// "Payment plans" (GEICO's View More Payment Plans, which only lists the plans) is not one.
const WORDS = 'finish|buy|bind|purchase|submit|save|delete|remove|cancel|discard|sign|signature|esign|esignature|e-sign|e-signature'
  + '|logout|log out|sign out|order|issue|pay|payments?(?!\\s+plans?\\b)|accept|agree|confirm|finali[sz]e|complete|authori[sz]e|certify|attest';

// What the fill never clicks to move on (Continue, Next and Start Quote are how it moves on).
export const NEVER_ADVANCE = new RegExp(`\\b(${WORDS})\\b`, 'i');
// What a helper click never is: those, and the ways on, which only `advance` clicks.
export const NEVER_CLICK = new RegExp(`\\b(continue|next|start quote|${WORDS})\\b`, 'i');
