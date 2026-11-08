// Audit 2026-11-07, UX-09: the panel's muted text fell under 4.5:1 on the canvas and the sunken
// surface, the edge of an input and the switch's off track under 3:1 on white, several labels were
// 9-10px, and with reduced motion on the fill's sliding bar froze at a third, reading as progress.
// These read sidepanel.css itself: jsdom computes no colors, so an axe pass there could not see them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
const token = (name) => {
  const m = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i'));
  assert.ok(m, `--${name} is a hex token`);
  return m[1];
};
// WCAG 2.x relative luminance and contrast ratio.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('muted text is 4.5:1 on every surface it sits on (WCAG 1.4.3)', () => {
  for (const ground of ['surface', 'canvas', 'surface-sunken']) {
    assert.ok(ratio(token('ink-muted'), token(ground)) >= 4.5, `--ink-muted on --${ground}: ${ratio(token('ink-muted'), token(ground)).toFixed(2)}`);
  }
});

test('an input’s edge and the switch’s off track are 3:1 on white (WCAG 1.4.11)', () => {
  assert.ok(ratio(token('border-control'), token('surface')) >= 3, ratio(token('border-control'), token('surface')).toFixed(2));
  // Every input, select and textarea with a grey edge takes the control border, and so does the
  // switch. Left as they are: the AI key's box, edged in brand blue (above 3:1), and client details'
  // filled boxes, which have no edge (the 2026-10-29 design's quiet rows, each beside its label).
  const rules = CSS.split('\n').filter((line) => /(input|select|textarea|#agent|\.opt-btn)\b[^{]*\{[^}]*border: 1px solid/.test(line))
    .filter((line) => !/border: 1px solid (var\(--brand\)|transparent)/.test(line));
  assert.ok(rules.length >= 8, 'the controls are found');
  for (const rule of rules) assert.match(rule, /border: 1px solid var\(--border-control\)/, rule.slice(0, 80));
  assert.match(CSS, /\.switch \{[^}]*background: var\(--border-control\);/);
});

test('no text in the panel is under 11px, beyond decorative glyphs', () => {
  // The PDF button's tiny "PDF" mark (aria-hidden) and a section's fold arrow are pictures, not text.
  const decorative = /^\.(pdf-icon|section-title::before) /;
  const small = CSS.split('\n').filter((line) => !decorative.test(line))
    .flatMap((line) => [...line.matchAll(/font(?:-size)?:\s*(?:\d{3}\s+)?(\d+(?:\.\d+)?)px/g)].map((m) => [Number(m[1]), line.slice(0, 60)]))
    .filter(([px]) => px < 11);
  assert.deepEqual(small, []);
});

test('with reduced motion, a fill shows a steady full bar and a still spinner, not a bar frozen at a third', () => {
  const reduced = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce) {'));
  assert.match(reduced, /\.progress span \{[^}]*width: 100%;/);
  assert.match(reduced, /\.spinner::before \{ content: "…"; \}/);
  assert.match(reduced, /\.spinner \{[^}]*border: 0;/);
});
