#!/usr/bin/env node
// Checks that the deployed usage server runs this repository's server/index.mjs: an older one
// drops event fields the extension now sends (docs/hosting.md). Prints one line; --md <file>
// appends a section to a review. Used by the daily review, which opens an issue when it differs.
//
//   node scripts/server-check.mjs [--md reviews/review-<date>.md]

import fs from 'node:fs';
import { serverUrl, checkServer } from './lib/central.mjs';
import { SERVER_HASH } from '../server/index.mjs';

const args = process.argv.slice(2);
const md = args.includes('--md') ? args[args.indexOf('--md') + 1] : null;
const r = await checkServer(serverUrl(), SERVER_HASH);
const says = {
  same: `The usage server runs this repository's server (${SERVER_HASH}).`,
  different: `The usage server runs ${r.deployed ? `another version (${r.deployed})` : 'a version from before this check'}, not this repository's (${SERVER_HASH}): it may drop fields the extension sends. Redeploy it (docs/hosting.md).`,
  unreachable: `The usage server could not be checked (${r.detail}).`,
}[r.status];
console.log(`server: ${r.status} · ${says}`);
if (md) fs.appendFileSync(md, `\n## Usage server\n\n${says}\n`);
