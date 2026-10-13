// Replay benchmark: today's rules against the answers agents left in recorded quotes.
//
// For each recorded quote whose intake PDF is on this computer (matched by its fingerprint), the
// intake is read again with today's normalization (as of the day it was loaded), and every
// question the quote answered is given to the rule that claims it today, as the fill engine and
// the coverage report pair them (claimingRule: data-model name, then its text on its page; a field
// recorded before names falls back to the rule path that filled it). That rule's answer is
// compared with the quote's final answer (finalAnswers: autofill the agent kept, the agent's
// correction, the agent's own answer, or the page's answer the agent left).
//
// The agent's final answer is a proxy for the right one, not proof: a correction can be a
// legitimate exception for that client. Choice matching covers pagekit's exact, yes/no, state and
// dollar-amount tiers; a pick that depends on the page's options (a band, a prefix, "any but")
// is `unsure`. Typed text is never logged, so a text answer is compared through the intake paths
// the agent's text matched (matchesIntake) or the rule path that filled it.

import { normalizeIntake } from '../../src/normalize.js';
import { buildPlan } from '../../src/plan.js';
import { GENERIC_RULES } from '../../src/rules.js';
import { fieldInfo } from '../../src/schema.js';
import { matchIntake, normalizeForMatch } from '../../src/usage.js';
import { get, STATES } from '../../src/util.js';
import { quoteSessions, sessionContexts } from './events.mjs';
import { claimingRule } from './coverage.mjs';
import { finalAnswers } from './learn.mjs';

const CHOICE = new Set(['select', 'radio', 'checkbox', 'combo']);
// pagekit's normalisation for option text.
const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// pagekit's moneyTokens: "$1M CSL" -> [1000000], "$100k with a $1,000 Deductible" -> [100000, 1000].
function moneyTokens(s) {
  const out = [];
  for (const m of String(s).matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?\b/gi)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const unit = (m[2] ?? '').toLowerCase();
    if (unit === 'k' || unit === 'thousand') n *= 1e3;
    else if (unit) n *= 1e6;
    out.push(Math.round(n));
  }
  return out;
}

// Whether today's step would pick the option the quote ended on.
export function choiceVerdict(step, answer) {
  if (['pick-not', 'first-option', 'selected-option', 'address-suggest'].includes(step.kind)) return 'unsure';
  const got = squash(answer);
  if (step.kind === 'bool') {
    const yes = !!step.value;
    if (answer === 'checked' || answer === 'unchecked') return (answer === 'checked') === yes ? 'agree' : 'differ';
    if (/^(yes|y|true)$/.test(got)) return yes ? 'agree' : 'differ';
    if (/^(no|n|false)$/.test(got)) return yes ? 'differ' : 'agree';
    return 'unsure';
  }
  const cands = step.kind === 'state'
    ? [squash(step.value), squash(STATES[String(step.value).toUpperCase()])].filter(Boolean)
    : [step.value, ...(step.choiceAliases ?? [])].map(squash);
  if (cands.includes(got)) return 'agree';
  // A number matched to a band ("201-500", "More than 500 miles") depends on the page's options.
  if (step.kind === 'int') return 'unsure';
  const want = typeof step.value === 'number' ? [step.value] : moneyTokens(step.value);
  const have = moneyTokens(answer);
  if (want.length && have.length) return want.length === have.length && want.every((n, i) => n === have[i]) ? 'agree' : 'differ';
  // pagekit also takes the one option that starts with or contains the answer.
  if (cands.some((c) => (c.length >= 2 && got.startsWith(c)) || (c.length >= 3 && got.includes(c)))) return 'unsure';
  return 'differ';
}

// Whether today's step would type what the quote ended with. `answer`: { path } when the agent
// kept an autofill of that rule path, { matches } when the agent typed it (the intake paths it
// equalled; none: a value that isn't on the intake, or a cleared box).
export function textVerdict(step, answer, record) {
  if (['pick-not', 'first-option', 'selected-option', 'address-suggest'].includes(step.kind)) return 'unsure';
  const want = normalizeForMatch(step.kind === 'bool' ? (step.value ? 'Yes' : 'No') : step.value);
  if (answer.path) {
    if (answer.path === step.path) return 'agree';
    const before = get(record, answer.path);
    return before == null ? 'unsure' : normalizeForMatch(before) === want ? 'agree' : 'differ';
  }
  for (const m of answer.matches) {
    const part = m.endsWith(':part');
    const v = get(record, m.replace(/:part$/, ''));
    if (v == null) continue;
    if (part ? normalizeForMatch(v).includes(want) && want.length >= 3 : normalizeForMatch(v) === want) return 'agree';
  }
  // Today's value equals no intake field either (derived: an owner's first name, digits of a
  // phone): the agent's text, which matched none, may be the same.
  return matchIntake(record, String(step.value)).length ? 'differ' : 'unsure';
}

