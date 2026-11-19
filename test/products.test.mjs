// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PRODUCTS, DEFAULT_PRODUCT, productOf } from '../src/products.js';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, UNKNOWN_INTAKE_ERROR } from '../src/normalize.js';
import { INTAKE_FORMS, detectIntakeForm, readIntake } from '../src/intake-forms.js';
import { CARRIERS, carrierForUrl } from '../src/carriers.js';

/** @import { CarrierConfig, IntakeForm } from '../types.js' */

const fixture = new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake.pdf', import.meta.url)));
const raw = await readIntakeFields(pdfjs, fixture);

test('PRODUCTS catalog, DEFAULT_PRODUCT, and productOf defaults and validation', () => {
  assert.equal(DEFAULT_PRODUCT, 'commercial-auto');
  assert.deepEqual(PRODUCTS, [{ id: 'commercial-auto', name: 'Commercial Auto' }]);

  assert.equal(productOf({ product: 'commercial-auto' }), 'commercial-auto');
  // Unknown products (e.g. a record from a newer build or corrupted value) fall back to DEFAULT_PRODUCT.
  assert.equal(productOf({ product: 'personal-auto' }), DEFAULT_PRODUCT);
  assert.equal(productOf({ product: 'future-line-of-business' }), DEFAULT_PRODUCT);
  assert.equal(productOf({ product: '' }), DEFAULT_PRODUCT);
  assert.equal(productOf(/** @type {any} */ ({ product: 42 })), DEFAULT_PRODUCT);
  // Records saved before `product` existed and fixtures omitting it default to Commercial Auto.
  assert.equal(productOf({ applicant: { name: 'Legacy LLC' } }), DEFAULT_PRODUCT);
  assert.equal(productOf({ product: undefined }), DEFAULT_PRODUCT);
  assert.equal(productOf(/** @type {any} */ ({ product: null })), DEFAULT_PRODUCT);
  assert.equal(productOf(null), DEFAULT_PRODUCT);
  assert.equal(productOf(undefined), DEFAULT_PRODUCT);
});

test('normalizeIntake stamps product: commercial-auto on the returned record', () => {
  const result = normalizeIntake(raw, { today: new Date('2026-09-30') });
  assert.ok(!('error' in result));
  assert.equal(result.record.product, 'commercial-auto');
  assert.equal(productOf(result.record), 'commercial-auto');
});

test('detectIntakeForm and readIntake handle the commercial-auto fixture and stamp form id', () => {
  const form = detectIntakeForm(raw);
  assert.ok(form);
  assert.equal(form.id, 'tni-commercial-auto');
  assert.equal(form.product, 'commercial-auto');
  assert.equal(form.name, 'TNI Commercial Quote Application');

  const today = new Date('2026-09-30');
  const viaRegistry = readIntake(raw, { today });
  const direct = normalizeIntake(raw, { today });
  assert.ok(!('error' in viaRegistry));
  assert.ok(!('error' in direct));
  assert.equal(viaRegistry.form, 'tni-commercial-auto');
  assert.equal(viaRegistry.record.product, 'commercial-auto');
  const { form: _formId, ...withoutForm } = viaRegistry;
  assert.deepEqual(withoutForm, direct);
});

test('readIntake returns the sole form error with one form and names all forms with several', () => {
  const unknown = { some_other_field: 'hello', another_field: 'world' };
  assert.equal(detectIntakeForm(unknown), null);

  // One registered form: exact error from that form (identical to normalizeIntake today).
  const single = readIntake(unknown);
  const direct = normalizeIntake(unknown);
  assert.deepEqual(single, direct);
  assert.deepEqual(single, { error: UNKNOWN_INTAKE_ERROR });

  // Several registered forms: error names every registered form.
  /** @type {IntakeForm} */
  const secondForm = {
    id: 'tni-personal-auto',
    product: 'personal-auto',
    name: 'TNI Personal Auto Application',
    detect: (fields) => Boolean(fields.pa_named_insured),
    normalize: () => ({ error: 'Not a Personal Auto application.' }),
  };
  const multi = readIntake(unknown, { forms: [...INTAKE_FORMS, secondForm] });
  assert.ok('error' in multi);
  assert.match(multi.error, /TNI Commercial Quote Application/);
  assert.match(multi.error, /TNI Personal Auto Application/);
});

