// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Audit 2026-11-07, QA-06: the GEICO mock starts each fill as the panel does, with its own copy of
// the panel's fill options, and the copy had fallen behind (no filledBefore, givenBefore): what the
// kit does with them was never exercised there. The mock passes every key the panel's fillOptions
// passes, and those fillPage adds, and no other.
const PANEL = fs.readFileSync(new URL('../sidepanel/panel/coordinator.js', import.meta.url), 'utf8');
const FILL = fs.readFileSync(new URL('../sidepanel/panel/fill.js', import.meta.url), 'utf8');
const MOCK = fs.readFileSync(new URL('../scripts/geico-mock.mjs', import.meta.url), 'utf8');

// The top-level keys of the object literal that opens at `start` (nested objects, calls and strings skipped).
function topKeys(text, start) {
  const keys = [];
  let depth = 0;
  // At depth 1, right after the opening brace or a comma: where a key (or a spread) starts.
  let keyNext = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') { i = text.indexOf(c, i + 1); keyNext = false; continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); continue; }
    if ('{[('.includes(c)) { depth++; keyNext = depth === 1; continue; }
    if ('}])'.includes(c)) { if (--depth === 0) return keys; continue; }
    if (depth !== 1) continue;
    if (c === ',') { keyNext = true; continue; }
    if (/\s/.test(c) || !keyNext) continue;
    keyNext = false;
    const m = /^([A-Za-z_$][\w$]*)\s*[:,}\n]/.exec(text.slice(i));
    if (m) { keys.push(m[1]); i += m[1].length - 1; }
  }
  throw new Error('unclosed object');
}

test('the GEICO mock fills with every option the panel gives a fill, and no other', () => {
  // The panel's: fillOptions' own keys (`trace` only while a recording runs), and what fillPage adds.
  const options = topKeys(PANEL, PANEL.indexOf('({', PANEL.indexOf('const fillOptions =')) + 1).filter((k) => k !== 'extra');
  const call = FILL.slice(FILL.indexOf('const options = fillOptions(carrier, {', FILL.indexOf('async function fillPage(')));
  const extra = topKeys(call, call.indexOf('{'));
  const panel = new Set([...options, ...extra, 'skipBy', 'confirmed'].filter((k) => k !== 'trace'));
  assert.ok(panel.has('filledBefore') && panel.has('givenBefore') && panel.has('expectPage'), [...panel].join(', '));
  const at = MOCK.indexOf('const options = {', MOCK.indexOf('async function fill('));
  const mock = new Set(topKeys(MOCK, MOCK.indexOf('{', at)));
  assert.deepEqual([...panel].filter((k) => !mock.has(k)).sort(), [], 'the panel passes these and the mock doesn\'t');
  assert.deepEqual([...mock].filter((k) => !panel.has(k)).sort(), [], 'the mock passes these and the panel doesn\'t');
});