// What the quote ended on, and who gave it: `kept` (autofill the agent left), `corrected` (the
// agent changed our answer), `agent` (answered by the agent, not autofilled), `page` (the page's
// answer: one it gave, or a default the agent left). null: not known.
function truthOf(a, choice) {
  const group = a.corrected ? 'corrected' : a.autofilled && a.source === 'autofill' ? 'kept' : a.source === 'agent' ? 'agent' : a.source === 'page' ? 'page' : null;
  if (!group) return null;
  if (choice) return a.value == null || a.value === '' ? null : { group, value: a.value };
  if (group === 'kept') return a.mappedPath ? { group, path: a.mappedPath } : null;
  return a.matches ? { group, matches: a.matches } : null;
}

// The vehicle, driver or trailer a page is about, from the answer's unit (`<view unit>@<row>`).
function activeOf(unit) {
  const m = String(unit).split('@')[0].match(/^(v|d|tr)(\d+)$/);
  return m ? { [{ v: 'vehicles', d: 'drivers', tr: 'trailers' }[m[1]]]: Number(m[2]) } : {};
}

// A rule's kind of step, as buildPlan gives it.
const kindOf = (rule) => rule.kind ?? (rule.path ? fieldInfo(rule.path).kind : 'text');

// A rule by the path its step had when it filled (a field recorded before names, which no rule
// claims by text today): `drivers[0].dob` is `drivers[].dob`, `progressive.q2B9` its q.
function ruleByPath(carrier, path) {
  if (!path) return null;
  const want = path.replace(/\[\d+\]/g, '[]');
  const rules = [...(carrier.rules ?? []), ...(carrier.useGenericRules === false ? [] : GENERIC_RULES)];
  return rules.find((r) => (r.path ?? (r.q ? `${carrier.id}.q${r.q}` : null)) === want) ?? null;
}

// A question without an id (AmWINS) is found by its element id or data-id, which its events don't
// carry: from the quote's own layouts of that page and step (any step when the event names none), by
// the question's text, when every field reading it there has the same ids.
function elementIds(events) {
  const seen = new Map();
  for (const e of events) {
    if (e.type !== 'page_layout' || !e.session) continue;
    for (const f of e.fields ?? []) {
      if (f.q || (!f.id && !f.dataId) || !squash(f.label)) continue;
      // Also under any step: an answer whose event names no step.
      for (const step of [e.step ?? '', '*']) {
        const k = `${e.session}|${e.page}|${step}|${squash(f.label)}`;
        const ids = seen.get(k) ?? new Map();
        ids.set(`${f.id}|${f.dataId}`, { id: f.id ?? null, dataId: f.dataId ?? null });
        seen.set(k, ids);
      }
    }
  }
  return (session, a) => {
    const ids = seen.get(`${session}|${a.page}|${a.step ?? '*'}|${squash(a.label)}`);
    return ids?.size === 1 ? [...ids.values()][0] : null;
  };
}

