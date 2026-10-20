// TNI's answer key: the right answer to each question a set of recorded quotes met, as a reviewer at
// TNI decided it, and today's rules scored against it.
//
// The benchmark (benchmark.mjs) compares today's rules with the agents' final answers, which are a
// proxy for the right ones. The key replaces the proxy for the quotes it covers: `npm run
// key:sheet` writes a local review page from the benchmark's pairing of questions and rules, the
// reviewer decides each answer there and saves key.json, and `npm run benchmark -- --key` scores
// today's rules (and, apart, the agents' answers) against it.
//
// A key entry's answer is one of:
//   { value }            this answer: a TNI standard or another fixed answer
//   { fromIntake: path } the intake's answer at that record path (`drivers[].dob`: the unit's
//                        driver); a blank intake answer is missing information, so the agent's
//   { agent: true }      the agent's: a client fact the intake doesn't give, or an attestation
//   { na: true }         not applicable: nobody should answer it
//   { perQuote: true }   (question entries only) it depends on the client: see each quote's entry
// with `by` (the reviewer) and `date`. A question entry may name the `states` it holds for.
// `proposed: true` marks an entry the reviewer confirmed as the sheet proposed it, without changing
// or typing it. A proposal is today's rule answer (or the agent's), so such entries agree with the
// rules by construction: scores are given for all entries and for the decided ones (the rest) apart.
//
// Question entries are keyed by question identity as the learner and benchmark group answers
// (`<carrier>|<page>|ref:<name>`, else the question's text on its page; AmWINS by page, step and
// text), never by a question id, which Progressive renumbers. A quote's entries are keyed by the
// intake's fingerprint, then the identity and unit (`…#v0@1`: vehicle 0, row 1) and win over the
// question's. Only quotes of the intakes listed under `quotes` are scored: the key holds for the
// quotes it was decided on. key.json, the review page and the PDFs hold client answers: they stay in
// ignored `layouts/`.

import fs from 'node:fs';
import { SECTIONS } from '../../src/schema.js';
import { matchIntake, normalizeForMatch } from '../../src/usage.js';
import { get } from '../../src/util.js';
import { activeOf, choiceVerdict, shown } from './benchmark.mjs';

export const KEY_KIND = 'tni-answer-key';
const KINDS = ['value', 'fromIntake', 'agent', 'na', 'perQuote'];
const CHOICE = new Set(['select', 'radio', 'checkbox', 'combo']);
// A record path: `applicant.name`, `drivers[].dob`, `vehicles[0].vin`.
const PATH = /^[A-Za-z_]\w*(\[\d*\])?(\.[A-Za-z_]\w*(\[\d*\])?)*$/;

// Which kind of answer an entry holds, or null when it holds none (or two).
export function answerKind(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const ks = Object.keys(answer).filter((k) => KINDS.includes(k));
  if (ks.length !== 1) return null;
  const [k] = ks;
  if (k === 'value') return ['string', 'number', 'boolean'].includes(typeof answer.value) && String(answer.value).trim() !== '' ? k : null;
  if (k === 'fromIntake') return typeof answer.fromIntake === 'string' && PATH.test(answer.fromIntake) ? k : null;
  return answer[k] === true ? k : null;
}

// A question named only by its id (`q:2B0`, or a bare number: no data-model name or text) can't be
// keyed: the id may name another question next month.
export const byIdOnly = (question) => {
  const name = String(question).split('|').slice(2).join('|');
  return /^q:/.test(name) || /^\d+$/.test(name);
};

// The quote's own pages: not a carrier's login or portal pages (Progressive's are recorded by path,
// its quote pages by name), nor another product's application (AmWINS' commercial property).
export function quotePage(carrier, page) {
  const p = String(page ?? '');
  if (/\/(auth\/)?login\b/i.test(p)) return false;
  if (carrier === 'progressive') return !p.startsWith('/');
  if (carrier === 'amwins') return p.startsWith('/application/businessauto');
  return true;
}

export const keyable = (row) => !byIdOnly(row.question) && quotePage(row.carrier, row.page);

