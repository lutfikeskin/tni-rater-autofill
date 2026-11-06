// @ts-check
// Agents' own defaults (docs/agent-defaults-spec.md): the step overlay buildPlan calls with each field
// step and its rule (PlanOptions `overlay`). It changes only a step whose source is `standard`:
//   - a rule whose own `std` names a replaced standard takes the agent's amount (source agent-default),
//     or becomes the agent's on "Ask me";
//   - where `std.applies` is false (GEICO's Texas UM split) the step keeps TNI's own exception, with
//     `defaultInfo` saying so (never `note`: the page kit leaves a step with a note to the agent);
//   - a dependent of a replaced standard (registry `dependents`) becomes the agent's, since its own
//     TNI answer assumes TNI's standard (GEICO's Basic PIP declined beside Medical Payments);
//   - a UM default above TNI's amount that the auto liability limit doesn't clear is the agent's.
// Every other step (intake, derived, fact, attestation) comes back as it went in.

import { STANDARD_IDS, usd } from '../standards.js';
import { REGISTRY } from './registry.js';

/** @import { CarrierRule, DefaultChoice, DefaultEntry, EffectiveDefaults, FieldStep, StepOverlay } from '../../types.js' */

export const AGENT_DEFAULT_SOURCE = 'agent-default';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** An amount as the panel says it: $1,000; rental $40/day, $1,200. @param {DefaultChoice} amount */
export const amountSaid = (amount) => (typeof amount === 'number' ? usd(amount) : `${usd(amount.perDay)}/day, ${usd(amount.max)}`);

// The auto liability limit as one amount, when the intake writes a combined single limit ($1M CSL,
// $750K, $1,000,000, 1000000); null for a split limit (25/50/25), State Minimum or anything else.
/** @param {unknown} text @returns {number | null} */
export function liabilityAmount(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s || s.includes('/')) return null;
  const m = s.match(/^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(m|mm|million|k)?\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] === 'k' ? 1_000 : m[2] ? 1_000_000 : 1;
  return n * unit;
}

/**
 * The step as the agent's to answer, with a note: never filled, never Luna's.
 * @param {Omit<FieldStep, 'resolution'>} step @param {string} note
 */
const agents = (step, note) => ({ ...step, source: 'fact', standard: false, reviewRequired: false, manualOnly: true, value: null, note });

/**
 * Does a registry dependent match this rule on this carrier?
 * @param {DefaultEntry['dependents'][number]} d @param {CarrierRule} rule @param {string} carrierId
 */
const dependentMatches = (d, rule, carrierId) => d.carrier === carrierId
  && (d.std ? rule.std?.id === d.std : (!d.concept || rule.concept === d.concept) && (!d.tni || rule.tni === d.tni));

/**
 * The overlay for one carrier's plan, from the defaults in force there (index.js effectiveDefaults).
 * @param {EffectiveDefaults} effective  registry id -> { value } or { ask: true }; only what differs from TNI's
 * @param {string} carrierId
 * @returns {StepOverlay}
 */
export function makeOverlay(effective, carrierId) {
  const replaced = REGISTRY.filter((e) => effective[e.id]);
  return (step, rule, { record, active }) => {
    if (step.source !== 'standard') return step;
    const std = rule.std;
    const mine = std ? effective[std.id] : null;
    if (std && mine) {
      const entry = REGISTRY.find((e) => e.id === std.id);
      const label = entry?.label ?? std.id;
      if (std.applies && !std.applies(record, active)) {
        return { ...step, defaultInfo: `${String(record.garaging?.state ?? '').toUpperCase() || 'Here'}: TNI's ${step.value} applies here (its own exception), not your default.` };
      }
      if ('ask' in mine) return { ...agents(step, `You chose to answer ${label.toLowerCase()} yourself (Settings → TNI defaults).`), agentDefault: { id: std.id, ask: true } };
      const tni = STANDARD_IDS[std.id]();
      const amount = mine.value;
      if (same(amount, tni)) return step;
      if (std.id === 'umCsl' && typeof amount === 'number' && amount > tni) {
        const liability = liabilityAmount(record.coverage?.autoLiabLimit);
        if (liability == null || amount > liability) {
          return { ...agents(step, `Your default UM of ${amountSaid(amount)} needs a liability limit at least as high, which the intake doesn't show: answer it yourself.`), agentDefault: { id: std.id, amount: amountSaid(amount), tni: amountSaid(tni) } };
        }
      }
      // A list condition giving TNI's own answer (GEICO's Medical Payments Not Included where it lists
      // no limit) is TNI's fallback, not the agent's amount: without it the step is the agent's there.
      const kept = step.onlyIf?.filter((x) => x.value == null) ?? null;
      const onlyIf = step.onlyIf && kept?.length !== step.onlyIf.length
        ? { onlyIf: kept?.length ? kept : null, onlyNote: `Your default ${label.toLowerCase()} of ${amountSaid(amount)} isn't offered here: answer it yourself.` }
        : {};
      return {
        ...step,
        ...onlyIf,
        source: AGENT_DEFAULT_SOURCE,
        standard: false,
        value: std.write(amount),
        name: std.name ? std.name(amount) : step.name,
        choiceAliases: std.aliases ? std.aliases(amount) : [],
        // An amount the carrier doesn't list here is the agent's at once, never a quiet return to TNI's.
        unofferedNote: std.unofferedNote ? std.unofferedNote(amount)
          : `Your default ${label.toLowerCase()} of ${amountSaid(amount)} isn't offered here (TNI's is ${amountSaid(tni)}): pick it yourself.`,
        agentDefault: { id: std.id, amount: amountSaid(amount), tni: amountSaid(tni) },
      };
    }
    const prerequisite = replaced.find((e) => e.dependents.some((d) => dependentMatches(d, rule, carrierId)));
    if (prerequisite) {
      const why = 'ask' in effective[prerequisite.id] ? 'which you chose to answer yourself' : 'which your default changes';
      return agents(step, `Answer this after ${prerequisite.label.toLowerCase()}, ${why}.`);
    }
    return step;
  };
}

/**
 * An overlay that never breaks a plan: a step it throws on goes to the agent with a note, and the
 * error is reported; every other step is unaffected.
 * @param {StepOverlay} overlay @param {(error: unknown, step: Omit<FieldStep, 'resolution'>) => void} [onError]
 * @returns {StepOverlay}
 */
export function safeOverlay(overlay, onError = () => {}) {
  return (step, rule, context) => {
    try {
      return overlay(step, rule, context);
    } catch (error) {
      onError(error, step);
      return step.source === 'standard' ? agents(step, 'Your default couldn\'t be applied: answer it yourself.') : step;
    }
  };
}

