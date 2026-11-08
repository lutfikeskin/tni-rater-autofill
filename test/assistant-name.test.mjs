// The panel calls the assistant "AI assistant" and never shows "Luna" (maintainer, 2026-11-07;
// docs/ai-assistant.md). Code, comments, provider ids and internal names keep Luna: this reads
// only the string literals of the files whose text reaches the agent (the panel, the assistant's
// errors and check items, and the carriers' notes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const files = [
  ...readdirSync('sidepanel/panel').filter((n) => /\.jsx?$/.test(n)).map((n) => `sidepanel/panel/${n}`),
  ...readdirSync('sidepanel/panel/agent-defaults').filter((n) => /\.jsx?$/.test(n)).map((n) => `sidepanel/panel/agent-defaults/${n}`),
  'sidepanel/sidepanel.html', 'sidepanel/sidepanel.js',
  'src/ai/luna.js', 'src/ai/common.js',
  ...readdirSync('src/carriers').filter((n) => n.endsWith('.js')).map((n) => `src/carriers/${n}`),
];

// The string literals of a source, comments taken out first (a comment's apostrophe would open a
// string). JSX text between tags counts too.
function literals(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g)].map((m) => m[0]);
}

test('no text the panel shows names the assistant Luna', () => {
  const said = files.flatMap((f) => literals(readFileSync(f, 'utf8')).filter((s) => /\bLuna\b/.test(s)).map((s) => `${f}: ${s.slice(0, 80)}`));
  assert.deepEqual(said, []);
});

test('the Settings row and the cards call it the AI assistant', () => {
  assert.match(readFileSync('sidepanel/panel/settings-view.jsx', 'utf8'), /<span className="fold-name">AI assistant<\/span>/);
  const cards = readFileSync('sidepanel/panel/ai-view.jsx', 'utf8');
  for (const said of ['Picked by the AI assistant: ', 'The AI assistant recommends: ', 'The AI assistant suggests ']) assert.ok(cards.includes(said), said);
});