/** Checks a parsed key.json and returns it with its parts filled in; throws on a bad one. */
export function readKey(json) {
  if (json?.kind !== KEY_KIND) throw new Error(`not an answer key (kind: ${json?.kind ?? 'missing'})`);
  if (json.version !== 1) throw new Error(`answer key version ${json.version} isn't supported`);
  const bad = [];
  for (const [id, e] of Object.entries(json.questions ?? {})) {
    if (byIdOnly(id) || !answerKind(e?.answer)) bad.push(id);
    else if (e.states && (!Array.isArray(e.states) || e.states.some((s) => !/^[A-Z]{2}$/.test(s)))) bad.push(`${id} (states)`);
    else if (e.proposed !== undefined && typeof e.proposed !== 'boolean') bad.push(`${id} (proposed)`);
  }
  for (const [intake, cells] of Object.entries(json.quotes ?? {})) {
    for (const [id, e] of Object.entries(cells ?? {})) {
      const kind = answerKind(e?.answer);
      if (!kind || kind === 'perQuote' || (e.proposed !== undefined && typeof e.proposed !== 'boolean')) bad.push(`${intake.slice(0, 8)} ${id}`);
    }
  }
  if (bad.length) throw new Error(`answer key: ${bad.length} entr${bad.length === 1 ? 'y has' : 'ies have'} no valid answer (${bad.slice(0, 3).join('; ')})`);
  return { kind: KEY_KIND, version: 1, questions: json.questions ?? {}, quotes: json.quotes ?? {} };
}

// What the unit of an answer is: `v0@1` the first vehicle, `@2` the second Rates row.
export function unitName(unit) {
  const [who, row] = String(unit ?? '').split('@');
  const m = who.match(/^(v|d|tr)(\d+)$/);
  const name = m ? `${{ v: 'vehicle', d: 'driver', tr: 'trailer' }[m[1]]} ${Number(m[2]) + 1}` : '';
  return [name, row && row !== '1' ? `row ${row}` : ''].filter(Boolean).join(', ');
}

// A list path for one unit: `vehicles[]` is the unit's vehicle (the first when the answer names none,
// as the plan does).
export function unitPath(path, unit) {
  const active = activeOf(unit);
  return path.replace(/^(\w+)\[\]/, (_, list) => `${list}[${active[list] ?? 0}]`);
}
// `drivers[0].dob` -> `drivers[].dob`
export const listPath = (path) => String(path).replace(/^(\w+)\[\d+\]/, '$1[]');

/**
 * One answer per quote, question and unit: benchmark rows (with `detail`) grouped by intake, as the
 * key is decided. The intake's latest quote stands for its others (today's rules give its quotes the
 * same answer); the agent's answer is the latest one known. An AmWINS answer recorded without its
 * step joins the one step whose question reads the same.
 * @returns {{id: string, intake: string, question: string, cell: string, unit: string, row: object, truthRow: object|null}[]}
 */
export function keyCells(rows) {
  const steps = new Map();
  for (const r of rows) {
    const [carrier, page, ...text] = r.question.split('|');
    if (!page?.includes(' › ')) continue;
    const k = `${carrier}|${page.split(' › ')[0]}|${text.join('|')}`;
    (steps.get(k) ?? steps.set(k, new Set()).get(k)).add(r.question);
  }
  const out = new Map();
  for (const r of rows) {
    if (!r.detail || !keyable(r)) continue;
    const one = r.question.split('|')[1].includes(' › ') ? null : steps.get(r.question);
    const question = one?.size === 1 ? [...one][0] : r.question;
    const unit = r.detail.unit ?? '';
    const cell = unit ? `${question}#${unit}` : question;
    const id = `${r.intakeId}|${cell}`;
    const prev = out.get(id);
    out.set(id, { id, intake: r.intakeId, question, cell, unit, row: r, truthRow: r.group ? r : prev?.truthRow ?? null });
  }
  return [...out.values()];
}

// The key's entry for a cell: the quote's own, else the question's (in its states). null: not keyed,
// or a question that depends on the client without this quote's answer.
export function keyEntry(key, c) {
  const own = key.quotes[c.intake]?.[c.cell];
  if (own) return { ...own, level: 'quote' };
  const q = key.questions[c.question];
  if (!q || q.answer.perQuote) return null;
  if (q.states?.length && !q.states.includes(c.row.detail?.state)) return null;
  return { ...q, level: 'question' };
}

