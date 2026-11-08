// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// Learns from usage events what each carrier question's answer should be.
//
// For every quote (session) and question it works out the final answer and who gave it:
// autofill, the agent, or the page itself. Across quotes it then proposes:
//   standard   an unmapped question agents answer the same way nearly every time: a question for
//              the maintainer (is it TNI's standard?), never a ready rule
//   byState    an unmapped question whose answer is consistent within each state
//   mapping    an unmapped text box whose typed value matches the same intake field every time
//   review     a mapped question whose autofill answer agents change often, under the current rules
//   pageAnswer a question left to the agent where they let the page's own answer stand
//   pageSets   an unmapped question the page itself answers (its own cascade), the same nearly every time
//   agent      an unmapped question agents answer the same way that is an attestation or a client
//              fact: the agent's (or the intake's), never a TNI standard
// Suggestions are for a person to review; nothing is changed automatically. A habit is no TNI
// standard until the maintainer decides it is and records it (AGENTS.md), so a possible standard
// comes with its evidence and the decision to make, never with a rule line to paste.

import { isPageLayout, quotePage, sessionContexts } from './events.mjs';
import { fieldIdentities, ENTITY_PAGES } from './layouts.mjs';
import { fieldStatus } from './coverage.mjs';
import { isOwnDefault } from './agent-defaults.mjs';

const CHOICE = new Set(['select', 'radio', 'checkbox', 'combo']);
const textOf = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
// Labels the recorder gives a page's own controls (AmWINS: the file button, a pager, a row's
// Delete): no question, so no candidate (compared lower-cased, after textOf).
// Trailing dots, ellipses or a colon don't make one a question ("Browse …", audit 2026-11-07 LEARN-04).
const UI_CHROME = /^(browse|delete coverage|\d+ of \d+|select files?)[\s.…:]*$/;
// A label as the panel logs it now (usage.js tidyLabel): without page markup an older event kept.
const tidyLabel = (s) => (s == null ? s : String(s).replace(/<\/?[a-z][^>]*>/gi, '').replace(/\s+/g, ' ').trim());
// A label that is only the redaction's tokens (GEICO's coverage rows read as their vehicle, which
// the log redacts to "[client]") names no question.
const blind = (label) => !/[a-z0-9]/.test(textOf(label).replace(/\[client\]/g, ''));
// Answers that are never TNI's to standardise (AGENTS.md: a standard is a TNI rulebook entry;
// attestations are the agent's): a question that reads as an attestation or consent, or as a fact
// about the client (its filings, its identifying numbers). Read from its text and its data-model name.
// First-person or consent wording only: "Declarations page" or "Prior authorization" asks no
// attestation (Claude review on PR #372).
const ATTESTATION = /\b(i agree|agrees? to|i certify|certif(ies|ication)|attest|consent|i acknowledge|acknowledge that|i declare|declare that|e-?sign|sign (here|below)|i understand|i confirm|i authori[sz]e|i warrant)/;
const CLIENT_FACT = /\b(filings?|mcs-?90|bmc-?\d*|federal liability|usdot|dot number|mc number|fein|social security|ssn|date of birth|vin)\b/;
const agentsOwn = (o) => {
  const text = `${textOf(o.label)} ${String(o.field ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').toLowerCase()}`;
  return ATTESTATION.test(text) ? 'attestation' : CLIENT_FACT.test(text) ? 'fact' : null;
};

