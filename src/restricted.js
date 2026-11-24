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

// Progressive PA embeds an accessibility-only "(submit and move to next step)" caption inside every
// step button ("PRODUCTS (submit and move to next step)", "POINT OF SALE (submit and move to next
// step)"). Strip that exact suffix for advance buttons only when the visible step name before it is
// non-empty and is not a sale step (Point of Sale / Final Sale), so safe quote-step navigation reads
// as its visible label while Point of Sale, Final Sale, and any commit-worded button stay refused by
// NEVER_ADVANCE. Helpers (NEVER_CLICK) never strip it.
const STEP_SUBMIT_SUFFIX = /\s*\(submit and move to next step\)$/i;
const SALE_STEP = /\b(point of sale|final sale)\b/i;

/**
 * Strips Progressive PA's accessibility-only "(submit and move to next step)" suffix from a
 * non-sale step-advance button label while keeping commit words and sale steps intact.
 * @param {string} s
 * @returns {string}
 */
export function cleanAdvanceLabel(s) {
  const trimmed = String(s ?? '').trim();
  if (!STEP_SUBMIT_SUFFIX.test(trimmed)) return trimmed;
  const visible = trimmed.replace(STEP_SUBMIT_SUFFIX, '').trim();
  return visible && !SALE_STEP.test(visible) ? visible : trimmed;
}
