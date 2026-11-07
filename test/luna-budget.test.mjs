// Headroom of Luna's request bound per carrier (audit 2026-11-07, AI-01). Each carrier's TNI rules go
// in full with every page review, so a growing rulebook makes every request longer; at the bound a
// question can't be asked at all (RequestTooLarge: "Answer it manually"). This fails in CI while
// there is still room: the largest one-question request a carrier's committed pages make, with each
// committed intake and a page's worth of other answers, stays within BUDGET of the bound.
// Committed fixtures only (synthetic intakes, scrubbed pages); no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { collectItems, pageAnswers } from '../src/ai/common.js';
import { CARRIER_PARTS } from '../src/ai/tni-rules.js';
import { buildRequest, MAX_REQUEST_CHARS } from '../src/ai/luna.js';

const BUDGET = 0.8;
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

const intakes = {};
for (const name of ['sample-intake.pdf', 'sample-intake-2026-10.pdf', 'multi-vehicle-intake.pdf']) {
  const { record } = normalizeIntake(await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(fixture(name)))), { today: new Date('2026-11-07') });
  assert.ok(record, name);
  intakes[name] = record;
}

// The choice questions of a carrier's committed pages: Progressive's page layouts, and the selects of
// GEICO's and AmWINS' saved pages.
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
function selects(file) {
  const html = fs.readFileSync(fixture(file), 'utf8');
  return [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].map((m, i) => ({
    key: /\b(?:id|name)="([^"]+)"/.exec(m[1])?.[1] ?? `select${i}`,
    options: [...m[2].matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((o) => text(o[1])).filter(Boolean),
  })).filter((x) => x.options.length).map((x) => ({ ...x, label: x.key, controlKind: 'select', current: '' }));
}
function layouts(dir) {
  return fs.readdirSync(fixture(dir)).filter((f) => f.endsWith('.json')).flatMap((f) => {
    const { pages } = JSON.parse(fs.readFileSync(fixture(`${dir}/${f}`), 'utf8'));
    return Object.entries(pages).flatMap(([page, { fields }]) => fields.filter((x) => x.opts?.length).map((x) => ({
      key: x.ref, q: x.q, label: x.caption, section: page, controlKind: x.kind === 'radio' ? 'radio' : 'select', options: x.opts, current: '' })));
  });
}
const PAGES = { progressive: () => layouts('progressive'), geico: () => selects('geico/quote.html'), amwins: () => selects('amwins/application.html') };

// A page's other answers at their bound (pageAnswers: at most 40 entries and about 6,000 characters).
const others = pageAnswers([{ frameId: 0, documentId: 'd', result: JSON.stringify(['https://carrier.example/quote',
  Array.from({ length: 80 }, (_, i) => ({ key: `q${i}`, section: 'About the business', label: `Question ${i} ${'about the business '.repeat(8)}`, kind: 'radio', current: 'Yes, the customer does' }))]) }], [], {});

test('the page answers measured are as many as a page review carries', () => {
  assert.ok(others.reduce((n, x) => n + JSON.stringify(x).length, 0) > 5500);
});

for (const carrier of Object.keys(CARRIER_PARTS)) {
  test(`${carrier}: the largest one-question Luna request stays within ${BUDGET * 100}% of the bound`, () => {
    assert.ok(PAGES[carrier], `${carrier} has TNI rules: add its committed pages here`);
    const seen = new Set();
    const questions = collectItems([{ unknown: PAGES[carrier]() }]).items.filter((x) => {
      const sig = JSON.stringify([x.label, x.options]);
      return !seen.has(sig) && seen.add(sig);
    });
    assert.ok(questions.length > 5, `${carrier}: its pages' choice questions`);
    let largest = { size: 0 };
    for (const [intake, record] of Object.entries(intakes)) {
      const context = { carrier, page: 'page', active: { drivers: 0, vehicles: 0 }, record, pageAnswers: others };
      for (const question of questions) {
        const size = JSON.stringify(buildRequest([{ ...question, id: 'f1' }], context)).length;
        if (size > largest.size) largest = { size, intake, question: question.label };
      }
    }
    const share = largest.size / MAX_REQUEST_CHARS;
    assert.ok(share <= BUDGET, `${carrier}: ${largest.size} characters (${Math.round(share * 100)}% of ${MAX_REQUEST_CHARS}), `
      + `"${largest.question}" with ${largest.intake}. The rulebook or the intake context grew: shorten it, or raise the bound `
      + '(server/index.mjs first, then src/ai/luna.js; docs/ai-assistant.md)');
  });
}