// Today's answer for one recorded question: { status, step?, rule?, pairedBy? }. status: `none`
// (no rule claims it; the agent's), `unsure` (only a selector might claim it, or which unit's row
// can't be told), `agent` (a rule leaves it to the agent), `ignored`, `blank` (no answer from this
// intake), or `value`.
function today(a, unit, record, carrier, element) {
  const f = { ref: a.ref ?? a.layout?.ref ?? undefined, caption: a.layout?.caption ?? a.label, kind: a.layout?.kind ?? a.kind, ...(element ?? {}) };
  let claim = claimingRule(f, carrier, a.page);
  // A checkbox takes only a yes/no rule (pagekit `fits`): the fill engine goes on to the next rule.
  const skipped = new Set();
  while (f.kind === 'checkbox' && claim.def && kindOf(claim.def) !== 'bool' && skipped.size < 20) {
    skipped.add(claim.def);
    const rules = [...(carrier.rules ?? []), ...(carrier.useGenericRules === false ? [] : GENERIC_RULES)].filter((r) => !skipped.has(r));
    claim = claimingRule(f, { ...carrier, rules, useGenericRules: false }, a.page);
    claim.generic = !!claim.def && GENERIC_RULES.includes(claim.def);
  }
  let rule = claim.def;
  let pairedBy = 'page';
  // A question without an id (AmWINS) is paired by its text alone, which can't say whether a
  // selector rule would have found it first (a recording without element ids, before 0.8.1) or
  // whether it sits in a row section, where label rules never answer (rowSections). Then only the
  // rule that filled it in that quote pairs it.
  const unclear = !a.q && (claim.passedUnsure || (claim.status === 'unsure' && !claim.unnamed) || (claim.generic && carrier.rowSections?.length));
  if (unclear) {
    rule = ruleByPath(carrier, a.mappedPath);
    if (!rule) return { status: 'unsure', reason: element ? 'row section' : 'no element ids' };
    pairedBy = 'path';
  } else if (claim.status === 'unsure' && !claim.unnamed) {
    return { status: 'unsure', rule: claim.rule, reason: 'selector' };
  } else if (claim.status === 'none') {
    rule = ruleByPath(carrier, a.mappedPath);
    pairedBy = 'path';
    if (!rule) return { status: 'none' };
  } else if (claim.generic && !f.ref) {
    // A field recorded without its data-model name, which a generic label rule claims by text: the
    // carrier's own rule that filled it in that quote finds it by name on the live page.
    const own = ruleByPath(carrier, a.mappedPath);
    if (own && (carrier.rules ?? []).includes(own)) { rule = own; pairedBy = 'path'; }
  }
  const name = rule.name ?? rule.path ?? rule.q ?? rule.label;
  const active = activeOf(unit);
  const steps = buildPlan(record, { ...carrier, rules: [rule], useGenericRules: false, actions: [] }, active).filter((s) => s.kind !== 'action');
  if (!steps.length) return { status: 'blank', rule: name, pairedBy };
  // Several units' steps (Rates rows, a driver list): the page's own unit, else one answer for all.
  const own = steps.filter((s) => s.activeVehicle === true);
  const pick = own.length === 1 ? own : steps;
  const same = new Set(pick.map((s) => JSON.stringify([s.value, s.note, s.ignore]))).size === 1;
  if (!same) return { status: 'unsure', rule: name, pairedBy, reason: 'which unit' };
  const step = pick[0];
  if (step.ignore) return { status: 'ignored', rule: name, pairedBy };
  if (step.note && step.value == null) return { status: 'agent', rule: name, pairedBy };
  if (step.value == null) return { status: 'blank', rule: name, pairedBy };
  return { status: 'value', step, rule: name, pairedBy };
}

// What a step's value reads as in the report (choices only: typed text is never shown).
const shown = (step, kind) => (step.kind === 'bool' ? (kind === 'checkbox' ? (step.value ? 'checked' : 'unchecked') : step.value ? 'Yes' : 'No')
  : typeof step.value === 'object' ? null : String(step.value));

/**
 * @param {object[]} events  from loadEvents()
 * @param {{carriers: object[], raws: Map<string, object>}} opts  raws: intake fingerprint -> the
 *   PDF's fields (readIntakeFields)
 * @returns {{rows: object[], quotes: number, replayed: number, missing: string[], edited: number}}
 *   one row per recorded answer: result `agree`, `differ`, `unsure`, `blank` (no answer today),
 *   `left` (the agent's today: no rule, or one that leaves it), or `unknown` (the quote's answer
 *   isn't known)
 */
