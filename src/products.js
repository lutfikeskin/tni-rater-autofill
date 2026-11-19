// @ts-check
// Insurance products (lines of business) the extension supports.
// Today only Commercial Auto is implemented; every carrier config and normalized client record
// declares its product so a second line of business (e.g. Personal Auto) can coexist cleanly.

/** @import { ClientRecord, Product } from '../types.js' */

/** @type {Product[]} */
export const PRODUCTS = [
  { id: 'commercial-auto', name: 'Commercial Auto' },
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
