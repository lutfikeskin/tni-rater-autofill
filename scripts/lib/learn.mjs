// Learns from usage events what each carrier question's answer should be.
//
// For every quote (session) and question it works out the final answer and who gave it:
// autofill, the agent, or the page itself. Across quotes it then proposes:
//   standard   an unmapped question agents answer the same way nearly every time
//   byState    an unmapped question whose answer is consistent within each state
//   mapping    an unmapped text box whose typed value matches the same intake field every time
//   review     a mapped question whose autofill answer agents change often
// Suggestions are for a person to review; nothing is changed automatically.

import { sessionContexts } from './events.mjs';
import { fieldIdentities } from './layouts.mjs';
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
  const view = String(e.view ?? '').split(':')[1] ?? '';
  const named = String(e.key ?? '').match(/^ref:([^@]+)(?:@(\d+))?$/);
  if (named) return { key: `${e.carrier}|${e.page}|ref:${named[1]}`, unit: `${view}@${named[2] ?? '1'}`, ref: named[1] };
  const found = ids.byField.get(`${e.session}|${e.page}|${e.q}`) ?? ids.byCaption.get(`${e.carrier}|${e.page}|${textOf(e.label)}`);
  if (found) return { key: `${e.carrier}|${e.page}|${found.id}`, unit: `${view}@${found.row?.split('_')[1] ?? '1'}`, ref: found.ref, layout: found };
  return { key: `${e.carrier}|${e.page}|${textOf(e.label) ? `text:${textOf(e.label)}` : `q:${e.q}`}`, unit: `${view}@1` };
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
        if (a.autofilled && e.vsAutofill === 'different') {
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
  return out;
}

const share = (counts, n) => [...counts].sort((x, y) => y[1] - x[1]).map(([v, c]) => ({ value: v, count: c, share: c / n }));

/**
 * @param {object[]} events   from loadEvents()
 * @param {{carriers?: object[], minQuotes?: number, threshold?: number}} opts
 */
export function learn(events, { carriers = [], minQuotes = 5, threshold = 0.9 } = {}) {
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

  const suggestions = { standard: [], byState: [], mapping: [], review: [] };
  const quotesOf = (list) => new Set(list.map((o) => o.session)).size;
  for (const [key, obs] of byQuestion) {
    const [carrier] = key.split('|');
    const first = obs.find((o) => o.label) ?? obs[0];
    const isMapped = obs.some((o) => o.autofilled) || claimed(first);
    const named = obs.find((o) => o.ref ?? o.layout?.ref);
    const field = named ? named.ref ?? named.layout.ref : null;
    const base = { carrier, q: first.q, field, page: first.page, label: first.label ?? '', quotes: quotesOf(obs) };
    const choices = obs.filter((o) => o.value !== undefined && o.value !== null && o.value !== '' && CHOICE.has(o.kind ?? 'select'));

    if (isMapped) {
      const filled = obs.filter((o) => o.autofilled);
      const corrected = filled.filter((o) => o.corrected);
      if (quotesOf(filled) >= minQuotes && corrected.length / filled.length >= 0.2) {
        const changes = new Map();
        corrected.forEach((o) => changes.set(o.correction, (changes.get(o.correction) ?? 0) + 1));
        suggestions.review.push({ ...base, filled: filled.length, corrected: corrected.length, rate: corrected.length / filled.length, changes: share(changes, corrected.length) });
      }
      continue;
    }

    if (quotesOf(choices) >= minQuotes) {
      const counts = new Map();
      choices.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, choices.length);
      if (ranked[0].share >= threshold) {
        suggestions.standard.push({ ...base, answers: choices.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1), kind: first.kind, rule: ruleFor({ ...first, field }, ranked[0].value) });
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
        suggestions.byState.push({ ...base, answers: choices.length, perState: perState.map(({ state, value, n }) => ({ state, value, n })) });
      }
      continue;
    }

    const typed = obs.filter((o) => o.matches);
    if (quotesOf(typed) >= minQuotes) {
      const counts = new Map();
      typed.forEach((o) => (o.matches.length ? o.matches : ['(no intake match)']).forEach((m) => {
        const k = m.replace(/:part$/, '');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }));
      const ranked = share(counts, typed.length);
      if (ranked[0].value !== '(no intake match)' && ranked[0].share >= 0.8) {
        const path = ranked[0].value.replace(/\[\d+\]/, '[]');
        suggestions.mapping.push({ ...base, answers: typed.length, path, share: ranked[0].share, rule: `{ ${target({ ...first, field })}, path: '${path}' },` });
      }
    }
  }
  for (const list of Object.values(suggestions)) list.sort((a, b) => b.quotes - a.quotes);
  return { quotes: answers.size, questions: byQuestion.size, suggestions };
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
