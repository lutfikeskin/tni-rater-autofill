import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { carrierForUrl } from '../src/carriers.js';

const script = fs.readFileSync(new URL('../scripts/extension-e2e.mjs', import.meta.url), 'utf8');
const constant = (name) => script.match(new RegExp(`const ${name} = (?:CHANNEL === 'store' \\? )?'([^']+)'`))?.[1];

// Audit 2026-11-07, QA-11: the store build's e2e ran on a localhost practice page, so the store
// manifest had to keep localhost and the practice mapping. It now opens the mock under AmWINS' own
// host, which the browser answers from the replay server: the store build fills it as AmWINS by its
// real host pattern, starting from Commercial Lines as an agent does.
test('the store e2e opens the mock as AmWINS itself, from its Commercial Lines', () => {
  const host = constant('MOCK_HOST');
  const prefix = constant('MOCK_PREFIX');
  const portal = constant('PORTAL_PATH');
  const mockPath = constant('MOCK_PATH');
  assert.ok(host && prefix && portal && mockPath, 'the store run\'s addresses');
  const quote = `https://${host}${prefix}${mockPath}`;
  const carrier = carrierForUrl(quote);
  assert.equal(carrier?.id, 'amwins', 'AmWINS by its own host pattern');
  assert.ok(!carrier.practice, 'not a practice page');
  assert.ok(carrier.autoFillUrl.test(quote), 'a quote page, not the portal');
  // Commercial Lines is AmWINS' but outside a quote, so the quote opened from it is the intake's.
  const start = `https://${host}${portal}`;
  assert.equal(carrierForUrl(start)?.id, 'amwins');
  assert.ok(!carrier.layoutUrl.test(start), 'outside a quote (quote-owner.js reads layoutUrl)');
  // Nothing leaves the machine: the host is routed, and only in the store run.
  assert.match(script, /url\.hostname !== MOCK_HOST/);
  assert.match(script, /await ctx\.route\(\(url\) => url\.hostname === MOCK_HOST,/);
  assert.match(script, /route\.fetch\(\{ url: `http:\/\/localhost:8792\$\{local\}\$\{search\}` \}\)/);
  assert.match(script, /const MOCK_URL = MOCK_HOST \? `https:\/\/\$\{MOCK_HOST\}\$\{MOCK_PREFIX\}\$\{MOCK_PATH\}` : `http:\/\/localhost:8792\$\{MOCK_PATH\}`;/);
});