// Which question an event answers. A question with an id (Progressive's Duck Creek fields) by its
// data-model name, or its text on its page: Progressive reassigns the ids (2026-10-07), so an id
// would split a question's history and join two questions'. The name comes from the event's key
// (ref:<name>, since 0.9.9), else from the quote's own layout of the page (fieldIdentities: a
// field recorded before names joins the named field with its text), else from the event's text.
// Its unit too: which vehicle, driver or trailer (`view`) and Rates row (`@<row>` in the key), so
// one quote's vehicles stay apart (events before 0.9.9 carry neither). Other questions (AmWINS,
// GEICO) by their page, and by their step when the event names one (a one-address application's
// visible step, `step`, as built layouts name its pages: `<page> › <step>`), so two steps' rows
// reading the same (Browse, a row's Delete) stay apart; events without it merge as before. There
// a question goes by the data-model name its key carries (GEICO's `ref:<name>`), else by its text.
function identify(e, ids) {
  const named = String(e.key ?? '').match(/^ref:([^@]+)/);
  if (!e.q) {
    const page = `${e.carrier}|${e.page}${e.step ? ` › ${e.step}` : ''}`;
    if (named) return { key: `${page}|ref:${named[1]}`, unit: '', ref: named[1] };
    // GEICO's coverage lists by their coverage (cov:COMP#2: the second vehicle's comprehensive, or
    // cov:<its caption>): their labels name the vehicle, which the log redacts, so five coverages
    // would read as one "[client]" question. A quote's vehicles merge, as without an id.
    const coverage = String(e.key ?? '').match(/^cov:(.+?)(?:#\d+)?$/)?.[1];
    return coverage ? { key: `${page}|cov:${coverage}`, unit: '', coverage } : { key: `${page}|${tidyLabel(e.label)}`, unit: '' };
  }
  // Its row from its own key (<q>@<row>, ref:<name>@<row>; none: the first row).
  const unit = `${String(e.view ?? '').split(':')[1] ?? ''}@${String(e.key ?? '').match(/@(\d+)$/)?.[1] ?? '1'}`;
  if (named) return { key: `${e.carrier}|${e.page}|ref:${named[1]}`, unit, ref: named[1], layout: ids.byField.get(`${e.session}|${e.page}|${e.q}`) };
  const text = textOf(tidyLabel(e.label));
  const caption = `${e.carrier}|${e.page}|${text}`;
  const found = ids.byField.get(`${e.session}|${e.page}|${e.q}`) ?? ids.byCaption.get(caption);
  if (found) return { key: `${e.carrier}|${e.page}|${found.id}`, unit, ref: found.ref, layout: found };
  // A text two questions of the page share (byCaption knows it, but as no one question) can't name
  // either: its id, which Progressive may renumber, rather than one question for both (Codex on PR #56).
  const shared = ids.byCaption.has(caption);
  return { key: `${e.carrier}|${e.page}|${text && !shared ? `text:${text}` : `q:${e.q}`}`, unit };
}

// Which question an event is about, as the learner groups them (by data-model name or text, never
// by its renumbered id): for the review's per-question tables.
export function questionOf(events) {
  const ids = fieldIdentities(events);
  return (e) => identify(e, ids).key;
}

// session -> answer key (question, then unit) -> { value, source, corrected, matches, label, page, q, kind }
export function finalAnswers(events, ids = fieldIdentities(events)) {
  const out = new Map();
  // Which rules filled an answer: its fill run's fingerprint of the rule files (`rules`, rulesHash
  // in src/usage.js), shared with its fill_field events by `run`.
  const rulesOf = new Map(events.filter((e) => e.type === 'fill_run' && e.run && e.rules).map((e) => [e.run, e.rules]));
  const get = (e) => {
    if (!e.session || !e.carrier) return null;
    const perSession = out.get(e.session) ?? new Map();
    out.set(e.session, perSession);
    const { key, unit, ref, layout, coverage } = identify(e, ids);
    const k = unit ? `${key}#${unit}` : key;
    const a = perSession.get(k) ?? { question: key, q: e.q ?? null, ref: ref ?? null, layout: layout ?? null, page: e.page, ...(e.step ? { step: e.step } : {}), ...(coverage ? { coverage } : {}), label: tidyLabel(e.label), carrier: e.carrier };
    perSession.set(k, a);
    if (e.label && !a.label) a.label = tidyLabel(e.label);
    return a;
  };
  for (const e of events) {
    if (e.type === 'fill_field') {
      const a = get(e);
      if (!a) continue;
      a.kind ??= e.controlKind;
      a.mappedPath = e.path ?? a.mappedPath;
      // Left to the agent: a question no rule knew, or a required one the fill couldn't answer.
      if (e.result === 'unfamiliar' || e.result === 'leftRequired') a.leftToAgent = true;
      // A rule matched it even without filling it: it kept the page's answer, had no intake value,
      // or couldn't set it (leftRequired is a required question no rule matched).
      if (['kept', 'noData', 'failed'].includes(e.result)) a.ruled = true;
      if (e.result === 'filled') {
        a.source = 'autofill';
        a.autofilled = true;
        // Where the fill's answer came from (intake, derived, standard, fact, attestation, or the
        // agent's own default: agent-default).
        if (e.source) a.ruleSource = e.source;
        a.rules = rulesOf.get(e.run) ?? null;
        if (e.shown !== undefined) { a.value = e.shown; a.filledValue = e.shown; }
      }
    } else if (e.type === 'field_change') {
      const a = get(e);
      if (!a) continue;
      a.kind = e.kind;
      if (e.by === 'agent') {
        // The panel knew the field was autofilled (`autofilled`, by its key), also when the fill was
        // on another page that shows the same question (Progressive's UM/UIM on More About Business
        // and on Rates): the agent changed our answer, to another value or none (a text box
        // cleared), as the review and the signals report count corrections.
        if ((a.autofilled || e.autofilled) && ['different', 'cleared'].includes(e.vsAutofill)) {
          a.autofilled = true;
          a.corrected = true;
          a.correction = e.kind === 'text' ? (e.vsAutofill === 'cleared' ? 'cleared the value' : 'typed a different value') : `"${a.filledValue ?? e.from}" → "${e.to}"`;
        }
        a.source = 'agent';
      } else if (!a.source) {
        a.source = 'page';
      }
      if (CHOICE.has(e.kind)) a.value = e.to;
      else if (e.matchesIntake) a.matches = e.matchesIntake;
    }
  }
  pageLeftAnswers(events, out, get, ids);
  return out;
}

// What a question no event answered held when the agent left its page: the page's own answer (a
// default, or one given in a way we couldn't see) that the agent let stand. From the page's last
// layout before the quote moved on from it (a page never left says nothing), for its picks
// (`selected`), only where no fill or change gave the question an answer: events always win.
// Questions with an id (Progressive) only; not one id drawn several times without rows (which
// vehicle's isn't known), nor a page about one vehicle, driver or trailer whose layout doesn't say
// which one. Within one quote tab (`view`): another tab's layout says nothing about this one's
// departure. Not when the extension may have moved on: its fill clicked a button on the page
// during that visit (Continue, `advanced`, or a helper that navigates, such as the bill plan, in
// `clicked`); that fill is logged up to seconds after the move, so one logged within
// EXTENSION_MOVE_MS after the departure counts too. Nor for a question an AI choice answered (the
// recorder is paused then). A layout belongs to one visit: coming back to the page (or failing to
// read it) drops it and the departure before, as the next visit logs no layout when the page's
// questions are the same (Codex on PR #51).
const EXTENSION_MOVE_MS = 30_000;
function pageLeftAnswers(events, out, get, ids) {
  const tabOf = (e) => String(e.view ?? '').split(':')[0];
  const page = (p) => String(p ?? '').replace(/-Reload$/, '');
  const clicks = events.filter((e) => e.type === 'fill_run' && e.session && (e.advanced || (e.clicked ?? []).length));
  const byUs = (d) => clicks.some((r) => r.session === d.session && page(r.page) === d.page
    && (!tabOf(r) || !d.tab || tabOf(r) === d.tab) && r.t >= d.start && Date.parse(r.t) <= Date.parse(d.end) + EXTENSION_MOVE_MS);
  const lastLayout = new Map();
  const arrivedAt = new Map();
  const left = new Map();
  const aiChosen = new Set();
  for (const e of events) {
    if (!e.session || !e.carrier) continue;
    const at = (p) => `${e.session}|${tabOf(e)}|${page(p)}`;
    if (isPageLayout(e) && !e.step) lastLayout.set(at(e.page), e);
    if (e.type === 'layout_error') lastLayout.delete(at(e.page));
    if (e.type === 'ai_decision' && e.q && ['accepted', 'approved', 'auto'].includes(e.decision)) aiChosen.add(`${e.session}|${identify(e, ids).key}`);
    if (e.type !== 'page_view') continue;
    const arrived = page(e.page);
    if (e.from && page(e.from) !== arrived) {
      const layout = lastLayout.get(at(e.from));
      const unit = String(layout?.view ?? '').split(':')[1] ?? '';
      if (layout) left.set(`${at(e.from)}|${unit}`, { layout, session: e.session, tab: tabOf(e), page: page(e.from), start: arrivedAt.get(at(e.from)) ?? '', end: e.t });
    }
    // Arriving at a page (from another, or a new document): a visit whose layout is still to come.
    if (!e.from || page(e.from) !== arrived) {
      lastLayout.delete(at(arrived));
      arrivedAt.set(at(arrived), e.t);
      for (const k of [...left.keys()]) if (k.startsWith(`${at(arrived)}|`)) left.delete(k);
    }
  }
  for (const { layout } of [...left.values()].filter((d) => !byUs(d))) {
    const unit = String(layout.view ?? '').split(':')[1] ?? '';
    if (ENTITY_PAGES.get(layout.carrier)?.has(layout.page) && !unit) continue;
    const fields = layout.fields ?? [];
    const repeated = new Set(fields.filter((f, i) => f.q && !f.row && fields.findIndex((x) => x.q === f.q) !== i).map((f) => f.q));
    for (const f of fields) {
      if (!f.q || f.selected == null || repeated.has(f.q)) continue;
      const row = String(f.row ?? '').split('_')[1];
      const a = get({ ...layout, q: f.q, label: f.label, key: row && row !== '1' ? `${f.q}@${row}` : f.q });
      if (!a || a.source || aiChosen.has(`${layout.session}|${a.question}`)) continue;
      Object.assign(a, { source: 'page', pageLeft: true, value: f.selected, kind: a.kind ?? f.kind });
    }
  }
}

const share = (counts, n) => [...counts].sort((x, y) => y[1] - x[1]).map(([v, c]) => ({ value: v, count: c, share: c / n }));

// The rules agents fill with now: the fingerprint of the newest fill run that names one (null: no
// fill in the log names one, from before fingerprints). By time, not by the text of `t` (another
// offset or precision would sort wrong; CodeRabbit on PR #373); a fill without a readable time
// can't be the newest.
export function newestRules(events) {
  let newest = null;
  let at = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.t);
    if (e.type === 'fill_run' && e.rules && t >= at) { newest = e; at = t; }
  }
  return newest?.rules ?? null;
}

