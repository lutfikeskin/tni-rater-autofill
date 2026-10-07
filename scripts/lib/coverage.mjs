// Rule coverage of the questions agents actually met: every field of a recorded layout (built from
// page_layout events, or a committed fixture) is matched against the current carrier rules the way
// the fill engine pairs them (pagekit assign: data-model name, then the question's text on its page,
// then option, selector / data-id, then label regex; never a question id), without a browser. A question no rule claims is one the extension leaves to the agent as
// "unfamiliar": either a TNI rule is missing, or the carrier changed its page.

import fs from 'node:fs';
import { GENERIC_RULES } from '../../src/rules.js';

// Same normalisation pagekit applies to labels before label rules run.
const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// A selector part understood without a DOM: "#id", "[data-id=x]" (optionally scoped), "#a, #b".
// Anything else (nth-of-type paths) can't be checked here and counts as "can't tell".
function selectorMatch(selector, f) {
  // Layouts recorded before ids were kept (before 0.8.1) can't be checked against id rules.
  if (f.id == null && f.dataId == null) return 'unknown';
  let unknown = false;
  for (const part of String(selector).split(',').map((p) => p.trim()).filter(Boolean)) {
    const dataId = part.match(/\[data-id=["']?([^"'\]]+)["']?\]\s*$/);
    if (dataId) { if (f.dataId === dataId[1]) return 'yes'; continue; }
    const id = part.match(/^#([\w-]+)$/);
    if (id) { if (f.id === id[1]) return 'yes'; continue; }
    unknown = true;
  }
  return unknown ? 'unknown' : 'no';
}

const textIs = (rule, f) => {
  const text = squash(f.caption);
  return !!text && ([].concat(rule.ask ?? []).some((a) => squash(a) === text)
    || (!!rule.label && new RegExp(rule.label, 'i').test(text) && !(rule.not && new RegExp(rule.not, 'i').test(text))));
};
const onPage = (rule, page) => !rule.page || page == null || [].concat(rule.page).includes(page);

// Like pagekit's assign(). A data-model name (`field`) claims its field on any page; a layout
// recorded before names were kept (0.9.9) is judged by the rule's expected wording instead, as the
// live page always carries the name. A question's text (`ask`, or `label` on its page) claims a
// field no rule knows by name. A question id never claims anything (Progressive renumbers them).
function claims(rule, f, page, named) {
  if (rule.field) return f.ref ? f.ref === rule.field : (!!rule.ask || !!rule.label) && onPage(rule, page) && textIs(rule, f);
  if ((rule.ask || rule.label) && rule.page) return onPage(rule, page) && !(f.ref && named.has(f.ref)) && textIs(rule, f);
  if (!onPage(rule, page)) return false;
  if (rule.selector) {
    const m = selectorMatch(rule.selector, f);
    if (m !== 'no') return m === 'yes' || 'unknown';
  }
  if (rule.withOption) return (f.opts ?? []).some((o) => squash(o) === squash(rule.withOption));
  if (rule.label) {
    if (f.kind === 'checkbox' && rule.kind && rule.kind !== 'bool') return false;
    const text = squash(f.caption);
    return new RegExp(rule.label, 'i').test(text) && !(rule.not && new RegExp(rule.not, 'i').test(text));
  }
  return false;
}

// What happens to a field: filled by a rule, left alone on purpose (ignore), left for the agent
// on purpose (note), or unclaimed. `unsure` when only a DOM-only selector might match.
export function fieldStatus(f, carrier, page = null) {
  const all = [...(carrier.rules ?? []), ...(carrier.useGenericRules === false ? [] : GENERIC_RULES)];
  // Known questions (a name, a text on its page, an option or a selector) before label rules, as
  // the fill engine pairs them.
  const known = (r) => !!(r.field || ((r.ask || r.label) && r.page) || r.selector || r.withOption);
  const rules = [...all.filter(known), ...all.filter((r) => !known(r))];
  const named = new Set(rules.map((r) => r.field).filter(Boolean));
  let unsure = null;
  for (const rule of rules) {
    const hit = claims(rule, f, page, named);
    if (hit === 'unknown') { unsure ??= rule; continue; }
    if (!hit) continue;
    const how = typeof rule.ignore === 'function' || rule.ignore ? 'ignored' : rule.note && !rule.value ? 'agent' : 'filled';
    return { status: how, rule: rule.name ?? rule.path ?? rule.q ?? rule.label ?? rule.selector, generic: !(carrier.rules ?? []).includes(rule) };
  }
  return unsure ? { status: 'unsure', rule: unsure.name ?? unsure.selector } : { status: 'none' };
}

export function coverage(layout, carrier, { mockIds = null } = {}) {
  const pages = [];
  const totals = { fields: 0, filled: 0, ignored: 0, agent: 0, unsure: 0, none: 0, notInMock: 0 };
  for (const [page, p] of Object.entries(layout.pages ?? {})) {
    const rows = (p.fields ?? []).filter((f) => !/^Rater Autofill:|^Su Mo Tu We/.test(f.caption ?? '')).map((f) => {
      const s = fieldStatus(f, carrier, page);
      // The page's own id/data-id isn't in the mock: the carrier changed the page, or the mock
      // misses a conditional part of it.
      const notInMock = !!mockIds && !!(f.id || f.dataId) && !mockIds.has(f.id) && !mockIds.has(f.dataId);
      return { ...f, ...s, notInMock };
    });
    for (const r of rows) { totals.fields++; totals[r.status]++; if (r.notInMock) totals.notInMock++; }
    pages.push({ page, rows });
  }
  return { carrier: layout.carrier, context: layout.context, quotes: layout.generated?.quotes ?? null, pages, totals };
}

// Every id and data-id in a saved page (the AmWINS mock), read without a browser.
export function idsInHtml(file) {
  const html = fs.readFileSync(file, 'utf8');
  return new Set([...html.matchAll(/\b(?:id|data-id)="([^"]+)"/g)].map((m) => m[1]));
}
