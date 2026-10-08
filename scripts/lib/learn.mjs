// Learns from usage events what each carrier question's answer should be.
//
// For every quote (session) and question it works out the final answer and who gave it:
// autofill, the agent, or the page itself. Across quotes it then proposes:
//   standard   an unmapped question agents answer the same way nearly every time
//   byState    an unmapped question whose answer is consistent within each state
//   mapping    an unmapped text box whose typed value matches the same intake field every time
//   review     a mapped question whose autofill answer agents change often
//   pageAnswer a question left to the agent where they let the page's own answer stand
// Suggestions are for a person to review; nothing is changed automatically.

import { sessionContexts } from './events.mjs';
import { fieldIdentities, ENTITY_PAGES } from './layouts.mjs';
import { fieldStatus } from './coverage.mjs';

const CHOICE = new Set(['select', 'radio', 'checkbox', 'combo']);
const textOf = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Which question an event answers. A question with an id (Progressive's Duck Creek fields) by its
// data-model name, or its text on its page: Progressive reassigns the ids (2026-10-07), so an id
// would split a question's history and join two questions'. The name comes from the event's key
// (ref:<name>, since 0.9.9), else from the quote's own layout of the page (fieldIdentities: a
// field recorded before names joins the named field with its text), else from the event's text.
// Its unit too: which vehicle, driver or trailer (`view`) and Rates row (`@<row>` in the key), so
// one quote's vehicles stay apart (events before 0.9.9 carry neither). Other questions (AmWINS)
// by their page and text, as before.
function identify(e, ids) {
  if (!e.q) return { key: `${e.carrier}|${e.page}|${e.label}`, unit: '' };
  // Its row from its own key (<q>@<row>, ref:<name>@<row>; none: the first row).
  const unit = `${String(e.view ?? '').split(':')[1] ?? ''}@${String(e.key ?? '').match(/@(\d+)$/)?.[1] ?? '1'}`;
  const named = String(e.key ?? '').match(/^ref:([^@]+)/);
  if (named) return { key: `${e.carrier}|${e.page}|ref:${named[1]}`, unit, ref: named[1], layout: ids.byField.get(`${e.session}|${e.page}|${e.q}`) };
  const found = ids.byField.get(`${e.session}|${e.page}|${e.q}`) ?? ids.byCaption.get(`${e.carrier}|${e.page}|${textOf(e.label)}`);
  if (found) return { key: `${e.carrier}|${e.page}|${found.id}`, unit, ref: found.ref, layout: found };
  return { key: `${e.carrier}|${e.page}|${textOf(e.label) ? `text:${textOf(e.label)}` : `q:${e.q}`}`, unit };
}

// session -> answer key (question, then unit) -> { value, source, corrected, matches, label, page, q, kind }
export function finalAnswers(events, ids = fieldIdentities(events)) {
  const out = new Map();
  const get = (e) => {
    if (!e.session || !e.carrier) return null;
    const perSession = out.get(e.session) ?? new Map();
    out.set(e.session, perSession);
    const { key, unit, ref, layout } = identify(e, ids);
    const k = unit ? `${key}#${unit}` : key;
    const a = perSession.get(k) ?? { question: key, q: e.q ?? null, ref: ref ?? null, layout: layout ?? null, page: e.page, label: e.label, carrier: e.carrier };
    perSession.set(k, a);
    if (e.label && !a.label) a.label = e.label;
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
      if (e.result === 'filled') {
        a.source = 'autofill';
        a.autofilled = true;
        if (e.shown !== undefined) { a.value = e.shown; a.filledValue = e.shown; }
      }
    } else if (e.type === 'field_change') {
      const a = get(e);
      if (!a) continue;
      a.kind = e.kind;
      if (e.by === 'agent') {
        // The panel knew the field was autofilled (`autofilled`, by its key), also when the fill was
        // on another page that shows the same question (Progressive's UM/UIM on More About Business
        // and on Rates): the agent changed our answer.
        if ((a.autofilled || e.autofilled) && e.vsAutofill === 'different') {
          a.autofilled = true;
          a.corrected = true;
          a.correction = e.kind === 'text' ? 'typed a different value' : `"${a.filledValue ?? e.from}" → "${e.to}"`;
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
// departure. Not when the extension moved on (its fill clicked Continue: `advanced`), nor for a
// question an AI choice answered (the recorder is paused then). A layout belongs to one visit:
// coming back to the page (or failing to read it) drops it and the departure before, as the next
// visit logs no layout when the page's questions are the same (Codex on PR #51).
function pageLeftAnswers(events, out, get, ids) {
  const tabOf = (e) => String(e.view ?? '').split(':')[0];
  const page = (p) => String(p ?? '').replace(/-Reload$/, '');
  const lastLayout = new Map();
  const lastFill = new Map();
  const left = new Map();
  const aiChosen = new Set();
  for (const e of events) {
    if (!e.session || !e.carrier) continue;
    const at = (p) => `${e.session}|${tabOf(e)}|${page(p)}`;
    if (e.type === 'page_layout' && !e.step) lastLayout.set(at(e.page), e);
    if (e.type === 'layout_error') lastLayout.delete(at(e.page));
    if (e.type === 'fill_run') lastFill.set(at(e.page), e);
    if (e.type === 'ai_decision' && e.q && ['accepted', 'approved', 'auto'].includes(e.decision)) aiChosen.add(`${e.session}|${identify(e, ids).key}`);
    if (e.type !== 'page_view') continue;
    const arrived = page(e.page);
    if (e.from && page(e.from) !== arrived) {
      const layout = lastLayout.get(at(e.from));
      const unit = String(layout?.view ?? '').split(':')[1] ?? '';
      const byUs = !!lastFill.get(at(e.from))?.advanced;
      if (layout && !byUs) left.set(`${at(e.from)}|${unit}`, layout);
    }
    // Arriving at a page (from another, or a new document): a visit whose layout is still to come.
    if (!e.from || page(e.from) !== arrived) {
      lastLayout.delete(at(arrived));
      lastFill.delete(at(arrived));
      for (const k of [...left.keys()]) if (k.startsWith(`${at(arrived)}|`)) left.delete(k);
    }
  }
  for (const layout of left.values()) {
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

/**
 * @param {object[]} events   from loadEvents()
 * @param {{carriers?: object[], minIntakes?: number, threshold?: number}} opts
 *   minIntakes: how many different intake PDFs a suggestion needs (quotes of one PDF, such as a
 *   sample retried many times, count once)
 */
export function learn(events, { carriers = [], minIntakes = 5, threshold = 0.9 } = {}) {
  const contexts = sessionContexts(events);
  const answers = finalAnswers(events);
  const byId = new Map(carriers.map((c) => [c.id, c]));
  // A question with an id is mapped when a current rule claims it, as the fill engine and the
  // coverage report pair them (fieldStatus: by data-model name, else its text on its page); 'unsure'
  // counts too, so an existing rule's question isn't suggested again.
  const claimed = (o) => {
    const carrier = byId.get(o.carrier);
    if (!carrier || !o.q) return false;
    const f = { ref: o.ref ?? o.layout?.ref ?? undefined, caption: o.layout?.caption ?? o.label, kind: o.layout?.kind ?? o.kind };
    return fieldStatus(f, carrier, o.page).status !== 'none';
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

  const suggestions = { standard: [], byState: [], mapping: [], review: [], pageAnswer: [] };
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
  for (const [key, obs] of byQuestion) {
    const [carrier] = key.split('|');
    // The question's wording as the page draws it (a layout's caption) over an event's, which can
    // be the recorder's guess at the text before the field.
    const caption = obs.find((o) => o.layout?.caption)?.layout.caption;
    const first = { ...(obs.find((o) => o.label) ?? obs[0]), ...(caption ? { label: caption } : {}) };
    const named = obs.find((o) => o.ref ?? o.layout?.ref);
    const field = named ? named.ref ?? named.layout.ref : null;
    const isMapped = obs.some((o) => o.autofilled) || claimed({ ...first, ref: field });
    const base = { carrier, q: first.q, field, page: first.page, label: first.label ?? '', intakes: intakesOf(obs), quotes: quotesOf(obs) };
    // Answers someone gave (autofill, the agent, the page on an answer): not one the page held
    // when the agent left it (pageLeft), which is weaker evidence (pageAnswer below).
    const choices = obs.filter((o) => !o.pageLeft && o.value !== undefined && o.value !== null && o.value !== '' && CHOICE.has(o.kind ?? 'select'));

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
      const filled = obs.filter((o) => o.autofilled);
      const corrected = filled.filter((o) => o.corrected);
      if (intakesOf(filled) >= minIntakes && corrected.length / filled.length >= 0.2) {
        const changes = new Map();
        corrected.forEach((o) => changes.set(o.correction, (changes.get(o.correction) ?? 0) + 1));
        suggestions.review.push({ ...base, ...support(filled), filled: filled.length, corrected: corrected.length, rate: corrected.length / filled.length, changes: share(changes, corrected.length) });
      }
      continue;
    }

    if (intakesOf(choices) >= minIntakes) {
      const counts = new Map();
      choices.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, choices.length);
      if (ranked[0].share >= threshold) {
        suggestions.standard.push({ ...base, ...support(choices), answers: choices.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1), kind: first.kind, rule: ruleFor({ ...first, field }, ranked[0].value) });
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
  for (const list of Object.values(suggestions)) list.sort((a, b) => b.intakes - a.intakes || b.quotes - a.quotes);
  return { quotes: answers.size, intakes: new Set([...answers.keys()].map(intakeOf)).size, questions: byQuestion.size, suggestions };
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

function ruleFor(o, answer) {
  const name = quote(`${String(o.label ?? '').slice(0, 70)} (standard: ${answer})`);
  if (/^(yes|no)$/i.test(answer)) return `{ ${target(o)}, name: ${name}, kind: 'bool', value: () => ${/^yes$/i.test(answer)} },`;
  if (/^(checked|unchecked)$/.test(answer)) return `{ ${target(o)}, name: ${name}, kind: 'bool', value: () => ${answer === 'checked'} },`;
  return `{ ${target(o)}, name: ${name}, kind: 'choice', value: () => ${quote(answer)} },`;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
