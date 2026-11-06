// @ts-check
// Agents' own defaults (docs/agent-defaults-spec.md): the TNI standards an agent may replace, data
// only. An override reaches only the rules whose own `std` names its id (CarrierRule `std`), never
// everything sharing a `tni` id or concept. Taking an entry out puts that standard back to TNI's
// everywhere; a stored default whose id isn't here is ignored.
//
// `choices`: the amounts offered, as the carriers' captured layouts list them (captures/<carrier>/
// generated, 2026-10 and 2026-11; local, not committed). `all` is what the TNI defaults page offers:
// amounts every carrier sells. A carrier's own list is what its Advanced row offers.
// `dependents`: other answers whose own TNI answer assumes this standard is TNI's (PIP declined beside
// Medical Payments; GEICO's rental behind comprehensive and collision). When this standard is replaced
// or asked, they become the agent's, where their own source is `standard` (overlay.js).
// Owner drives and the other workflow standards are not here: other code reads their assumptions
// straight from the record (ownerDrives() in src/answers/owner.js), which no step overlay reaches.

/** @import { DefaultEntry } from '../../types.js' */

const RENTAL = (perDay, max) => ({ perDay, max });

/** @type {readonly DefaultEntry[]} */
export const REGISTRY = Object.freeze([
  {
    id: 'umCsl',
    label: 'Uninsured / underinsured motorist (CSL)',
    choices: {
      all: [100_000, 300_000, 500_000, 750_000, 1_000_000],
      progressive: [50_000, 100_000, 125_000, 200_000, 300_000, 350_000, 500_000, 750_000, 1_000_000],
      amwins: [100_000, 300_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000],
      geico: [100_000, 200_000, 300_000, 500_000, 600_000, 750_000, 1_000_000, 1_500_000, 2_000_000],
    },
    dependents: [],
  },
  {
    id: 'medPay',
    label: 'Medical payments',
    choices: {
      all: [500, 1_000, 2_000, 5_000],
      progressive: [500, 1_000, 2_000, 5_000, 10_000, 25_000, 50_000],
      amwins: [500, 1_000, 2_000, 5_000, 10_000, 25_000],
      geico: [500, 1_000, 2_000, 5_000],
    },
    // PIP is declined because Medical Payments is TNI's (W44-26).
    dependents: [{ carrier: 'geico', concept: 'coverage.pip', tni: 'geico.medpay-pip' }, { carrier: 'amwins', concept: 'coverage.pip', tni: 'amwins.medpay-pip' }],
  },
  {
    id: 'compDeductible',
    label: 'Comprehensive deductible',
    choices: {
      all: [100, 250, 500, 1_000],
      progressive: [100, 150, 250, 500, 750, 1_000, 1_500, 2_000, 2_500, 5_000],
      amwins: [100, 250, 500, 1_000],
      geico: [100, 250, 500, 1_000, 2_500, 5_000],
    },
    // GEICO's rental follows comprehensive and collision (W43-22).
    dependents: [{ carrier: 'geico', std: 'rental' }],
  },
  {
    id: 'collDeductible',
    label: 'Collision deductible',
    choices: {
      all: [100, 250, 500, 1_000],
      progressive: [50, 100, 150, 200, 250, 500, 750, 1_000, 1_500, 2_000, 2_500, 5_000],
      amwins: [100, 250, 500, 1_000],
      geico: [100, 250, 500, 1_000, 2_500, 5_000],
    },
    dependents: [{ carrier: 'geico', std: 'rental' }],
  },
  {
    id: 'rental',
    label: 'Rental reimbursement',
    choices: {
      all: [RENTAL(30, 900), RENTAL(40, 1_200), RENTAL(50, 1_500), RENTAL(100, 3_000)],
      progressive: [RENTAL(30, 900), RENTAL(40, 1_200), RENTAL(50, 1_500), RENTAL(70, 2_100), RENTAL(80, 2_400), RENTAL(90, 2_700), RENTAL(100, 3_000), RENTAL(125, 3_750), RENTAL(150, 4_500)],
      amwins: [RENTAL(30, 900), RENTAL(40, 1_200), RENTAL(50, 1_500), RENTAL(75, 2_250), RENTAL(100, 3_000)],
      geico: [RENTAL(30, 900), RENTAL(40, 1_200), RENTAL(50, 1_500), RENTAL(70, 2_100), RENTAL(80, 2_400), RENTAL(100, 3_000), RENTAL(125, 3_750), RENTAL(150, 4_500)],
    },
    dependents: [],
  },
]);

/** @param {string} id */
export const entryOf = (id) => REGISTRY.find((e) => e.id === id) ?? null;