// What the key wants for this quote: { value, path? } an answer; { none } nobody's answer from the
// intake (`agent`, `na`, or `missing`: the intake path is blank); { unsure } can't say.
export function wanted(answer, record, unit) {
  const kind = answerKind(answer);
  if (kind === 'value') return { value: answer.value };
  if (kind === 'fromIntake') {
    const path = unitPath(answer.fromIntake, unit);
    const v = get(record, path);
    if (v == null || v === '') return { none: 'missing', path };
    return typeof v === 'object' ? { unsure: true, path } : { value: v, path };
  }
  return kind === 'agent' || kind === 'na' ? { none: kind } : { unsure: true };
}

// Picks by the page's options (any but one, the first, the one already selected): no value of
// their own. An address typed for the page's suggestion is the text typed.
const PAGE_PICKS = ['pick-not', 'first-option', 'selected-option'];
const yesNo = (v) => (v ? 'Yes' : 'No');
function sameText(step, value) {
  if (PAGE_PICKS.includes(step.kind) || (step.value && typeof step.value === 'object')) return 'unsure';
  const got = normalizeForMatch(step.kind === 'bool' ? yesNo(step.value) : step.value);
  return got === normalizeForMatch(typeof value === 'boolean' ? yesNo(value) : value) ? 'agree' : 'differ';
}

// Whether today's step gives what the key wants: agree, differ or unsure (a pick that depends on the
// page's options, as the benchmark judges them).
export function keyVerdict(step, want, choice) {
  if (want.path && step.path === want.path) return 'agree';
  const v = want.value;
  if (typeof v === 'number' && typeof step.value === 'number') return v === step.value ? 'agree' : 'differ';
  if (typeof v === 'boolean' && step.kind === 'bool') return !!step.value === v ? 'agree' : 'differ';
  if (!choice) return sameText(step, v);
  return choiceVerdict(step, typeof v === 'boolean' ? yesNo(v) : String(v));
}

const VERDICT = { agree: 'right', differ: 'wrong', unsure: 'unsure' };

// The agent's final answer against the key's, where the key has one: right, wrong, unsure or null
// (no answer to judge). Typed text is never logged: it is judged by the intake answers it equalled
// (`matches`) or the rule path of an autofill the agent kept.
export function agentVerdict(truth, want, choice, record) {
  if (!truth || !('value' in want)) return null;
  if (choice) {
    if (truth.value == null) return null;
    const as = typeof want.value === 'boolean' ? { kind: 'bool', value: want.value } : { kind: 'choice', value: String(want.value) };
    return VERDICT[choiceVerdict(as, truth.value)];
  }
  const paths = truth.path ? [truth.path] : (truth.matches ?? []).filter((m) => !m.endsWith(':part'));
  if (want.path && paths.includes(want.path)) return 'right';
  const w = normalizeForMatch(want.value);
  if (paths.some((p) => get(record, p) != null && normalizeForMatch(get(record, p)) === w)) return 'right';
  // The key's answer is on the intake, so typing it would have matched it.
  return w.length >= 3 && matchIntake(record, String(want.value)).length ? 'wrong' : 'unsure';
}

/**
 * Today's rules on one cell against the key: `right` (the key's answer, or left to the agent where
 * the key says agent / not applicable / the intake is blank), `wrong`, `missed` (left to the agent
 * though the key has an answer), `invented` (filled where the key says nobody's answer from the
 * intake: must be 0), `unsure` (the pairing or the page's options can't tell), `unkeyed`.
 */
export function scoreCell(c, entry) {
  if (!entry) return { result: 'unkeyed', agent: null };
  const { step, record, unit, truth } = c.row.detail;
  const want = wanted(entry.answer, record, unit);
  const choice = CHOICE.has(c.row.kind);
  const agent = agentVerdict((c.truthRow ?? c.row).detail.truth ?? truth, want, choice, record);
  const status = c.row.status;
  let result;
  if (status === 'unsure' || want.unsure) result = 'unsure';
  else if (want.none) result = status === 'value' ? 'invented' : 'right';
  else if (status !== 'value') result = 'missed';
  else result = VERDICT[keyVerdict(step, want, choice)];
  return { result, agent, want: want.none ? want.none : choice && 'value' in want ? String(typeof want.value === 'boolean' ? yesNo(want.value) : want.value) : null };
}