test('detectIntakeForm and readIntake route to a second form, stamp form and record.product, and pass options through', () => {
  /** @type {Date | undefined} */
  let receivedToday;
  /** @type {IntakeForm} */
  const personalAutoForm = {
    id: 'tni-personal-auto',
    product: 'personal-auto',
    name: 'TNI Personal Auto Application',
    detect: (fields) => Boolean(fields.pa_named_insured && fields.pa_garaging_zip),
    // Intentionally omits `record.product` to verify readIntake guarantees `record.product === form.product`.
    normalize: (fields, opts) => {
      receivedToday = opts?.today;
      return {
        record: {
          applicant: { name: String(fields.pa_named_insured) },
          garaging: { zip: String(fields.pa_garaging_zip) },
        },
        warnings: [],
        stats: { fields: 2, filled: 2 },
        rows: { drivers: [], vehicles: [], trailers: [] },
        readFrom: {},
      };
    },
  };

  const forms = [...INTAKE_FORMS, personalAutoForm];
  const paRaw = { pa_named_insured: 'Jane Doe', pa_garaging_zip: '33101' };

  assert.equal(detectIntakeForm(paRaw, forms)?.id, 'tni-personal-auto');
  assert.equal(detectIntakeForm(raw, forms)?.id, 'tni-commercial-auto');

  const today = new Date('2026-11-15');
  const result = readIntake(paRaw, { forms, today });
  assert.ok(!('error' in result));
  assert.equal(receivedToday, today);
  assert.equal(result.form, 'tni-personal-auto');
  assert.equal(result.record.product, 'personal-auto');
  assert.equal(result.record.applicant.name, 'Jane Doe');
  // Production registry was not mutated.
  assert.equal(INTAKE_FORMS.length, 1);
});

test('carrierForUrl preserves existing behavior when product is omitted and filters when provided', () => {
  const progUrl = 'https://clpolicy.foragentsonly.com/Express/Default.aspx';
  const geicoUrl = 'https://sales.geico.com/quote';
  const amwinsUrl = 'https://agency.amwinsadmittedplacement.com/quote/1';

  assert.equal(carrierForUrl(progUrl)?.id, 'progressive');
  assert.equal(carrierForUrl(progUrl, { product: null })?.id, 'progressive');
  assert.equal(carrierForUrl(progUrl, { product: 'commercial-auto' })?.id, 'progressive');
  assert.equal(carrierForUrl(geicoUrl, { product: 'commercial-auto' })?.id, 'geico');
  assert.equal(carrierForUrl(amwinsUrl, { product: 'commercial-auto' })?.id, 'amwins');
  assert.equal(carrierForUrl(progUrl, { product: 'personal-auto' }), null);
  assert.equal(carrierForUrl('http://localhost:8123/test/fixtures/geico/quote.html', { product: 'commercial-auto' })?.id, 'geico');
  assert.equal(carrierForUrl('http://localhost:8123/test/fixtures/geico/quote.html', { product: 'personal-auto' }), null);
});

test('carrierForUrl disambiguates carriers sharing a host across products', () => {
  /** @type {CarrierConfig[]} */
  const carriers = [
    {
      id: 'progressive',
      name: 'Progressive',
      product: 'commercial-auto',
      hosts: [/(^|\.)foragentsonly\.com$/i],
      rules: [],
      useGenericRules: false,
    },
    {
      id: 'progressive-pa',
      name: 'Progressive Personal Auto',
      product: 'personal-auto',
      hosts: [/(^|\.)foragentsonly\.com$/i],
      rules: [],
      useGenericRules: false,
    },
  ];
  const url = 'https://www.foragentsonly.com/quote/start';

  // Omitted / null product keeps first-match behavior.
  assert.equal(carrierForUrl(url, { carriers })?.id, 'progressive');
  assert.equal(carrierForUrl(url, { product: null, carriers })?.id, 'progressive');
  // Explicit product selects the matching product's carrier.
  assert.equal(carrierForUrl(url, { product: 'commercial-auto', carriers })?.id, 'progressive');
  assert.equal(carrierForUrl(url, { product: 'personal-auto', carriers })?.id, 'progressive-pa');
  // Non-matching product returns null rather than falling back.
  assert.equal(carrierForUrl(url, { product: 'homeowners', carriers }), null);
  // Production CARRIERS list was not mutated.
  assert.ok(CARRIERS.every((c) => c.product === 'commercial-auto'));
});
