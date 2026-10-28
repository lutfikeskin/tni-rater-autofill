#!/usr/bin/env node
// Builds the committed GEICO fixture, test/fixtures/geico/quote.html, from the ignored raw evidence:
// the NE quote pages saved with Chrome's "Save page as" on 2026-10-20 (layouts/geico/NE-no-dot/) and,
// for what was never saved as HTML (Business & Owner Info, the owner/SSN sub-form, the USDOT number box,
// the filing boxes, the vehicle type list), the FL Alt+Shift+C captures (layouts/geico/json_layouts_FL_DOT/),
// and for the Trailer Interchange card the FL Quote & Coverages saved on 2026-10-28 (INTERCHANGE_SAVE).
// test/fixtures/geico/mock.js plays GEICO's page script on it; scripts/geico-mock.mjs drives the fill.
//
// It only runs on a machine that holds those ignored captures. It writes nothing when a privacy check
// fails: findPii (scripts/lib/privacy.mjs), GEICO's session token and link patterns, and every client,
// agent and session value it harvested from the raw pages (checked by whole token, reported by category
// and count, never printed).
//
//   node scripts/geico-fixture.mjs                 # build; --from <dir> when layouts/geico is elsewhere
//   node scripts/geico-fixture.mjs --dry-run       # build and check, write nothing
//   node scripts/geico-fixture.mjs --check         # after a build: each view against its raw page in
//                                                  # headless Chromium (visible and hidden stems, shadow
//                                                  # roots), every request but the page's own aborted
//
// One file for the whole quote because every live GEICO step is the same address (/quote): the kit is
// never re-injected between steps, and file:// cannot fetch sibling views. Each step is an inert
// <template id="view-…">, each answer-drawn part a <template id="frag-…">; mock.js swaps them in.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findPii } from './lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(root, 'test/fixtures/geico/quote.html');

// ---------------------------------------------------------------------------------------------------
// The fake identity. Shapes the committed-fixture scan (scripts/lib/privacy.mjs ALLOWED) accepts; the
// premiums repeat their digits so nobody mistakes them for a rate.
export const FAKE = {
  vins: ['1FTBR3X80MKA12345', '1FTBR3X87MKA12399', '54DC4W1B5KS800000'],
  email: 'client@example.test', phone: '(402) 555-0100',
  first: 'SAMPLE', last: 'DRIVER', owner: 'SAMPLE DRIVER', agent: 'SAMPLE AGENT', agency: 'SAMPLE AGENCY', business: 'SAMPLE TRUCKING LLC',
  street: '1 Test Way', zip: '68102', city: 'OMAHA', dob: '01/02/1968',
  vehicle: { year: '2019', make: 'RAM', model: '1500' },
};
// Text inputs that may keep a value in the fixture: GEICO's own prefills, faked (the gateway's ZIP on
// Business Class & USDOT). test/geico-fixture.test.mjs allows exactly these.
export const PREFILLS = { GiveInitialZipCode: FAKE.zip };
const money = (i) => `$${(1000 + 111 * i).toLocaleString('en-US')}.00`;

// GEICO's visibility rules (961.*.css and main.*.css as saved) that decide what the fill engine sees
// (isVisible: client rects and visibility), plus select2's 1-px box that keeps the native select seen.
// Shown states come from inline style="display: block", which GEICO's script writes and mock.js too.
const FIXTURE_CSS = `
/* Fixture stylesheet: GEICO's visibility rules only (961.css, main.css as saved 2026-10-20). */
.hide{display:none!important}
.hidden{display:none}
[hidden]{display:none}
ul.expandable-form>li .expandable-form-content-container{display:none}
.modal,.loader-container{display:none;position:fixed;inset:0;z-index:1100;background:#fff}
.select2-hidden-accessible{border:0!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;height:1px!important;overflow:hidden!important;padding:0!important;position:absolute!important;width:1px!important;white-space:nowrap!important}
#consolidated-summary-component .vertical-tabs-panels .panel{visibility:hidden}
#consolidated-summary-component .vertical-tabs-panels .panel.active{visibility:visible}
.sales-expandable-radio-price-offer .hide-expandable-radio-content{display:none!important}
/* Icon-font glyphs (add, edit, view icons) have no box without GEICO's font: give them one. */
.geico-icon,.expandable-form-control{display:inline-block;min-width:16px;min-height:16px}
body{font:14px/1.4 system-ui,sans-serif;margin:0 16px}
`.trim();

// Views: id, saved page (or how it is made), step. The order is GEICO's flow.
const VIEWS = [
  ['business-class', 'GEICO Business Class & USDOT.html', 'Business Class & USDOT'],
  ['business-owner', 'FL 004, 005', 'Business & Owner Info'],
  // Capture 007 was titled "GEICO Vehicles" over a fresh render of the owner fields and the SSN.
  ['owner-verification', 'FL 007', 'Vehicles'],
  ['vehicle-form', 'GEICO Vehicles.html', 'Vehicles'],
  ['vehicle-list', 'GEICO Vehicles2.html', 'Vehicles'],
  ['vehicle-or-trailer', 'GEICO Vehicles3.html', 'Vehicles'],
  ['trailer-form', 'GEICO Vehicles4Trailer.html', 'Vehicles'],
  ['owner-driver', 'GEICO Drivers & Incidents.html', 'Drivers & Incidents'],
  ['driver-list', 'GEICO Drivers & Incidents2.html', 'Drivers & Incidents'],
  ['add-driver', 'GEICO Drivers & Incidents3AddDriver.html', 'Drivers & Incidents'],
  ['business-info', 'GEICO Additional Business Info.html', 'Additional Business Info'],
  ['quote', 'GEICO Quote & Coverages.html', 'Quote & Coverages'],
  ['final-quote-details', 'placeholder', 'Final Quote Details'],
  ['mvr-and-clue', 'placeholder', 'MVR & CLUE'],
  ['payment-information', 'placeholder', 'Payment Information'],
];
// Saved pages read only for the parts an answer draws (fragments) and for the privacy harvest.
const VARIANTS = {
  abiInsured: 'GEICO Additional Business InfoAlt.html', // current insurer Yes: years with insurer, BI limits
  quoteStale: 'GEICO Quote & CoveragesFull.html', // after a coverage change: "Please Recalculate", longer lists
  quoteCargo: 'GEICO Quote & CoveragesCargoFull.html', // Motor Truck Cargo Yes, its follow-ups and limit
  quoteGl: 'GEICO Quote & CoverageswithGL.html', // Motor Truck General Liability Yes and its limit
};
const ALSO_HARVEST = ['GEICO Quote & CoveragesCargo.html', 'GEICO Quote & CoveragesFilled.html', 'GEICO Quote & CoveragesAfterRunAgain.html', 'GEICO Gateway.html'];
// The FL Quote & Coverages saved on 2026-10-28 (layouts/geico/, beside NE-no-dot/) with Trailer
// Interchange and Motor Truck General Liability opened and answered by the agent: read for the
// Trailer Interchange card alone, which the NE quote doesn't offer. Its answers are put back to GEICO's
// first state (need it No, the rest unanswered and hidden, the limit list not drawn: frag-ti-limit),
// and it goes after Non-Owned Trailer Physical Damage's card, whose id stem it shares, as on the FL page.
const INTERCHANGE_SAVE = 'GEICO Quote & CoveragesTrailerandGL.html';
const INTERCHANGE_STEMS = ['GiveTrailerInterchangeEligibleRequireCoverageYesNo', 'GiveTrailerInterchangeAgreementYesNo', 'GiveTrailerInterchangeAgreementProvideOnRequestYesNo',
  'GiveTrailerInterchangeNumberOfTrailers', 'GiveTrailerInterchangeCommonTrailerType'];

