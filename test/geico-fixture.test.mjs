// The committed GEICO fixture (test/fixtures/geico/quote.html, built by scripts/geico-fixture.mjs from
// the ignored captures in layouts/geico/) must hold nothing of the client, the agent or the session it
// was saved from. The builder refuses to write on any finding; these checks hold the committed file to
// the same rules on every machine, including the ones without the raw captures, and pin the shape
// mock.js and scripts/geico-mock.mjs rely on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPii } from '../scripts/lib/privacy.mjs';
import { FAKE, PREFILLS, TOKEN_PATTERNS, privacyFindings } from '../scripts/geico-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test/fixtures/geico');
const html = fs.readFileSync(path.join(dir, 'quote.html'), 'utf8');
const mock = fs.readFileSync(path.join(dir, 'mock.js'), 'utf8');
const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attrOf = (tag, k) => tag.match(new RegExp(`\\s${k}="([^"]*)"`))?.[1] ?? null;

test('the GEICO fixture holds no session token, saved-from address or link query', () => {
  for (const [name, text] of [['quote.html', html], ['mock.js', mock]]) {
    for (const re of TOKEN_PATTERNS) assert.doesNotMatch(text, re, `${name} matches ${re}`);
  }
  for (const tag of tags('[a-z][\\w-]*').filter((t) => /\shref="/.test(t))) {
    const href = attrOf(tag, 'href');
    assert.ok(href === '#' || href === '/PrintQuote', `a link keeps an address or a query: ${tag.slice(0, 80)}`);
  }
  assert.doesNotMatch(html, /https?:\/\//, 'no absolute address of any kind');
  assert.doesNotMatch(html, /<!--(?!\s*GEICO commercial auto quote)/, 'no comment but the header (Chrome writes "saved from url" in one)');
});

test('the GEICO fixture runs no script but mock.js and loads nothing else', () => {
  assert.deepEqual(tags('script'), ['<script src="mock.js">']);
  assert.deepEqual(tags('(?:link|iframe|img|object|embed|base|meta http-equiv)'), []);
  assert.deepEqual([...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]), ['mock.js']);
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline event handler');
  assert.doesNotMatch(mock, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|location\.(?:href|assign|replace)\s*=|window\.open\(/, 'mock.js reaches nothing outside the page');
});

test('text inputs carry no value but the synthetic prefills', () => {
  for (const tag of tags('input')) {
    const type = attrOf(tag, 'type') ?? 'text';
    if (['radio', 'checkbox'].includes(type)) continue;
    assert.notEqual(type, 'hidden', `a hidden input survived: ${attrOf(tag, 'id')}`);
    const value = attrOf(tag, 'value');
    if (value == null) continue;
    const stem = String(attrOf(tag, 'name') ?? attrOf(tag, 'id')).match(/^Id_([A-Za-z][A-Za-z0-9]*)_\d+/)?.[1];
    assert.equal(value, PREFILLS[stem], `${stem ?? attrOf(tag, 'id')} keeps a value`);
  }
});

test('the GEICO fixture passes the client-data scan and holds only the fake identity', () => {
  for (const [name, text] of [['quote.html', html], ['mock.js', mock]]) assert.deepEqual(findPii(text).slice(0, 5), [], `${name} looks like it holds client data`);
  assert.deepEqual(privacyFindings(html), {}, 'the builder\'s own gate (without the harvested values, which need the raw captures)');
  const vins = new Set([...html.matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map((m) => m[0]).filter((v) => /\d/.test(v) && /[A-Z]/.test(v)));
  for (const v of vins) assert.ok(FAKE.vins.includes(v), `a VIN that is not one of the fakes (${v.length} characters)`);
  for (const m of html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) assert.equal(m[0], FAKE.email);
  // Premiums are the builder's fakes: $1,000.00, $1,111.00, $1,222.00 ... (a real rate would show).
  for (const m of html.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*)\.(\d{2})/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    assert.ok(m[2] === '00' && n >= 1000 && (n - 1000) % 111 === 0, `an amount that is not a fake premium: ${m[0]}`);
  }
});

test('the builder\'s gate refuses tokens, link queries, other scripts and harvested values', () => {
  const page = '<!doctype html><body><a href="#">x</a><script src="mock.js"></script></body>';
  assert.deepEqual(privacyFindings(page), {});
  assert.ok(Object.keys(privacyFindings(page.replace('x', '<input id="ssotoken">'))).length, 'session token');
  assert.ok(Object.keys(privacyFindings(page.replace('href="#"', 'href="/quote?conversationId=1"'))).length, 'link with a query');
  assert.ok(Object.keys(privacyFindings(page.replace('</body>', '<script>1</script></body>'))).length, 'inline script');
  assert.ok(Object.keys(privacyFindings(page.replace('x', 'Jane Q Customer'), new Map([['Jane Q Customer', 'marked text']]))).length, 'harvested value');
  assert.deepEqual(privacyFindings(page.replace('x', 'id="Id_GiveZip_68123"'), new Map([['68123', 'input GiveZip']])), {}, 'a render number is not a ZIP');
});

test('the GEICO fixture has every view and part mock.js draws, with clonable shadow roots', () => {
  const ids = tags('template').map((t) => attrOf(t, 'id')).filter(Boolean);
  const views = ['business-class', 'business-owner', 'owner-verification', 'vehicle-form', 'vehicle-list', 'vehicle-or-trailer', 'trailer-form',
    'owner-driver', 'driver-list', 'add-driver', 'business-info', 'quote', 'final-quote-details', 'mvr-and-clue', 'payment-information'];
  assert.deepEqual(ids.filter((id) => id.startsWith('view-')), views.map((v) => `view-${v}`));
  for (const f of ['insurer-years', 'insurer-limits', 'stale-card', 'options-COLL', 'options-Rental', 'options-ERS', 'mtc-limit', 'gl-limit', 'usdot-number', 'add-filings', 'vehicle-types', 'trailer-types']) {
    assert.ok(ids.includes(`frag-${f}`), `frag-${f}`);
    if (f !== 'vehicle-types' && f !== 'trailer-types' && !f.startsWith('options-')) assert.match(mock, new RegExp(`'${f}'`), `mock.js draws ${f}`);
  }
  const steps = [...html.matchAll(/<template id="view-[^"]+" data-step="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual([...new Set(steps)], ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents', 'Additional Business Info',
    'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information']);
  const shadow = tags('template').filter((t) => /shadowrootmode=/.test(t));
  assert.ok(shadow.length > 500, `${shadow.length} shadow templates`);
  assert.deepEqual(shadow.filter((t) => !/shadowrootclonable/.test(t)), [], 'mock.js clones views: a root that is not clonable is dropped');
  for (const slot of ['usdot-number', 'usdot-verify', 'insurer-years', 'insurer-limits', 'add-filings', 'term', 'stale-card', 'pay', 'pay-in-full', 'rated', 'recalc', 'mtc-limit', 'gl-limit']) {
    assert.equal(html.split(`data-mock-slot="${slot}"`).length - 1, 1, `slot ${slot}`);
  }
  // What the saves and captures do not show is marked as the builder's.
  assert.ok((html.match(/data-mock-inferred="/g) ?? []).length >= 10);
});

test('the GEICO fixture stays a sane size', () => {
  const kb = (s) => Buffer.byteLength(s) / 1024;
  assert.ok(kb(html) > 300 && kb(html) < 1024, `quote.html is ${Math.round(kb(html))} KB`);
  assert.ok(kb(mock) < 80, `mock.js is ${Math.round(kb(mock))} KB`);
});
