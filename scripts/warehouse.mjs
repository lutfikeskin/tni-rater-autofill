#!/usr/bin/env node
// Builds the quoting history warehouse: a DuckDB file of TNI's quotes, their intake profiles, the
// carriers they went to and every final answer, for SQL (docs/quoting-history-database.md). Run it
// after npm run pull. Each run builds the whole file again from the usage log, which stays the
// source of record; scripts/lib/warehouse.mjs has the tables.
//
//   npm run warehouse                                   # server-data -> server-data/warehouse.duckdb
//   node scripts/warehouse.mjs [server-data ...] [--tests reviews/test-intakes.txt] [--out file.duckdb]
//
// It refuses to run without a test-run list (--tests, or reviews/test-intakes.txt in this checkout):
// a database people query for months must not count the maintainer's test quotes as clients. From a
// git worktree, pass the main checkout's list.
//
// The file holds client data (git-ignored under server-data/): keep it on this computer. It is
// replaced on every run, so keep your own queries in .sql files, not as views inside it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEvents, readEvents } from './lib/events.mjs';
import { readTestList } from './lib/signals.mjs';
import { eventRows, warehouseRows, writeWarehouse } from './lib/warehouse.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
  return args[i + 1];
};
const valued = new Set(['--tests', '--out']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!inputs.length) inputs.push('server-data');
for (const p of inputs) if (!fs.existsSync(p)) fail(`No usage data at ${p}. Run npm run pull first.`);
const shown = opt('out') ?? 'server-data/warehouse.duckdb';
const out = path.resolve(shown);

let testList;
try { testList = readTestList({ tests: opt('tests') }); } catch (err) { fail(err.message); }
if (!testList.file) fail('No test-run list: the warehouse would count the maintainer\'s test quotes as clients. Pass --tests <file> (from a git worktree, the main checkout\'s reviews/test-intakes.txt), or create reviews/test-intakes.txt, empty if there are none.');

const stored = readEvents(inputs);
const events = loadEvents(inputs, stored);
const rows = warehouseRows(events, { testIntakes: testList.intakes });
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const times = stored.map((e) => Date.parse(e.t)).filter(Number.isFinite).sort((a, b) => a - b);
const commit = git('rev-parse', 'HEAD');
const info = {
  built_at: new Date().toISOString(), commit, dirty: commit ? git('status', '--porcelain', '--untracked-files=no') !== '' : null,
  sources: inputs.map((p) => path.resolve(p)), events: stored.length, quotes: rows.quotes.length,
  test_quotes: rows.quotes.filter((q) => q.is_test).length, test_list: testList.file,
  first_event: times.length ? new Date(times[0]).toISOString() : null, last_event: times.length ? new Date(times.at(-1)).toISOString() : null,
};

// Built beside the old file, which stays until the new one is whole.
const building = `${out}.building`;
const remove = (f) => { for (const x of [f, `${f}.wal`]) fs.rmSync(x, { force: true }); };
remove(building);
try {
  await writeWarehouse(building, { events: eventRows(stored), ...rows, build_info: [info] });
} catch (err) {
  remove(building);
  fail(`Building the warehouse failed: ${err.message}`);
}
try {
  // The old file's log of unsaved changes belongs to the old file: it would be replayed into the new one.
  fs.rmSync(`${out}.wal`, { force: true });
  fs.renameSync(building, out);
} catch (err) {
  remove(building);
  fail(`Could not replace ${out} (${err.code ?? err.message}). Close it in DuckDB or any other program, then run again.`);
}

const count = (name) => (name === 'events' ? stored.length : rows[name].length);
console.log(`Built ${shown}: ${count('events')} events, ${info.quotes} quotes (${info.test_quotes} test runs, left out of v_quotes), `
  + `${count('quote_carriers')} quote-carrier rows, ${count('quote_premiums')} premiums, ${count('answers')} answers, ${count('quote_drivers')} drivers, ${count('quote_vehicles')} vehicles and trailers.`);
console.log(`Profiles on ${rows.quotes.filter((q) => q.profile_source).length} quotes. Test-run list: ${testList.file}. Commit ${commit?.slice(0, 7) ?? 'unknown'}${info.dirty ? ' with uncommitted changes' : ''}.`);
console.log(`Open it: duckdb -readonly ${shown}`);