export function benchmark(events, { carriers, raws }) {
  const contexts = sessionContexts(events);
  const quotes = quoteSessions(events);
  const answers = finalAnswers(events);
  const byId = new Map(carriers.map((c) => [c.id, c]));
  // The agent corrected the intake in the panel: the PDF read again doesn't hold those corrections.
  const editedSessions = new Set(events.filter((e) => e.type === 'intake_edit' && e.session).map((e) => e.session));
  const elementOf = elementIds(events);
  const rows = [];
  const missing = new Set();
  let replayed = 0;
  for (const [session, perSession] of answers) {
    const ctx = contexts.get(session);
    if (!quotes.has(session) || !ctx) continue;
    const raw = raws.get(ctx.intakeId);
    if (!raw) { missing.add(ctx.intakeId); continue; }
    replayed++;
    const { record } = normalizeIntake(raw, { today: new Date(ctx.t) });
    for (const [key, a] of perSession) {
      const carrier = byId.get(a.carrier);
      if (!carrier) continue;
      const unit = a.q ? key.slice(key.lastIndexOf('#') + 1) : '';
      const kind = a.layout?.kind === 'combo' ? 'combo' : a.kind ?? a.layout?.kind;
      const choice = CHOICE.has(kind);
      const truth = truthOf(a, choice);
      const now = today(a, unit, record, carrier, a.q ? null : elementOf(session, a));
      let result;
      let reason = now.reason ?? null;
      if (!truth) result = 'unknown';
      else if (now.status === 'value') {
        result = choice ? choiceVerdict(now.step, truth.value) : textVerdict(now.step, truth, record);
        if (result === 'unsure') reason = choice ? 'depends on the page\'s options' : 'derived or suggested text';
      } else result = { none: 'left', agent: 'left', ignored: 'left', blank: 'blank', unsure: 'unsure' }[now.status];
      rows.push({
        id: `${session}|${key}`,
        session,
        intakeId: ctx.intakeId,
        carrier: a.carrier,
        question: a.question,
        page: a.page,
        ...(a.step ? { step: a.step } : {}),
        label: a.layout?.caption ?? a.label ?? '',
        kind: kind ?? null,
        group: truth?.group ?? null,
        // Choices only: the option the quote ended on, the one we filled, and today's.
        answer: choice ? truth?.value ?? null : null,
        filled: choice && a.autofilled ? a.filledValue ?? null : null,
        today: choice && now.step ? shown(now.step, kind) : null,
        status: now.status,
        rule: now.rule ?? null,
        pairedBy: now.pairedBy ?? null,
        result,
        ...(result === 'unsure' ? { reason } : {}),
        intakeEdited: editedSessions.has(session),
      });
    }
  }
  return { rows, quotes: [...answers.keys()].filter((s) => quotes.has(s)).length, replayed, missing: [...missing], edited: [...editedSessions].filter((s) => rows.some((r) => r.session === s)).length };
}

// Counts by who gave the quote's answer and how today's rules answer it.
export function summarize(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.group) continue;
    const g = (out[r.group] ??= { total: 0, agree: 0, differ: 0, unsure: 0, blank: 0, left: 0 });
    g.total++;
    g[r.result]++;
  }
  return out;
}

// What today's rules do with a question when they give it no value.
const NOW = { none: 'no rule', agent: 'agent\'s', ignored: 'left alone', blank: 'no answer from the intake', unsure: '?' };

// One line per question for a kind of change: how many answers and intakes, and the picks.
export function byQuestion(rows) {
  const out = new Map();
  for (const r of rows) {
    const q = out.get(r.question) ?? { question: r.question, carrier: r.carrier, page: r.page, step: r.step, label: r.label, rule: r.rule, answers: 0, intakes: new Set(), pairs: new Map(), edited: 0 };
    q.answers++;
    q.intakes.add(r.intakeId);
    if (r.intakeEdited) q.edited++;
    if (r.answer != null || r.today != null || r.status !== 'value') {
      const now = r.today ?? NOW[r.status] ?? '?';
      const pair = r.answer != null ? `${now} → agent ${r.answer}` : now;
      q.pairs.set(pair, (q.pairs.get(pair) ?? 0) + 1);
    }
    out.set(r.question, q);
  }
  return [...out.values()].map((q) => ({ ...q, intakes: q.intakes.size, pairs: [...q.pairs].sort((x, y) => y[1] - x[1]) }))
    .sort((a, b) => b.intakes - a.intakes || b.answers - a.answers);
}

// Kinds of change between two runs, the ones to check first first.
export const CHANGES = [
  ['differs', 'now differs from the agent'],
  ['handed', 'handed to the agent'],
  ['agrees', 'now agrees'],
  ['withdrawn', 'a differing answer withdrawn'],
  ['other', 'other'],
];

// What a change of result means: a new answer unlike the agent's (`differs`), an answer that
// agreed now left to the agent (`handed`: more work, not a wrong answer), a new agreement, a
// differing answer no longer given (`withdrawn`), or a change to or from unsure.
export function changeKind(was, now) {
  if (now === 'differ') return 'differs';
  if (now === 'agree') return 'agrees';
  if (was === 'agree' && (now === 'left' || now === 'blank')) return 'handed';
  if (was === 'differ' && (now === 'left' || now === 'blank')) return 'withdrawn';
  return 'other';
}

// Answers whose result changed between two saved runs (the same quotes, before and after a rule change).
export function compareRuns(before, after) {
  const prev = new Map(before.map((r) => [r.id, r]));
  const changed = [];
  for (const r of after) {
    const p = prev.get(r.id);
    if (p && p.result !== r.result) changed.push({ ...r, was: p.result, wasToday: p.today, change: changeKind(p.result, r.result) });
  }
  return changed;
}