// ---------------------------------------------------------------------------------------------------
// A small HTML tree for Chrome's own serializer output (explicit end tags, declarative shadow DOM as
// <template shadowrootmode>). Not a spec parser.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
function parse(src) {
  const top = { type: 'root', children: [], parent: null };
  let cur = top;
  const push = (n) => { n.parent = cur; cur.children.push(n); };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { push({ type: 'text', v: src.slice(i) }); break; }
    if (lt > i) push({ type: 'text', v: src.slice(i, lt) });
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); const stop = e < 0 ? src.length : e + 3; push({ type: 'comment', v: src.slice(i, stop) }); i = stop; continue; }
    if (src[i + 1] === '!' || src[i + 1] === '?') { const e = src.indexOf('>', i); push({ type: 'doctype', v: src.slice(i, e + 1) }); i = e + 1; continue; }
    if (src[i + 1] === '/') {
      const m = /^<\/([A-Za-z][^\s/>]*)\s*>/.exec(src.slice(i, i + 200));
      if (!m) { push({ type: 'text', v: '<' }); i++; continue; }
      const name = m[1].toLowerCase();
      let p = cur;
      while (p && p.type === 'el' && p.name !== name) p = p.parent;
      if (p && p.type === 'el') cur = p.parent;
      i += m[0].length;
      continue;
    }
    const m = /^<([A-Za-z][^\s/>]*)/.exec(src.slice(i, i + 200));
    if (!m) { push({ type: 'text', v: '<' }); i++; continue; }
    const name = m[1].toLowerCase();
    let j = i + m[0].length;
    const attrs = [];
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { j += 2; break; }
      if (src[j] === '/') { j++; continue; }
      const am = /^[^\s/>=]+/.exec(src.slice(j, j + 500));
      if (!am) { j++; continue; }
      j += am[0].length;
      while (j < src.length && /\s/.test(src[j])) j++;
      let av = null;
      if (src[j] === '=') {
        j++;
        while (j < src.length && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); av = src.slice(j + 1, e); j = e + 1; } else { av = /^[^\s>]*/.exec(src.slice(j, j + 5000))[0]; j += av.length; }
      }
      attrs.push([am[0], av]);
    }
    const el = { type: 'el', name, attrs, children: [] };
    push(el);
    i = j;
    if (RAW.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, 'ig');
      re.lastIndex = i;
      const em = re.exec(src);
      const stop = em ? em.index : src.length;
      if (stop > i) el.children.push({ type: 'raw', v: src.slice(i, stop), parent: el });
      i = em ? em.index + em[0].length : src.length;
    } else if (!VOID.has(name)) cur = el;
  }
  return top;
}
const escAttr = (v) => String(v).replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;').replace(/"/g, '&quot;');
const serialize = (n) => {
  if (n.type === 'root') return n.children.map(serialize).join('');
  if (n.type !== 'el') return n.v;
  const a = n.attrs.map(([k, v]) => (v == null ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
  return VOID.has(n.name) ? `<${n.name}${a}>` : `<${n.name}${a}>${n.children.map(serialize).join('')}</${n.name}>`;
};
const inner = (n) => n.children.map(serialize).join('');
const attr = (el, k) => el.attrs?.find(([a]) => a === k)?.[1] ?? null;
const hasAttr = (el, k) => !!el.attrs?.some(([a]) => a === k);
const setAttr = (el, k, v) => { const a = el.attrs.find(([x]) => x === k); if (a) a[1] = v; else el.attrs.push([k, v]); };
const delAttr = (el, k) => { el.attrs = el.attrs.filter(([x]) => x !== k); };
const classes = (el) => (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
function* walk(n) { yield n; for (const c of n.children ?? []) yield* walk(c); }
const els = (tree) => [...walk(tree)].filter((n) => n.type === 'el');
const find = (tree, pred) => els(tree).find(pred) ?? null;
const kids = (n) => n.children.filter((c) => c.type === 'el');
const decode = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const textOf = (n) => (n.type === 'text' ? decode(n.v) : n.type === 'el' || n.type === 'root' ? n.children.map(textOf).join('') : '');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const stemOf = (s) => String(s ?? '').match(/^Id_([A-Za-z][A-Za-z0-9]*)_\d+/)?.[1] ?? null;
const formOf = (tree) => find(tree, (n) => attr(n, 'id') === 'salesForm');
const hasAncestorClass = (n, c) => { for (let p = n.parent; p; p = p.parent) if (p.type === 'el' && classes(p).includes(c)) return true; return false; };
const inSummary = (n) => { for (let p = n; p; p = p.parent) if (p.type === 'el' && attr(p, 'id') === 'consolidated-summary-component') return true; return false; };

// ---------------------------------------------------------------------------------------------------
// 1. The sensitive values the pages mark or show. They build the fake identity (one for all pages, so a
// first name typed on Add Driver maps to the same fake in the driver list) and the refusal list.
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const EMAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const PHONE = /^\(?\d{3}\)?[-. ]?\d{3}[-. ]\d{4}$/;
const VEHICLE_LINE = /^(19|20)\d{2} [A-Z0-9][A-Z0-9-]*(?: [A-Za-z0-9-]+)*$/;
const PREMIUM = /\$\s?\d{1,3}(?:,\d{3})*\.\d{2}/g;
const INPUT_FAKE = { GiveFirstName: FAKE.first, GiveLastName: FAKE.last, GiveStreet: FAKE.street, GiveZip: FAKE.zip, GiveInitialZipCode: FAKE.zip,
  GiveBusinessName: FAKE.business, GiveEmail: FAKE.email, GivePhoneNumber: FAKE.phone, GiveBusinessPhoneNumber: FAKE.phone, GiveDateOfBirth: FAKE.dob };

function learn(trees) {
  const state = { repl: new Map(), secrets: new Map(), vinN: 0, amounts: new Map() };
  const secret = (v, cat) => { v = oneLine(v); if (v.length >= 2 && !/^(yes|no|true|false|please select|other|none|ssp)$/i.test(v)) { if (!state.secrets.has(v)) state.secrets.set(v, cat); } };
  const map = (orig, fake, cat) => { const v = oneLine(orig); if (v.length < 2) return; secret(v, cat); if (!state.repl.has(v)) state.repl.set(v, fake); };
  const nextVin = () => FAKE.vins[state.vinN++ % FAKE.vins.length];
  const classify = (v, ctx, position) => {
    if (VIN.test(v)) return nextVin();
    if (EMAIL.test(v)) return FAKE.email;
    if (PHONE.test(v)) return FAKE.phone;
    if (/^\d{5}$/.test(v)) return FAKE.zip;
    if (ctx === 'agency') return FAKE.agency;
    if (ctx === 'agent') return FAKE.agent;
    return position === 1 ? FAKE.last : position === 0 ? FAKE.first : FAKE.owner;
  };
  for (const tree of trees) for (const n of els(tree)) {
    // Typed or prefilled input values by stem; hidden inputs (ssotoken, tkey) are dropped, never faked.
    if (n.name === 'input' && attr(n, 'value') && !['radio', 'checkbox'].includes(attr(n, 'type'))) {
      const v = decode(attr(n, 'value'));
      const stem = stemOf(attr(n, 'name') || attr(n, 'id'));
      if (attr(n, 'type') === 'hidden') secret(v, 'hidden input');
      else if (stem === 'GiveVinPreQuote' || VIN.test(v)) map(v, nextVin(), 'vin');
      else map(v, INPUT_FAKE[stem] ?? '', `input ${stem ?? '?'}`);
    }
    for (const k of ['href', 'action']) for (const m of decode(attr(n, k) ?? '').matchAll(/[?&#;]([\w.-]+)=([^&#;]+)/g)) {
      let v = m[2];
      try { v = decodeURIComponent(v); } catch { /* kept as saved */ }
      secret(v, 'link token');
    }
  }
  for (const tree of trees) for (const n of els(tree)) {
    // Texts GEICO marks for Quantum Metric encryption: names, VINs.
    if (attr(n, 'data-qm-encrypt') === 'true' && n.name !== 'input' && n.name !== 'fieldset' && n.name !== 'select') {
      const v = oneLine(textOf(n));
      if (v && !state.repl.has(v)) {
        // Two marked names side by side (driver list: first, last) keep that order.
        const sibs = (n.parent?.children ?? []).filter((c) => c.type === 'el' && attr(c, 'data-qm-encrypt') === 'true');
        map(v, classify(v, null, sibs.length === 2 ? sibs.indexOf(n) : -1), 'marked text');
      }
    }
    // The summary panel (contact, agent, agency); the rating context (state, segment) is kept.
    if (n.name === 'li' && inSummary(n)) {
      const divs = kids(n).filter((c) => c.name === 'div');
      const label = divs[0] ? oneLine(textOf(divs[0])) : '';
      const v = divs[1] ? oneLine(textOf(divs[1])) : '';
      if (v && !/^(rated state|business segment)$/i.test(label)) map(v, classify(v, /agency/i.test(label) ? 'agency' : /^name$/i.test(label) ? 'agent' : null), 'summary');
    }
    // The summary header (the customer's name once GEICO knows it).
    if (/^(h3|p)$/.test(n.name) && hasAncestorClass(n, 'consolidated-summary-driver-info')) { const v = oneLine(textOf(n)); if (v) map(v, FAKE.owner, 'summary header'); }
    // The ZIP lookup's city.
    if (n.name === 'select' && stemOf(attr(n, 'id')) === 'GiveCity') {
      for (const o of kids(n).filter((c) => c.name === 'option')) { const t = oneLine(textOf(o)); if (t && !/^(please select|other)$/i.test(t)) map(t, FAKE.city, 'city'); }
    }
    // Vehicle headlines ("2020 MAKE MODEL" next to a VIN) and the select2 texts they come from. Replaced in
    // place (scrubPage), never through the global map: a year also appears in GEICO's own lists.
    if (n.name === 'strong' || n.name === 'p') for (const c of n.children) if (c.type === 'text' && VEHICLE_LINE.test(oneLine(decode(c.v)))) secret(oneLine(decode(c.v)), 'vehicle');
    // Premiums: replaced by fakes wherever they occur outside option lists.
    if (n.type === 'el') for (const c of n.children) if (c.type === 'text' && n.name !== 'option') for (const m of decode(c.v).matchAll(PREMIUM)) secret(m[0].replace(/\s/g, ''), 'premium');
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------
// 2. Scrub one saved page in place.
const DROP_TAGS = new Set(['script', 'noscript', 'link', 'meta', 'iframe', 'svg', 'img', 'base', 'object', 'embed']);
const DROP_ATTRS = new Set(['nonce', 'integrity', 'crossorigin', 'data-select2-id', 'data-link', 'data-link-name', 'data-1p-ignore',
  'data-side-panel-trigger', 'data-side-panel', 'srcset', 'src', 'externalwindow', 'data-rater-autofill', 'action']);
const NO_REPLACE_ATTRS = new Set(['id', 'name', 'for', 'input-id', 'group-id', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'slot',
  'class', 'shadowrootmode', 'shadowrootclonable', 'type', 'data-testid', 'fieldset-aria-labelledby']);
const BLOCKISH = new Set(['html', 'head', 'body', 'div', 'form', 'section', 'main', 'ul', 'ol', 'fieldset', 'template', 'select', 'optgroup', 'table', 'tr', 'gds-progress-bar-group', 'button']);
function hiddenByAncestor(n) {
  for (let p = n; p; p = p.parent) {
    if (p.type !== 'el') continue;
    const c = classes(p);
    if (c.includes('hide') || c.includes('hidden') || hasAttr(p, 'hidden')) return true;
    if ((c.includes('expandable-form-content-container') || c.includes('modal')) && !/display:\s*block/.test(attr(p, 'style') ?? '')) return true;
  }
  return false;
}

function scrubPage(tree, state, { answers = 'reset', keepValues = [] } = {}) {
  const report = { removed: {}, reset: [], keptHidden: [], marksUndone: 0 };
  const note = (list, s) => { if (s && !list.includes(s)) list.push(s); };
  const vehicle = FAKE.vehicle;
  const VEHICLE_STEMS = { GiveYear: vehicle.year, GiveMake: vehicle.make, GiveModel: vehicle.model };
  for (const n of els(tree)) {
    if (n.name === 'span' && classes(n).includes('select2-selection__rendered')) {
      const stem = stemOf(String(attr(n, 'id') ?? '').replace(/^select2-/, ''));
      if (stem in VEHICLE_STEMS && oneLine(textOf(n)) && !kids(n).length) { n.children = [{ type: 'text', v: VEHICLE_STEMS[stem], parent: n }]; if (hasAttr(n, 'title')) setAttr(n, 'title', VEHICLE_STEMS[stem]); }
    }
    if (n.name === 'strong' || (n.name === 'p' && !inSummary(n))) {
      for (const c of n.children) if (c.type === 'text' && VEHICLE_LINE.test(oneLine(decode(c.v)))) c.v = ` ${vehicle.year} ${vehicle.make} ${vehicle.model} `;
    }
  }
  // Structure the mock does not need: scripts, styles, the site header and footer, comments (Chrome's
  // "saved from url" and Lit's part markers), hidden inputs (ssotoken, tkey, isMobile), the "Jury Notes" plog.
  const dropWhy = (n) => {
    if (n.type === 'comment' || n.type === 'doctype') return 'comment';
    if (n.type !== 'el') return null;
    if (DROP_TAGS.has(n.name)) return n.name;
    const id = attr(n, 'id');
    if ((n.name === 'header' && id === 'primary-header') || (n.name === 'nav' && id === 'primary-navigation')) return n.name;
    if (n.name === 'input' && attr(n, 'type') === 'hidden') return 'hidden input';
    if (classes(n).includes('plog') || classes(n).includes('consolidated-plog-items')) return '.plog';
    if (/^gds-(footer|drawer|skip-to-content)$/.test(n.name)) return n.name;
    return null;
  };
  (function prune(node) {
    if (!node.children) return;
    node.children = node.children.filter((c) => { const why = dropWhy(c); if (why) bump(report.removed, why); return !why; });
    node.children.forEach(prune);
  })(tree);
  for (const n of els(tree)) {
    // The extension's own marks, left in the save by a fill: undone the way pagekit.js clear() does.
    if (hasAttr(n, 'data-rater-autofill') || hasAttr(n, 'data-ra-prev-title')) {
      report.marksUndone++;
      const style = (attr(n, 'style') ?? '').split(';').map((s) => s.trim()).filter((s) => s && !/^outline(-offset)?\s*:/.test(s));
      if (attr(n, 'data-ra-prev-outline')) style.push(`outline: ${attr(n, 'data-ra-prev-outline')}`);
      if (attr(n, 'data-ra-prev-offset')) style.push(`outline-offset: ${attr(n, 'data-ra-prev-offset')}`);
      if (style.length) setAttr(n, 'style', style.join('; ') + ';'); else delAttr(n, 'style');
      if (attr(n, 'data-ra-prev-title')) setAttr(n, 'title', attr(n, 'data-ra-prev-title')); else delAttr(n, 'title');
      for (const k of ['data-ra-prev-outline', 'data-ra-prev-offset', 'data-ra-prev-title', 'data-rater-autofill']) delAttr(n, k);
    }
    for (const [k] of [...n.attrs]) if (DROP_ATTRS.has(k) || /^on[a-z]+$/i.test(k)) delAttr(n, k);
    // Links keep no query and no address: the Print Quote Proposal link keeps its path so it can be told
    // apart, every other link becomes "#".
    if (hasAttr(n, 'href')) setAttr(n, 'href', /\/PrintQuote\b/i.test(decode(attr(n, 'href'))) ? '/PrintQuote' : '#');
    if (n.name === 'option' && hasAttr(n, 'data-code') && attr(n, 'data-code') === attr(n, 'value')) delAttr(n, 'data-code');
    if (n.name === 'option' && hasAttr(n, 'data-value') && oneLine(decode(attr(n, 'data-value'))) === oneLine(textOf(n))) delAttr(n, 'data-value');
    // mock.js clones views and parts with their shadow roots: cloneNode/importNode drop non-clonable ones.
    if (n.name === 'template' && hasAttr(n, 'shadowrootmode') && !hasAttr(n, 'shadowrootclonable')) n.attrs.push(['shadowrootclonable', '']);
    // Sizes GEICO's script wrote for its own layout.
    if (hasAttr(n, 'style')) {
      const s = attr(n, 'style').split(';').map((x) => x.trim()).filter((x) => x && (!/^(height|min-width|white-space|top)\s*:/.test(x) || /display/.test(x)));
      if (s.length) setAttr(n, 'style', s.join('; ') + ';'); else delAttr(n, 'style');
    }
    // Three saves caught a request in flight (Looks Good on the driver list, Next on the insured
    // Additional Business Info, every button on the stale quote): GEICO disables its buttons meanwhile. The
    // views start at rest; mock.js disables a pressed button until its view is drawn.
    if (n.name === 'gds-button' && hasAttr(n, 'disabled')) {
      delAttr(n, 'disabled');
      for (const b of els(n)) if (/^(button|a)$/.test(b.name)) { delAttr(b, 'disabled'); if (hasAttr(b, 'aria-disabled')) setAttr(b, 'aria-disabled', 'false'); }
    }
  }
  // Answers: what the agent answered on screen is reset; hidden questions keep their state (nobody can
  // click a hidden question, so it is GEICO's own or carried from an earlier step). Quote & Coverages keeps
  // everything: its answers on screen are GEICO's defaults (the pay plan).
  for (const n of els(tree)) {
    if (n.name === 'gds-radio-button-group') {
      const opts = kids(n).filter((c) => c.name === 'gds-radio-button');
      if (!opts.some((o) => hasAttr(o, 'checked'))) continue;
      if (answers === 'reset' && !hiddenByAncestor(n)) {
        for (const o of opts) { delAttr(o, 'checked'); for (const x of els(o)) if (x.name === 'input') delAttr(x, 'checked'); }
        setAttr(n, 'active-index', '-1');
        note(report.reset, stemOf(attr(n, 'id')));
      } else if (hiddenByAncestor(n)) note(report.keptHidden, stemOf(attr(n, 'id')));
    }
    if (n.name === 'input' && attr(n, 'value') != null && !['radio', 'checkbox', 'hidden'].includes(attr(n, 'type'))) {
      const stem = stemOf(attr(n, 'name') || attr(n, 'id'));
      if (keepValues.includes(stem)) { if (PREFILLS[stem]) setAttr(n, 'value', PREFILLS[stem]); } else if (answers === 'reset' || !hiddenByAncestor(n)) { delAttr(n, 'value'); note(report.reset, stem); }
    }
    if (answers === 'reset' && n.name === 'span' && classes(n).includes('select2-selection__rendered') && !hiddenByAncestor(n)
      && oneLine(textOf(n)) && !kids(n).some((c) => classes(c).includes('select2-selection__placeholder'))) {
      n.children = [{ type: 'el', name: 'span', attrs: [['class', 'select2-selection__placeholder']], children: [{ type: 'text', v: 'Please Select' }], parent: n }];
      delAttr(n, 'title');
      note(report.reset, stemOf(String(attr(n, 'id') ?? '').replace(/^select2-/, '')));
    }
    if (answers === 'reset' && n.name === 'ul' && classes(n).includes('select2-selection__rendered') && !hiddenByAncestor(n)) {
      n.children = n.children.filter((c) => !(c.type === 'el' && classes(c).includes('select2-selection__choice')));
    }
  }
  // Every learned value replaced wherever it occurs (whole tokens), never inside id/name/for: render
  // numbers are 5 digits, like a ZIP. Premiums become fakes everywhere but option lists.
  const pairs = [...state.repl.entries()].sort((a, b) => b[0].length - a[0].length);
  const patterns = pairs.map(([o, f]) => [new RegExp(`(?<![\\p{L}\\p{N}_])${reEsc(o).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu'), f]);
  const fixText = (s, inOption) => {
    let out = s;
    for (const [re, f] of patterns) out = out.replace(re, f);
    if (!inOption) out = out.replace(PREMIUM, (m) => { const k = m.replace(/\s/g, ''); if (!state.amounts.has(k)) state.amounts.set(k, money(state.amounts.size)); return state.amounts.get(k); });
    return out;
  };
  const cityOption = (o) => !!(o?.parent && stemOf(attr(o.parent, 'id')) === 'GiveCity');
  for (const n of walk(tree)) {
    if (n.type === 'text') {
      const inOption = !!(n.parent && (n.parent.name === 'option' || n.parent.name === 'optgroup')) && !cityOption(n.parent);
      const fixed = fixText(decode(n.v), inOption);
      if (fixed !== decode(n.v)) n.v = esc(fixed).replace(/&quot;/g, '"');
    } else if (n.type === 'el') {
      for (const a of n.attrs) {
        if (a[1] == null || NO_REPLACE_ATTRS.has(a[0])) continue;
        const fixed = fixText(decode(a[1]), n.name === 'option' && !cityOption(n));
        if (fixed !== decode(a[1])) a[1] = fixed;
      }
    }
  }
  // Whitespace between block containers carries nothing (the kit joins text nodes with a space).
  for (const n of walk(tree)) {
    if (n.type === 'text' && !(n.parent && ['pre', 'textarea'].includes(n.parent.name))) n.v = n.v.replace(/\s+/g, ' ');
    if (n.type === 'el' && BLOCKISH.has(n.name)) n.children = n.children.filter((c) => !(c.type === 'text' && c.v === ' '));
  }
  return report;
}

// A unit list saved right after Add was pressed (Drivers & Incidents2): put it back at rest, like the
// vehicle list, and mark the saved unit's row as the one mock.js copies for each unit.
function restList(tree) {
  for (const n of els(tree)) {
    if (n.name === 'li' && n.parent && classes(n.parent).includes('expandable-form')) {
      delAttr(n, 'aria-disabled');
      if (classes(n).includes('add-state')) setAttr(n, 'class', 'add-state');
      else setAttr(n, 'data-mock', 'unit-row');
    }
    if (classes(n).includes('action--disable-click')) setAttr(n, 'class', classes(n).filter((c) => c !== 'action--disable-click').join(' '));
    if (classes(n).includes('expandable-form-add-icon')) delAttr(n, 'aria-expanded');
    if (classes(n).includes('expandable-form-content-container') && n.parent?.name === 'li' && classes(n.parent).includes('add-state')) { delAttr(n, 'style'); setAttr(n, 'aria-hidden', 'true'); }
    if (classes(n).includes('expandable-form-edit-icon')) setAttr(n, 'tabindex', '0');
  }
}

// ---------------------------------------------------------------------------------------------------
// 3. Views GEICO never saved as HTML, drawn from the FL captures (which questions, kinds, labels, options,
// #salesForm positions; no values) with the markup GEICO uses for the same kind on the scrubbed NE pages.
// What the captures cannot show is marked data-mock-inferred.
function markupKit(scrubbed) {
  const container = (tree, test) => {
    const n = find(tree, test);
    if (!n) throw new Error('markup template not found');
    let p = n;
    while (p.parent && attr(p.parent, 'id') !== 'salesForm') p = p.parent;
    return serialize(p);
  };
  const addDriver = scrubbed['add-driver'], vehicles = scrubbed['vehicle-form'], bc = scrubbed['business-class'];
  return {
    text: container(addDriver, (n) => n.name === 'input' && stemOf(attr(n, 'name')) === 'GiveFirstName'),
    date: container(addDriver, (n) => n.name === 'input' && stemOf(attr(n, 'name')) === 'GiveDateOfBirth'),
    select: container(vehicles, (n) => n.name === 'select' && stemOf(attr(n, 'id')) === 'GiveCity'),
    radio: container(addDriver, (n) => n.name === 'gds-radio-button-group' && stemOf(attr(n, 'id')) === 'GiveOwnerActiveDriverStatusYesNo'),
    street: container(vehicles, (n) => n.name === 'input' && stemOf(attr(n, 'name')) === 'GiveStreet'),
    next: container(bc, (n) => n.name === 'gds-button' && oneLine(textOf(n)) === 'Next'),
  };
}
const FROM = { text: 'GiveFirstName', date: 'GiveDateOfBirth', select: 'GiveCity', radio: 'GiveOwnerActiveDriverStatusYesNo', street: 'GiveStreet' };
let renderSeed = 40000;
const freshNumber = () => String((renderSeed += 41) % 90000 + 10000);
const freshHex = () => (renderSeed * 7919).toString(16).padStart(32, '0').slice(-32);
function drawQuestion(kit, kind, stem, label, { options = [], type = null, description = null, masked = false } = {}) {
  const n = freshNumber();
  let h = kit[kind].replace(new RegExp(`Id_${FROM[kind]}_\\d{5}`, 'g'), `Id_${stem}_${n}`).replace(/id="Id_[0-9a-f]{32}"/, `id="Id_${freshHex()}"`);
  if (kind === 'radio') return h.replace(/<div class="\s*hide">/, '<div class="">').replace(/ checked=""/g, '').replace(/active-index="-?\d+"/, 'active-index="-1"');
  h = h.replace(/(<gds-label-legend[^>]*>(?:<template[\s\S]*?<\/template>)?<span>)[^<]*(<\/span>)/, `$1${esc(label)}$2`);
  h = h.replace(/aria-label="[^"]*"/, kind === 'date' ? '' : `aria-label="${esc(label)}"`);
  if (description) h = h.replace(/(<gds-label-legend[^>]*>(?:<template[\s\S]*?<\/template>)?<span>[^<]*<\/span>)/, `$1<span slot="description"><span>${esc(description)}</span></span>`);
  if (type) h = h.replace(/(<input[^>]*?) type="text"/, `$1 type="${type}"`);
  // GEICO's masked boxes (VIN, SSN) carry the mask in the name: Id_<Stem>_<n>maskedField.
  if (masked) h = h.replace(new RegExp(`name="Id_${stem}_(\\d+)"`), `name="Id_${stem}_$1maskedField"`);
  if (kind === 'select') {
    const opts = options.map((o, i) => (i === 0 && /^please select$/i.test(o) ? `<option value="" readonly="" hidden="">${esc(o)}</option>`
      : `<option value="${esc(o === '[client]' ? FAKE.city : o)}">${esc(o === '[client]' ? FAKE.city : o)}</option>`)).join('');
    h = h.replace(/(<select[^>]*>)[\s\S]*?(<\/select>)/, `$1${opts}$2`);
  }
  return h.replace(/(<input[^>]*?) value="[^"]*"/g, '$1');
}
const capturePos = (sel) => Number(String(sel).match(/^(?:#salesForm > )?div:nth-of-type\((\d+)\)/)?.[1] ?? NaN);
function captureControls(caps) {
  const out = new Map();
  for (const cap of caps) for (const c of cap.controls) {
    const stem = stemOf(c.name || c.id);
    if (!stem || out.has(stem)) continue;
    if (/\[client\]|data-qm-encrypt/.test(c.label ?? '')) throw new Error(`${stem}: a capture label holds a redacted client value; draw it by hand`);
    out.set(stem, { stem, kind: c.kind, type: c.type, label: oneLine(c.label), options: c.options ?? [], at: capturePos(c.selector), masked: /maskedField$/.test(c.name ?? '') });
  }
  return out;
}
function synthesizeView(kit, caps, { extra = {}, actions }) {
  const slots = new Map();
  for (const c of captureControls(caps).values()) if (Number.isFinite(c.at)) slots.set(c.at, c);
  for (const [at, c] of Object.entries(extra)) slots.set(Number(at), c);
  const parts = [];
  for (let i = 1; i <= Math.max(...slots.keys()); i++) {
    const c = slots.get(i);
    if (!c) { parts.push(`<div id="Id_${freshHex()}" data-mock-inferred="wrapper without a control"></div>`); continue; }
    let h;
    if (c.kind === 'street') h = drawQuestion(kit, 'street', 'GiveStreet', c.label);
    else if (c.kind === 'radio') h = drawQuestion(kit, 'radio', c.stem, c.label);
    else if (c.kind === 'select') h = drawQuestion(kit, 'select', c.stem, c.label, { options: c.options });
    else if (/date of birth|coverage start date/i.test(c.label)) { const [first, ...rest] = c.label.split(/(?<=Date) /); h = drawQuestion(kit, 'date', c.stem, first, { description: rest.join(' ') || null }); } else h = drawQuestion(kit, 'text', c.stem, c.label, { type: c.type === 'tel' ? 'tel' : null, masked: c.masked });
    if (c.kind === 'street') h = h.replace(/(<gds-label-legend[^>]*>(?:<template[\s\S]*?<\/template>)?<span>)[^<]*(<\/span>)/, `$1${esc(c.label)}$2`);
    if (c.inferred) h = h.replace(/^<div /, `<div data-mock-inferred="${esc(c.inferred)}" `);
    parts.push(h);
  }
  return parts.join('') + kit.next.replace(/Id_[A-Za-z]+ComboActivityDataActions_\d+/, `Id_${actions}_${freshNumber()}`);
}

// Stop steps were never captured: a placeholder view per step, so the stop is provable (mock.js records
// any click or fill there). Nothing on them is GEICO's markup.
function placeholderView(kit, step) {
  const h = drawQuestion(kit, 'text', 'MockPlaceholderQuestion', `${step}: placeholder question (this step was never captured)`);
  const button = (text) => kit.next.replace(/Id_[A-Za-z]+ComboActivityDataActions_\d+/, `Id_MockPlaceholderActions_${freshNumber()}`).replace('>Next</gds-button>', `>${esc(text)}</gds-button>`);
  return `<div data-mock-inferred="placeholder for a step never captured"><h2>${esc(step)}</h2><p>Placeholder view: GEICO's ${esc(step)} was never captured.</p></div>${h}`
    + (step === 'Payment Information' ? button('Purchase') : '') + button('Next');
}

// ---------------------------------------------------------------------------------------------------
// 4. Build.
function locateRaw(args) {
  const i = args.indexOf('--from');
  const tries = i >= 0 ? [path.resolve(args[i + 1])] : [path.join(root, 'layouts/geico')];
  if (i < 0) {
    // A git worktree has no ignored folders of its own: try the main checkout's layouts/.
    try {
      const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      tries.push(path.join(path.dirname(common), 'layouts/geico'));
    } catch { /* not a checkout */ }
  }
  return tries.find((d) => fs.existsSync(path.join(d, 'NE-no-dot')) && fs.existsSync(path.join(d, 'json_layouts_FL_DOT'))) ?? null;
}

export function build(rawDir) {
  const ne = (f) => { const p = path.join(rawDir, 'NE-no-dot', f); if (!fs.existsSync(p)) throw new Error(`missing raw page: NE-no-dot/${f}`); return fs.readFileSync(p, 'utf8'); };
  const fl = (n) => JSON.parse(fs.readFileSync(path.join(rawDir, 'json_layouts_FL_DOT', `capture-geico-unnamed-f519-${n}-quote.json`), 'utf8')).frames[0];
  const flAll = fs.readdirSync(path.join(rawDir, 'json_layouts_FL_DOT')).filter((f) => /^capture-geico-.*\.json$/.test(f)).sort();

  const sources = {};
  for (const [id, file] of VIEWS) if (file.endsWith('.html')) sources[id] = ne(file);
  for (const [k, file] of Object.entries(VARIANTS)) sources[k] = ne(file);
  const extraRaw = ALSO_HARVEST.filter((f) => fs.existsSync(path.join(rawDir, 'NE-no-dot', f))).map(ne);
  const trees = Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, parse(s)]));
  const state = learn([...Object.values(trees), ...extraRaw.map((s) => parse(s))]);
  // pages.md (the handoff's own list of sensitive values), when present, joins the refusal list.
  const pagesMd = path.join(rawDir, 'claude-handoff/pages.md');
  if (fs.existsSync(pagesMd)) {
    const md = fs.readFileSync(pagesMd, 'utf8');
    const at = md.indexOf('## Client-identifying and sensitive values');
    for (const line of at < 0 ? [] : md.slice(at).split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 8 || cells[1] === 'Category' || /^-+$/.test(cells[1]) || /^(rating context|dates)/i.test(cells[1])) continue;
      if (!/not reproduced|^\(kept\)$|^<\d+ chars/.test(cells[3]) && cells[3].length >= 3) { const v = oneLine(cells[3].replace(/`/g, '')); if (!state.secrets.has(v)) state.secrets.set(v, 'pages.md'); }
    }
  }
  // The make whose model list Vehicles.html holds: the list stays only when it is the fake vehicle's make.
  const savedMake = oneLine(textOf(find(trees['vehicle-form'], (n) => /^select2-Id_GiveMake_/.test(attr(n, 'id') ?? '')) ?? { type: 'root', children: [] }));

  const reports = {};
  for (const [k, tree] of Object.entries(trees)) {
    const quote = k === 'quote' || k.startsWith('quote');
    reports[k] = scrubPage(tree, state, { answers: quote ? 'keep' : 'reset', keepValues: k === 'business-class' ? ['GiveInitialZipCode'] : [] });
  }
  restList(trees['driver-list']);
  restList(trees['vehicle-list']);
  // The trailer form was saved with its "discard changes?" confirmation open: it starts closed.
  for (const n of els(trees['trailer-form'])) if (classes(n).includes('modal')) { setAttr(n, 'class', classes(n).filter((c) => !/^modal--(show|animate)$/.test(c)).join(' ')); const s = (attr(n, 'style') ?? '').replace(/display:\s*block;?/, '').trim(); if (s) setAttr(n, 'style', s); else delAttr(n, 'style'); }
  const model = find(trees['vehicle-form'], (n) => n.name === 'select' && stemOf(attr(n, 'id')) === 'GiveModel');
  if (savedMake.toUpperCase() === FAKE.vehicle.make) setAttr(model, 'data-mock-make', FAKE.vehicle.make);
  else {
    model.children = model.children.filter((o) => o.type !== 'el' || attr(o, 'value') === '' || /vehicle not listed/i.test(textOf(o)));
  }
  const forms = Object.fromEntries(Object.entries(trees).map(([k, t]) => [k, formOf(t)]));
  for (const [k, f] of Object.entries(forms)) if (!f) throw new Error(`${k}: no form#salesForm in the saved page`);
  const block = (k, i) => kids(forms[k])[i - 1];
  const slot = (n, name) => { if (!n) throw new Error(`fixture slot ${name}: not where the saves put it`); setAttr(n, 'data-mock-slot', name); return n; };
  const blockOf = (k, pred) => { const n = find(forms[k], pred); let p = n; while (p && p.parent !== forms[k]) p = p.parent; return p; };
  const byStem = (stem) => (n) => stemOf(attr(n, 'id') || attr(n, 'name')) === stem;

  // Where answers draw things (positions from the saves and captures; GEICO's ids change every render).
  slot(block('business-class', 5), 'usdot-number'); // FL 001: #salesForm > div:nth-of-type(5) > div > input
  slot(blockOf('business-class', byStem('GiveExtendUsDotVerifyBusinessAddress')), 'usdot-verify');
  slot(block('business-info', 7), 'insurer-years'); // filled on the insured save (…InfoAlt): FL 039 -> 040
  slot(block('business-info', 8), 'insurer-limits');
  slot(block('business-info', 26), 'add-filings'); // FL 038: div:nth-of-type(26) > fieldset > div > div > input
  const quoteBlocks = kids(forms.quote);
  slot(blockOf('quote', (n) => /^Id_PolicyTermSliderCollect_/.test(attr(n, 'id') ?? '')), 'term');
  slot(quoteBlocks[3], 'stale-card');
  slot(blockOf('quote', (n) => n.name === 'gds-radio-button-group' && stemOf(attr(n, 'id')) === 'GivePayPlanV2' && !hiddenByAncestor(n)), 'pay');
  slot(blockOf('quote', (n) => classes(n).includes('font--center') && /pay in full/i.test(textOf(n))), 'pay-in-full');
  const footers = quoteBlocks.filter((b) => find(b, (n) => n.name === 'gds-sticky-bar'));
  slot(footers.find((b) => !classes(b).includes('hide')), 'rated');
  slot(footers.find((b) => classes(b).includes('hide')), 'recalc');
  const panel = (k, re) => find(forms[k], (n) => n.name === 'li' && re.test(attr(n, 'id') ?? ''));
  slot(kids(panel('quote', /^Id_MtcCoverageQuestionsComboActivityData_/))[2], 'mtc-limit');
  slot(kids(panel('quote', /^Id_MotorTruckGeneralLiabilityEligibilityComboActivityData_/))[2], 'gl-limit');

  // Fragments: the parts an answer draws, from the save that shows them.
  const frags = {};
  frags['insurer-years'] = inner(block('abiInsured', 7));
  frags['insurer-limits'] = inner(block('abiInsured', 8));
  frags['stale-card'] = inner(kids(formOf(trees.quoteStale))[3]);
  const staleSelect = (suffix) => find(forms.quoteStale, (n) => n.name === 'select' && new RegExp(`_${suffix}$`).test(attr(n, 'id') ?? ''));
  for (const s of ['COLL', 'Rental', 'ERS']) frags[`options-${s}`] = inner(staleSelect(s));
  frags['mtc-limit'] = inner(kids(panel('quoteCargo', /^Id_MtcCoverageQuestionsComboActivityData_/))[2]);
  frags['gl-limit'] = inner(kids(panel('quoteGl', /^Id_MotorTruckGeneralLiabilityEligibilityComboActivityData_/))[2]);
  for (const k of ['insurer-years', 'insurer-limits', 'stale-card', 'mtc-limit', 'gl-limit', 'options-COLL', 'options-Rental', 'options-ERS']) if (!frags[k].trim()) throw new Error(`fragment ${k} is empty in its save`);
  // The Trailer Interchange card (INTERCHANGE_SAVE): learned and scrubbed on its own (the NE pages'
  // fakes and premiums stay as they were), its values joining the refusal list.
  const tiFile = path.join(rawDir, INTERCHANGE_SAVE);
  if (!fs.existsSync(tiFile)) throw new Error(`missing raw page: ${INTERCHANGE_SAVE}`);
  const tiTree = parse(fs.readFileSync(tiFile, 'utf8'));
  const tiState = learn([tiTree]);
  for (const [v, cat] of tiState.secrets) if (!state.secrets.has(v)) state.secrets.set(v, `${cat} (${INTERCHANGE_SAVE})`);
  reports.quoteInterchange = scrubPage(tiTree, tiState, { answers: 'keep' });
  const tiCard = find(formOf(tiTree), (n) => n.name === 'li' && /^Id_TrailerInterchangeQuestionsComboActivityData_/.test(attr(n, 'id') ?? '')
    && !!find(n, (x) => stemOf(attr(x, 'id')) === INTERCHANGE_STEMS[0]));
  if (!tiCard) throw new Error(`${INTERCHANGE_SAVE}: no Trailer Interchange card`);
  for (const n of els(tiCard)) {
    const stem = stemOf(attr(n, 'id'));
    if (n.name === 'gds-radio-button-group' && INTERCHANGE_STEMS.includes(stem)) {
      const opts = kids(n).filter((c) => c.name === 'gds-radio-button');
      const first = stem === INTERCHANGE_STEMS[0];
      for (const o of opts) {
        const on = first && attr(o, 'value') === 'No';
        if (on) setAttr(o, 'checked', null); else delAttr(o, 'checked');
        for (const x of els(o)) if (x.name === 'input') { if (on) setAttr(x, 'checked', null); else delAttr(x, 'checked'); }
      }
      setAttr(n, 'active-index', first ? String(opts.findIndex((o) => attr(o, 'value') === 'No')) : '-1');
      if (!first) setAttr(n.parent, 'class', ' hide');
    }
    if (n.name === 'select' && INTERCHANGE_STEMS.includes(stem)) {
      for (const o of kids(n)) delAttr(o, 'selected');
      const field = n.parent?.parent;
      if (field) setAttr(field, 'class', [...classes(field).filter((c) => c !== 'hide'), 'hide'].join(' '));
    }
  }
  const tiLimit = kids(tiCard).find((c) => classes(c).includes('coverage-form-field-wrapper'));
  if (!tiLimit || !find(tiLimit, (n) => n.name === 'select')) throw new Error(`${INTERCHANGE_SAVE}: no Trailer Interchange limit list`);
  frags['ti-limit'] = inner(tiLimit);
  tiLimit.children = [];
  slot(tiLimit, 'ti-limit');
  const nonOwned = panel('quote', /^Id_TrailerInterchangeQuestionsComboActivityData_/);
  nonOwned.parent.children.splice(nonOwned.parent.children.indexOf(nonOwned) + 1, 0, tiCard);
  tiCard.parent = nonOwned.parent;
  // FL 001: the USDOT number box, a light-DOM tel input labelled by its aria-label.
  const dot = fl('001').controls.find((c) => stemOf(c.name || c.id) === 'GiveDepartmentOfTransportationNumber');
  const dotId = `Id_GiveDepartmentOfTransportationNumber_${freshNumber()}`;
  frags['usdot-number'] = `<div data-mock-inferred="drawn from FL capture 001 (path, type, label); never saved as HTML"><input type="${esc(dot.type)}" id="${dotId}" name="${dotId}" aria-label="${esc(dot.label)}" autocomplete="off" aria-invalid="false"></div>`;
  // FL 038: three filing boxes sharing one name, the box in the id.
  const filings = fl('038').controls.filter((c) => stemOf(c.name) === 'AddFilings');
  const fn = freshNumber();
  frags['add-filings'] = `<fieldset data-mock-inferred="drawn from FL capture 038 (ids, name, labels, path); never saved as HTML"><div>${filings.map((c) => {
    const box = String(c.id).match(/-([A-Za-z0-9]+)$/)[1];
    return `<div><input type="checkbox" id="checkbox-Id_AddFilings_${fn}-${box}" name="Id_AddFilings_${fn}" value="${box}"><label for="checkbox-Id_AddFilings_${fn}-${box}">${esc(c.label)}</label></div>`;
  }).join('')}</div></fieldset>`;
  // The vehicle type list: never saved with its options (GEICO draws it after the vehicle is known); the
  // FL captures hold it (its order changes per VIN: the first full list is used). Trailers: never captured.
  const typeList = flAll.map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, 'json_layouts_FL_DOT', f), 'utf8')).frames[0])
    .flatMap((fr) => fr.controls).find((c) => stemOf(c.name || c.id) === 'GiveOtherVehicleType' && (c.options ?? []).length > 10)?.options ?? [];
  if (typeList.some((o) => /\[client\]/.test(o))) throw new Error('the vehicle type list holds a redacted value');
  const optionsHtml = (list) => list.map((o, i) => (i === 0 && /^please select$/i.test(o) ? '' : `<option code="${esc(o)}" value="${esc(o)}">${esc(o)}</option>`)).join('');
  frags['vehicle-types'] = optionsHtml(typeList);
  frags['trailer-types'] = optionsHtml(['Please Select', 'SAMPLE TRAILER TYPE A', 'SAMPLE TRAILER TYPE B', 'SAMPLE TRAILER TYPE C']);

  // Synthesized views.
  const kit = markupKit(forms);
  const synth = {
    'business-owner': synthesizeView(kit, [fl('004'), fl('005')], {
      actions: 'BusinessOwnerInfoComboActivityDataActions',
      extra: {
        // Search boxes are not captured (type=search is skipped): the gap between Email (15) and Unit (17).
        16: { kind: 'street', label: 'Street address (label not captured)', inferred: 'position from the gap between captured questions; GEICO\'s label was never captured' },
        // The radio's path stops at its shadow root: after Marital Status (12), in the first free slot.
        13: { ...captureControls([fl('004')]).get('GiveOwnerActiveDriverStatusYesNo'), inferred: 'position unknown (the capture path stops at the shadow root); legend from NE Add Driver (same stem)' },
      },
    }),
    'owner-verification': synthesizeView(kit, [fl('007')], { actions: 'OwnerVerificationComboActivityDataActions' }),
  };
  for (const [id, , step] of VIEWS) if (VIEWS.find((v) => v[0] === id)[1] === 'placeholder') synth[id] = placeholderView(kit, step);

  // The page: the scrubbed Business Class shell (summary panel, progress bar, loaders, an empty form);
  // the progress labels (a link for a finished step, a span for the others) are drawn by mock.js.
  const shell = trees['business-class'];
  const shellForm = formOf(shell);
  const views = {};
  for (const [id] of VIEWS) views[id] = synth[id] ?? inner(forms[id]);
  shellForm.children = [];
  for (const n of els(shell)) if (n.name === 'gds-progress-bar') n.children = n.children.filter((c) => c.name === 'template');
  const title = find(shell, (n) => n.name === 'title') ?? (() => { const t = { type: 'el', name: 'title', attrs: [], children: [] }; find(shell, (n) => n.name === 'head').children.push(t); return t; })();
  title.children = [{ type: 'text', v: 'GEICO Business Class &amp; USDOT', parent: title }];
  const head = find(shell, (n) => n.name === 'head');
  head.children.unshift({ type: 'raw', v: '<meta charset="utf-8">' });
  head.children.push({ type: 'raw', v: `<style id="geico-fixture-css">\n${FIXTURE_CSS}\n</style>` });
  const body = find(shell, (n) => n.name === 'body');
  for (const [id, , step] of VIEWS) body.children.push({ type: 'raw', v: `\n<template id="view-${id}" data-step="${esc(step)}">${views[id]}</template>` });
  for (const [id, html] of Object.entries(frags)) body.children.push({ type: 'raw', v: `\n<template id="frag-${id}">${html}</template>` });
  body.children.push({ type: 'raw', v: '\n<script src="mock.js"></script>\n' });
  const doc = serialize(shell).replace(/^\s+/, '');
  const html = `<!doctype html>\n<!-- GEICO commercial auto quote (/quote), every step one view: built by scripts/geico-fixture.mjs from the NE pages saved 2026-10-20 and the FL captures; client, agent and session values replaced; played by mock.js. -->\n${doc}`;
  const stems = Object.fromEntries(Object.entries(views).map(([id, h]) => [id, [...new Set([...h.matchAll(/\b(?:id|name)="Id_([A-Za-z][A-Za-z0-9]*)_\d+/g)].map((m) => m[1]))].length]));
  return { html, state, reports, stems, frags: Object.keys(frags), savedMake: savedMake.toUpperCase() === FAKE.vehicle.make };
}

// ---------------------------------------------------------------------------------------------------
// 5. Privacy gate: the fixture is refused on any finding.
export const TOKEN_PATTERNS = [/ssotoken/i, /\btkey\b/i, /geicoApp/i, /retentionKey/i, /conversationId/i, /\bauth=/i, /commercialPolicyRef/i, /convToken/i, /saved from url/i];
export function privacyFindings(html, secrets = new Map()) {
  const out = {};
  for (const h of findPii(html)) bump(out, `findPii ${h.kind}`);
  for (const re of TOKEN_PATTERNS) if (re.test(html)) bump(out, `token ${re.source}`);
  if (/href="[^"]*[?]/i.test(html)) bump(out, 'link with a query');
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) if (m[0] !== '<script src="mock.js">') bump(out, 'script other than mock.js');
  const fakes = new Set([...Object.values(FAKE).flat().filter((v) => typeof v === 'string'), ...Object.values(FAKE.vehicle)].map((v) => v.toLowerCase()));
  const text = decode(html);
  for (const [v, cat] of secrets) {
    if (v.length < 3 || fakes.has(v.toLowerCase())) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${reEsc(v).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'iu');
    if (re.test(html) || re.test(text)) bump(out, `harvested ${cat}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 6. --check: each view against its raw page in headless Chromium.
async function check(rawDir) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  // `without`: a part the raw page doesn't have (the quote's Trailer Interchange card, from another save).
  const probe = (without) => {
    const outside = (el) => { for (let n = el; n; n = n.parentElement ?? n.getRootNode?.()?.host ?? null) if (without && n.matches?.(without)) return false; return true; };
    const deep = (r, sel, acc = []) => { acc.push(...[...r.querySelectorAll(sel)].filter(outside)); for (const el of r.querySelectorAll('*')) if (el.shadowRoot) deep(el.shadowRoot, sel, acc); return acc; };
    const form = document.getElementById('salesForm');
    const visible = (el) => !!((el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') || [...(el.labels ?? [])].some((l) => l.getClientRects().length));
    const stem = (el) => String(el.name || el.id || '').replace(/^Id_([A-Za-z][A-Za-z0-9]*)_\d+.*$/, '$1').replace(/^Id_[0-9a-f-]{36}_\d+(_[A-Za-z]+)?$/, 'coverage$1');
    const controls = deep(form, 'input:not([type=hidden]), select, textarea').map((el) => ({ stem: stem(el), visible: visible(el), disabled: el.disabled }));
    const shown = [...new Set(controls.filter((c) => c.visible && !c.disabled).map((c) => c.stem))].sort();
    const hidden = [...new Set(controls.filter((c) => !c.visible).map((c) => c.stem))].filter((s) => !shown.includes(s)).sort();
    const hosts = deep(form, '*').filter((e) => e.shadowRoot).length;
    return { shown, hidden, hosts, unattached: form.querySelectorAll('template[shadowrootmode]').length, title: document.title };
  };
  const open = async (url, allow) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const seen = { aborted: 0, errors: [] };
    await page.route('**/*', (r) => (allow(r.request().url()) ? r.continue() : (seen.aborted++, r.abort())));
    page.on('pageerror', (e) => seen.errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    return { page, seen };
  };
  const fixture = pathToFileURL(OUT).href;
  const mockJs = pathToFileURL(path.join(path.dirname(OUT), 'mock.js')).href;
  let failures = 0;
  for (const [id, file, step] of VIEWS) {
    if (!file.endsWith('.html')) continue;
    const raw = pathToFileURL(path.join(rawDir, 'NE-no-dot', file)).href;
    const a = await open(raw, (u) => u === raw || (u.startsWith('file:') && /\.css$/i.test(u)));
    const A = await a.page.evaluate(probe);
    await a.page.close();
    const b = await open(`${fixture}?view=${id}&delay=0`, (u) => u.startsWith(fixture) || u === mockJs);
    await b.page.waitForFunction(() => window.__geicoMock?.renders >= 1);
    const B = await b.page.evaluate(probe, id === 'quote' ? `li:has([id^="Id_${INTERCHANGE_STEMS[0]}_"])` : null);
    await b.page.close();
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const ok = same(A.shown, B.shown) && same(A.hidden, B.hidden) && A.hosts === B.hosts && !B.unattached && !b.seen.aborted && !b.seen.errors.length && B.title === `GEICO ${step}`;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${id}: ${B.shown.length} shown / ${B.hidden.length} hidden stems, ${B.hosts} shadow hosts (raw ${A.hosts}), title "${B.title}"`
      + (ok ? '' : `\n     shown only raw ${JSON.stringify(A.shown.filter((s) => !B.shown.includes(s)))}, only fixture ${JSON.stringify(B.shown.filter((s) => !A.shown.includes(s)))}; hidden only raw ${JSON.stringify(A.hidden.filter((s) => !B.hidden.includes(s)))}, only fixture ${JSON.stringify(B.hidden.filter((s) => !A.hidden.includes(s)))}; unattached ${B.unattached}; aborted ${b.seen.aborted}; errors ${b.seen.errors.length}`));
  }
  await browser.close();
  return failures;
}

// ---------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rawDir = locateRaw(args);
  if (!rawDir) {
    console.error('The GEICO raw captures are not here. This script only runs on a machine that holds the ignored layouts/geico/'
      + ' folder (NE-no-dot/*.html and json_layouts_FL_DOT/*.json); pass --from <that folder> when it is elsewhere.'
      + ' The committed fixture (test/fixtures/geico/quote.html) is used as it is everywhere else.');
    process.exit(2);
  }
  if (args.includes('--check')) process.exit((await check(rawDir)) ? 1 : 0);
  const { html, state, reports, stems, frags, savedMake } = build(rawDir);
  const findings = privacyFindings(html, state.secrets);
  console.log(`views: ${Object.entries(stems).map(([k, n]) => `${k} (${n} stems)`).join(', ')}`);
  console.log(`fragments: ${frags.join(', ')}; model list kept: ${savedMake}`);
  console.log(`hidden answers kept: ${Object.entries(reports).filter(([, r]) => r.keptHidden.length).map(([k, r]) => `${k}: ${r.keptHidden.join(', ')}`).join('; ') || 'none'}`);
  console.log(`privacy: ${state.secrets.size} harvested values, ${state.amounts.size} premiums replaced; findings: ${JSON.stringify(findings)}`);
  if (Object.keys(findings).length) { console.error('Refused: the fixture would hold client, agent or session data (categories and counts above). Nothing written.'); process.exit(1); }
  if (args.includes('--dry-run')) { console.log(`dry run: ${Buffer.byteLength(html)} bytes, not written`); process.exit(0); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`${path.relative(root, OUT)}: ${Buffer.byteLength(html)} bytes`);
}
