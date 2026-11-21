// Whole-or-nothing parsing and atomic day-file writes for scripts/logs-pull.mjs.
// Every line must be a JSON object and no existing day file may shrink unless allowed;
// every day is written to a temporary file in the destination folder before the first rename.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse an NDJSON export body into per-day event lines, grouped by `receivedAt` UTC day.
 * Throws naming the 1-based line number if any non-empty line is not a JSON object.
 * @param {string} text
 * @returns {{ byDay: Map<string, string[]>, events: number }}
 */
export function parseExport(text) {
  /** @type {Map<string, string[]>} */
  const byDay = new Map();
  const rawLines = text.split('\n');
  let events = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].replace(/\r$/, '');
    if (!line) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Export line ${i + 1} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Export line ${i + 1} is not a JSON object.`);
    }
    const receivedAt = /** @type {{ receivedAt?: unknown }} */ (parsed).receivedAt;
    const rawDay = String(receivedAt ?? '').slice(0, 10);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : '0000-00-00';
    let rows = byDay.get(day);
    if (!rows) { rows = []; byDay.set(day, rows); }
    rows.push(line);
    events++;
  }
  return { byDay, events };
}

/**
 * Write per-day JSONL files into `dir` atomically: check every day for shrink before writing,
 * stage all days to temporary files in `dir`, then rename each into place.
 * @param {string} dir
 * @param {Map<string, string[]>} byDay
 * @param {{ allowShrink?: boolean }} [options]
 */
export function writeDays(dir, byDay, { allowShrink = false } = {}) {
  if (!allowShrink && fs.existsSync(dir)) {
    for (const [day, rows] of byDay) {
      const dest = path.join(dir, `${day}.jsonl`);
      if (!fs.existsSync(dest)) continue;
      const existing = fs.readFileSync(dest, 'utf8').split('\n').filter(Boolean).length;
      if (rows.length < existing) {
        throw new Error(`Refusing to shrink ${day}.jsonl from ${existing} to ${rows.length} events (pass --allow-shrink to overwrite).`);
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  /** @type {[string, string][]} */
  const staged = [];
  try {
    for (const [day, rows] of byDay) {
      const dest = path.join(dir, `${day}.jsonl`);
      const tmp = path.join(dir, `${day}.jsonl.${process.pid}.tmp`);
      fs.writeFileSync(tmp, `${rows.join('\n')}\n`);
      staged.push([tmp, dest]);
    }
  } catch (err) {
    for (const [tmp] of staged) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }
  for (const [tmp, dest] of staged) fs.renameSync(tmp, dest);
}
