// Audit 2026-11-07, CARR-13: the buttons the extension never clicks itself (src/restricted.js), one
// list for the fill engine and the weekly signals. A committed corpus of commit buttons a carrier or
// product may show is always refused, and the buttons today's carriers' helpers and Continue click
// never are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_ADVANCE, NEVER_CLICK } from '../src/restricted.js';

const COMMITS = ['Bind', 'Bind Policy', 'Buy Now', 'Purchase', 'Submit', 'Submit Application', 'Finish', 'Save', 'Delete', 'Remove', 'Cancel', 'Discard Changes',
  'Order reports', 'Sign', 'eSignature', 'E-Sign', 'Log out', 'Sign out', 'Issue Policy', 'Pay Now', 'Make a Payment', 'Payment', 'Accept & Continue',
  'I Agree', 'Agree and Continue', 'Confirm Quote', 'Finalize Application', 'Finalise', 'Complete Purchase', 'Authorize', 'Authorise Payment', 'Certify', 'Attest'];
// What today's carriers click, as helper or as Continue (src/carriers/*.js, the mocks).
const HELPERS = ['View More Payment Plans', 'Recalculate', 'Print Quote Proposal', 'Verify Address', 'Verify USDOT', 'Look Up VIN', 'Import Data', 'Import Valid Records',
  'Default all answers to No', 'Bill Plan Options', 'Print, Email, Fax', 'Done with this coverage', 'Add Commodity', 'Add Another Vehicle', 'Add Trailer',
  'Yes, under permanent lease', 'Open New Application', 'Auto', 'Search', '+', 'Add Non-Trucking Liability instead?'];
const ADVANCES = ['Continue', 'Next', 'Save & Continue', 'Save and Continue', 'Looks Good'];

test('every commit button of the corpus is refused, as a helper and as Continue', () => {
  for (const words of COMMITS) {
    assert.ok(NEVER_ADVANCE.test(words), `Continue would click "${words}"`);
    assert.ok(NEVER_CLICK.test(words), `a helper would click "${words}"`);
  }
});

test('the buttons today\'s carriers click are not refused', () => {
  for (const words of HELPERS) assert.ok(!NEVER_CLICK.test(words), `a helper can't click "${words}"`);
  // Save & Continue reads as Continue (src/kit/actions.js findAdvanceButton).
  for (const words of ADVANCES) assert.ok(!NEVER_ADVANCE.test(words.replace(/^save\s*(?:&|and)\s*continue$/i, 'continue')), `Continue can't click "${words}"`);
});
