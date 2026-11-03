// @ts-check
// The business classes the carriers' class-dependent answers are written for, read from the
// intake's business class (and, for AmWINS, what they haul). Each carrier imports the patterns it
// uses and lists them as its review-mode gate (`supportedClasses`, plan.js), so a class they don't
// match gets both the carrier's notes and review mode. The carriers' own answers and wording for
// these classes stay in their files.
//
// Progressive and GEICO read the same classes; AmWINS reads a broader pattern. Unifying them (and
// util.js's misspelling-tolerant GENERAL_FREIGHT) is TNI decision "Karar 1" in the refactor plan.

// An expediter, or a freight hauler class ("Freight Hauler", "General Freight Hauling"): the classes
// Progressive's for-hire and business-type answers were written for; GEICO lists the same.
export const EXPEDITER = /expedit/i;
export const FREIGHT_HAULER = /^(?:general\s+)?freight\s+haul(?:er|ing)$/i;
/** @param {any} r @returns {string} */
const businessClass = (r) => String(r.operations.businessClass ?? '').trim();
/** @param {any} r @returns {boolean} */
export const isExpediter = (r) => EXPEDITER.test(businessClass(r));
/** @param {any} r @returns {boolean} */
export const isFreightHauler = (r) => FREIGHT_HAULER.test(businessClass(r));
// A freight hauler of general freight, by its class or what they haul (Progressive's General Freight
// Trucking alias).
/** @param {any} r @returns {boolean} */
export const isGeneralFreightHauler = (r) => isFreightHauler(r) && /general\s+freight/i.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);

// AmWINS: the class or what they haul names expediting or general freight, read as one
// text, so a "Freight Hauler" of furniture is not one. Broader than the classes above on purpose.
export const EXPEDITING_OR_GENERAL_FREIGHT = /expedit|general\s*freight/i;
/** @param {any} r @returns {boolean} */
export const namesExpeditingOrGeneralFreight = (r) => EXPEDITING_OR_GENERAL_FREIGHT.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);
