#!/usr/bin/env node
// One quote, fill run or problem report as a story from the central usage log (REC-08): its
// events in time order (page views, fills with what failed or was left and why, the agent's
// changes and clicks, layouts, problem reports), and under a problem report the fill it names.
//
//   npm run session -- <session id | fill run id | problem report event id> [logs...] [--out file.md]
//
// Logs default to server-data (npm run pull). Writes to stdout, or to --out.

import fs from 'node:fs';
import { loadEvents } from './lib/events.mjs';
import { sessionStory } from './lib/session.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : null;
const rest = args.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
const [id, ...inputs] = rest;
if (!id) { console.error('Usage: npm run session -- <session | run | problem report id> [logs...] [--out file.md]'); process.exit(1); }
if (!inputs.length) inputs.push('server-data');
for (const p of inputs) if (!fs.existsSync(p)) { console.error(`No usage data at ${p}. Pull it first (npm run pull) or pass exported logs.`); process.exit(1); }
const story = sessionStory(id, loadEvents(inputs));
if (!story) { console.error(`No session, fill run or problem report ${id} in ${inputs.join(', ')}.`); process.exit(1); }
if (out) { fs.writeFileSync(out, story); console.log(`Wrote ${out}`); } else process.stdout.write(story);
