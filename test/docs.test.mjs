import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULE_FILES } from '../src/usage.js';
import { COMMON, EVENT_FIELDS } from '../server/index.mjs';

// Audit 2026-11-07, LEARN-18: docs/learning.md had drifted from the code (its rule-fingerprint list
// lacked src/answers/owner.js). The parts of it that list what the code lists are checked here.
const LEARNING = fs.readFileSync(new URL('../docs/learning.md', import.meta.url), 'utf8');
const names = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

test('learning.md names the rule fingerprint\'s files as RULE_FILES does, in its order', () => {
  const list = LEARNING.match(/the first 12 hex of SHA-256 over the text of (.*?), in that order/)?.[1];
  assert.ok(list, 'the fingerprint\'s file list');
  assert.deepEqual(names(list), RULE_FILES);
});

test('learning.md\'s event reference lists every event the server keeps, with its fields and the common ones', () => {
  const section = LEARNING.split('## Event reference')[1]?.split('\n## ')[0];
  assert.ok(section, 'the event reference');
  const rows = Object.fromEntries(section.split('\n').filter((l) => /^\| `/.test(l)).map((l) => {
    const [event, , fields] = l.split(' | ');
    return [names(event)[0], names(fields)];
  }));
  assert.deepEqual(rows, Object.fromEntries(Object.entries(EVENT_FIELDS).map(([type, fields]) => [type, [...fields]])));
  assert.deepEqual(names(section.match(/besides the common ones \((.*?)\)\. /)?.[1] ?? ''), ['COMMON', ...COMMON]);
});
