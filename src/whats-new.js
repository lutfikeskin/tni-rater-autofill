// @ts-check
// What's new for agents in each version, said once on the panel's first opening after an update
// (sidepanel/panel/whats-new.js draws it as a card). Written at a release, with the version bump
// (docs/chrome-web-store.md): a few short lines in the agent's words about what they will see
// differently, no client data and no developer detail. A version with no lines shows no card.
// test/whats-new.test.mjs checks the shape: versions no newer than the package's, 1 to 5 lines each,
// each under WHATS_NEW_LINE_MAX characters.

/** @type {Record<string, string[]>} version (x.y.z) -> its lines, in the order said */
const WHATS_NEW = {};

const WHATS_NEW_LINE_MAX = 160;

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
