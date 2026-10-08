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
const onPage = (rule, page) => (!rule.page || page == null || [].concat(rule.page).includes(page)) && !(page != null && rule.notPages?.includes(page));
// A data-model name claims its field on any page, except where the rule is fenced off (as in
// pagekit: a trailer's questions carry the vehicle's names).
const nameHere = (rule, page) => (rule.pageOnly ? onPage(rule, page) : !(page != null && rule.notPages?.includes(page)));

// The field kinds pagekit's assign() checks a known question against: a layout's combo is a
// select and its date box a text box. A choice is never a text box, a date or address never a
// choice, and `control` names the kind when two kinds share a question's text.
const KIND = { combo: 'select', date: 'text' };
const CHOICE = new Set(['choice', 'pick-not', 'first-option', 'selected-option', 'bool']);
const TYPED = new Set(['date', 'address-suggest']);
const kindFits = (rule, f) => {
  const kind = KIND[f.kind] ?? f.kind;
  if (!kind) return true;
  return (!rule.control || kind === rule.control) && !(CHOICE.has(rule.kind) && kind === 'text') && !(TYPED.has(rule.kind) && kind !== 'text');
};

// Like pagekit's assign(). A data-model name (`field`) claims its field on any page; a layout
// recorded before names were kept (0.9.9) is judged by the rule's expected wording instead, as the
// live page always carries the name ('unnamed' when other fields of the page have names). A question's text (`ask`, or `label` on its page) claims a
// field no rule knows by name. A question id never claims anything (Progressive renumbers them).
// A rule whose text repeats on the page (`askAfter`) claims only the first field reading it after
// its anchor question, as pagekit's afterAnchor does (needs the page's fields in order).
function anchored(rule, f, fields) {
  if (!rule.askAfter || !fields) return true;
  const at = fields.findIndex((x) => squash(x.caption) === squash(rule.askAfter));
  return at >= 0 && fields.slice(at + 1).find((x) => textIs(rule, x) && kindFits(rule, x)) === f;
}

function claims(rule, f, page, named, fields) {
  if (rule.field) {
    if (f.ref) return f.ref === rule.field && nameHere(rule, page) && kindFits(rule, f);
    const byText = (!!rule.ask || !!rule.label) && onPage(rule, page) && textIs(rule, f) && anchored(rule, f, fields) && kindFits(rule, f);
    // On a page recorded with names too, this field may have lost its name on the live page,
    // where the rule (looked for by name) leaves it unfamiliar: can't tell (Codex on PR #43).
    return byText && fields?.some((x) => x.ref) ? 'unnamed' : byText;
  }
  if ((rule.ask || rule.label) && rule.page) return onPage(rule, page) && !(f.ref && named.has(f.ref)) && textIs(rule, f) && kindFits(rule, f) && anchored(rule, f, fields);
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
// on purpose (note), or unclaimed. `unsure` when only a DOM-only selector might match. `fields`:
// the page's fields in order, for questions told apart by the question before them (askAfter).
export function fieldStatus(f, carrier, page = null, fields = null) {
  const all = [...(carrier.rules ?? []), ...(carrier.useGenericRules === false ? [] : GENERIC_RULES)];
  // Known questions (a name, a text on its page, an option or a selector) before label rules, as
  // the fill engine pairs them.
  const known = (r) => !!(r.field || ((r.ask || r.label) && r.page) || r.selector || r.withOption);
  const rules = [...all.filter(known), ...all.filter((r) => !known(r))];
  // Names known on this page (a trailer's names fenced off Add Vehicle claim nothing there).
  const named = new Set(rules.filter((r) => r.field && nameHere(r, page)).map((r) => r.field));
  let unsure = null;
  for (const rule of rules) {
    const hit = claims(rule, f, page, named, fields);
    if (hit === 'unnamed') return { status: 'unsure', rule: rule.name ?? rule.path, unnamed: true };
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
      const s = fieldStatus(f, carrier, page, p.fields ?? null);
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
