// @ts-check
// Insurance products (lines of business) the extension supports.
// Every carrier config and normalized client record declares its product; the loaded intake's
// product picks the carrier configs for a tab (src/carriers.js carrierForUrl). Personal Auto reads
// its intake and has carrier configs without rules yet (src/products/personal-auto/).

/** @import { ClientRecord, Product } from '../types.js' */

/** @type {Product[]} */
export const PRODUCTS = [
  { id: 'commercial-auto', name: 'Commercial Auto' },
  { id: 'personal-auto', name: 'Personal Auto' },
];

export const DEFAULT_PRODUCT = 'commercial-auto';

const PRODUCT_IDS = new Set(PRODUCTS.map((p) => p.id));

/**
 * Product id of a client record, defaulting to Commercial Auto when `product` is absent or not in
 * PRODUCTS (records saved before `product` existed, from a newer build, or corrupted).
 * @param {ClientRecord | null | undefined} record
 * @returns {string}
 */
export function productOf(record) {
  const id = record?.product;
  return typeof id === 'string' && PRODUCT_IDS.has(id) ? id : DEFAULT_PRODUCT;
}
