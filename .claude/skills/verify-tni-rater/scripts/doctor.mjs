#!/usr/bin/env node
// Read-only. Answers whether this checkout can drive the packaged AmWINS proof.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function findRoot(start) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    const manifest = path.join(dir, 'manifest.json');
    if (fs.existsSync(pkg) && fs.existsSync(manifest)) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Run this from a TNI Rater Autofill checkout.');
}

const root = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist', 'tni-rater-autofill', 'manifest.json');
const intake = path.join(root, 'test', 'fixtures', 'sample-intake.pdf');
const fixture = path.join(root, 'test', 'fixtures', 'amwins', 'application.html');
// Resolved as the scripts resolve it: a checkout under .claude/worktrees/ uses the main checkout's node_modules.
const require = createRequire(path.join(root, 'package.json'));
let playwright = '';
try {
  playwright = require.resolve('playwright');
} catch {}

const lines = [];
const fail = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
lines.push(`node ${process.version} (docs say 22, this machine may be newer)`);
if (nodeMajor < 22) fail.push('Node is older than 22.');

if (fs.existsSync(dist)) {
  const packaged = JSON.parse(fs.readFileSync(dist, 'utf8'));
  lines.push(`package dist/tni-rater-autofill (${packaged.version})`);
} else {
  lines.push('package missing. Run npm run package.');
  fail.push('package');
}

if (fs.existsSync(intake)) lines.push('intake test/fixtures/sample-intake.pdf');
else {
  lines.push('sample intake missing.');
  fail.push('intake');
}

if (playwright) {
  let browser = '';
  try {
    browser = require(playwright).chromium.executablePath();
  } catch (err) {
    lines.push(`playwright package present, executablePath failed (${err.message})`);
    fail.push('playwright-browser');
  }
  if (browser) {
    if (fs.existsSync(browser)) lines.push(`playwright chromium ${browser}`);
    else {
      lines.push(`playwright chromium missing at ${browser}. Run npx playwright install chromium.`);
      fail.push('playwright-browser');
    }
  }
} else {
  lines.push('playwright missing. Run npm ci and npx playwright install chromium.');
  fail.push('playwright');
}

function probeReplay() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8792/test/fixtures/amwins/application.html', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

const replay = await probeReplay();
if (replay.error) {
  lines.push(`replay down on 127.0.0.1:8792 (${replay.error}). Run npm run replay.`);
  fail.push('replay');
} else if (replay.status !== 200 || !replay.body.includes('CL - Business Auto (mock)')) {
  lines.push(`port 8792 answered ${replay.status} but is not this repo's replay. Do not start a second listener. Stop whatever owns the port, then npm run replay.`);
  fail.push('replay-wrong');
} else if (replay.body !== fs.readFileSync(fixture, 'utf8')) {
  lines.push('port 8792 is another checkout\'s replay: its AmWINS fixture differs from this checkout\'s. Run npm run replay here once that one is stopped by whoever started it.');
  fail.push('replay-other-checkout');
} else {
  lines.push('replay ready http://127.0.0.1:8792/test/fixtures/amwins/application.html');
}

console.log('verify-tni-rater doctor');
console.log(`root ${root}`);
for (const line of lines) console.log(line);
if (fail.length) {
  console.log(`NOT READY ${fail.join(', ')}`);
  process.exit(1);
}
console.log('READY packaged AmWINS proof');