/**
 * @param {object[]} events   from loadEvents()
 * @param {{carriers?: object[], minIntakes?: number, threshold?: number, rules?: string | null, excludeSessions?: Set<string> | null}} opts
 *   minIntakes: how many different intake PDFs a suggestion needs (quotes of one PDF, such as a
 *   sample retried many times, count once); rules: the rule files' fingerprint a rule review counts
 *   answers of (default: the newest the agents' fills name, newestRules, test runs left out;
 *   null: every fill's); excludeSessions: the test runs (testSessionsOf in signals.mjs), left out
 *   as every other report leaves them out: a fixture or synthetic intake's answers were chosen on
 *   purpose and are no agents' habit
 */
export function learn(all, { carriers = [], minIntakes = 5, threshold = 0.9, rules: rulesOpt, excludeSessions = null } = {}) {
  const events = excludeSessions?.size ? all.filter((e) => !excludeSessions.has(e.session)) : all;
  const testRunsLeftOut = events === all ? 0 : new Set(all.filter((e) => e.session && excludeSessions.has(e.session)).map((e) => e.session)).size;
  // The current rules from the agents' fills, after test runs are left out: a maintainer's test
  // build is never "current".
  const rules = rulesOpt === undefined ? newestRules(events) : rulesOpt;
  const contexts = sessionContexts(events);
  const answers = finalAnswers(events);
  const byId = new Map(carriers.map((c) => [c.id, c]));
  // A question is mapped when a current rule claims it, as the fill engine and the coverage report
  // pair them (fieldStatus: by data-model name, else its text on its page). With an id, 'unsure'
  // counts too, so an existing rule's question isn't suggested again. Without one (AmWINS, GEICO)
  // it doesn't: the event names no element id, so every selector rule of the page reads 'unsure'
  // and no question would ever be new; the fill's own results (`ruled`) say when a rule matched.
  const claimed = (o) => {
    const carrier = byId.get(o.carrier);
    if (!carrier) return false;
    const f = { ref: o.ref ?? o.layout?.ref ?? undefined, caption: o.layout?.caption ?? o.label, kind: o.layout?.kind ?? o.kind };
    const { status } = fieldStatus(f, carrier, o.page);
    return status !== 'none' && (!!o.q || status !== 'unsure');
  };

  // question -> observations across quotes (one per quote and unit: a quote's vehicles each count)
  const byQuestion = new Map();
  for (const [session, perSession] of answers) {
    const state = contexts.get(session)?.state ?? '?';
    for (const a of perSession.values()) {
      const list = byQuestion.get(a.question) ?? [];
      list.push({ ...a, session, state });
      byQuestion.set(a.question, list);
    }
  }

  const suggestions = { standard: [], byState: [], mapping: [], review: [], pageAnswer: [], pageSets: [], agent: [] };
  // Support counts intake PDFs (by fingerprint; a quote without one counts as its own). Every
  // event carries its quote's fingerprint, so a log without the intake_loaded event (a capped
  // export, a slice of days) still knows it.
  const fingerprints = new Map();
  for (const e of events) if (e.session && e.intakeId && !fingerprints.has(e.session)) fingerprints.set(e.session, e.intakeId);
  const intakeOf = (session) => fingerprints.get(session) ?? contexts.get(session)?.intakeId ?? session;
  const quotesOf = (list) => new Set(list.map((o) => o.session)).size;
  const intakesOf = (list) => new Set(list.map((o) => intakeOf(o.session))).size;
  // A suggestion reports the support it qualified on, not every observation of its question.
  const support = (list) => ({ intakes: intakesOf(list), quotes: quotesOf(list) });
  const observedSteps = new Map();
  for (const [key, obs] of byQuestion) {
    const [carrier] = key.split('|');
    // The question's wording as the page draws it (a layout's caption) over an event's, which can
    // be the recorder's guess at the text before the field.
    const caption = obs.find((o) => o.layout?.caption)?.layout.caption;
    const first = { ...(obs.find((o) => o.label) ?? obs[0]), ...(caption ? { label: caption } : {}) };
    const named = obs.find((o) => o.ref ?? o.layout?.ref);
    const field = named ? named.ref ?? named.layout.ref : null;
    // A question without an id (AmWINS) is known by its text alone: one with none, or one that is
    // the page's own chrome (a file button, a pager, a row's Delete), is no question to suggest a
    // rule for (the 2026-10-06 review listed "Browse" and "1 of 1").
    // A label that is only redacted text names none either, unless its key does (a coverage row).
    if (!first.q && !field && !first.coverage && (blind(first.label) || UI_CHROME.test(textOf(first.label)))) continue;
    // A question off the quote (a login, the carrier's portal: GEICO's gateway search, Progressive's
    // home page) gets no suggestion, as the answer key keys none (quotePage).
    if (!quotePage(carrier, first.page)) continue;
    const selector = `${carrier}|${target({ ...first, field })}`;
    const steps = observedSteps.get(selector) ?? new Set();
    for (const o of obs) steps.add(o.step ?? '(no step)');
    observedSteps.set(selector, steps);
    const isMapped = obs.some((o) => o.autofilled || o.ruled) || claimed({ ...first, ref: field });
    const base = { carrier, q: first.q, field, page: first.page, ...(first.step ? { step: first.step } : {}), ...(first.coverage ? { coverage: first.coverage } : {}), label: first.label ?? '', intakes: intakesOf(obs), quotes: quotesOf(obs) };
    // Answers someone gave (autofill or the agent): not one the page set itself (a cascade, pageSets
    // below) or held when the agent left it (pageLeft, pageAnswer below), which say nothing about
    // how agents answer.
    const given = (o) => o.value !== undefined && o.value !== null && o.value !== '' && CHOICE.has(o.kind ?? 'select');
    const choices = obs.filter((o) => !o.pageLeft && o.source !== 'page' && given(o));

    // A question the extension left to the agent, whose page answer they let stand in nearly
    // every quote and never changed to another: a candidate to leave as the page has it. A
    // default the agents kept, not proof it fits every client.
    const leftAsIs = obs.filter((o) => o.pageLeft);
    if (!isMapped && obs.some((o) => o.leftToAgent) && intakesOf(choices) < minIntakes && intakesOf(leftAsIs) >= minIntakes) {
      const counts = new Map();
      leftAsIs.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, leftAsIs.length);
      if (ranked[0].share >= threshold && choices.filter((o) => o.source === 'agent').every((o) => o.value === ranked[0].value)) {
        suggestions.pageAnswer.push({ ...base, ...support(leftAsIs), answers: leftAsIs.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1),
          // Kept with the agent (a note), never left as the page has it: these are often the
          // client's decisions (a coverage limit, a payment plan), where a default proves nothing.
          rule: `{ ${target({ ...first, field })}, name: ${quote(`${String(first.label ?? '').slice(0, 70)} (agent's; page default ${ranked[0].value})`)}, note: ${quote(`The page's answer "${ranked[0].value}" was left in ${counts.get(ranked[0].value)} of ${leftAsIs.length} answers (${quotesOf(leftAsIs)} quotes, ${intakesOf(leftAsIs)} intake PDFs); confirm it for this client.`)} },` });
        continue;
      }
    }

    if (isMapped) {
      // An answer filled with the agent's own default (agent defaults) says nothing about TNI's rule:
      // its correction is the agent overriding themselves (the weekly signals count those apart).
      // Only answers today's rules filled (`rules`): a correction of a rule since changed says
      // nothing about the rule now, and would keep a fixed rule on the list for good. Earlier
      // builds' answers are shown beside it, before and after the change, apart from answers whose
      // rules aren't known (a build from before fingerprints, or a fill on another page whose run
      // the log doesn't hold; CodeRabbit on PR #373).
      const all = obs.filter((o) => o.autofilled && !isOwnDefault(o.ruleSource));
      const filled = rules ? all.filter((o) => o.rules === rules) : all;
      const corrected = filled.filter((o) => o.corrected);
      if (intakesOf(filled) >= minIntakes && corrected.length / filled.length >= 0.2) {
        const changes = new Map();
        corrected.forEach((o) => changes.set(o.correction, (changes.get(o.correction) ?? 0) + 1));
        const counts = (list) => ({ filled: list.length, corrected: list.filter((o) => o.corrected).length });
        const others = all.filter((o) => !filled.includes(o));
        suggestions.review.push({ ...base, ...support(filled), filled: filled.length, corrected: corrected.length, rate: corrected.length / filled.length, changes: share(changes, corrected.length),
          otherRules: counts(others.filter((o) => o.rules)), unknownRules: counts(others.filter((o) => !o.rules)) });
      }
      continue;
    }

    if (intakesOf(choices) >= minIntakes) {
      const counts = new Map();
      choices.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, choices.length);
      // An attestation or a client fact is never a standard, nor a per-state one: the agent's, or
      // the intake's to map. Its line keeps it with the agent.
      const own = agentsOwn({ ...first, field });
      if (own) {
        suggestions.agent.push({ ...base, ...support(choices), answers: choices.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1), why: own, rule: agentRule({ ...first, field }, own) });
        continue;
      }
      if (ranked[0].share >= threshold) {
        suggestions.standard.push({ ...base, ...support(choices), answers: choices.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1), kind: first.kind, decide: decision(ranked[0].value) });
        continue;
      }
      // Consistent within each state?
      const states = new Map();
      for (const o of choices) {
        const m = states.get(o.state) ?? new Map();
        m.set(o.value, (m.get(o.value) ?? 0) + 1);
        states.set(o.state, m);
      }
      const perState = [...states].map(([state, m]) => {
        const n = [...m.values()].reduce((x, y) => x + y, 0);
        return { state, n, ...share(m, n)[0] };
      });
      if (perState.length > 1 && perState.every((s) => s.share >= threshold && s.n >= 2)) {
        suggestions.byState.push({ ...base, ...support(choices), answers: choices.length, perState: perState.map(({ state, value, n }) => ({ state, value, n })) });
      }
      continue;
    }

    // What the page set on its own (a cascade from another answer), nearly always the same, where
    // agents gave too few answers to judge: reported, never a rule (the page answers it already).
    const pageSet = obs.filter((o) => o.source === 'page' && !o.pageLeft && given(o));
    if (intakesOf(pageSet) >= minIntakes) {
      const counts = new Map();
      pageSet.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, pageSet.length);
      if (ranked[0].share >= threshold) {
        suggestions.pageSets.push({ ...base, ...support(pageSet), answers: pageSet.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1) });
        continue;
      }
    }

    const typed = obs.filter((o) => o.matches);
    if (intakesOf(typed) >= minIntakes) {
      const counts = new Map();
      typed.forEach((o) => (o.matches.length ? o.matches : ['(no intake match)']).forEach((m) => {
        const k = m.replace(/:part$/, '');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }));
      const ranked = share(counts, typed.length);
      if (ranked[0].value !== '(no intake match)' && ranked[0].share >= 0.8) {
        const path = ranked[0].value.replace(/\[\d+\]/, '[]');
        suggestions.mapping.push({ ...base, ...support(typed), answers: typed.length, path, share: ranked[0].share, rule: `{ ${target({ ...first, field })}, path: '${path}' },` });
      }
    }
  }
  // A question known only by its text (AmWINS) gets a rule by its label, which no step constrains:
  // two observed steps' questions reading the same would get one selector, even when only one has
  // enough support for a suggestion. Such suggestions get no ready rule, only a note naming the steps.
  const pasted = [...suggestions.mapping, ...suggestions.pageAnswer, ...suggestions.agent].filter((s) => s.rule);
  for (const s of pasted) {
    // A coverage row (cov:COMP) is found by its element id, never by its label (its vehicle).
    if (s.coverage) {
      s.rule = null;
      s.manualRule = `a coverage row (cov:${s.coverage}) whose label is its vehicle: write the rule by hand by its id (as GEICO's [id$="_<coverage>"] rules)`;
      continue;
    }
    const steps = [...(observedSteps.get(`${s.carrier}|${target(s)}`) ?? [])];
    if (steps.length < 2) continue;
    s.rule = null;
    s.manualRule = `the same label on steps ${steps.join(', ')}: a label rule would match each step; write the rule by hand so it finds this step's question only`;
  }
  for (const list of Object.values(suggestions)) list.sort((a, b) => b.intakes - a.intakes || b.quotes - a.quotes);
  return { quotes: answers.size, intakes: new Set([...answers.keys()].map(intakeOf)).size, questions: byQuestion.size, rules, testRunsLeftOut, suggestions };
}