export const RESULTS = ['right', 'wrong', 'missed', 'invented', 'unsure'];
const counts = () => ({ cells: 0, right: 0, wrong: 0, missed: 0, invented: 0, unsure: 0, unkeyed: 0, agents: { right: 0, wrong: 0, unsure: 0 } });

// The key's entries, and how many the reviewer confirmed as proposed.
export function keyEntries(key) {
  const all = [...Object.values(key.questions), ...Object.values(key.quotes).flatMap((q) => Object.values(q))];
  return { entries: all.length, proposed: all.filter((e) => e.proposed).length };
}

/**
 * Scores today's rules on the key's quotes, test runs left out (as the sheet leaves them out: a
 * keyed intake run again as a test must not become its agent's answer).
 * @param {object[]} rows  benchmark rows run with `detail`
 * @param {{tests?: Set<string>|null}} opts  tests: the sessions that are test runs (testSessionsOf)
 * @returns {{scored: object[], total: object, decided: object, byCarrier: object, decidedByCarrier: object, quotes: number, entries: number, proposed: number}}
 *   total: every keyed answer; decided: only answers whose entry the reviewer changed or typed
 *   (not `proposed`), so a key confirmed as proposed can't score the rules right by itself
 */
export function scoreKey(rows, key, { tests = null } = {}) {
  const scored = keyCells(rows.filter((r) => !tests?.has(r.session))).filter((c) => key.quotes[c.intake]).map((c) => {
    const entry = keyEntry(key, c);
    return { ...c, entry, decided: !!entry && !entry.proposed, ...scoreCell(c, entry) };
  });
  const total = counts();
  const decided = counts();
  const byCarrier = {};
  const decidedByCarrier = {};
  for (const s of scored) {
    const into = [total, (byCarrier[s.row.carrier] ??= counts())];
    if (s.decided) into.push(decided, (decidedByCarrier[s.row.carrier] ??= counts()));
    for (const t of into) {
      t.cells++;
      t[s.result]++;
      if (s.agent) t.agents[s.agent]++;
    }
  }
  return { scored, total, decided, byCarrier, decidedByCarrier, quotes: new Set(scored.map((s) => s.intake)).size, ...keyEntries(key) };
}

// The share of keyed answers today's rules get right.
export const rightPercent = (t) => {
  const keyed = t.cells - t.unkeyed - t.unsure;
  return keyed ? Math.round((t.right / keyed) * 100) : null;
};

