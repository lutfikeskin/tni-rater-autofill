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

const CHOICE = new Set(['select', 'radio', 'checkbox', 'combo']);

const questionKey = (e) => `${e.carrier}|${e.q ? `q${e.q}` : `${e.page}|${e.label}`}`;

// session -> question key -> { value, source, corrected, matches, label, page, q, kind }
export function finalAnswers(events) {
  const out = new Map();
  const get = (e) => {
    if (!e.session || !e.carrier) return null;
    const perSession = out.get(e.session) ?? new Map();
    out.set(e.session, perSession);
    const k = questionKey(e);
    const a = perSession.get(k) ?? { q: e.q ?? null, page: e.page, label: e.label, carrier: e.carrier };
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
  const mappedQ = new Map(carriers.map((c) => [c.id, new Set(c.rules.map((r) => r.q).filter(Boolean))]));

  // question key -> observations across quotes
  const byQuestion = new Map();
  for (const [session, perSession] of answers) {
    const state = contexts.get(session)?.state ?? '?';
    for (const [k, a] of perSession) {
      const list = byQuestion.get(k) ?? [];
      list.push({ ...a, session, state });
      byQuestion.set(k, list);
    }
  }

  const suggestions = { standard: [], byState: [], mapping: [], review: [] };
  for (const [key, obs] of byQuestion) {
    const [carrier] = key.split('|');
    const first = obs.find((o) => o.label) ?? obs[0];
    const isMapped = obs.some((o) => o.autofilled) || (first.q && mappedQ.get(carrier)?.has(first.q));
    const base = { carrier, q: first.q, page: first.page, label: first.label ?? '', quotes: new Set(obs.map((o) => o.session)).size };
    const choices = obs.filter((o) => o.value !== undefined && o.value !== null && o.value !== '' && CHOICE.has(o.kind ?? 'select'));

    if (isMapped) {
      const filled = obs.filter((o) => o.autofilled);
      const corrected = filled.filter((o) => o.corrected);
      if (filled.length >= minQuotes && corrected.length / filled.length >= 0.2) {
        const changes = new Map();
        corrected.forEach((o) => changes.set(o.correction, (changes.get(o.correction) ?? 0) + 1));
        suggestions.review.push({ ...base, filled: filled.length, corrected: corrected.length, rate: corrected.length / filled.length, changes: share(changes, corrected.length) });
      }
      continue;
    }

    if (choices.length >= minQuotes) {
      const counts = new Map();
      choices.forEach((o) => counts.set(o.value, (counts.get(o.value) ?? 0) + 1));
      const ranked = share(counts, choices.length);
      if (ranked[0].share >= threshold) {
        suggestions.standard.push({ ...base, answers: choices.length, answer: ranked[0].value, share: ranked[0].share, others: ranked.slice(1), kind: first.kind, rule: ruleFor(first, ranked[0].value) });
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
    if (typed.length >= minQuotes) {
      const counts = new Map();
      typed.forEach((o) => (o.matches.length ? o.matches : ['(no intake match)']).forEach((m) => {
        const k = m.replace(/:part$/, '');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }));
      const ranked = share(counts, typed.length);
      if (ranked[0].value !== '(no intake match)' && ranked[0].share >= 0.8) {
        const path = ranked[0].value.replace(/\[\d+\]/, '[]');
        suggestions.mapping.push({ ...base, answers: typed.length, path, share: ranked[0].share, rule: `{ q: '${first.q}', path: '${path}' },` });
      }
    }
  }
  for (const list of Object.values(suggestions)) list.sort((a, b) => b.quotes - a.quotes);
  return { quotes: answers.size, questions: byQuestion.size, suggestions };
}

function ruleFor(o, answer) {
  const name = `${(o.label ?? '').replace(/'/g, "\\'").slice(0, 70)} (standard: ${answer})`;
  const target = o.q ? `q: '${o.q}'` : `label: '${squash(o.label)}'`;
  if (/^(yes|no)$/i.test(answer)) return `{ ${target}, name: '${name}', kind: 'bool', value: () => ${/^yes$/i.test(answer)} },`;
  if (/^(checked|unchecked)$/.test(answer)) return `{ ${target}, name: '${name}', kind: 'bool', value: () => ${answer === 'checked'} },`;
  return `{ ${target}, name: '${name}', kind: 'choice', value: () => '${String(answer).replace(/'/g, "\\'")}' },`;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