const quote = (s) => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// How a suggested rule finds its question, as the fill engine does: a question with an id by its
// data-model name on its page (field, pageOnly) with its wording as the check, else by its text on
// its page (ask), never by the id. Other questions (AmWINS) by their label, as before.
function target(o) {
  if (o.field) return `field: ${quote(o.field)}, page: ${quote(o.page)}, pageOnly: true, ask: ${quote(o.label)}`;
  if (o.q) return `page: ${quote(o.page)}, ask: ${quote(o.label)}`;
  return `label: '${squash(o.label)}'`;
}

// The maintainer's decision on a possible standard (maintainer, 2026-11-07: every suggested TNI
// standard is decide-only). Only a recorded TNI standard may answer what the intake doesn't
// (AGENTS.md), so the report asks; the rule is written once the answer is TNI's.
const decision = (answer) => `Is "${answer}" TNI's standard here? If so, record it in TNI's rulebook (docs/intake-and-rules.md, src/ai/tni-rules.js) and write its rule with that entry (tni) and a concept; if it depends on the client, map it from the intake or keep it with the agent.`;

// An attestation or a client fact agents answer the same way: kept with the agent (a note, never
// filled: plan.js fills no `attestation` or `fact`), or mapped from the intake by hand.
function agentRule(o, why) {
  const label = String(o.label ?? '').slice(0, 70);
  return why === 'attestation'
    ? `{ ${target(o)}, concept: '<choose a concept>', name: ${quote(`${label} (the agent's: attestation)`)}, source: 'attestation', note: 'Yours to confirm with the client; never ticked for you.' },`
    : `{ ${target(o)}, concept: '<choose a concept>', name: ${quote(`${label} (client fact: map it from the intake, else the agent's)`)}, source: 'fact', note: 'A fact about the client: answer it from the intake.' },`;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
