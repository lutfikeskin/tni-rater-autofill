// @ts-check
// The side panel: the one way it builds a plan.
// One part of the panel; sidepanel.js wires the parts together.
//
// Every panel caller goes through planFor, so the plan that fills, the plan the usage log rebuilds
// and the plan Luna's report comes from are built alike. A hook that changes plan steps (buildPlan's
// `overlay`, docs/agent-defaults-spec.md) plugs in here only; test/plan-hooks.test.mjs fails if a
// panel file calls buildPlan directly. Today nothing plugs in: the plan is the rules' own.

import { buildPlan } from '../../src/plan.js';

/** @import { ActiveUnits, CarrierConfig, ClientRecord, PlanStep } from '../../types.js' */

/**
 * @param {ClientRecord} record
 * @param {CarrierConfig | null} carrier
 * @param {ActiveUnits} [active]
 * @returns {PlanStep[]}
 */
export function planFor(record, carrier, active = {}) {
  return buildPlan(record, carrier, active);
}
