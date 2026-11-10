// @ts-check
// What's new for agents in each version, said once on the panel's first opening after an update
// (sidepanel/panel/whats-new.js draws it as a card). Written at a release, with the version bump
// (docs/chrome-web-store.md): a few short lines in the agent's words about what they will see
// differently, no client data and no developer detail: one short sentence each, shown as a bullet. A version with no lines shows no card.
// test/whats-new.test.mjs checks the shape: versions no newer than the package's, 1 to 5 lines each,
// each under WHATS_NEW_LINE_MAX characters.

/** @type {Record<string, string[]>} version (x.y.z) -> its lines, in the order said */
const WHATS_NEW = {
  '0.9.39': [
    'Pages fill faster.',
    'GEICO: the trailer type comes from the intake.',
    'GEICO: a ZIP with only one city is no longer flagged.',
    'A sound plays when a fill needs you. Turn it off in Settings.',
    'Bigger carrier logo, simpler Settings, steadier quote tab.',
  ],
  '0.9.36': [
    "Usage and AI requests go through TNI's server.",
  ],
  '0.9.35': [
    'Fixing a flagged value checks off its Intake card.',
  ],
  '0.9.34': [
    'A bar shows how much of the page is done.',
    'Each answer is tagged: Worked out, Your edit, Your default, TNI standard.',
    'Report a problem gives you a reference to quote.',
    'Reload now appears when an update is ready.',
  ],
  '0.9.33': [
    'The panel has two tabs: Intake and This page.',
    'Correct client details, or Restore what the intake said.',
    'Save summary keeps a copy of every answer.',
    'Filling pauses while you type in another field.',
    'A ? on any view opens a short guide.',
  ],
};

// One short line each, read at a glance as a bullet (the maintainer, 2026-11-10: "no one's gonna
// read a whole paragraph").
const WHATS_NEW_LINE_MAX = 80;

/** @param {string} v */
function versionParts(v) {
  return String(v).split('.').map((n) => Number(n));
}

/**
 * Negative when `a` is older than `b`, 0 when the same, positive when newer.
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The lines to say to an agent now running `version` who last saw `seen`'s (null: never, as after
 * updating from a version before this card): every version after `seen` up to `version`, newest
 * first; with `seen` null, `version`'s own only. Empty when there is nothing new.
 * @param {string | null | undefined} seen
 * @param {string} version
 * @param {Record<string, string[]>} [notes]
 * @returns {{ version: string, lines: string[] }[]}
 */
function whatsNewSince(seen, version, notes = WHATS_NEW) {
  return Object.keys(notes)
    .filter((v) => compareVersions(v, version) <= 0 && (seen ? compareVersions(v, seen) > 0 : v === version))
    .sort((a, b) => compareVersions(b, a))
    .map((v) => ({ version: v, lines: notes[v] }))
    .filter((e) => e.lines.length);
}

export { WHATS_NEW, WHATS_NEW_LINE_MAX, compareVersions, whatsNewSince };