// One line per question for a result: how many quotes, the key's answers and today's (choices only;
// typed text is never shown).
export function keyByQuestion(scored, result) {
  const out = new Map();
  for (const s of scored.filter((x) => x.result === result)) {
    const q = out.get(s.question) ?? { question: s.question, carrier: s.row.carrier, page: s.row.page, step: s.row.step, label: s.row.label, rule: s.row.rule, source: s.row.source, cells: 0, decided: 0, intakes: new Set(), pairs: new Map() };
    q.cells++;
    if (s.decided) q.decided++;
    q.intakes.add(s.intake);
    const today = s.row.today ?? { none: 'no rule', agent: 'agent\'s', ignored: 'left alone', blank: 'blank', unsure: '?' }[s.row.status] ?? (s.row.kind && CHOICE.has(s.row.kind) ? '?' : 'text');
    const pair = `key ${s.want ?? 'text'} · today ${today}`;
    q.pairs.set(pair, (q.pairs.get(pair) ?? 0) + 1);
    out.set(s.question, q);
  }
  return [...out.values()].map((q) => ({ ...q, intakes: q.intakes.size, pairs: [...q.pairs].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.intakes - a.intakes || b.cells - a.cells);
}

// Cells whose key result changed between two saved runs (`key` on each row, --save with --key).
export function compareKey(before, after) {
  const prev = new Map(before.filter((r) => r.key).map((r) => [r.id, r]));
  return after.filter((r) => r.key && prev.has(r.id) && prev.get(r.id).key !== r.key).map((r) => ({ ...r, wasKey: prev.get(r.id).key }));
}

// ---- The review sheet ----

// Coverage pages: what the client asked for decides these, quote by quote.
const COVERAGE_PAGE = /CoveragesRates|› Coverages/;

// How a value reads on the sheet.
function show(step, kind) {
  if (!step || step.value == null) return null;
  if (step.value && typeof step.value === 'object') return step.value.not ? `any but "${step.value.not}"` : JSON.stringify(step.value);
  return CHOICE.has(kind) ? shown(step, kind) : step.kind === 'bool' ? yesNo(step.value) : String(step.value);
}
// Whether the key can hold today's answer as a value: not a pick that depends on the page's options.
const holdable = (step) => step?.value != null && typeof step.value !== 'object' && !PAGE_PICKS.includes(step.kind);
// A value as the key holds it: a yes/no as the page shows it (Yes, checked), else the rule's own
// (a number stays one).
const raw = (step, kind) => (step.kind === 'bool' ? shown(step, kind) : step.value);
const STATUS = { none: 'no rule', agent: 'left to the agent', ignored: 'left alone', blank: 'nothing from this intake', unsure: 'can\'t pair' };

function agentText(truth, kind) {
  if (!truth) return null;
  const who = { kept: 'kept autofill', corrected: 'corrected autofill', agent: 'agent', page: 'page default' }[truth.group];
  if (CHOICE.has(kind)) return truth.value == null ? null : `${truth.value} (${who})`;
  if (truth.path) return `${who}: ${truth.path}`;
  if (truth.matches?.length) return `${who} typed = intake ${truth.matches.join(', ')}`;
  return `${who} typed text not on the intake`;
}

const readable = (v) => (v == null || v === '' ? '(blank)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
// The intake answers behind a cell: the rule's path, the facts a derived rule read, the fields the
// agent's typed text equalled.
function intakeValues(c) {
  const { step, record } = c.row.detail;
  const paths = new Set();
  if (step?.source === 'intake' && step.path && !/^\w+\.q/.test(step.path)) paths.add(step.path);
  for (const p of step?.from ?? []) paths.add(p);
  const t = (c.truthRow ?? c.row).detail.truth;
  for (const p of t?.matches ?? []) paths.add(p.replace(/:part$/, ''));
  if (t?.path && get(record, t.path) !== undefined) paths.add(t.path);
  return [...paths].slice(0, 6).map((p) => [p, readable(get(record, p))]);
}

// A derived rule's answer for a quote, as the key keeps it: its value, or the agent's when the rule
// leaves it (a missing fact gives a note, never a guess). null: one the key can't hold (a pick by the
// page's options).
function frozen(c) {
  const { step } = c.row.detail;
  if (['agent', 'blank'].includes(c.row.status)) return { agent: true };
  if (c.row.status !== 'value' || c.row.source !== 'derived' || !holdable(step)) return null;
  return { value: raw(step, c.row.kind) };
}

const tally = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);
const ranked = (map) => [...map].sort((a, b) => b[1] - a[1]).map(([text, n]) => ({ text, n }));

/**
 * The review page's model: one row per question (standards, mappings, questions left to the agent)
 * and one per quote where that client decides (coverage choices, answers the agent changed, today's
 * rules and the agent disagreeing, a quote today's rules answer differently from the question's
 * proposal). Each row carries a proposal; nothing in it is decided until the reviewer confirms it.
 * @param {object[]} rows  benchmark rows with `detail`, of the quotes to key
 * @param {{key?: object|null}} opts  an existing key to resume
 */
export function sheetModel(rows, { key = null } = {}) {
  const cells = keyCells(rows);
  const byQuestion = new Map();
  for (const c of cells) (byQuestion.get(c.question) ?? byQuestion.set(c.question, []).get(c.question)).push(c);
  const intakes = new Map();
  for (const c of cells) {
    const d = c.row.detail;
    const i = intakes.get(c.intake) ?? { id: c.intake, short: c.intake.slice(0, 8), state: d.state, businessClass: d.businessClass, carriers: new Set(), sessions: new Set() };
    i.carriers.add(c.row.carrier);
    i.sessions.add(c.row.session);
    intakes.set(c.intake, i);
  }
  const questions = [];
  const cellRows = [];
  for (const [id, list] of byQuestion) {
    const first = list[0].row;
    const kind = first.kind;
    const valued = list.filter((c) => c.row.status === 'value');
    const of = (source) => valued.filter((c) => c.row.source === source);
    const group = of('standard').length ? 'standard'
      : of('intake').length ? 'mapping'
        : of('derived').length ? (COVERAGE_PAGE.test(first.page + (first.step ? ` › ${first.step}` : '')) || COVERAGE_PAGE.test(id) ? 'coverage' : 'derived')
          : 'agent';
    const today = new Map();
    const agents = new Map();
    for (const c of list) {
      const d = c.row.detail;
      tally(today, c.row.status === 'value' ? `${show(d.step, kind)} (${c.row.source})` : STATUS[c.row.status] ?? c.row.status);
      const a = agentText((c.truthRow ?? c.row).detail.truth, kind);
      if (a) tally(agents, a);
    }
    // The proposal for the question, and which quotes it covers as today's rules answer them.
    let proposal;
    // A standard the agents answered otherwise: what the reviewer chooses between.
    let choose = null;
    let covers;
    if (group === 'standard') {
      const answers = new Map();
      for (const c of of('standard')) if (holdable(c.row.detail.step)) tally(answers, JSON.stringify(raw(c.row.detail.step, kind)));
      const value = answers.size ? JSON.parse(ranked(answers)[0].text) : null;
      // A pick the key can't hold as a value (any option but one, the first option, the page's
      // suggestion): the option the agents' quotes ended on, else none (the reviewer types it).
      const picked = new Map();
      for (const c of list) { const v = (c.truthRow ?? c.row).detail.truth?.value; if (CHOICE.has(kind) && v != null && v !== '') tally(picked, v); }
      const proposed = value ?? (picked.size ? ranked(picked)[0].text : null);
      const states = new Set(of('standard').map((c) => c.row.detail.state));
      // Restricted to those states only when a quote elsewhere gets another answer today.
      const elsewhere = list.some((c) => c.row.status !== 'unsure' && !states.has(c.row.detail.state));
      // An agent who corrected it, or answered it themselves, otherwise: no answer is preselected;
      // the reviewer chooses between today's rule and the agents' answers.
      const others = new Map();
      for (const c of list) {
        const tr = c.truthRow ?? c.row;
        if (proposed == null || !['corrected', 'agent'].includes(tr.group)) continue;
        if (agentVerdict(tr.detail.truth, { value: proposed }, CHOICE.has(kind), tr.detail.record) === 'wrong') tally(others, CHOICE.has(kind) ? String(tr.detail.truth.value) : 'other typed text');
      }
      if (others.size) choose = { rules: proposed, agents: ranked(others) };
      proposal = { answer: proposed == null || others.size ? null : { value: proposed }, ...(elsewhere ? { states: [...states].filter(Boolean).sort() } : {}) };
      covers = (c) => c.row.status === 'value' && c.row.source === 'standard' && (value == null ? !holdable(c.row.detail.step) : JSON.stringify(raw(c.row.detail.step, kind)) === JSON.stringify(value));
    } else if (group === 'mapping') {
      const paths = new Map();
      for (const c of of('intake')) tally(paths, listPath(c.row.detail.step.path));
      const path = ranked(paths)[0].text;
      proposal = { answer: { fromIntake: path } };
      covers = (c) => (c.row.status === 'value' && c.row.source === 'intake' && listPath(c.row.detail.step.path) === path) || (c.row.status === 'blank' && c.row.source === 'intake');
    } else if (group === 'derived') {
      // The rule's answer for each quote, as listed on the row: confirmed, each becomes that quote's.
      proposal = { answer: { perQuote: true }, listed: true };
      covers = (c) => !!frozen(c);
    } else if (group === 'coverage') {
      proposal = { answer: { perQuote: true } };
      covers = () => false;
    } else {
      proposal = { answer: { agent: true } };
      covers = (c) => c.row.status !== 'value';
    }
    const q = {
      id, carrier: first.carrier, page: first.page, step: first.step ?? null, label: first.label, kind, options: first.detail.options ?? null,
      rule: [...new Set(list.map((c) => c.row.rule).filter(Boolean))].slice(0, 3).join(' / ') || null,
      group, proposal, ...(choose ? { choose } : {}), today: ranked(today), agents: ranked(agents), cells: [], quotes: new Set(list.map((c) => c.intake)).size,
    };
    for (const c of list) {
      const d = c.row.detail;
      const t = (c.truthRow ?? c.row).detail.truth;
      const attention = [];
      const truthGroup = (c.truthRow ?? c.row).group;
      if (truthGroup === 'corrected') attention.push('the agent corrected the autofill');
      if (c.row.result === 'differ' || c.truthRow?.result === 'differ') attention.push('today\'s rules and the agent\'s answer differ');
      // A quote whose answer today's rules can't be paired with takes the question's answer.
      if (c.row.status !== 'unsure' && !covers(c)) attention.push(group === 'coverage' ? 'coverage choice' : `today's rules answer this quote differently (${c.row.status === 'value' ? `${show(d.step, kind)}, ${c.row.source}` : STATUS[c.row.status] ?? c.row.status})`);
      // The quote's own proposal: today's answer, the agent's choice where they changed it, else the agent's.
      let answer;
      const agentChoice = CHOICE.has(kind) && t?.value != null && ['corrected', 'agent'].includes(truthGroup) ? t.value : null;
      if (agentChoice != null && attention.length && !(group === 'coverage' && truthGroup === 'agent' && c.row.status === 'value')) answer = { value: agentChoice };
      else if (c.row.status === 'value' && c.row.source === 'intake' && d.step.path) answer = { fromIntake: listPath(d.step.path) };
      else if (c.row.status === 'value' && holdable(d.step)) answer = { value: raw(d.step, kind) };
      // A pick by the page's options: the option the quote ended on.
      else if (c.row.status === 'value' && CHOICE.has(kind) && t?.value != null && t.value !== '') answer = { value: t.value };
      else if (!CHOICE.has(kind) && t?.matches?.length) answer = { fromIntake: listPath(t.matches[0].replace(/:part$/, '')) };
      else answer = { agent: true };
      const cellRow = {
        id: c.id, intake: c.intake, question: id, cell: c.cell, unit: unitName(c.unit), state: d.state,
        today: { text: c.row.status === 'value' ? show(d.step, kind) : STATUS[c.row.status] ?? c.row.status, source: c.row.source },
        agent: agentText(t, kind), values: intakeValues(c), attention, proposal: { answer },
        // What this quote's entry is when the question is confirmed as its rule's answers, as listed.
        ...(group === 'derived' ? { frozen: frozen(c) } : {}),
      };
      q.cells.push(c.id);
      cellRows.push(cellRow);
    }
    questions.push(q);
  }
  const order = { standard: 0, mapping: 1, derived: 2, coverage: 3, agent: 4 };
  questions.sort((a, b) => order[a.group] - order[b.group] || a.carrier.localeCompare(b.carrier) || a.page.localeCompare(b.page) || String(a.label).localeCompare(String(b.label)));
  return {
    kind: 'tni-answer-key-sheet',
    intakes: [...intakes.values()].map((i) => ({ ...i, carriers: [...i.carriers].sort(), sessions: i.sessions.size })),
    questions,
    cells: cellRows,
    paths: SECTIONS.flatMap((s) => s.fields.map(([path, label]) => [path, label])),
    key,
    left: { byId: rows.filter((r) => r.detail && byIdOnly(r.question)).length, offQuote: rows.filter((r) => r.detail && !quotePage(r.carrier, r.page)).length },
  };
}

// The review page: answer-key-sheet.html with the model inside it. In a <script> block, so no "<"
// of a label or an intake answer can close it early.
export function sheetHtml(model) {
  const template = fs.readFileSync(new URL('./answer-key-sheet.html', import.meta.url), 'utf8');
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  return template.replace('/*MODEL*/null', () => json);
}
